import express from "express";
import {
  createTask,
  getTaskBySlug,
  getUserTasks,
} from "../controllers/taskController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.post("/", auth_key_header, auth_token, createTask);
router.get("/get-taslks", auth_key_header, auth_token, getUserTasks);
router.get("/share/:slug", auth_key_header, auth_token, getTaskBySlug);

export default router;
