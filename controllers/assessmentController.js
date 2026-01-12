import fs from "fs";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import { extractText, parseQA } from "../utils/extractor.js";
import { gradeDynamic } from "./Ai-tasks/ai-grader.js";
import Assignment from "../models/AssignmentModel.js";
import Question from "../models/QuestionModel.js";
import Student from "../models/studentModel.js";

export const handleAssessmentUpload = async (req, res) => {
  const filePath = req.file.path;
  const { studentId, assignmentId } = req.body;

  try {
    const text = await extractText(filePath);
    const qaPairs = parseQA(text);

    // console.log("text", text);
    // console.log("qaPairs", qaPairs);
    const graded = [];
    let totalScore = 0;

    for (const { question, answer } of qaPairs) {
      const result = await gradeDynamic(question, answer);
      graded.push({ question, answer, ...result });
      totalScore += result.score;
    }

    fs.unlinkSync(filePath); // clean up uploaded file

    const submission = new GradedSubmission({
      studentId,
      assignmentId,
      totalScore,
      maxScore: qaPairs.length * 5,
      graded,
    });
    await submission.save();
    res.status(200).json(submission);
  } catch (error) {
    console.error("Grading failed:", error);
    res.status(500).json({ error: "Auto-grading failed. " + error.message });
  }
};

export const gradeAssignment = async (req, res) => {
  const { studentId, assignmentId, assignmentTaskId, answers } = req.body;

  try {
    // ✅ Validate student
    const student = await Student.findById(studentId);
    if (!student) {
      return res
        .status(400)
        .json({ error: "Invalid studentId. Student not found." });
    }
    // ✅ Validate assignment
    const assignment = await Assignment.findById(assignmentId);
    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    // ✅ Validate assignmentTaskId inside assignment
    const task = assignment.assignments.find(
      (t) => t._id.toString() === assignmentTaskId
    );
    if (!task) {
      return res
        .status(404)
        .json({ error: "Assignment task not found in assignment" });
    }

    // ✅ Check if student is allowed to submit this task
    const isAssigned = task.studentIds.some(
      (id) => id.toString() === studentId
    );
    if (!isAssigned) {
      return res
        .status(403)
        .json({ error: "This student is not assigned to this task." });
    }

    // ✅ Validate answers array
    if (!Array.isArray(answers) || answers.length === 0) {
      return res
        .status(400)
        .json({ error: "Answers must be a non-empty array" });
    }

    // ✅ Load questions from DB and match by question text
    const dbQuestions = await Question.find({ _id: { $in: task.questions } });

    // console.log("DB Questions:", dbQuestions);
    const questionsWithAnswers = answers
      .map((a) => {
        const match = dbQuestions.find(
          (q) => q.question?.trim() === a.question?.trim()
        );
        if (!match) return null;
        return {
          questionId: match._id,
          question: match.questionText,
          answer: a.answer,
        };
      })
      .filter(Boolean);

    if (questionsWithAnswers.length === 0) {
      return res.status(400).json({ error: "No valid answers provided" });
    }

    const aiGraded = await gradeDynamic(questionsWithAnswers);

    let totalScore = 0;
    let maxScore = 0;

    const gradedResults = aiGraded.map((result) => {
      const original = questionsWithAnswers.find(
        (q) => q.question === result.question
      );
      totalScore += result.score;
      maxScore += 5;

      return {
        questionId: original?.questionId,
        questionText: result.question,
        answer: result.answer,
        score: result.score,
        feedback: result.feedback,
      };
    });

    const graded = await GradedSubmission.create({
      studentId,
      assignmentId,
      assignmentTaskId,
      totalScore,
      maxScore,
      graded: gradedResults,
    });

    res.status(201).json({
      message: "Task graded successfully",
      graded,
    });
  } catch (err) {
    console.error("Grading error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getGradedSubmission = async (req, res) => {
  const { assignmentId, assignmentTaskId, studentId } = req.params;

  try {
    const query = {
      assignmentId,
      assignmentTaskId,
    };
    if (studentId) query.studentId = studentId;

    const graded = await GradedSubmission.find(query)
      .populate("studentId", "firstName lastName email")
      // .populate("graded.questionId", "question options correctAnswer")
      .lean(); // to allow modification

    if (!graded || graded.length === 0) {
      return res
        .status(404)
        .json({ message: "No graded submission(s) found." });
    }

    // Fetch the assignment and find the specific task
    const assignment = await Assignment.findById(assignmentId).lean();
    if (!assignment) {
      return res.status(404).json({ message: "Assignment not found." });
    }

    const matchedTask = assignment.assignments.find(
      (task) => task._id.toString() === assignmentTaskId
    );

    if (!matchedTask) {
      return res.status(404).json({ message: "Assignment task not found." });
    }

    // Only pick necessary fields
    const assignmentTaskDetails = {
      _id: matchedTask._id,
      title: matchedTask.title,
      description: matchedTask.description,
      dueDate: matchedTask.dueDate,
      resources: matchedTask.resources,
    };

    // Inject the task details into each graded submission
    graded.forEach((g) => {
      g.assignmentTask = assignmentTaskDetails;
      delete g.assignmentTaskId;
    });

    res.status(200).json({
      count: graded.length,
      graded,
    });
  } catch (err) {
    console.error("Fetch graded error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getSubmittedAssignmentsByStudent = async (req, res) => {
  const { studentId } = req.params;

  try {
    const submissions = await GradedSubmission.find({ studentId })
      .populate("assignmentId", "_id")
      .populate("studentId", "firstName lastName email")
      .populate("graded.questionId", "question")
      .sort({ createdAt: -1 })
      .lean();

    if (!submissions.length) {
      return res
        .status(404)
        .json({ message: "No submitted assignments found for this student." });
    }

    // Group assignmentIds to batch-fetch assignments
    const assignmentIds = [
      ...new Set(submissions.map((s) => s.assignmentId._id.toString())),
    ];

    const assignments = await Assignment.find({
      _id: { $in: assignmentIds },
    }).lean();

    // Map: assignmentId → task[]
    const taskMap = {};
    assignments.forEach((assignment) => {
      taskMap[assignment._id.toString()] = assignment.assignments;
    });

    // Inject the assignmentTask and remove assignmentTaskId
    const result = submissions.map((sub) => {
      const tasks = taskMap[sub.assignmentId._id.toString()] || [];
      const task = tasks.find(
        (t) => t._id.toString() === sub.assignmentTaskId.toString()
      );

      return {
        assignmentTask: task
          ? {
              _id: task._id,
              title: task.title,
              description: task.description,
              dueDate: task.dueDate,
              resources: task.resources,
            }
          : null,
        ...sub,
        assignmentTaskId: undefined, // Remove it from response
      };
    });

    res.status(200).json({
      count: result.length,
      submissions: result,
    });
  } catch (err) {
    console.error("Fetch student submissions error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getAssignedTasksForStudent = async (req, res) => {
  try {
    // Fetch all assignments where any task has assigned students
    const assignments = await Assignment.find({
      "assignments.studentIds.0": { $exists: true },
    })
      .populate({
        path: "assignments.questions",
        select: "question type course topic questionText correctAnswer hints ",
      })
      .populate("assignments.studentIds", "firstName lastName email")
      .populate("classroomId", "name")
      .populate("sessionId", "topic");

    const assignedTasks = [];

    assignments.forEach((assignment) => {
      assignment.assignments.forEach((task) => {
        if (task.studentIds.length > 0) {
          assignedTasks.push({
            assignmentId: assignment._id,
            assignmentTaskId: task._id,
            title: task.title,
            description: task.description,
            dueDate: task.dueDate,
            classroom: assignment.classroomId?.name,
            session: assignment.sessionId?.topic,
            students: task.studentIds,
            questions: task.questions,
          });
        }
      });
    });

    if (assignedTasks.length === 0) {
      return res.status(404).json({ message: "No assigned tasks found." });
    }

    res.status(200).json({
      count: assignedTasks.length,
      assignedTasks,
    });
  } catch (err) {
    console.error("Fetch assigned tasks error:", err);
    res.status(500).json({ error: err.message });
  }
};
