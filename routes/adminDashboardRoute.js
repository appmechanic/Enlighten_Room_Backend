// routes/adminDashboard.routes.js
import { Router } from "express";
import {
  bulkCreateTeachers,
  bulkCreateStudents,
  excelUploadMiddleware,
  getAdminDashboardMetrics,
} from "../controllers/adminDashboardController.js";
import {
  getStandardPrompts,
  getStandardPromptDefaultsHandler,
  upsertStandardPrompts,
} from "../controllers/standardPromptController.js";
import {
  getAiTokenUsage,
  getAiCallLogs,
} from "../controllers/aiTokenUsageController.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import { requireFeatureFlag } from "../middleware/requirePlan.js";

const router = Router();

// POST /api/admin/teachers/bulk-upload
// Accepts: multipart/form-data (file) OR JSON with { excelUrl }
router.post(
  "/teachers/bulk-upload",
  auth_admin,
  auth_key_header,
  requireFeatureFlag("excelImport"),
  excelUploadMiddleware,
  bulkCreateTeachers
);

// POST /api/admin/students/bulk-upload
// Same shape as the teacher bulk-upload. Excel columns:
//   firstName, lastName, email, date_of_birth (required)
//   phone, gender, age, city, country, language (optional)
//   parentEmail, teacherEmail (optional — resolved to references)
router.post(
  "/students/bulk-upload",
  auth_admin,
  auth_key_header,
  requireFeatureFlag("excelImport"),
  excelUploadMiddleware,
  bulkCreateStudents
);

// GET /api/admin/dashboard/metrics?start=2025-09-01&end=2025-09-26  (optional filters)
router.get("/dashboard", auth_admin, auth_key_header, getAdminDashboardMetrics);

// Standard AI prompts (admin only)
router.get(
  "/standard-prompts",
  auth_admin,
  auth_key_header,
  getStandardPrompts
);
// Read-only canonical defaults from config/standardPromptDefaults.js. Powers
// the "Reset to default" buttons in the admin UI — the React side no longer
// ships hardcoded copies of the canonical text.
router.get(
  "/standard-prompts/defaults",
  auth_admin,
  auth_key_header,
  getStandardPromptDefaultsHandler
);
router.put(
  "/standard-prompts",
  auth_admin,
  auth_key_header,
  upsertStandardPrompts
);

// Dev-stage token tracking. Returns per-(month, session) totals joined with
// teacher info for the AI Token Usage admin page.
router.get(
  "/ai-token-usage",
  auth_admin,
  auth_key_header,
  getAiTokenUsage
);

// Per-call audit log for the admin AI Call Logs page. Recent-first with
// tag/teacher/student/session filters.
router.get(
  "/ai-call-logs",
  auth_admin,
  auth_key_header,
  getAiCallLogs
);

export default router;
