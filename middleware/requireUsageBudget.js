// requireUsageBudget(category, [resolveTeacherId])
//
// Blocks a request when the owning teacher has already hit or passed the
// monthly cap for the given category. Categories are the strings enumerated
// in utils/teacherUsage.js USAGE_CATEGORIES.
//
// Most endpoints are called BY the teacher (start lesson, send report, upload,
// generate assignment) — in that case `req.user._id` IS the teacher, and no
// resolver is needed.
//
// A few endpoints are called by a student on behalf of a teacher (classwork
// AI hint on student submit). Those must pass a `resolveTeacherId(req)` that
// looks up the owning teacher (typically via roomId → Classroom.teacherId).
//
// On block: HTTP 402 with a machine-readable body — the React/FrontEnd 402
// interceptor keys off `error === "LIMIT_REACHED"` to open the upgrade modal.
import { checkUsageBudget } from "../utils/teacherUsage.js";

// Thrown by assertUsageBudget so controllers that call AI utilities directly
// (rather than sitting behind requireUsageBudget) can catch a well-typed error
// and translate it to the same 402 shape the middleware returns.
export class LimitReachedError extends Error {
  constructor(category, used, limit) {
    super(`LIMIT_REACHED:${category} ${used}/${limit}`);
    this.name = "LimitReachedError";
    this.category = category;
    this.used = used;
    this.limit = limit;
    this.status = 402;
  }
}

// Inline variant of requireUsageBudget for callers that already have teacherId
// in hand. Throws LimitReachedError when the cap is hit; no-ops when teacherId
// is falsy so background/student-triggered paths degrade to "count usage but
// don't block" rather than 500ing.
export async function assertUsageBudget(teacherId, category) {
  if (!teacherId) return;
  const { ok, used, limit } = await checkUsageBudget(teacherId, category);
  if (!ok) throw new LimitReachedError(category, used, limit);
}

// Convenience for turning a LimitReachedError into a 402 response body.
export function limitReachedResponseBody(err) {
  return {
    error: "LIMIT_REACHED",
    category: err.category,
    used: err.used,
    limit: err.limit,
    message: `Monthly ${err.category} limit reached (${err.used}/${err.limit}). Contact your admin to raise this limit.`,
  };
}

export function requireUsageBudget(category, resolveTeacherId) {
  return async (req, res, next) => {
    try {
      const teacherId =
        typeof resolveTeacherId === "function"
          ? await resolveTeacherId(req)
          : req.user?._id || req.user?.id;

      if (!teacherId) {
        // Can't attribute the action to a teacher — allow through rather than
        // 500. Enforcement is best-effort; the reader endpoints still count
        // the usage after the fact.
        return next();
      }

      const { ok, used, limit } = await checkUsageBudget(teacherId, category);
      if (!ok) {
        return res.status(402).json({
          error: "LIMIT_REACHED",
          category,
          used,
          limit,
          message: `Monthly ${category} limit reached (${used}/${limit}). Contact your admin to raise this limit.`,
        });
      }
      return next();
    } catch (err) {
      console.error(`requireUsageBudget[${category}] error:`, err);
      return res.status(500).json({ error: "Usage check failed" });
    }
  };
}
