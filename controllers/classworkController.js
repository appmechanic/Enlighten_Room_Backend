import ClassworkModel from '../models/ClassworkModel.js';

// Add a question (teacher side)
export const addQuestion = async (req, res) => {
  try {
    const { question, correctAnswer, roomId } = req.body;
    const newQuestion = await ClassworkModel.create({ ...question, correctAnswer, roomId });
    res.status(201).json(newQuestion);
  } catch (err) {
    res.status(500).json({ message: 'Error adding question', error: err.message });
  }
};

// Submit answer (student side)
export const submitAnswer = async (req, res) => {
  try {
    const { questionId, studentId, studentName, answer, roomId } = req.body;
    const question = await ClassworkModel.findOne({ id: questionId });
    if (!question) return res.status(404).json({ message: 'Question not found' });
    if (!question.roomId && roomId) question.roomId = roomId;

    // Check if question has expired
    if (question.expiryTime && question.createdAt) {
      const elapsed = (Date.now() - new Date(question.createdAt).getTime()) / 1000;
      if (elapsed > question.expiryTime) {
        return res.status(403).json({ message: 'Time expired. You can no longer submit an answer for this question.' });
      }
    }

    let isCorrect = false;
    // Compare answer to correctAnswer
    if (question.correctAnswer !== undefined) {
      if (typeof answer === 'string' && typeof question.correctAnswer === 'string') {
        isCorrect = answer.trim().toLowerCase() === question.correctAnswer.trim().toLowerCase();
      } else if (Array.isArray(answer) && Array.isArray(question.correctAnswer)) {
        isCorrect = JSON.stringify(answer.map(a => a.trim().toLowerCase())) === JSON.stringify(question.correctAnswer.map(a => a.trim().toLowerCase()));
      } else {
        isCorrect = answer === question.correctAnswer;
      }
    }
    question.submitted.push({ studentId, studentName, answer, isCorrect });
    await question.save();
    res.status(200).json({ message: 'Answer submitted', isCorrect ,"correctAnswer": question.correctAnswer});
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
