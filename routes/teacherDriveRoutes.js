// routes/teacherDriveRoutes.js
import express from "express";
import { saveTeachingMaterial } from "../controllers/teacherDriveController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.post("/drive", auth_key_header, auth_token, saveTeachingMaterial);

export default router;
