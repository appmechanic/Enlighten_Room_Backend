// enforceStorageQuota(resolveTeacherId)
//
// Pre-upload guard. Runs BEFORE multer so we don't burn a network round-trip
// pushing a file to DigitalOcean Spaces only to reject it after. Reads
// Content-Length off the request and compares (current + incoming) against
// User.limits.storageBytes.
//
// Content-Length is set by the browser and is trustworthy for multipart
// uploads in practice; a client that forges it just gets an inaccurate
// pre-check and the accurate check happens on the next upload.
import { checkUsageBudget } from "../utils/teacherUsage.js";

export function enforceStorageQuota(resolveTeacherId) {
  return async (req, res, next) => {
    try {
      const teacherId =
        typeof resolveTeacherId === "function"
          ? await resolveTeacherId(req)
          : req.user?._id || req.user?.id;
      if (!teacherId) return next();

      const contentLength = Number(req.headers["content-length"]) || 0;
      const { used, limit } = await checkUsageBudget(
        teacherId,
        "storageBytes"
      );

      if (used + contentLength > limit) {
        return res.status(402).json({
          error: "LIMIT_REACHED",
          category: "storageBytes",
          used,
          limit,
          incomingBytes: contentLength,
          message: `Storage limit reached (${used}/${limit} bytes). Delete old files or ask your admin to raise the limit.`,
        });
      }
      return next();
    } catch (err) {
      console.error("enforceStorageQuota error:", err);
      return res.status(500).json({ error: "Storage check failed" });
    }
  };
}
