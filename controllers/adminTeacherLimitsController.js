import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import User from "../models/user.js";
import {
  getTeacherMonthUsage,
  currentMonthKey,
} from "../utils/teacherUsage.js";

const LIMIT_FIELDS = [
  "meetingMinutesPerMonth",
  "screenLockMinutesPerMonth",
  "lessonReportsPerMonth",
  "aiTokensPerMonth",
  "storageBytes",
];

// GET /api/admin/teachers/limits?monthKey=YYYY-MM&search=&limit=&skip=
// Paginated list of teachers with their limits + current-month usage across
// all five quota categories. Used by the admin subscription page to show
// each teacher's "used vs limit" side-by-side so admins can spot the ones
// approaching their cap.
export const listTeachersWithLimits = asyncHandler(async (req, res) => {
  const {
    monthKey: rawMonth,
    search,
    limit: rawLimit,
    skip: rawSkip,
  } = req.query || {};

  const monthKey = rawMonth ? String(rawMonth) : currentMonthKey();
  const limit = Math.max(1, Math.min(100, Number(rawLimit) || 25));
  const skip = Math.max(0, Number(rawSkip) || 0);

  const filter = { userRole: "teacher" };
  if (search) {
    const s = String(search).trim();
    if (s) {
      const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { firstName: rx },
        { lastName: rx },
        { email: rx },
        { userName: rx },
      ];
    }
  }

  const [teachers, total] = await Promise.all([
    User.find(filter)
      .select("firstName lastName email userName isPaid isSuspended limits stripeCustomerId createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const usageByTeacher = await Promise.all(
    teachers.map((t) => getTeacherMonthUsage(t._id, monthKey))
  );

  const rows = teachers.map((t, i) => ({
    _id: String(t._id),
    firstName: t.firstName || "",
    lastName: t.lastName || "",
    email: t.email || "",
    userName: t.userName || "",
    isPaid: !!t.isPaid,
    isSuspended: !!t.isSuspended,
    stripeCustomerId: t.stripeCustomerId || "",
    createdAt: t.createdAt,
    limits: {
      meetingMinutesPerMonth: t.limits?.meetingMinutesPerMonth ?? 0,
      screenLockMinutesPerMonth: t.limits?.screenLockMinutesPerMonth ?? 0,
      lessonReportsPerMonth: t.limits?.lessonReportsPerMonth ?? 0,
      aiTokensPerMonth: t.limits?.aiTokensPerMonth ?? 0,
      storageBytes: t.limits?.storageBytes ?? 0,
    },
    usage: usageByTeacher[i],
  }));

  return res.json({
    ok: true,
    data: { rows, total, limit, skip, monthKey },
  });
});

// PATCH /api/admin/teachers/:id/limits
// Body accepts any subset of { limits: {...}, isPaid, isSuspended }.
// Fields not present in the body are left untouched. Numeric limits are
// coerced and floored to non-negative integers.
export const updateTeacherLimits = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ ok: false, error: "Invalid teacher id" });
  }

  const teacher = await User.findById(id);
  if (!teacher || teacher.userRole !== "teacher") {
    return res.status(404).json({ ok: false, error: "Teacher not found" });
  }

  const { limits, isPaid, isSuspended } = req.body || {};

  if (limits && typeof limits === "object") {
    teacher.limits = teacher.limits || {};
    for (const field of LIMIT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(limits, field)) {
        const raw = Number(limits[field]);
        if (!Number.isFinite(raw) || raw < 0) {
          return res
            .status(400)
            .json({ ok: false, error: `Invalid limits.${field}` });
        }
        teacher.limits[field] = Math.floor(raw);
      }
    }
  }

  if (typeof isPaid === "boolean") teacher.isPaid = isPaid;
  if (typeof isSuspended === "boolean") teacher.isSuspended = isSuspended;

  await teacher.save();

  return res.json({
    ok: true,
    data: {
      _id: String(teacher._id),
      isPaid: teacher.isPaid,
      isSuspended: teacher.isSuspended,
      limits: teacher.limits,
    },
  });
});
