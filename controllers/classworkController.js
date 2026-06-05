import { Parser as Json2csvParser } from 'json2csv';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import mongoose from 'mongoose';
import ClassworkModel from '../models/ClassworkModel.js';
import ClassworkAiReport from '../models/ClassworkAiReportModel.js';
import Classroom from '../models/classroomModel.js';
import Session from '../models/SessionModel.js';
import Lesson from '../models/LessonModel.js';
import { getClassworkAiFeedback } from '../utils/geminiClassworkFeedback.js';
import { generateClassReportSummary } from '../utils/geminiClassReportSummary.js';
import { getExpiryState, getQuestionAiExpirySeconds, getQuestionExpirySeconds, getQuestionTimerStart, isValidExpirySeconds } from '../utils/classworkExpiry.js';
import { s3 } from '../utils/s3.js';
import nodemailer from "nodemailer";

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

    if (ended) {
      generateAndStoreClassReport(ended).catch((err) => {
        console.error('[endLessonForRoom] background class report failed:', err);
      });
    }

    return res.status(200).json({
      message: ended ? 'Lesson ended.' : 'No active lesson found; staged buffer cleared.',
      lesson: ended,
      clearedStaged: clearedStaged?.deletedCount ?? 0,
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

  const teacherId = lessonDoc.classroomId
    ? (await Classroom.findById(lessonDoc.classroomId).select('teacherId').lean())?.teacherId
    : null;

  const classReport = await generateClassReportSummary({
    lessonName: lessonDoc.name,
    questions: lessonQuestions,
    teacherId,
  });

  if (!classReport) return null;

  lessonDoc.classReport = classReport;
  await lessonDoc.save();
  return classReport;
}

// Manual regenerate endpoint. POST /api/classwork/class-report/:roomId/regenerate
// Body may include { lessonName } to retry a single lesson; otherwise every
// ended lesson in the room whose classReport.summary is missing is retried.
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
      if (!lessonName && lesson.classReport && lesson.classReport.summary) {
        // Already has a summary — skip unless explicitly named.
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

// Submit answer + get AI feedback (single merged endpoint replacing /submit + /ai-hint)
export const submitAnswer = async (req, res) => {
  try {
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
    } = req.body;

    let resolvedTeacherId = teacherId;
    if (!resolvedTeacherId && roomId) {
      try {
        const escapedRoomId = roomId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const session = await Session.findOne({
            sessionUrl: { $regex: escapedRoomId, $options: "i" }
        });
        if (session?.classroomId) {
          const classroom = await Classroom.findById(session.classroomId)
            .select("teacherId")
            .lean();
          resolvedTeacherId = classroom?.teacherId || null;
        }
      } catch (err) {
        console.error("[Classwork] Failed to resolve teacherId from roomId:", err);
      }
    }

    const lookup = roomId ? { _id: id, id: questionId, roomId } : { id: questionId };
    const question = await ClassworkModel.findOne(lookup).sort({ createdAt: -1 });

    if (!question) {
      return res.status(404).json({
        message: roomId ? 'Question not found for this room' : 'Question not found',
      });
    }
    if (!question.roomId && roomId) question.roomId = roomId;

    if (!question.released) {
      return res.status(403).json({ message: 'This question has not been released yet.' });
    }
    const answerExpiryState = getExpiryState(getQuestionTimerStart(question), getQuestionExpirySeconds(question));
    // if (answerExpiryState.isExpired) {
    //   return res.status(403).json({ message: 'Time expired. You can no longer submit an answer for this question.' });
    // }

    if (question.format === 'textbox') {
      const textboxLimit = Number(question.maxLength) > 0 ? Number(question.maxLength) : 2000;
      const answerText = typeof answer === 'string' ? answer : '';
      if (answerText.length > textboxLimit) {
        return res.status(400).json({ message: `Answer exceeds ${textboxLimit} character limit.` });
      }
    }

    // aiExpiryTime on the question is the per-click AI cooldown enforced by the FE,
    // not a total window since createdAt. The answer-window check above already gates
    // whether the student can submit at all. So AI runs whenever aiAllowed is true.
    const aiAllowed = question.aiAllowed !== false;
    const aiExpired = !aiAllowed;

    const normalizedAnswer = await normalizeSubmittedAnswer(answer, question.format, {
      roomId: question.roomId || roomId,
      questionId: question.id || questionId,
      studentId,
    });

    // When the student is iterating on an AI-generated follow-up question (case b),
    // the frontend sends `overrideQuestionText` so AI sees the new question, not the original.
    const questionTextForAi = (typeof overrideQuestionText === 'string' && overrideQuestionText.trim())
      ? overrideQuestionText.trim()
      : question.question;
    const isFollowUp = questionTextForAi !== question.question;

    let aiResult = {
      correct: false,
      part1: '',
      part2: '',
      part3: '',
      newQuestion: '',
    };
    let aiFailed = false;

    if (!aiExpired) {
      try {
        aiResult = await getClassworkAiFeedback({
          questionText: questionTextForAi,
          answer: normalizedAnswer,
          correctAnswer: isFollowUp ? '' : question.correctAnswer,
          questionImage: isFollowUp ? null : question.image,
          format: question.format,
          studentName,
          teacherId: resolvedTeacherId,
        });
      } catch (aiErr) {
        console.error('[Classwork] AI feedback failed:', aiErr);
        aiFailed = true;
      }
    }

    // If AI failed entirely, don't penalize the student: skip saving the submission
    // and let the frontend roll back the hint count / cooldown.
    if (aiFailed) {
      return res.status(503).json({
        message: 'AI feedback is temporarily unavailable. Please try again shortly.',
        aiFailed: true,
        aiAllowed,
        aiExpired,
      });
    }

    const isCorrect = Boolean(aiResult.correct);
    const feedback = aiResult.part2 || '';

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

    // Persist case-c report data: questions, latest answer, latest part 2, full
    // part-3 history. Each interaction is assigned its own ObjectId here so the
    // matching `allPart3` entry can reference it via `interactionId`.
    try {
      const interactionId = new mongoose.Types.ObjectId();
      const interactionAt = new Date();
      const interaction = {
        _id: interactionId,
        questionText: questionTextForAi,
        studentAnswer: normalizedAnswer,
        aiPart1: aiResult.part1 || '',
        aiPart2: aiResult.part2 || '',
        aiPart3: aiResult.part3 || '',
        correct: isCorrect,
        newQuestion: aiResult.newQuestion || '',
        timestamp: interactionAt,
      };

      const pushOps = { interactions: interaction };
      if (aiResult.part3) {
        pushOps.allPart3 = {
          interactionId,
          text: aiResult.part3,
          timestamp: interactionAt,
        };
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
          $set: {
            studentName: studentName || 'Unknown',
            lastAnswer: normalizedAnswer,
            lastPart2: aiResult.part2 || '',
          },
          $push: pushOps,
        },
        { upsert: true, new: true }
      );
    } catch (reportErr) {
      console.error('[Classwork] Failed to upsert AI report:', reportErr);
    }

    res.status(200).json({
      message: 'Answer submitted',
      isCorrect,
      aiAllowed,
      aiExpired,
      // Debug echo — surface exactly what the AI saw so we can verify the inputs.
      debug: {
        originalQuestion: question.question,
        questionTextForAi,
        isFollowUp,
        studentAnswer: normalizedAnswer,
        format: question.format,
        expectedAnswer: isFollowUp ? null : (question.correctAnswer ?? null),
      },
      // Case a (incorrect): student sees part1 + part2; teacher sees student answer + part2 replacing prior.
      // Case b (correct): student sees part2 confirmation + newQuestion; teacher sees the final answer marked correct.
      // Part 3 is intentionally NOT returned — it belongs only in the report.
      ai: {
        correct: isCorrect,
        part1: aiResult.part1 || '',
        part2: aiResult.part2 || '',
        newQuestion: aiResult.newQuestion || '',
      },
      feedback,
      correctAnswer: question.correctAnswer,
      data: question.submitted,
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

        // Pull the latest bonus question (newQuestion) by walking interactions
        // in reverse — the most recent non-empty value wins.
        let latestNewQuestion = '';
        if (report && Array.isArray(report.interactions)) {
          for (let i = report.interactions.length - 1; i >= 0; i -= 1) {
            const nq = report.interactions[i]?.newQuestion;
            if (nq) {
              latestNewQuestion = nq;
              break;
            }
          }
        }

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
            ? {
                lastPart2: report.lastPart2 || '',
                // `allPart3` is now [{ interactionId, text, timestamp }]. Old
                // documents may still hold plain strings — normalize both
                // shapes so the frontend never has to branch.
                allPart3: (report.allPart3 || []).map((entry) =>
                  typeof entry === 'string'
                    ? { interactionId: null, text: entry, timestamp: null }
                    : {
                        interactionId: entry.interactionId || null,
                        text: entry.text || '',
                        timestamp: entry.timestamp || null,
                      }
                ),
                interactions: (report.interactions || []).map((it) => ({
                  interactionId: it._id || null,
                  questionText: it.questionText || '',
                  studentAnswer: it.studentAnswer,
                  aiPart1: it.aiPart1 || '',
                  aiPart2: it.aiPart2 || '',
                  aiPart3: it.aiPart3 || '',
                  newQuestion: it.newQuestion || '',
                  correct: Boolean(it.correct),
                  timestamp: it.timestamp || null,
                })),
                newQuestion: latestNewQuestion,
                originalQuestion: report.originalQuestion || '',
              }
            : {
                lastPart2: '',
                allPart3: [],
                interactions: [],
                newQuestion: '',
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
      'expiryTime', 'aiAllowed', 'aiExpiryTime',
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

