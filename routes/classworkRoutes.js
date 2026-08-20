import express from "express";
import { clearAllClasswork, addQuestion, submitAnswer, submitAnswerStream, viewAnswers, viewAllAnswers, getQuestions, getStagedQuestions, releaseQuestion, sendClassworkReportToStudentsAndParents, downloadAllAnswersCsvReport, startLessonForRoom, renameLessonForRoom, endLessonForRoom, getActiveLessonForRoom, getClassReportForRoom, regenerateClassReportForRoom, updateStagedQuestion, getStudentLessonReport } from "../controllers/classworkController.js";
import { uploadClasswork } from "../utils/multer.js";

// Download all answers as a detailed CSV report
// Download per-student classwork report as CSV
const router = express.Router();

router.get("/clear-all", clearAllClasswork);
router.post("/start-lesson/:roomId", startLessonForRoom);
router.post("/end-lesson/:roomId", endLessonForRoom);
router.patch("/rename-lesson/:roomId", renameLessonForRoom);
router.get("/active-lesson/:roomId", getActiveLessonForRoom);
router.get("/class-report/:roomId", getClassReportForRoom);
router.post("/class-report/:roomId/regenerate", regenerateClassReportForRoom);
router.post("/submit", submitAnswer);
router.post("/submit/stream", submitAnswerStream);
router.get("/questions/:roomId", getQuestions);
router.get("/staged/:roomId", getStagedQuestions);
router.patch("/:questionId/release", releaseQuestion);
router.get("/answers-overview/:roomId", viewAllAnswers);
router.get("/student-report/:roomId/:studentId", getStudentLessonReport);
// Download all answers as a report (JSON)
router.get("/download-csv-report/:roomId", downloadAllAnswersCsvReport);
router.post("/send-report", sendClassworkReportToStudentsAndParents);
router.get("/answers/:questionId", viewAnswers);
router.post("/question",
    uploadClasswork,
    addQuestion
);
router.put("/question/:questionId", uploadClasswork, updateStagedQuestion);

export default router;
