import express from "express";
import { clearAllClasswork, addQuestion, submitAnswer, viewAnswers, viewAllAnswers, getQuestions, sendClassworkReportToStudentsAndParents, downloadAllAnswersCsvReport, saveAiHintUsage } from "../controllers/classworkController.js";
import { uploadClasswork } from "../utils/multer.js";

// Download all answers as a detailed CSV report
// Download per-student classwork report as CSV
const router = express.Router();

router.get("/", clearAllClasswork)
router.post("/submit", submitAnswer);
router.post("/ai-hint", saveAiHintUsage);
router.get("/questions/:roomId", getQuestions);
router.get("/answers-overview/:roomId", viewAllAnswers);
// Download all answers as a report (JSON)
router.get("/download-csv-report/:roomId", downloadAllAnswersCsvReport);
router.post("/send-report", sendClassworkReportToStudentsAndParents);
router.get("/answers/:questionId", viewAnswers);
router.post("/question", 
    uploadClasswork, 
    addQuestion
);

export default router;
