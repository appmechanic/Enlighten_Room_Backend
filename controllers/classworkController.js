import { Parser as Json2csvParser } from 'json2csv';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import ClassworkModel from '../models/ClassworkModel.js';
import ClassworkAiReport from '../models/ClassworkAiReportModel.js';
import Classroom from '../models/classroomModel.js';
import Session from '../models/SessionModel.js';
import Lesson from '../models/LessonModel.js';
import {
  getClassworkAiFeedback,
  getClassworkAiFeedbackStream,
} from '../utils/geminiClassworkFeedback.js';
import {
  fingerprintAnswer,
  buildCacheKey as buildFeedbackCacheKey,
  getCachedFeedback,
  setCachedFeedback,
} from '../utils/classworkFeedbackCache.js';
import { precomputeStandardSolution } from '../utils/geminiClassworkPrecompute.js';
import { generateClassReportSummary } from '../utils/geminiClassReportSummary.js';
import { getExpiryState, getQuestionAiExpirySeconds, getQuestionExpirySeconds, getQuestionTimerStart, isValidExpirySeconds } from '../utils/classworkExpiry.js';
import { s3 } from '../utils/s3.js';
import nodemailer from "nodemailer";

const bucketName = process.env.DO_SPACE_BUCKET;
const spaceEndpoint = process.env.DO_SPACE_ENDPOINT;

// Coerce whatever the AI (or a caller) provides into a string[] so downstream
// code can always spread it safely. Strings become one-element arrays; falsy
// values become []; arrays are copied and their entries stringified.
function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? ''));
  }
  if (value == null || value === '') return [];
  return [String(value)];
}

// Default shape returned when the AI is skipped (aiExpired) or fails. Matches
// the admin StandardPrompt schema: `{ correct, hintStream, part1[], part2[],
// part3[], advancedChallenge{ congratulations, question } }`.
function emptyAiFeedback() {
  return {
    correct: false,
    hintStream: '',
    part1: [],
    part2: [],
    part3: [],
    advancedChallenge: { congratulations: '', question: '' },
    standardSolution: '',
    commonMistake: { title: '', isCommon: false, answerLatex: '' },
  };
}

// Projects a stored ClassworkAiReport document into the wire shape consumed
// by the teacher/student report renderers. Walks `interactions` backwards
// once to surface the latest advanced-challenge question (the mastery-mode
// bonus prompt).
function projectAiReport(report, { includeStudentAnswer = false } = {}) {
  const interactions = Array.isArray(report?.interactions) ? report.interactions : [];

  let latestAdvancedQuestion = '';
  for (let i = interactions.length - 1; i >= 0; i -= 1) {
    const q = interactions[i]?.advancedChallenge?.question;
    if (q) { latestAdvancedQuestion = q; break; }
  }

  // Report renderers want the FULL last WRONG interaction that immediately
  // preceded the student's most recent correct answer — the wrong answer,
  // its live hint, part1/2/3, and any bonus challenge the AI attached.
  // Falls back to `null` when the student never got it right, or when their
  // very first attempt was correct (no wrong to precede).
  let lastWrongInteraction = null;
  const lastCorrectIdx = (() => {
    for (let i = interactions.length - 1; i >= 0; i -= 1) {
      if (interactions[i]?.correct) return i;
    }
    return -1;
  })();
  if (lastCorrectIdx > 0) {
    for (let i = lastCorrectIdx - 1; i >= 0; i -= 1) {
      const it = interactions[i];
      if (it && !it.correct) {
        lastWrongInteraction = {
          interactionId: it._id || null,
          previousInteractionId: it.previousInteractionId || null,
          questionText: it.questionText || '',
          ...(includeStudentAnswer ? { studentAnswer: it.studentAnswer } : {}),
          hintStream: it.hintStream || '',
          part1: toStringArray(it.part1),
          part2: toStringArray(it.part2),
          part3: toStringArray(it.part3),
          standardSolution: it.standardSolution || '',
          commonMistake: {
            title: it.commonMistake?.title || '',
            isCommon: Boolean(it.commonMistake?.isCommon),
            answerLatex: it.commonMistake?.answerLatex || '',
          },
          advancedChallenge: {
            congratulations: it.advancedChallenge?.congratulations || '',
            question: it.advancedChallenge?.question || '',
          },
          timestamp: it.timestamp || null,
        };
        break;
      }
    }
  }

  return {
    lastHintStream: report?.lastHintStream || '',
    originalQuestion: report?.originalQuestion || '',
    latestAdvancedQuestion,
    lastWrongInteraction,
    trainingHistory: (report?.trainingHistory || []).map((entry) => ({
      interactionId: entry.interactionId || null,
      part3: toStringArray(entry.part3),
      timestamp: entry.timestamp || null,
    })),
    interactions: interactions.map((it) => ({
      interactionId: it._id || null,
      previousInteractionId: it.previousInteractionId || null,
      questionText: it.questionText || '',
      ...(includeStudentAnswer ? { studentAnswer: it.studentAnswer } : {}),
      hintStream: it.hintStream || '',
      part1: toStringArray(it.part1),
      part2: toStringArray(it.part2),
      part3: toStringArray(it.part3),
      standardSolution: it.standardSolution || '',
      commonMistake: {
        title: it.commonMistake?.title || '',
        isCommon: Boolean(it.commonMistake?.isCommon),
        answerLatex: it.commonMistake?.answerLatex || '',
      },
      advancedChallenge: {
        congratulations: it.advancedChallenge?.congratulations || '',
        question: it.advancedChallenge?.question || '',
      },
      correct: Boolean(it.correct),
      timestamp: it.timestamp || null,
    })),
  };
}

// Pulled-down view of the AI feedback we ship to the student frontend in the
// `ai` field on /submit and on the SSE `done` event. Keeps part3 (diagnostic
// training) off the wire — it belongs only on the teacher report.
function projectAiForStudent(aiResult) {
  return {
    correct: Boolean(aiResult?.correct),
    hintStream: aiResult?.hintStream || '',
    part1: toStringArray(aiResult?.part1),
    part2: toStringArray(aiResult?.part2),
    advancedChallenge: {
      congratulations: aiResult?.advancedChallenge?.congratulations || '',
      question: aiResult?.advancedChallenge?.question || '',
    },
  };
}

function normalizeGradeLevel(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function resolveCommonMistakeThreshold({ classSize, gradeLevel }) {
  const size = Number(classSize) > 0 ? Number(classSize) : 0;
  if (size <= 7) return 0;
  if (size > 15) return 2;
  if (gradeLevel != null && gradeLevel >= 10) return 1;
  return 2;
}

function buildCachedContext(question) {
  const mistakes = Array.isArray(question?.commonMistakeBank)
    ? question.commonMistakeBank.map((m) => ({
        title: String(m?.title || '').trim(),
        studentAnswer: String(m?.studentAnswer || '').trim(),
        feedback: String(m?.feedback || '').trim(),
        answerLatex: String(m?.answerLatex || '').trim(),
      }))
        .filter((m) => m.title)
    : [];

  return {
    standardSolution: String(question?.standardSolution || '').trim(),
    commonMistakes: mistakes,
  };
}

function normalizeMistakeTitle(input) {
  return String(input || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

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

// Fires the S3 upload of the handwriting bytes without blocking. Returns a
// promise that resolves to the CDN URL (or "" on failure) — callers await it
// AFTER the Gemini call so the upload runs in parallel with generation.
// Previously the upload was awaited BEFORE the Gemini call, adding 0.5-2s to
// every handwriting submission for bytes we already had in memory.
function startAnswerImageUpload({ roomId, questionId, studentId, imageData }) {
  if (!imageData || !/^data:image\//i.test(String(imageData))) {
    return Promise.resolve('');
  }
  return uploadAnswerImageToSpaces({ roomId, questionId, studentId, imageData })
    .then((url) => {
      console.log('[normalizeSubmittedAnswer] Background upload finished.', {
        questionId,
        studentId,
        imageUrl: url || '(null)',
      });
      return url || '';
    })
    .catch((err) => {
      console.error('[normalizeSubmittedAnswer] Background upload failed:', err);
      return '';
    });
}

// Returns { answer, uploadPromise } — the answer is safe to hand to the AI
// path immediately; the uploadPromise must be awaited before persisting so the
// Mongo doc gets the CDN URL for later teacher-side rendering. For any format
// other than handwriting there's nothing to upload and uploadPromise resolves
// synchronously to "".
function normalizeSubmittedAnswer(answer, format, metadata = {}) {
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
    return { answer, uploadPromise: Promise.resolve('') };
  }

  if (typeof answer === 'string') {
    if (!/^data:image\//i.test(answer)) {
      console.log('[normalizeSubmittedAnswer] Handwriting answer received as plain text.');
      return { answer, uploadPromise: Promise.resolve('') };
    }

    // Kick off the upload but do NOT await. Hand the base64 straight to the
    // AI path via imageData so Gemini reads it inline without a CDN round trip.
    const uploadPromise = startAnswerImageUpload({
      roomId: metadata.roomId,
      questionId: metadata.questionId,
      studentId: metadata.studentId,
      imageData: answer,
    });

    return {
      answer: {
        type: 'image',
        imageData: answer,
        imageUrl: '',
        text: 'Handwritten answer submitted as image.',
      },
      uploadPromise,
    };
  }

  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    console.log('[normalizeSubmittedAnswer] Unsupported handwriting payload returned unchanged.');
    return { answer, uploadPromise: Promise.resolve('') };
  }

  const rawImageData = typeof answer.imageData === 'string' ? answer.imageData : '';
  const uploadPromise = rawImageData
    ? startAnswerImageUpload({
        roomId: metadata.roomId,
        questionId: metadata.questionId,
        studentId: metadata.studentId,
        imageData: rawImageData,
      })
    : Promise.resolve('');

  const normalizedAnswer = {
    ...answer,
    type: rawImageData || answer.imageUrl ? 'image' : answer.type || 'text',
    imageUrl: answer.imageUrl || '',
    imageData: rawImageData,
    text: answer.text || (rawImageData || answer.imageUrl ? 'Handwritten answer submitted as image.' : ''),
  };

  console.log('[normalizeSubmittedAnswer] Normalized handwriting payload (upload backgrounded).', {
    questionId: metadata.questionId,
    studentId: metadata.studentId,
    hasRawImageData: Boolean(rawImageData),
    usedExistingImageUrl: Boolean(answer.imageUrl),
    finalType: normalizedAnswer.type,
  });

  return { answer: normalizedAnswer, uploadPromise };
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
          'Correct Answer': Array.isArray(q.correctAnswer)
            ? q.correctAnswer.filter((s) => String(s ?? '').trim()).join(' | ')
            : q.correctAnswer ?? '',
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
          'Correct Answer': Array.isArray(q.correctAnswer)
            ? q.correctAnswer.filter((s) => String(s ?? '').trim()).join(' | ')
            : q.correctAnswer ?? '',
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


// Resolve the Session + Classroom for a given roomId (derived from sessionUrl).
// Returns { sessionId, classroomId } or nulls when no Session matches the room.
async function resolveSessionContext(roomId) {
  if (!roomId) return { sessionId: null, classroomId: null };
  try {
    const escaped = roomId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const session = await Session.findOne({
      sessionUrl: { $regex: escaped, $options: 'i' },
    })
      .select('_id classroomId')
      .lean();
    return {
      sessionId: session?._id || null,
      classroomId: session?.classroomId || null,
    };
  } catch (err) {
    console.warn('[Lesson] resolveSessionContext failed:', err.message);
    return { sessionId: null, classroomId: null };
  }
}

// Resolve the teacherId for a room by scanning Session.sessionUrl for the
// room slug and following the classroom pointer. Used by the precompute
// hook in addQuestion (which needs teacher context to load the teacher's
// prompt) — separate from the submit-path resolver so it can run without
// waiting for a Lesson row to exist for staged questions.
async function resolveTeacherIdForRoom(roomId) {
  if (!roomId) return null;
  try {
    const escapedRoomId = String(roomId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const session = await Session.findOne({
      sessionUrl: { $regex: escapedRoomId, $options: "i" },
    })
      .select("classroomId")
      .lean();
    if (!session?.classroomId) return null;
    const classroom = await Classroom.findById(session.classroomId)
      .select("teacherId")
      .lean();
    return classroom?.teacherId || null;
  } catch (err) {
    console.warn("[Classwork] resolveTeacherIdForRoom failed:", err?.message || err);
    return null;
  }
}

// Fires a synthetic feedback call after a question is released so Gemini's
// implicit prefix cache is warm before the first real student submission
// arrives. The systemInstruction (standard prompt + teacher prompt + cached
// solution block) is identical across every submission for a question, so
// one warm-up primes the cache for every student that follows.
//
// Silent no-op on any error. Deliberately runs off the release HTTP
// response via setImmediate so it never delays the teacher's release
// action, and skips itself when the standardSolution precompute hasn't
// finished (in that case the systemInstruction prefix isn't stable yet).
const FEEDBACK_WARMUP_ENABLED =
  String(process.env.CLASSWORK_FEEDBACK_WARMUP_DISABLED || '').toLowerCase() !== 'true';

function scheduleFeedbackWarmup(question) {
  if (!FEEDBACK_WARMUP_ENABLED) return;
  if (!question || !question.roomId || !question.id) return;
  if (question.aiAllowed === false) return;
  // Without a cached solution the systemInstruction prefix is unstable, so
  // warming would prime a prefix the real submissions won't reuse.
  if (!question.standardSolution) return;

  setImmediate(async () => {
    try {
      const [sessionIdForUsage, resolvedTeacherId] = await Promise.all([
        resolveSessionIdForRoom(question.roomId, question.lessonName || null),
        resolveTeacherIdForRoom(question.roomId),
      ]);
      const cachedContext = buildCachedContext(question);
      // Use the teacher's reference answer as the synthetic student answer
      // — Gemini returns a quick "correct + congratulations" response with
      // the same systemInstruction prefix a real submission will hit.
      const referenceAnswer = Array.isArray(question.correctAnswer)
        ? question.correctAnswer.find((v) => String(v ?? '').trim()) || 'warm-up'
        : (typeof question.correctAnswer === 'string' && question.correctAnswer.trim())
          ? question.correctAnswer
          : 'warm-up';
      await getClassworkAiFeedback({
        questionText: question.question || '',
        answer: referenceAnswer,
        correctAnswer: question.correctAnswer,
        // Warm-up primes the systemInstruction prefix cache — attach the
        // question image so the primed prefix matches what real submissions
        // will send. (Small extra tokens; buys a per-student latency win.)
        questionImage: question.image || null,
        format: question.format,
        studentName: 'warm-up',
        studentId: null,
        classroomId: question.classroomId || null,
        teacherId: resolvedTeacherId,
        maxOutputTokens: question.maxOutputTokens,
        sessionId: sessionIdForUsage,
        interactionId: String(new mongoose.Types.ObjectId()),
        previousInteractionId: '',
        // 0 skips the ASK/TELL instruction so the warm-up doesn't bias the
        // prefix toward one parity — both real-student parities can reuse it.
        submissionNumber: 0,
        cachedContext,
        computeStandardSolution: false,
        computeCommonMistake: false,
      });
      console.log('[Classwork] Feedback warm-up completed', {
        questionId: question.id,
        roomId: question.roomId,
      });
    } catch (err) {
      console.warn(
        '[Classwork] Feedback warm-up failed (non-fatal):',
        err?.message || err,
      );
    }
  });
}

// Fires the standard-solution precompute in the background so the
// question-create HTTP response returns immediately. Persists the result on
// the ClassworkModel doc when it succeeds; silent no-op on failure so
// per-submission feedback stays on its slower fallback path.
function schedulePrecomputes(newQuestion, { correctAnswer }) {
  setImmediate(async () => {
    try {
      const [sessionId, teacherId] = await Promise.all([
        resolveSessionIdForRoom(newQuestion.roomId, newQuestion.lessonName || null),
        resolveTeacherIdForRoom(newQuestion.roomId),
      ]);

      if (!newQuestion.standardSolution) {
        const { solution, finalAnswer, opener } = await precomputeStandardSolution({
          questionText: newQuestion.question,
          imageSource: newQuestion.image,
          correctAnswer,
          format: newQuestion.format,
          teacherId,
          sessionId,
          maxOutputTokens: newQuestion.maxOutputTokens,
        });
        // solution may be empty (e.g. Gemini returned only opener + finalAnswer
        // on a tricky question) — still persist whatever we got so the
        // instant-opener path lights up even without a solution to cache.
        const update = {};
        if (solution) {
          update.standardSolution = solution;
          update.solutionCapturedAt = new Date();
        }
        if (finalAnswer) update.derivedCorrectAnswer = finalAnswer;
        if (opener) update.aiOpener = opener;
        if (Object.keys(update).length > 0) {
          await ClassworkModel.updateOne(
            { _id: newQuestion._id },
            { $set: update },
          );
        }
      }
    } catch (err) {
      console.error(
        "[Classwork] schedulePrecomputes failed:",
        err?.message || err,
      );
    }
  });
}

// Cheap sessionId lookup used only for AI-usage bucketing on the classwork
// submit path. Prefers the Lesson row (indexed on roomId) because the same
// room may back multiple sessions historically. Falls back to the sessionUrl
// scan (resolveSessionContext) when no Lesson exists yet — that covers
// legacy submits that predate the Lesson model.
async function resolveSessionIdForRoom(roomId, lessonName) {
  if (!roomId) return null;
  try {
    const query = { roomId };
    if (lessonName) query.name = lessonName;
    const lesson = await Lesson.findOne(query)
      .sort({ startedAt: -1 })
      .select('sessionId')
      .lean();
    if (lesson?.sessionId) return lesson.sessionId;
  } catch (err) {
    console.warn('[AiUsage] resolveSessionIdForRoom lesson lookup failed:', err.message);
  }
  const ctx = await resolveSessionContext(roomId);
  return ctx.sessionId;
}

// Start a lesson for a room: adopt any pre-staged classwork (lessonName === "")
// into the new lesson, and remove classwork belonging to any prior lesson so
// the new lesson starts clean while preserving pre-created questions. Also
// persists a Lesson document so we can track the active lesson per room and
// keep a history for reporting.
export const startLessonForRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { lessonName, previousLessonName, sessionId, classroomId } =
      req.body || {};
    if (!roomId || !lessonName) {
      return res.status(400).json({ message: 'roomId and lessonName are required.' });
    }
    const newName = String(lessonName);

    // Defensive: any lesson still marked active for this room from a prior
    // run gets closed before we open the new one. Keeps the "only one active
    // lesson per room" invariant intact even if a previous end call was lost.
    await Lesson.updateMany(
      { roomId, status: 'active' },
      { $set: { status: 'ended', endedAt: new Date() } }
    );

    // Resolve Session/Classroom from the room when the caller didn't pass them
    // — keeps the API friendly to the existing client which only knows roomId.
    let resolvedSessionId = sessionId || null;
    let resolvedClassroomId = classroomId || null;
    if (!resolvedSessionId || !resolvedClassroomId) {
      const ctx = await resolveSessionContext(roomId);
      resolvedSessionId = resolvedSessionId || ctx.sessionId;
      resolvedClassroomId = resolvedClassroomId || ctx.classroomId;
    }

    const lesson = await Lesson.create({
      name: newName,
      roomId,
      sessionId: resolvedSessionId,
      classroomId: resolvedClassroomId,
      startedAt: new Date(),
      status: 'active',
    });

    // Delete classwork tied to any other lesson in this room. Empty
    // lessonName === "" means "pre-staged, not yet assigned" and is preserved.
    const removed = await ClassworkModel.deleteMany({
      roomId,
      lessonName: { $nin: ['', newName] },
    });
    // Adopt staged questions into the new lesson.
    const adopted = await ClassworkModel.updateMany(
      { roomId, lessonName: '' },
      { $set: { lessonName: newName } }
    );
    return res.status(200).json({
      message: 'Lesson started.',
      lesson,
      lessonName: newName,
      removedPrior: removed?.deletedCount ?? 0,
      adoptedStaged: adopted?.modifiedCount ?? 0,
      previousLessonName: previousLessonName || '',
    });
  } catch (err) {
    console.error('startLessonForRoom error:', err);
    res.status(500).json({ message: 'Error starting lesson', error: err.message });
  }
};

// ─── Rolling class-report checkpoints ─────────────────────────────────────
// Every time a student submits an answer, we opportunistically pre-generate
// the class report in the background so end-lesson can reuse a fresh copy
// instead of paying a cold Gemini call. Thresholds keep the checkpoint
// cadence sane: at least MIN_NEW_SUBMISSIONS since the last one AND at
// least MIN_INTERVAL_MS elapsed, and at most one checkpoint per lesson
// in flight at a time (deduped via the map below).
const REPORT_CHECKPOINT_MIN_NEW_SUBMISSIONS = 15;
const REPORT_CHECKPOINT_MIN_INTERVAL_MS = 5 * 60 * 1000;
// At end-lesson, if the last checkpoint is at most this old AND the current
// submission count matches, skip regeneration entirely — the teacher sees
// the pre-generated report immediately in the response.
const REPORT_CHECKPOINT_FRESHNESS_MS = 3 * 60 * 1000;

// Per-lesson state, keyed by lesson _id: { inFlight, lastAt, lastSubs }.
// In-memory only — a process restart just means the first post-restart
// submission after the threshold will trigger a fresh checkpoint, which
// is exactly what we want.
const reportCheckpointState = new Map();

function getCheckpointState(lessonId) {
  const key = String(lessonId);
  let entry = reportCheckpointState.get(key);
  if (!entry) {
    entry = { inFlight: false, lastAt: 0, lastSubs: -1 };
    reportCheckpointState.set(key, entry);
  }
  return entry;
}

// Fires a background class-report generation for the active lesson in this
// room, but only when enough time and submissions have accumulated since
// the last checkpoint. Silent no-op on any failure.
function maybeScheduleReportCheckpoint({ roomId, lessonName }) {
  if (!roomId) return;
  setImmediate(async () => {
    try {
      const lesson = await Lesson.findOne({ roomId, status: 'active' })
        .sort({ startedAt: -1 });
      if (!lesson) return;
      // The submit path may have a different lessonName than what Lesson
      // has if the teacher renamed mid-flight — but the Lesson row wins
      // for report scoping, so ignore the passed lessonName here.
      const state = getCheckpointState(lesson._id);
      if (state.inFlight) return;

      const currentSubs = await ClassworkModel.aggregate([
        { $match: { roomId, lessonName: lesson.name } },
        { $project: { subs: { $size: { $ifNull: ['$submitted', []] } } } },
        { $group: { _id: null, total: { $sum: '$subs' } } },
      ]);
      const submissionCount = currentSubs?.[0]?.total || 0;
      const now = Date.now();
      const newSubs = state.lastSubs < 0
        ? submissionCount
        : submissionCount - state.lastSubs;

      if (newSubs < REPORT_CHECKPOINT_MIN_NEW_SUBMISSIONS) return;
      if (now - state.lastAt < REPORT_CHECKPOINT_MIN_INTERVAL_MS) return;

      state.inFlight = true;
      try {
        console.log('[ClassReport] Rolling checkpoint firing', {
          lessonId: String(lesson._id),
          submissionCount,
          newSubsSinceLast: newSubs,
        });
        await generateAndStoreClassReport(lesson);
        state.lastAt = Date.now();
        state.lastSubs = submissionCount;
      } finally {
        state.inFlight = false;
      }
    } catch (err) {
      console.warn(
        '[ClassReport] Rolling checkpoint failed (non-fatal):',
        err?.message || err,
      );
    }
  });
}

// End the active lesson in a room. Marks the Lesson row ended and clears
// the staged classwork buffer (lessonName === '') so the next session starts
// with an empty tray. Classwork already tagged with this lesson's name is
// preserved for reporting.
export const endLessonForRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ message: 'roomId is required.' });
    }
    const ended = await Lesson.findOneAndUpdate(
      { roomId, status: 'active' },
      { $set: { status: 'ended', endedAt: new Date() } },
      { new: true, sort: { startedAt: -1 } }
    );
    const clearedStaged = await ClassworkModel.deleteMany({
      roomId,
      lessonName: '',
    });

    let reusedCheckpoint = false;
    if (ended) {
      // If the rolling-checkpoint pipeline pre-generated a report that's
      // still fresh AND covers every current submission, skip the cold
      // end-lesson regen — teacher already has the up-to-date report on
      // the `lesson` field of this response.
      const cr = ended.classReport;
      const generatedAt = cr?.generatedAt ? new Date(cr.generatedAt).getTime() : 0;
      const isFreshByTime =
        generatedAt > 0 &&
        Date.now() - generatedAt <= REPORT_CHECKPOINT_FRESHNESS_MS;
      let submissionCountMatches = false;
      if (isFreshByTime) {
        try {
          const currentSubs = await ClassworkModel.aggregate([
            { $match: { roomId: ended.roomId, lessonName: ended.name } },
            {
              $project: {
                subs: { $size: { $ifNull: ['$submitted', []] } },
              },
            },
            { $group: { _id: null, total: { $sum: '$subs' } } },
          ]);
          const submissionCount = currentSubs?.[0]?.total || 0;
          const state = getCheckpointState(ended._id);
          submissionCountMatches = state.lastSubs === submissionCount;
        } catch (err) {
          console.warn(
            '[endLessonForRoom] freshness submission count check failed:',
            err?.message || err,
          );
        }
      }

      if (isFreshByTime && submissionCountMatches) {
        reusedCheckpoint = true;
        console.log(
          '[endLessonForRoom] Reusing fresh checkpoint — skipping regeneration',
          { lessonId: String(ended._id), generatedAt: cr.generatedAt },
        );
      } else {
        generateAndStoreClassReport(ended).catch((err) => {
          console.error('[endLessonForRoom] background class report failed:', err);
        });
      }
    }

    return res.status(200).json({
      message: ended ? 'Lesson ended.' : 'No active lesson found; staged buffer cleared.',
      lesson: ended,
      clearedStaged: clearedStaged?.deletedCount ?? 0,
      reusedCheckpoint,
    });
  } catch (err) {
    console.error('endLessonForRoom error:', err);
    res.status(500).json({ message: 'Error ending lesson', error: err.message });
  }
};

// Rename the active lesson in a room. Updates all classwork tagged with the
// previous lesson name so reports/filters still resolve, and renames the
// active Lesson document.
export const renameLessonForRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { from, to } = req.body || {};
    if (!roomId || !to) {
      return res.status(400).json({ message: 'roomId and `to` are required.' });
    }
    const trimmedTo = String(to).trim();
    if (!trimmedTo) {
      return res.status(400).json({ message: '`to` cannot be empty.' });
    }
    const fromName = typeof from === 'string' ? from : '';
    const updated = await ClassworkModel.updateMany(
      { roomId, lessonName: fromName },
      { $set: { lessonName: trimmedTo } }
    );
    const renamedLesson = await Lesson.findOneAndUpdate(
      { roomId, status: 'active' },
      { $set: { name: trimmedTo } },
      { new: true, sort: { startedAt: -1 } }
    );
    return res.status(200).json({
      message: 'Lesson renamed.',
      from: fromName,
      to: trimmedTo,
      updated: updated?.modifiedCount ?? 0,
      lesson: renamedLesson,
    });
  } catch (err) {
    console.error('renameLessonForRoom error:', err);
    res.status(500).json({ message: 'Error renaming lesson', error: err.message });
  }
};

// Return the currently-active Lesson for a room, if any. Useful for the
// React side to check whether students can join (item 3 in the spec).
export const getActiveLessonForRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ message: 'roomId is required.' });
    }
    const lesson = await Lesson.findOne({ roomId, status: 'active' }).sort({
      startedAt: -1,
    });
    return res.status(200).json({ lesson });
  } catch (err) {
    console.error('getActiveLessonForRoom error:', err);
    res.status(500).json({ message: 'Error fetching active lesson', error: err.message });
  }
};

// Gather a lesson's classwork + teacherId, run the AI summary, and persist
// the result onto the Lesson document. Used both by the end-lesson hook
// (fire-and-forget) and by the manual regenerate endpoint. Throws on
// terminal failure so callers can log/respond appropriately.
async function generateAndStoreClassReport(lessonDoc) {
  if (!lessonDoc) return null;
  const lessonQuestions = await ClassworkModel.find({
    roomId: lessonDoc.roomId,
    lessonName: lessonDoc.name,
  }).lean();

  const submissionCount = lessonQuestions.reduce(
    (n, q) => n + (Array.isArray(q.submitted) ? q.submitted.length : 0),
    0,
  );
  console.log(
    `[ClassReport] lesson=${lessonDoc._id} name="${lessonDoc.name}" questions=${lessonQuestions.length} submissions=${submissionCount}`,
  );

  const classroomDoc = lessonDoc.classroomId
    ? await Classroom.findById(lessonDoc.classroomId)
        .select('teacherId studentIds scope')
        .lean()
    : null;
  const teacherId = classroomDoc?.teacherId || null;
  const studentCount = Array.isArray(classroomDoc?.studentIds)
    ? classroomDoc.studentIds.length
    : 0;
  // Instruction language is a session-level knob, not a classroom one, so
  // pull it off the Session doc that owns this lesson.
  const sessionDoc = lessonDoc.sessionId
    ? await Session.findById(lessonDoc.sessionId)
        .select('instructionLanguage')
        .lean()
    : null;

  const classReport = await generateClassReportSummary({
    lessonName: lessonDoc.name,
    questions: lessonQuestions,
    teacherId,
    studentCount,
    scope: classroomDoc?.scope || null,
    instructionLanguage: sessionDoc?.instructionLanguage || 'English',
    sessionId: lessonDoc.sessionId,
  });

  if (!classReport) {
    console.warn(
      `[ClassReport] generation returned null for lesson=${lessonDoc._id} (no submissions or empty AI response).`,
    );
    return null;
  }

  // Use updateOne with $set rather than doc.save() so the new nested
  // subdocument arrays (studentDifficulties etc.) write through cleanly
  // regardless of any in-memory path-tracking state on the loaded doc.
  await Lesson.updateOne(
    { _id: lessonDoc._id },
    { $set: { classReport } },
  );
  console.log(
    `[ClassReport] stored for lesson=${lessonDoc._id}: ` +
      `${classReport.studentDifficulties.length} difficulties, ` +
      `${classReport.nextLessonStrategy.length} strategies, ` +
      `${classReport.targetedHomework.length} homework items`,
  );
  return classReport;
}

// Manual regenerate endpoint. POST /api/classwork/class-report/:roomId/regenerate
// Body may include { lessonName } to retry a single lesson; otherwise every
// ended lesson in the room whose classReport is empty is retried.
// Each retry runs in the background — the response returns immediately with
// the list of lessons that were queued.
export const regenerateClassReportForRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ message: 'roomId is required.' });
    }
    const { lessonName } = req.body || {};

    const query = { roomId, status: 'ended' };
    if (lessonName && typeof lessonName === 'string') {
      query.name = lessonName;
    }
    const lessons = await Lesson.find(query).sort({ endedAt: -1 });

    const queued = [];
    for (const lesson of lessons) {
      const cr = lesson.classReport;
      const alreadyGenerated =
        cr &&
        ((Array.isArray(cr.studentDifficulties) && cr.studentDifficulties.length > 0) ||
          (Array.isArray(cr.nextLessonStrategy) && cr.nextLessonStrategy.length > 0) ||
          (Array.isArray(cr.targetedHomework) && cr.targetedHomework.length > 0));
      if (!lessonName && alreadyGenerated) {
        // Already has a report — skip unless explicitly named.
        continue;
      }
      queued.push({
        lessonId: lesson._id,
        name: lesson.name,
        endedAt: lesson.endedAt,
      });
      generateAndStoreClassReport(lesson).catch((err) => {
        console.error(
          `[regenerateClassReportForRoom] failed for lesson ${lesson._id} (${lesson.name}):`,
          err,
        );
      });
    }

    return res.status(202).json({
      message:
        queued.length === 0
          ? 'No lessons needed regeneration.'
          : `Queued ${queued.length} lesson(s) for regeneration.`,
      queued,
    });
  } catch (err) {
    console.error('regenerateClassReportForRoom error:', err);
    res.status(500).json({ message: 'Error queuing regeneration', error: err.message });
  }
};

// Returns the lesson-level "Class Report" summaries for a room, newest first.
// Each lesson item carries the AI-generated classReport (summary/generatedAt/
// model), the lesson name, and endedAt. The React SessionReportModal calls
// this endpoint to show the class summary by default, before the teacher
// picks a specific student.
export const getClassReportForRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) {
      return res.status(400).json({ message: 'roomId is required.' });
    }
    const lessons = await Lesson.find({ roomId })
      .sort({ endedAt: -1, startedAt: -1 })
      .select('name status startedAt endedAt classReport')
      .lean();

    return res.status(200).json({
      lessons: lessons.map((l) => ({
        name: l.name,
        status: l.status,
        startedAt: l.startedAt,
        endedAt: l.endedAt,
        classReport: l.classReport || null,
      })),
    });
  } catch (err) {
    console.error('getClassReportForRoom error:', err);
    res.status(500).json({ message: 'Error fetching class report', error: err.message });
  }
};

// Per-student lesson report. Returns every lesson for the given room with
// only the requesting student's submission attached to each question — so a
// student can see their own answers/AI feedback without exposing peers.
// Mirrors the per-lesson shape the React modal already understands; the
// class-level summary, range queries, and other students' answers are
// intentionally omitted (spec: "no class general report, no range-of-days
// report").
export const getStudentLessonReport = async (req, res) => {
  try {
    const { roomId, studentId } = req.params;
    if (!roomId || !studentId) {
      return res
        .status(400)
        .json({ message: 'roomId and studentId are required.' });
    }

    const lessons = await Lesson.find({ roomId })
      .sort({ startedAt: 1 })
      .select('name status startedAt endedAt')
      .lean();

    // Pull every question in the room once; we'll bucket by lessonName below.
    const questions = await ClassworkModel.find({ roomId }).lean();

    // Index the student's AI-report rows so per-question AI history (Part 3,
    // interaction trail) is available the same way the teacher report uses it.
    const aiReports = await ClassworkAiReport.find({ roomId, studentId }).lean();
    const reportIndex = new Map();
    aiReports.forEach((r) => {
      reportIndex.set(String(r.questionId), r);
    });

    const projectQuestion = (q) => {
      const submission = (q.submitted || []).find(
        (s) => String(s.studentId) === String(studentId)
      );
      const aiReport = reportIndex.get(String(q.id)) || null;
      return {
        id: q.id,
        _id: q._id,
        label: q.label,
        title: q.title,
        question: q.question,
        image: q.image || '',
        format: q.format || q.formatLabel || '',
        correctAnswer: q.correctAnswer,
        lessonName: q.lessonName || '',
        submission: submission
          ? {
              answer: formatSubmittedAnswerText(submission.answer),
              answerImage: getSubmittedAnswerImage(submission.answer),
              isCorrect: Boolean(submission.isCorrect),
              feedback: submission.feedback || '',
              submittedAt: submission.submittedAt || null,
            }
          : null,
        aiReport: aiReport ? projectAiReport(aiReport, { includeStudentAnswer: false }) : null,
      };
    };

    // Group questions by lessonName so we can emit one report block per lesson.
    const byLessonName = new Map();
    questions.forEach((q) => {
      const key = q.lessonName || '';
      if (!key) return; // staged drafts (no lesson yet) are skipped
      if (!byLessonName.has(key)) byLessonName.set(key, []);
      byLessonName.get(key).push(projectQuestion(q));
    });

    const data = lessons.map((l) => ({
      name: l.name,
      status: l.status,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      questions: byLessonName.get(l.name) || [],
    }));

    return res.status(200).json({ lessons: data });
  } catch (err) {
    console.error('getStudentLessonReport error:', err);
    res
      .status(500)
      .json({ message: 'Error fetching student lesson report', error: err.message });
  }
};

export const clearAllClasswork = async (req, res) => {
  try {
    const [questions, reports] = await Promise.all([
      ClassworkModel.deleteMany({}),
      ClassworkAiReport.deleteMany({}),
    ]);
    res.status(200).json({
      message: 'All classwork cleared.',
      deletedQuestions: questions.deletedCount ?? 0,
      deletedAiReports: reports.deletedCount ?? 0,
    });
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

    // Staged questions are created with released:false and have no
    // releasedAt until the teacher hits the release endpoint. Live-created
    // questions (legacy flow) default to released:true and get a releasedAt
    // stamp now so the expiry timer matches the createdAt window.
    const stagedAsDraft = question?.released === false;
    const newQuestion = await ClassworkModel.create({
      ...question,
      roomId,
      aiAllowed: resolvedAiAllowed,
      aiExpiryTime: resolvedAiAllowed ? resolvedAiExpiryTime : question?.expiryTime,
      released: !stagedAsDraft,
      releasedAt: stagedAsDraft ? null : new Date(),
    });
    if (req.file){
      newQuestion.image = req.file.location;
    }
    await newQuestion.save();

    // Fire the standard-solution precompute off the response path. Writes back
    // to this doc when it succeeds; per-submission feedback reads it via
    // buildCachedContext() and folds it into the systemInstruction prefix.
    schedulePrecomputes(newQuestion, { correctAnswer: question?.correctAnswer });

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

// Release a staged question. Flips released=true and stamps releasedAt so
// the expiry timer starts from now, while createdAt stays as the original
// staging time (preserves audit trail).
export const releaseQuestion = async (req, res) => {
  try {
    const { questionId } = req.params;
    const { roomId } = req.body || {};
    const filter = roomId ? { id: questionId, roomId } : { id: questionId };
    const question = await ClassworkModel.findOneAndUpdate(
      filter,
      { $set: { released: true, releasedAt: new Date() } },
      { new: true }
    );
    if (!question) {
      return res.status(404).json({ message: 'Question not found' });
    }
    // Warm Gemini's implicit prefix cache with a synthetic submission so
    // the first real student pays a warm-cache latency instead of a cold
    // one. Fire-and-forget — never blocks the release response.
    scheduleFeedbackWarmup(question);
    res.status(200).json({
      message: 'Question released',
      question: {
        ...question.toObject(),
        // Mirror addQuestion's response shape so the teacher UI can reuse
        // the same client-side render path.
        image: question.image,
      },
    });
  } catch (err) {
    console.error('Error in releaseQuestion:', err);
    res.status(500).json({ message: 'Error releasing question', error: err.message });
  }
};

// Resolve teacherId + class size from a roomId by walking Session → Classroom.
// Both callers below (submitAnswer, submitAnswerStream) need the same lookup.
async function resolveTeacherAndClassSize({ roomId, teacherId }) {
  let resolvedTeacherId = teacherId || null;
  let resolvedClassSize = null;
  if (!roomId) return { resolvedTeacherId, resolvedClassSize };

  const escapedRoomId = roomId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  if (!resolvedTeacherId) {
    try {
      const session = await Session.findOne({
        sessionUrl: { $regex: escapedRoomId, $options: 'i' },
      });
      if (session?.classroomId) {
        const classroom = await Classroom.findById(session.classroomId)
          .select('teacherId studentIds')
          .lean();
        resolvedTeacherId = classroom?.teacherId || null;
        resolvedClassSize = Array.isArray(classroom?.studentIds)
          ? classroom.studentIds.length
          : null;
      }
    } catch (err) {
      console.error('[Classwork] Failed to resolve teacherId from roomId:', err);
    }
  }

  if (resolvedClassSize == null) {
    try {
      const session = await Session.findOne({
        sessionUrl: { $regex: escapedRoomId, $options: 'i' },
      }).select('classroomId');
      if (session?.classroomId) {
        const classroom = await Classroom.findById(session.classroomId)
          .select('studentIds')
          .lean();
        resolvedClassSize = Array.isArray(classroom?.studentIds)
          ? classroom.studentIds.length
          : null;
      }
    } catch (err) {
      console.error('[Classwork] Failed to resolve class size from roomId:', err);
    }
  }

  return { resolvedTeacherId, resolvedClassSize };
}

// Everything both submit paths need before touching the AI, packaged up.
// Returns either { error: { status, body } } (bail out and respond) or the
// prepared context that both paths feed into the AI call.
async function prepareClassworkSubmission(req) {
  const {
    id,
    questionId,
    studentId,
    studentName,
    answer,
    roomId,
    aiUsed,
    teacherId,
    overrideQuestionText,
    gradeLevel,
  } = req.body;

  const requestedGradeLevel = normalizeGradeLevel(gradeLevel);
  const { resolvedTeacherId, resolvedClassSize } = await resolveTeacherAndClassSize({
    roomId,
    teacherId,
  });

  const lookup = roomId ? { _id: id, id: questionId, roomId } : { id: questionId };
  const question = await ClassworkModel.findOne(lookup).sort({ createdAt: -1 });

  if (!question) {
    return {
      error: {
        status: 404,
        body: { message: roomId ? 'Question not found for this room' : 'Question not found' },
      },
    };
  }
  if (!question.roomId && roomId) question.roomId = roomId;

  if (!question.released) {
    return {
      error: {
        status: 403,
        body: { message: 'This question has not been released yet.' },
      },
    };
  }

  if (question.format === 'textbox') {
    const textboxLimit = Number(question.maxLength) > 0 ? Number(question.maxLength) : 2000;
    const answerText = typeof answer === 'string' ? answer : '';
    if (answerText.length > textboxLimit) {
      return {
        error: {
          status: 400,
          body: { message: `Answer exceeds ${textboxLimit} character limit.` },
        },
      };
    }
  }

  // aiExpiryTime on the question is the per-click AI cooldown enforced by
  // the FE, not a total window since createdAt. The answer-window check
  // above already gates whether the student can submit at all. So AI runs
  // whenever aiAllowed is true.
  const aiAllowed = question.aiAllowed !== false;
  const aiExpired = !aiAllowed;

  const { answer: normalizedAnswer, uploadPromise: answerImageUploadPromise } =
    normalizeSubmittedAnswer(answer, question.format, {
      roomId: question.roomId || roomId,
      questionId: question.id || questionId,
      studentId,
    });

  // When the student is iterating on an AI-generated follow-up question,
  // the frontend sends `overrideQuestionText` so AI sees the new question.
  const questionTextForAi = (typeof overrideQuestionText === 'string' && overrideQuestionText.trim())
    ? overrideQuestionText.trim()
    : question.question;
  const isFollowUp = questionTextForAi !== question.question;

  const existingReport = await ClassworkAiReport.findOne({
    roomId: question.roomId,
    questionId: question.id,
    studentId,
  })
    .select('interactions._id')
    .lean();
  const priorInteractionCount = Array.isArray(existingReport?.interactions)
    ? existingReport.interactions.length
    : 0;
  const previousInteractionId = priorInteractionCount > 0
    ? existingReport.interactions[priorInteractionCount - 1]._id
    : null;
  // 1-based attempt number for THIS submission on this (student, question).
  // Drives the Ask/Tell pedagogy: odd attempts (1,3,5…) ask the student to
  // recall the method themselves; even attempts (2,4,6…) explain it. Resets
  // naturally per question because the report is keyed per (room,question,student).
  const submissionNumber = priorInteractionCount + 1;
  const interactionId = new mongoose.Types.ObjectId();
  const cachedContext = buildCachedContext(question);

  // Resolve the session that owns this room so the AI usage row lands in
  // the right (month, session) bucket. If no active lesson is found we
  // fall back to the sessionless monthly bucket.
  const sessionIdForUsage = await resolveSessionIdForRoom(
    question.roomId || roomId,
    question.lessonName,
  );

  return {
    question,
    studentId,
    studentName,
    aiUsed,
    aiAllowed,
    aiExpired,
    resolvedTeacherId,
    resolvedClassSize,
    requestedGradeLevel,
    normalizedAnswer,
    answerImageUploadPromise,
    questionTextForAi,
    isFollowUp,
    previousInteractionId,
    interactionId,
    submissionNumber,
    cachedContext,
    sessionIdForUsage,
    roomId,
    questionId,
  };
}

// Everything both submit paths do AFTER the AI has returned: fold the
// canonical solution back, update the common-mistake bank + threshold
// state, mutate the submission row, save the question, and upsert the
// per-student AI report. Kept in one place so the non-stream and stream
// controllers can't drift apart.
async function persistClassworkFeedback({ ctx, aiResult }) {
  const {
    question,
    studentId,
    studentName,
    aiUsed,
    aiExpired,
    resolvedClassSize,
    requestedGradeLevel,
    normalizedAnswer,
    answerImageUploadPromise,
    questionTextForAi,
    previousInteractionId,
    interactionId,
  } = ctx;

  // Strip the fat base64 the AI path used inline. Mongo only stores the CDN
  // URL, which the background upload patches in later (see below). Never
  // await the upload here — Gemini is on the critical path, S3 is not.
  if (
    normalizedAnswer &&
    typeof normalizedAnswer === 'object' &&
    !Array.isArray(normalizedAnswer)
  ) {
    if (normalizedAnswer.imageData) {
      delete normalizedAnswer.imageData;
    }
  }

  if (!question.standardSolution && aiResult.standardSolution) {
    question.standardSolution = String(aiResult.standardSolution).trim();
    question.solutionCapturedAt = new Date();
  }

  const isCorrect = Boolean(aiResult.correct);
  const feedback = aiResult.hintStream || '';

  const effectiveClassSize = Number(resolvedClassSize) > 0
    ? Number(resolvedClassSize)
    : 0;
  const commonMistakeThreshold = resolveCommonMistakeThreshold({
    classSize: effectiveClassSize,
    gradeLevel: requestedGradeLevel,
  });

  const aiCache = question.aiFeedbackCache || {};
  aiCache.threshold = commonMistakeThreshold;
  if (commonMistakeThreshold <= 0) {
    aiCache.enabled = false;
  }

  const currentMistakeBank = Array.isArray(question.commonMistakeBank)
    ? [...question.commonMistakeBank]
    : [];
  const rawMistakeTitle = aiResult?.commonMistake?.title || '';
  const normalizedTitle = normalizeMistakeTitle(rawMistakeTitle);
  const isCommonMistake = Boolean(aiResult?.commonMistake?.isCommon);
  if (
    commonMistakeThreshold > 0 &&
    !isCorrect &&
    isCommonMistake &&
    normalizedTitle
  ) {
    const hasTitleAlready = currentMistakeBank.some(
      (m) => normalizeMistakeTitle(m?.title) === normalizedTitle,
    );
    if (!hasTitleAlready) {
      const answerLatex = String(aiResult?.commonMistake?.answerLatex || '').trim();
      currentMistakeBank.push({
        title: String(rawMistakeTitle).trim(),
        studentId,
        studentName,
        studentAnswer: answerLatex || formatSubmittedAnswerText(normalizedAnswer),
        feedback,
        answerLatex,
        interactionId,
        createdAt: new Date(),
      });
    }
  }
  question.commonMistakeBank = currentMistakeBank;

  const distinctTitles = new Set(
    currentMistakeBank
      .map((m) => normalizeMistakeTitle(m?.title))
      .filter(Boolean),
  ).size;

  if (
    commonMistakeThreshold > 0 &&
    !aiCache.enabled &&
    distinctTitles >= commonMistakeThreshold
  ) {
    aiCache.enabled = true;
    aiCache.cachedAt = new Date();
    aiCache.promptSnapshot = String(aiResult?.standardPromptText || '').trim();
    aiCache.teacherPromptSnapshot = String(aiResult?.teacherPromptText || '').trim();
    aiCache.questionSnapshot = question.question || '';
    aiCache.standardSolution = String(
      question.standardSolution || aiResult.standardSolution || ''
    ).trim();
    aiCache.commonMistakes = currentMistakeBank;
  }
  question.aiFeedbackCache = aiCache;

  const existingSubmissionIndex = question.submitted.findIndex((s) => s.studentId === studentId);
  if (existingSubmissionIndex !== -1) {
    const submission = question.submitted[existingSubmissionIndex];
    submission.answer = normalizedAnswer;
    submission.isCorrect = isCorrect;
    submission.aiUsed = aiUsed;
    submission.studentName = studentName;
    submission.feedback = feedback;
    submission.submittedAt = new Date();
  } else {
    question.submitted.push({
      studentId,
      studentName,
      answer: normalizedAnswer,
      isCorrect,
      aiUsed,
      feedback,
      submittedAt: new Date(),
    });
  }
  await question.save();

  // Persist per-interaction AI report data (questions, answer, hint,
  // diagnostic training). Each interaction gets its own ObjectId so the
  // matching `trainingHistory` entry can reference it via `interactionId`.
  try {
    const interactionAt = new Date();
    const part1 = toStringArray(aiResult.part1);
    const part2 = toStringArray(aiResult.part2);
    const part3 = toStringArray(aiResult.part3);
    const interaction = {
      _id: interactionId,
      previousInteractionId,
      questionText: questionTextForAi,
      studentAnswer: normalizedAnswer,
      hintStream: aiResult.hintStream || '',
      part1,
      part2,
      part3,
      standardSolution: aiResult.standardSolution || '',
      commonMistake: {
        title: aiResult?.commonMistake?.title || '',
        isCommon: Boolean(aiResult?.commonMistake?.isCommon),
        answerLatex: aiResult?.commonMistake?.answerLatex || '',
      },
      advancedChallenge: {
        congratulations: aiResult.advancedChallenge?.congratulations || '',
        question: aiResult.advancedChallenge?.question || '',
      },
      correct: isCorrect,
      timestamp: interactionAt,
    };

    const pushOps = { interactions: interaction };
    if (part3.length > 0) {
      pushOps.trainingHistory = {
        interactionId,
        part3,
        timestamp: interactionAt,
      };
    }

    const reportSet = {
      studentName: studentName || 'Unknown',
      lastAnswer: normalizedAnswer,
      lastHintStream: aiResult.hintStream || '',
    };
    if (!aiExpired && typeof aiResult.standardPromptHash === 'string') {
      reportSet.standardPromptHash = aiResult.standardPromptHash;
    }

    await ClassworkAiReport.findOneAndUpdate(
      { roomId: question.roomId, questionId: question.id, studentId },
      {
        $setOnInsert: {
          roomId: question.roomId,
          questionId: question.id,
          studentId,
          originalQuestion: question.question,
        },
        $set: reportSet,
        $push: pushOps,
      },
      { upsert: true, new: true }
    );
  } catch (reportErr) {
    console.error('[Classwork] Failed to upsert AI report:', reportErr);
  }

  // Fire-and-forget: when the handwriting upload eventually resolves, patch
  // both docs' answer.imageUrl in place. This runs completely off the request
  // path — the SSE `done` event has already fired by the time this executes,
  // and the doc initially has imageUrl='' until this catches up. Teacher-side
  // views may briefly see no image; typically only a few seconds.
  if (answerImageUploadPromise && typeof answerImageUploadPromise.then === 'function') {
    const questionMongoId = question._id;
    const questionRoomId = question.roomId;
    const questionPublicId = question.id;
    answerImageUploadPromise
      .then((uploadedUrl) => {
        if (!uploadedUrl) return;
        return Promise.all([
          ClassworkModel.updateOne(
            { _id: questionMongoId, 'submitted.studentId': studentId },
            { $set: { 'submitted.$.answer.imageUrl': uploadedUrl } },
          ).catch((err) =>
            console.error('[Classwork] deferred imageUrl patch on ClassworkModel failed:', err),
          ),
          ClassworkAiReport.updateOne(
            {
              roomId: questionRoomId,
              questionId: questionPublicId,
              studentId,
              'interactions._id': interactionId,
            },
            {
              $set: {
                'interactions.$.studentAnswer.imageUrl': uploadedUrl,
                'lastAnswer.imageUrl': uploadedUrl,
              },
            },
          ).catch((err) =>
            console.error('[Classwork] deferred imageUrl patch on ClassworkAiReport failed:', err),
          ),
        ]);
      })
      .catch((err) => {
        console.error('[Classwork] deferred handwriting upload rejected:', err);
      });
  }

  return {
    isCorrect,
    feedback,
    commonMistakeThreshold,
    distinctTitles,
  };
}

function buildSubmissionResponseBody({ ctx, aiResult, isCorrect, feedback, commonMistakeThreshold, distinctTitles }) {
  const {
    question,
    normalizedAnswer,
    questionTextForAi,
    isFollowUp,
    interactionId,
    previousInteractionId,
    aiAllowed,
    aiExpired,
  } = ctx;
  return {
    message: 'Answer submitted',
    isCorrect,
    aiAllowed,
    aiExpired,
    debug: {
      originalQuestion: question.question,
      questionTextForAi,
      isFollowUp,
      studentAnswer: normalizedAnswer,
      format: question.format,
      expectedAnswer: isFollowUp ? null : (question.correctAnswer ?? null),
      interactionId: String(interactionId),
      previousInteractionId: previousInteractionId ? String(previousInteractionId) : null,
      commonMistakeThreshold,
      cachedCommonMistakeCount: distinctTitles,
      hasCachedSolution: Boolean(question.standardSolution),
    },
    // DIAGNOSTIC: student sees hintStream + part1 + part2. Teacher's
    //             report shows the full part1/part2/part3 per attempt.
    // MASTERY: student sees advancedChallenge (congratulations + question);
    //          teacher sees the final answer marked correct.
    // part3 is intentionally NOT returned to the student — it belongs only
    // in the teacher report.
    ai: projectAiForStudent(aiResult),
    feedback,
    correctAnswer: question.correctAnswer,
    data: question.submitted,
  };
}

// Submit answer + get AI feedback (single merged endpoint replacing /submit + /ai-hint)
export const submitAnswer = async (req, res) => {
  try {
    const prepared = await prepareClassworkSubmission(req);
    if (prepared.error) {
      return res.status(prepared.error.status).json(prepared.error.body);
    }
    const ctx = prepared;

    let aiResult = emptyAiFeedback();
    let aiFailed = false;

    if (!ctx.aiExpired) {
      // Answer-hash dedup: if another student already got Gemini feedback
      // for this same (question, normalized answer, ASK/TELL parity) within
      // the cache TTL, reuse it instead of paying for a fresh call.
      const answerHash = fingerprintAnswer({
        answer: ctx.normalizedAnswer,
        format: ctx.question.format,
        normalizedAnswerText: typeof ctx.normalizedAnswer === 'string'
          ? ctx.normalizedAnswer
          : '',
        isFollowUp: ctx.isFollowUp,
      });
      const cacheKey = buildFeedbackCacheKey({
        questionId: ctx.question.id,
        answerHash,
        submissionNumber: ctx.submissionNumber,
      });
      const cachedAiResult = cacheKey ? getCachedFeedback(cacheKey) : null;

      if (cachedAiResult) {
        console.log('[Classwork] Answer-hash cache HIT — skipping Gemini call', {
          questionId: ctx.question.id,
          cacheKey,
        });
        aiResult = cachedAiResult;
      } else {
        try {
          // Skip the per-call solution compute when we've already precomputed
          // one at question-create time — buildCachedContext folds it into
          // the stable systemInstruction prefix.
          const hasPrecomputedSolution = Boolean(ctx.question.standardSolution);
          aiResult = await getClassworkAiFeedback({
            questionText: ctx.questionTextForAi,
            answer: ctx.normalizedAnswer,
            correctAnswer: ctx.isFollowUp ? '' : ctx.question.correctAnswer,
            derivedCorrectAnswer: ctx.isFollowUp ? '' : (ctx.question.derivedCorrectAnswer || ''),
            questionImage: ctx.isFollowUp ? null : (ctx.question.image || null),
            format: ctx.question.format,
            studentName: ctx.studentName,
            studentId: ctx.studentId,
            classroomId: ctx.question.classroomId || null,
            teacherId: ctx.resolvedTeacherId,
            maxOutputTokens: ctx.question.maxOutputTokens,
            sessionId: ctx.sessionIdForUsage,
            interactionId: String(ctx.interactionId),
            previousInteractionId: ctx.previousInteractionId ? String(ctx.previousInteractionId) : '',
            submissionNumber: ctx.submissionNumber,
            cachedContext: ctx.cachedContext,
            computeStandardSolution: !hasPrecomputedSolution,
          });
          if (cacheKey) setCachedFeedback(cacheKey, aiResult);
        } catch (aiErr) {
          console.error('[Classwork] AI feedback failed:', aiErr);
          aiFailed = true;
        }
      }
    }

    if (aiFailed) {
      return res.status(503).json({
        message: 'AI feedback is temporarily unavailable. Please try again shortly.',
        aiFailed: true,
        aiAllowed: ctx.aiAllowed,
        aiExpired: ctx.aiExpired,
      });
    }

    const { isCorrect, feedback, commonMistakeThreshold, distinctTitles } =
      await persistClassworkFeedback({ ctx, aiResult });

    // Opportunistically pre-generate the class report in the background so
    // end-lesson can reuse a fresh copy instead of paying a cold Gemini call.
    maybeScheduleReportCheckpoint({
      roomId: ctx.question.roomId,
      lessonName: ctx.question.lessonName,
    });

    res.status(200).json(
      buildSubmissionResponseBody({
        ctx,
        aiResult,
        isCorrect,
        feedback,
        commonMistakeThreshold,
        distinctTitles,
      }),
    );
  } catch (err) {
    console.error('[Classwork] submitAnswer error:', err);
    res.status(500).json({ message: 'Error submitting answer', error: err.message });
  }
};

// Small SSE writer. Each event is a single `event:` + `data:` pair
// terminated by a blank line, per the spec. Keeps the payload one JSON
// object per event so the client can `JSON.parse(evt.data)` uniformly.
function writeSseEvent(res, event, data) {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  } catch (err) {
    console.error('[Classwork][stream] Failed to write SSE event:', err);
  }
}

// Streaming variant of submitAnswer. Emits `hint` events with decoded
// `hintStream` deltas as Gemini produces them, then a single `done`
// event whose payload matches the non-stream /submit response body
// exactly — client renderers stay identical after the stream ends.
export const submitAnswerStream = async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Nginx-style buffers can starve short SSE messages; the header is a
  // no-op elsewhere and safe to always set.
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });

  try {
    const prepared = await prepareClassworkSubmission(req);
    if (prepared.error) {
      writeSseEvent(res, 'error', {
        status: prepared.error.status,
        ...prepared.error.body,
      });
      return res.end();
    }
    const ctx = prepared;

    // Fire an instant opener the moment we have ctx — before any Gemini
    // call, cache lookup, or DB work. The client types it out instantly so
    // the student sees warm, personalised content from t=0 instead of a
    // blank spinner during the ~10s Gemini wait. Real hint tokens stream
    // in below over subsequent `hint` events.
    //
    // Composition:
    //   1. Precomputed question-warmup preamble (question.aiOpener) — set at
    //      question-create time; question-specific but student-agnostic.
    //   2. Live answer restate — synthesised here so it can include what
    //      THIS student actually wrote. Zero tokens, zero latency, pure JS.
    //
    // Skipped for follow-ups (the precomputed opener was generated against
    // the original question, and a restate of an AI-generated follow-up
    // adds no value).
    if (!clientGone && !ctx.isFollowUp) {
      const parts = [];
      if (ctx.question.aiOpener) parts.push(String(ctx.question.aiOpener).trim());
      const answerPreview = formatSubmittedAnswerText(ctx.normalizedAnswer).trim();
      if (answerPreview && answerPreview !== '[Image answer submitted]') {
        const clipped = answerPreview.length > 140
          ? `${answerPreview.slice(0, 140)}…`
          : answerPreview;
        parts.push(`You wrote: "${clipped}" — let me take a look.`);
      } else if (answerPreview === '[Image answer submitted]') {
        parts.push('Let me take a look at your handwritten answer.');
      }
      const text = parts.filter(Boolean).join(' ');
      if (text) writeSseEvent(res, 'opener', { text });
    }

    let aiResult = emptyAiFeedback();
    let aiFailed = false;

    if (!ctx.aiExpired) {
      // Answer-hash dedup: if another student already got Gemini feedback
      // for this same (question, normalized answer, ASK/TELL parity) within
      // the cache TTL, replay the cached hintStream as a single SSE 'hint'
      // event and skip the Gemini call entirely. The client's `done` event
      // still carries the full projected AI shape.
      const answerHash = fingerprintAnswer({
        answer: ctx.normalizedAnswer,
        format: ctx.question.format,
        normalizedAnswerText: typeof ctx.normalizedAnswer === 'string'
          ? ctx.normalizedAnswer
          : '',
        isFollowUp: ctx.isFollowUp,
      });
      const cacheKey = buildFeedbackCacheKey({
        questionId: ctx.question.id,
        answerHash,
        submissionNumber: ctx.submissionNumber,
      });
      const cachedAiResult = cacheKey ? getCachedFeedback(cacheKey) : null;

      if (cachedAiResult) {
        console.log('[Classwork][stream] Answer-hash cache HIT — skipping Gemini call', {
          questionId: ctx.question.id,
          cacheKey,
        });
        aiResult = cachedAiResult;
        if (!clientGone) {
          // Same verdict + hint contract as the live Gemini branch, just
          // replayed instantly from the answer-hash cache so the client
          // doesn't need to branch on cache-hit vs miss.
          writeSseEvent(res, 'verdict', { correct: Boolean(aiResult.correct) });
          if (aiResult.hintStream) {
            writeSseEvent(res, 'hint', { chunk: aiResult.hintStream });
          }
        }
      } else {
        try {
          const hasPrecomputedSolution = Boolean(ctx.question.standardSolution);
          aiResult = await getClassworkAiFeedbackStream({
            questionText: ctx.questionTextForAi,
            answer: ctx.normalizedAnswer,
            correctAnswer: ctx.isFollowUp ? '' : ctx.question.correctAnswer,
            derivedCorrectAnswer: ctx.isFollowUp ? '' : (ctx.question.derivedCorrectAnswer || ''),
            questionImage: ctx.isFollowUp ? null : (ctx.question.image || null),
            format: ctx.question.format,
            studentName: ctx.studentName,
            studentId: ctx.studentId,
            classroomId: ctx.question.classroomId || null,
            teacherId: ctx.resolvedTeacherId,
            maxOutputTokens: ctx.question.maxOutputTokens,
            sessionId: ctx.sessionIdForUsage,
            interactionId: String(ctx.interactionId),
            previousInteractionId: ctx.previousInteractionId ? String(ctx.previousInteractionId) : '',
            submissionNumber: ctx.submissionNumber,
            cachedContext: ctx.cachedContext,
            computeStandardSolution: !hasPrecomputedSolution,
            onHintDelta: (chunk) => {
              if (clientGone) return;
              writeSseEvent(res, 'hint', { chunk });
            },
            // Fires once, as soon as Gemini emits the first `"correct":…`
            // token (schema puts `correct` first). The client can render
            // "✅ Correct" / "keep going" without waiting for the full
            // hint stream to complete — this is the perceived-latency win
            // for handwriting/image submissions.
            onVerdict: (isCorrect) => {
              if (clientGone) return;
              writeSseEvent(res, 'verdict', { correct: Boolean(isCorrect) });
            },
          });
          if (cacheKey) setCachedFeedback(cacheKey, aiResult);
        } catch (aiErr) {
          console.error('[Classwork][stream] AI feedback failed:', aiErr);
          aiFailed = true;
        }
      }
    }

    if (aiFailed) {
      writeSseEvent(res, 'error', {
        status: 503,
        message: 'AI feedback is temporarily unavailable. Please try again shortly.',
        aiFailed: true,
        aiAllowed: ctx.aiAllowed,
        aiExpired: ctx.aiExpired,
      });
      return res.end();
    }

    const { isCorrect, feedback, commonMistakeThreshold, distinctTitles } =
      await persistClassworkFeedback({ ctx, aiResult });

    // Opportunistically pre-generate the class report in the background so
    // end-lesson can reuse a fresh copy instead of paying a cold Gemini call.
    maybeScheduleReportCheckpoint({
      roomId: ctx.question.roomId,
      lessonName: ctx.question.lessonName,
    });

    writeSseEvent(
      res,
      'done',
      buildSubmissionResponseBody({
        ctx,
        aiResult,
        isCorrect,
        feedback,
        commonMistakeThreshold,
        distinctTitles,
      }),
    );
    res.end();
  } catch (err) {
    console.error('[Classwork][stream] error:', err);
    writeSseEvent(res, 'error', {
      status: 500,
      message: 'Error submitting answer',
      error: err.message,
    });
    if (!res.writableEnded) res.end();
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

// View all answers overview for a room (teacher side).
// Merges ClassworkModel.submitted (the live answer slice) with the
// ClassworkAiReport persisted history so the report modal can show the
// question image, AI Part 3 history, per-interaction trail, and any bonus
// question generated when the student answered correctly.
export const viewAllAnswers = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { lessonName } = req.query;
    const filter = { roomId };
    if (lessonName !== undefined) filter.lessonName = lessonName;
    const questions = await ClassworkModel.find(filter);

    // Batch-load all AI reports for this room so we don't hit the DB once per
    // (question, student) pair. Index by `${questionId}::${studentId}`.
    const aiReports = await ClassworkAiReport.find({ roomId }).lean();
    const reportIndex = new Map();
    aiReports.forEach((r) => {
      reportIndex.set(`${r.questionId}::${r.studentId}`, r);
    });

    const data = questions.map((q) => {
      const submitted = q.submitted.map((s) => {
        const name = s.studentName || s.studentId || 'Unknown';
        const initials = name
          .split(' ')
          .map((p) => p[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();

        const report = reportIndex.get(`${q.id}::${s.studentId}`) || null;

        return {
          // Existing shape — kept verbatim for backwards compatibility.
          name,
          initials,
          studentId: s.studentId,
          answer: formatSubmittedAnswerText(s.answer),
          answerImage: getSubmittedAnswerImage(s.answer),
          isCorrect: s.isCorrect || false,
          aiScore: s.aiScore || 0,
          aiUsed: s.aiUsed || '0x',
          feedback: s.feedback || '',
          preSubmitAnswers: s.preSubmitAnswers || [],
          submittedAt: s.submittedAt || null,

          // AI report fields (case-c storage). Empty defaults when no AI
          // history exists for this student/question.
          aiReport: report
            ? projectAiReport(report, { includeStudentAnswer: true })
            : {
                lastHintStream: '',
                trainingHistory: [],
                interactions: [],
                latestAdvancedQuestion: '',
                lastWrongInteraction: null,
                originalQuestion: '',
              },
        };
      });

      return {
        id: q.id,
        _id: q._id,
        label: q.label,
        title: q.title,
        question: q.question,
        // The question image is stored once on the Classwork document and
        // referenced by `q.id`. The frontend can use `questionImageId` as a
        // stable handle (per spec #9: avoid duplicating images).
        image: q.image || '',
        questionImageId: q.image ? q.id : '',
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

// Get questions for a room (student side). Only released questions are
// returned — staged-but-not-yet-released drafts stay hidden.
export const getQuestions = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { lessonName } = req.query;
    const filter = { roomId, released: true };
    if (lessonName !== undefined) filter.lessonName = lessonName;
    const questions = await ClassworkModel.find(filter).select('-submitted -correctAnswer');
    res.status(200).json(questions);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching questions', error: err.message });
  }
};

// Update an existing classwork question. Intended for the staged (pre-lesson)
// editor — refuses to mutate a question that has already been released so we
// don't change the wording out from under students who are mid-answer.
export const updateStagedQuestion = async (req, res) => {
  try {
    const { questionId } = req.params;
    const patch = req.body?.question ? JSON.parse(req.body.question) : (req.body || {});
    const existing = await ClassworkModel.findOne({ id: questionId });
    if (!existing) {
      return res.status(404).json({ message: 'Question not found' });
    }
    if (existing.released) {
      return res.status(409).json({ message: 'Released questions cannot be edited' });
    }
    const editable = [
      'label', 'title', 'question', 'format', 'formatLabel',
      'options', 'blanks', 'maxLength', 'correctAnswer',
      'expiryTime', 'aiAllowed', 'aiExpiryTime', 'maxOutputTokens',
    ];
    for (const key of editable) {
      if (patch[key] !== undefined) existing[key] = patch[key];
    }
    if (existing.aiAllowed && existing.aiExpiryTime == null) {
      existing.aiExpiryTime = existing.expiryTime;
    }
    if (req.file) {
      existing.image = req.file.location;
    } else if (patch.removeImage === true) {
      existing.image = undefined;
    }
    await existing.save();
    res.status(200).json(existing.toObject());
  } catch (err) {
    console.error('Error in updateStagedQuestion:', err);
    res.status(500).json({ message: 'Error updating question', error: err.message });
  }
};

// Get the full queue for a room (teacher side) — includes both released
// questions and staged drafts so the teacher can manage their lineup.
export const getStagedQuestions = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { lessonName } = req.query;
    const filter = { roomId };
    if (lessonName !== undefined) filter.lessonName = lessonName;
    const questions = await ClassworkModel.find(filter)
      .select('-submitted')
      .sort({ createdAt: 1 });
    res.status(200).json(questions);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching staged questions', error: err.message });
  }
};

