import express from "express";
import {
  createTestWithAI,
  getTestsByClassroom,
  getStudentTest,
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

// Manual/cron trigger for the post-expiry class report. Idempotent.
router.post(
  "/:testId/:taskId/generate-report",
  auth_key_header,
  auth_token,
  triggerTestClassReport,
);

export default router;
