import express from "express";
import {
  createTeacher,
  getAllTeachers,
  getTeacherByUid,
  updateTeacher,
  deleteTeacher,
  getTeacherDashboard,
} from "../controllers/teacherController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import auth_admin from "../middleware/auth_admin.js";
import multer from "multer";
import upload from "../utils/multer.js";
import {
  deleteMyAIConfig,
  getMyAIConfig,
  upsertMyAIConfig,
} from "../controllers/teacherAIConfigController.js";

const router = express.Router();

const allowTeacherOrAdmin = (req, res, next) => {
  const role = req.user?.userRole;

  if (role === "teacher" || role === "admin") return next();
  return res
    .status(403)
    .json({ message: "Access denied. Teacher or Admin only." });
};

router.post(
  "/",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  createTeacher
);
//cofigure routes for teacher AI config
router.get(
  "/ai-config",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getMyAIConfig
); // READ
router.post(
  "/ai-config",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  upsertMyAIConfig
); // CREATE/UPDATE
router.delete(
  "/ai-config",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  deleteMyAIConfig
); // DELETE

router.get("/", auth_key_header, getAllTeachers);
router.get("/dashboard/:teacherId", getTeacherDashboard);

router.get("/:userId", auth_key_header, auth_token, getTeacherByUid);
router.put(
  "/:id",
  auth_key_header,
  auth_token,

  allowTeacherOrAdmin,
  upload.single("image"),
  updateTeacher
);
router.delete("/:id", auth_key_header, auth_admin, deleteTeacher);

export default router;
