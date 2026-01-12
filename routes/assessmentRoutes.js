import express from "express";
import multer from "multer";
import {
  getAssignedTasksForStudent,
  getGradedSubmission,
  getSubmittedAssignmentsByStudent,
  gradeAssignment,
  handleAssessmentUpload,
} from "../controllers/assessmentController.js";
import upload from "../utils/multer.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();
// const upload = multer({ dest: "uploads/" });

// router.post("/upload", upload.single("file"), handleAssessmentUpload);
router.post("/ai-result", auth_key_header, auth_token, gradeAssignment);

// Submitted assignments of a student
router.get(
  "/student/:studentId",
  auth_key_header,
  auth_token,
  getSubmittedAssignmentsByStudent
);

// Assigned (pending or not) tasks to student
router.get(
  "/assigned",
  auth_key_header,
  auth_token,
  getAssignedTasksForStudent
);
// 🔹 GET by assignment + task + student
router.get(
  "/:assignmentId/:assignmentTaskId/:studentId",
  auth_key_header,
  auth_token,
  getGradedSubmission
);

// 🔹 GET all graded for a task
router.get(
  "/:assignmentId/:assignmentTaskId",
  auth_key_header,
  auth_token,
  getGradedSubmission
);

export default router;
