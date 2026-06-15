import asyncHandler from "express-async-handler";
import StandardPrompt from "../models/standardPromptModel.js";
import {
  AI_HINT_SECTION_COUNT,
  assembleAiHintPrompt,
  defaultAiHintSections,
  normalizeAiHintSections,
} from "../utils/aiHintSections.js";

const GLOBAL_KEY = "global";

function sectionsFromDoc(doc) {
  if (
    Array.isArray(doc?.aiHintPromptSections) &&
    doc.aiHintPromptSections.length === AI_HINT_SECTION_COUNT
  ) {
    return normalizeAiHintSections(doc.aiHintPromptSections);
  }
  return defaultAiHintSections();
}

export const getStandardPrompts = asyncHandler(async (req, res) => {
  const doc = await StandardPrompt.findOne({ key: GLOBAL_KEY }).lean();
  const sections = sectionsFromDoc(doc);

  return res.json({
    ok: true,
    data: {
      aiHintPromptSections: sections,
      aiHintPrompt: assembleAiHintPrompt(sections),
      reportPrompt: doc?.reportPrompt || "",
      emailPrompt: doc?.emailPrompt || "",
      updatedAt: doc?.updatedAt || null,
    },
  });
});

export const upsertStandardPrompts = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { aiHintPromptSections, reportPrompt, emailPrompt } = req.body || {};

  const sections = normalizeAiHintSections(aiHintPromptSections);
  const joined = assembleAiHintPrompt(sections);

  const next = {
    aiHintPromptSections: sections,
    aiHintPrompt: joined,
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
      aiHintPromptSections: sectionsFromDoc(doc),
      aiHintPrompt: doc?.aiHintPrompt || joined,
      reportPrompt: doc?.reportPrompt || "",
      emailPrompt: doc?.emailPrompt || "",
      updatedAt: doc?.updatedAt || null,
    },
  });
});
