// Simple in-memory cooldown map: { key: lastSentMs }
const lastSentMap = new Map();
const COOLDOWN_MS = 60 * 1000; // 60s

export function focusCooldown(req, res, next) {
  try {
    const { studentId, reason = "tab_blur" } = req.body || {};
    const key = `${studentId}:${reason}`;
    const now = Date.now();
    const last = lastSentMap.get(key) || 0;

    if (now - last < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (now - last)) / 1000);
      return res.status(429).json({
        ok: false,
        message: `Alert recently sent. Try again in ~${wait}s.`,
      });
    }

    lastSentMap.set(key, now);
    return next();
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, message: "Cooldown check failed." });
  }
}
