// Date-Range Summary Report routes (Task 3).
//
// All endpoints are teacher-authenticated. Quota enforcement happens INSIDE
// the controller (after cache lookup), not in middleware, so that cache hits
// don't consume monthly budget.

import express from "express";
import auth_token from "../middleware/auth_token.js";
import {
  listCandidates,
  createClassSummary,
  createStudentSummary,
  getSummaryById,
} from "../controllers/summaryReportController.js";

const router = express.Router();

router.use(auth_token);

// POST /api/summary/candidates — list classwork / assignment / test items
// in the date range with isSelectable + reason flags for the picker UI.
router.post("/candidates", listCandidates);

// POST /api/summary/class — generate (or cache-hit) a class-wide summary.
router.post("/class", createClassSummary);

// POST /api/summary/student — generate per-student summaries, optionally
// dispatch emails to students/parents via tokenized 90-day links.
router.post("/student", createStudentSummary);

// GET /api/summary/:id — teacher re-opens a prior summary (both kinds).
router.get("/:id", getSummaryById);

export default router;
