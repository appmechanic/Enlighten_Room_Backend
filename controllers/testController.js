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
import GradedTestAnswerModel from "../models/GradedTestAnswerModel.js";
import GradeSetting from "../models/GradeSetting.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/sendEmail.js";
import { focusAlertTemplate } from "../utils/focusAlertTemplate.js";

// Repeated fullscreen exits during a proctored test are a strong integrity
// signal. Fire a parent email once the student crosses this threshold; the
// same submission won't re-notify (guarded by parentAlertSentAt).
const FULLSCREEN_EXIT_ALERT_THRESHOLD = Number(
  process.env.FULLSCREEN_EXIT_ALERT_THRESHOLD || 3
);

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
    perFormatMarks = {},
    maxMarks: maxMarksOverride,
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

  // Normalize perFormatMarks — any format with count > 0 needs a positive
  // marks value. Formats the teacher skipped (count 0) are ignored.
  const marksByFormat = {};
  for (const [fmt, count] of Object.entries(perFormatCounts)) {
    const c = Number(count) || 0;
    if (c <= 0) continue;
    const m = Number(perFormatMarks?.[fmt]);
    if (!Number.isFinite(m) || m <= 0) {
      return res.status(400).json({
        error: `perFormatMarks.${fmt} must be a positive number when perFormatCounts.${fmt} > 0.`,
      });
    }
    marksByFormat[fmt] = m;
  }

  // Derive maxMarks from Σ(count × marks) unless the caller sent an explicit
  // override (kept for API back-compat).
  const derivedMaxMarks = Object.entries(perFormatCounts).reduce(
    (sum, [fmt, count]) =>
      sum + (Number(count) || 0) * (Number(marksByFormat[fmt]) || 0),
    0,
  );
  const maxMarks =
    Number.isFinite(Number(maxMarksOverride)) && Number(maxMarksOverride) > 0
      ? Number(maxMarksOverride)
      : derivedMaxMarks || 10;

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
        marks: marksByFormat[q.format],
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
      perFormatMarks: marksByFormat,
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

    // Per-question full marks: prefer the value stamped on the Question doc
    // (set by createTestWithAI from perFormatMarks). Then fall back to the
    // task's perFormatMarks map keyed by the question's format. Only then
    // divide task.maxMarks across all questions — that last branch is what
    // produced the 3.333… reports on legacy tests before per-format marks
    // were introduced.
    const totalQs = (task.questions || []).length || 1;
    const perFormatMarksMap = task.perFormatMarks || {};
    const perQFull =
      questionDoc?.metadata?.marks ||
      Number(perFormatMarksMap?.[questionDoc?.type]) ||
      task.maxMarks / totalQs ||
      1;

    let student = null;
    try {
      student = await User.findById(studentId).select("name email").lean();
    } catch {
      student = null;
    }

    // Empty submissions bypass the AI — same short-circuit as the Assignment
    // path. Without this Gemini has been rubber-stamping blank answers as
    // "correct" and awarding full marks.
    const answerText = Array.isArray(answer)
      ? answer.join(", ").trim()
      : String(answer ?? "").trim();
    let feedback;
    if (answerText === "") {
      feedback = {
        marksAwarded: 0,
        correctBeforeStuck: "",
        stuckOn: "No answer provided",
        practiceAdvice: "No answer submitted.",
      };
    } else {
      feedback = await generateTestFeedback({
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
    }

    // Compose the feedback log line once — used by every retry attempt.
    // The `Q${n}:` prefix is populated from the fresh submission state on
    // each attempt, so we build the tail here and prepend the counter
    // inside the retry loop.
    const feedbackTail = [
      `  correctBeforeStuck: ${feedback.correctBeforeStuck}`,
      `  stuckOn: ${feedback.stuckOn}`,
      `  practiceAdvice: ${feedback.practiceAdvice}`,
    ].join("\n");
    const marksToAdd = Number(feedback.marksAwarded) || 0;

    // Retry loop: `testDoc.save()` uses Mongoose optimistic concurrency
    // (`__v` filter), and Gemini's ~10s round-trip means two rapid
    // submissions from the same student — or from different students on
    // the same test — both read version N, both mutate in memory, and the
    // second save fails with a VersionError because the first bumped the
    // doc to N+1. Symptom seen in prod:
    //   No matching document found for id "…" version 1
    //   modifiedPaths "tests, tests.0, tests.0.submissions, …"
    // Reload + reapply the mutation on each attempt. The AI call above is
    // NOT retried — we only replay the cheap DB mutation.
    let justCompleted = false;
    const MAX_ATTEMPTS = 5;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        // First pass reuses the doc/task/submission we already loaded so
        // the fast path pays no re-fetch cost. Subsequent attempts refetch
        // because the stale doc's `__v` is what caused the conflict.
        if (attempt > 1) {
          const fresh = await Test.findById(testId);
          if (!fresh) return res.status(404).json({ error: "Test not found." });
          const freshTask = fresh.tests.id(taskId);
          if (!freshTask)
            return res.status(404).json({ error: "Test task not found." });
          testDoc = fresh;
          task = freshTask;
          submission = task.submissions.find(
            (s) => String(s.studentId) === studentId,
          );
          // A parallel handler may have raced this exact questionId in
          // between attempts. Return 409 so the client renders the
          // inactive state instead of retrying forever.
          if (
            submission &&
            (submission.questions || []).some(
              (id) => String(id) === String(questionId),
            )
          ) {
            return res
              .status(409)
              .json({ error: "This question has already been submitted." });
          }
        }

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
          (Number(submission.marks) || 0) + marksToAdd,
        );
        const entry = [
          `Q${submission.questions.length}: marks=${marksToAdd}/${perQFull}`,
          feedbackTail,
        ].join("\n");
        submission.feedback = submission.feedback
          ? `${submission.feedback}\n\n${entry}`
          : entry;
        submission.submittedAt = new Date();
        justCompleted =
          submission.questions.length >= (task.questions || []).length &&
          !submission.isCompleted;
        if (justCompleted) {
          submission.isCompleted = true;
          submission.completedAt = new Date();
        }

        await testDoc.save();
        break;
      } catch (saveErr) {
        const isVersionError =
          saveErr?.name === "VersionError" ||
          /No matching document found for id/i.test(saveErr?.message || "");
        if (!isVersionError || attempt >= MAX_ATTEMPTS) throw saveErr;
        // Short exponential-ish backoff so parallel submits don't
        // thundering-herd the same version.
        await new Promise((r) => setTimeout(r, 40 * attempt));
      }
    }

    // Persist a per-question grade row so the student panel + details page
    // can render score cards without parsing the human-readable feedback
    // log. Uses the same shape as GradedAnswerModel to keep the UI mirrors
    // simple. `upsert` because the submission is built one question at a
    // time and this handler runs per-question.
    try {
      const submittedAnswerArray = Array.isArray(answer)
        ? answer.map((s) => String(s ?? "").trim())
        : answerText
        ? [answerText]
        : [];
      const correctAnswerArray = Array.isArray(questionDoc.correctAnswer)
        ? questionDoc.correctAnswer.map((s) => String(s ?? "").trim())
        : [];
      const marksAwarded = Number(feedback.marksAwarded) || 0;
      await GradedTestAnswerModel.updateOne(
        { studentId, taskId: task._id },
        {
          $setOnInsert: {
            studentId,
            testId: testDoc._id,
            taskId: task._id,
            sessionId: testDoc.sessionId,
            classroomId: testDoc.classroomId,
            teacherId: testDoc.teacherId,
            gradedBy: "AI",
          },
          $push: {
            gradedAnswers: {
              questionId,
              submittedAnswer: submittedAnswerArray,
              correctAnswer: correctAnswerArray,
              isCorrect: marksAwarded >= perQFull,
              score: marksAwarded,
              maxScore: perQFull,
              feedback: [
                answerText === "" ? "No answer submitted." : "",
                feedback.practiceAdvice || "",
              ]
                .filter(Boolean)
                .join(" ")
                .trim(),
            },
          },
        },
        { upsert: true },
      );

      // On the last question flip status + fill in aggregate stats. Load
      // the whole doc so the aggregate calculation works off the fresh
      // gradedAnswers array (updateOne pushes are not observable in
      // memory).
      if (justCompleted) {
        const graded = await GradedTestAnswerModel.findOne({
          studentId,
          taskId: task._id,
        });
        if (graded) {
          const totalQuestions = graded.gradedAnswers.length;
          const correctCount = graded.gradedAnswers.filter(
            (a) => a.isCorrect,
          ).length;
          const totalScore = graded.gradedAnswers.reduce(
            (s, a) => s + (Number(a.score) || 0),
            0,
          );
          const maxScore = graded.gradedAnswers.reduce(
            (s, a) => s + (Number(a.maxScore) || 0),
            0,
          );
          const percentage =
            maxScore > 0
              ? parseFloat(((totalScore / maxScore) * 100).toFixed(2))
              : 0;
          let grade = "Grades not defined";
          try {
            const setting = await GradeSetting.findOne({
              teacherId: testDoc.teacherId,
            });
            if (setting && Array.isArray(setting.grades)) {
              const match = setting.grades.find(
                (g) =>
                  percentage >= g.minPercent && percentage <= g.maxPercent,
              );
              if (match) grade = match.letter;
            }
          } catch {
            /* grade defaults handled above */
          }
          graded.totalQuestions = totalQuestions;
          graded.correctCount = correctCount;
          graded.incorrectCount = totalQuestions - correctCount;
          graded.percentage = String(percentage);
          graded.grade = grade;
          await graded.save();
        }

        // Flip the sub-task status the same way the Assignment path does
        // so the student panel can render "graded" instead of stuck-at-
        // "pending" once the last question lands.
        await Test.updateOne(
          { "tests._id": task._id },
          { $set: { "tests.$.testStatus": "graded" } },
        );
      }
    } catch (gradeErr) {
      console.error("submitTestQuestion: grade persist failed:", gradeErr);
      // Do not fail the submission — the human-readable feedback log on
      // TestSubmissionSchema is still populated and downstream reports work.
    }

    // Test-completion emails: fire once, at the moment the student finishes
    // every question. Sends to the student and (when present) the parent so
    // both have a record of the attempt. Fire-and-forget — student sees the
    // 200 immediately, mail runs in the background.
    if (justCompleted) {
      (async () => {
        try {
          const student = await User.findById(studentId)
            .populate("parentId", "email firstName lastName")
            .select("firstName lastName email parentId")
            .lean();
          if (!student) return;
          const studentName = `${student.firstName || ""} ${
            student.lastName || ""
          }`.trim() || "Student";
          const testTitle = testDoc.title || task?.title || "Test";
          const questionCount = (task.questions || []).length;
          const recipients = [
            student.email,
            student.parentId?.email,
          ].filter(Boolean);
          if (!recipients.length) return;
          const html = `
            <h3>Test completed</h3>
            <p>Hi,</p>
            <p><strong>${studentName}</strong> has finished the test
              "<strong>${testTitle}</strong>" (${questionCount} question${
              questionCount === 1 ? "" : "s"
            }).</p>
            <p>Detailed feedback will be available once the test window
              closes and the teacher releases the report.</p>
            <p>— Enlighten Room</p>
          `;
          for (const to of recipients) {
            await sendEmail({
              to,
              subject: `Test completed: ${testTitle}`,
              html,
            });
          }
        } catch (mailErr) {
          console.error(
            "Test-completion email failed:",
            mailErr.message
          );
        }
      })();
    }

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

    // Threshold-based parent alert. Fire once per submission — the
    // `parentAlertSentAt` guard prevents spamming a parent on every
    // subsequent exit for the same test. Kept fire-and-forget so a slow
    // SMTP hop doesn't stretch the student-facing request.
    const exitCount = submission.fullscreenExits.length;
    if (
      !returned &&
      exitCount >= FULLSCREEN_EXIT_ALERT_THRESHOLD &&
      !submission.parentAlertSentAt
    ) {
      submission.parentAlertSentAt = new Date();
      await testDoc.save();
      // Look up student + parent emails outside the critical path.
      (async () => {
        try {
          const student = await User.findById(studentId)
            .populate("parentId", "email firstName lastName")
            .select("firstName lastName parentId")
            .lean();
          const parentEmail = student?.parentId?.email;
          if (!parentEmail) return;
          const studentName = `${student.firstName || ""} ${
            student.lastName || ""
          }`.trim() || "Your student";
          const html = focusAlertTemplate({
            studentName,
            className: testDoc.title || "the test",
            occurredAt: Date.now(),
            reason: "repeated_fullscreen_exit",
            details: `The student left fullscreen ${exitCount} times during a proctored test.`,
          });
          await sendEmail({
            to: parentEmail,
            subject: `Focus Alert: ${studentName} left fullscreen during a test`,
            html,
          });
        } catch (mailErr) {
          console.error(
            "Fullscreen parent alert email failed:",
            mailErr.message
          );
        }
      })();
    }

    return res.json({
      ok: true,
      exitCount,
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

// GET /api/test/student/:studentId/classroom/:classroomId
// Mirrors getStudentAssignmentsByClassroom — returns every Test task the
// student is assigned to in this classroom, with score/grade/submittedAt
// attached from GradedTestAnswerModel. Correct answers are stripped from
// the questions (spec: students never see the answer while the test is
// live).
export const getStudentTestsByClassroom = async (req, res) => {
  const { studentId, classroomId } = req.params;
  if (!studentId || !classroomId) {
    return res.status(400).json({
      error: "Both studentId and classroomId are required",
    });
  }
  try {
    const tests = await Test.find({
      classroomId,
      "tests.studentIds": studentId,
    })
      .populate("classroomId")
      .populate("sessionId")
      .populate("teacherId", "firstName lastName email")
      .populate("tests.questions");

    if (!tests || tests.length === 0) {
      return res.status(200).json({
        message: `No tests found for student in this classroom`,
        count: 0,
        assignments: [],
      });
    }

    const allTaskIds = tests.flatMap((doc) =>
      doc.tests.map((t) => t._id),
    );
    const gradedDocs = await GradedTestAnswerModel.find({
      studentId,
      taskId: { $in: allTaskIds },
    })
      .select(
        "taskId percentage grade totalQuestions correctCount incorrectCount overall_remarks createdAt",
      )
      .lean();
    const gradedByTaskId = new Map(
      gradedDocs.map((g) => [String(g.taskId), g]),
    );

    const studentTests = [];
    tests.forEach((testDoc) => {
      const {
        classroomId: cls,
        sessionId,
        teacherId,
        _id: parentTestId,
      } = testDoc;
      testDoc.tests.forEach((task) => {
        if (
          !task.studentIds.some((id) => id.toString() === studentId)
        )
          return;
        const graded = gradedByTaskId.get(String(task._id));
        // Strip correctAnswer/solution from questions on the pre-submit
        // path — students shouldn't be able to sniff the answer via
        // devtools while the test is live. Once graded we surface them
        // through getStudentTestGradeDetails instead.
        const strippedQuestions = (task.questions || []).map((q) => {
          const qObj = q.toObject ? q.toObject() : q;
          if (graded) return qObj;
          const { correctAnswer, solution, ...safe } = qObj;
          return safe;
        });
        studentTests.push({
          testId: parentTestId,
          taskId: task._id,
          testStatus: task.testStatus,
          title: task.title,
          description: task.description,
          startDate: task.startDate,
          expiredDate: task.expiredDate,
          duration: task.duration,
          resources: task.resources,
          maxMarks: task.maxMarks,
          questions: strippedQuestions,
          classroomId: cls,
          sessionId,
          teacher: teacherId,
          score: graded?.percentage ?? undefined,
          grade: graded?.grade ?? undefined,
          correctCount: graded?.correctCount ?? undefined,
          totalQuestions: graded?.totalQuestions ?? undefined,
          submittedAt: graded?.createdAt ?? undefined,
        });
      });
    });

    return res.status(200).json({
      message: `Tests for student ${studentId} in classroom ${classroomId}`,
      count: studentTests.length,
      assignments: studentTests,
    });
  } catch (err) {
    console.error("getStudentTestsByClassroom error:", err);
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/test/student-grade/:taskId
// Per-task graded detail — mirrors the report used by
// StudentAssignmentDetails.jsx. Returns the GradedTestAnswer for the
// current student plus enough parent metadata (title, dueDate, session,
// classroom, teacher) to render the page header.
export const getStudentTestGradeDetails = async (req, res) => {
  const { taskId } = req.params;
  const studentId = String(req.user?._id || req.query?.studentId || "");
  if (!taskId) return res.status(400).json({ error: "taskId is required." });
  if (!studentId)
    return res.status(401).json({ error: "Student identity required." });

  try {
    const graded = await GradedTestAnswerModel.findOne({
      studentId,
      taskId,
    })
      .populate({
        path: "gradedAnswers.questionId",
        select:
          "questionText type options correctAnswer solution course topic",
      })
      .populate("classroomId")
      .populate("sessionId", "_id topic sessionDate notes sessionUrl")
      .populate("studentId", "_id firstName lastName email")
      .populate("teacherId", "_id firstName lastName email")
      .lean();

    if (!graded) {
      return res.status(404).json({
        error: "No graded submission found for this test task yet.",
      });
    }

    const testDoc = await Test.findById(graded.testId)
      .select("tests._id tests.title tests.description tests.expiredDate tests.duration tests.resources tests.maxMarks tests.testStatus")
      .lean();
    const task = testDoc?.tests?.find(
      (t) => String(t._id) === String(taskId),
    );

    return res.status(200).json({
      data: [
        {
          ...graded,
          testId: {
            _id: graded.testId,
            tests: task ? [task] : [],
          },
        },
      ],
    });
  } catch (err) {
    console.error("getStudentTestGradeDetails error:", err);
    return res.status(500).json({ error: err.message });
  }
};
