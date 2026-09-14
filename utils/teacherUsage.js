import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";
import Classroom from "../models/classroomModel.js";
import ScreenLockInterval from "../models/ScreenLockIntervalModel.js";
import LessonReportSent from "../models/LessonReportSentModel.js";
import UploadedFile from "../models/UploadedFileModel.js";
import AiTokenUsage from "../models/AiTokenUsageModel.js";
import AiCallLog from "../models/AiCallLogModel.js";
import User from "../models/user.js";
import Subscription from "../models/SubscriptionModel.js";
import Session from "../models/SessionModel.js";

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

// Clamps the monthly window to Subscription.usageResetAt so an upgrade
// zeroes every monthly counter as of the reset moment. resetAt=null (no
// active subscription) leaves the window untouched.
export function effectiveMonthlyWindow(monthKey, resetAt) {
  const { start, end } = monthBounds(monthKey);
  if (!resetAt) return { start, end };
  const reset = resetAt instanceof Date ? resetAt : new Date(resetAt);
  if (Number.isNaN(reset.getTime())) return { start, end };
  return {
    start: reset > start ? reset : start,
    end,
  };
}

// Reads the active subscription's usageResetAt marker. Returns null when
// no active subscription exists — callers treat that as "no reset applied".
export async function getUsageResetAt(teacherId) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return null;
  const sub = await Subscription.findOne({
    userId: teacherOid,
    status: "active",
  })
    .select("usageResetAt")
    .lean();
  return sub?.usageResetAt || null;
}

// Stamps Subscription.usageResetAt=now for a teacher. Call from any code
// path that grants a new billing period: plan upgrade/downgrade endpoints,
// Stripe subscription webhooks (customer.subscription.created/updated when
// the plan changes), and admin manual plan edits. Fire-and-forget-safe.
export async function touchUsageResetAt(teacherId) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return null;
  return Subscription.findOneAndUpdate(
    { userId: teacherOid, status: "active" },
    { $set: { usageResetAt: new Date() } },
    { new: true, projection: { usageResetAt: 1 } },
  ).lean();
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
// overlapped the given [start, end) window. Active lessons (endedAt=null)
// are clipped to now so dashboards reflect in-progress usage. Caller is
// responsible for clamping `start` to max(monthStart, subscription.usageResetAt)
// so upgrades zero the counter mid-month.
async function sumMeetingMinutes(teacherId, start, end) {
  const classrooms = await Classroom.find({ teacherId })
    .select("_id")
    .lean();
  if (classrooms.length === 0) return 0;
  const classroomIds = classrooms.map((c) => c._id);

  // Some legacy Lesson docs have classroomId=null because
  // resolveSessionContext returned null at create time (roomId <-> Session
  // regex miss). Recover those via sessionId → Session.classroomId.
  const sessionIds = await Session.find({ classroomId: { $in: classroomIds } })
    .distinct("_id");

  const lessons = await Lesson.find({
    $and: [
      {
        $or: [
          { classroomId: { $in: classroomIds } },
          ...(sessionIds.length ? [{ sessionId: { $in: sessionIds } }] : []),
        ],
      },
      { startedAt: { $lt: end } },
      { $or: [{ endedAt: null }, { endedAt: { $gte: start } }] },
    ],
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

async function sumScreenLockMinutes(teacherId, start, end) {
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

async function countLessonReports(teacherId, start, end) {
  return LessonReportSent.countDocuments({
    teacherId,
    sentAt: { $gte: start, $lt: end },
  });
}

// Sums raw Gemini tokens across every AiCallLog row where teacherId matches
// this teacher. AiCallLog is written on every call (teacher-initiated
// assignment gen + every student submission in one of the teacher's
// classrooms), so this captures the teacher's spend AND their students'
// spend — matching what the teacher sees in their own AI call log.
async function sumAiTokensBilled(teacherId, start, end) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return 0;
  const [row] = await AiCallLog.aggregate([
    {
      $match: {
        teacherId: teacherOid,
        createdAt: { $gte: start, $lt: end },
      },
    },
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

// Count of AI calls (rows in AiCallLog) attributed to this teacher for the
// month — includes the teacher's own calls plus every AI call triggered by
// their students. This is the "number of times AI was used" figure shown
// on the teacher's own subscription view.
async function countAiCalls(teacherId, start, end) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return 0;
  return AiCallLog.countDocuments({
    teacherId: teacherOid,
    createdAt: { $gte: start, $lt: end },
  });
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
  const [user, resetAt] = await Promise.all([
    User.findById(teacherId).select("limits").lean(),
    getUsageResetAt(teacherId),
  ]);
  const limits = user?.limits || {};
  const { start, end } = effectiveMonthlyWindow(mk, resetAt);

  const [
    meetingMinutes,
    screenLockMinutes,
    lessonReports,
    aiTokens,
    aiCalls,
    storageBytes,
  ] = await Promise.all([
    sumMeetingMinutes(teacherId, start, end),
    sumScreenLockMinutes(teacherId, start, end),
    countLessonReports(teacherId, start, end),
    sumAiTokensBilled(teacherId, start, end),
    countAiCalls(teacherId, start, end),
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
    aiCalls: {
      used: aiCalls,
      limit: 0,
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
  const [user, resetAt] = await Promise.all([
    User.findById(teacherId).select("limits").lean(),
    getUsageResetAt(teacherId),
  ]);
  const limit = user?.limits?.[LIMIT_FIELD_BY_CATEGORY[category]] ?? 0;
  const { start, end } = effectiveMonthlyWindow(mk, resetAt);

  let used = 0;
  switch (category) {
    case "meetingMinutes":
      used = await sumMeetingMinutes(teacherId, start, end);
      break;
    case "screenLockMinutes":
      used = await sumScreenLockMinutes(teacherId, start, end);
      break;
    case "lessonReports":
      used = await countLessonReports(teacherId, start, end);
      break;
    case "aiTokens":
      used = await sumAiTokensBilled(teacherId, start, end);
      break;
    case "storageBytes":
      used = await sumStorageBytes(teacherId);
      break;
    default:
      return { ok: true, used: 0, limit: 0 };
  }
  return { ok: used < limit, used, limit };
}

// Count current AI calls this month (dedicated helper — reused by both the
// self-service view and any future middleware gate against maxAiCallsPerMonth).
async function countAiCallsInternal(teacherOid, start, end) {
  return AiCallLog.countDocuments({
    teacherId: teacherOid,
    createdAt: { $gte: start, $lt: end },
  });
}

async function countSessionsThisMonth(teacherOid, start, end) {
  const classroomIds = await Classroom.find({ teacherId: teacherOid })
    .distinct("_id");
  if (classroomIds.length === 0) return 0;
  return Session.countDocuments({
    classroomId: { $in: classroomIds },
    sessionDate: { $gte: start, $lt: end },
  });
}

async function countClassrooms(teacherOid) {
  return Classroom.countDocuments({ teacherId: teacherOid });
}

async function countStudents(teacherOid) {
  // Match both the new multi-teacher array (teacherIds) AND the legacy
  // singular teacherId — students created before the multi-teacher
  // migration only have teacherId set, so the array-only query returned
  // 0 for teachers whose students were all pre-migration. See
  // [[student-multi-teacher]].
  return User.countDocuments({
    userRole: "student",
    $or: [{ teacherIds: teacherOid }, { teacherId: teacherOid }],
  });
}

async function countTeachers(teacherOid) {
  // "Teachers under this account" only applies to school-admin owners. For a
  // solo teacher this is always 1 (themselves). Leaving here so a school
  // plan can display it meaningfully.
  return User.countDocuments({
    userRole: "teacher",
    $or: [{ _id: teacherOid }, { schoolAdminId: teacherOid }],
  });
}

// Loads the teacher's active subscription plan and returns a normalized
// {plan, categories[], featureFlags} snapshot with current usage vs each
// Plan.limits dimension. null/undefined limit == unlimited (per Plan
// schema comment). The teacher self-service page renders straight off
// this shape so what's on screen matches exactly what their plan sells.
export async function getTeacherSubscriptionUsage(teacherId, monthKey) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return null;
  const mk = monthKey || currentMonthKey();

  const subscription = await Subscription.findOne({
    userId: teacherOid,
    status: "active",
  })
    .populate("planType")
    .lean();

  const plan = subscription?.planType || null;
  const limits = plan?.limits || {};
  const featureFlags = plan?.featureFlags || {};

  // Reset marker on the subscription clamps every monthly counter, so
  // upgrading/renewing a plan zeroes them mid-month without touching any
  // underlying rows. Cumulative counters (classrooms, students, teachers)
  // deliberately ignore reset — they reflect current state, not history.
  const { start, end } = effectiveMonthlyWindow(mk, subscription?.usageResetAt);

  const [
    aiCalls,
    sessions,
    sessionMinutes,
    screenLockMinutes,
    classrooms,
    students,
    teachers,
  ] = await Promise.all([
    countAiCallsInternal(teacherOid, start, end),
    countSessionsThisMonth(teacherOid, start, end),
    sumMeetingMinutes(teacherOid, start, end),
    sumScreenLockMinutes(teacherOid, start, end),
    countClassrooms(teacherOid),
    countStudents(teacherOid),
    countTeachers(teacherOid),
  ]);

  const categories = [
    {
      key: "aiCalls",
      label: "AI calls",
      unit: "calls",
      used: aiCalls,
      limit: limits.maxAiCallsPerMonth,
      period: "month",
    },
    {
      key: "sessions",
      label: "Sessions",
      unit: "sessions",
      used: sessions,
      limit: limits.maxSessionsPerMonth,
      period: "month",
    },
    {
      key: "sessionMinutes",
      label: "Session minutes",
      unit: "min",
      used: sessionMinutes,
      limit: limits.maxSessionMinutesPerMonth,
      period: "month",
    },
    {
      key: "screenLockMinutes",
      label: "Screen lock minutes",
      unit: "min",
      used: screenLockMinutes,
      limit: limits.maxScreenLockMinutesPerMonth,
      period: "month",
    },
    {
      key: "classrooms",
      label: "Classrooms",
      unit: "classrooms",
      used: classrooms,
      limit: limits.maxClassrooms,
      period: "cumulative",
    },
    {
      key: "students",
      label: "Students",
      unit: "students",
      used: students,
      limit: limits.maxStudents,
      period: "cumulative",
    },
    {
      key: "teachers",
      label: "Teachers",
      unit: "teachers",
      used: teachers,
      limit: limits.maxTeachers,
      period: "cumulative",
    },
  ];

  return {
    monthKey: mk,
    plan: plan
      ? {
          _id: String(plan._id),
          name: plan.name,
          planType: plan.planType,
          planCategory: plan.planCategory,
          subtitle: plan.subtitle || "",
        }
      : null,
    subscription: subscription
      ? {
          status: subscription.status,
          frequency: subscription.frequency,
          currency: subscription.currency,
          provider: subscription.provider || "",
          createdAt: subscription.createdAt,
        }
      : null,
    categories,
    featureFlags,
  };
}
