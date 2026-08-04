// In-process answer-hash dedup cache for classwork AI feedback.
//
// Two students who submit the same normalized answer to the same question
// receive the same Gemini feedback — the model output is deterministic
// enough for that shape (same question, same answer, same standard prompt,
// same cached solution). Instead of paying a fresh Gemini call for every
// duplicate, we hash the normalized answer and reuse the first result.
//
// Not cached:
// - Handwriting / image-format answers (the image bytes differ per student
//   even when normalizeAnswerText collapses to the same generic string).
// - Follow-up submissions (question text varies per interaction thread).
// - Empty answers (nothing meaningful to key on).
//
// The cache key includes the ASK/TELL parity of the submission number so
// the pedagogy alternation is preserved: two students on attempt 1 (both
// ASK-mode) share a cached hint, but a student's attempt 2 (TELL-mode)
// with the same wrong answer gets a fresh Gemini call — the response
// shape is genuinely different.
//
// Entries expire after CLASSWORK_FEEDBACK_CACHE_TTL_MS. Bank capped at
// CLASSWORK_FEEDBACK_CACHE_MAX_ENTRIES; oldest entries evicted first
// (Map iteration order is insertion order in Node).

import crypto from "crypto";
import { getAiTuningSync } from "./aiConfig.js";

// TTL and max size come from StandardPrompt.tuning.cache (see aiConfig.js).
// Read via getAiTuningSync to keep the cache write path zero-await; falls
// back to the hardcoded defaults on a cold cache — those match the tuned
// speed-win values (60m / 500 entries).
function cacheLimits() {
  const cfg = getAiTuningSync("cache");
  return {
    ttlMs: Number(cfg?.feedbackTtlMs) > 0 ? Number(cfg.feedbackTtlMs) : 60 * 60 * 1000,
    maxEntries: Number(cfg?.feedbackMaxEntries) > 0 ? Number(cfg.feedbackMaxEntries) : 500,
  };
}

const cache = new Map();

// Formats where the "answer" is really an image (the normalized text is a
// generic placeholder and would collide across every student). Keep in sync
// with getAnswerImageSource in geminiClassworkFeedback.js.
const IMAGE_ANSWER_FORMATS = new Set(["handwriting"]);

function answerHasImage(answer) {
  if (!answer) return false;
  if (typeof answer === "string") return /^data:image\//i.test(answer);
  if (typeof answer === "object") {
    if (typeof answer.imageUrl === "string" && answer.imageUrl.trim()) return true;
    if (answer.type === "image") return true;
  }
  return false;
}

// Returns the answer text used as the cache key material, or null when the
// submission is not eligible for caching. Callers must not build a cache key
// without a non-null return here.
export function fingerprintAnswer({ answer, format, normalizedAnswerText, isFollowUp }) {
  if (isFollowUp) return null;
  if (IMAGE_ANSWER_FORMATS.has(format)) return null;
  if (answerHasImage(answer)) return null;
  const text = typeof normalizedAnswerText === "string"
    ? normalizedAnswerText.trim()
    : "";
  if (!text) return null;
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Cache key = questionId + answerHash + ASK/TELL parity. Parity keeps the
// alternating pedagogy correct: attempt 1 (ASK) and attempt 2 (TELL) for
// the same answer are genuinely different responses.
export function buildCacheKey({ questionId, answerHash, submissionNumber }) {
  if (!questionId || !answerHash) return null;
  const parity = Number.isInteger(Number(submissionNumber))
    && Number(submissionNumber) > 0
      ? Number(submissionNumber) % 2 === 1 ? "ask" : "tell"
      : "none";
  return `${questionId}::${answerHash}::${parity}`;
}

function isFresh(entry, now) {
  return entry && entry.expiresAt > now;
}

function evictExpired(now) {
  for (const [key, entry] of cache) {
    if (!isFresh(entry, now)) cache.delete(key);
    else break; // Map keeps insertion order — everything after is fresher.
  }
}

// Deep clone via JSON so downstream persistence code (which mutates the
// feedback object — e.g. folding standardSolution into the question doc)
// never corrupts the cached copy.
function cloneFeedback(feedback) {
  return JSON.parse(JSON.stringify(feedback));
}

export function getCachedFeedback(key) {
  if (!key) return null;
  const now = Date.now();
  const entry = cache.get(key);
  if (!isFresh(entry, now)) {
    if (entry) cache.delete(key);
    return null;
  }
  return cloneFeedback(entry.feedback);
}

export function setCachedFeedback(key, feedback) {
  if (!key || !feedback) return;
  // Never cache empty hints — that's usually an AI failure we don't want
  // to replay to the next student.
  if (typeof feedback.hintStream !== "string" || !feedback.hintStream.trim()) {
    return;
  }
  const now = Date.now();
  const { ttlMs, maxEntries } = cacheLimits();
  if (cache.size >= maxEntries) {
    evictExpired(now);
    if (cache.size >= maxEntries) {
      // Still full after expiry sweep — drop the oldest entry.
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
  }
  cache.set(key, {
    feedback: cloneFeedback(feedback),
    expiresAt: now + ttlMs,
  });
}

// Test/admin helper — not exported through the barrel.
export function _resetClassworkFeedbackCacheForTests() {
  cache.clear();
}
