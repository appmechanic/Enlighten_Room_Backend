import crypto from "crypto";

// Response-level cache for identical (teacher, question, normalizedAnswer)
// submissions. Sits IN FRONT of Gemini so repeated wrong answers, accidental
// double-taps, and "checking…" retries return the previous feedback without
// spending any tokens. Complements — does not replace — the Gemini explicit
// prompt cache in classworkGeminiCache.js.
//
// Bounded LRU with per-entry TTL. In-process only; multi-instance
// deployments get one cache per worker — that's fine for a "same student
// re-submits within seconds" workflow, which is the target.
//
// Not cached: image-only submissions (answer text empty), errored responses,
// or when either teacherId or questionId is missing.

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500;

// key -> { value, expiresAt }
// Map preserves insertion order, which we use as an LRU proxy: on get we
// re-insert to move the entry to the tail; on eviction we drop the head.
const cache = new Map();

function evictExpiredAndOversized() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expiresAt <= now) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Deterministic key for a submission. Returns null if we shouldn't cache —
// caller can safely treat that as "cache disabled for this call".
export function classworkResponseCacheKey({ teacherId, questionId, normalizedAnswer }) {
  if (!teacherId || !questionId) return null;
  if (typeof normalizedAnswer !== "string" || !normalizedAnswer.trim()) return null;
  const answerHash = crypto
    .createHash("sha1")
    .update(normalizedAnswer.trim())
    .digest("hex")
    .slice(0, 16);
  return `${String(teacherId)}::${String(questionId)}::${answerHash}`;
}

export function getCachedClassworkResponse(key) {
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

export function setCachedClassworkResponse(key, value) {
  if (!key || !value) return;
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  evictExpiredAndOversized();
}

// Wipe every entry belonging to a question — call when the question is
// deleted or its correctAnswer/solution changes materially.
export function invalidateClassworkResponseCacheByQuestion(questionId) {
  if (!questionId) return;
  const marker = `::${questionId}::`;
  for (const key of cache.keys()) {
    if (key.includes(marker)) cache.delete(key);
  }
}

export function classworkResponseCacheStats() {
  return { size: cache.size, max: MAX_ENTRIES, ttlMs: TTL_MS };
}
