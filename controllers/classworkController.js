import { Parser as Json2csvParser } from 'json2csv';
import ClassworkModel from '../models/ClassworkModel.js';
import { getGeminiScoreAndFeedback } from '../utils/geminiScoreFeedback.js';
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail", // or your SMTP provider
  auth: {
    user: process.env.NODEMAILER_EMAIL,
    pass: process.env.NODEMAILER_PASSCODE,
  },
});


// Placeholder for sending email with attachment (implement with your email service)
async function sendEmailWithAttachment({ to, subject, text, attachment, filename }) {
  // Add try-catch and support for attachments
  try {
    console.log(`[EMAIL] To: ${to}, Subject: ${subject}, Filename: ${filename}`);
    const mailOptions = {
      from: process.env.NODEMAILER_EMAIL,
      to: to,
      subject: `${subject}`,
      text: `${text}`,
      attachments: attachment && filename ? [
        {
          filename: filename,
          content: attachment,
        },
      ] : [],
    };
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send email to ${to}:`, err);
    throw err;
  }
}

export const downloadAllAnswersCsvReport = async (req, res) => {
  try {
    const { roomId } = req.params;
    const questions = await ClassworkModel.find({ roomId });
    // Flatten all answers for all questions
    const rows = [];
    questions.forEach((q, qIdx) => {
      q.submitted.forEach((s, sIdx) => {
        rows.push({
          'Question No.': qIdx + 1,
          'Question Text': q.question,
          'Format': q.format || q.formatLabel || '',
          'Student ID': s.studentId,
          'Student Name': s.studentName,
          'Answer': s.answer,
          'Is Correct': s.isCorrect ? 'Yes' : 'No',
          'AI Score': s.aiScore,
          'AI Used': s.aiUsed,
          'Feedback': s.feedback,
          'Correct Answer': q.correctAnswer ?? '',
        });
      });
    });
    const fields = [
      'Question No.', 'Question Text', 'Format',
      'Student ID', 'Student Name', 'Answer', 'Is Correct', 'AI Score', 'AI Used', 'Feedback', 'Correct Answer'
    ];
    const parser = new Json2csvParser({ fields });
    const csv = parser.parse(rows);
    res.setHeader('Content-Disposition', `attachment; filename=classwork_detailed_report_${roomId}.csv`);
    res.setHeader('Content-Type', 'text/csv');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).json({ message: 'Error downloading answers CSV report', error: err.message });
  }
};

// Send classwork report to a list of students and their parents (simulated)
export const sendClassworkReportToStudentsAndParents = async (req, res) => {
  try {
    const { roomId, emailIds, message } = req.body;
    // emailIds: array of { id, email }
    if (!Array.isArray(emailIds) || !roomId) {
      return res.status(400).json({ message: 'roomId and emailIds[] required' });
    }
    const questions = await ClassworkModel.find({ roomId });
    // Build the full CSV report once for all answers in the room
    const rows = [];
    questions.forEach((q, qIdx) => {
      q.submitted.forEach((s, sIdx) => {
        rows.push({
          'Question No.': qIdx + 1,
          'Question Text': q.question,
          'Format': q.format || q.formatLabel || '',
          'Student ID': s.studentId,
          'Student Name': s.studentName,
          'Answer': s.answer,
          'Is Correct': s.isCorrect ? 'Yes' : 'No',
          'AI Score': s.aiScore,
          'AI Used': s.aiUsed,
          'Feedback': s.feedback,
          'Correct Answer': q.correctAnswer ?? '',
        });
      });
    });
    const fields = [
      'Question No.', 'Question Text', 'Format',
      'Student ID', 'Student Name', 'Answer', 'Is Correct', 'AI Score', 'AI Used', 'Feedback', 'Correct Answer'
    ];
    const parser = new Json2csvParser({ fields });
    const csv = parser.parse(rows);
    const subject = `Classwork Report for Room ${roomId}`;
    const text = `Please find attached the detailed classwork report.\n \b Note \b ${message}`;
    const filename = `classwork_report_${roomId}.csv`;
    let success = 0;
    let failed = [];
    console.log(emailIds)
    for (const email of emailIds) {
      try {
        await sendEmailWithAttachment({ to: email, subject, text, attachment: csv, filename });
        success++;
      } catch (err) {
        failed.push(email);
      }
    }
    res.status(200).json({ message: 'Reports sent', success, failed });
  } catch (err) {
    res.status(500).json({ message: 'Error sending classwork reports', error: err.message });
  }
};


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
    // Validate expiryTime if present
    if (question && question.expiryTime !== undefined) {
      if (
        typeof question.expiryTime !== 'number' ||
        !Number.isFinite(question.expiryTime) ||
        question.expiryTime <= 0
      ) {
        console.warn('[AddQuestion] Invalid expiryTime:', question.expiryTime);
        return res.status(400).json({ message: 'Invalid expiryTime. It must be a positive number of seconds.' });
      }
    }
    const newQuestion = await ClassworkModel.create({ ...question, roomId });
    console.log('[AddQuestion] Question created:', {
      id: newQuestion.id,
      createdAt: newQuestion.createdAt,
      expiryTime: newQuestion.expiryTime,
      roomId: newQuestion.roomId,
      now: new Date().toISOString()
    });
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
    console.log('[SubmitAnswer] Attempt:', {
      questionId,
      studentId,
      now: new Date().toISOString(),
      questionCreatedAt: question ? question.createdAt : null
    });
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
