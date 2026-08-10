import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import { recordAiTokenUsage, logAiUsage } from "./aiTokenUsage.js";
import { getAiModel, getAiRetry, getAiTuning, getAiDirective } from "./aiConfig.js";

// One Gemini call made at question CREATION time so every subsequent
// per-student submission can skip re-deriving the canonical solution:
// precomputeStandardSolution generates the step-by-step solution once, using
// teacher rubrics/correct answers as reference, so per-submission calls fold
// it into the systemInstruction prefix and get an implicit cache hit.
//
// The question image (if present) is attached directly here AND on every
// per-submission call — no OCR-to-text detour, because the OCR was lossy on
// math notation (e.g. rendering "d/dx(cos 5x)" as "d cos5x/dx") and hurt
// correctness downstream. Latency, not tokens, is the priority.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

// Runs one Gemini call to produce the canonical step-by-step solution for a
// question. The teacher's rubrics/correct answers are attached as reference
// material so Gemini stays faithful to the intended answer key. When a
// question image exists, it's attached inline so the model reads the actual
// notation instead of a lossy transcription.
export async function precomputeStandardSolution({
  questionText,
  imageSource,
  correctAnswer,
  format,
  teacherId,
  sessionId,
  maxOutputTokens,
}) {
  const reqId = newReqId();
  try {
    const [standardText, teacherPrompt, MODEL, retryCfg, precomputeTuning, solutionHeader, jsonEnvelopeInstruction] = await Promise.all([
      loadStandardPromptText(),
      loadTeacherPrompt(teacherId),
      getAiModel(),
      getAiRetry("classworkPrecompute"),
      getAiTuning("precompute"),
      getAiDirective("precompute.solution"),
      getAiDirective("precompute.solutionJsonEnvelope"),
    ]);
    const systemInstruction = [standardText, teacherPrompt]
      .filter(Boolean)
      .join("\n\n");

    const referenceAnswer = formatCorrectAnswerForPrompt(correctAnswer);

    // The envelope directive (precompute.solutionJsonEnvelope) is what makes
    // the call return {solution, finalAnswer, opener} instead of bare text.
    // - finalAnswer is persisted as `derivedCorrectAnswer` and used as the
    //   fallback reference in per-submission feedback prompts when the teacher
    //   didn't attach a correctAnswer.
    // - opener is a warm 1-2 sentence question-specific preamble that the
    //   student sees streamed instantly on submit (via SSE `opener` event)
    //   while the real Gemini feedback call is still running. Fills the
    //   10-15s wait with something meaningful and question-aware.
    // Both are admin-editable via AdminAiPrompts.
    const instruction = [
      solutionHeader,
      `Question format: ${format || "unspecified"}`,
      `Question: ${questionText || ""}`,
      imageSource ? "A question image is attached below — inspect it carefully; it is the authoritative source of the question notation." : null,
      referenceAnswer
        ? `Teacher's reference answer / rubric (treat as authoritative):\n${referenceAnswer}`
        : "Teacher did not attach a reference answer; derive the canonical solution from the question alone.",
      jsonEnvelopeInstruction,
    ]
      .filter(Boolean)
      .join("\n\n");

    const parts = [{ text: instruction }];
    if (imageSource) {
      const inline = await sourceToInlineData(imageSource).catch(() => null);
      if (inline) {
        parts.push({
          inlineData: { data: inline.base64, mimeType: inline.mimeType },
        });
      }
    }

    const resolvedMax =
      Number(maxOutputTokens) > 0
        ? Number(maxOutputTokens)
        : precomputeTuning.solutionMaxTokens;

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
              thinkingBudget: Math.round(resolvedMax * precomputeTuning.solutionThinkingRatio),
            },
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                solution: { type: Type.STRING },
                finalAnswer: { type: Type.STRING },
                opener: {
                  type: Type.STRING,
                  description:
                    "A warm 1-2 sentence preamble in the SAME language as the question. Should acknowledge what the question is about and prime the student for feedback WITHOUT solving or revealing the answer. Example: 'Great, let's look at how you handled this derivative — I'll walk through your work with you.' Do not greet by name (the student's name isn't known here). Do not use markdown. Keep under 250 characters.",
                },
              },
              required: ["solution", "finalAnswer", "opener"],
            },
          },
        }),
      {
        maxAttempts: retryCfg.max,
        baseDelayMs: retryCfg.baseMs,
        maxDelayMs: retryCfg.capMs,
        tag: `ClassworkPrecompute:sol:${reqId}`,
      },
    );

    logAiUsage(reqId, result?.usageMetadata, "ClassworkPrecompute:sol");
    await recordAiTokenUsage(result?.usageMetadata, {
      sessionId,
      tag: `ClassworkPrecompute:sol:${reqId}`,
    });

    const rawText = (result?.text || "").trim();
    const parsed = parseFirstJsonObject(rawText, {
      tag: `ClassworkPrecompute:sol:${reqId}`,
    });
    const solution = String(parsed?.solution ?? "").trim();
    const finalAnswer = String(parsed?.finalAnswer ?? "").trim();
    // Cap the opener at 250 chars so a runaway model can't push a
    // paragraph into the student-facing preamble.
    const opener = String(parsed?.opener ?? "").trim().slice(0, 250);
    console.log(
      `[ClassworkPrecompute][req=${reqId}] solution (${solution.length} chars) · finalAnswer: ${finalAnswer || "(empty)"} · opener: ${opener || "(empty)"}\n${solution}`,
    );
    return { solution, finalAnswer, opener };
  } catch (err) {
    console.error(
      `[ClassworkPrecompute][req=${reqId}] solution generation failed:`,
      err?.message || err,
    );
    return { solution: "", finalAnswer: "", opener: "" };
  }
}
