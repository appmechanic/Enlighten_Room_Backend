// routes/adminDashboard.routes.js
import { Router } from "express";
import {
  bulkCreateTeachers,
  excelUploadMiddleware,
  getAdminDashboardMetrics,
} from "../controllers/adminDashboardController.js";
import {
  getStandardPrompts,
  upsertStandardPrompts,
} from "../controllers/standardPromptController.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = Router();

// POST /api/admin/teachers/bulk-upload
// Accepts: multipart/form-data (file) OR JSON with { excelUrl }
router.post(
  "/teachers/bulk-upload",
  auth_admin,
  auth_key_header,
  excelUploadMiddleware,
  bulkCreateTeachers
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
router.put(
  "/standard-prompts",
  auth_admin,
  auth_key_header,
  upsertStandardPrompts
);

export default router;
