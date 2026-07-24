import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";
import { withGeminiRetry } from "./geminiCommon.js";
import { recordAiTokenUsage, logAiUsage } from "./aiTokenUsage.js";

// Two one-off Gemini calls made at question CREATION time so every subsequent
// per-student submission can skip the heavy work:
//   1. precomputeQuestionImageText — OCR/transcribe the question image once
//      into text so per-submission calls don't have to re-attach the image.
//   2. precomputeStandardSolution — generate the canonical step-by-step
//      solution once, using teacher rubrics/correct answers as reference, so
//      per-submission calls can cache it as a stable prefix and stop asking
//      Gemini to re-derive the solution for every submission.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function newReqId() {
  return crypto.randomBytes(3).toString("hex");
}

async function sourceToInlineData(source) {
  if (!source || typeof source !== "string") return null;
  const dataUrlMatch = source.match(/^data:(.+?);base64,(.+)$/);
  if (dataUrlMatch) {
    return { mimeType: dataUrlMatch[1], base64: dataUrlMatch[2] };
  }
  const response = await fetch(source);
  const buffer = await response.arrayBuffer();
  return {
    base64: Buffer.from(buffer).toString("base64"),
    mimeType: "image/jpeg",
  };
}

function formatCorrectAnswerForPrompt(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean);
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    return items.map((a, i) => `${i + 1}. ${a}`).join("\n");
  }
  if (value == null) return "";
  return String(value).trim();
}

async function loadTeacherPrompt(teacherId) {
  if (!teacherId) return "";
  try {
    const config = await TeacherAIConfig.findOne({ user: teacherId })
      .select("prompt")
      .lean();
    return (config?.prompt || "").trim();
  } catch (err) {
    console.error("[ClassworkPrecompute] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

async function loadStandardPromptText() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" }).lean();
    return (doc?.aiHintPrompt || "").trim();
  } catch (err) {
    console.error("[ClassworkPrecompute] Failed to load StandardPrompt:", err);
    return "";
  }
}

// Runs one Gemini call to transcribe a question image into plain text (with
// LaTeX for math). Return "" on any failure so the caller can degrade to
// attaching the image at submission time.
export async function precomputeQuestionImageText({ imageSource, sessionId }) {
  if (!imageSource) return "";
  const reqId = newReqId();
  try {
    const inline = await sourceToInlineData(imageSource);
    if (!inline) return "";

    const instruction =
      "Transcribe every visible element of this question image into plain text so it can stand in for the image in later prompts. Use LaTeX for all math expressions and formulas. Preserve numbered/lettered lists and multi-line layouts using newlines. Do not solve the question. Return the transcription only, no preamble.";

    console.log(`[ClassworkPrecompute][req=${reqId}] === IMAGE-TO-TEXT ===`);

    const result = await withGeminiRetry(
      () =>
        ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              role: "user",
              parts: [
                { text: instruction },
                {
                  inlineData: { data: inline.base64, mimeType: inline.mimeType },
                },
              ],
            },
          ],
          config: {
            // Text output; no JSON schema — we want the raw transcription.
            maxOutputTokens: 2000,
            thinkingConfig: { thinkingBudget: 1200 },
          },
        }),
      {
        maxAttempts: MAX_ATTEMPTS,
        baseDelayMs: BASE_DELAY_MS,
        tag: `ClassworkPrecompute:img:${reqId}`,
      },
    );

    logAiUsage(reqId, result?.usageMetadata, "ClassworkPrecompute:img");
    await recordAiTokenUsage(result?.usageMetadata, {
      sessionId,
      tag: `ClassworkPrecompute:img:${reqId}`,
    });

    const text = (result?.text || "").trim();
    console.log(
      `[ClassworkPrecompute][req=${reqId}] image-to-text (${text.length} chars):\n${text}`,
    );
    return text;
  } catch (err) {
    console.error(
      `[ClassworkPrecompute][req=${reqId}] image-to-text failed:`,
      err?.message || err,
    );
    return "";
  }
}

// Runs one Gemini call to produce the canonical step-by-step solution for a
// question. The teacher's rubrics/correct answers are attached as reference
// material so Gemini stays faithful to the intended answer key. Uses the
// pre-transcribed question text when the image OCR has already run — avoids
// paying for the image tokens a second time.
export async function precomputeStandardSolution({
  questionText,
  questionImageText,
  imageSource,
  correctAnswer,
  format,
  teacherId,
  sessionId,
  maxOutputTokens,
}) {
  const reqId = newReqId();
  try {
    const [standardText, teacherPrompt] = await Promise.all([
      loadStandardPromptText(),
      loadTeacherPrompt(teacherId),
    ]);
    const systemInstruction = [standardText, teacherPrompt]
      .filter(Boolean)
      .join("\n\n");

    const referenceAnswer = formatCorrectAnswerForPrompt(correctAnswer);
    const questionForPrompt = (questionImageText && questionImageText.trim())
      ? `${questionText || ""}\n\n[Question image transcription:]\n${questionImageText.trim()}`
      : questionText || "";

    const instruction = [
      "Produce the canonical step-by-step solution to the question below so it can be cached and reused for every student's submission. Use LaTeX for math expressions and formulas. For essay-writing questions, produce a sample response and rubric bullets rather than numeric steps. Use \"\\n\" between lines. Return the solution text only — no JSON wrapper, no preamble.",
      `Question format: ${format || "unspecified"}`,
      `Question: ${questionForPrompt}`,
      referenceAnswer
        ? `Teacher's reference answer / rubric (treat as authoritative):\n${referenceAnswer}`
        : "Teacher did not attach a reference answer; derive the canonical solution from the question alone.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const parts = [{ text: instruction }];
    // Fall back to attaching the raw image only when OCR wasn't already run.
    if ((!questionImageText || !questionImageText.trim()) && imageSource) {
      const inline = await sourceToInlineData(imageSource).catch(() => null);
      if (inline) {
        parts.push({
          inlineData: { data: inline.base64, mimeType: inline.mimeType },
        });
      }
    }

    const resolvedMax =
      Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 2000;

    console.log(
      `[ClassworkPrecompute][req=${reqId}] === SOLUTION === teacherId=${teacherId || "(none)"} maxOutputTokens=${resolvedMax}`,
    );

    const result = await withGeminiRetry(
      () =>
        ai.models.generateContent({
          model: MODEL,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction,
            maxOutputTokens: resolvedMax,
            thinkingConfig: {
              thinkingBudget: Math.round(resolvedMax * 0.6),
            },
          },
        }),
      {
        maxAttempts: MAX_ATTEMPTS,
        baseDelayMs: BASE_DELAY_MS,
        tag: `ClassworkPrecompute:sol:${reqId}`,
      },
    );

    logAiUsage(reqId, result?.usageMetadata, "ClassworkPrecompute:sol");
    await recordAiTokenUsage(result?.usageMetadata, {
      sessionId,
      tag: `ClassworkPrecompute:sol:${reqId}`,
    });

    const solution = (result?.text || "").trim();
    console.log(
      `[ClassworkPrecompute][req=${reqId}] solution (${solution.length} chars):\n${solution}`,
    );
    return solution;
  } catch (err) {
    console.error(
      `[ClassworkPrecompute][req=${reqId}] solution generation failed:`,
      err?.message || err,
    );
    return "";
  }
}
