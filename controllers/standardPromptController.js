import asyncHandler from "express-async-handler";
import StandardPrompt from "../models/standardPromptModel.js";

const GLOBAL_KEY = "global";

// Admin's AI hint prompt is edited as 10 sub-fields in the UI but stored as
// both an array (aiHintPromptSections) and a joined string (aiHintPrompt) so
// older callers reading the joined string keep working.
const AI_HINT_SECTION_COUNT = 10;
const AI_HINT_JOIN_SEPARATOR = "\n\n";

function normalizeSections(input) {
  const arr = Array.isArray(input) ? input : [];
  return Array.from({ length: AI_HINT_SECTION_COUNT }, (_, i) =>
    typeof arr[i] === "string" ? arr[i].trim() : ""
  );
}

function sectionsFromDoc(doc) {
  if (
    Array.isArray(doc?.aiHintPromptSections) &&
    doc.aiHintPromptSections.length === AI_HINT_SECTION_COUNT
  ) {
    return normalizeSections(doc.aiHintPromptSections);
  }
  // No structured array stored yet — drop the legacy single string into the
  // first sub-field so the admin can split it across sections on next save.
  const legacy = (doc?.aiHintPrompt || "").trim();
  const sections = Array.from({ length: AI_HINT_SECTION_COUNT }, () => "");
  if (legacy) sections[0] = legacy;
  return sections;
}

function joinSections(sections) {
  return sections.filter((s) => s.length > 0).join(AI_HINT_JOIN_SEPARATOR);
}

export const getStandardPrompts = asyncHandler(async (req, res) => {
  const doc = await StandardPrompt.findOne({ key: GLOBAL_KEY }).lean();
  const sections = sectionsFromDoc(doc);

  return res.json({
    ok: true,
    data: {
      aiHintPrompt: doc?.aiHintPrompt || joinSections(sections),
      aiHintPromptSections: sections,
      reportPrompt: doc?.reportPrompt || "",
      emailPrompt: doc?.emailPrompt || "",
      updatedAt: doc?.updatedAt || null,
    },
  });
});

export const upsertStandardPrompts = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { aiHintPromptSections, reportPrompt, emailPrompt } = req.body || {};

  const sections = normalizeSections(aiHintPromptSections);
  const joined = joinSections(sections);

  const next = {
    aiHintPrompt: joined,
    aiHintPromptSections: sections,
    reportPrompt: (reportPrompt || "").trim(),
    emailPrompt: (emailPrompt || "").trim(),
    updatedBy: userId || null,
  };

  const doc = await StandardPrompt.findOneAndUpdate(
    { key: GLOBAL_KEY },
    next,
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return res.json({
    ok: true,
    message: "Standard prompts saved successfully",
    data: {
      aiHintPrompt: doc?.aiHintPrompt || joined,
      aiHintPromptSections: sectionsFromDoc(doc),
      reportPrompt: doc?.reportPrompt || "",
      emailPrompt: doc?.emailPrompt || "",
      updatedAt: doc?.updatedAt || null,
    },
  });
});
