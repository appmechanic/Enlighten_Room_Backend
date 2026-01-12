import express from "express";
import {
  assignStudentsToAssignment,
  createAssignment,
  createnewAssignment,
  deleteAssignmentById,
  deleteSubAssignmentById,
  getAllAssignedAssignments,
  getAllAssignments,
  getAssignedAssignments,
  getAssignmentById,
  getAssignmentBySessionId,
  getAssignmentsByClassroom,
  getAssignmentWithQuestions,
  getFullClassroomData,
  getStudentAssignmentsByClassroom,
  getSubAssignmentById,
  updateAssignmentByAdmin,
} from "../controllers/assignmentController.js";
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
router.post("/create", auth_key_header, auth_token, createAssignment);
router.post("/new", auth_key_header, auth_token, createnewAssignment);
// GET /api/assignments/assigned
router.get("/assigned", getAllAssignedAssignments);
router.get("/get-All", getAllAssignments);

//update the assignment

router.patch(
  "/update/:taskId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateAssignmentByAdmin
);

router.put(
  "/:id/students/:taskId",
  auth_key_header,
  auth_token,
  assignStudentsToAssignment
);
router.get("/classroom/:classroomId", getAssignmentsByClassroom);
router.get("/:id/data", auth_key_header, auth_token, getFullClassroomData);

// GET /api/assignments/:assignmentId
router.get("/:assignmentId", getAssignmentById);
router.get("/sub/:subAssignmentId", getSubAssignmentById);

router.get("/:id", auth_key_header, auth_token, getAssignmentWithQuestions);
router.get(
  "/session/:sessionId",
  auth_key_header,
  auth_token,
  getAssignmentBySessionId
);

// GET /api/assignments/student/:studentId
router.get("/student/:studentId", getAssignedAssignments);

router.get(
  "/:studentId/classroom/:classroomId",
  getStudentAssignmentsByClassroom
);

router.delete("/sub-assignment/:subAssignmentId", deleteSubAssignmentById);
router.delete("/assignment/:assignmentId", deleteAssignmentById);

export default router;
