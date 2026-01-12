import express from "express";
import { saveStudentMaterial } from "../controllers/studentDriveController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.post("/drive", auth_key_header, auth_token, saveStudentMaterial);

export default router;
