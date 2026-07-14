import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";
const FEEDBACK_THINKING_CONFIG = { thinkingBudget: -1 };
const DEFAULT_FEEDBACK_MAX_OUTPUT_TOKENS = 800;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

// Attached to the user prompt on the first classwork submission for a
// question so Gemini computes the canonical solution once; every later
// call in the class (and every assignment call) gets the "skip" line
// instead to save output tokens.
const STANDARD_SOLUTION_COMPUTE_INSTRUCTION =
  'standardSolution: please return a string of the step-by-step solution of this question. Please use "\\n" to separate multiple lines. Please use Latex form for all math expressions and formulas. Please create a sample writing and rubrics for an essay writing question instead of step-by-step solution.';
const STANDARD_SOLUTION_SKIP_INSTRUCTION = "standardSolution: Leave it empty";

// Attached until the per-question aiFeedbackCache is finalized (classwork)
// or omitted entirely (assignment). Once the cache is finalized we tell
// Gemini to skip mistake analysis on every subsequent call.
const COMMON_MISTAKE_COMPUTE_INSTRUCTION = [
  "commonMistake: {",
  "  properties: {",
  "    isCommon: Type.BOOLEAN — return true if you predict the first mistake of this solution is very common (more than half of this grade's students would make it).",
  "    title: Type.STRING — a short title for the mistake.",
  "    answerLatex: Type.STRING — if the student's answer is a handwriting image, return the LaTeX transcription of the handwriting. Use LaTeX for all math expressions.",
  "  }",
  "}",
].join("\n");
const COMMON_MISTAKE_SKIP_INSTRUCTION = "commonMistake: Leave it empty";

const CLASSWORK_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    correct: { type: Type.BOOLEAN },
    hintStream: { type: Type.STRING },
    part1: { type: Type.ARRAY, items: { type: Type.STRING } },
    part2: { type: Type.ARRAY, items: { type: Type.STRING } },
    part3: { type: Type.ARRAY, items: { type: Type.STRING } },
    advancedChallenge: {
      type: Type.OBJECT,
      properties: {
        congratulations: { type: Type.STRING },
        question: { type: Type.STRING },
      },
      required: ["congratulations", "question"],
    },
    standardSolution: { type: Type.STRING },
    commonMistake: {
      type: Type.OBJECT,
      properties: {
        isCommon: { type: Type.BOOLEAN },
        title: { type: Type.STRING },
        answerLatex: { type: Type.STRING },
      },
      required: ["isCommon", "title"],
    },
  },
  required: [
    "correct",
    "hintStream",
    "part1",
    "part2",
    "part3",
    "advancedChallenge",
  ],
};

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

function normalizeAnswerText(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => `Blank ${index + 1}: ${String(entry ?? "")}`)
      .join("\n");
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string" && value.text.trim()) {
      return value.text.trim();
    }
    if (typeof value.value === "string" && value.value.trim()) {
      return value.value.trim();
    }
    if (value.type === "image") {
      return "Student submitted the answer as an image/handwriting sample.";
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "string") {
    return /^data:image\//i.test(value)
      ? "Student submitted the answer as an image/handwriting sample."
      : value;
  }

  return value == null ? "" : String(value);
}

export function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? ""));
  }
  if (value == null || value === "") return [];
  return [String(value)];
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeCommonMistake(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    title: firstNonEmptyString([source.title, source.name, source.mistakeTitle]),
    isCommon: Boolean(source.isCommon ?? source.common ?? source.predictedCommon),
    answerLatex: firstNonEmptyString([source.answerLatex, source.latex]),
  };
}

function getAnswerImageSource(answer) {
  if (!answer) return null;
  if (typeof answer === "string") {
    return /^data:image\//i.test(answer) ? answer : null;
  }
  if (
    typeof answer === "object" &&
    typeof answer.imageUrl === "string" &&
    answer.imageUrl.trim()
  ) {
    return answer.imageUrl;
  }
  return null;
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

async function buildTeacherSection(teacherId) {
  if (!teacherId) return "";
  try {
    const config = await TeacherAIConfig.findOne({ user: teacherId })
      .select("prompt")
      .lean();
    const prompt = (config?.prompt || "").trim();
    return prompt;
  } catch (err) {
    console.error("[ClassworkFeedback] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

function hashStandardPrompt(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return crypto.createHash("sha1").update(trimmed).digest("hex");
}

async function loadStandardPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" }).lean();
    const text = (doc?.aiHintPrompt || "").trim();
    return { text, hash: hashStandardPrompt(text) };
  } catch (err) {
    console.error("[ClassworkFeedback] Failed to load StandardPrompt:", err);
    return { text: "", hash: "" };
  }
}

function newReqId() {
  return crypto.randomBytes(3).toString("hex");
}

function summarizeContentsForLog(contents) {
  try {
    return JSON.parse(
      JSON.stringify(contents, (key, value) => {
        if (key === "data" && typeof value === "string" && value.length > 120) {
          return `<base64 ${value.length} chars>`;
        }
        return value;
      }),
    );
  } catch {
    return contents;
  }
}

const PERSISTED_INTERACTION_KEYS = new Set([
  "hintStream",
  "part1",
  "part2",
  "part3",
  "advancedChallenge",
  "correct",
  "standardSolution",
  "commonMistake",
]);

function logGeminiResponse(reqId, rawText, parsed) {
  console.log(`[ClassworkFeedback][req=${reqId}] === RESPONSE ===`);
  console.log(
    `[ClassworkFeedback][req=${reqId}] Raw text (${rawText.length} chars):\n${rawText}`,
  );
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    console.log(`[ClassworkFeedback][req=${reqId}] Parsed top-level keys:`, keys);
    console.log(
      `[ClassworkFeedback][req=${reqId}] Parsed object:`,
      JSON.stringify(parsed, null, 2),
    );
    const droppedByMongo = keys.filter((k) => !PERSISTED_INTERACTION_KEYS.has(k));
    if (droppedByMongo.length > 0) {
      console.warn(
        `[ClassworkFeedback][req=${reqId}] ⚠ Schema mismatch — these keys will be DROPPED on save:`,
        droppedByMongo,
        `(persisted keys: ${[...PERSISTED_INTERACTION_KEYS].join(", ")})`,
      );
    }
    const missingPersisted = [...PERSISTED_INTERACTION_KEYS].filter((k) => !(k in parsed));
    if (missingPersisted.length > 0) {
      console.warn(
        `[ClassworkFeedback][req=${reqId}] ⚠ Missing keys that the DB schema expects:`,
        missingPersisted,
      );
    }
  } else {
    console.warn(
      `[ClassworkFeedback][req=${reqId}] Parsed response is not an object — Gemini output did not contain a valid JSON object.`,
    );
  }
  console.log(`[ClassworkFeedback][req=${reqId}] === END RESPONSE ===`);
}

async function buildGeminiRequest({
  reqId,
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
  interactionId,
  previousInteractionId,
  cachedContext,
  computeStandardSolution,
  computeCommonMistake,
}) {
  console.log(`[ClassworkFeedback][req=${reqId}] === PROMPT ===`);
  console.log(`[ClassworkFeedback][req=${reqId}] teacherId:`, teacherId || "(missing)");

  const [{ text: standardText, hash: standardPromptHash }, teacherPrompt] = await Promise.all([
    loadStandardPrompt(),
    buildTeacherSection(teacherId),
  ]);

  const systemInstruction = [standardText, teacherPrompt].filter(Boolean).join("\n\n");

  const normalizedAnswerText = normalizeAnswerText(answer);
  const referenceAnswer = formatCorrectAnswerForPrompt(correctAnswer);
  const referenceCount = Array.isArray(correctAnswer)
    ? correctAnswer.filter((c) => String(c ?? "").trim()).length
    : referenceAnswer
      ? 1
      : 0;
  const answerImageSource = getAnswerImageSource(answer);

  const promptLines = [
    interactionId ? `interaction_id: ${interactionId}` : null,
    previousInteractionId
      ? `previous_interaction_id: ${previousInteractionId}`
      : "previous_interaction_id: null",
    studentName ? `Student name: ${studentName}` : null,
    `Question: ${questionText}`,
    format ? `Answer Format: ${format}` : null,
    referenceAnswer
      ? referenceCount > 1
        ? `Acceptable correct answers (any one counts as correct):\n${referenceAnswer}`
        : `Reference / Correct Answer: ${referenceAnswer}`
      : null,
    `Student Answer: ${normalizedAnswerText || "[No text provided]"}`,
    questionImage ? "A question image is attached." : null,
    answerImageSource
      ? "A student answer image is attached. Inspect the handwriting/image carefully."
      : null,
    computeStandardSolution
      ? STANDARD_SOLUTION_COMPUTE_INSTRUCTION
      : STANDARD_SOLUTION_SKIP_INSTRUCTION,
    computeCommonMistake
      ? COMMON_MISTAKE_COMPUTE_INSTRUCTION
      : COMMON_MISTAKE_SKIP_INSTRUCTION,
  ].filter(Boolean);

  const cachedSolution =
    typeof cachedContext?.standardSolution === "string"
      ? cachedContext.standardSolution.trim()
      : "";
  const cachedMistakes = Array.isArray(cachedContext?.commonMistakes)
    ? cachedContext.commonMistakes
    : [];

  const cacheLines = [];
  if (cachedSolution) {
    cacheLines.push(`Cached canonical solution: ${cachedSolution}`);
  }
  if (cachedMistakes.length > 0) {
    cacheLines.push("Cached common mistakes and feedback:");
    cachedMistakes.forEach((m, index) => {
      const title = String(m?.title || "").trim() || `Mistake ${index + 1}`;
      const answerText = String(m?.answerLatex || m?.studentAnswer || "").trim();
      const fb = String(m?.feedback || "").trim();
      cacheLines.push(`${index + 1}. ${title}`);
      if (answerText) cacheLines.push(`   Student answer: ${answerText}`);
      if (fb) cacheLines.push(`   Feedback: ${fb}`);
    });
  }

  const parts = [];

  if (questionImage) {
    const imageData = await sourceToInlineData(questionImage).catch(() => null);
    if (imageData) {
      parts.push({ text: "Question image:" });
      parts.push({ inlineData: { data: imageData.base64, mimeType: imageData.mimeType } });
    }
  }

  if (answerImageSource) {
    const answerImageData = await sourceToInlineData(answerImageSource).catch(() => null);
    if (answerImageData) {
      parts.push({ text: "Student answer image:" });
      parts.push({
        inlineData: { data: answerImageData.base64, mimeType: answerImageData.mimeType },
      });
    }
  }

  if (cacheLines.length > 0) {
    parts.push({ text: cacheLines.join("\n") });
  }

  parts.push({ text: promptLines.join("\n") });

  // Full text of the user-side prompt so the admin call log can persist
  // exactly what was sent (question + cached context + runtime directives).
  const userPromptText = [
    cacheLines.length > 0 ? cacheLines.join("\n") : null,
    promptLines.join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");

  console.log(
    `[ClassworkFeedback][req=${reqId}] Standard prompt (${standardText.length} chars):\n${standardText || "(none configured)"}`,
  );
  console.log(`[ClassworkFeedback][req=${reqId}] Teacher prompt:\n${teacherPrompt || "(none)"}`);
  console.log(`[ClassworkFeedback][req=${reqId}] standardPromptHash:`, standardPromptHash);
  console.log(
    `[ClassworkFeedback][req=${reqId}] User prompt (${promptLines.join("\n").length} chars):\n${promptLines.join("\n")}`,
  );
  console.log(
    `[ClassworkFeedback][req=${reqId}] Question image attached:`,
    Boolean(questionImage),
    "· Answer image attached:",
    Boolean(answerImageSource),
    "· Cached solution:",
    Boolean(cachedSolution),
    "· Cached mistakes:",
    cachedMistakes.length,
  );
  console.log(
    `[ClassworkFeedback][req=${reqId}] Final systemInstruction (${systemInstruction.length} chars):\n${systemInstruction}`,
  );
  console.log(`[ClassworkFeedback][req=${reqId}] === END PROMPT ===`);

  return {
    systemInstruction,
    contents: [{ role: "user", parts }],
    standardPromptHash,
    standardPromptText: standardText,
    teacherPromptText: teacherPrompt,
    userPromptText,
    hasCachedSolution: Boolean(cachedSolution),
  };
}

function shapeFeedback(parsed, responseText) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const hintStream = firstNonEmptyString([
    source.hintStream,
    source.liveHint,
    source.hint,
    Array.isArray(source.hintChunks) ? source.hintChunks.join(" ") : "",
  ]);

  return {
    correct: Boolean(source.correct),
    hintStream,
    part1: toStringArray(source.part1 ?? source.studentCanDo),
    part2: toStringArray(source.part2 ?? source.nextStep),
    part3: toStringArray(source.part3 ?? source.diagnosticTraining),
    advancedChallenge: {
      congratulations: firstNonEmptyString([
        source?.advancedChallenge?.congratulations,
        source.congratulations,
      ]),
      question: firstNonEmptyString([
        source?.advancedChallenge?.question,
        source.question,
      ]),
    },
    standardSolution: firstNonEmptyString([
      source.standardSolution,
      source.stepByStepSolution,
      source.solution,
      source.sampleWriting,
      source.referenceSolution,
    ]),
    commonMistake: normalizeCommonMistake(source.commonMistake ?? source.firstMistake),
    raw: responseText,
  };
}

export async function getClassworkAiFeedback({
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  studentId,
  classroomId,
  teacherId,
  maxOutputTokens,
  sessionId,
  interactionId,
  previousInteractionId,
  cachedContext,
  computeStandardSolution = false,
  computeCommonMistake = false,
}) {
  const reqId = newReqId();
  const {
    systemInstruction,
    contents,
    standardPromptHash,
    standardPromptText,
    teacherPromptText,
    userPromptText,
    hasCachedSolution,
  } = await buildGeminiRequest({
    reqId,
    questionText,
    answer,
    correctAnswer,
    questionImage,
    format,
    studentName,
    teacherId,
    interactionId,
    previousInteractionId,
    cachedContext,
    computeStandardSolution,
    computeCommonMistake,
  });

  const resolvedMaxOutputTokens =
    Number(maxOutputTokens) > 0
      ? Number(maxOutputTokens)
      : DEFAULT_FEEDBACK_MAX_OUTPUT_TOKENS;

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: CLASSWORK_RESPONSE_SCHEMA,
    thinkingConfig: hasCachedSolution ? { thinkingBudget: 0 } : FEEDBACK_THINKING_CONFIG,
    maxOutputTokens: resolvedMaxOutputTokens,
  };

  console.log(`[ClassworkFeedback][req=${reqId}] Gemini request:`, {
    model: MODEL,
    contents: summarizeContentsForLog(contents),
    config: {
      ...config,
      systemInstruction: `<${systemInstruction.length} chars — see PROMPT block above>`,
    },
  });

  const result = await withGeminiRetry(
    () => ai.models.generateContent({ model: MODEL, contents, config }),
    {
      maxAttempts: MAX_ATTEMPTS,
      baseDelayMs: BASE_DELAY_MS,
      tag: `ClassworkFeedback:${reqId}`,
    },
  );

  logAiUsage(reqId, result?.usageMetadata, "ClassworkFeedback");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId,
    tag: `ClassworkFeedback:${reqId}`,
  });

  const responseText = result.text || "";
  const parsed = parseFirstJsonObject(responseText, {
    tag: `ClassworkFeedback:${reqId}`,
  });
  logGeminiResponse(reqId, responseText, parsed);

  const feedback = shapeFeedback(parsed, responseText);
  feedback.standardPromptHash = standardPromptHash;
  feedback.standardPromptText = standardPromptText;
  feedback.teacherPromptText = teacherPromptText;

  // Per-call audit log for the admin panel. Best-effort — errors are
  // swallowed inside recordAiCallLog so a log write can't break feedback.
  await recordAiCallLog({
    reqId,
    tag: "ClassworkFeedback",
    model: MODEL,
    sessionId,
    classroomId,
    teacherId,
    studentId,
    studentName,
    questionText,
    studentAnswer: normalizeAnswerText(answer),
    aiResponseSummary: responseText,
    userPromptText,
    standardPromptSnippet: standardPromptText,
    standardPromptHash,
    teacherPromptSnippet: teacherPromptText,
    usageMetadata: result?.usageMetadata,
  });

  return feedback;
}
