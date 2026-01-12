import express from "express";
import {
  addClassSession,
  deleteSession,
  getAllClassSessions,
  getAllSessions,
  getSessionById,
  searchSessions,
  updateSession,
  validateSessionForUser,
  reportOffScreen,
} from "../controllers/classroomController.js";
import { addCustomIdMapping } from "../controllers/customIdMapController.js";
import auth_token from "../middleware/auth_token.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = express.Router();
const allowTeacherOrAdmin = (req, res, next) => {
  const role = req.user?.userRole;

  if (role === "teacher" || role === "admin") return next();
  return res
    .status(403)
    .json({ message: "Access denied. Teacher or Admin only." });
};

// Add a mapping for custom sessionId or userId
router.post("/custom-id-map", addCustomIdMapping);

// ✅ Report off-screen activity - logs when student goes off-screen
router.post(
  "/reportoffscreen/:sessionId/:userId",
  auth_key_header,
  auth_token,
  reportOffScreen
);

// ✅ Validate session for user - returns user and session details
router.get(
  "/validate/:sessionId/:userId",
  auth_key_header,
  validateSessionForUser
);

router.get(
  "/all-sessions",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getAllSessions
);
router.get(
  "/search",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  searchSessions
);
// Add a new session to a classroom
router.post(
  "/:id",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  addClassSession
);

// Get all sessions for a specific classroom
router.get(
  "/:id",
  auth_key_header,
  auth_token,
  // allowTeacherOrAdmin,
  getAllClassSessions
);

// Get a specific session by ID
router.get(
  "/get/:sessionId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  getSessionById
);

// Get all sessions from all classrooms
// Update a session by ID
router.put(
  "/:sessionId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  updateSession
);

// Delete a session by ID
router.delete(
  "/:sessionId",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  deleteSession
);

export default router;
