import mongoose from "mongoose";
import Assignment from "../models/AssignmentModel.js";
import Classroom from "../models/classroomModel.js";
import Question from "../models/QuestionModel.js";
import Session from "../models/SessionModel.js";
import Student from "../models/studentModel.js";
import Teacher from "../models/teacherModel.js";
import User from "../models/user.js";
import { generateAIQuestions } from "./Ai-tasks/generateQuestions.js";
import { notifyNewAssignment } from "../utils/notify.js";
import {
  generateAssignmentQuestions,
  ASSIGNMENT_QUESTION_MODEL,
} from "../utils/geminiAssignmentQuestions.js";
import {
  generateAssignmentQuestionImage,
  ASSIGNMENT_IMAGE_MODEL,
} from "../utils/geminiAssignmentImage.js";
import Lesson from "../models/LessonModel.js";
import ClassworkModel from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";

export const createAssignment = async (req, res) => {
  const {
    classroomId,
    sessionId,
    teacherId,
    assignments,
    assignmentId,
    maxMarks,
  } = req.body;

  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res
      .status(400)
      .json({ error: "assignments must be a non-empty array" });
  }

  try {
    const [classroom, session, teacher] = await Promise.all([
      Classroom.findById(classroomId),
      Session.findById(sessionId),
      User.findById(teacherId),
    ]);

    if (!classroom)
      return res.status(400).json({ error: "Invalid classroomId" });
    if (!session) return res.status(400).json({ error: "Invalid sessionId" });
    // if (!teacher) return res.status(400).json({ error: "Invalid teacherId" });

    // 🧠 Only validate teacherId if it's a new assignment
    if (!assignmentId) {
      if (!teacherId)
        return res.status(400).json({ error: "teacherId is required" });

      const teacher = await User.findOne({
        _id: teacherId,
        userRole: "teacher",
      });
      if (!teacher) return res.status(400).json({ error: "Invalid teacherId" });
    }
    // Validate each assignment task
    // ✅ Validate each assignment task
    for (const [index, a] of assignments.entries()) {
      if (!a.title || !a.dueDate) {
        return res.status(400).json({
          error: `Assignment at index ${index} must have a title and dueDate`,
        });
      }

      if (!a.maxMarks && a.maxMarks !== 0) {
        // Optional fallback to global maxMarks
        if (maxMarks !== undefined) {
          a.maxMarks = maxMarks;
        } else {
          return res.status(400).json({
            error: `Assignment at index ${index} must have maxMarks`,
          });
        }
      }

      if (a.studentIds?.length > 0) {
        const students = await User.find({
          _id: { $in: a.studentIds },
          userRole: "student",
        });
        if (students.length !== a.studentIds.length) {
          return res.status(400).json({
            error: `One or more studentIds are invalid in assignment at index ${index}`,
          });
        }
      }

      if (a.questions?.length > 0) {
        const questions = await Question.find({ _id: { $in: a.questions } });
        if (questions.length !== a.questions.length) {
          return res.status(400).json({
            error: `One or more questionIds are invalid in assignment at index ${index}`,
          });
        }
      }
    }

    let resultAssignment;

    if (assignmentId) {
      // 🟡 Append to existing assignment
      const existingAssignment = await Assignment.findById(assignmentId);
      if (!existingAssignment) {
        return res
          .status(404)
          .json({ error: "Assignment not found with given assignmentId" });
      }
      // 🛑 Classroom mismatch check
      if (existingAssignment.classroomId.toString() !== classroomId) {
        return res.status(400).json({
          error:
            "Provided classroomId does not match the existing assignment classroom",
        });
      }

      // 🛑 Session mismatch check
      if (existingAssignment.sessionId.toString() !== sessionId) {
        return res.status(400).json({
          error:
            "Provided sessionId does not match the existing assignment session",
        });
      }
      existingAssignment.assignments.push(...assignments);
      await existingAssignment.save();

      resultAssignment = existingAssignment;
    } else {
      // 🟢 Create new assignment
      resultAssignment = await Assignment.create({
        classroomId,
        sessionId,
        teacherId,
        assignments,
        maxMarks,
      });
    }

    // 🔔 Fire notifications (students + parents)
    try {
      await notifyNewAssignment({
        assignmentDoc: resultAssignment,
        tasks: assignments,
        actorId: teacherId,
        classroomId,
        sessionId,
        io: req.app?.get("io"), // if you stored io on app: app.set("io", io)
      });
    } catch (notifyErr) {
      console.error("notifyNewAssignment error:", notifyErr);
      // Don't fail the main request if notifications fail; just log
    }

    res.status(201).json({
      message: assignmentId
        ? "Assignment tasks added to existing assignment"
        : "New assignment created successfully",
      assignment: resultAssignment,
    });
  } catch (err) {
    console.error("Create assignment error:", err);
    res.status(500).json({ error: err.message });
  }
};

// export const assignStudentsToAssignment = async (req, res) => {
//   const { id } = req.params;
//   const { studentIds } = req.body;

//   if (!Array.isArray(studentIds)) {
//     return res.status(400).json({ error: "studentIds must be an array" });
//   }

//   try {
//     const assignment = await Assignment.findById(id);
//     if (!assignment) {
//       return res.status(404).json({ error: "Assignment not found" });
//     }

//     assignment.studentIds = studentIds;
//     await assignment.save();

//     res
//       .status(200)
//       .json({ message: "Students assigned to assignment", assignment });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// };

export const getFullClassroomData = async (req, res) => {
  const { id: classroomId } = req.params;

  try {
    const classroom = await Classroom.findById(classroomId);
    if (!classroom)
      return res.status(404).json({ error: "Classroom not found" });

    const sessions = await Session.find({ classroomId }).sort({
      sessionDate: 1,
    });
    const assignments = await Assignment.find({ classroomId }).sort({
      dueDate: 1,
    });

    res.status(200).json({
      classroom,
      sessions,
      assignments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAssignmentWithQuestions = async (req, res) => {
  const { id } = req.params;

  try {
    const assignment = await Assignment.findById(id)
      .populate("questions")
      .populate("classroomId")
      .populate("sessionId", "topic sessionDate sessionUrl")
      .populate("teacherId", "firstName lastName email")
      .populate("studentIds", "firstName lastName email");

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    res.status(200).json({
      message: "Assignment with questions fetched successfully",
      assignment,
    });
  } catch (err) {
    console.error("Get assignment error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getAssignmentBySessionId = async (req, res) => {
  const { sessionId } = req.params;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }
  try {
    const assignments = await Assignment.find({ sessionId })
      .populate("questions") // populate full question objects
      .populate("teacherId", "firstName lastName email")
      .populate("classroomId")
      .populate("studentIds", "firstName lastName email");

    res.status(200).json({
      message: `Assignments for session ${sessionId}`,
      count: assignments.length,
      assignments,
    });
  } catch (error) {
    console.error("Error fetching assignments:", error);
    res.status(500).json({ error: error.message });
  }
};

export const getAssignedAssignments = async (req, res) => {
  const studentId = req.params.studentId;

  if (!studentId) {
    return res.status(400).json({ error: "studentId is required" });
  }

  try {
    // Find assignments where any of the nested 'assignments' contains the studentId
    const assignments = await Assignment.find({
      "assignments.studentIds": studentId,
    })
      .populate("classroomId")
      .populate("sessionId")
      .populate("teacherId", "firstName lastName email")
      .populate("assignments.questions");

    if (!assignments || assignments.length === 0) {
      return res
        .status(404)
        .json({ message: "No assignments found for this student" });
    }

    // Flatten relevant data
    const studentAssignments = [];

    assignments.forEach((assignmentDoc) => {
      const {
        classroomId,
        sessionId,
        teacherId,
        _id: assignmentId,
      } = assignmentDoc;

      assignmentDoc.assignments.forEach((task) => {
        if (task.studentIds.some((id) => id.toString() === studentId)) {
          studentAssignments.push({
            assignmentId,
            subAssignment: task._id,
            title: task.title,
            description: task.description,
            dueDate: task.dueDate,
            duration: task.duration,
            resources: task.resources,
            questions: task.questions,
            submissions: task.submissions,
            classroomId,
            sessionId,
            teacher: teacherId,
          });
        }
      });
    });

    res.status(200).json({
      message: `Assignments for student ${studentId}`,
      count: studentAssignments.length,
      assignments: studentAssignments,
    });
  } catch (error) {
    console.error("Error fetching assignments:", error);
    res.status(500).json({ error: error.message });
  }
};

export const assignStudentsToAssignment = async (req, res) => {
  const { id, taskId } = req.params;
  const { studentIds } = req.body;
  if (!Array.isArray(studentIds)) {
    return res.status(400).json({ error: "studentIds must be an array" });
  }
  try {
    const assignment = await Assignment.findById(id);
    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    const task = assignment.assignments.find(
      (a) => a._id.toString() === taskId
    );
    if (!task) {
      return res.status(404).json({ error: "Assignment task not found" });
    }

    // Validate student IDs
    const foundStudents = await User.find({
      _id: { $in: studentIds },
      userRole: "student",
    });
    if (foundStudents.length !== studentIds.length) {
      return res
        .status(400)
        .json({ error: "One or more studentIds are invalid" });
    }
    // Merge new studentIds without duplicates
    const existingIds = task.studentIds.map((id) => id.toString());
    const newUniqueIds = studentIds.filter((id) => !existingIds.includes(id));
    task.studentIds.push(...newUniqueIds);
    await assignment.save();
    res.status(200).json({
      message: "Students assigned to assignment successfully",
      assignment,
    });
  } catch (err) {
    console.error("Error assigning students:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getAllAssignedAssignments = async (req, res) => {
  try {
    const assignedAssignments = await Assignment.find({
      assignments: {
        $elemMatch: {
          studentIds: { $exists: true, $not: { $size: 0 } },
        },
      },
    })
      .populate("classroomId")
      .populate("sessionId")
      .populate("teacherId");

    res.status(200).json(assignedAssignments);
  } catch (error) {
    console.error("Error fetching assigned assignments:", error);
    res.status(500).json({ error: "Server error", message: error.message });
  }
};

export const getAssignmentById = async (req, res) => {
  const { assignmentId } = req.params;

  try {
    // Step 1: Fetch main document
    const assignmentDoc = await Assignment.findById(assignmentId)
      .populate({
        path: "classroomId",
        select: "_id remarks scope",
        populate: {
          path: "studentIds",
          select: "_id firstName lastName email",
        },
      })
      .populate("sessionId", "_id topic sessionDate notes sessionUrl")
      .populate("teacherId", "_id firstName lastName email userId");

    if (!assignmentDoc) {
      return res.status(404).json({ error: "Assignment document not found" });
    }

    // Step 2: For each assignment, populate its students and questions
    const populatedAssignments = await Promise.all(
      assignmentDoc.assignments.map(async (a) => {
        const students = await User.find({
          _id: { $in: a.studentIds },
          userRole: "student",
        }).select("_id firstName lastName email");

        console.log("students", students);
        const questions = await Question.find({
          _id: { $in: a.questions },
        }).select("_id text type options correctAnswer");

        return {
          // ...a.toObject(),
          _id: a._id,
          title: a.title,
          description: a.description,
          dueDate: a.dueDate,
          maxMarks: a.maxMarks,
          assignmentStatus: a.assignmentStatus,
          duration: a.duration,
          students,
          questions,
        };
      })
    );

    // Step 3: Return everything
    res.status(200).json({
      _id: assignmentDoc._id,
      teacherId: assignmentDoc.teacherId,
      classroomId: assignmentDoc.classroomId,
      sessionId: assignmentDoc.sessionId,
      assignments: populatedAssignments,
      createdAt: assignmentDoc.createdAt,
    });
  } catch (error) {
    console.error("Error fetching assignment:", error);
    res.status(500).json({ error: "Server error", message: error.message });
  }
};

export const getAllAssignments = async (req, res) => {
  try {
    const assignments = await Assignment.find()
      .populate("classroomId")
      .populate("sessionId")
      .populate("teacherId");

    res.status(200).json(assignments);
  } catch (error) {
    console.error("Error fetching assignments:", error);
    res.status(500).json({ error: "Server error", message: error.message });
  }
};

export const getAssignmentsByClassroom = async (req, res) => {
  try {
    const { classroomId } = req.params;

    if (!classroomId) {
      return res.status(400).json({ error: "classroomId is required" });
    }

    const assignments = await Assignment.find({ classroomId })
      .populate("classroomId")
      .populate("sessionId", "notes topic sessionDate sessionUrl")
      .populate("teacherId", "firstName lastName email");

    if (!assignments || assignments.length === 0) {
      return res
        .status(404)
        .json({ message: "No assignments found for this classroom" });
    }
    res.status(200).json(assignments);
  } catch (error) {
    console.error("Error fetching assignments by classroom:", error);
    res.status(500).json({ error: "Server error", message: error.message });
  }
};

export const createnewAssignment = async (req, res) => {
  const {
    classroomId,
    sessionId,
    teacherId,
    assignments,
    maxMarks,
    assignmentId,
  } = req.body;

  if (!Array.isArray(assignments) || assignments.length === 0) {
    return res
      .status(400)
      .json({ error: "assignments must be a non-empty array" });
  }

  try {
    const [classroom, session, teacher] = await Promise.all([
      Classroom.findById(classroomId),
      Session.findById(sessionId),
      User.findById(teacherId),
    ]);

    if (!classroom)
      return res.status(400).json({ error: "Invalid classroomId" });
    if (!session) return res.status(400).json({ error: "Invalid sessionId" });
    // if (!teacher) return res.status(400).json({ error: "Invalid teacherId" });

    let classroomPrompt = classroom.classroom_prompt || "";
    for (const task of assignments) {
      // 🔍 Validate student IDs
      if (task.studentIds?.length > 0) {
        const students = await User.find({ _id: { $in: task.studentIds } });
        if (students.length !== task.studentIds.length) {
          return res.status(400).json({ error: "Invalid student IDs found." });
        }
      }

      // 🔍 If task contains generateQuestions metadata → generate + insert
      if (task.generateQuestions) {
        const {
          numberOfQuestions,
          type,
          mcqOptions,
          difficulty,
          course,
          topic,
          fineTuningInstructions,
        } = task.generateQuestions;

        // 1️⃣ Generate AI Questions
        const aiQuestions = await generateAIQuestions({
          numberOfQuestions,
          type,
          mcqOptions,
          difficulty,
          course,
          topic,
          maxMarks,
          fineTuningInstructions,
          classroomPrompt,
        });

        // 2️⃣ Save each question to DB
        const savedQuestions = await Question.insertMany(
          aiQuestions.map((q) => ({
            classroomId,
            sessionId,
            teacherId,
            course,
            topic,
            maxMarks,
            type: q.type,
            questionText: q.questionText,
            options: q.options || [],
            correctAnswer: q.correctAnswer || [],
            hints: q.hints || [],
            answer: q.answer || [],
            metadata: q.metadata,
            fineTuningInstructions,
            language: "English",
            assignmentId: assignmentId || null,
          }))
        );

        // 3️⃣ Push saved question IDs to task
        task.questions = savedQuestions.map((q) => q._id);
      } else {
        // 🔍 Validate manually provided question IDs
        if (task.questions?.length > 0) {
          const questions = await Question.find({
            _id: { $in: task.questions },
          });
          if (questions.length !== task.questions.length) {
            return res.status(400).json({ error: "Invalid question IDs." });
          }
        }
      }
    }

    // 🔧 Ensure every task has its own maxMarks
    for (const task of assignments) {
      if (task.maxMarks === undefined || task.maxMarks === null) {
        task.maxMarks = maxMarks;
      }
    }

    let resultAssignment;

    if (assignmentId) {
      const existingAssignment = await Assignment.findById(assignmentId);
      if (!existingAssignment)
        return res.status(404).json({ error: "Assignment not found." });

      if (existingAssignment.classroomId.toString() !== classroomId)
        return res.status(400).json({ error: "Classroom mismatch." });

      if (existingAssignment.sessionId.toString() !== sessionId)
        return res.status(400).json({ error: "Session mismatch." });

      existingAssignment.assignments.push(...assignments);
      await existingAssignment.save();
      resultAssignment = existingAssignment;
    } else {
      resultAssignment = await Assignment.create({
        classroomId,
        sessionId,
        teacherId,
        assignments,
      });
    }

    await resultAssignment.populate({
      path: "assignments.questions",
    });
    // 🔔 Fire notifications (students + parents)
    try {
      await notifyNewAssignment({
        assignmentDoc: resultAssignment,
        tasks: assignments,
        actorId: teacherId,
        classroomId,
        sessionId,
        io: req.app?.get("io"), // if you stored io on app: app.set("io", io)
      });
    } catch (notifyErr) {
      console.error("notifyNewAssignment error:", notifyErr);
      // Don't fail the main request if notifications fail; just log
    }

    res.status(201).json({
      message: assignmentId
        ? "Assignment tasks added to existing assignment"
        : "New assignment created successfully",
      assignment: resultAssignment,
    });
  } catch (err) {
    console.error("Create assignment error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getSubAssignmentById = async (req, res) => {
  const { subAssignmentId } = req.params;

  try {
    // 1️⃣ Find the assignment document that contains the sub-assignment
    const assignment = await Assignment.findOne({
      "assignments._id": subAssignmentId,
    }).lean(); // lean() makes manual population easier and faster

    if (!assignment) {
      return res.status(404).json({ error: "Sub-assignment not found." });
    }

    // 2️⃣ Extract the sub-assignment from the array
    const subAssignment = assignment.assignments.find(
      (a) => a._id.toString() === subAssignmentId
    );

    if (!subAssignment) {
      return res.status(404).json({ error: "Sub-assignment not found." });
    }

    // 3️⃣ Manually populate studentIds
    const students = await User.find({
      _id: { $in: subAssignment.studentIds },
    })
      .select("_id firstName lastName email parentId")
      .populate({ path: "parentId", select: "_id firstName lastName email" });

    // 4️⃣ Manually populate questions
    const questions = await Question.find({
      _id: { $in: subAssignment.questions },
    }).select(
      "_id course topic questionText type correctAnswer fineTuningInstructions language options hints answer"
    );

    // 6️⃣ Return the populated sub-assignment
    res.status(200).json({
      message: "Sub-assignment retrieved successfully",
      subAssignment: {
        ...subAssignment,
        studentIds: students,
        questions: questions,
      },
    });
  } catch (err) {
    console.error("Error fetching sub-assignment:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

export const deleteSubAssignmentById = async (req, res) => {
  const { subAssignmentId } = req.params;

  try {
    // 1️⃣ Find the assignment that contains the sub-assignment
    const assignment = await Assignment.findOne({
      "assignments._id": subAssignmentId,
    });

    if (!assignment) {
      return res.status(404).json({ error: "Sub-assignment not found." });
    }

    // 2️⃣ Remove the sub-assignment from the array
    assignment.assignments = assignment.assignments.filter(
      (a) => a._id.toString() !== subAssignmentId
    );

    // 3️⃣ Save the updated document
    await assignment.save();

    res.status(200).json({ message: "Sub-assignment deleted successfully." });
  } catch (err) {
    console.error("Error deleting sub-assignment:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

export const deleteAssignmentById = async (req, res) => {
  const { assignmentId } = req.params;

  try {
    // 1️⃣ Find the assignment document
    const assignment = await Assignment.findById(assignmentId);

    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found." });
    }

    // 2️⃣ Collect all question IDs from sub-assignments
    const allQuestionIds = assignment.assignments.flatMap(
      (sub) => sub.questions
    );

    // console.log("All Question IDs to delete:", allQuestionIds);
    // console.log("Assignment ID to delete:", assignmentId);

    // 3️⃣ Delete all associated questions
    await Question.deleteMany({ _id: { $in: allQuestionIds } });

    // 4️⃣ Delete the assignment document itself
    await Assignment.findByIdAndDelete(assignmentId);

    res.status(200).json({
      message: "Assignment and associated questions deleted successfully.",
    });
  } catch (err) {
    console.error("Error deleting assignment:", err);
    res.status(500).json({ error: "Internal server error." });
  }
};

//specifically get the student assignment by classroom

export const getStudentAssignmentsByClassroom = async (req, res) => {
  const { studentId, classroomId } = req.params;

  if (!studentId || !classroomId) {
    return res.status(400).json({
      error: "Both studentId and classroomId are required",
    });
  }

  try {
    // Find assignments matching classroomId and containing the studentId in any sub-assignment
    const assignments = await Assignment.find({
      classroomId,
      "assignments.studentIds": studentId,
    })
      .populate("classroomId")
      .populate("sessionId")
      .populate("teacherId", "firstName lastName email")
      .populate("assignments.questions");

    if (!assignments || assignments.length === 0) {
      return res.status(404).json({
        message: `No assignments found for student in this classroom `,
      });
    }

    const studentAssignments = [];

    assignments.forEach((assignmentDoc) => {
      const {
        classroomId,
        sessionId,
        teacherId,
        _id: assignmentId,
      } = assignmentDoc;

      assignmentDoc.assignments.forEach((task) => {
        if (task.studentIds.some((id) => id.toString() === studentId)) {
          studentAssignments.push({
            assignmentId,
            subAssignmentId: task._id,
            assignmentStatus: task.assignmentStatus,
            title: task.title,
            description: task.description,
            dueDate: task.dueDate,
            duration: task.duration,
            resources: task.resources,
            questions: task.questions,
            submissions: task.submissions,
            classroomId,
            sessionId,
            teacher: teacherId,
          });
        }
      });
    });

    res.status(200).json({
      message: `Assignments for student ${studentId} in classroom ${classroomId}`,
      count: studentAssignments.length,
      assignments: studentAssignments,
    });
  } catch (error) {
    console.error("Error fetching student assignments by classroom:", error);
    res.status(500).json({ error: error.message });
  }
};

// Update assignment

// Helper: role check
function isAdminish(user) {
  const role = user?.role || user?.userRole; // support both fields
  return ["teacher", "admin"].includes(role);
}

const isObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

async function validateStudents(studentIds) {
  if (!studentIds) return;
  if (!Array.isArray(studentIds))
    throw new Error("studentIds must be an array");
  if (studentIds.length === 0) return;
  const found = await User.find({
    _id: { $in: studentIds },
    userRole: "student",
  }).select("_id");
  if (found.length !== studentIds.length) {
    throw new Error("One or more studentIds are invalid");
  }
}

async function validateQuestions(questionIds) {
  if (!questionIds) return;
  if (!Array.isArray(questionIds))
    throw new Error("questions must be an array");
  if (questionIds.length === 0) return;
  const found = await Question.find({ _id: { $in: questionIds } }).select(
    "_id"
  );
  if (found.length !== questionIds.length) {
    throw new Error("One or more questionIds are invalid");
  }
}

// PUT/PATCH: /api/assignments/:assignmentId/admin
export const updateAssignmentByAdmin = async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!isObjectId(taskId)) {
      return res.status(400).json({ error: "Invalid taskId" });
    }

    const {
      title,
      description,
      dueDate,
      resources,
      studentIds,
      maxMarks,
      questions,
      status,

      // question generation controls
      generateQuestions, // object (optional)
      appendQuestions = false, // if true, append to existing; else replace
    } = req.body || {};

    // Validate arrays up front
    if (resources && !Array.isArray(resources)) {
      return res
        .status(400)
        .json({ error: "resources must be an array of URLs/strings" });
    }
    await validateStudents(studentIds);
    await validateQuestions(questions);

    // Prepare $set / $addToSet
    const $set = {};
    if (title !== undefined) $set["assignments.$.title"] = title;
    if (description !== undefined)
      $set["assignments.$.description"] = description;
    if (dueDate !== undefined) {
      const dt = new Date(dueDate);
      if (isNaN(dt.getTime())) {
        return res.status(400).json({ error: "Invalid dueDate" });
      }
      $set["assignments.$.dueDate"] = dt;
    }
    if (resources !== undefined) $set["assignments.$.resources"] = resources;
    if (studentIds !== undefined) $set["assignments.$.studentIds"] = studentIds;
    if (maxMarks !== undefined) $set["assignments.$.maxMarks"] = maxMarks;
    if (status !== undefined) $set["assignments.$.status"] = status;

    // Handle provided question ids directly (replace or append)
    const updateOps = {};
    if (questions !== undefined) {
      if (appendQuestions) {
        updateOps.$addToSet = {
          "assignments.$.questions": { $each: questions },
        };
      } else {
        $set["assignments.$.questions"] = questions;
      }
    }

    // Find the parent by subdoc id; apply initial updates (without generation yet)
    if (Object.keys($set).length) updateOps.$set = $set;

    let doc = await Assignment.findOneAndUpdate(
      { "assignments._id": taskId },
      Object.keys(updateOps).length ? updateOps : {}, // may be empty if only generateQuestions is requested
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: "Task not found" });

    // // If we also need to generate questions, do it now and then update again
    // if (generateQuestions && generateQuestions.numberOfQuestions > 0) {
    //   const genIds = await generateQuestionsAndCreate(generateQuestions);
    //   if (genIds && genIds.length) {
    //     if (appendQuestions || (questions !== undefined && appendQuestions)) {
    //       // append generated questions
    //       doc = await Assignment.findOneAndUpdate(
    //         { "assignments._id": taskId },
    //         { $addToSet: { "assignments.$.questions": { $each: genIds } } },
    //         { new: true }
    //       );
    //     } else {
    //       // replace with only generated (or replace what we set above)
    //       doc = await Assignment.findOneAndUpdate(
    //         { "assignments._id": taskId },
    //         { $set: { "assignments.$.questions": genIds } },
    //         { new: true }
    //       );
    //     }
    //   }
    // }

    const updatedTask = doc.assignments.id(taskId);
    return res.json({
      message: "Assignment task updated",
      assignmentId: doc._id,
      task: updatedTask,
      // assignment: doc, // optional to return whole doc
    });
  } catch (err) {
    console.error("updateAssignmentByAdmin error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// -----------------------------------------------------------------------
// Create Assignment with AI — full pipeline
// -----------------------------------------------------------------------
// Loads the source session's lesson + classwork + AI-report data, builds a
// session-report snapshot, calls the new Gemini question generator, then
// optionally fans out per-format image generation. Persists Question docs +
// an Assignment doc with the new per-format / hints / dates fields.
//
// Request body:
// {
//   classroomId, sessionId, teacherId,
//   title, description,
//   startDate, dueDate,                // ISO strings
//   perFormatCounts: { mcq, "fill-blanks", handwriting, textbox },
//   perFormatImages: { mcq, "fill-blanks", handwriting, textbox },
//   maxAiHints: int,
//   maxMarks: int,
//   studentIds: [ObjectId],
//   teacherPrompt: string,             // teacher's personalized prompt; if
//                                      // omitted, falls back to TeacherAIConfig
//   resources: [string]
// }

// Pull every classwork question for a Session and stitch in the per-question
// diagnostic-training history from ClassworkAiReport (broken out by student).
// Output matches the shape geminiAssignmentQuestions expects.
async function buildSessionReportForAssignment({ session }) {
  if (!session?._id) return { lessonName: "", questions: [] };

  const lessons = await Lesson.find({ sessionId: session._id })
    .sort({ startedAt: -1 })
    .select("name roomId")
    .lean();
  const latest = lessons[0];
  if (!latest) return { lessonName: "", questions: [] };

  const [classwork, aiReports] = await Promise.all([
    ClassworkModel.find({
      roomId: latest.roomId,
      lessonName: latest.name,
    }).lean(),
    ClassworkAiReport.find({ roomId: latest.roomId }).lean(),
  ]);

  // Index AI reports by `${questionId}::${studentId}` so we can attach
  // training history per question without an N+1 inside the loop.
  const reportIndex = new Map();
  aiReports.forEach((r) => {
    reportIndex.set(`${r.questionId}::${r.studentId}`, r);
  });

  const questions = classwork.map((q) => {
    const submitted = (q.submitted || []).map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      feedback: s.feedback || "",
    }));

    // Flatten trainingHistory across every student who attempted this
    // question so the cohort-weakness prompt sees every part3 advice string
    // Gemini emitted for this room/question. Each entry's `part3` array is
    // passed through verbatim.
    const trainingHistory = [];
    (q.submitted || []).forEach((s) => {
      const report = reportIndex.get(`${q.id}::${s.studentId}`);
      const entries = report?.trainingHistory || [];
      entries.forEach((entry) => {
        const items = Array.isArray(entry?.part3)
          ? entry.part3.map((x) => String(x ?? "").trim()).filter(Boolean)
          : [];
        if (items.length === 0) return;
        trainingHistory.push({
          studentId: s.studentId,
          studentName: s.studentName,
          part3: items,
        });
      });
    });

    return {
      question: q.question,
      format: q.format,
      correctAnswer: q.correctAnswer,
      submitted,
      trainingHistory,
    };
  });

  return { lessonName: latest.name, questions };
}

// Global-scope companion to buildSessionReportForAssignment. Walks every past
// session of the classroom and unions their classwork questions + per-question
// diagnostic-training history into one flat snapshot, so the AI can generate a
// homework set that covers the whole term rather than a single lesson.
async function buildAggregatedReportForClassroom({ classroomId }) {
  if (!classroomId) return { lessonName: "", questions: [] };

  const sessions = await Session.find({ classroomId })
    .select("_id topic")
    .lean();
  if (!sessions.length) return { lessonName: "", questions: [] };

  // For each session, look up its most recent lesson (matches
  // buildSessionReportForAssignment's "latest lesson wins" rule) so the room
  // + lessonName pair we key ClassworkModel on is unambiguous.
  const perSessionReports = await Promise.all(
    sessions.map(async (s) => {
      const lesson = await Lesson.findOne({ sessionId: s._id })
        .sort({ startedAt: -1 })
        .select("name roomId")
        .lean();
      if (!lesson) return null;
      return { session: s, lesson };
    }),
  );
  const withLesson = perSessionReports.filter(Boolean);
  if (!withLesson.length) return { lessonName: "", questions: [] };

  const [classwork, aiReports] = await Promise.all([
    ClassworkModel.find({
      $or: withLesson.map(({ lesson }) => ({
        roomId: lesson.roomId,
        lessonName: lesson.name,
      })),
    }).lean(),
    ClassworkAiReport.find({
      roomId: { $in: withLesson.map(({ lesson }) => lesson.roomId) },
    }).lean(),
  ]);

  const reportIndex = new Map();
  aiReports.forEach((r) => {
    reportIndex.set(`${r.questionId}::${r.studentId}`, r);
  });

  const questions = classwork.map((q) => {
    const submitted = (q.submitted || []).map((s) => ({
      studentId: s.studentId,
      studentName: s.studentName,
      feedback: s.feedback || "",
    }));

    const trainingHistory = [];
    (q.submitted || []).forEach((s) => {
      const report = reportIndex.get(`${q.id}::${s.studentId}`);
      const entries = report?.trainingHistory || [];
      entries.forEach((entry) => {
        const items = Array.isArray(entry?.part3)
          ? entry.part3.map((x) => String(x ?? "").trim()).filter(Boolean)
          : [];
        if (items.length === 0) return;
        trainingHistory.push({
          studentId: s.studentId,
          studentName: s.studentName,
          part3: items,
        });
      });
    });

    return {
      question: q.question,
      format: q.format,
      correctAnswer: q.correctAnswer,
      submitted,
      trainingHistory,
    };
  });

  return {
    lessonName: `All lessons (${withLesson.length} session${withLesson.length === 1 ? "" : "s"})`,
    questions,
  };
}

// Map a generated question (gemini shape) onto a Question doc.
function buildQuestionDoc({
  generated,
  classroomId,
  sessionId,
  teacherId,
  course,
  topic,
  maxAiHints,
}) {
  return {
    classroomId,
    sessionId,
    teacherId,
    course: course || "General",
    topic: topic || "General",
    questionText: generated.questionText,
    type: generated.format, // 4 formats land on the widened enum
    options: generated.options || [],
    blanks: generated.blanks || [],
    correctAnswer: generated.correctAnswer || [],
    hints: generated.hints || [],
    answer: [],
    maxAiHints,
    image: "",
    metadata: {
      difficulty: generated.difficulty || "medium",
      marks: undefined,
      tags: [topic].filter(Boolean),
      createdBy: "AI",
    },
    language: "English",
  };
}

// Concurrency-capped fan-out so one slow image gen doesn't serialise the
// rest. 3 in flight is a comfortable balance against Gemini rate limits.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        console.error("[createAssignmentWithAI] worker failed:", err?.message || err);
        results[idx] = null;
      }
    }
  });
  await Promise.all(lanes);
  return results;
}

export const createAssignmentWithAI = async (req, res) => {
  const {
    classroomId,
    sessionId,
    teacherId,
    title,
    description = "",
    startDate,
    dueDate,
    perFormatCounts = {},
    perFormatImages = {},
    maxAiHints = 0,
    maxMarks = 10,
    studentIds = [],
    teacherPrompt: teacherPromptOverride,
    resources = [],
    course,
    topic,
  } = req.body || {};

  // Basic guards. Most validation is shape-checking — heavier checks (Mongo
  // ID validity, classroom membership) happen during the Mongoose lookups.
  // sessionId is optional: when omitted the assignment runs in "all lessons"
  // (classroom-wide) scope and aggregates classwork across every past session.
  const isGlobalScope = !sessionId;
  if (!classroomId || !teacherId) {
    return res.status(400).json({
      error: "classroomId and teacherId are required.",
    });
  }
  if (!title || !dueDate) {
    return res.status(400).json({ error: "title and dueDate are required." });
  }
  const totalRequested = Object.values(perFormatCounts || {}).reduce(
    (n, v) => n + (Number(v) || 0),
    0,
  );
  if (totalRequested === 0) {
    return res.status(400).json({
      error: "At least one format must request a non-zero question count.",
    });
  }

  try {
    const [classroom, session] = await Promise.all([
      Classroom.findById(classroomId).lean(),
      isGlobalScope ? Promise.resolve(null) : Session.findById(sessionId).lean(),
    ]);
    if (!classroom) return res.status(400).json({ error: "Invalid classroomId" });
    if (!isGlobalScope && !session) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }

    const sessionReport = isGlobalScope
      ? await buildAggregatedReportForClassroom({ classroomId })
      : await buildSessionReportForAssignment({ session });
    const classroomPrompt = classroom.classroom_prompt || "";

    // Resolve teacher prompt: explicit body value wins so the panel can let
    // the teacher tweak it before generating; otherwise fall back to stored
    // TeacherAIConfig.assignmentPrompt (handled inside the gemini util).
    const useExplicitTeacherPrompt =
      typeof teacherPromptOverride === "string" && teacherPromptOverride.trim() !== "";

    const resolvedTopic = topic || session?.topic || sessionReport.lessonName || "";
    const { questions: generatedQuestions, generation } = await generateAssignmentQuestions({
      sessionReport,
      perFormatCounts,
      maxAiHints,
      course: course || classroom.subject?.name,
      topic: resolvedTopic,
      classroomPrompt,
      // If we have an explicit override, slip it into TeacherAIConfig path
      // by passing null teacherId and prepending to the prompt manually. The
      // simpler approach: pass teacherId always so the stored prompt loads,
      // and if override exists we re-decorate the standard prompt block here.
      teacherId: useExplicitTeacherPrompt ? null : teacherId,
    });
    if (useExplicitTeacherPrompt) {
      generation.teacherPrompt = teacherPromptOverride.trim();
    }

    if (!generatedQuestions.length) {
      return res.status(502).json({
        error: "AI did not return any questions. Please try again.",
      });
    }

    // Persist Question docs first so we have IDs to use for image upload
    // keys. Image generation then runs concurrently against the saved IDs.
    const baseDocs = generatedQuestions.map((q) =>
      buildQuestionDoc({
        generated: q,
        classroomId,
        sessionId: sessionId || undefined,
        teacherId,
        course: course || classroom.subject?.name,
        topic: resolvedTopic,
        maxAiHints,
      }),
    );
    const savedQuestions = await Question.insertMany(baseDocs);

    // Fan out image generation per format only when the teacher requested it.
    // The image utility already swallows individual failures, so a single
    // slow / failed call won't drop the assignment.
    const wantsImage = (format) => Boolean(perFormatImages?.[format]);
    const targetsForImages = savedQuestions
      .map((doc, idx) => ({ doc, generated: generatedQuestions[idx] }))
      .filter(({ generated }) => wantsImage(generated.format));

    if (targetsForImages.length) {
      const generatedImages = await runWithConcurrency(
        targetsForImages,
        3,
        async ({ doc, generated }) => {
          const img = await generateAssignmentQuestionImage({
            questionText: generated.imagePromptHint || generated.questionText,
            course: course || classroom.subject?.name,
            topic: resolvedTopic,
            format: generated.format,
            questionId: doc._id,
          });
          if (img?.url) {
            await Question.updateOne({ _id: doc._id }, { $set: { image: img.url } });
            return img;
          }
          return null;
        },
      );
      const okCount = generatedImages.filter(Boolean).length;
      console.log(
        `[createAssignmentWithAI] generated ${okCount}/${targetsForImages.length} images`,
      );
      if (okCount > 0) generation.imageModel = ASSIGNMENT_IMAGE_MODEL;
    }

    const task = {
      title,
      description,
      startDate: startDate ? new Date(startDate) : new Date(),
      dueDate: new Date(dueDate),
      maxMarks,
      studentIds,
      resources,
      perFormatCounts,
      perFormatImages,
      maxAiHints,
      questions: savedQuestions.map((q) => q._id),
      generation,
    };

    const assignmentDoc = await Assignment.create({
      classroomId,
      ...(sessionId ? { sessionId } : {}),
      teacherId,
      assignments: [task],
    });

    // Backfill assignmentId on the saved Question docs so the existing
    // assignment-by-question lookups continue to work.
    await Question.updateMany(
      { _id: { $in: savedQuestions.map((q) => q._id) } },
      { $set: { assignmentId: assignmentDoc._id } },
    );

    await assignmentDoc.populate({ path: "assignments.questions" });

    // Reuse the existing notifier so students + parents get the same
    // notification shape as the legacy create flow.
    try {
      await notifyNewAssignment({
        assignmentDoc,
        tasks: assignmentDoc.assignments,
        actorId: teacherId,
        classroomId,
        sessionId,
        io: req.app?.get("io"),
      });
    } catch (notifyErr) {
      console.error("[createAssignmentWithAI] notify failed:", notifyErr);
    }

    return res.status(201).json({
      message: "Assignment created with AI.",
      assignment: assignmentDoc,
      stats: {
        questionsGenerated: savedQuestions.length,
        questionModel: ASSIGNMENT_QUESTION_MODEL,
        imageRequested: targetsForImages.length,
      },
    });
  } catch (err) {
    console.error("createAssignmentWithAI error:", err);
    return res.status(500).json({ error: err.message });
  }
};
