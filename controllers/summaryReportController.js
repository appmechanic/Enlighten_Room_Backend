import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import crypto from "crypto";

import SummaryReport from "../models/SummaryReportModel.js";
import ReportAccessToken from "../models/ReportAccessTokenModel.js";
import Classroom from "../models/classroomModel.js";
import User from "../models/user.js";
import LessonReportSent from "../models/LessonReportSentModel.js";

import {
  listSummaryCandidates,
  aggregateClassSummaryInputs,
  aggregateStudentSummaryInputs,
  resolveInstructionLanguageForSelection,
} from "../utils/summaryReportAggregator.js";
import {
  generateClassSummary,
  generateStudentSummary,
  hashPromptBundle,
} from "../utils/geminiSummaryReport.js";
import {
  buildSummaryCacheKey,
  findCachedSummary,
} from "../utils/summaryReportCache.js";
import {
  assertUsageBudget,
  LimitReachedError,
  limitReachedResponseBody,
} from "../middleware/requireUsageBudget.js";

import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";

// Reuse Task 2's nodemailer transporter so we don't open two gmail
// connections per process.
import { getTransporter } from "./tokenizedReportController.js";
import { buildStudentSummaryEmail } from "../utils/emailTemplates/studentSummaryEmail.js";

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function buildSummaryViewUrl(token) {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return `${base}/reports/summary/${token}`;
}

// ---------------------------------------------------------------------------
// Prompt bundle loaders (used for cache-hash check BEFORE the Gemini call,
// so a cache hit avoids Gemini entirely)
// ---------------------------------------------------------------------------

async function loadClassPromptHash(teacherId) {
  const [doc, cfg] = await Promise.all([
    StandardPrompt.findOne({ key: "global" }).select("classSummaryPrompt").lean(),
    teacherId
      ? TeacherAIConfig.findOne({ user: teacherId }).select("reportPrompt").lean()
      : null,
  ]);
  return hashPromptBundle([
    (doc?.classSummaryPrompt || "").trim(),
    (cfg?.reportPrompt || "").trim(),
  ]);
}

async function loadStudentPromptHash(teacherId) {
  const [doc, cfg] = await Promise.all([
    StandardPrompt.findOne({ key: "global" }).select("studentSummaryPrompt").lean(),
    teacherId
      ? TeacherAIConfig.findOne({ user: teacherId }).select("reportPrompt").lean()
      : null,
  ]);
  return hashPromptBundle([
    (doc?.studentSummaryPrompt || "").trim(),
    (cfg?.reportPrompt || "").trim(),
  ]);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateDateRange(dateRange) {
  if (!dateRange || !dateRange.start || !dateRange.end) return "dateRange {start,end} required";
  const s = new Date(dateRange.start);
  const e = new Date(dateRange.end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return "dateRange values must be parseable dates";
  if (s > e) return "dateRange.start must be <= dateRange.end";
  return null;
}

function validateSelected(selectedItems) {
  const si = selectedItems || {};
  const totalCount =
    (Array.isArray(si.lessonIds) ? si.lessonIds.length : 0) +
    (Array.isArray(si.assignmentTaskIds) ? si.assignmentTaskIds.length : 0) +
    (Array.isArray(si.testTaskIds) ? si.testTaskIds.length : 0);
  if (totalCount === 0) return "selectedItems must include at least one of lessonIds / assignmentTaskIds / testTaskIds";
  return null;
}

function normalizeSelected(selectedItems) {
  const si = selectedItems || {};
  return {
    lessonIds: Array.isArray(si.lessonIds) ? si.lessonIds.filter(Boolean) : [],
    assignmentTaskIds: Array.isArray(si.assignmentTaskIds)
      ? si.assignmentTaskIds.filter(Boolean)
      : [],
    testTaskIds: Array.isArray(si.testTaskIds) ? si.testTaskIds.filter(Boolean) : [],
  };
}

// ---------------------------------------------------------------------------
// POST /api/summary/candidates — list eligible items for the picker
// ---------------------------------------------------------------------------

export const listCandidates = asyncHandler(async (req, res) => {
  const { classroomId, dateRange } = req.body || {};
  if (!classroomId) return res.status(400).json({ error: "classroomId required" });
  const err = validateDateRange(dateRange);
  if (err) return res.status(400).json({ error: err });

  const candidates = await listSummaryCandidates({ classroomId, dateRange });
  return res.json({ ok: true, data: candidates });
});

// ---------------------------------------------------------------------------
// POST /api/summary/class — generate (or cache-hit) a class-wide summary
// ---------------------------------------------------------------------------

export const createClassSummary = asyncHandler(async (req, res) => {
  const teacherId = req.user?._id || req.user?.id;
  if (!teacherId) return res.status(401).json({ error: "Authenticated teacher required" });

  const { classroomId, dateRange, selectedItems: rawSelected } = req.body || {};
  if (!classroomId) return res.status(400).json({ error: "classroomId required" });
  const dateErr = validateDateRange(dateRange);
  if (dateErr) return res.status(400).json({ error: dateErr });
  const selErr = validateSelected(rawSelected);
  if (selErr) return res.status(400).json({ error: selErr });
  const selectedItems = normalizeSelected(rawSelected);

  const cacheKey = buildSummaryCacheKey({
    kind: "class",
    classroomId,
    dateRange,
    selectedItems,
  });

  // Cache lookup — fast path, skips Gemini entirely. Prompt hash is checked
  // inside findCachedSummary so admin prompt edits auto-invalidate.
  const currentHash = await loadClassPromptHash(teacherId);
  const cached = await findCachedSummary({
    cacheKey,
    standardPromptHash: currentHash,
  });
  if (cached) {
    return res.json({
      ok: true,
      data: shapeSummaryForClient(cached),
      cached: true,
    });
  }

  // Cache miss — count against quota BEFORE the real Gemini call. Cache
  // hits above cost nothing so they correctly don't count.
  try {
    await assertUsageBudget(teacherId, "lessonReports");
  } catch (err) {
    if (err instanceof LimitReachedError) {
      return res.status(402).json(limitReachedResponseBody(err));
    }
    throw err;
  }

  const [classroom, instructionLanguage, aggregated] = await Promise.all([
    Classroom.findById(classroomId).select("name title").lean(),
    resolveInstructionLanguageForSelection({ classroomId, selectedItems }),
    aggregateClassSummaryInputs({ classroomId, selectedItems }),
  ]);
  const classroomName = classroom?.name || classroom?.title || "";

  const { body, promptHash, model } = await generateClassSummary({
    teacherId,
    classroomName,
    dateRange,
    aggregated,
    instructionLanguage,
  });

  const doc = await SummaryReport.create({
    kind: "class",
    classroomId,
    teacherId,
    dateRange: { start: new Date(dateRange.start), end: new Date(dateRange.end) },
    selectedItems,
    instructionLanguage,
    standardPromptHash: promptHash,
    cacheKey,
    body,
    perStudent: [],
    aiCallCount: 1,
  });

  // Counts against the teacher's monthly lessonReports quota (same bucket
  // used by Task 2 dispatch — summary and lesson reports are the same
  // metered thing from a billing perspective). Upsert keeps re-generations
  // of the same (teacher, summaryId) idempotent.
  try {
    await LessonReportSent.updateOne(
      { teacherId, lessonId: doc._id }, // lessonId field overloaded as summaryId here
      { $setOnInsert: { teacherId, lessonId: doc._id, sentAt: new Date() }, $addToSet: { kinds: "summary-class" } },
      { upsert: true }
    );
  } catch (err) {
    // Non-fatal — the report is already saved, quota logging is best-effort.
    console.warn("[SummaryReport:class] usage upsert failed:", err?.message || err);
  }

  console.log(`[SummaryReport:class] created id=${doc._id} teacher=${teacherId} items=${selectedItems.lessonIds.length}+${selectedItems.assignmentTaskIds.length}+${selectedItems.testTaskIds.length} model=${model}`);

  return res.json({ ok: true, data: shapeSummaryForClient(doc), cached: false });
});

// ---------------------------------------------------------------------------
// POST /api/summary/student — generate per-student summaries + dispatch emails
// ---------------------------------------------------------------------------

export const createStudentSummary = asyncHandler(async (req, res) => {
  const teacherId = req.user?._id || req.user?.id;
  if (!teacherId) return res.status(401).json({ error: "Authenticated teacher required" });

  const {
    classroomId,
    dateRange,
    selectedItems: rawSelected,
    studentIds: rawStudentIds,
    sendToStudents = false,
    sendToParents = false,
    message = "",
  } = req.body || {};

  if (!classroomId) return res.status(400).json({ error: "classroomId required" });
  const dateErr = validateDateRange(dateRange);
  if (dateErr) return res.status(400).json({ error: dateErr });
  const selErr = validateSelected(rawSelected);
  if (selErr) return res.status(400).json({ error: selErr });
  if (!Array.isArray(rawStudentIds) || rawStudentIds.length === 0) {
    return res.status(400).json({ error: "studentIds[] required (at least one student)" });
  }

  const selectedItems = normalizeSelected(rawSelected);
  const studentIds = [...new Set(rawStudentIds.map((s) => String(s)))];

  const cacheKey = buildSummaryCacheKey({
    kind: "student",
    classroomId,
    dateRange,
    selectedItems,
    studentIds,
  });

  const currentHash = await loadStudentPromptHash(teacherId);
  const cached = await findCachedSummary({
    cacheKey,
    standardPromptHash: currentHash,
  });
  if (cached) {
    // Cache hit — we still dispatch emails if asked to (teacher may re-send
    // without regenerating). This is rare; the common path is one-shot
    // generate+send.
    let emails = null;
    if (sendToStudents || sendToParents) {
      emails = await dispatchSummaryEmails({
        teacherId,
        summaryDoc: cached,
        sendToStudents,
        sendToParents,
        message,
      });
    }
    return res.json({
      ok: true,
      data: shapeSummaryForClient(cached),
      cached: true,
      emails,
    });
  }

  // Cache miss — N Gemini calls, N quota counts. We assert the budget N
  // times up front so we don't half-generate; a partial quota exhaustion
  // is a worse UX than a clean rejection.
  for (let i = 0; i < studentIds.length; i++) {
    try {
      await assertUsageBudget(teacherId, "lessonReports");
    } catch (err) {
      if (err instanceof LimitReachedError) {
        return res.status(402).json(limitReachedResponseBody(err));
      }
      throw err;
    }
  }

  const [classroom, instructionLanguage, students] = await Promise.all([
    Classroom.findById(classroomId).select("name title").lean(),
    resolveInstructionLanguageForSelection({ classroomId, selectedItems }),
    User.find({ _id: { $in: studentIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("_id firstName lastName userName email")
      .lean(),
  ]);
  const classroomName = classroom?.name || classroom?.title || "";
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  // Fan out per-student. allSettled so one failure doesn't abort the rest;
  // failures surface as perStudent[].status = "failed".
  const results = await Promise.allSettled(
    studentIds.map(async (studentId) => {
      const student = studentById.get(studentId);
      const studentName = buildStudentDisplayName(student) || studentId;

      const aggregated = await aggregateStudentSummaryInputs({
        classroomId,
        selectedItems,
        studentId,
      });
      if (!aggregated) {
        return {
          studentId: new mongoose.Types.ObjectId(studentId),
          studentName,
          body: null,
          status: "skipped",
          failureReason: "No recorded activity for this student in the selected items.",
        };
      }
      try {
        const { body } = await generateStudentSummary({
          teacherId,
          studentId,
          studentName,
          classroomName,
          dateRange,
          aggregated,
          instructionLanguage,
        });
        return {
          studentId: new mongoose.Types.ObjectId(studentId),
          studentName,
          body,
          status: "ok",
        };
      } catch (err) {
        console.warn(`[SummaryReport:student] generation failed for student=${studentId}:`, err?.message || err);
        return {
          studentId: new mongoose.Types.ObjectId(studentId),
          studentName,
          body: null,
          status: "failed",
          failureReason: String(err?.message || err).slice(0, 500),
        };
      }
    })
  );

  const perStudent = results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : {
          studentId: null,
          studentName: "",
          body: null,
          status: "failed",
          failureReason: String(r.reason?.message || r.reason || "unknown").slice(0, 500),
        }
  );

  const successCount = perStudent.filter((p) => p.status === "ok").length;

  const doc = await SummaryReport.create({
    kind: "student",
    classroomId,
    teacherId,
    dateRange: { start: new Date(dateRange.start), end: new Date(dateRange.end) },
    selectedItems,
    instructionLanguage,
    standardPromptHash: currentHash,
    cacheKey,
    body: null,
    perStudent,
    aiCallCount: successCount,
  });

  console.log(`[SummaryReport:student] created id=${doc._id} teacher=${teacherId} studentsRequested=${studentIds.length} ok=${successCount} model=auto`);

  let emails = null;
  if ((sendToStudents || sendToParents) && successCount > 0) {
    emails = await dispatchSummaryEmails({
      teacherId,
      summaryDoc: doc,
      sendToStudents,
      sendToParents,
      message,
    });
  }

  return res.json({ ok: true, data: shapeSummaryForClient(doc), cached: false, emails });
});

// ---------------------------------------------------------------------------
// GET /api/summary/:id — teacher re-opens a prior summary
// ---------------------------------------------------------------------------

export const getSummaryById = asyncHandler(async (req, res) => {
  const teacherId = req.user?._id || req.user?.id;
  if (!teacherId) return res.status(401).json({ error: "Authenticated teacher required" });
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid summary id" });
  }
  const doc = await SummaryReport.findById(id).lean();
  if (!doc) return res.status(404).json({ error: "Summary not found" });
  // Scope check — only the owning teacher can read.
  if (String(doc.teacherId) !== String(teacherId)) {
    return res.status(403).json({ error: "Not your summary" });
  }
  return res.json({ ok: true, data: shapeSummaryForClient(doc) });
});

// ---------------------------------------------------------------------------
// Email dispatch — issues one ReportAccessToken per recipient (role-split
// just like Task 2's Both flow). The public view handler is extended to
// recognise kind="studentSummary" tokens.
// ---------------------------------------------------------------------------

async function dispatchSummaryEmails({ teacherId, summaryDoc, sendToStudents, sendToParents, message }) {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const [teacher, classroom] = await Promise.all([
    User.findById(teacherId).select("firstName lastName name userName").lean(),
    Classroom.findById(summaryDoc.classroomId)
      .select("studentIds")
      .populate({
        path: "studentIds",
        select: "firstName lastName userName email parentId",
        populate: { path: "parentId", select: "email" },
      })
      .lean(),
  ]);
  const teacherName =
    [teacher?.firstName, teacher?.lastName].filter(Boolean).join(" ") ||
    teacher?.name ||
    teacher?.userName ||
    "Your teacher";

  const studentsFromClassroom = Array.isArray(classroom?.studentIds)
    ? classroom.studentIds
    : [];
  const studentDocById = new Map(
    studentsFromClassroom.map((s) => [String(s._id), s])
  );

  const transporter = getTransporter();
  const results = await Promise.allSettled(
    summaryDoc.perStudent
      .filter((p) => p.status === "ok" && p.studentId)
      .flatMap((p) => {
        const studentDoc = studentDocById.get(String(p.studentId));
        const studentEmail = studentDoc?.email;
        const parentEmail = studentDoc?.parentId?.email;
        const studentName = buildStudentDisplayName(studentDoc) || p.studentName;
        const tasks = [];
        if (sendToStudents && studentEmail) {
          tasks.push(
            sendOneSummaryEmail({
              transporter,
              teacherId,
              summaryDoc,
              studentId: p.studentId,
              studentName,
              recipientEmail: studentEmail,
              role: "student",
              teacherName,
              message,
              expiresAt,
            })
          );
        }
        if (sendToParents && parentEmail) {
          tasks.push(
            sendOneSummaryEmail({
              transporter,
              teacherId,
              summaryDoc,
              studentId: p.studentId,
              studentName,
              recipientEmail: parentEmail,
              role: "parent",
              teacherName,
              message,
              expiresAt,
            })
          );
        }
        return tasks;
      })
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  return { sent, failed, total: sent + failed };
}

async function sendOneSummaryEmail({
  transporter,
  teacherId,
  summaryDoc,
  studentId,
  studentName,
  recipientEmail,
  role,
  teacherName,
  message,
  expiresAt,
}) {
  let token;
  for (let attempt = 0; attempt < 2; attempt++) {
    token = generateToken();
    try {
      await ReportAccessToken.create({
        token,
        kind: "studentSummary",
        summaryId: summaryDoc._id,
        studentId,
        teacherId,
        recipientRole: role,
        sentToEmail: recipientEmail,
        expiresAt,
      });
      break;
    } catch (err) {
      if (attempt === 1 || err?.code !== 11000) throw err;
    }
  }

  const { subject, html, text } = buildStudentSummaryEmail({
    recipientName: role === "parent" ? "Parent" : studentName,
    studentName,
    teacherName,
    rangeStart: summaryDoc.dateRange?.start,
    rangeEnd: summaryDoc.dateRange?.end,
    viewUrl: buildSummaryViewUrl(token),
    customMessage: message || "",
    isParent: role === "parent",
  });

  await transporter.sendMail({
    from: process.env.NODEMAILER_EMAIL,
    to: recipientEmail,
    subject,
    html,
    text,
  });

  console.log(`[SummaryReport:student] email to ${recipientEmail} (${role}) summary=${summaryDoc._id} student=${studentId} token=${token.slice(0, 8)}...`);
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

function shapeSummaryForClient(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    kind: doc.kind,
    classroomId: String(doc.classroomId),
    dateRange: {
      start: doc.dateRange?.start || null,
      end: doc.dateRange?.end || null,
    },
    selectedItems: doc.selectedItems || { lessonIds: [], assignmentTaskIds: [], testTaskIds: [] },
    instructionLanguage: doc.instructionLanguage || "English",
    body: doc.body || null,
    perStudent: Array.isArray(doc.perStudent)
      ? doc.perStudent.map((p) => ({
          studentId: p.studentId ? String(p.studentId) : null,
          studentName: p.studentName || "",
          body: p.body || null,
          status: p.status || "ok",
          failureReason: p.failureReason || "",
        }))
      : [],
    aiCallCount: doc.aiCallCount || 0,
    createdAt: doc.createdAt || null,
  };
}

function buildStudentDisplayName(user) {
  if (!user) return "";
  return (
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.userName ||
    ""
  );
}
