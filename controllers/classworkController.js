import ClassworkModel from '../models/ClassworkModel.js';
import { getGeminiScoreAndFeedback } from '../utils/geminiScoreFeedback.js';

export const clearAllClasswork = async (req, res) => {
  try {
    await ClassworkModel.deleteMany({});
    res.status(200).json({ message: 'All classwork cleared.' });
  } catch (err) {
    res.status(500).json({ message: 'Error clearing classwork', error: err.message });
  }
};
// Add a question (teacher side)
export const addQuestion = async (req, res) => {
  try {
    const { question, roomId } = req.body;
    const newQuestion = await ClassworkModel.create({ ...question, roomId });
    res.status(201).json(newQuestion);
  } catch (err) {
    console.error('Error in addQuestion:', err);
    res.status(500).json({ message: 'Error adding question', error: err.message });
  }
};

// Submit answer (student side)
export const submitAnswer = async (req, res) => {
  try {
    const { questionId, studentId, studentName, answer, roomId, aiUsed } = req.body;
    const question = await ClassworkModel.findOne({ id: questionId });
    if (!question) return res.status(404).json({ message: 'Question not found' });
    if (!question.roomId && roomId) question.roomId = roomId;

    // Check if question has expired
    if (question.expiryTime && question.createdAt) {
      const now = Date.now();
      const createdAtTime = new Date(question.createdAt).getTime();
      const elapsed = (now - createdAtTime) / 1000;
      console.log('[Expiry Debug]', {
        now: new Date(now).toISOString(),
        createdAt: question.createdAt,
        createdAtTime,
        expiryTime: question.expiryTime,
        elapsed,
        expiryExceeded: elapsed > question.expiryTime
      });
      if (elapsed > question.expiryTime) {
        return res.status(403).json({ message: 'Time expired. You can no longer submit an answer for this question.' });
      }
    }

    // Get AI-based score, feedback, and correctness
    let aiScore = 0;
    let feedback = '';
    let isCorrect = false;
    try {
      const aiResult = await getGeminiScoreAndFeedback(
        question.question,
        answer,
        question.correctAnswer
      );
      aiScore = aiResult.aiScore;
      feedback = aiResult.feedback;
      isCorrect = aiResult.isCorrect;
    } catch (aiErr) {
      console.error('AI scoring failed:', aiErr);
    }

    // Check if student already submitted an answer
    const existingSubmissionIndex = question.submitted.findIndex(
      (s) => s.studentId === studentId
    );
    if (existingSubmissionIndex !== -1) {
      // Update existing answer
      question.submitted[existingSubmissionIndex].answer = answer;
      question.submitted[existingSubmissionIndex].isCorrect = isCorrect;
      question.submitted[existingSubmissionIndex].aiUsed = aiUsed;
      question.submitted[existingSubmissionIndex].studentName = studentName;
      question.submitted[existingSubmissionIndex].aiScore = aiScore;
      question.submitted[existingSubmissionIndex].feedback = feedback;
    } else {
      // Add new answer
      question.submitted.push({ studentId, studentName, answer, isCorrect, aiUsed, aiScore, feedback });
    }
    await question.save();
    res.status(200).json({ message: 'Answer submitted', isCorrect, aiScore, feedback, correctAnswer: question.correctAnswer, data: question.submitted });
  } catch (err) {
    res.status(500).json({ message: 'Error submitting answer', error: err.message });
  }
};

// View answers for a single question (teacher side)
export const viewAnswers = async (req, res) => {
  try {
    const { questionId } = req.params;
    const question = await ClassworkModel.findOne({ id: questionId });
    if (!question) return res.status(404).json({ message: 'Question not found' });
    res.status(200).json({ submitted: question.submitted });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching answers', error: err.message });
  }
};

// View all answers overview for a room (teacher side)
export const viewAllAnswers = async (req, res) => {
  try {
    const { roomId } = req.params;
    const questions = await ClassworkModel.find({ roomId });

    const data = questions.map((q) => {
      const submitted = q.submitted.map((s) => {
        const name = s.studentName || s.studentId || 'Unknown';
        const initials = name
          .split(' ')
          .map((p) => p[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
        return {
          name,
          initials,
          answer: s.answer,
          isCorrect: s.isCorrect || false,
          aiScore: s.aiScore || 0,
          aiUsed: s.aiUsed || '0x',
          feedback: s.feedback || '',
        };
      });

      const submittedStudentNames = submitted.map((s) => s.name);

      return {
        id: q.id,
        _id: q._id,
        label: q.label,
        title: q.title,
        question: q.question,
        format: q.format || q.formatLabel || '',
        totalStudents: 0,
        correctAnswer: q.correctAnswer,
        submitted,
        waiting: [],
      };
    });

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching answers overview', error: err.message });
  }
};

// Get questions for a room (student side)
export const getQuestions = async (req, res) => {
  try {
    const { roomId } = req.params;
    const questions = await ClassworkModel.find({ roomId }).select('-submitted -correctAnswer');
    res.status(200).json(questions);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching questions', error: err.message });
  }
};
