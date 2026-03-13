import express from 'express';
import { addQuestion, submitAnswer, viewAnswers, viewAllAnswers, getQuestions } from '../controllers/classworkController.js';
const router = express.Router();

router.post('/question', addQuestion);
router.post('/submit', submitAnswer);
router.get('/questions/:roomId', getQuestions);
router.get('/answers-overview/:roomId', viewAllAnswers);
router.get('/answers/:questionId', viewAnswers);

export default router;
