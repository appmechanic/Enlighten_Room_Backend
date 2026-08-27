import express from "express";
import {
  createTestWithAI,
  getTestsByClassroom,
  getStudentTest,
  getStudentTestsByClassroom,
  getStudentTestGradeDetails,
  submitTestQuestion,
  logFullscreenExit,
  triggerTestClassReport,
} from "../controllers/testController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

// AI-generated test from a date range of past sessions (Create Test panel).
router.post("/with-ai", auth_key_header, auth_token, createTestWithAI);

// Student endpoints — the video-app Test page hits these to fetch the
// (correct-answer-stripped) question set, submit one question at a time,
// and record fullscreen exits for integrity review.
router.get(
  "/student/:testId/:taskId",
  auth_key_header,
  auth_token,
  getStudentTest,
);
router.post(
  "/submit-question",
  auth_key_header,
  auth_token,
  submitTestQuestion,
);
router.post(
  "/fullscreen-exit",
  auth_key_header,
  auth_token,
  logFullscreenExit,
);

router.get(
  "/classroom/:classroomId",
  auth_key_header,
  auth_token,
  getTestsByClassroom,
);

// Mirrors GET /api/assignments/:studentId/classroom/:classroomId — used by
// the student dashboard to render each Test as a card with attached score,
// grade and submittedAt from GradedTestAnswerModel.
router.get(
  "/student/:studentId/classroom/:classroomId",
  auth_key_header,
  auth_token,
  getStudentTestsByClassroom,
);

// Per-task graded detail (score card + per-question breakdown) used by the
// student view-details page.
router.get(
  "/student-grade/:taskId",
  auth_key_header,
  auth_token,
  getStudentTestGradeDetails,
);

// Manual/cron trigger for the post-expiry class report. Idempotent.
router.post(
  "/:testId/:taskId/generate-report",
  auth_key_header,
  auth_token,
  triggerTestClassReport,
);

export default router;
