import express from "express";
import {
  createQuestion,
  getAllQuestions,
  getQuestionById,
  updateQuestion,
  deleteQuestion,
  searchQuestions,
  updateQuestionStatus,
  getFilterAllQuestions,
  generateQuestionsFromAI,
  getQuestionsBySession,
} from "../controllers/questionController.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

//search route
router.get("/search", searchQuestions);

router.post("/", auth_key_header, auth_token, createQuestion);
router.get("/", auth_key_header, auth_token, getAllQuestions);
router.get(
  "/filter",
  auth_key_header,
  auth_token,
  auth_admin,
  getFilterAllQuestions
);

router.get("/:id", auth_key_header, auth_token, getQuestionById);
router.put("/:id", auth_key_header, auth_token, updateQuestion);
router.delete("/:id", auth_key_header, auth_token, deleteQuestion);
//Admin Routes
router.put(
  "/:questionId",
  auth_key_header,
  auth_token,
  auth_admin,
  updateQuestionStatus
);

router.post("/generate", generateQuestionsFromAI);
router.get("/session/:sessionId", getQuestionsBySession);

export default router;
