import express from "express";
import {
  viewLessonReportByToken,
  viewSummaryByToken,
} from "../controllers/tokenizedReportController.js";

// PUBLIC router for tokenized report access (Task 2 lesson reports + Task 3
// student summary reports). Deliberately NO auth middleware — these endpoints
// are for recipients who received an emailed link, not logged-in users.
// Security is the token itself (256 bits of entropy + 90-day TTL +
// per-recipient issuance). The handlers kind-guard the token so a Task 2
// token cannot resolve a Task 3 route or vice versa.
//
// Mounted at /api/report-link in app.js. Separate from /api/reports (legacy,
// auth-required) and /api/classwork (auth-required) to make the "no auth
// here" contract unmissable when reviewing routes.

const router = express.Router();

// Task 2 — single-lesson tokenized report (one student's lesson attempts).
// 404 if not found, 410 if expired.
router.get("/view/:token", viewLessonReportByToken);

// Task 3 — single-student date-range summary.
// 404 if not found, 410 if expired or empty-for-this-student.
router.get("/view-summary/:token", viewSummaryByToken);

export default router;
