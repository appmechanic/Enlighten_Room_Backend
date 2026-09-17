import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";
import Classroom from "../models/classroomModel.js";
import ScreenLockInterval from "../models/ScreenLockIntervalModel.js";
import LessonReportSent from "../models/LessonReportSentModel.js";
import UploadedFile from "../models/UploadedFileModel.js";
import AiCallLog from "../models/AiCallLogModel.js";
import User from "../models/user.js";
import Subscription from "../models/SubscriptionModel.js";
import Plan from "../models/PlanModel.js";
import Session from "../models/SessionModel.js";

export const USAGE_CATEGORIES = [
  "meetingMinutes",
  "screenLockSessions",
  "lessonReports",
  "aiCalls",
  "storageBytes",
];

// Maps each usage category to the Plan.limits.<field> it's compared against.
// null/undefined on the plan means "unlimited" for that dimension. AI spend
// is capped by call count only — token totals stay visible on the admin AI
// token page but are not enforced.
export const LIMIT_FIELD_BY_CATEGORY = {
  meetingMinutes: "maxSessionMinutesPerMonth",
  screenLockSessions: "maxScreenLockSessionsPerMonth",
  lessonReports: "maxLessonReportsPerMonth",
  aiCalls: "maxAiCallsPerMonth",
  storageBytes: "maxStorageBytes",
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

// Resolves the effective Plan.limits for a teacher. Reads the active
// Subscription → Plan first; if the teacher has no active subscription,
// falls back to the Free plan (planType: "free") so untiered accounts still
// get their marketing caps enforced. Returns `{}` if even the Free plan is
// missing — every `limits[field]` read then yields undefined, which the
// hasLimit check treats as unlimited (fail-open, matching prior behaviour).
export async function getEffectivePlanLimits(teacherId) {
  const teacherOid = toObjectId(teacherId);
  if (!teacherOid) return {};
  const sub = await Subscription.findOne({
    userId: teacherOid,
    status: "active",
  })
    .populate({ path: "planType", select: "limits" })
    .lean();
  if (sub?.planType?.limits) return sub.planType.limits;
  const freePlan = await Plan.findOne({ planType: "free" })
    .select("limits")
    .lean();
  return freePlan?.limits || {};
}

// null/undefined limit on Plan.limits means "unlimited" per the plan schema.
function hasLimit(v) {
  return v !== null && v !== undefined;
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

// Counts screen-lock activations (distinct ScreenLockInterval rows) in the
// window rather than summing minutes. Marketing lists caps as "N sessions"
// (e.g. "Screen Lock Sessions: 240 sessions"), so the enforcement dimension
// is a session count, not a minute total.
async function countScreenLockSessions(teacherId, start, end) {
  return ScreenLockInterval.countDocuments({
    teacherId,
    startedAt: { $gte: start, $lt: end },
  });
}

async function countLessonReports(teacherId, start, end) {
  return LessonReportSent.countDocuments({
    teacherId,
    sentAt: { $gte: start, $lt: end },
  });
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

// Sums Gemini prompt (input) + candidates (output) tokens attributed to this
// teacher for the window. Returns { input, output } — AiCallLog has both
// fields per call, so a single aggregation returns both dimensions.
async function sumAiTokens(teacherOid, start, end) {
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
        input: { $sum: "$promptTokenCount" },
        output: { $sum: "$candidatesTokenCount" },
      },
    },
  ]);
  return { input: row?.input || 0, output: row?.output || 0 };
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
// Limits are derived from the teacher's active Subscription → Plan.limits,
// falling back to the Free plan when no active sub. A null/undefined `limit`
// in a returned pair means "unlimited" for that category.
export async function getTeacherMonthUsage(teacherId, monthKey) {
  const mk = monthKey || currentMonthKey();
  const [planLimits, resetAt] = await Promise.all([
    getEffectivePlanLimits(teacherId),
    getUsageResetAt(teacherId),
  ]);
  const { start, end } = effectiveMonthlyWindow(mk, resetAt);

  const [
    meetingMinutes,
    screenLockSessions,
    lessonReports,
    aiCalls,
    storageBytes,
  ] = await Promise.all([
    sumMeetingMinutes(teacherId, start, end),
    countScreenLockSessions(teacherId, start, end),
    countLessonReports(teacherId, start, end),
    countAiCalls(teacherId, start, end),
    sumStorageBytes(teacherId),
  ]);

  const pair = (used, category) => ({
    used,
    limit: planLimits[LIMIT_FIELD_BY_CATEGORY[category]] ?? null,
  });

  return {
    teacherId: String(teacherId),
    monthKey: mk,
    meetingMinutes: pair(meetingMinutes, "meetingMinutes"),
    screenLockSessions: pair(screenLockSessions, "screenLockSessions"),
    lessonReports: pair(lessonReports, "lessonReports"),
    aiCalls: pair(aiCalls, "aiCalls"),
    storageBytes: pair(storageBytes, "storageBytes"),
  };
}

// Cheaper single-category check for the enforcement middleware — avoids
// running all aggregations on every action. Returns {used, limit, ok} where
// ok=false means the teacher has already reached (or passed) the cap.
// A null/undefined limit on the plan is treated as unlimited (ok=true).
export async function checkUsageBudget(teacherId, category, monthKey) {
  const mk = monthKey || currentMonthKey();
  const [planLimits, resetAt] = await Promise.all([
    getEffectivePlanLimits(teacherId),
    getUsageResetAt(teacherId),
  ]);
  const limit = planLimits[LIMIT_FIELD_BY_CATEGORY[category]] ?? null;
  const { start, end } = effectiveMonthlyWindow(mk, resetAt);

  let used = 0;
  switch (category) {
    case "meetingMinutes":
      used = await sumMeetingMinutes(teacherId, start, end);
      break;
    case "screenLockSessions":
      used = await countScreenLockSessions(teacherId, start, end);
      break;
    case "lessonReports":
      used = await countLessonReports(teacherId, start, end);
      break;
    case "aiCalls":
      used = await countAiCalls(teacherId, start, end);
      break;
    case "storageBytes":
      used = await sumStorageBytes(teacherId);
      break;
    default:
      return { ok: true, used: 0, limit: null };
  }
  if (!hasLimit(limit)) return { ok: true, used, limit: null };
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

  // Resolve limits from the active plan OR the Free-tier plan when the
  // teacher has no active subscription — same fallback getEffectivePlanLimits
  // uses, so enforcement and the self-service view agree on the cap.
  let plan = subscription?.planType || null;
  let limits = plan?.limits || {};
  let featureFlags = plan?.featureFlags || {};
  if (!subscription) {
    const freePlan = await Plan.findOne({ planType: "free" }).lean();
    if (freePlan) {
      plan = freePlan;
      limits = freePlan.limits || {};
      featureFlags = freePlan.featureFlags || {};
    }
  }

  // Reset marker on the subscription clamps every monthly counter, so
  // upgrading/renewing a plan zeroes them mid-month without touching any
  // underlying rows. Cumulative counters (classrooms, students, teachers)
  // deliberately ignore reset — they reflect current state, not history.
  const { start, end } = effectiveMonthlyWindow(mk, subscription?.usageResetAt);

  const [
    aiCalls,
    aiTokens,
    sessions,
    sessionMinutes,
    screenLockSessions,
    lessonReports,
    storageBytes,
    classrooms,
    students,
    teachers,
  ] = await Promise.all([
    countAiCallsInternal(teacherOid, start, end),
    sumAiTokens(teacherOid, start, end),
    countSessionsThisMonth(teacherOid, start, end),
    sumMeetingMinutes(teacherOid, start, end),
    countScreenLockSessions(teacherOid, start, end),
    countLessonReports(teacherOid, start, end),
    sumStorageBytes(teacherOid),
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
      key: "aiInputTokens",
      label: "AI input tokens",
      unit: "tokens",
      used: aiTokens.input,
      limit: limits.maxAiInputTokensPerMonth,
      period: "month",
    },
    {
      key: "aiOutputTokens",
      label: "AI output tokens",
      unit: "tokens",
      used: aiTokens.output,
      limit: limits.maxAiOutputTokensPerMonth,
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
      key: "screenLockSessions",
      label: "Screen lock sessions",
      unit: "sessions",
      used: screenLockSessions,
      limit: limits.maxScreenLockSessionsPerMonth,
      period: "month",
    },
    {
      key: "lessonReports",
      label: "Lesson reports",
      unit: "reports",
      used: lessonReports,
      limit: limits.maxLessonReportsPerMonth,
      period: "month",
    },
    {
      key: "storageBytes",
      label: "Storage",
      unit: "bytes",
      used: storageBytes,
      limit: limits.maxStorageBytes,
      period: "cumulative",
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
