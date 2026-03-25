import express from 'express';
import { clearAllClasswork, addQuestion, submitAnswer, viewAnswers, viewAllAnswers, getQuestions } from '../controllers/classworkController.js';
const router = express.Router();

router.get('/', clearAllClasswork)
router.post('/question', addQuestion);
router.post('/submit', submitAnswer);
router.get('/questions/:roomId', getQuestions);
router.get('/answers-overview/:roomId', viewAllAnswers);
router.get('/answers/:questionId', viewAnswers);

export default router;
