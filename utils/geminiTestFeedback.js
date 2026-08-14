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

// Per-submission AI feedback for the Test module. Unlike classwork hints,
// this output is NEVER shown to the student mid-test — it feeds the
// individual test report and the class general report generated on expiry.
//
// Prompt assembly:
//   1. StandardPrompt.testAiHintPrompt (the 4-point analysis from the spec).
//   2. TeacherAIConfig.reportPrompt for the teacher (appended per spec:
//      "Attach teacher's personalized report prompt to the end of my
//      standard report prompt").
//
// Response is structured so the class report generator can aggregate
// individual submissions without re-parsing free text.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    // Spec point 1 — content/step correct just before the student got stuck.
    correctBeforeStuck: { type: Type.STRING },
    // Spec point 2 — formula/keyword/concept/method the student can't manage.
    stuckOn: { type: Type.STRING },
    // Spec point 3 — short, specific practice advice for this stuck point.
    practiceAdvice: { type: Type.STRING },
    // Spec point 4 — marks awarded out of `fullMarks` supplied in the prompt.
    marksAwarded: { type: Type.NUMBER },
  },
  required: [
    "correctBeforeStuck",
    "stuckOn",
    "practiceAdvice",
    "marksAwarded",
  ],
};

async function loadStandardTestPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("testAiHintPrompt")
      .lean();
    return (doc?.testAiHintPrompt || "").trim();
  } catch (err) {
    console.error("[TestFeedback] Failed to load StandardPrompt:", err);
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
    console.error("[TestFeedback] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

// Public entry point. `fullMarks` seeds the "The full mark of this question
// is ___" blank in the standard prompt so the AI can scale marksAwarded.
export async function generateTestFeedback({
  teacherId,
  studentName,
  question, // { text, format, correctAnswer, solution }
  studentAnswer, // free-form string as submitted by the student
  fullMarks,
}) {
  const [standardPrompt, teacherPrompt, MODEL, retryCfg] = await Promise.all([
    loadStandardTestPrompt(),
    loadTeacherReportPrompt(teacherId),
    getAiModel(),
    getAiRetry("classworkFeedback"),
  ]);

  const systemInstruction = [
    standardPrompt.replace(
      "The full mark of this question is ___",
      `The full mark of this question is ${Number(fullMarks) || 0}`,
    ),
    teacherPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  const answerText =
    typeof studentAnswer === "string"
      ? studentAnswer
      : studentAnswer == null
        ? ""
        : Array.isArray(studentAnswer)
          ? studentAnswer.map((x) => String(x ?? "")).join(" | ")
          : (() => {
              try {
                return JSON.stringify(studentAnswer);
              } catch {
                return String(studentAnswer);
              }
            })();

  const userMessage = [
    studentName ? `Student: ${studentName}` : null,
    `Question format: ${question?.format || ""}`,
    `Question: ${question?.text || ""}`,
    question?.correctAnswer
      ? `Reference answer: ${
          Array.isArray(question.correctAnswer)
            ? question.correctAnswer.join(" | ")
            : String(question.correctAnswer)
        }`
      : null,
    question?.solution ? `Worked solution: ${question.solution}` : null,
    "",
    `Student's answer:\n${answerText}`,
    "",
    `Full marks for this question: ${Number(fullMarks) || 0}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

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
      tag: "TestFeedback",
    },
  );

  logAiUsage(null, result?.usageMetadata, "TestFeedback");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag: "TestFeedback",
  });

  const raw = (result?.text || "").trim();

  await recordAiCallLog({
    tag: "TestFeedback",
    model: MODEL,
    teacherId,
    questionText: question?.text || "",
    studentAnswer: answerText,
    aiResponseSummary: raw,
    userPromptText: userMessage,
    standardPromptSnippet: standardPrompt,
    teacherPromptSnippet: teacherPrompt,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag: "TestFeedback" }) || {};
  // Defensive normalisation — never let a malformed AI response corrupt the
  // stored submission record.
  const capped = Math.max(
    0,
    Math.min(Number(fullMarks) || 0, Number(parsed.marksAwarded) || 0),
  );
  return {
    correctBeforeStuck: String(parsed.correctBeforeStuck || "").trim(),
    stuckOn: String(parsed.stuckOn || "").trim(),
    practiceAdvice: String(parsed.practiceAdvice || "").trim(),
    marksAwarded: capped,
    model: MODEL,
  };
}
