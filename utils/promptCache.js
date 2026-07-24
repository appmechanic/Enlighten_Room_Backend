import crypto from "crypto";
import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";

// Tiny in-process TTL cache for the two documents every classwork
// submission needs to load from Mongo: the global StandardPrompt and the
// per-teacher TeacherAIConfig. Both change rarely (admin edits + teacher
// settings) but are read on every submission — during a live class this
// is thousands of reads per minute of an effectively-immutable value.
//
// Kept dependency-free on purpose. If we ever run multiple API nodes and
// want cross-node cache coherence, swap this out for Redis — the
// call-site API stays the same.

const STANDARD_PROMPT_TTL_MS = 60 * 1000;
const TEACHER_PROMPT_TTL_MS = 60 * 1000;

const standardPromptCache = { entry: null };
const teacherPromptCache = new Map();

function hashText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return crypto.createHash("sha1").update(trimmed).digest("hex");
}

async function loadStandardPromptFresh() {
  const doc = await StandardPrompt.findOne({ key: "global" }).lean();
  const text = (doc?.aiHintPrompt || "").trim();
  return { text, hash: hashText(text) };
}

async function loadTeacherPromptFresh(teacherId) {
  const config = await TeacherAIConfig.findOne({ user: teacherId })
    .select("prompt")
    .lean();
  return (config?.prompt || "").trim();
}

export async function getStandardPromptCached() {
  const now = Date.now();
  const cached = standardPromptCache.entry;
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const value = await loadStandardPromptFresh();
    standardPromptCache.entry = {
      value,
      expiresAt: now + STANDARD_PROMPT_TTL_MS,
    };
    return value;
  } catch (err) {
    console.error("[promptCache] Failed to load StandardPrompt:", err);
    if (cached) return cached.value;
    return { text: "", hash: "" };
  }
}

export async function getTeacherPromptCached(teacherId) {
  if (!teacherId) return "";
  const key = String(teacherId);
  const now = Date.now();
  const cached = teacherPromptCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const value = await loadTeacherPromptFresh(key);
    teacherPromptCache.set(key, {
      value,
      expiresAt: now + TEACHER_PROMPT_TTL_MS,
    });
    return value;
  } catch (err) {
    console.error("[promptCache] Failed to load TeacherAIConfig:", err);
    if (cached) return cached.value;
    return "";
  }
}

// Test-only helper — invalidate everything so unit tests don't leak state.
export function _resetPromptCacheForTests() {
  standardPromptCache.entry = null;
  teacherPromptCache.clear();
}
