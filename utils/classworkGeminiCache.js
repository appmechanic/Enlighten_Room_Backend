import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { getAiTuning } from "./aiConfig.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// key -> { cacheName, expiresAt } | { createPromise }
// Registry lives for the lifetime of the Node process. TTL defaults to
// tuning.cache.geminiExplicitCacheTtlSeconds (1h) — long enough to span a
// full class, short enough that a re-created question inherits a fresh cache
// within the hour.
const cacheRegistry = new Map();

const MIN_SYSTEM_INSTRUCTION_CHARS = 400;

function computeKey({ model, teacherId, questionId, systemInstruction }) {
  const digest = crypto
    .createHash("sha1")
    .update(systemInstruction || "")
    .digest("hex")
    .slice(0, 16);
  return `${model}::${teacherId || "-"}::${questionId || "-"}::${digest}`;
}

async function resolveTtlSeconds() {
  try {
    const cacheTuning = await getAiTuning("cache");
    const raw = Number(cacheTuning?.geminiExplicitCacheTtlSeconds);
    return Math.max(60, Number.isFinite(raw) && raw > 0 ? raw : 3600);
  } catch {
    return 3600;
  }
}

// Returns { name, ok, reused } — matches the shape callers use to decide
// whether to attach `cachedContent` on the Gemini config or fall through to
// the inline `systemInstruction` path.
export async function getOrCreateClassworkFeedbackCache({
  model,
  teacherId,
  questionId,
  systemInstruction,
  tag,
}) {
  if (
    !model ||
    !questionId ||
    !systemInstruction ||
    systemInstruction.length < MIN_SYSTEM_INSTRUCTION_CHARS
  ) {
    return { name: "", ok: false, reused: false, reason: "skip-small" };
  }

  const key = computeKey({ model, teacherId, questionId, systemInstruction });
  const now = Date.now();
  const existing = cacheRegistry.get(key);

  if (existing?.createPromise) {
    return existing.createPromise;
  }
  if (existing?.cacheName && existing.expiresAt > now + 30_000) {
    return { name: existing.cacheName, ok: true, reused: true };
  }
  if (existing) {
    cacheRegistry.delete(key);
  }

  const ttlSeconds = await resolveTtlSeconds();
  const createPromise = (async () => {
    try {
      const cache = await ai.caches.create({
        model,
        config: {
          systemInstruction,
          ttl: `${ttlSeconds}s`,
        },
      });
      const cacheName = cache?.name || "";
      if (!cacheName) {
        cacheRegistry.delete(key);
        return { name: "", ok: false, reused: false, reason: "no-name" };
      }
      cacheRegistry.set(key, {
        cacheName,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return { name: cacheName, ok: true, reused: false };
    } catch (err) {
      // Most common failure: systemInstruction under the model's minimum
      // cache-token threshold (~1024 for gemini-2.5-flash). Fall back to
      // inlining the systemInstruction on this call and don't retry the
      // create until the entry naturally rotates.
      console.warn(
        `[${tag || "ClassworkFeedbackCache"}] caches.create failed — falling back to inline systemInstruction:`,
        err?.message || err,
      );
      cacheRegistry.delete(key);
      return { name: "", ok: false, reused: false, reason: "create-failed" };
    }
  })();

  cacheRegistry.set(key, { createPromise });
  return createPromise;
}

export function invalidateClassworkFeedbackCacheByQuestion(questionId) {
  if (!questionId) return;
  const marker = `::${questionId}::`;
  const toDelete = [];
  for (const [key, entry] of cacheRegistry.entries()) {
    if (key.includes(marker)) toDelete.push([key, entry]);
  }
  toDelete.forEach(([key, entry]) => {
    cacheRegistry.delete(key);
    if (entry?.cacheName) {
      ai.caches
        .delete({ name: entry.cacheName })
        .catch((err) =>
          console.warn(
            `[ClassworkFeedbackCache] delete failed for ${entry.cacheName}:`,
            err?.message || err,
          ),
        );
    }
  });
}
