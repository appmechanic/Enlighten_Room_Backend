import asyncHandler from "express-async-handler";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";

function isTeacherOrTutor(role) {
  return role === "teacher" || role === "tutor";
}

/**
 * GET /api/teacher/ai-config/me
 * Get current teacher/tutor AI config (prompt + style + features)
 */
export const getMyAIConfig = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const role = req.user?.userRole;

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Auth required" });
  }

  if (!isTeacherOrTutor(role)) {
    return res.status(403).json({
      ok: false,
      message: "Only teachers/tutors can use this setting",
    });
  }

  const doc = await TeacherAIConfig.findOne({ user: userId });

  return res.json({
    ok: true,
    data: doc || null,
  });
});

/**
 * POST /api/teacher/ai-config
 * Create / update AI config (UP-SERT)
 * body: { prompt: string, style?: string, features?: string }
 */
export const upsertMyAIConfig = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const role = req.user?.userRole;
  const {
    prompt,
    assignmentPrompt,
    reportPrompt,
    style = "",
    features = "",
  } = req.body || {};

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Auth required" });
  }

  if (!isTeacherOrTutor(role)) {
    return res.status(403).json({
      ok: false,
      message: "Only teachers/tutors can use this setting",
    });
  }

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res
      .status(400)
      .json({ ok: false, message: "prompt is required (non-empty string)" });
  }

  const doc = await TeacherAIConfig.findOneAndUpdate(
    { user: userId },
    {
      prompt: prompt.trim(),
      assignmentPrompt: (assignmentPrompt || "").trim(),
      reportPrompt: (reportPrompt || "").trim(),
      style: (style || "").trim(),
      features: (features || "").trim(),
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  );

  return res.json({
    ok: true,
    message: "AI prompt, style & features saved successfully",
    data: doc,
  });
});

/**
 * DELETE /api/teacher/ai-config/me
 * Remove custom config (fallback to default AI behaviour)
 */
export const deleteMyAIConfig = asyncHandler(async (req, res) => {
  const userId = req.user?._id;
  const role = req.user?.userRole;

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Auth required" });
  }

  if (!isTeacherOrTutor(role)) {
    return res.status(403).json({
      ok: false,
      message: "Only teachers/tutors can use this setting",
    });
  }

  await TeacherAIConfig.findOneAndDelete({ user: userId });

  return res.json({
    ok: true,
    message:
      "Custom AI config removed. System will use default prompts & styles.",
  });
});
