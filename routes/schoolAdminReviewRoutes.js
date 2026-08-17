import { Router } from "express";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import {
  listReviewableUsers,
  approveSchoolAdmin,
  rejectSchoolAdmin,
} from "../controllers/schoolAdminReviewController.js";

const router = Router();

router.get("/", auth_admin, auth_key_header, listReviewableUsers);
router.post("/:id/approve", auth_admin, auth_key_header, approveSchoolAdmin);
router.post("/:id/reject", auth_admin, auth_key_header, rejectSchoolAdmin);

export default router;
