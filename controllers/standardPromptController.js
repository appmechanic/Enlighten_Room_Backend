import asyncHandler from "express-async-handler";
import StandardPrompt from "../models/standardPromptModel.js";
import { invalidateAiModelsCache } from "../utils/aiModels.js";

const GLOBAL_KEY = "global";

// Admin's AI hint prompt is edited as 11 sub-fields in the UI but stored as
// both an array (aiHintPromptSections) and a joined string (aiHintPrompt) so
// older callers reading the joined string keep working. Section 11
// (commonMistake) was added after the original 10; older docs stored 10
// sections and are padded automatically by normalizeSections below.
const AI_HINT_SECTION_COUNT = 11;
// Class Report prompt mirrors the same pattern with 5 sub-fields.
const REPORT_SECTION_COUNT = 5;
const JOIN_SEPARATOR = "\n\n";

function normalizeSections(input, count) {
  const arr = Array.isArray(input) ? input : [];
  return Array.from({ length: count }, (_, i) =>
    typeof arr[i] === "string" ? arr[i].trim() : ""
  );
}

function aiHintSectionsFromDoc(doc) {
  if (
    Array.isArray(doc?.aiHintPromptSections) &&
    doc.aiHintPromptSections.length > 0
  ) {
    // Pad/truncate to current count so a docs with 10 stored sections still
    // load cleanly after the 11th section was added.
    return normalizeSections(doc.aiHintPromptSections, AI_HINT_SECTION_COUNT);
  }
  // No structured array stored yet — drop the legacy single string into the
  // first sub-field so the admin can split it across sections on next save.
  const legacy = (doc?.aiHintPrompt || "").trim();
  const sections = Array.from({ length: AI_HINT_SECTION_COUNT }, () => "");
  if (legacy) sections[0] = legacy;
  return sections;
}

function reportSectionsFromDoc(doc) {
  if (
    Array.isArray(doc?.reportPromptSections) &&
    doc.reportPromptSections.length === REPORT_SECTION_COUNT
  ) {
    return normalizeSections(doc.reportPromptSections, REPORT_SECTION_COUNT);
  }
  // Same legacy bridge as aiHint: if only the flat reportPrompt was stored,
  // surface it in the first sub-field for the admin to split.
  const legacy = (doc?.reportPrompt || "").trim();
  const sections = Array.from({ length: REPORT_SECTION_COUNT }, () => "");
  if (legacy) sections[0] = legacy;
  return sections;
}

function joinSections(sections) {
  return sections.filter((s) => s.length > 0).join(JOIN_SEPARATOR);
}

export const getStandardPrompts = asyncHandler(async (req, res) => {
  const doc = await StandardPrompt.findOne({ key: GLOBAL_KEY }).lean();
  const aiHintSections = aiHintSectionsFromDoc(doc);
  const reportSections = reportSectionsFromDoc(doc);

  return res.json({
    ok: true,
    data: {
      aiHintPrompt: doc?.aiHintPrompt || joinSections(aiHintSections),
      aiHintPromptSections: aiHintSections,
      reportPrompt: doc?.reportPrompt || joinSections(reportSections),
      reportPromptSections: reportSections,
      emailPrompt: doc?.emailPrompt || "",
      creatingAssignmentPrompt: doc?.creatingAssignmentPrompt || "",
      models: {
        default: doc?.models?.default || "",
        fallback: doc?.models?.fallback || "",
        image: doc?.models?.image || "",
      },
      updatedAt: doc?.updatedAt || null,
    },
  });
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
  } = req.body || {};

  const aiHintSections = normalizeSections(
    aiHintPromptSections,
    AI_HINT_SECTION_COUNT
  );
  const aiHintJoined = joinSections(aiHintSections);

  // When the admin posts reportPromptSections, the joined-string mirror is
  // derived from them — admins editing in the new sectioned UI never touch
  // the legacy single-field reportPrompt. Fall back to the body's
  // reportPrompt only if the sectioned array wasn't sent (e.g. older client).
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

  // Only overwrite the models field if the client actually sent one — older
  // clients don't know about it and would otherwise wipe the config on save.
  if (models && typeof models === "object") {
    next.models = {
      default: typeof models.default === "string" ? models.default.trim() : "",
      fallback: typeof models.fallback === "string" ? models.fallback.trim() : "",
      image: typeof models.image === "string" ? models.image.trim() : "",
    };
  }

  const doc = await StandardPrompt.findOneAndUpdate(
    { key: GLOBAL_KEY },
    next,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // Drop the in-memory model cache so the next AI call sees the new value
  // instead of waiting up to 60s for the TTL.
  invalidateAiModelsCache();

  return res.json({
    ok: true,
    message: "Standard prompts saved successfully",
    data: {
      aiHintPrompt: doc?.aiHintPrompt || aiHintJoined,
      aiHintPromptSections: aiHintSectionsFromDoc(doc),
      reportPrompt: doc?.reportPrompt || reportJoined,
      reportPromptSections: reportSectionsFromDoc(doc),
      emailPrompt: doc?.emailPrompt || "",
      creatingAssignmentPrompt: doc?.creatingAssignmentPrompt || "",
      models: {
        default: doc?.models?.default || "",
        fallback: doc?.models?.fallback || "",
        image: doc?.models?.image || "",
      },
      updatedAt: doc?.updatedAt || null,
    },
  });
});
