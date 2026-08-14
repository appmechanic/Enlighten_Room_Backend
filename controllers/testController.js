import mongoose from "mongoose";
import Test from "../models/TestModel.js";
import Classroom from "../models/classroomModel.js";
import Question from "../models/QuestionModel.js";
import Session from "../models/SessionModel.js";
import Lesson from "../models/LessonModel.js";
import Assignment from "../models/AssignmentModel.js";
import {
  buildLessonsReport,
  buildQuestionDoc,
  runWithConcurrency,
} from "./assignmentController.js";
import { generateTestQuestions } from "../utils/geminiTestGeneration.js";
import {
  generateAssignmentQuestionImage,
  getAssignmentImageModel,
} from "../utils/geminiAssignmentImage.js";
import { generateTestFeedback } from "../utils/geminiTestFeedback.js";
import { generateTestClassReport } from "../utils/geminiTestClassReport.js";
import User from "../models/user.js";

// Runs one-shot: reads every submission's aggregated feedback, calls the
// class-report util, and writes {generatedAt, body} onto the task doc.
// Returns the fresh classReport shape either way (null if it couldn't
// generate). Idempotent — callers should check task.classReport?.body first
// to avoid re-billing tokens on every read.
async function ensureTestClassReport(testDoc, taskId) {
  const task = testDoc.tests.id(taskId);
  if (!task) return null;
  if (task.classReport?.body) return task.classReport;
  const expiredMs = task.expiredDate
    ? new Date(task.expiredDate).getTime()
    : 0;
  if (!expiredMs || Date.now() < expiredMs) return null;
  if (!(task.submissions || []).length) {
    // No submissions to summarise — record an empty report so we don't try
    // to generate again on every read.
    task.classReport = {
      generatedAt: new Date(),
      body: {
        summary: "No students submitted this test before it expired.",
        topDifficulties: [],
        suggestedNextSteps: [],
        marksDistribution: "",
      },
    };
    await testDoc.save();
    return task.classReport;
  }

  // Enrich the roster with student names in a single query so the report
  // prompt reads as "Alice" instead of an ObjectId.
  const studentIds = task.submissions
    .map((s) => s.studentId)
    .filter(Boolean);
  const users = studentIds.length
    ? await User.find({ _id: { $in: studentIds } })
        .select("name")
        .lean()
    : [];
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  const submissions = task.submissions.map((s) => ({
    studentId: String(s.studentId),
    studentName: nameById.get(String(s.studentId)) || "",
    isCompleted: s.isCompleted,
    marks: s.marks,
    feedback: s.feedback,
  }));

  const body = await generateTestClassReport({
    teacherId: testDoc.teacherId,
    title: task.title,
    totalQuestions: (task.questions || []).length,
    maxMarks: task.maxMarks,
    submissions,
  });
  task.classReport = { generatedAt: new Date(), body };
  await testDoc.save();
  return task.classReport;
}

// POST /api/test/with-ai
// Creates a new Test using the same "Create Assignment with AI" pipeline
// but scoped by a *date range* instead of a lesson picker, and framed as a
// post-lesson assessment (see config/standardPromptDefaults.js →
// CREATING_TEST_PROMPT_DEFAULT).
//
// Flow:
//   1. Validate inputs (per-format counts, date range, expiredDate).
//   2. sessionRange.start/end → Sessions of THIS classroom that overlap the
//      window → all Lessons of those Sessions → lessonIds.
//   3. Reuse assignmentController.buildLessonsReport(lessonIds) for the
//      classwork evidence (questions + last Part 2 feedback + Part 3
//      training history — exactly the spec's attachment list).
//   4. Additionally fetch Assignment tasks whose dueDate falls in the same
//      window and inline their questions for the "assignment reports" half
//      of the evidence bundle.
//   5. generateTestQuestions() → structured question list.
//   6. Persist Question docs, fan out image gen per format (Nano Banana Pro
//      via geminiAssignmentImage.js — the module is format-agnostic).
//   7. Save Test doc, respond.
export const createTestWithAI = async (req, res) => {
  const {
    classroomId,
    teacherId,
    title,
    description = "",
    startDate,
    expiredDate,
    sessionRange = {}, // { start, end } ISO strings
    perFormatCounts = {},
    perFormatImages = {},
    maxMarks = 10,
    teacherPrompt: teacherPromptOverride,
    resources = [],
    course,
    topic,
  } = req.body || {};

  if (!classroomId || !teacherId) {
    return res
      .status(400)
      .json({ error: "classroomId and teacherId are required." });
  }
  if (!title || !expiredDate) {
    return res
      .status(400)
      .json({ error: "title and expiredDate are required." });
  }

  const totalRequested = Object.values(perFormatCounts || {}).reduce(
    (n, v) => n + (Number(v) || 0),
    0,
  );
  if (totalRequested === 0) {
    return res.status(400).json({
      error: "At least one format must request a non-zero question count.",
    });
  }
  // Enforce the picker's 3-30 range on the server so a hand-crafted request
  // can't smuggle a huge count past the UI.
  for (const [fmt, n] of Object.entries(perFormatCounts)) {
    const v = Number(n) || 0;
    if (v > 0 && (v < 3 || v > 30)) {
      return res.status(400).json({
        error: `perFormatCounts.${fmt} must be between 3 and 30 (got ${v}).`,
      });
    }
  }

  const rangeStart = sessionRange?.start ? new Date(sessionRange.start) : null;
  const rangeEnd = sessionRange?.end ? new Date(sessionRange.end) : null;
  if (
    !rangeStart ||
    !rangeEnd ||
    Number.isNaN(rangeStart.getTime()) ||
    Number.isNaN(rangeEnd.getTime()) ||
    rangeEnd < rangeStart
  ) {
    return res
      .status(400)
      .json({ error: "sessionRange.start and sessionRange.end are required." });
  }

  try {
    const classroom = await Classroom.findById(classroomId).lean();
    if (!classroom) {
      return res.status(400).json({ error: "Invalid classroomId" });
    }
    const classroomPrompt = classroom.classroom_prompt || "";
    const useExplicitTeacherPrompt =
      typeof teacherPromptOverride === "string" &&
      teacherPromptOverride.trim() !== "";

    // Resolve the sessions-in-range → lessons-in-range chain. Session dates
    // may live on scheduled slots or on the doc itself depending on how the
    // session was created, so we intersect with Lesson.startedAt as the
    // authoritative "this actually happened at time T" signal.
    const lessonsInRange = await Lesson.find({
      startedAt: { $gte: rangeStart, $lte: rangeEnd },
    })
      .populate({ path: "sessionId", select: "classroomId topic" })
      .select("_id name roomId sessionId startedAt")
      .lean();
    const scoped = lessonsInRange.filter(
      (l) => String(l?.sessionId?.classroomId || "") === String(classroomId),
    );
    const lessonIds = scoped.map((l) => String(l._id));
    const derivedSessionId = scoped[0]?.sessionId?._id
      ? String(scoped[0].sessionId._id)
      : undefined;
    const resolvedTopic =
      topic || scoped[0]?.sessionId?.topic || classroom.subject?.name || "";

    // Classwork evidence — reuse the assignment pipeline verbatim so both
    // paths agree on how "last Part 2 + all Part 3" is shaped.
    const classworkReport = await buildLessonsReport({ lessonIds });

    // Assignment evidence — every Assignment doc for this classroom whose
    // task dueDate falls in the window. We flatten task.questions so the AI
    // sees the assignment questions alongside classwork questions.
    const assignmentDocs = await Assignment.find({ classroomId })
      .populate({ path: "assignments.questions" })
      .lean();
    const assignmentQuestions = [];
    assignmentDocs.forEach((doc) => {
      (doc.assignments || []).forEach((task) => {
        const due = task?.dueDate ? new Date(task.dueDate) : null;
        if (!due || due < rangeStart || due > rangeEnd) return;
        (task.questions || []).forEach((q) => {
          if (!q) return;
          assignmentQuestions.push({
            question: q.questionText,
            format: q.type,
            correctAnswer: q.correctAnswer,
            submitted: [],
          });
        });
      });
    });

    const evidenceBundle = {
      rangeLabel: `${rangeStart.toISOString()} → ${rangeEnd.toISOString()}`,
      lessonNames: scoped.map((l) => l.name).filter(Boolean),
      classworkQuestions: classworkReport?.questions || [],
      assignmentQuestions,
    };

    const { questions: generatedQuestions, generation } =
      await generateTestQuestions({
        evidenceBundle,
        perFormatCounts,
        course: course || classroom.subject?.name,
        topic: resolvedTopic,
        classroomPrompt,
        // Only pass teacherId when we WANT the DB-stored per-teacher prompt.
        // If the request supplied an explicit override, skip the DB lookup
        // and stamp the override on the generation snapshot instead.
        teacherId: useExplicitTeacherPrompt ? null : teacherId,
      });
    if (useExplicitTeacherPrompt) {
      generation.teacherPrompt = teacherPromptOverride.trim();
    }

    if (!generatedQuestions.length) {
      return res.status(502).json({
        error: "AI did not return any questions. Please try again.",
      });
    }

    // Persist Question docs first so images can be keyed on stable IDs.
    // Tests never show AI hints to students during the sitting, so
    // maxAiHints is pinned to 0 on the underlying Question docs.
    const baseDocs = generatedQuestions.map((q) =>
      buildQuestionDoc({
        generated: q,
        classroomId,
        sessionId: derivedSessionId,
        teacherId,
        course: course || classroom.subject?.name,
        topic: resolvedTopic,
        maxAiHints: 0,
        aiHintCooldownSeconds: 0,
      }),
    );
    const savedQuestions = await Question.insertMany(baseDocs);

    // Fan out image gen per format only when the teacher opted in. The
    // Nano Banana Pro helper is generic (assignment/test agnostic) —
    // reusing it keeps a single image code path.
    const wantsImage = (format) => Boolean(perFormatImages?.[format]);
    const targetsForImages = savedQuestions
      .map((doc, idx) => ({ doc, generated: generatedQuestions[idx] }))
      .filter(({ generated }) => wantsImage(generated.format));

    if (targetsForImages.length) {
      const generatedImages = await runWithConcurrency(
        targetsForImages,
        3,
        async ({ doc, generated }) => {
          const img = await generateAssignmentQuestionImage({
            questionText: generated.imagePromptHint || generated.questionText,
            course: course || classroom.subject?.name,
            topic: resolvedTopic,
            format: generated.format,
            questionId: doc._id,
          });
          if (img?.url) {
            await Question.updateOne(
              { _id: doc._id },
              { $set: { image: img.url } },
            );
            return img;
          }
          return null;
        },
      );
      const okCount = generatedImages.filter(Boolean).length;
      console.log(
        `[createTestWithAI] generated ${okCount}/${targetsForImages.length} images`,
      );
      if (okCount > 0) generation.imageModel = await getAssignmentImageModel();
    }

    const task = {
      title,
      description,
      startDate: startDate ? new Date(startDate) : new Date(),
      expiredDate: new Date(expiredDate),
      sessionRange: { start: rangeStart, end: rangeEnd },
      maxMarks,
      studentIds: (classroom.studentIds || []).map((id) => String(id)),
      resources,
      perFormatCounts,
      perFormatImages,
      questions: savedQuestions.map((q) => q._id),
      generation,
    };

    const testDoc = await Test.create({
      classroomId,
      ...(derivedSessionId ? { sessionId: derivedSessionId } : {}),
      teacherId,
      tests: [task],
    });

    await Question.updateMany(
      { _id: { $in: savedQuestions.map((q) => q._id) } },
      { $set: { testId: testDoc._id } },
    );

    await testDoc.populate({ path: "tests.questions" });

    return res.status(201).json({
      message: "Test created with AI.",
      test: testDoc,
      stats: {
        questionsGenerated: savedQuestions.length,
        imageRequested: targetsForImages.length,
        lessonsInRange: scoped.length,
        assignmentQuestionsInRange: assignmentQuestions.length,
      },
    });
  } catch (err) {
    console.error("createTestWithAI error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/test/student/:testId/:taskId
// Returns the test task shaped for a student to take. Strips reference
// answers / worked solutions from every question so a client-side inspect
// can't leak them. Only returns questions if the current time is within the
// [startDate, expiredDate] window. Also returns which questions this
// student has already submitted so the client can render them inactive.
export const getStudentTest = async (req, res) => {
  const { testId, taskId } = req.params;
  const studentId = String(req.user?._id || req.query?.studentId || "");
  if (!testId || !taskId) {
    return res.status(400).json({ error: "testId and taskId are required." });
  }
  if (!studentId) {
    return res.status(401).json({ error: "Student identity required." });
  }
  try {
    const testDoc = await Test.findById(testId)
      .populate({ path: "tests.questions" })
      .lean();
    if (!testDoc) return res.status(404).json({ error: "Test not found." });
    const task = (testDoc.tests || []).find((t) => String(t._id) === taskId);
    if (!task) return res.status(404).json({ error: "Test task not found." });

    // Availability window enforcement. Return 403 with a hint so the client
    // can render a friendly "not open yet" / "closed" screen instead of a
    // generic error.
    const now = Date.now();
    const startMs = task.startDate ? new Date(task.startDate).getTime() : 0;
    const expiredMs = task.expiredDate
      ? new Date(task.expiredDate).getTime()
      : Infinity;
    if (now < startMs) {
      return res.status(403).json({
        error: "Test is not open yet.",
        opensAt: task.startDate,
      });
    }
    if (now >= expiredMs) {
      return res.status(403).json({
        error: "Test has expired.",
        closedAt: task.expiredDate,
      });
    }

    // Whitelist check — only students the test was published to may take it.
    const eligible = (task.studentIds || []).some(
      (id) => String(id) === studentId,
    );
    if (!eligible) {
      return res
        .status(403)
        .json({ error: "You are not assigned to this test." });
    }

    // Which questions this student has already submitted — used by the
    // client to disable those questions' Submit buttons.
    const mySubmission = (task.submissions || []).find(
      (s) => String(s.studentId) === studentId,
    );
    const submittedQIds = new Set(
      (mySubmission?.questions || []).map((id) => String(id)),
    );

    // Strip fields the student must not see: correctAnswer, solution, hints
    // (per spec: "No hints shown to students because this one is a test").
    const safeQuestions = (task.questions || []).map((q) => ({
      _id: q._id,
      questionText: q.questionText,
      type: q.type,
      options: q.options || [],
      blanks: q.blanks || [],
      image: q.image || "",
      submitted: submittedQIds.has(String(q._id)),
    }));

    return res.json({
      ok: true,
      test: {
        _id: testDoc._id,
        classroomId: testDoc.classroomId,
        sessionId: testDoc.sessionId,
      },
      task: {
        _id: task._id,
        title: task.title,
        description: task.description,
        startDate: task.startDate,
        expiredDate: task.expiredDate,
        maxMarks: task.maxMarks,
        perFormatCounts: task.perFormatCounts,
        questions: safeQuestions,
      },
      mySubmission: mySubmission
        ? {
            submittedAt: mySubmission.submittedAt,
            isCompleted: mySubmission.isCompleted,
            marks: mySubmission.marks,
            fullscreenExits: mySubmission.fullscreenExits || [],
          }
        : null,
    });
  } catch (err) {
    console.error("getStudentTest error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /api/test/submit-question
// Records one student's answer to one question, calls the Test AI feedback
// util, and updates the student's TestSubmission subdoc in place. Response
// intentionally does NOT include the AI's feedback body — students must not
// see hints/feedback during a test (spec).
export const submitTestQuestion = async (req, res) => {
  const { testId, taskId, questionId, answer } = req.body || {};
  const studentId = String(req.user?._id || req.body?.studentId || "");
  if (!testId || !taskId || !questionId) {
    return res
      .status(400)
      .json({ error: "testId, taskId, and questionId are required." });
  }
  if (!studentId) {
    return res.status(401).json({ error: "Student identity required." });
  }

  try {
    const testDoc = await Test.findById(testId);
    if (!testDoc) return res.status(404).json({ error: "Test not found." });
    const task = testDoc.tests.id(taskId);
    if (!task) return res.status(404).json({ error: "Test task not found." });

    const now = Date.now();
    const startMs = task.startDate ? new Date(task.startDate).getTime() : 0;
    const expiredMs = task.expiredDate
      ? new Date(task.expiredDate).getTime()
      : Infinity;
    if (now < startMs) {
      return res.status(403).json({ error: "Test is not open yet." });
    }
    if (now >= expiredMs) {
      return res.status(403).json({ error: "Test has expired." });
    }
    const eligible = (task.studentIds || []).some(
      (id) => String(id) === studentId,
    );
    if (!eligible) {
      return res
        .status(403)
        .json({ error: "You are not assigned to this test." });
    }

    const belongs = (task.questions || []).some(
      (id) => String(id) === String(questionId),
    );
    if (!belongs) {
      return res
        .status(404)
        .json({ error: "Question does not belong to this test." });
    }

    // Idempotency — once a question is submitted it stays submitted (spec:
    // "the question becomes inactive"). Return 409 so the client can render
    // the inactive state without pretending the second click succeeded.
    let submission = task.submissions.find(
      (s) => String(s.studentId) === studentId,
    );
    if (submission) {
      const already = (submission.questions || []).some(
        (id) => String(id) === String(questionId),
      );
      if (already) {
        return res
          .status(409)
          .json({ error: "This question has already been submitted." });
      }
    }

    const questionDoc = await Question.findById(questionId).lean();
    if (!questionDoc) {
      return res.status(404).json({ error: "Question record missing." });
    }

    // Per-question full marks default to task.maxMarks / total questions
    // when nothing question-specific is stored. Keeps marksAwarded in a
    // sensible band for the AI to fill.
    const totalQs = (task.questions || []).length || 1;
    const perQFull =
      questionDoc?.metadata?.marks || task.maxMarks / totalQs || 1;

    let student = null;
    try {
      student = await User.findById(studentId).select("name email").lean();
    } catch {
      student = null;
    }

    const feedback = await generateTestFeedback({
      teacherId: testDoc.teacherId,
      studentName: student?.name || "",
      question: {
        text: questionDoc.questionText,
        format: questionDoc.type,
        correctAnswer: questionDoc.correctAnswer,
        solution: questionDoc.solution,
      },
      studentAnswer: answer,
      fullMarks: perQFull,
    });

    // Compose feedback rollup on the submission doc. `feedback` is kept as a
    // human-readable running log so the class-report generator can slice on
    // it later without additional joins.
    if (!submission) {
      submission = {
        studentId,
        submittedAt: new Date(),
        isCompleted: false,
        questions: [],
        marks: 0,
        feedback: "",
        fullscreenExits: [],
      };
      task.submissions.push(submission);
      submission = task.submissions[task.submissions.length - 1];
    }
    submission.questions.push(questionId);
    submission.marks = Math.round(
      (Number(submission.marks) || 0) + feedback.marksAwarded,
    );
    const entry = [
      `Q${submission.questions.length}: marks=${feedback.marksAwarded}/${perQFull}`,
      `  correctBeforeStuck: ${feedback.correctBeforeStuck}`,
      `  stuckOn: ${feedback.stuckOn}`,
      `  practiceAdvice: ${feedback.practiceAdvice}`,
    ].join("\n");
    submission.feedback = submission.feedback
      ? `${submission.feedback}\n\n${entry}`
      : entry;
    submission.submittedAt = new Date();
    // Mark completed when the student has submitted every question in the
    // task. Downstream (class-report cron) can then treat this student as
    // "final".
    if (submission.questions.length >= (task.questions || []).length) {
      submission.isCompleted = true;
    }

    await testDoc.save();

    // Response is intentionally minimal — no feedback body, no marks. The
    // student only learns their result after the test expires and the
    // teacher/system releases the report.
    return res.json({ ok: true, questionId, submitted: true });
  } catch (err) {
    console.error("submitTestQuestion error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /api/test/fullscreen-exit
// Records a single fullscreen exit on the student's submission. Called by
// the video-app test page's `fullscreenchange` handler when the student
// leaves fullscreen (deliberately or accidentally). The teacher can see
// these entries on the individual report for integrity review.
export const logFullscreenExit = async (req, res) => {
  const { testId, taskId, returned } = req.body || {};
  const studentId = String(req.user?._id || req.body?.studentId || "");
  if (!testId || !taskId) {
    return res
      .status(400)
      .json({ error: "testId and taskId are required." });
  }
  if (!studentId) {
    return res.status(401).json({ error: "Student identity required." });
  }

  try {
    const testDoc = await Test.findById(testId);
    if (!testDoc) return res.status(404).json({ error: "Test not found." });
    const task = testDoc.tests.id(taskId);
    if (!task) return res.status(404).json({ error: "Test task not found." });

    let submission = task.submissions.find(
      (s) => String(s.studentId) === studentId,
    );
    if (!submission) {
      submission = {
        studentId,
        submittedAt: new Date(),
        isCompleted: false,
        questions: [],
        marks: 0,
        feedback: "",
        fullscreenExits: [],
      };
      task.submissions.push(submission);
      submission = task.submissions[task.submissions.length - 1];
    }

    if (returned) {
      // Late signal — patch the most recent open exit (returnedAt missing).
      const openIdx = [...submission.fullscreenExits]
        .reverse()
        .findIndex((e) => !e.returnedAt);
      if (openIdx !== -1) {
        const idx = submission.fullscreenExits.length - 1 - openIdx;
        submission.fullscreenExits[idx].returnedAt = new Date();
      }
    } else {
      submission.fullscreenExits.push({ exitedAt: new Date() });
    }

    await testDoc.save();
    return res.json({
      ok: true,
      exitCount: submission.fullscreenExits.length,
    });
  } catch (err) {
    console.error("logFullscreenExit error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/test/classroom/:classroomId
// List tests for a classroom. For every expired task without a classReport,
// fire ensureTestClassReport in the background so the report exists by the
// time the teacher opens it — but do NOT block the list response on it.
export const getTestsByClassroom = async (req, res) => {
  const { classroomId } = req.params;
  if (!classroomId) {
    return res.status(400).json({ error: "classroomId is required." });
  }
  try {
    // Kick off background report generation for expired tasks first so it
    // runs while the query below is executing.
    Test.find({ classroomId })
      .then((docs) => {
        docs.forEach((doc) => {
          (doc.tests || []).forEach((task) => {
            ensureTestClassReport(doc, task._id).catch((err) =>
              console.warn(
                `[TestClassReport] background gen failed for ${doc._id}:${task._id}`,
                err?.message || err,
              ),
            );
          });
        });
      })
      .catch(() => {});

    const tests = await Test.find({ classroomId })
      .sort({ createdAt: -1 })
      .populate({ path: "tests.questions" })
      .lean();
    return res.json({ ok: true, tests });
  } catch (err) {
    console.error("getTestsByClassroom error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// POST /api/test/:testId/:taskId/generate-report
// Manual trigger for the class report (also callable from a cron). Idempotent
// via ensureTestClassReport — a second call after the report exists returns
// the cached body without a fresh AI call.
export const triggerTestClassReport = async (req, res) => {
  const { testId, taskId } = req.params;
  if (!testId || !taskId) {
    return res.status(400).json({ error: "testId and taskId are required." });
  }
  try {
    const testDoc = await Test.findById(testId);
    if (!testDoc) return res.status(404).json({ error: "Test not found." });
    const task = testDoc.tests.id(taskId);
    if (!task) return res.status(404).json({ error: "Test task not found." });
    const now = Date.now();
    const expiredMs = task.expiredDate
      ? new Date(task.expiredDate).getTime()
      : 0;
    if (!expiredMs || now < expiredMs) {
      return res.status(409).json({
        error: "Test has not expired yet; class report is generated on expiry.",
        expiresAt: task.expiredDate,
      });
    }
    const report = await ensureTestClassReport(testDoc, taskId);
    return res.json({ ok: true, classReport: report });
  } catch (err) {
    console.error("triggerTestClassReport error:", err);
    return res.status(500).json({ error: err.message });
  }
};
