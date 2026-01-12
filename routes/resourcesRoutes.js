import express from "express";
import {
  getStudentResources,
  getTeacherResources,
} from "../controllers/resourcesController.js";

const router = express.Router();
router.get("/student/:studentId", getStudentResources);
router.get("/teacher/:teacherId", getTeacherResources);
export default router;
