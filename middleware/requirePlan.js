// middleware/requirePlan.js
//
// Two building blocks for plan-based gating:
//
//   requirePlanLimit(dimension, countCurrent)
//     Blocks the request when a caller's plan cap is at/over used. `dimension`
//     is a key on Plan.limits (maxStudents, maxSessionsPerMonth, …).
//     `countCurrent(req)` returns the current usage — passed in from the
//     controller because "current classrooms" vs. "sessions this month"
//     have wildly different queries and shouldn't live here.
//
//   requireFeatureFlag(flag)
//     Blocks when Plan.featureFlags[flag] is falsy. For binary gates like
//     AI classwork or Excel import.
//
// Callers must have already run an auth middleware (req.user is required).
// Missing subscription is treated as the free tier — deny the gated
// dimension rather than silently allow.
import Subscription from "../models/SubscriptionModel.js";
import Plan from "../models/PlanModel.js";

async function loadPlanForUser(userId) {
  const sub = await Subscription.findOne({
    userId,
    status: "active",
  })
    .populate("planType")
    .lean();
  return sub?.planType || null;
}

export function requirePlanLimit(dimension, countCurrent) {
  if (typeof dimension !== "string") {
    throw new Error("requirePlanLimit: dimension must be a string");
  }
  if (typeof countCurrent !== "function") {
    throw new Error("requirePlanLimit: countCurrent must be a function");
  }
  return async (req, res, next) => {
    try {
      if (!req.user?._id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const plan = await loadPlanForUser(req.user._id);
      const cap = plan?.limits?.[dimension];
      // null/undefined cap → unlimited. Explicit 0 still enforces (denies).
      if (cap == null) return next();
      const current = await countCurrent(req);
      if (Number(current) >= Number(cap)) {
        return res.status(402).json({
          error: "Plan limit reached",
          dimension,
          limit: cap,
          current,
          upgradeUrl: "/pricing",
        });
      }
      return next();
    } catch (err) {
      console.error("requirePlanLimit error:", err);
      return res.status(500).json({ error: "Plan check failed" });
    }
  };
}

export function requireFeatureFlag(flag) {
  return async (req, res, next) => {
    try {
      if (!req.user?._id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const plan = await loadPlanForUser(req.user._id);
      if (!plan?.featureFlags?.[flag]) {
        return res.status(402).json({
          error: "Feature not included in your plan",
          feature: flag,
          upgradeUrl: "/pricing",
        });
      }
      return next();
    } catch (err) {
      console.error("requireFeatureFlag error:", err);
      return res.status(500).json({ error: "Feature check failed" });
    }
  };
}
