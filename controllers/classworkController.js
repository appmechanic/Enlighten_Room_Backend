import { Parser as Json2csvParser } from 'json2csv';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GoogleGenerativeAI } from "@google/generative-ai";
import ClassworkModel from '../models/ClassworkModel.js';
import { getGeminiScoreAndFeedback } from '../utils/geminiScoreFeedback.js';
import { getExpiryState, getQuestionAiExpirySeconds, getQuestionExpirySeconds, isValidExpirySeconds } from '../utils/classworkExpiry.js';
import { s3 } from '../utils/s3.js';
import nodemailer from "nodemailer";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const bucketName = process.env.DO_SPACE_BUCKET;
const spaceEndpoint = process.env.DO_SPACE_ENDPOINT;

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

function getSpacesPublicUrl(key) {
  if (!bucketName || !spaceEndpoint) {
    throw new Error('DigitalOcean Spaces configuration is missing.');
  }

  const endpoint = new URL(spaceEndpoint);
  return `${endpoint.protocol}//${bucketName}.${endpoint.host}/${key}`;
}

function parseBase64Image(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return null;
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function getImageExtension(mimeType) {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

async function uploadAnswerImageToSpaces({ roomId, questionId, studentId, imageData }) {
  const parsedImage = parseBase64Image(imageData);

  if (!parsedImage) {
    return null;
  }

  const extension = getImageExtension(parsedImage.mimeType);
  const key = `photos/classwork-answers/${roomId}/${questionId}-${studentId}-${Date.now()}.${extension}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: parsedImage.buffer,
      ContentType: parsedImage.mimeType,
      ACL: 'public-read',
    })
  );

  return getSpacesPublicUrl(key);
}

async function normalizeSubmittedAnswer(answer, format, metadata = {}) {
  console.log('[normalizeSubmittedAnswer] Received answer payload:', {
    format,
    roomId: metadata.roomId,
    questionId: metadata.questionId,
    studentId: metadata.studentId,
    answerType: Array.isArray(answer) ? 'array' : typeof answer,
    hasImageData: Boolean(answer && typeof answer === 'object' && answer.imageData),
    hasImageUrl: Boolean(answer && typeof answer === 'object' && answer.imageUrl),
    hasText: Boolean(
      typeof answer === 'string'
        ? answer.trim()
        : answer && typeof answer === 'object' && typeof answer.text === 'string' && answer.text.trim()
    ),
  });

  if (format !== 'handwriting') {
    console.log('[normalizeSubmittedAnswer] Non-handwriting answer kept as-is.');
    return answer;
  }

  if (typeof answer === 'string') {
    if (!/^data:image\//i.test(answer)) {
      console.log('[normalizeSubmittedAnswer] Handwriting answer received as plain text.');
      return answer;
    }

    const imageUrl = await uploadAnswerImageToSpaces({
      roomId: metadata.roomId,
      questionId: metadata.questionId,
      studentId: metadata.studentId,
      imageData: answer,
    });

    console.log('[normalizeSubmittedAnswer] Uploaded handwriting base64 image to Spaces.', {
      questionId: metadata.questionId,
      studentId: metadata.studentId,
      imageUrl,
    });

    return {
      type: 'image',
      imageUrl,
      text: 'Handwritten answer submitted as image.',
    };
  }

  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    console.log('[normalizeSubmittedAnswer] Unsupported handwriting payload returned unchanged.');
    return answer;
  }

  const rawImageData = typeof answer.imageData === 'string' ? answer.imageData : '';
  const uploadedImageUrl = rawImageData
    ? await uploadAnswerImageToSpaces({
        roomId: metadata.roomId,
        questionId: metadata.questionId,
        studentId: metadata.studentId,
        imageData: rawImageData,
      })
    : null;

  const normalizedAnswer = {
    ...answer,
    type: uploadedImageUrl || answer.imageUrl ? 'image' : answer.type || 'text',
    imageUrl: uploadedImageUrl || answer.imageUrl || '',
    text: answer.text || (uploadedImageUrl || answer.imageUrl ? 'Handwritten answer submitted as image.' : ''),
  };

  console.log('[normalizeSubmittedAnswer] Normalized handwriting payload.', {
    questionId: metadata.questionId,
    studentId: metadata.studentId,
    usedUploadedImage: Boolean(uploadedImageUrl),
    usedExistingImageUrl: Boolean(answer.imageUrl),
    retainedText: Boolean(normalizedAnswer.text),
    finalType: normalizedAnswer.type,
  });

  return normalizedAnswer;
}

function getSubmittedAnswerImage(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return null;
  }

  return answer.imageUrl || answer.imageData || null;
}

function formatSubmittedAnswerText(answer) {
  if (Array.isArray(answer)) {
    return answer.map((entry) => String(entry ?? '')).join(' | ');
  }

  if (typeof answer === 'string') {
    return /^data:image\//i.test(answer) ? '[Image answer submitted]' : answer;
  }

  if (answer && typeof answer === 'object') {
    if (typeof answer.text === 'string' && answer.text.trim()) {
      return answer.text;
    }

    if (answer.type === 'image') {
      return '[Image answer submitted]';
    }

    try {
      return JSON.stringify(answer);
    } catch (err) {
      return '[Unsupported answer format]';
    }
  }

  return answer == null ? '' : String(answer);
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
          'Answer': formatSubmittedAnswerText(s.answer),
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
          'Answer': formatSubmittedAnswerText(s.answer),
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
    const question  = JSON.parse(req.body.question);
    const roomId = req.body.roomId;
    const resolvedAiAllowed = question?.aiAllowed !== false;
    const resolvedAiExpiryTime = question?.aiExpiryTime ?? question?.expiryTime;
    console.log('[AddQuestion] Incoming payload:', {
      id: question?.id,
      roomId,
      expiryTime: question?.expiryTime,
      aiAllowed: resolvedAiAllowed,
      aiExpiryTime: resolvedAiExpiryTime,
      receivedAt: new Date().toISOString()
    });
    if (question && question.expiryTime !== undefined) {
      if (!isValidExpirySeconds(question.expiryTime)) {
        console.warn('[AddQuestion] Invalid expiryTime:', question.expiryTime);
        return res.status(400).json({ message: 'Invalid expiryTime. It must be a positive number of seconds.' });
      }
      console.log('[AddQuestion] Expiry provided by client:', {
        questionId: question.id,
        expiryTime: question.expiryTime,
        unit: 'seconds'
      });
    } else {
      console.log('[AddQuestion] No expiryTime provided. Schema default will be used.', {
        questionId: question?.id,
        schemaDefaultExpiryTime: 30,
        unit: 'seconds'
      });
    }
    if (resolvedAiAllowed && resolvedAiExpiryTime !== undefined && !isValidExpirySeconds(resolvedAiExpiryTime)) {
      console.warn('[AddQuestion] Invalid aiExpiryTime:', resolvedAiExpiryTime);
      return res.status(400).json({ message: 'Invalid aiExpiryTime. It must be a positive number of seconds.' });
    }

    if (resolvedAiAllowed && resolvedAiExpiryTime !== undefined) {
      console.log('[AddQuestion] AI expiry provided by client or inherited from question expiry.', {
        questionId: question?.id,
        aiExpiryTime: resolvedAiExpiryTime,
        unit: 'seconds'
      });
    } else if (!resolvedAiAllowed) {
      console.log('[AddQuestion] AI hints/check disabled for this question.', {
        questionId: question?.id,
      });
    } else {
      console.log('[AddQuestion] No aiExpiryTime provided. Schema default will be used.', {
        questionId: question?.id,
        schemaDefaultAiExpiryTime: 30,
        unit: 'seconds'
      });
    }

    const newQuestion = await ClassworkModel.create({
      ...question,
      roomId,
      aiAllowed: resolvedAiAllowed,
      aiExpiryTime: resolvedAiAllowed ? resolvedAiExpiryTime : question?.expiryTime,
    });
    if (req.file){
      newQuestion.image = req.file.location;
    }
    newQuestion.save()
    const createdAtTime = new Date(newQuestion.createdAt).getTime();
    const expiresAt = Number.isFinite(createdAtTime)
      ? new Date(createdAtTime + (newQuestion.expiryTime * 1000)).toISOString()
      : null;
    const aiExpiresAt = Number.isFinite(createdAtTime)
      ? new Date(createdAtTime + (newQuestion.aiExpiryTime * 1000)).toISOString()
      : null;
    console.log('[AddQuestion] Question created:', {
      id: newQuestion.id,
      createdAt: newQuestion.createdAt,
      expiryTime: newQuestion.expiryTime,
      aiAllowed: newQuestion.aiAllowed,
      aiExpiryTime: newQuestion.aiExpiryTime,
      expiresAt,
      aiExpiresAt,
      roomId: newQuestion.roomId,
      image: newQuestion.image,
      now: new Date().toISOString()
    });
    res.status(201).json({
      ...newQuestion.toObject(),
      image: newQuestion.image // This will be the S3/Spaces URL if uploaded
    });
  } catch (err) {
    console.error('Error in addQuestion:', err);
    res.status(500).json({ message: 'Error adding question', error: err.message });
  }
};

// Submit answer (student side)
export const submitAnswer = async (req, res) => {
  try {
    const { id , questionId, studentId, studentName, answer, roomId, aiUsed } = req.body;
    const lookup = roomId ? { _id: id,  id: questionId, roomId } : { id: questionId };
    const question = await ClassworkModel.findOne(lookup).sort({ createdAt: -1 });
    
    if (!question) {
      return res.status(404).json({
        message: roomId ? 'Question not found for this room' : 'Question not found'
      });
    }
    if (!question.roomId && roomId) question.roomId = roomId;

    // Check if question has expired
    const answerExpiryState = getExpiryState(question.createdAt, getQuestionExpirySeconds(question));
    if (answerExpiryState.isExpired) {
        return res.status(403).json({ message: 'Time expired. You can no longer submit an answer for this question.' });
    }

    if (question.format === 'textbox') {
      const textboxLimit = Number(question.maxLength) > 0 ? Number(question.maxLength) : 2000;
      const answerText = typeof answer === 'string' ? answer : '';
      if (answerText.length > textboxLimit) {
        return res.status(400).json({ message: `Answer exceeds ${textboxLimit} character limit.` });
      }
    }

    // Get AI-based score, feedback, and correctness
    let aiScore = 0;
    let feedback = '';
    let isCorrect = false;
    let aiExpired = false;
    const aiAllowed = question.aiAllowed !== false;
    const normalizedAnswer = await normalizeSubmittedAnswer(answer, question.format, {
      roomId: question.roomId || roomId,
      questionId: question.id || questionId,
      studentId,
    });
   
    try {
      const aiResult = await getGeminiScoreAndFeedback(
        question.question,
        normalizedAnswer,
        question.image,
        question.correctAnswer,
        question.format
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
      question.submitted[existingSubmissionIndex].answer = normalizedAnswer;
      question.submitted[existingSubmissionIndex].isCorrect = isCorrect;
      question.submitted[existingSubmissionIndex].aiUsed = aiUsed;
      question.submitted[existingSubmissionIndex].studentName = studentName;
      question.submitted[existingSubmissionIndex].aiScore = aiScore;
      question.submitted[existingSubmissionIndex].feedback = feedback;
    } else {
      // Add new answer
      question.submitted.push({ studentId, studentName, answer: normalizedAnswer, isCorrect, aiUsed, aiScore, feedback });
    }
    await question.save();
    res.status(200).json({
      message: 'Answer submitted',
      isCorrect,
      aiScore,
      aiAllowed,
      aiExpired,
      feedback,
      correctAnswer: question.correctAnswer,
      data: question.submitted
    });
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
    const { lessonName } = req.query;
    const filter = { roomId };
    if (lessonName !== undefined) filter.lessonName = lessonName;
    const questions = await ClassworkModel.find(filter);

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
          answer: formatSubmittedAnswerText(s.answer),
          answerImage: getSubmittedAnswerImage(s.answer),
          isCorrect: s.isCorrect || false,
          aiScore: s.aiScore || 0,
          aiUsed: s.aiUsed || '0x',
          feedback: s.feedback || '',
          preSubmitAnswers: s.preSubmitAnswers || [],
          
        };
      });

      const submittedStudentNames = submitted.map((s) => s.name);

      return {
        id: q.id,
        _id: q._id,
        label: q.label,
        title: q.title,
        question: q.question,
        lessonName: q.lessonName || '',
        format: q.format || q.formatLabel || '',
        aiAllowed: q.aiAllowed !== false,
        aiExpiryTime: q.aiExpiryTime,
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
    const { lessonName } = req.query;
    const filter = { roomId };
    if (lessonName !== undefined) filter.lessonName = lessonName;
    const questions = await ClassworkModel.find(filter).select('-submitted -correctAnswer');
    res.status(200).json(questions);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching questions', error: err.message });
  }
};

// Save AI Hint Usage (before final answer submission)
export const saveAiHintUsage = async (req, res) => {
  try {
    const { questionId, roomId, studentId, studentName, currentAnswer, image } = req.body;

    if (!questionId || !roomId || !studentId) {
      return res.status(400).json({ message: 'questionId, roomId, and studentId are required.' });
    }

    if (!currentAnswer && !image) {
      return res.status(400).json({ message: 'Either currentAnswer or image is required.' });
    }

    // Find the question
    const question = await ClassworkModel.findOne({ id: questionId, roomId }).sort({ createdAt: -1 });

    if (!question) {
      return res.status(404).json({ message: 'Question not found for this room.' });
    }

    // Check if AI is allowed
    if (question.aiAllowed === false) {
      return res.status(403).json({ message: 'AI hints are disabled for this question.' });
    }

    // Check if AI hint time has expired
    const aiExpiryState = getExpiryState(question.createdAt, getQuestionAiExpirySeconds(question));
    if (aiExpiryState.isExpired) {
      return res.status(403).json({ message: 'AI hint time expired for this question.' });
    }

    // Generate AI hint using Gemini
    const systemInstruction = `
      You are a warm, patient, and encouraging tutor (like a caring parent)
      who reads a student's classwork attempt and provides short, supportive,
      and educational guidance.

      Rules:
      - Start advice with the student's name if provided
      - Never give final answers unless the student has failed 3 times
      - Be concise, child-friendly, and encouraging
      - Provide hints to guide the student to the correct answer
    `;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction,
    });

    let inputArr = [];
    if (image) {
      const base64Image = image.includes(',') ? image.split(',')[1] : image;
      inputArr.push({
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg',
        },
      });
    }
    
    const questionText = `Question: ${question.question}`;
    const answerText = currentAnswer ? `Student's current answer: ${typeof currentAnswer === 'string' ? currentAnswer : JSON.stringify(currentAnswer)}` : '';
    const promptText = studentName 
      ? `${studentName}: ${questionText}. ${answerText}` 
      : `${questionText}. ${answerText}`;

    inputArr.push(promptText);

    const result = await model.generateContent(inputArr);
    const hint = (result.response && result.response.text && result.response.text()) || 'No hint available';

    // Find or create submission for this student
    const existingSubmissionIndex = question.submitted.findIndex(
      (s) => s.studentId === studentId
    );

    if (existingSubmissionIndex !== -1) {
      // Update existing submission
      const submission = question.submitted[existingSubmissionIndex];
      
      // Add current answer to preSubmitAnswers if it's different
      if (currentAnswer && JSON.stringify(submission.answer) !== JSON.stringify(currentAnswer)) {
        submission.preSubmitAnswers.push(currentAnswer);
      }
      
      // Add hint to aiHintsUsed
      submission.aiHintsUsed.push(hint);
    } else {
      // Create new submission with pre-submit data
      question.submitted.push({
        studentId,
        studentName: studentName || 'Unknown',
        answer: currentAnswer || '',
        isCorrect: false,
        aiScore: 0,
        aiUsed: '0x',
        feedback: '',
        preSubmitAnswers: currentAnswer ? [currentAnswer] : [],
        aiHintsUsed: [hint],
      });
    }

    await question.save();

    res.status(200).json({
      message: 'AI hint saved',
      hint,
      aiExpiryState,
    });
  } catch (err) {
    console.error('Error in saveAiHintUsage:', err);
    res.status(500).json({ message: 'Error generating AI hint', error: err.message });
  }
};
