import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";
import Classroom from "../models/classroomModel.js";
import ScreenLockInterval from "../models/ScreenLockIntervalModel.js";
import LessonReportSent from "../models/LessonReportSentModel.js";
import UploadedFile from "../models/UploadedFileModel.js";
import AiTokenUsage from "../models/AiTokenUsageModel.js";
import User from "../models/user.js";

// Keep in sync with COST_OVERHEAD_MULTIPLIER in AdminAiTokenUsage.jsx and
// AiTokenUsageCard.jsx. Raw Gemini tokens are multiplied by this factor to
// get the "billed" count that plan quotas are stated in.
const AI_COST_OVERHEAD_MULTIPLIER = 1.3;

export const USAGE_CATEGORIES = [
  "meetingMinutes",
  "screenLockMinutes",
  "lessonReports",
  "aiTokens",
  "storageBytes",
];

// Maps each usage category to the User.limits.<field> it's compared against.
export const LIMIT_FIELD_BY_CATEGORY = {
  meetingMinutes: "meetingMinutesPerMonth",
  screenLockMinutes: "screenLockMinutesPerMonth",
  lessonReports: "lessonReportsPerMonth",
  aiTokens: "aiTokensPerMonth",
  storageBytes: "storageBytes",
};

export function currentMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function monthBounds(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return { start, end };
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch {
    return null;
  }
}

// Sums (endedAt - startedAt) for lessons owned by this teacher whose activity
// overlapped the month. Active lessons (endedAt=null) are clipped to now so
// dashboards reflect in-progress usage.
async function sumMeetingMinutes(teacherId, monthKey) {
  const { start, end } = monthBounds(monthKey);
  const classrooms = await Classroom.find({ teacherId })
    .select("_id")
    .lean();
  if (classrooms.length === 0) return 0;
  const classroomIds = classrooms.map((c) => c._id);

  const lessons = await Lesson.find({
    classroomId: { $in: classroomIds },
    startedAt: { $lt: end },
    $or: [{ endedAt: null }, { endedAt: { $gte: start } }],
  })
    .select("startedAt endedAt")
    .lean();

  const now = new Date();
  let ms = 0;
  for (const l of lessons) {
    const s = l.startedAt ? new Date(l.startedAt) : null;
    if (!s) continue;
    const e = l.endedAt ? new Date(l.endedAt) : now;
    const clipStart = s < start ? start : s;
    const clipEnd = e > end ? end : e;
    if (clipEnd > clipStart) ms += clipEnd - clipStart;
  }
  return Math.round(ms / 60000);
}

async function sumScreenLockMinutes(teacherId, monthKey) {
  const { start, end } = monthBounds(monthKey);
  const intervals = await ScreenLockInterval.find({
    teacherId,
    startedAt: { $lt: end },
    $or: [{ endedAt: null }, { endedAt: { $gte: start } }],
  })
    .select("startedAt endedAt")
    .lean();

  const now = new Date();
  let ms = 0;
  for (const it of intervals) {
    const s = it.startedAt ? new Date(it.startedAt) : null;
    if (!s) continue;
    const e = it.endedAt ? new Date(it.endedAt) : now;
    const clipStart = s < start ? start : s;
    const clipEnd = e > end ? end : e;
    if (clipEnd > clipStart) ms += clipEnd - clipStart;
  }
  return Math.round(ms / 60000);
}

async function countLessonReports(teacherId, monthKey) {
  const { start, end } = monthBounds(monthKey);
  return LessonReportSent.countDocuments({
    teacherId,
    sentAt: { $gte: start, $lt: end },
  });
}

// AiTokenUsage rows don't carry teacherId directly — they join through
// session → classroom → teacher, matching getAiTokenUsage() in
// aiTokenUsageController. Sessionless calls (no sessionId) can't be
// attributed to a teacher and are excluded from per-teacher totals.
async function sumAiTokensBilled(teacherId, monthKey) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return 0;
  const [row] = await AiTokenUsage.aggregate([
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
    { $match: { "classroom.teacherId": teacherOid } },
    {
      $group: {
        _id: null,
        rawTotal: {
          $sum: {
            $add: [
              { $ifNull: ["$promptTokenCount", 0] },
              { $ifNull: ["$candidatesTokenCount", 0] },
              { $ifNull: ["$totalThoughtTokens", 0] },
            ],
          },
        },
      },
    },
  ]);
  const raw = row?.rawTotal || 0;
  return Math.ceil(raw * AI_COST_OVERHEAD_MULTIPLIER);
}

// Cumulative — storage doesn't reset each month.
async function sumStorageBytes(teacherId) {
  const [row] = await UploadedFile.aggregate([
    { $match: { teacherId: toObjectId(teacherId) } },
    { $group: { _id: null, total: { $sum: "$sizeBytes" } } },
  ]);
  return row?.total || 0;
}

// Returns { monthKey, meetingMinutes:{used,limit}, ... } for one teacher.
// Called by the admin dashboard, teacher self-view, and the enforcement
// middleware (which cares only about the {used, limit} pair for its category).
export async function getTeacherMonthUsage(teacherId, monthKey) {
  const mk = monthKey || currentMonthKey();
  const user = await User.findById(teacherId).select("limits").lean();
  const limits = user?.limits || {};

  const [
    meetingMinutes,
    screenLockMinutes,
    lessonReports,
    aiTokens,
    storageBytes,
  ] = await Promise.all([
    sumMeetingMinutes(teacherId, mk),
    sumScreenLockMinutes(teacherId, mk),
    countLessonReports(teacherId, mk),
    sumAiTokensBilled(teacherId, mk),
    sumStorageBytes(teacherId),
  ]);

  return {
    teacherId: String(teacherId),
    monthKey: mk,
    meetingMinutes: {
      used: meetingMinutes,
      limit: limits.meetingMinutesPerMonth ?? 0,
    },
    screenLockMinutes: {
      used: screenLockMinutes,
      limit: limits.screenLockMinutesPerMonth ?? 0,
    },
    lessonReports: {
      used: lessonReports,
      limit: limits.lessonReportsPerMonth ?? 0,
    },
    aiTokens: {
      used: aiTokens,
      limit: limits.aiTokensPerMonth ?? 0,
    },
    storageBytes: {
      used: storageBytes,
      limit: limits.storageBytes ?? 0,
    },
  };
}

// Cheaper single-category check for the enforcement middleware — avoids
// running all five aggregations on every action. Returns {used, limit, ok}
// where ok=false means the teacher has already reached (or passed) the cap.
export async function checkUsageBudget(teacherId, category, monthKey) {
  const mk = monthKey || currentMonthKey();
  const user = await User.findById(teacherId).select("limits").lean();
  const limit = user?.limits?.[LIMIT_FIELD_BY_CATEGORY[category]] ?? 0;

  let used = 0;
  switch (category) {
    case "meetingMinutes":
      used = await sumMeetingMinutes(teacherId, mk);
      break;
    case "screenLockMinutes":
      used = await sumScreenLockMinutes(teacherId, mk);
      break;
    case "lessonReports":
      used = await countLessonReports(teacherId, mk);
      break;
    case "aiTokens":
      used = await sumAiTokensBilled(teacherId, mk);
      break;
    case "storageBytes":
      used = await sumStorageBytes(teacherId);
      break;
    default:
      return { ok: true, used: 0, limit: 0 };
  }
  return { ok: used < limit, used, limit };
}
