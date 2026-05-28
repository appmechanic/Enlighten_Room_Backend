import asyncHandler from "express-async-handler";
import StandardPrompt from "../models/standardPromptModel.js";

const GLOBAL_KEY = "global";

export const getStandardPrompts = asyncHandler(async (req, res) => {
  const doc = await StandardPrompt.findOne({ key: GLOBAL_KEY }).lean();

  return res.json({
    ok: true,
    data: {
      aiHintPrompt: doc?.aiHintPrompt || "",
      reportPrompt: doc?.reportPrompt || "",
      emailPrompt: doc?.emailPrompt || "",
      updatedAt: doc?.updatedAt || null,
    },
  });
});

export const upsertStandardPrompts = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const { aiHintPrompt, reportPrompt, emailPrompt } = req.body || {};

  const next = {
    aiHintPrompt: (aiHintPrompt || "").trim(),
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
      aiHintPrompt: doc?.aiHintPrompt || "",
      reportPrompt: doc?.reportPrompt || "",
      emailPrompt: doc?.emailPrompt || "",
      updatedAt: doc?.updatedAt || null,
    },
  });
});
