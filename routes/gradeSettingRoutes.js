import express from "express";
import {
  defineGradeSetting,
  getGradeSetting,
  deleteGradeSetting,
} from "../controllers/gradeSettingController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

const allowTeacherOrAdmin = (req, res, next) => {
  const role = req.user?.userRole;

  if (role === "teacher" || role === "admin") return next();
  return res
    .status(403)
    .json({ message: "Access denied. Teacher or Admin only." });
};

// Define or update grade settings
router.post(
  "/define",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  defineGradeSetting
);

// Get grade settings (by classroomId or assignmentId)
router.get(
  "/",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getGradeSetting
);

// Delete grade setting
router.delete(
  "/:id",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  deleteGradeSetting
);

export default router;
