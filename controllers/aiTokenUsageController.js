import mongoose from "mongoose";
import asyncHandler from "express-async-handler";
import AiTokenUsage from "../models/AiTokenUsageModel.js";
import AiCallLog from "../models/AiCallLogModel.js";
import Session from "../models/SessionModel.js";

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
