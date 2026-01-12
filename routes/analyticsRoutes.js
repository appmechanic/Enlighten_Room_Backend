import express from "express";
import {
  getSystemAnalytics,
  getStudentAnalytics,
  getClassroomAnalytics,
} from "../controllers/analyticsController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.get("/system", auth_key_header, auth_token, getSystemAnalytics); // /analytics/system
router.get("/student", auth_key_header, auth_token, getStudentAnalytics); // /analytics/student
router.get("/classroom", auth_key_header, auth_token, getClassroomAnalytics); // /analytics/classroom

export default router;
