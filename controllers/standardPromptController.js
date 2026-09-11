import asyncHandler from "express-async-handler";
import StandardPrompt from "../models/standardPromptModel.js";
import ClassworkModel from "../models/ClassworkModel.js";
import { invalidateAiConfigCache } from "../utils/aiConfig.js";
import { warmClassworkFeedbackCache } from "../utils/geminiClassworkFeedback.js";
import { resolveTeacherIdForRoom } from "./classworkController.js";
import {
  buildSeedPatch,
  getStandardPromptDefaults,
  AI_HINT_PROMPT_SECTION_DEFAULTS,
  REPORT_PROMPT_SECTION_DEFAULTS,
} from "../config/standardPromptDefaults.js";

const GLOBAL_KEY = "global";

// Admin's AI hint prompt is edited as sub-fields in the UI but stored as
// both an array (aiHintPromptSections) and a joined string (aiHintPrompt) so
// older callers reading the joined string keep working. Section count is
// driven by the defaults array so adding a new section only requires an edit
// there + on the React side.
const AI_HINT_SECTION_COUNT = AI_HINT_PROMPT_SECTION_DEFAULTS.length;
const REPORT_SECTION_COUNT = REPORT_PROMPT_SECTION_DEFAULTS.length;
const JOIN_SEPARATOR = "\n\n";

function normalizeSections(input, count) {
  const arr = Array.isArray(input) ? input : [];
  return Array.from({ length: count }, (_, i) =>
    typeof arr[i] === "string" ? arr[i].trim() : ""
  );
}

function joinSections(sections) {
  return sections.filter((s) => s.length > 0).join(JOIN_SEPARATOR);
}

// After an admin prompt edit every Gemini explicit-cache entry becomes
// unreachable because its systemInstruction digest no longer matches.
// Proactively re-warm the caches for questions created in the last 24h so
// the first student submission after the edit doesn't pay the
// caches.create round-trip. Fire-and-forget; the warmer swallows failures.
async function rewarmRecentClassworkCaches() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await ClassworkModel.find(
      { createdAt: { $gte: since } },
      { id: 1, roomId: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    if (recent.length === 0) {
      console.log("[StandardPrompt] rewarm: no recent classwork questions");
      return;
    }
    // Dedup teacherId lookup by roomId — all questions in a session share it.
    const roomIds = [...new Set(recent.map((q) => q.roomId).filter(Boolean))];
    const teacherByRoom = new Map();
    await Promise.all(
      roomIds.map(async (roomId) => {
        const teacherId = await resolveTeacherIdForRoom(roomId);
        if (teacherId) teacherByRoom.set(roomId, String(teacherId));
      }),
    );
    let fired = 0;
    for (const q of recent) {
      const teacherId = teacherByRoom.get(q.roomId);
      if (!teacherId || !q.id) continue;
      warmClassworkFeedbackCache({
        teacherId,
        questionId: q.id,
        standardSolution: "",
      }).catch(() => {});
      fired++;
    }
    console.log(
      `[StandardPrompt] rewarm: fired ${fired}/${recent.length} warm calls (${roomIds.length} rooms)`,
    );
  } catch (err) {
    console.warn(
      "[StandardPrompt] rewarm after prompt edit failed:",
      err?.message || err,
    );
  }
}

// Idempotently backfill any empty StandardPrompt field with its default. Runs
// on every admin GET (cheap: no-op when nothing is missing) and from
// aiConfig.loadFromDb on cache-miss so the first AI call after a fresh
// install also triggers seeding. Never overwrites admin edits.
export async function seedStandardPromptIfMissing() {
  const doc = await StandardPrompt.findOne({ key: GLOBAL_KEY }).lean();
  const patch = buildSeedPatch(doc);
  if (!patch) return doc;
  const updated = await StandardPrompt.findOneAndUpdate(
    { key: GLOBAL_KEY },
    patch,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  return updated;
}

function serializeDoc(doc) {
  return {
    aiHintPrompt: doc?.aiHintPrompt || "",
    aiHintPromptSections: normalizeSections(
      doc?.aiHintPromptSections,
      AI_HINT_SECTION_COUNT
    ),
    reportPrompt: doc?.reportPrompt || "",
    reportPromptSections: normalizeSections(
      doc?.reportPromptSections,
      REPORT_SECTION_COUNT
    ),
    emailPrompt: doc?.emailPrompt || "",
    creatingAssignmentPrompt: doc?.creatingAssignmentPrompt || "",
    models: {
      default: doc?.models?.default || "",
      fallback: doc?.models?.fallback || "",
      image: doc?.models?.image || "",
    },
    retry: doc?.retry || {},
    tuning: doc?.tuning || {},
    directives: doc?.directives || {},
    updatedAt: doc?.updatedAt || null,
  };
}

export const getStandardPrompts = asyncHandler(async (req, res) => {
  const doc = await seedStandardPromptIfMissing();
  return res.json({ ok: true, data: serializeDoc(doc) });
});

// Read-only endpoint returning the canonical defaults straight from the
// defaults module. Powers the React "Reset to default" buttons — the admin
// UI no longer ships its own copy of the canonical text.
export const getStandardPromptDefaultsHandler = asyncHandler(async (req, res) => {
  return res.json({ ok: true, data: getStandardPromptDefaults() });
});

export const upsertStandardPrompts = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const {
    aiHintPromptSections,
    reportPromptSections,
    reportPrompt,
    emailPrompt,
    creatingAssignmentPrompt,
    models,
    retry,
    tuning,
    directives,
  } = req.body || {};

  const aiHintSections = normalizeSections(
    aiHintPromptSections,
    AI_HINT_SECTION_COUNT
  );
  const aiHintJoined = joinSections(aiHintSections);

  // When the admin posts reportPromptSections, the joined-string mirror is
  // derived from them. Fall back to the body's reportPrompt only if the
  // sectioned array wasn't sent (e.g. older client).
  const reportSections = normalizeSections(
    reportPromptSections,
    REPORT_SECTION_COUNT
  );
  const reportJoined = Array.isArray(reportPromptSections)
    ? joinSections(reportSections)
    : (reportPrompt || "").trim();

  const next = {
    aiHintPrompt: aiHintJoined,
    aiHintPromptSections: aiHintSections,
    reportPrompt: reportJoined,
    reportPromptSections: reportSections,
    emailPrompt: (emailPrompt || "").trim(),
    creatingAssignmentPrompt: (creatingAssignmentPrompt || "").trim(),
    updatedBy: userId || null,
  };

  if (models && typeof models === "object") {
    next.models = {
      default: typeof models.default === "string" ? models.default.trim() : "",
      fallback: typeof models.fallback === "string" ? models.fallback.trim() : "",
      image: typeof models.image === "string" ? models.image.trim() : "",
    };
  }
  if (retry && typeof retry === "object") next.retry = retry;
  if (tuning && typeof tuning === "object") next.tuning = tuning;
  if (directives && typeof directives === "object") {
    next.directives = Object.fromEntries(
      Object.entries(directives).filter(([, v]) => typeof v === "string")
    );
  }

  const doc = await StandardPrompt.findOneAndUpdate(
    { key: GLOBAL_KEY },
    next,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  invalidateAiConfigCache();
  // Fire-and-forget: the admin's response ships instantly; recent classwork
  // questions get their Gemini explicit-cache entries pre-warmed under the
  // new digest so the first submission after this edit doesn't pay the
  // caches.create round-trip.
  rewarmRecentClassworkCaches();

  return res.json({
    ok: true,
    message: "Standard prompts saved successfully",
    data: serializeDoc(doc),
  });
});
