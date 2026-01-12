import express from "express";
import {
  generateSessionReport,
  generateStudentReport,
  sendReportsToParents,
} from "../controllers/reportController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.post("/session", auth_key_header, auth_token, generateSessionReport);
router.post("/student", auth_key_header, auth_token, generateStudentReport);
router.post("/send-reports", auth_key_header, auth_token, sendReportsToParents);

export default router;
