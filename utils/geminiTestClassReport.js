import { GoogleGenAI, Type } from "@google/genai";
import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry } from "./aiConfig.js";

// Post-expiry class report for a Test. Aggregates every student's
// per-question feedback (already produced by generateTestFeedback at submit
// time) into a class-level view the teacher can act on. Kept intentionally
// small — this is a summarisation over pre-analysed feedback, not a fresh
// per-answer analysis, so a short prompt + tight schema is enough.
//
// Reuses the same StandardPrompt.reportPromptSections + TeacherAIConfig
// .reportPrompt pair the classwork class report uses, so a teacher who has
// tuned their reporting voice sees it applied to test reports too.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    topDifficulties: { type: Type.ARRAY, items: { type: Type.STRING } },
    suggestedNextSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
    marksDistribution: { type: Type.STRING },
  },
  required: [
    "summary",
    "topDifficulties",
    "suggestedNextSteps",
    "marksDistribution",
  ],
};

async function loadReportPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("reportPromptSections reportPrompt")
      .lean();
    const joined = Array.isArray(doc?.reportPromptSections)
      ? doc.reportPromptSections.filter(Boolean).join("\n\n")
      : "";
    return joined || (doc?.reportPrompt || "").trim();
  } catch (err) {
    console.error("[TestClassReport] Failed to load StandardPrompt:", err);
    return "";
  }
}

async function loadTeacherReportPrompt(teacherId) {
  if (!teacherId) return "";
  try {
    const cfg = await TeacherAIConfig.findOne({ user: teacherId })
      .select("reportPrompt")
      .lean();
    return (cfg?.reportPrompt || "").trim();
  } catch (err) {
    console.error("[TestClassReport] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

// `submissions` is the raw submissions[] array from the TestTaskSchema.
// Each entry carries a rolled-up `feedback` string produced by the per-
// submission AI feedback util, so this call is pure aggregation.
export async function generateTestClassReport({
  teacherId,
  title,
  totalQuestions,
  maxMarks,
  submissions,
}) {
  const [reportPrompt, teacherPrompt, MODEL, retryCfg] = await Promise.all([
    loadReportPrompt(),
    loadTeacherReportPrompt(teacherId),
    getAiModel(),
    getAiRetry("classReport"),
  ]);

  const systemInstruction = [reportPrompt, teacherPrompt]
    .filter(Boolean)
    .join("\n\n");

  const roster = (submissions || [])
    .map((s, idx) => {
      const name = s?.studentName || String(s?.studentId || `Student ${idx + 1}`);
      const marks = Number(s?.marks) || 0;
      const status = s?.isCompleted ? "completed" : "partial";
      const feedbackBody = (s?.feedback || "").trim() || "(no feedback recorded)";
      return `--- ${name} (${status}, marks=${marks}) ---\n${feedbackBody}`;
    })
    .join("\n\n");

  const userMessage = [
    `Test: ${title || "(untitled)"}`,
    `Total questions: ${totalQuestions}`,
    `Max marks: ${maxMarks}`,
    `Students submitted: ${(submissions || []).length}`,
    "",
    "Per-student per-question AI analysis rolled up below. Aggregate the recurring `stuckOn` themes, propose next-lesson strategies for the top difficulties, and give a short marks distribution summary.",
    "",
    roster || "(no submissions recorded)",
  ].join("\n");

  const result = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    {
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag: "TestClassReport",
    },
  );

  logAiUsage(null, result?.usageMetadata, "TestClassReport");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag: "TestClassReport",
  });

  const raw = (result?.text || "").trim();

  await recordAiCallLog({
    tag: "TestClassReport",
    model: MODEL,
    teacherId,
    questionText: `Test class report: ${title || ""}`,
    studentAnswer: userMessage,
    aiResponseSummary: raw,
    userPromptText: userMessage,
    standardPromptSnippet: reportPrompt,
    teacherPromptSnippet: teacherPrompt,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag: "TestClassReport" }) || {};
  return {
    summary: String(parsed.summary || "").trim(),
    topDifficulties: Array.isArray(parsed.topDifficulties)
      ? parsed.topDifficulties.map((x) => String(x || "").trim()).filter(Boolean)
      : [],
    suggestedNextSteps: Array.isArray(parsed.suggestedNextSteps)
      ? parsed.suggestedNextSteps
          .map((x) => String(x || "").trim())
          .filter(Boolean)
      : [],
    marksDistribution: String(parsed.marksDistribution || "").trim(),
    model: MODEL,
  };
}
