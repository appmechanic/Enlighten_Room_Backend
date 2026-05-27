import express from "express";
import { clearAllClasswork, addQuestion, submitAnswer, viewAnswers, viewAllAnswers, getQuestions, sendClassworkReportToStudentsAndParents, downloadAllAnswersCsvReport } from "../controllers/classworkController.js";
import { uploadClasswork } from "../utils/multer.js";

// Download all answers as a detailed CSV report
// Download per-student classwork report as CSV
const router = express.Router();

router.get("/clear-all", clearAllClasswork);
router.post("/submit", submitAnswer);
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
