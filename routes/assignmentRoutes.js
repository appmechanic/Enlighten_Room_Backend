import express from "express";
import {
  assignStudentsToAssignment,
  createAssignment,
  createnewAssignment,
  createAssignmentWithAI,
  deleteAssignmentById,
  deleteSubAssignmentById,
  getAllAssignedAssignments,
  getAllAssignments,
  getAssignedAssignments,
  getAssignmentById,
  getAssignmentBySessionId,
  getAssignmentsByClassroom,
  getAssignmentWithQuestions,
  getFullClassroomData,
  getStudentAssignmentsByClassroom,
  getSubAssignmentById,
  listLessonsForSession,
  updateAssignmentByAdmin,
  updateAssignmentQuestionPreStart,
} from "../controllers/assignmentController.js";
import {
  getAssignmentAiHint,
  getAssignmentAiReport,
  getAssignmentAiReportByParent,
} from "../controllers/assignmentAiController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

const allowTeacherOrAdmin = (req, res, next) => {
  const role = req.user?.userRole;

  if (role === "teacher" || role === "admin") return next();
  return res
    .status(403)
    .json({ message: "Access denied. Teacher or Admin only." });
};
router.post("/create", auth_key_header, auth_token, createAssignment);
router.post("/new", auth_key_header, auth_token, createnewAssignment);
// AI-generated assignment from a previous session (Create Assignment panel).
router.post("/with-ai", auth_key_header, auth_token, createAssignmentWithAI);
// Lesson picker for the Create Assignment panel — one session can have
// multiple lessons (reruns), and the teacher chooses which lessons feed the AI.
router.get(
  "/lessons-by-session/:sessionId",
  auth_key_header,
  auth_token,
  listLessonsForSession,
);
// GET /api/assignments/assigned
router.get("/assigned", getAllAssignedAssignments);
router.get("/get-All", getAllAssignments);

// AI hints on a student's assignment attempt. Mirrors the classwork
// aiHintPrompt path — same Gemini util, same schema — but reads the ideal
// answer from Question.correctAnswer and gates per-student inactivation
// on maxAiHints + AI-marked correctness.
router.post("/ai-hint", auth_key_header, auth_token, getAssignmentAiHint);
router.get(
  "/ai-report/:subAssignmentId/:studentId",
  auth_key_header,
  auth_token,
  getAssignmentAiReport
);
router.get(
  "/ai-report-by-parent/:assignmentId/:studentId",
  auth_key_header,
  auth_token,
  getAssignmentAiReportByParent
);

//update the assignment

router.patch(
  "/update/:taskId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateAssignmentByAdmin
);

// Teacher pre-start edit of a single AI-generated question (text /
// correctAnswer / solution). 409s if the assignment has already started.
router.patch(
  "/:assignmentId/task/:taskId/question/:questionId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateAssignmentQuestionPreStart
);

router.put(
  "/:id/students/:taskId",
  auth_key_header,
  auth_token,
  assignStudentsToAssignment
);
router.get("/classroom/:classroomId", getAssignmentsByClassroom);
router.get("/:id/data", auth_key_header, auth_token, getFullClassroomData);

// GET /api/assignments/:assignmentId
router.get("/:assignmentId", getAssignmentById);
router.get("/sub/:subAssignmentId", getSubAssignmentById);

router.get("/:id", auth_key_header, auth_token, getAssignmentWithQuestions);
router.get(
  "/session/:sessionId",
  auth_key_header,
  auth_token,
  getAssignmentBySessionId
);

// GET /api/assignments/student/:studentId
router.get("/student/:studentId", getAssignedAssignments);

router.get(
  "/:studentId/classroom/:classroomId",
  getStudentAssignmentsByClassroom
);

router.delete("/sub-assignment/:subAssignmentId", deleteSubAssignmentById);
router.delete("/assignment/:assignmentId", deleteAssignmentById);

export default router;
