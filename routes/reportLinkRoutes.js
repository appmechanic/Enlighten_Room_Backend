import express from "express";
import { viewLessonReportByToken } from "../controllers/tokenizedReportController.js";

// Task 2: PUBLIC router for tokenized lesson-report access.
// Deliberately NO auth middleware — these endpoints are for recipients who
// received an emailed link, not logged-in users. Security is the token itself
// (256 bits of entropy + 90-day TTL + per-recipient issuance).
//
// Mounted at /api/report-link in app.js. Separate from /api/reports (legacy,
// auth-required) and /api/classwork (auth-required) to make the "no auth
// here" contract unmissable when reviewing routes.

const router = express.Router();

// View the lesson report for the given token. 404 if not found, 410 if expired.
router.get("/view/:token", viewLessonReportByToken);

export default router;
