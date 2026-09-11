import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import AiTokenUsage from "../models/AiTokenUsageModel.js";
import AiCallLog from "../models/AiCallLogModel.js";
import Session from "../models/SessionModel.js";
import User from "../models/user.js";
import {
  getTeacherMonthUsage,
  getTeacherSubscriptionUsage,
  currentMonthKey,
} from "../utils/teacherUsage.js";

// Per-classroom breakdown of AI token usage grouped by (session, month).
// Returned rows are sorted newest-month-first, then by topic. Sessions with
// zero usage in every month are omitted so the UI shows only sessions that
// actually consumed tokens.
export const getClassroomAiUsage = async (req, res) => {
  try {
    const { classroomId } = req.params;
    if (!classroomId || !mongoose.Types.ObjectId.isValid(classroomId)) {
      return res.status(400).json({ error: "Valid classroomId is required." });
    }

    const sessions = await Session.find({ classroomId })
      .select("_id topic subject sessionDate")
      .lean();

    if (sessions.length === 0) {
      return res.status(200).json({ rows: [] });
    }

    const sessionIds = sessions.map((s) => s._id);
    const usageDocs = await AiTokenUsage.find({
      sessionId: { $in: sessionIds },
    })
      .select(
        "monthKey sessionId promptTokenCount candidatesTokenCount cachedContentTokenCount totalThoughtTokens",
      )
      .lean();

    const sessionById = new Map(
      sessions.map((s) => [String(s._id), s]),
    );

    const rows = usageDocs
      .map((u) => {
        const session = sessionById.get(String(u.sessionId));
        return {
          monthKey: u.monthKey,
          sessionId: String(u.sessionId),
          sessionTopic: session?.topic || "(deleted session)",
          sessionSubject: session?.subject || "",
          sessionDate: session?.sessionDate || null,
          promptTokenCount: u.promptTokenCount || 0,
          candidatesTokenCount: u.candidatesTokenCount || 0,
          cachedContentTokenCount: u.cachedContentTokenCount || 0,
          totalThoughtTokens: u.totalThoughtTokens || 0,
        };
      })
      .sort((a, b) => {
        if (a.monthKey !== b.monthKey) {
          return b.monthKey.localeCompare(a.monthKey);
        }
        return a.sessionTopic.localeCompare(b.sessionTopic);
      });

    return res.status(200).json({ rows });
  } catch (err) {
    console.error("[AiTokenUsage] getClassroomAiUsage failed:", err);
    return res.status(500).json({ error: "Failed to fetch AI token usage." });
  }
};

// GET /api/admin/ai-token-usage
// Admin-wide token totals for the dev-stage tracking page. Joins each
// AiTokenUsage row with Session → Classroom → teacher so the UI can show
// who spent what. Sessionless rows (Create Assignment, image gen — no
// session context) come back with sessionId=null and blank teacher fields;
// the UI groups them under a "(sessionless)" bucket.
export const getAiTokenUsage = asyncHandler(async (req, res) => {
  const pipeline = [
    {
      $lookup: {
        from: "sessions",
        localField: "sessionId",
        foreignField: "_id",
        as: "session",
      },
    },
    { $unwind: { path: "$session", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "classrooms",
        localField: "session.classroomId",
        foreignField: "_id",
        as: "classroom",
      },
    },
    { $unwind: { path: "$classroom", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "users",
        localField: "classroom.teacherId",
        foreignField: "_id",
        as: "teacher",
      },
    },
    { $unwind: { path: "$teacher", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        monthKey: 1,
        sessionId: 1,
        sessionTopic: "$session.topic",
        sessionDate: "$session.sessionDate",
        classroomId: "$session.classroomId",
        teacherName: {
          $trim: {
            input: {
              $concat: [
                { $ifNull: ["$teacher.firstName", ""] },
                " ",
                { $ifNull: ["$teacher.lastName", ""] },
              ],
            },
          },
        },
        teacherEmail: "$teacher.email",
        promptTokenCount: { $ifNull: ["$promptTokenCount", 0] },
        candidatesTokenCount: { $ifNull: ["$candidatesTokenCount", 0] },
        cachedContentTokenCount: { $ifNull: ["$cachedContentTokenCount", 0] },
        totalThoughtTokens: { $ifNull: ["$totalThoughtTokens", 0] },
        total: {
          $add: [
            { $ifNull: ["$promptTokenCount", 0] },
            { $ifNull: ["$candidatesTokenCount", 0] },
            { $ifNull: ["$totalThoughtTokens", 0] },
          ],
        },
        updatedAt: 1,
      },
    },
    { $sort: { monthKey: -1, sessionDate: -1, updatedAt: -1 } },
  ];

  const rows = await AiTokenUsage.aggregate(pipeline);
  return res.json({ ok: true, data: { rows } });
});

// GET /api/admin/ai-call-logs
// Per-call audit rows for the admin panel. Recent-first, capped at 200 by
// default. Filters: tag, teacherId, studentId, sessionId. Response includes
// question / student answer / AI response text so admin can eyeball what
// Gemini saw and returned. Populates teacher + student names.
export const getAiCallLogs = asyncHandler(async (req, res) => {
  const {
    limit: rawLimit,
    skip: rawSkip,
    tag,
    teacherId,
    studentId,
    sessionId,
  } = req.query || {};

  const limit = Math.max(1, Math.min(500, Number(rawLimit) || 100));
  const skip = Math.max(0, Number(rawSkip) || 0);

  const filter = {};
  if (tag) filter.tag = String(tag);
  if (teacherId && mongoose.Types.ObjectId.isValid(teacherId)) {
    filter.teacherId = new mongoose.Types.ObjectId(teacherId);
  }
  if (studentId && mongoose.Types.ObjectId.isValid(studentId)) {
    filter.studentId = new mongoose.Types.ObjectId(studentId);
  }
  if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
    filter.sessionId = new mongoose.Types.ObjectId(sessionId);
  }

  const [rows, total] = await Promise.all([
    AiCallLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("teacherId", "firstName lastName email")
      .populate("studentId", "firstName lastName email")
      .populate("sessionId", "topic sessionDate")
      .lean(),
    AiCallLog.countDocuments(filter),
  ]);

  const shaped = rows.map((r) => ({
    _id: String(r._id),
    reqId: r.reqId || "",
    tag: r.tag,
    model: r.model || "",
    createdAt: r.createdAt,
    teacherName:
      [r.teacherId?.firstName, r.teacherId?.lastName]
        .filter(Boolean)
        .join(" ") || "",
    teacherEmail: r.teacherId?.email || "",
    studentName:
      r.studentName ||
      [r.studentId?.firstName, r.studentId?.lastName]
        .filter(Boolean)
        .join(" ") ||
      "",
    sessionTopic: r.sessionId?.topic || "",
    sessionDate: r.sessionId?.sessionDate || null,
    questionText: r.questionText || "",
    studentAnswer: r.studentAnswer || "",
    aiResponseSummary: r.aiResponseSummary || "",
    userPromptText: r.userPromptText || "",
    standardPromptSnippet: r.standardPromptSnippet || "",
    teacherPromptSnippet: r.teacherPromptSnippet || "",
    standardPromptHash: r.standardPromptHash || "",
    promptTokenCount: r.promptTokenCount || 0,
    candidatesTokenCount: r.candidatesTokenCount || 0,
    cachedContentTokenCount: r.cachedContentTokenCount || 0,
    totalThoughtTokens: r.totalThoughtTokens || 0,
    totalTokens: r.totalTokens || 0,
    error: r.error || "",
  }));

  return res.json({
    ok: true,
    data: {
      rows: shaped,
      total,
      limit,
      skip,
    },
  });
});

// GET /api/admin/ai-cache-stats?days=30
// Cache hit-rate summary from AiCallLog. A "hit" is a call where any
// portion of the input was served from the Gemini explicit cache
// (cachedContentTokenCount > 0). Also surfaces the internal preCheck /
// response-cache tags because those short-circuit Gemini entirely.
export const getAiCacheStats = asyncHandler(async (req, res) => {
  const days = Math.max(1, Math.min(90, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [row] = await AiCallLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        totalCalls: { $sum: 1 },
        cachedCalls: {
          $sum: {
            $cond: [{ $gt: ["$cachedContentTokenCount", 0] }, 1, 0],
          },
        },
        preCheckCalls: {
          $sum: {
            $cond: [
              {
                $in: [
                  "$tag",
                  [
                    "ClassworkFeedback:preCheck",
                    "ClassworkFeedback:stream:preCheck",
                  ],
                ],
              },
              1,
              0,
            ],
          },
        },
        totalInputTokens: { $sum: { $ifNull: ["$promptTokenCount", 0] } },
        totalCachedTokens: {
          $sum: { $ifNull: ["$cachedContentTokenCount", 0] },
        },
        totalOutputTokens: {
          $sum: { $ifNull: ["$candidatesTokenCount", 0] },
        },
      },
    },
  ]);

  const totalCalls = row?.totalCalls || 0;
  const cachedCalls = row?.cachedCalls || 0;
  const preCheckCalls = row?.preCheckCalls || 0;
  const totalInputTokens = row?.totalInputTokens || 0;
  const totalCachedTokens = row?.totalCachedTokens || 0;
  const totalOutputTokens = row?.totalOutputTokens || 0;

  const hitRate = totalCalls > 0 ? cachedCalls / totalCalls : 0;
  const preCheckRate = totalCalls > 0 ? preCheckCalls / totalCalls : 0;
  const cachedTokenShare =
    totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0;

  return res.json({
    ok: true,
    data: {
      days,
      totalCalls,
      cachedCalls,
      preCheckCalls,
      totalInputTokens,
      totalCachedTokens,
      totalOutputTokens,
      hitRate,
      preCheckRate,
      cachedTokenShare,
    },
  });
});

// GET /api/admin/ai-token-usage-by-teacher?monthKey=YYYY-MM
// Per-teacher rollup for one month. Groups AiTokenUsage rows through
// session → classroom → teacher, then joins User for name/email + the
// teacher's aiTokensPerMonth limit so the UI can render used-vs-quota.
export const getAiTokenUsageByTeacher = asyncHandler(async (req, res) => {
  const monthKey = String(req.query.monthKey || currentMonthKey());

  const rows = await AiTokenUsage.aggregate([
    { $match: { monthKey, sessionId: { $ne: null } } },
    {
      $lookup: {
        from: "sessions",
        localField: "sessionId",
        foreignField: "_id",
        as: "session",
      },
    },
    { $unwind: "$session" },
    {
      $lookup: {
        from: "classrooms",
        localField: "session.classroomId",
        foreignField: "_id",
        as: "classroom",
      },
    },
    { $unwind: "$classroom" },
    {
      $group: {
        _id: "$classroom.teacherId",
        promptTokenCount: {
          $sum: { $ifNull: ["$promptTokenCount", 0] },
        },
        candidatesTokenCount: {
          $sum: { $ifNull: ["$candidatesTokenCount", 0] },
        },
        cachedContentTokenCount: {
          $sum: { $ifNull: ["$cachedContentTokenCount", 0] },
        },
        totalThoughtTokens: {
          $sum: { $ifNull: ["$totalThoughtTokens", 0] },
        },
        sessions: { $addToSet: "$sessionId" },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "teacher",
      },
    },
    { $unwind: { path: "$teacher", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        teacherId: "$_id",
        teacherName: {
          $trim: {
            input: {
              $concat: [
                { $ifNull: ["$teacher.firstName", ""] },
                " ",
                { $ifNull: ["$teacher.lastName", ""] },
              ],
            },
          },
        },
        teacherEmail: "$teacher.email",
        aiTokensPerMonth: "$teacher.limits.aiTokensPerMonth",
        isPaid: "$teacher.isPaid",
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        cachedContentTokenCount: 1,
        totalThoughtTokens: 1,
        sessionCount: { $size: "$sessions" },
        rawTotal: {
          $add: [
            "$promptTokenCount",
            "$candidatesTokenCount",
            "$totalThoughtTokens",
          ],
        },
      },
    },
    { $sort: { rawTotal: -1 } },
  ]);

  return res.json({ ok: true, data: { monthKey, rows } });
});

// GET /api/teacher/usage?monthKey=YYYY-MM
// Teacher self-service — returns the plan-driven subscription snapshot for
// one month. Includes the active Plan doc, current usage per Plan.limits
// dimension, and the plan's feature flags. Falls back to a null-plan
// response (with usage still populated) when the teacher has no active
// subscription so the UI can prompt "Choose a plan".
export const getMyUsage = asyncHandler(async (req, res) => {
  const teacherId = req.user?._id;
  if (!teacherId) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const monthKey = req.query.monthKey ? String(req.query.monthKey) : undefined;
  const usage = await getTeacherSubscriptionUsage(teacherId, monthKey);
  return res.json({ ok: true, data: usage });
});

// GET /api/teacher/ai-call-logs/:id
// Per-call detail — the token breakdown, full prompts, question / answer /
// AI response text. Always restricted to the teacher's own calls.
export const getMyAiCallLogById = asyncHandler(async (req, res) => {
  const teacherId = req.user?._id;
  if (!teacherId) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ ok: false, error: "Invalid id" });
  }

  const row = await AiCallLog.findOne({
    _id: id,
    teacherId: new mongoose.Types.ObjectId(String(teacherId)),
  })
    .populate("studentId", "firstName lastName email")
    .populate("sessionId", "topic sessionDate")
    .lean();

  if (!row) {
    return res.status(404).json({ ok: false, error: "Call not found" });
  }

  return res.json({
    ok: true,
    data: {
      _id: String(row._id),
      reqId: row.reqId || "",
      tag: row.tag,
      model: row.model || "",
      createdAt: row.createdAt,
      studentName:
        row.studentName ||
        [row.studentId?.firstName, row.studentId?.lastName]
          .filter(Boolean)
          .join(" ") ||
        "",
      sessionTopic: row.sessionId?.topic || "",
      sessionDate: row.sessionId?.sessionDate || null,
      questionText: row.questionText || "",
      studentAnswer: row.studentAnswer || "",
      aiResponseSummary: row.aiResponseSummary || "",
      promptTokenCount: row.promptTokenCount || 0,
      candidatesTokenCount: row.candidatesTokenCount || 0,
      cachedContentTokenCount: row.cachedContentTokenCount || 0,
      totalThoughtTokens: row.totalThoughtTokens || 0,
      totalTokens: row.totalTokens || 0,
      error: row.error || "",
    },
  });
});

// GET /api/teacher/ai-call-logs?limit=&skip=&tag=
// Teacher self-service — same shape as the admin endpoint but always
// filtered to req.user._id. teacherId query param is ignored.
export const getMyAiCallLogs = asyncHandler(async (req, res) => {
  const teacherId = req.user?._id;
  if (!teacherId) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { limit: rawLimit, skip: rawSkip, tag, sessionId } = req.query || {};
  const limit = Math.max(1, Math.min(200, Number(rawLimit) || 50));
  const skip = Math.max(0, Number(rawSkip) || 0);

  const filter = { teacherId: new mongoose.Types.ObjectId(String(teacherId)) };
  if (tag) filter.tag = String(tag);
  if (sessionId && mongoose.Types.ObjectId.isValid(sessionId)) {
    filter.sessionId = new mongoose.Types.ObjectId(sessionId);
  }

  const [rows, total] = await Promise.all([
    AiCallLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("studentId", "firstName lastName email")
      .populate("sessionId", "topic sessionDate")
      .lean(),
    AiCallLog.countDocuments(filter),
  ]);

  const shaped = rows.map((r) => ({
    _id: String(r._id),
    reqId: r.reqId || "",
    tag: r.tag,
    model: r.model || "",
    createdAt: r.createdAt,
    studentName:
      r.studentName ||
      [r.studentId?.firstName, r.studentId?.lastName]
        .filter(Boolean)
        .join(" ") ||
      "",
    sessionTopic: r.sessionId?.topic || "",
    sessionDate: r.sessionId?.sessionDate || null,
    questionText: r.questionText || "",
    studentAnswer: r.studentAnswer || "",
    aiResponseSummary: r.aiResponseSummary || "",
    promptTokenCount: r.promptTokenCount || 0,
    candidatesTokenCount: r.candidatesTokenCount || 0,
    cachedContentTokenCount: r.cachedContentTokenCount || 0,
    totalThoughtTokens: r.totalThoughtTokens || 0,
    totalTokens: r.totalTokens || 0,
    error: r.error || "",
  }));

  return res.json({
    ok: true,
    data: { rows: shaped, total, limit, skip },
  });
});
