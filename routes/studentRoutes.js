import express from "express";
import {
  createStudent,
  getAllStudents,
  getStudentById,
  updateStudent,
  deleteStudent,
  updateStudentSettings,
  addStudentRemark,
  getStudentsByTeacherId,
  startAssignment,
  submitAssignment,
  autoSubmitAssignments,
  getStudentDashboard,
  getClassroomsByStudentId,
} from "../controllers/studentController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import auth_admin from "../middleware/auth_admin.js";
import checkRoles from "../middleware/check_roles.js";

const router = express.Router();
// Helper to allow only teacher or admin
const allowTeacherOrAdmin = (req, res, next) => {
  const role = req.user?.userRole;

  if (role === "teacher" || role === "admin") return next();
  return res
    .status(403)
    .json({ message: "Access denied. Teacher or Admin only." });
};

router.post("/start", auth_key_header, auth_token, startAssignment);
router.post("/submit", auth_key_header, auth_token, submitAssignment);
router.post("/auto-submit", auth_key_header, auth_token, autoSubmitAssignments);
router.post(
  "/",
  auth_key_header,
  // auth_token,
  // allowTeacherOrAdmin,
  createStudent
);
router.get(
  "/dashboard/:studentId",
  auth_key_header,
  auth_token,
  getStudentDashboard
);
router.get(
  "/",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getAllStudents
);

// @route   GET /api/classrooms/student/:studentId
// @desc    Get all classrooms a student is enrolled in
router.get(
  "/classroom/:studentId",
  auth_key_header,
  auth_token,
  getClassroomsByStudentId
);

router.get(
  "/:id",
  auth_key_header,
  auth_token,
  // allowTeacherOrAdmin,
  getStudentById
);
router.get(
  "/teacher/:teacherId",
  auth_key_header,
  auth_token,
  getStudentsByTeacherId
);

router.put("/:id", auth_key_header, auth_token, updateStudent);
router.delete(
  "/:id",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  deleteStudent
);
router.put(
  "/:id/settings",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateStudentSettings
);
router.put("/:id/remarks", auth_key_header, auth_token, addStudentRemark);

export default router;
