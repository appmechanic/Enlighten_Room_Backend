import express from "express";
import {
  createSubject,
  deleteSubject,
  getSubjects,
  updateSubject,
} from "../controllers/subjectController.js";

const router = express.Router();

router.post("/", createSubject);
router.get("/", getSubjects);
router.patch("/:id", updateSubject);
router.delete("/:id", deleteSubject);

export default router;
