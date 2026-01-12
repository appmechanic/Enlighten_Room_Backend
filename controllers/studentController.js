import Assignment from "../models/AssignmentModel.js";
import Classroom from "../models/classroomModel.js";
import GradedAnswerModel from "../models/GradedAnswerModel.js";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import GradeSetting from "../models/GradeSetting.js";
import Parent from "../models/parentModel.js";
import Question from "../models/QuestionModel.js";
import Session from "../models/SessionModel.js";
import StudentAssignmentStatus from "../models/StudentAssignmentStatus.js";
import Student from "../models/studentModel.js";
import Teacher from "../models/teacherModel.js";
import User from "../models/user.js";
import { addSendEmail } from "../utils/addSendEmail.js";
import { sendAssignmentReportEmails } from "../utils/emailAssignmentReport.js";
import { getGradeFromPercentage } from "../utils/gradeHelper.js";
import { notifyAssignmentReport } from "../utils/notify.js";
// import { notifyAssignmentReport } from "../utils/notification.helper.js";
import { gradeDynamic } from "./Ai-tasks/ai-grader.js";

function stripQuotes(str) {
  return str?.replace(/^['"]|['"]$/g, "").trim();
}

const generateUniqueUserName = async (firstName, lastName) => {
  let base = `${firstName}${lastName}`.toLowerCase().replace(/\s/g, "");
  let userName;
  let exists = true;

  while (exists) {
    const suffix = Math.floor(100 + Math.random() * 900); // 3-digit random
    userName = `${base}${suffix}`;
    exists = await User.findOne({ userName });
  }

  return userName;
};

// Create a new student
export const createStudent = async (req, res) => {
  try {
    const LoggedUser = req?.user?._id;
    const {
      email,
      password,
      firstName,
      lastName,
      parentId,
      teacherId,
      age,
      city,
      language,
      date_of_birth,
      country,
      ...rest
    } = req.body;

    if (!email || !password || !firstName || !date_of_birth || !lastName) {
      return res.status(404).json({
        error: "required fields missing",
      });
    }
    // ✅ Check if email format is valid and has no spaces
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    if (parentId) {
      const parent = await User.findOne({ _id: parentId, userRole: "parent" });
      if (!parent) {
        return res.status(400).json({ error: "Parent not found" });
      }
    }
    if (teacherId) {
      const teacher = await User.findOne({
        _id: teacherId,
        userRole: "teacher",
      });
      if (!teacher) {
        return res.status(400).json({ error: "Teacher not found" });
      }
    }

    // console.log("parent", parent);
    // console.log("teacher", teacher);

    // Check if email already exists in User
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(409)
        .json({ error: "User with this email already registered" });
    }

    // Generate unique userName
    const userName = await generateUniqueUserName(firstName, lastName);

    // Create User entry
    const user = new User({
      email,
      // userId: user._id,
      password,
      userRole: "student",
      is_verified: true,
      is_active: true,
      userName,
      firstName,
      lastName,
      parentId,
      teacherId,
      date_of_birth,
      age,
      city,
      language,
      country,
      // referedBy: LoggedUser ? LoggedUser : "",
      ...rest,
    });

    // // Optionally create a Student-specific record if you still use the Student model
    // const student = new Student({
    //   userId: user._id,
    //   email,
    //   password,
    //   is_verified: true,
    //   userName,
    //   firstName,
    //   lastName,
    //   referedBy: LoggedUser,
    //   ...rest,
    // });

    // ✅ Send Email
    const html = `
      <h3>Welcome to Enlighten Room!</h3>
      <p>Your account has been created.</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Password:</strong> ${password}</p>
      <p><strong>Username:</strong> ${userName}</p>
      <p>You can now log in and start using the platform.</p>
    `;

    try {
      await addSendEmail(email, "Your Enlighten Room Account", html);
      // ✅ Populate parentId and teacherId
      await user.save();
      const populatedUser = await User.findOne({ _id: user._id })
        .populate("parentId", "firstName lastName email")
        .populate("teacherId", "firstName lastName email")
        .populate("referedBy", "firstName lastName email");
      res.status(201).json({ populatedUser });

      // await student.save();
    } catch (error) {
      console.error("Error sending email:", error);
    }
  } catch (error) {
    console.log(error);
    res.status(400).json({ error: error.message });
  }
};

// Get all students
export const getAllStudents = async (req, res) => {
  try {
    const students = await User.find({ userRole: "student" })
      .populate("teacherId", "firstName lastName email")
      .populate("parentId", "firstName lastName email")
      .populate("referedBy", "firstName lastName email")
      .select(
        "firstName lastName userName email userRole settings date_of_birth is_active is_verified image phone gender city country language age"
      );
    res.status(200).json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get a single student by ID
export const getStudentById = async (req, res) => {
  try {
    const student = await User.findOne({
      _id: req.params.id,
      userRole: "student",
    })
      .populate("teacherId", "firstName lastName email")
      .populate("parentId", "firstName lastName email")
      .populate("referedBy", "firstName lastName email")
      .select(
        "firstName lastName userName email userRole settings image phone date_of_birth gender city country language age"
      );
    if (!student) return res.status(404).json({ error: "Student not found" });
    res.status(200).json(student);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update student by ID
export const updateStudent = async (req, res) => {
  try {
    // Disallowed fields for update

    const disallowedFields = [
      "email",
      "userName",
      "password",
      "userRole",
      "referedBy",
      "is_verified",
      "is_active",
      "isAdmin",
      "OTP_code",
      "isSuspended",
      "isPaid",
    ];

    // Remove disallowed fields from the update payload
    disallowedFields.forEach((field) => delete req.body[field]);

    // const users = await User.find({ email: req.body.email });
    // if (users.length > 0) {
    //   return res
    //     .status(409)
    //     .json({ error: "Student with this email already registered" });
    // }

    const student = await User.findOneAndUpdate(
      { _id: req.params.id, userRole: "student" },
      req.body,
      {
        new: true,
      }
    )
      .populate("teacherId", "firstName lastName email")
      .populate("parentId", "firstName lastName email")
      .populate("referedBy", "firstName lastName email")
      .select(
        "settings image firstName lastName userName email userRole city country language age ai_enabled"
      );

    if (!student) return res.status(404).json({ error: "Student not found" });
    res.status(200).json(student);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Delete student by ID
export const deleteStudent = async (req, res) => {
  try {
    const student = await User.findOneAndDelete({
      _id: req.params.id,
      userRole: "student",
    });
    if (!student) return res.status(404).json({ error: "Student not found" });
    // Option 1: If Student has userId field
    if (student.userId) {
      await User.findByIdAndDelete(student.userId);
    }
    res.status(200).json({ message: "Student deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update student settings
export const updateStudentSettings = async (req, res) => {
  try {
    const { screenLocked, sendReport, saveToDrive, emailNotFocus } = req.body;

    const student = await User.findOneAndUpdate(
      { _id: req.params.id, userRole: "student" },
      {
        $set: {
          "settings.screenLocked": screenLocked,
          "settings.sendReport": sendReport,
          "settings.saveToDrive": saveToDrive,
          "settings.emailNotFocus": emailNotFocus,
        },
      },
      { new: true, runValidators: true }
    )
      .populate("teacherId", "firstName lastName email")
      .populate("parentId", "firstName lastName email")
      .populate("referedBy", "firstName lastName email")
      .select(
        "settings image firstName lastName userName email userRole city country language age"
      );

    if (!student) return res.status(404).json({ error: "Student not found" });

    res.status(200).json({
      message: "Student settings updated successfully",
      student,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Set or update student remark
export const addStudentRemark = async (req, res) => {
  try {
    const { remark } = req.body;

    if (!remark || typeof remark !== "string") {
      return res
        .status(400)
        .json({ error: "Remark must be a non-empty string" });
    }

    const student = await User.findOneAndUpdate(
      { _id: req.params.id, userRole: "student" },
      { remarks: remark },
      { new: true, runValidators: true }
    )
      .populate("teacherId", "firstName lastName email")
      .populate("parentId", "firstName lastName email")
      .populate("referedBy", "firstName lastName email")
      .select(
        "settings image firstName lastName userName email userRole remarks city country language age"
      );

    if (!student) return res.status(404).json({ error: "Student not found" });

    res.status(200).json({
      message: "Remark updated successfully",
      student,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

export const getStudentsByTeacherId = async (req, res) => {
  try {
    const { teacherId } = req.params;

    const students = await User.find({
      userRole: "student",
      teacherId: teacherId,
    })
      .populate("teacherId", "firstName lastName email")
      .populate("parentId", "firstName lastName email")
      .populate("referedBy", "firstName lastName email")
      .select(
        "settings image firstName lastName userName email userRole date_of_birth phone gender age city country language createdAt ai_enabled"
      );

    if (!students || students.length === 0) {
      return res
        .status(404)
        .json({ message: "No students found for this teacher" });
    }

    res.status(200).json(students);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Start assignment
export const startAssignment = async (req, res) => {
  try {
    const { studentId, assignmentId, durationMinutes, settings } = req.body;

    if (!studentId || !assignmentId || !durationMinutes) {
      return res.status(400).json({
        error: "studentId, assignmentId, and durationMinutes are required",
      });
    }

    const student = await User.findOne({ _id: studentId, userRole: "student" });
    if (!student) return res.status(404).json({ error: "Student not found" });

    const parentAssignment = await Assignment.findOne({
      "assignments._id": assignmentId,
    });
    if (!parentAssignment)
      return res.status(404).json({ error: "Assignment not found" });

    const subAssignment = parentAssignment.assignments.find(
      (a) => a._id.toString() === assignmentId
    );
    if (!subAssignment)
      return res.status(404).json({ error: "Sub-assignment not found" });

    const isEligible = subAssignment.studentIds.some(
      (id) => id.toString() === studentId.toString()
    );
    if (!isEligible)
      return res
        .status(403)
        .json({ error: "Student not assigned to this assignment" });

    const existing = await StudentAssignmentStatus.findOne({
      studentId,
      assignmentId,
    });
    if (existing)
      return res.status(400).json({ message: "Assignment already started" });

    const now = new Date();
    const dueTime = new Date(now.getTime() + durationMinutes * 60000);

    const assignmentStatus = new StudentAssignmentStatus({
      studentId,
      assignmentId,
      startTime: now,
      dueTime,
      isStarted: true,
      settings,
    });

    await assignmentStatus.save();
    res.status(200).json({
      message: "Assignment started successfully",
      data: assignmentStatus,
    });
  } catch (err) {
    console.error("Error starting assignment:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Submit assignment manually
export const submitAssignment = async (req, res) => {
  try {
    const {
      studentId,
      subAssignmentId,
      answers,
      isAutoSubmitted = false,
    } = req.body;

    if (!studentId || !subAssignmentId || !Array.isArray(answers)) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // 🔎 Load student to check ai_enabled
    const student = await User.findById(studentId).lean();
    if (!student) {
      return res.status(404).json({ error: "Student not found." });
    }
    const includeRemarks = !!student.ai_enabled; // <-- your toggle

    // Step 1: Find the parent assignment that contains the sub-assignment
    const parentAssignment = await Assignment.findOne({
      "assignments._id": subAssignmentId,
    }).lean();

    if (!parentAssignment) {
      return res.status(404).json({ error: "Sub-assignment not found." });
    }

    // Step 2: Get the sub-assignment object
    const subAssignment = parentAssignment.assignments.find(
      (a) => a._id.toString() === subAssignmentId
    );

    if (!subAssignment) {
      return res
        .status(404)
        .json({ error: "Sub-assignment not found inside assignment." });
    }

    // Step 3: Fetch questions and prepare for AI
    const questionsWithAnswers = [];

    for (const { questionId, answer: studentAnswer } of answers) {
      const question = await Question.findById(questionId).lean();
      if (!question) continue;

      questionsWithAnswers.push({
        question: question.questionText,
        answer: studentAnswer.join(", "),
        maxMarks: subAssignment.maxMarks,
        questionId,
        correctAnswer: question.correctAnswer || [],
      });
    }

    // console.log("questionsWithAnswers prepared:", questionsWithAnswers);
    // Step 4: Send to AI for grading
    const aiResults = await gradeDynamic(questionsWithAnswers, {
      teacherId: parentAssignment.teacherId,
    });

    // Step 5: Build gradedAnswers from AI result
    let totalScore = 0;
    let maxScore = 0;
    let correctCount = 0;
    let remarks = "";
    const gradedAnswers = [];
    // remarks =  || "";

    for (const result of aiResults.graded) {
      // Match using question text only (better: use questionId if AI returns it)
      const original = questionsWithAnswers.find(
        (q) => q.question?.trim() === result.question?.trim()
      );

      if (!original) {
        console.warn("No match found for result:", result.question);
        continue;
      }

      const submittedAnswerArray = result.answer
        .split(",")
        .map((s) => stripQuotes(s?.trim()));

      const correctAnswerArray = Array.isArray(original.correctAnswer)
        ? original.correctAnswer.map((s) => s?.trim())
        : [];

      const isCorrect = result.score === result.maxMarks;

      if (isCorrect) correctCount++;
      totalScore += result.score;
      maxScore += result.maxMarks;
      gradedAnswers.push({
        questionId: original.questionId,
        submittedAnswer: submittedAnswerArray,
        correctAnswer: correctAnswerArray,
        isCorrect,
        score: result.score,
        maxScore: result.maxMarks,
        feedback: result.feedback,
        subAssignmentId,
      });
    }

    const totalQuestions = gradedAnswers.length;
    const incorrectCount = totalQuestions - correctCount;

    // ✅ Calculate percentage
    const percentage =
      maxScore > 0 ? parseFloat(((totalScore / maxScore) * 100).toFixed(2)) : 0;

    // Step 6: Fetch grade scale from DB
    let grade = "Grades not defined";
    let gradePoint = null;

    // console.log("parentAssignment.teacherId", parentAssignment.teacherId);

    const gradeSetting = await GradeSetting.findOne({
      teacherId: parentAssignment.teacherId,
    });

    // console.log("gradeSetting", gradeSetting);
    // console.log("percentage", percentage);

    if (gradeSetting && Array.isArray(gradeSetting.grades)) {
      const matched = gradeSetting.grades.find(
        (g) => percentage >= g.minPercent && percentage <= g.maxPercent
      );
      if (matched) {
        grade = matched.letter;
        // gradePoint = matched.gradePoint;
      }
    }

    // Step 7: Save graded answer
    const gradedDoc = await GradedAnswerModel.create({
      studentId,
      assignmentId: parentAssignment._id,
      sessionId: parentAssignment.sessionId,
      classroomId: parentAssignment.classroomId,
      gradedBy: "AI",
      isAutoSubmitted,
      gradedAnswers,
      totalQuestions,
      correctCount,
      incorrectCount,
      percentage,
      grade,
      // gradePoint,
      overall_remarks: includeRemarks ? aiResults.overall_remarks || "" : "",
    });

    // Populate classroomId to access settings
    const populatedGradedDoc = await GradedAnswerModel.findById(gradedDoc._id)
      .populate("classroomId")
      .lean();

    console.log("Graded submission saved:", populatedGradedDoc);

    await Assignment.updateOne(
      { "assignments._id": subAssignmentId },
      {
        $set: {
          "assignments.$.assignmentStatus": "submitted",
        },
      }
    );

    // Check if classroom settings allow sending report
    const shouldSendReport =
      populatedGradedDoc?.classroomId?.settings?.sendReport;

    // 🔔 Send notifications and emails only if sendReport is true
    if (shouldSendReport) {
      try {
        await notifyAssignmentReport({
          studentId,
          subAssignmentTitle: subAssignment.title || "Assignment",
          parentAssignmentId: parentAssignment._id.toString(),
          sessionId:
            parentAssignment.sessionId?.toString?.() ||
            parentAssignment.sessionId,
          classroomId:
            parentAssignment.classroomId?.toString?.() ||
            parentAssignment.classroomId,
          gradedDoc: populatedGradedDoc,
          percentage,
          grade,
          includeRemarks,
          actorId:
            parentAssignment.teacherId?.toString?.() ||
            parentAssignment.teacherId,
          io: req.app?.get("io"),
        });

        await sendAssignmentReportEmails({
          studentId,
          subAssignmentTitle: subAssignment.title || "Assignment",
          parentAssignmentId: parentAssignment._id.toString(),
          sessionId:
            parentAssignment.sessionId?.toString?.() ||
            parentAssignment.sessionId,
          classroomId:
            parentAssignment.classroomId?.toString?.() ||
            parentAssignment.classroomId,
          gradedDoc: populatedGradedDoc,
          percentage,
          grade,
          includeRemarks,
        });
      } catch (notifyErr) {
        console.error("notifyAssignmentReport error:", notifyErr);
        // Don't block submission if notifications fail
      }
    } else {
      console.log(
        "Report sending disabled for this classroom - skipping notifications and emails"
      );
    }

    res.status(200).json({
      message: "Your assignment is being submitted",
      // gradedAnswer: newGradedAnswer,
    });
  } catch (err) {
    console.error("Error submitting assignment:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Auto-submit overdue assignments
export const autoSubmitAssignments = async (req, res) => {
  try {
    const now = new Date();

    const overdueAssignments = await StudentAssignmentStatus.find({
      isCompleted: false,
      dueTime: { $lt: now },
    });

    for (const assignment of overdueAssignments) {
      assignment.isCompleted = true;
      assignment.isAutoSubmitted = true;
      assignment.endTime = now;
      assignment.score = 0;
      assignment.feedback = "Auto-submitted due to timeout";
      await assignment.save();
    }

    res.status(200).json({
      message: "Auto-submitted overdue assignments",
      count: overdueAssignments.length,
    });
  } catch (err) {
    console.error("Error auto-submitting:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ---- date helpers ----
const atStart = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const atEnd = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const inRange = (d, a, b) => d >= a && d <= b;
const byDue = (a, b) => new Date(a.dueAt) - new Date(b.dueAt);

/**
 * Build assignment deadline buckets from your existing `allAssignments`.
 * - If `studentId` is provided, only include tasks that target that student.
 * - Otherwise (teacher dashboard), include all tasks in those assignments.
 *
 * Expected shape:
 * allAssignments = [{ _id, classroomId?, teacherId?, assignments: [{ _id, title?, dueDate, studentIds[], course?, topic? }] }]
 */
// const pickAssignmentDeadlineBuckets = (allAssignments, { studentId } = {}) => {
//   const _now = new Date();
//   const _todayStart = new Date(
//     _now.getFullYear(),
//     _now.getMonth(),
//     _now.getDate()
//   );
//   const _todayEnd = new Date(
//     _now.getFullYear(),
//     _now.getMonth(),
//     _now.getDate(),
//     23,
//     59,
//     59,
//     999
//   );
//   const _pastStart = new Date(_todayStart);
//   _pastStart.setDate(_pastStart.getDate() - 15);
//   const _pastEnd = new Date(_todayStart.getTime() - 1);
//   const _upStart = new Date(_todayEnd.getTime() + 1);
//   const _upEnd = new Date(_todayEnd);
//   _upEnd.setDate(_upEnd.getDate() + 30);

//   const _buckets = { today: [], past15Days: [], upcoming30Days: [] };

//   for (const group of allAssignments || []) {
//     const tasks = Array.isArray(group.assignments) ? group.assignments : [];
//     for (const t of tasks) {
//       if (!t || !t.dueDate) continue;

//       // If you're in the STUDENT dashboard, keep this guard:
//       // (remove it in Teacher dashboard)
//       if (typeof studentId !== "undefined") {
//         const list = Array.isArray(t.studentIds) ? t.studentIds : [];
//         const isMine = list.some((id) => String(id) === String(studentId));
//         if (!isMine) continue;
//       }

//       const due = new Date(t.dueDate);
//       if (isNaN(due)) continue;

//       // Minimal merged data (only what you already have)
//       const item = {
//         id: t._id || `${group._id}:${due.getTime()}`,
//         title: t.title || "Assignment Deadline",
//         dueAt: due.toISOString(),
//         allDay: true,

//         // merged fields (will be ObjectIds if you didn't populate)
//         course: t.course || null,
//         topic: t.topic || null,
//         classroomId: group.classroomId || null,
//         teacherId: group.teacherId || null,

//         // audience
//         students: (Array.isArray(t.studentIds) ? t.studentIds : []).map((s) =>
//           s?.toString ? s.toString() : String(s)
//         ),
//         studentsCount: Array.isArray(t.studentIds) ? t.studentIds.length : 0,
//       };

//       if (due >= _todayStart && due <= _todayEnd) {
//         _buckets.today.push(item);
//       } else if (due >= _pastStart && due <= _pastEnd) {
//         _buckets.past15Days.push(item);
//       } else if (due >= _upStart && due <= _upEnd) {
//         _buckets.upcoming30Days.push(item);
//       }
//     }
//   }

//   // optional: sort by due date
//   _buckets.today.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
//   _buckets.past15Days.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
//   _buckets.upcoming30Days.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

//   // final object to include in your res.json
//   const assignmentDeadlines = {
//     today: { count: _buckets.today.length, items: _buckets.today },
//     past15Days: {
//       count: _buckets.past15Days.length,
//       items: _buckets.past15Days,
//     },
//     upcoming30Days: {
//       count: _buckets.upcoming30Days.length,
//       items: _buckets.upcoming30Days,
//     },
//   };
// };

//Dashboard
export const getStudentDashboard = async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId) {
      return res.status(400).json({ error: "Student ID is required." });
    }

    const student = await User.findOne({ _id: studentId, userRole: "student" })
      .populate("parentId", "firstName lastName email userId _id")
      .populate("teacherId", "firstName lastName email userId _id")
      .populate("referedBy", "firstName lastName email userId _id")
      .select(
        "firstName lastName userName email userRole settings image phone gender city country"
      )
      .lean();
    if (!student) {
      return res.status(404).json({ error: "Student not found." });
    }

    const sameLocalDay = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();

    const nowLocal = new Date();

    const now = new Date();
    const startOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const endOfDay = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    );

    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);

    // 1. Get all assignments where this student is assigned
    const allAssignments = await Assignment.find({
      "assignments.studentIds": studentId,
    })
      .select("classroomId sessionId teacherId assignments") // ensure sessionId is included
      .populate("sessionId", "topic sessionDate sessionUrl classroomId") // optional
      // .populate(
      //   "assignments.questions",
      //   "course topic questionText type options hints "
      // )
      .lean();

    const uniqueStudentIds = new Set();
    for (const grp of allAssignments || []) {
      for (const task of grp.assignments || []) {
        for (const sid of task?.studentIds || []) {
          uniqueStudentIds.add(String(sid));
        }
      }
    }

    let studentsById = new Map();
    if (uniqueStudentIds.size) {
      const studentDocs = await User.find({
        _id: { $in: [...uniqueStudentIds] },
        userRole: "student",
      })
        .select(
          "_id firstName lastName userName email image settings gender city country"
        )
        .lean();

      studentsById = new Map(studentDocs.map((s) => [String(s._id), s]));
    }

    const todayStr = new Date().toISOString().split("T")[0];
    // Extract assignments due today
    const todayAssignments = [];
    const thisWeekAssignments = [];

    allAssignments.forEach((assignmentGroup) => {
      (assignmentGroup.assignments || []).forEach((task) => {
        if (!task?.dueDate) return;

        // only if this student is assigned
        if (!task.studentIds?.some((id) => String(id) === String(studentId)))
          return;

        const dueStr = new Date(task.dueDate).toISOString().split("T")[0];

        if (dueStr === todayStr) {
          todayAssignments.push(task);
        } else {
          thisWeekAssignments.push(task);
        }
      });
    });

    // --- Classrooms the student belongs to, with classmates populated ---
    const classrooms = await Classroom.find({ studentIds: studentId })
      .select(
        "subject sessions teacherId studentIds settings room dateTime createdAt scope frequency duration lastDate expiryDateTime"
      )
      .populate("subject")
      .populate("teacherId", "firstName lastName email image _id")
      // .populate({ path: "classroomId", populate: { path: "teacherId" } })
      .populate("studentIds", "firstName lastName userName email image _id")
      .lean();

    // right after: const classrooms = await Classroom.find(...).lean();
    const classroomIds = classrooms.map((c) => c._id);
    const classroomMap = new Map(classrooms.map((c) => [String(c._id), c]));

    // classmates per-classroom (excluding current student)
    const classmatesByClassroom = classrooms.map((cls) => {
      const classmates = (cls.studentIds || []).filter(
        (st) => st._id.toString() !== studentId
      );
      return {
        classroomId: cls._id,
        subject: cls.subject,
        teacherId: cls.teacherId,
        dateTime: cls.dateTime,
        frequency: cls.frequency,
        createdAt: cls.createdAt,
        duration: cls.duration,
        lastDate: cls.lastDate,
        scope: cls.scope,
        expiryDateTime: cls.expiryDateTime,
        frequency: cls.frequency,
        settings: cls?.settings,
        // classmates,
      };
    });

    // 2. Get today's sessions and this week's sessions
    const todaySessionsRaw = await Session.find({
      classroomId: { $in: classroomIds },
      sessionDate: { $gte: startOfDay, $lte: endOfDay },
    })
      .select("_id topic sessionDate sessionUrl classroomId")
      .populate({
        path: "classroomId",
        populate: [
          {
            path: "teacherId",
            select: "firstName lastName email image _id",
          },
          { path: "subject" }, // e.g. select: "name code _id"
        ],
      })
      .lean();

    const thisWeekSessionsRaw = await Session.find({
      classroomId: { $in: classroomIds },
      sessionDate: { $gte: new Date(), $lte: weekEnd },
    })
      .select("_id topic sessionDate sessionUrl classroomId")
      .populate({
        path: "classroomId",
        populate: [
          {
            path: "teacherId",
            select: "firstName lastName email image _id",
          },
          { path: "subject" }, // e.g. select: "name code _id"
        ],
      })
      .lean();

    // Enrich with students from the classroom (and optional subject)
    const mapSession = (s) => {
      const cls = classroomMap.get(String(s.classroomId));
      return {
        ...s,
        subject: cls?.subject ?? null,
        students: (cls?.studentIds ?? []).map((st) => st?._id ?? st), // if populated use _id, else ObjectId
      };
    };

    const todaySessions = todaySessionsRaw.map(mapSession);
    const thisWeekSessions = thisWeekSessionsRaw.map(mapSession);

    // 3. Get submission status
    const statuses = await User.find({
      _id: studentId,
      userRole: "student",
    }).lean();

    const completed = statuses.filter(
      (s) => s.isCompleted && !s.isAutoSubmitted
    ).length;
    const autoSubmitted = statuses.filter((s) => s.isAutoSubmitted).length;
    const pending = statuses.filter((s) => !s.isCompleted).length;

    // 4. Get graded results
    const gradedSubmissions = await GradedSubmission.find({ studentId }).lean();

    const avgScore =
      gradedSubmissions.length > 0
        ? Math.round(
            gradedSubmissions.reduce((sum, s) => sum + s.totalScore, 0) /
              gradedSubmissions.length
          )
        : null;

    // =========================
    // NEW: Simple Calendar Data
    // Range: previous 1 month → next 2 months
    // =========================
    const now2 = new Date();
    const rangeStart = new Date(now2);
    rangeStart.setMonth(rangeStart.getMonth() - 1);
    rangeStart.setHours(0, 0, 0, 0);
    const rangeEnd = new Date(now2);
    rangeEnd.setMonth(rangeEnd.getMonth() + 2);
    rangeEnd.setHours(23, 59, 59, 999);

    // helper (tiny & simple)
    const addMinutes = (date, min) => {
      const d = new Date(date);
      d.setMinutes(d.getMinutes() + (Number(min) || 60));
      return d;
    };
    const incByFrequency = (date, freq) => {
      const d = new Date(date);
      const f = String(freq || "once").toLowerCase();
      if (f === "daily") d.setDate(d.getDate() + 1);
      else if (f === "weekly") d.setDate(d.getDate() + 7);
      else if (f === "biweekly") d.setDate(d.getDate() + 14);
      else if (f === "monthly") d.setMonth(d.getMonth() + 1);
      else return null; // "once"
      return d;
    };

    // A) CLASS EVENTS from classrooms you already loaded
    const classEvents = [];
    for (const cls of classrooms) {
      if (!cls?.dateTime) continue;

      const durationMin = Number(cls?.duration) || 60;
      const freq = String(cls?.frequency || "once").toLowerCase();
      const hardStop = new Date(
        Math.min(
          rangeEnd.getTime(),
          cls?.expiryDateTime
            ? new Date(cls.expiryDateTime).getTime()
            : rangeEnd.getTime(),
          cls?.lastDate ? new Date(cls.lastDate).getTime() : rangeEnd.getTime()
        )
      );

      // "once" – just push if in range
      if (!["daily", "weekly", "biweekly", "monthly"].includes(freq)) {
        const start = new Date(cls.dateTime);
        const end = addMinutes(start, durationMin);
        if (end >= rangeStart && start <= rangeEnd) {
          classEvents.push({
            id: cls._id,
            type: "class",
            title: cls?.settings?.room ? cls.settings.room : "Class",
            start,
            end,
            allDay: false,
          });
        }
      } else {
        // recurring
        let cursor = new Date(cls.dateTime);

        // fast-forward to first occurrence >= (rangeStart - one period)
        while (cursor < rangeStart) {
          const next = incByFrequency(cursor, freq);
          if (!next || next <= cursor) break;
          cursor = next;
          if (cursor > hardStop) break;
        }

        let safety = 0;
        while (cursor <= hardStop && safety < 500) {
          safety++;
          const start = new Date(cursor);
          const end = addMinutes(start, durationMin);

          if (end >= rangeStart && start <= rangeEnd) {
            classEvents.push({
              id: cls._id,
              type: "class",
              title: cls?.settings?.room ? cls.settings.room : "Class",
              start,
              end,
              allDay: false,
            });
          }

          const next = incByFrequency(cursor, freq);
          if (!next || next <= cursor) break;
          cursor = next;
        }
      }
    }

    // B) SESSION EVENTS (fetch only for the calendar window)
    const calendarSessions = await Session.find({
      classroomId: { $in: classroomIds },
      sessionDate: { $gte: rangeStart, $lte: rangeEnd },
    });
    // .select("_id topic sessionDate classroomId duration")
    // .lean();

    const sessionEvents = calendarSessions
      .map((s) => {
        const cls = classroomMap.get(String(s.classroomId));
        const start = new Date(s.sessionDate);
        const dur =
          Number(s?.duration) > 0
            ? Number(s.duration)
            : Number(cls?.duration) || 60;

        // console.log("Session Event:", s);
        return {
          id: s._id,
          type: "session",
          title: s.topic || "Session",
          start,
          sessionUrl: s.sessionUrl || null,
          end: addMinutes(start, dur),
          allDay: false,

          classroomId: s.classroomId,
          subject: cls?.subject ?? null,
        };
      })
      .filter(Boolean) // drop any nulls from missing classrooms
      .sort((a, b) => a.start - b.start);

    // C) ASSIGNMENT DEADLINES (use allAssignments you already loaded)
    const assignmentEvents = [];
    for (const group of allAssignments) {
      const cls = classroomMap.get(String(group.classroomId)) || null;
      for (const task of group.assignments || []) {
        if (!task?.dueDate) continue;
        const isMine = (task.studentIds || []).some(
          (id) => String(id) === String(studentId)
        );
        if (!isMine) continue;

        const due = new Date(task.dueDate);
        if (due >= rangeStart && due <= rangeEnd) {
          const start = new Date(due.setHours(0, 0, 0, 0));
          const end = new Date(due.setHours(23, 59, 59, 999));
          assignmentEvents.push({
            id: group._id,
            type: "assignment",
            title: task?.title || "Assignment Deadline",
            classroom: cls,

            description: task?.description,
            assignmentStatus: task?.assignmentStatus,

            session: group.sessionId,
            // session:
            //   typeof group.sessionId === "object" ? group.sessionId : undefined,
            start,
            end,
            allDay: true,
          });
        }
      }
    }

    const calendarEvents = [
      ...classEvents,
      ...sessionEvents,
      ...assignmentEvents,
    ].sort((a, b) => new Date(a.start) - new Date(b.start));

    // === Date-only helpers (UTC) ===
    const ymdUTC = (d) => new Date(d).toISOString().split("T")[0]; // "YYYY-MM-DD"
    const dayIndex = (ymd) => {
      const [y, m, d] = ymd.split("-").map(Number);
      return Date.UTC(y, m - 1, d) / 86400000; // days since epoch
    };

    const todayKey = ymdUTC(new Date()); // e.g. "2025-09-02"
    const todayIdx = dayIndex(todayKey);

    const _buckets = { today: [], past15Days: [], upcoming30Days: [] };

    for (const group of allAssignments || []) {
      const cls = classroomMap.get(String(group.classroomId)) || null;
      const tasks = Array.isArray(group.assignments) ? group.assignments : [];
      for (const t of tasks) {
        if (!t?.dueDate) continue;

        // only keep tasks for this student
        const list = Array.isArray(t.studentIds) ? t.studentIds : [];
        if (!list.some((id) => String(id) === String(studentId))) continue;

        // date-only key in UTC for due date
        const dueKey = ymdUTC(t.dueDate);
        const dueIdx = dayIndex(dueKey);
        const diff = dueIdx - todayIdx; // 0=today, -1=yesterday, +1=tomorrow
        const studentIdsOnly = list.map((s) =>
          s?.toString ? s.toString() : String(s)
        );
        const studentsFull = studentIdsOnly
          .map((id) => studentsById.get(id))
          .filter(Boolean);

        const item = {
          id: t?._id || `${group?._id}:${dueKey}`,
          title: t?.title || "Assignment Deadline",
          description: t?.description,
          assignmentStatus: t?.assignmentStatus,
          dueAt: new Date(t.dueDate).toISOString(),
          allDay: true,
          classroom: cls,
          course: t?.course || null,
          topic: t?.topic || null,
          classroomId: group?.classroomId || null,
          session: group?.sessionId,
          teacherId: group?.teacherId || null,
          // students: list?.map((s) => (s?.toString ? s.toString() : String(s))),
          students: studentsFull,
          studentsCount: list?.length,
        };

        if (diff === 0) {
          _buckets.today.push(item);
        } else if (diff < 0 && diff >= -15) {
          _buckets.past15Days.push(item);
        } else if (diff > 0 && diff <= 30) {
          _buckets.upcoming30Days.push(item);
        }
      }
    }

    // sort by due date asc
    const byDueAsc = (a, b) => new Date(a.dueAt) - new Date(b.dueAt);
    _buckets.today.sort(byDueAsc);
    _buckets.past15Days.sort(byDueAsc);
    _buckets.upcoming30Days.sort(byDueAsc);

    // final object
    const assignmentDeadlines = {
      today: { count: _buckets.today.length, items: _buckets.today },
      past15Days: {
        count: _buckets.past15Days.length,
        items: _buckets.past15Days,
      },
      upcoming30Days: {
        count: _buckets.upcoming30Days.length,
        items: _buckets.upcoming30Days,
      },
    };

    res.status(200).json({
      student,
      classClalender: classmatesByClassroom,
      assignmentDeadlines,
      todayAssignments,
      thisWeekAssignments,
      todaySessions,
      thisWeekSessions,
      allAssignments,
      submissionStatuses: statuses,
      reports: {
        averageScore:
          avgScore !== null ? avgScore : "No submissions graded yet",
        completedAssignments: completed,
        autoSubmittedAssignments: autoSubmitted,
        pendingAssignments: pending,
      },
      // NEW (for Month/Week/Day calendar use):
      calendar: {
        rangeStart,
        rangeEnd,
        counts: {
          classes: classEvents.length,
          sessions: sessionEvents.length,
          assignments: assignmentEvents.length,
        },
        events: calendarEvents,
      },
      success: true,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getClassroomsByStudentId = async (req, res) => {
  const { studentId } = req.params;

  try {
    const classrooms = await Classroom.find({ studentIds: studentId })
      .populate("teacherId", "name email firstName lastName userId")
      .populate("subject", "name code classLevel")
      .populate({
        path: "studentIds",
        select: "name email firstName lastName userId parentId",
        populate: {
          path: "parentId",
          select: "name email firstName lastName relation",
        },
      })
      .populate("sessions", "sessionDate topic notes sessionUrl")
      .select("-__v ");

    if (!classrooms || classrooms.length === 0) {
      res.status(404).json({
        success: false,
        message: "no classrooms are found",
      });
    }
    return res.status(200).json({ success: true, data: classrooms });
  } catch (error) {
    console.error("Error fetching classrooms for student:", error);
    res.status(500).json({ message: "Failed to fetch classrooms", error });
  }
};
