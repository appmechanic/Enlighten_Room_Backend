import { Router } from "express";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import { excelUploadMiddleware } from "../controllers/adminDashboardController.js";
import {
  requireSchoolAdmin,
  listSchoolTeachers,
  createSchoolTeacher,
  bulkCreateSchoolTeachers,
} from "../controllers/schoolAdminTeacherController.js";

const router = Router();

router.get(
  "/teachers",
  auth_key_header,
  auth_token,
  requireSchoolAdmin,
  listSchoolTeachers
);

router.post(
  "/teachers",
  auth_key_header,
  auth_token,
  requireSchoolAdmin,
  createSchoolTeacher
);

router.post(
  "/teachers/bulk-upload",
  auth_key_header,
  auth_token,
  requireSchoolAdmin,
  excelUploadMiddleware,
  bulkCreateSchoolTeachers
);

export default router;
