// routes/classroomRoutes.js
import express from "express";
import {
  createClassroom,
  getClassrooms,
  getClassroomById,
  updateClassroom,
  deleteClassroom,
  removeTeacher,
  addStudentsToClassroom,
  removeStudentsFromClassroom,
  updateClassroomSettings,
  updateClassSchedule,
  updateClassroomRemarks,
  addClassSession,
  assignStudentsToSession,
  getTeacherAddedClassrooms,
  getAllTeacherSessions,
  getClassroomStudents,
} from "../controllers/classroomController.js";
import auth_admin from "../middleware/auth_admin.js";
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

// @route   POST /api/classrooms
// @desc    Create a new classroom

router.post(
  "/",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  createClassroom
);

// @route   GET /api/classrooms
// @desc    Get all classrooms (admin only)

router.get("/", auth_key_header, auth_admin, getClassrooms);

// @route   GET /api/classrooms/sessions/teacher
// @desc    Get all sessions created by teacher
router.get(
  "/sessions/teacher",
  auth_token,
  allowTeacherOrAdmin,
  getAllTeacherSessions
);

// @route   GET /api/classrooms/:id/students
// @desc    Get all students in a classroom
router.get(
  "/:id/students",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getClassroomStudents
);

// @route   GET /api/classrooms/:id
// @desc    Get classroom by ID
router.get(
  "/:id",
  auth_key_header,
  auth_token,
  // allowTeacherOrAdmin,
  getClassroomById
);

// @route   GET /api/classrooms/teacher/:teacherId
// @desc    Get all classrooms created by a specific teacher
router.get(
  "/teacher/:teacherId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getTeacherAddedClassrooms
);

// @route   PUT /api/classrooms/:id
// @desc    Update classroom details

router.put(
  "/:id",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateClassroom
);

// @route   DELETE /api/classrooms/:id
// @desc    Delete a classroom (admin only)

router.delete("/:id", auth_key_header, auth_admin, deleteClassroom);

// @route   PUT /api/classrooms/:id/students/add
// @desc    Add students to classroom

router.put(
  "/:id/students/add",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  addStudentsToClassroom
);

// @route   PUT /api/classrooms/:id/students/remove
// @desc    Remove students from classroom

router.put(
  "/:id/students/remove",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  removeStudentsFromClassroom
);

// @route   DELETE /api/classrooms/:id/teacher
// @desc    Remove teacher from classroom

router.delete("/:id/teacher", auth_key_header, auth_token, removeTeacher);

// @route   PUT /api/classrooms/:id/settings
// @desc    Update classroom settings

router.put(
  "/:id/settings",
  auth_key_header,
  auth_token,
  updateClassroomSettings
);

// @route   PUT /api/classrooms/:id/schedule
// @desc    Update classroom schedule

router.put(
  "/:id/schedule",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateClassSchedule
);

// @route   PUT /api/classrooms/:id/remarks
// @desc    Update classroom remarks

router.put(
  "/:id/remarks",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateClassroomRemarks
);

// @route   POST /api/classrooms/:id/session
// @desc    Add a new session to a classroom

router.post(
  "/:id/session",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  addClassSession
);

// @route   PUT /api/classrooms/sessions/:id/students
// @desc    Assign students to a session

router.put(
  "/sessions/:id/students",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  assignStudentsToSession
);

export default router;
