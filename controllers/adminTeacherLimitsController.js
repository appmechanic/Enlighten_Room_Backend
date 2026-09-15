import asyncHandler from "express-async-handler";
import mongoose from "mongoose";
import User from "../models/user.js";
import Subscription from "../models/SubscriptionModel.js";
import "../models/PlanModel.js";
import {
  getTeacherMonthUsage,
  currentMonthKey,
  touchUsageResetAt,
} from "../utils/teacherUsage.js";

// GET /api/admin/teachers/limits?monthKey=YYYY-MM&search=&limit=&skip=
// Paginated list of teachers with their active-plan snapshot + current-month
// usage across every quota category. Limits are derived from the teacher's
// Subscription → Plan.limits (with a Free-tier fallback); there is no
// per-teacher override — admins tune caps by editing the Plan itself.
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
      .select("firstName lastName email userName isPaid isSuspended stripeCustomerId createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
  ]);

  const teacherIds = teachers.map((t) => t._id);
  const subs = await Subscription.find({
    userId: { $in: teacherIds },
    status: "active",
  })
    .populate({ path: "planType", select: "name planType planCategory" })
    .lean();
  const subByTeacher = new Map(
    subs.map((s) => [String(s.userId), s])
  );

  const usageByTeacher = await Promise.all(
    teachers.map((t) => getTeacherMonthUsage(t._id, monthKey))
  );

  const rows = teachers.map((t, i) => {
    const sub = subByTeacher.get(String(t._id));
    const plan = sub?.planType || null;
    return {
      _id: String(t._id),
      firstName: t.firstName || "",
      lastName: t.lastName || "",
      email: t.email || "",
      userName: t.userName || "",
      isPaid: !!t.isPaid,
      isSuspended: !!t.isSuspended,
      stripeCustomerId: t.stripeCustomerId || "",
      createdAt: t.createdAt,
      plan: plan
        ? {
            _id: String(plan._id),
            name: plan.name,
            planType: plan.planType,
            planCategory: plan.planCategory || null,
          }
        : null,
      usage: usageByTeacher[i],
    };
  });

  return res.json({
    ok: true,
    data: { rows, total, limit, skip, monthKey },
  });
});

// POST /api/admin/teachers/:id/reset-usage
// Bumps Subscription.usageResetAt=now so every monthly counter reads 0
// from this moment. Cumulative counters (classrooms, students, teachers,
// storage) are untouched — they reflect current state, not history.
export const resetTeacherUsage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ ok: false, error: "Invalid teacher id" });
  }
  const teacher = await User.findById(id).select("_id userRole").lean();
  if (!teacher || teacher.userRole !== "teacher") {
    return res.status(404).json({ ok: false, error: "Teacher not found" });
  }
  const updated = await touchUsageResetAt(id);
  if (!updated) {
    return res.status(409).json({
      ok: false,
      error: "No active subscription for this teacher",
    });
  }
  return res.json({
    ok: true,
    data: { _id: String(teacher._id), usageResetAt: updated.usageResetAt },
  });
});
