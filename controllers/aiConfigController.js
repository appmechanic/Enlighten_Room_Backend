import asyncHandler from "express-async-handler";
import { getAiTuning } from "../utils/aiConfig.js";

// Public read-only projection of the tuning knobs that the browser needs to
// compute a session's default maxOutputTokens (grade bands + language +
// format multipliers). No secrets here — just tuning constants — so no auth.
// React SessionTab and the video app's client.js fetch this at mount and
// cache in memory.
export const getPublicTuning = asyncHandler(async (_req, res) => {
  const [tuning, cache] = await Promise.all([
    getAiTuning(),
    getAiTuning("cache"),
  ]);
  return res.json({
    ok: true,
    data: {
      gradeBands: tuning?.gradeBands || {},
      languageMultiplier: tuning?.languageMultiplier ?? 1.3,
      formatMultiplier: tuning?.formatMultiplier ?? 1.3,
      // Included so future frontend features can respect the same limits.
      feedbackCache: {
        ttlMs: cache?.feedbackTtlMs ?? 60 * 60 * 1000,
      },
    },
  });
});
