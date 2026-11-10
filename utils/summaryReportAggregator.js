// Date-Range Summary Report aggregator (Task 3).
//
// Pure read functions over existing models — never writes. Feeds the Gemini
// summary generators with pre-condensed fragments from the AI reports that
// already live in Mongo, so the summary calls stay cheap (a few hundred
// tokens of structured input instead of raw submissions).
//
// Shape contracts are declared at the top of each export so the controller
// / Gemini util can lean on them without reading the implementation.

import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";
import ClassworkModel from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";
import Assignment from "../models/AssignmentModel.js";
import AssignmentAiReport from "../models/AssignmentAiReportModel.js";
import Test from "../models/TestModel.js";
import GradedTestAnswer from "../models/GradedTestAnswerModel.js";
import Session from "../models/SessionModel.js";

// ---------------------------------------------------------------------------
// Candidate listing — drives the picker UI
// ---------------------------------------------------------------------------

/**
 * Lists every classwork lesson / assignment task / test task for a classroom
 * whose primary date falls inside the window. Each returned entry carries an
 * `isSelectable` flag so the React picker can grey-out active lessons and
 * unexpired assignments/tests without a second request.
 *
 * Date-filter rules (per spec, confirmed by Francis):
 *   - Classwork (Lesson): filter by Lesson.startedAt
 *   - Assignment / Test tasks: filter by sub-task.createdAt
 *
 * Returns:
 *   {
 *     classwork:   [{ id, name, date, isSelectable, reason }],
 *     assignments: [{ id, title, date, dueDate, isSelectable, reason }],
 *     tests:       [{ id, title, date, expiredDate, isSelectable, reason }]
 *   }
 */
export async function listSummaryCandidates({ classroomId, dateRange }) {
  const { start, end } = normalizeRange(dateRange);
  const classroomObjectId = toObjectId(classroomId);

  const [lessons, assignments, tests] = await Promise.all([
    Lesson.find({
      classroomId: classroomObjectId,
      startedAt: { $gte: start, $lte: end },
    })
      .select("_id name startedAt endedAt status roomId")
      .sort({ startedAt: -1 })
      .lean(),
    Assignment.find({ classroomId: classroomObjectId })
      .select("assignments._id assignments.title assignments.createdAt assignments.dueDate")
      .lean(),
    Test.find({ classroomId: classroomObjectId })
      .select("tests._id tests.title tests.createdAt tests.expiredDate")
      .lean(),
  ]);

  const now = new Date();

  const classwork = lessons.map((l) => {
    const active = !l.endedAt; // Lesson.endedAt is set when the teacher ends the live session.
    return {
      id: String(l._id),
      name: l.name,
      date: l.startedAt,
      isSelectable: !active,
      reason: active ? "Lesson still active" : "",
    };
  });

  const assignmentTasks = [];
  for (const doc of assignments) {
    for (const task of doc.assignments || []) {
      if (!task.createdAt || task.createdAt < start || task.createdAt > end) continue;
      const expired = task.dueDate && task.dueDate < now;
      assignmentTasks.push({
        id: String(task._id),
        title: task.title,
        date: task.createdAt,
        dueDate: task.dueDate,
        isSelectable: !!expired,
        reason: expired ? "" : "Assignment not yet due",
      });
    }
  }

  const testTasks = [];
  for (const doc of tests) {
    for (const task of doc.tests || []) {
      if (!task.createdAt || task.createdAt < start || task.createdAt > end) continue;
      const expired = task.expiredDate && task.expiredDate < now;
      testTasks.push({
        id: String(task._id),
        title: task.title,
        date: task.createdAt,
        expiredDate: task.expiredDate,
        isSelectable: !!expired,
        reason: expired ? "" : "Test not yet expired",
      });
    }
  }

  // Newest first across the board — matches the Session Report page's
  // existing default ordering so teachers aren't visually jolted.
  assignmentTasks.sort((a, b) => (b.date || 0) - (a.date || 0));
  testTasks.sort((a, b) => (b.date || 0) - (a.date || 0));

  return { classwork, assignments: assignmentTasks, tests: testTasks };
}

// ---------------------------------------------------------------------------
// Class summary — class-wide aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregates the pre-generated "studentDifficulties" fragments across the
 * selected items for the Class Summary prompt. Excludes nextLessonStrategy
 * and targetedHomework per spec.
 *
 * Returns:
 *   {
 *     classwork:   [{ lessonName, date, studentDifficulties: [...] }],
 *     assignments: [{ title, createdAt, studentDifficulties: [...] }],
 *     tests:       [{ title, createdAt, summary, topDifficulties: [...] }]
 *   }
 *
 * Items whose underlying class report hasn't been generated yet are omitted
 * (not errors) — the teacher sees the summary synthesise only what exists.
 */
export async function aggregateClassSummaryInputs({ classroomId, selectedItems }) {
  const { lessonIds, assignmentTaskIds, testTaskIds } = normalizeSelected(selectedItems);

  const lessonFragment = lessonIds.length
    ? await aggregateClasswork(lessonIds)
    : [];
  const assignmentFragment = assignmentTaskIds.length
    ? await aggregateAssignmentsClass(classroomId, assignmentTaskIds)
    : [];
  const testFragment = testTaskIds.length
    ? await aggregateTestsClass(classroomId, testTaskIds)
    : [];

  return {
    classwork: lessonFragment,
    assignments: assignmentFragment,
    tests: testFragment,
  };
}

async function aggregateClasswork(lessonIds) {
  const lessons = await Lesson.find({ _id: { $in: lessonIds } })
    .select("_id name startedAt classReport")
    .lean();
  return lessons
    .filter((l) => Array.isArray(l.classReport?.studentDifficulties) && l.classReport.studentDifficulties.length > 0)
    .map((l) => ({
      lessonName: l.name,
      date: l.startedAt,
      studentDifficulties: l.classReport.studentDifficulties.map((d) => ({
        difficulty: d.difficulty || "",
        affectedStudents: Array.isArray(d.affectedStudents) ? d.affectedStudents : [],
      })),
    }));
}

async function aggregateAssignmentsClass(classroomId, assignmentTaskIds) {
  const docs = await Assignment.find({
    classroomId: toObjectId(classroomId),
    "assignments._id": { $in: assignmentTaskIds },
  })
    .select("assignments")
    .lean();

  const selectedSet = new Set(assignmentTaskIds.map((id) => String(id)));
  const out = [];
  for (const doc of docs) {
    for (const task of doc.assignments || []) {
      if (!selectedSet.has(String(task._id))) continue;
      const difficulties = task.classReport?.studentDifficulties || [];
      if (!Array.isArray(difficulties) || difficulties.length === 0) continue;
      out.push({
        title: task.title,
        createdAt: task.createdAt,
        studentDifficulties: difficulties.map((d) => ({
          difficulty: d.difficulty || "",
          affectedStudents: Array.isArray(d.affectedStudents) ? d.affectedStudents : [],
        })),
      });
    }
  }
  return out;
}

async function aggregateTestsClass(classroomId, testTaskIds) {
  const docs = await Test.find({
    classroomId: toObjectId(classroomId),
    "tests._id": { $in: testTaskIds },
  })
    .select("tests")
    .lean();

  const selectedSet = new Set(testTaskIds.map((id) => String(id)));
  const out = [];
  for (const doc of docs) {
    for (const task of doc.tests || []) {
      if (!selectedSet.has(String(task._id))) continue;
      const body = task.classReport?.body;
      if (!body || typeof body !== "object") continue;
      const summary = typeof body.summary === "string" ? body.summary : "";
      const topDifficulties = Array.isArray(body.topDifficulties) ? body.topDifficulties : [];
      if (!summary && topDifficulties.length === 0) continue;
      out.push({
        title: task.title,
        createdAt: task.createdAt,
        summary,
        topDifficulties,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Student individual summary — per-student aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregates per-attempt diagnostic slices for ONE student. By spec:
 *   - Classwork & Assignments: part2[0] from EVERY attempt (the misconception
 *     line — now admin-editable, extracted by index not label), plus
 *     part1 / part2 / part3 from the LAST attempt only.
 *   - Tests: per-question feedback for every question in the task.
 *
 * Every item includes the question text (context anchor) + a boolean for
 * whether the student's final attempt was correct.
 *
 * Returns:
 *   {
 *     classwork:   [{ lessonName, date, questions: [{ questionText, finalCorrect,
 *                     misconceptionAttempts: [...], last: { part1, part2, part3 } }] }],
 *     assignments: [{ title, createdAt, questions: [...] }],       // same shape as classwork
 *     tests:       [{ title, createdAt, questions: [{ questionText, finalCorrect, feedback }] }]
 *   }
 *
 * Returns null if the student has zero recorded interactions across every
 * selected item — the caller can then skip the Gemini call for this student
 * and mark the perStudent entry status="skipped".
 */
export async function aggregateStudentSummaryInputs({ classroomId, selectedItems, studentId }) {
  const { lessonIds, assignmentTaskIds, testTaskIds } = normalizeSelected(selectedItems);
  const studentIdStr = String(studentId);
  const studentObjectId = toObjectId(studentId);

  const [classwork, assignments, tests] = await Promise.all([
    lessonIds.length ? aggregateStudentClasswork(lessonIds, studentIdStr) : [],
    assignmentTaskIds.length ? aggregateStudentAssignments(assignmentTaskIds, studentObjectId) : [],
    testTaskIds.length ? aggregateStudentTests(classroomId, testTaskIds, studentObjectId) : [],
  ]);

  const nothing =
    classwork.length === 0 && assignments.length === 0 && tests.length === 0;
  if (nothing) return null;

  return { classwork, assignments, tests };
}

async function aggregateStudentClasswork(lessonIds, studentIdStr) {
  // ClassworkAiReport is keyed by (roomId, questionId=short id, studentId=string).
  // So we first resolve each lesson to its (roomId, name) pair, then find the
  // matching Classwork questions, then load this student's AI reports for
  // those (roomId, question.id) pairs.
  const lessons = await Lesson.find({ _id: { $in: lessonIds } })
    .select("_id name roomId startedAt")
    .lean();
  if (lessons.length === 0) return [];

  // Pull every question for the (roomId, lessonName) pairs in one query.
  const roomNamePairs = lessons.map((l) => ({ roomId: l.roomId, lessonName: l.name }));
  const questions = await ClassworkModel.find({
    $or: roomNamePairs.map((p) => ({ roomId: p.roomId, lessonName: p.lessonName })),
  })
    .select("_id id roomId lessonName question")
    .lean();

  if (questions.length === 0) return [];

  // Load every AI report for this student for those (roomId, question.id) pairs
  // in one query to avoid N+1 on large lessons.
  const aiReports = await ClassworkAiReport.find({
    studentId: studentIdStr,
    $or: questions.map((q) => ({ roomId: q.roomId, questionId: q.id })),
  })
    .select("roomId questionId interactions")
    .lean();

  const reportKey = (roomId, questionId) => `${roomId}::${questionId}`;
  const reportByKey = new Map();
  for (const r of aiReports) reportByKey.set(reportKey(r.roomId, r.questionId), r);

  const questionsByLesson = new Map();
  for (const q of questions) {
    const lessonKey = `${q.roomId}::${q.lessonName}`;
    if (!questionsByLesson.has(lessonKey)) questionsByLesson.set(lessonKey, []);
    questionsByLesson.get(lessonKey).push(q);
  }

  const out = [];
  for (const lesson of lessons) {
    const lessonKey = `${lesson.roomId}::${lesson.name}`;
    const lessonQuestions = questionsByLesson.get(lessonKey) || [];
    const perQuestion = [];
    for (const q of lessonQuestions) {
      const report = reportByKey.get(reportKey(q.roomId, q.id));
      if (!report || !Array.isArray(report.interactions) || report.interactions.length === 0) continue;
      perQuestion.push(buildPerQuestionSlice(q.question, report.interactions));
    }
    if (perQuestion.length === 0) continue;
    out.push({
      lessonName: lesson.name,
      date: lesson.startedAt,
      questions: perQuestion,
    });
  }
  return out;
}

async function aggregateStudentAssignments(assignmentTaskIds, studentObjectId) {
  // AssignmentAiReport is keyed by (subAssignmentId, questionId, studentId).
  // No need to go via Assignment doc — we can query the AI reports directly
  // then group by subAssignmentId.
  const reports = await AssignmentAiReport.find({
    subAssignmentId: { $in: assignmentTaskIds },
    studentId: studentObjectId,
  })
    .select("subAssignmentId originalQuestion interactions")
    .lean();
  if (reports.length === 0) return [];

  // Pull task metadata (title, createdAt) for the sub-ids that returned reports.
  const subIds = [...new Set(reports.map((r) => String(r.subAssignmentId)))];
  const assignmentDocs = await Assignment.find({
    "assignments._id": { $in: subIds.map((id) => toObjectId(id)) },
  })
    .select("assignments")
    .lean();

  const taskMeta = new Map();
  for (const doc of assignmentDocs) {
    for (const task of doc.assignments || []) {
      if (subIds.includes(String(task._id))) {
        taskMeta.set(String(task._id), { title: task.title, createdAt: task.createdAt });
      }
    }
  }

  const reportsByTask = new Map();
  for (const r of reports) {
    const key = String(r.subAssignmentId);
    if (!reportsByTask.has(key)) reportsByTask.set(key, []);
    reportsByTask.get(key).push(r);
  }

  const out = [];
  for (const [subId, taskReports] of reportsByTask) {
    const meta = taskMeta.get(subId);
    if (!meta) continue;
    const perQuestion = taskReports
      .filter((r) => Array.isArray(r.interactions) && r.interactions.length > 0)
      .map((r) => buildPerQuestionSlice(r.originalQuestion, r.interactions));
    if (perQuestion.length === 0) continue;
    out.push({
      title: meta.title,
      createdAt: meta.createdAt,
      questions: perQuestion,
    });
  }
  return out;
}

async function aggregateStudentTests(classroomId, testTaskIds, studentObjectId) {
  const graded = await GradedTestAnswer.find({
    classroomId: toObjectId(classroomId),
    taskId: { $in: testTaskIds },
    studentId: studentObjectId,
  })
    .select("taskId gradedAnswers")
    .populate({ path: "gradedAnswers.questionId", select: "question questionText" })
    .lean();
  if (graded.length === 0) return [];

  // Pull task metadata for titles.
  const testDocs = await Test.find({
    classroomId: toObjectId(classroomId),
    "tests._id": { $in: testTaskIds },
  })
    .select("tests")
    .lean();
  const taskMeta = new Map();
  for (const doc of testDocs) {
    for (const task of doc.tests || []) {
      taskMeta.set(String(task._id), { title: task.title, createdAt: task.createdAt });
    }
  }

  const out = [];
  for (const g of graded) {
    const meta = taskMeta.get(String(g.taskId));
    if (!meta) continue;
    const questions = (g.gradedAnswers || [])
      .filter((a) => a.feedback && a.feedback.trim())
      .map((a) => ({
        questionText: a.questionId?.question || a.questionId?.questionText || "",
        finalCorrect: !!a.isCorrect,
        feedback: a.feedback.trim(),
      }));
    if (questions.length === 0) continue;
    out.push({ title: meta.title, createdAt: meta.createdAt, questions });
  }
  return out;
}

function buildPerQuestionSlice(questionText, interactions) {
  // part2[0] from EVERY attempt = the misconception line (admin-editable;
  // first element by index, never matched on "DON'T:" text — that way this
  // keeps working when the admin edits the prompt shape).
  const misconceptionAttempts = interactions
    .map((it, index) => {
      const line = Array.isArray(it.part2) ? it.part2[0] : null;
      if (!line || typeof line !== "string" || !line.trim()) return null;
      return { attempt: index + 1, misconception: line.trim(), correct: !!it.correct };
    })
    .filter(Boolean);

  // part1 / part2 / part3 from the LAST attempt only.
  const last = interactions[interactions.length - 1] || {};

  return {
    questionText: questionText || "",
    finalCorrect: !!last.correct,
    misconceptionAttempts,
    last: {
      part1: Array.isArray(last.part1) ? last.part1 : [],
      part2: Array.isArray(last.part2) ? last.part2 : [],
      part3: Array.isArray(last.part3) ? last.part3 : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Instruction language resolution
// ---------------------------------------------------------------------------

/**
 * Per spec: "Summaries automatically adapt to the instruction language of
 * the most recent session within the selected date range."
 *
 * Resolution order:
 *   1. Most recent selected Lesson → Lesson.sessionId → Session.instructionLanguage
 *   2. If no lessons selected, most recent Assignment / Test sub-task's parent
 *      Session via .sessionId
 *   3. "English" fallback (same default resolveInstructionLanguage uses)
 */
export async function resolveInstructionLanguageForSelection({ classroomId, selectedItems }) {
  const { lessonIds, assignmentTaskIds, testTaskIds } = normalizeSelected(selectedItems);

  if (lessonIds.length > 0) {
    const newest = await Lesson.findOne({ _id: { $in: lessonIds } })
      .sort({ startedAt: -1 })
      .select("sessionId")
      .lean();
    if (newest?.sessionId) {
      const lang = await languageFor(newest.sessionId);
      if (lang) return lang;
    }
  }

  // Fall back to the parent Session of the newest assignment/test task.
  // Both docs carry sessionId at the top level; their sub-tasks don't.
  if (assignmentTaskIds.length > 0) {
    const doc = await Assignment.findOne({
      classroomId: toObjectId(classroomId),
      "assignments._id": { $in: assignmentTaskIds },
    })
      .sort({ updatedAt: -1 })
      .select("sessionId")
      .lean();
    if (doc?.sessionId) {
      const lang = await languageFor(doc.sessionId);
      if (lang) return lang;
    }
  }
  if (testTaskIds.length > 0) {
    const doc = await Test.findOne({
      classroomId: toObjectId(classroomId),
      "tests._id": { $in: testTaskIds },
    })
      .sort({ updatedAt: -1 })
      .select("sessionId")
      .lean();
    if (doc?.sessionId) {
      const lang = await languageFor(doc.sessionId);
      if (lang) return lang;
    }
  }

  return "English";
}

async function languageFor(sessionId) {
  if (!sessionId) return null;
  const s = await Session.findById(sessionId).select("instructionLanguage").lean();
  return s?.instructionLanguage || null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toObjectId(id) {
  if (!id) return id;
  return id instanceof mongoose.Types.ObjectId
    ? id
    : new mongoose.Types.ObjectId(String(id));
}

function normalizeRange(range) {
  const start = range?.start ? new Date(range.start) : new Date(0);
  const end = range?.end ? new Date(range.end) : new Date();
  return { start, end };
}

function normalizeSelected(selectedItems) {
  const si = selectedItems || {};
  return {
    lessonIds: Array.isArray(si.lessonIds) ? si.lessonIds.map(toObjectId) : [],
    assignmentTaskIds: Array.isArray(si.assignmentTaskIds)
      ? si.assignmentTaskIds.map(toObjectId)
      : [],
    testTaskIds: Array.isArray(si.testTaskIds) ? si.testTaskIds.map(toObjectId) : [],
  };
}
