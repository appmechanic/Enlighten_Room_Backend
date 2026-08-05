
import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import fetch from "node-fetch";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  getStandardPromptCached,
  getTeacherPromptCached,
} from "./promptCache.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry, getAiTuning, getAiDirective } from "./aiConfig.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Model IDs come from StandardPrompt.models via getAiModel() (60s in-memory
// cache with a hardcoded fallback if Mongo is unreachable). The fallback slot
// is used ONCE when the primary is under load (503/UNAVAILABLE or another
// retryable status). During Gemini spikes flash-lite typically has spare
// capacity, so the student sees a hint in a couple of seconds instead of
// waiting out the retry ladder. Same JSON shape as flash so the shaping code
// below doesn't need to branch. An admin can disable the fallback by setting
// StandardPrompt.models.fallback to the same value as models.default.
// Tuning constants (thinkingBudgetRatio, maxThinkingBudget,
// defaultMaxOutputTokens, imageStudyFormats) are resolved per call via
// getAiTuning("feedback") from StandardPrompt.tuning.feedback. Retry budget
// via getAiRetry("classworkFeedback"). All values have hardcoded fallbacks in
// utils/aiConfig.js so a missing DB field never breaks the flow.

// Derive the Gemini thinking budget from the resolved output-token budget.
// No cached solution -> full share (the model must derive the answer).
// Cached solution -> 0 for everything except handwriting/imageStudy formats,
// which keep a small capped budget to read the answer image. The result is
// capped by tuning.maxThinkingBudget so a huge output budget can't translate
// into a long pre-stream thinking delay before the hint appears.
function resolveThinkingBudget(resolvedMaxOutputTokens, hasCachedSolution, format, tuning) {
  const share = Math.round(resolvedMaxOutputTokens * tuning.thinkingBudgetRatio);
  const imageStudy = new Set(tuning.imageStudyFormats || []);
  if (!hasCachedSolution) return Math.min(share, tuning.maxThinkingBudget);
  if (imageStudy.has(format)) {
    return Math.min(Math.round(share / 2), tuning.maxThinkingBudget);
  }
  return 0;
}

// Every prompt directive attached below is resolved per call via
// getAiDirective(key). The canonical text lives in
// config/standardPromptDefaults.js and is seeded into StandardPrompt on
// first read; admin edits in the AdminAiPrompts UI override the seed value.
// See utils/aiConfig.js for the DB-read + 60s cache.

// Property order matters: Gemini emits structured-JSON fields in the
// order they appear in the schema, so the student-facing text
// (`hintStream`, `part1`, `part2`) is placed first to unlock incremental
// streaming — the client can render the hint before the trailing
// metadata (`commonMistake`, `standardSolution`) has finished.
function buildClassworkResponseSchema({ includeStandardSolution }) {
  const properties = {
    // Field descriptions are honored by Gemini structured output and are the
    // strongest signal for what goes where. Without them the model conflated
    // hintStream with part1 (both became a bare greeting). Keep these in sync
    // with the standard prompt's section descriptions.
    hintStream: {
      type: Type.STRING,
      description:
        "The concise live hint the student sees typing in real time. 2-4 complete sentences in the question's language: greet by first name, acknowledge what they did right, and give the single most important next-step nudge toward the correct method WITHOUT revealing the final answer. Must stand alone as a useful hint; never just a greeting and never a copy of part1.",
    },
    part1: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Acknowledgment section. The first string greets the student by first name and names the last correct step/milestone they reached before the error.",
    },
    part2: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Immediate Next Step Guidance. One string per subtitle in order: '🛑: ' (what NOT to do), '✅: ' (the correct formula/strategy), '🔨: ' (how to apply it), and optionally '🔍: ' (short explanation of the underlying theorem/reason).",
    },
    correct: {
      type: Type.BOOLEAN,
      description:
        "true only when the student's answer is complete and correct; otherwise false.",
    },
    part3: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "Diagnostic training suggestions that strengthen the underlying skill the student is missing, phrased encouragingly.",
    },
    advancedChallenge: {
      type: Type.OBJECT,
      description:
        "Only filled when correct is true: a warm congratulation plus a brand-new question one level more advanced. Leave both fields empty strings when the answer is not yet correct.",
      properties: {
        congratulations: { type: Type.STRING },
        question: { type: Type.STRING },
      },
      required: ["congratulations", "question"],
    },
    commonMistake: {
      type: Type.OBJECT,
      properties: {
        isCommon: { type: Type.BOOLEAN },
        title: { type: Type.STRING },
        answerLatex: { type: Type.STRING },
      },
      required: ["isCommon", "title"],
    },
  };

  // Only advertise `standardSolution` when the caller actually wants it
  // computed — when a precompute already rode in on systemInstruction
  // there's nothing to derive and the field wastes output tokens.
  if (includeStandardSolution) {
    properties.standardSolution = { type: Type.STRING };
  }

  return {
    type: Type.OBJECT,
    properties,
    required: [
      "hintStream",
      "part1",
      "part2",
      "correct",
      "part3",
      "advancedChallenge",
    ],
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
  questionImageText,
  answer,
  correctAnswer,
  derivedCorrectAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
  interactionId,
  previousInteractionId,
  submissionNumber,
  cachedContext,
  computeStandardSolution,
  computeCommonMistake,
}) {
  console.log(`[ClassworkFeedback][req=${reqId}] === PROMPT ===`);
  console.log(`[ClassworkFeedback][req=${reqId}] teacherId:`, teacherId || "(missing)");

  const [
    { text: standardText, hash: standardPromptHash },
    teacherPrompt,
    STANDARD_SOLUTION_COMPUTE_INSTRUCTION,
    STANDARD_SOLUTION_SKIP_INSTRUCTION,
    COMMON_MISTAKE_COMPUTE_INSTRUCTION,
    COMMON_MISTAKE_SKIP_INSTRUCTION,
    HINT_STREAM_INSTRUCTION,
    MATH_EQUIVALENCE_INSTRUCTION,
    ASK_MODE_INSTRUCTION,
    TELL_MODE_INSTRUCTION,
  ] = await Promise.all([
    getStandardPromptCached(),
    getTeacherPromptCached(teacherId),
    getAiDirective("classwork.solutionCompute"),
    getAiDirective("classwork.solutionSkip"),
    getAiDirective("classwork.mistakeCompute"),
    getAiDirective("classwork.mistakeSkip"),
    getAiDirective("classwork.hintStream"),
    getAiDirective("classwork.mathEquivalence"),
    getAiDirective("classwork.askMode"),
    getAiDirective("classwork.tellMode"),
  ]);

  const cachedSolution =
    typeof cachedContext?.standardSolution === "string"
      ? cachedContext.standardSolution.trim()
      : "";
  const cachedMistakes = Array.isArray(cachedContext?.commonMistakes)
    ? cachedContext.commonMistakes
    : [];

  // Cache-friendly stable prefix: standard prompt + teacher prompt +
  // precomputed canonical solution. Every submission for this question gets
  // exactly this systemInstruction, so Gemini's implicit prefix cache can
  // hit across submissions. Common mistakes are DELIBERATELY excluded —
  // they change as new mistakes accumulate and would invalidate the cache.
  const solutionBlock = cachedSolution
    ? `Canonical step-by-step solution (precomputed at question-create time; treat as authoritative):\n${cachedSolution}`
    : "";
  const systemInstruction = [standardText, teacherPrompt, solutionBlock]
    .filter(Boolean)
    .join("\n\n");

  const normalizedAnswerText = normalizeAnswerText(answer);
  const referenceAnswer = formatCorrectAnswerForPrompt(correctAnswer);
  const referenceCount = Array.isArray(correctAnswer)
    ? correctAnswer.filter((c) => String(c ?? "").trim()).length
    : referenceAnswer
      ? 1
      : 0;
  // When the teacher didn't attach a correctAnswer, fall back to the answer
  // the precompute step distilled from the canonical solution — otherwise
  // the model has nothing concrete to compare the student's answer against
  // and `correct` is essentially a guess.
  const derivedReferenceAnswer = referenceAnswer
    ? ""
    : formatCorrectAnswerForPrompt(derivedCorrectAnswer);
  const answerImageSource = getAnswerImageSource(answer);

  // Fold the pre-OCR'd question image transcription into the question text
  // so per-submission calls don't have to re-attach the raw image. The image
  // itself is only sent as inlineData when OCR wasn't available.
  const effectiveQuestionText = questionImageText && questionImageText.trim()
    ? `${questionText || ""}\n\n[Question image transcription:]\n${questionImageText.trim()}`
    : questionText || "";
  const includeRawQuestionImage = Boolean(
    questionImage && !(questionImageText && questionImageText.trim()),
  );

  // Ask/Tell pedagogy directive, derived from the runtime attempt number.
  // Odd -> ASK (coach recall), even -> TELL (explain). Skipped entirely when
  // no valid number was supplied so older callers behave as before. The
  // "if correct" caveat keeps a correct answer on the normal congratulate +
  // advancedChallenge path regardless of which mode this attempt is.
  const attemptNo = Number(submissionNumber);
  const askTellInstruction =
    Number.isInteger(attemptNo) && attemptNo > 0
      ? [
          `Submission attempt #${attemptNo} for this student on this question.`,
          attemptNo % 2 === 1 ? ASK_MODE_INSTRUCTION : TELL_MODE_INSTRUCTION,
          "If the student's answer is fully correct, IGNORE the pedagogy mode above — congratulate them and fill advancedChallenge as usual.",
        ].join("\n")
      : null;

  const promptLines = [
    interactionId ? `interaction_id: ${interactionId}` : null,
    previousInteractionId
      ? `previous_interaction_id: ${previousInteractionId}`
      : "previous_interaction_id: null",
    studentName ? `Student name: ${studentName}` : null,
    `Question: ${effectiveQuestionText}`,
    format ? `Answer Format: ${format}` : null,
    referenceAnswer
      ? referenceCount > 1
        ? `Acceptable correct answers (any one counts as correct):\n${referenceAnswer}`
        : `Reference / Correct Answer: ${referenceAnswer}`
      : derivedReferenceAnswer
        ? `Reference / Correct Answer (AI-derived at question-create time from the canonical solution — use as ground truth unless the solution above contradicts it): ${derivedReferenceAnswer}`
        : null,
    `Student Answer: ${normalizedAnswerText || "[No text provided]"}`,
    includeRawQuestionImage ? "A question image is attached." : null,
    answerImageSource
      ? "A student answer image is attached. Inspect the handwriting/image carefully."
      : null,
    askTellInstruction,
    MATH_EQUIVALENCE_INSTRUCTION,
    HINT_STREAM_INSTRUCTION,
    computeStandardSolution
      ? STANDARD_SOLUTION_COMPUTE_INSTRUCTION
      : STANDARD_SOLUTION_SKIP_INSTRUCTION,
    computeCommonMistake
      ? COMMON_MISTAKE_COMPUTE_INSTRUCTION
      : COMMON_MISTAKE_SKIP_INSTRUCTION,
  ].filter(Boolean);


  // Common mistakes rendered as their own attachment part AFTER the main
  // prompt. Kept out of both systemInstruction and the shared user prompt
  // so accumulating new mistakes doesn't bust the implicit cache prefix.
  const mistakeLines = [];
  if (cachedMistakes.length > 0) {
    mistakeLines.push(
      "Reference bank of common mistakes previously seen for this question (use to shape feedback but do NOT copy verbatim):",
    );
    cachedMistakes.forEach((m, index) => {
      const title = String(m?.title || "").trim() || `Mistake ${index + 1}`;
      const answerText = String(m?.answerLatex || m?.studentAnswer || "").trim();
      const fb = String(m?.feedback || "").trim();
      mistakeLines.push(`${index + 1}. ${title}`);
      if (answerText) mistakeLines.push(`   Student answer: ${answerText}`);
      if (fb) mistakeLines.push(`   Feedback: ${fb}`);
    });
  }

  const parts = [];

  if (includeRawQuestionImage) {
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

  parts.push({ text: promptLines.join("\n") });

  if (mistakeLines.length > 0) {
    parts.push({ text: mistakeLines.join("\n") });
  }

  // Full text of the user-side prompt so the admin call log can persist
  // exactly what was sent (question + runtime directives + mistake bank).
  const userPromptText = [
    promptLines.join("\n"),
    mistakeLines.length > 0 ? mistakeLines.join("\n") : null,
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
    includeRawQuestionImage,
    "· OCR text available:",
    Boolean(questionImageText && questionImageText.trim()),
    "· Answer image attached:",
    Boolean(answerImageSource),
    "· Cached solution in systemInstruction:",
    Boolean(cachedSolution),
    "· Attached mistakes:",
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
  questionImageText,
  answer,
  correctAnswer,
  derivedCorrectAnswer,
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
  submissionNumber,
  cachedContext,
  computeStandardSolution = false,
  computeCommonMistake = false,
}) {
  const reqId = newReqId();
  const [MODEL, FALLBACK_MODEL, retryCfg, feedbackTuning] = await Promise.all([
    getAiModel(),
    getAiModel("fallback"),
    getAiRetry("classworkFeedback"),
    getAiTuning("feedback"),
  ]);
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
    questionImageText,
    answer,
    correctAnswer,
    derivedCorrectAnswer,
    questionImage,
    format,
    studentName,
    teacherId,
    interactionId,
    previousInteractionId,
    submissionNumber,
    cachedContext,
    computeStandardSolution,
    computeCommonMistake,
  });

  const resolvedMaxOutputTokens =
    Number(maxOutputTokens) > 0
      ? Number(maxOutputTokens)
      : feedbackTuning.defaultMaxOutputTokens;
  // Bind thinking to a fixed share of the output budget (see
  // THINKING_BUDGET_RATIO / resolveThinkingBudget). When the canonical
  // solution is cached the model has nothing left to derive, so thinking
  // drops to 0 — except for handwriting/textbox, which still need room to
  // study the image or open-ended answer.
  const thinkingBudget = resolveThinkingBudget(
    resolvedMaxOutputTokens,
    hasCachedSolution,
    format,
    feedbackTuning
  );

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: buildClassworkResponseSchema({
      includeStandardSolution: Boolean(computeStandardSolution),
    }),
    thinkingConfig: { thinkingBudget },
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
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag: `ClassworkFeedback:${reqId}`,
      fallbackCallFn: FALLBACK_MODEL
        ? () =>
            ai.models.generateContent({
              model: FALLBACK_MODEL,
              contents,
              config,
            })
        : undefined,
    },
  );

  logAiUsage(reqId, result?.usageMetadata, "ClassworkFeedback");

  const responseText = result.text || "";
  const parsed = parseFirstJsonObject(responseText, {
    tag: `ClassworkFeedback:${reqId}`,
  });
  logGeminiResponse(reqId, responseText, parsed);

  const feedback = shapeFeedback(parsed, responseText);
  feedback.standardPromptHash = standardPromptHash;
  feedback.standardPromptText = standardPromptText;
  feedback.teacherPromptText = teacherPromptText;

  // Analytics + audit writes are fire-and-forget: they don't gate the
  // student's response and their failures must never surface as a 500.
  // recordAiCallLog already swallows its own errors; the token-usage
  // path is wrapped defensively in case a Mongo hiccup would otherwise
  // become an unhandled rejection.
  setImmediate(() => {
    recordAiTokenUsage(result?.usageMetadata, {
      sessionId,
      tag: `ClassworkFeedback:${reqId}`,
    }).catch((err) => {
      console.error(
        `[ClassworkFeedback][req=${reqId}] deferred token-usage write failed:`,
        err,
      );
    });
    recordAiCallLog({
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
  });

  return feedback;
}

// Incremental scanner that extracts the value of the first `"hintStream"`
// string in a growing JSON buffer and emits decoded text via `onDelta`.
// Handles `\n`, `\"`, `\\`, `\t`, `\r`, and the trivial ASCII escapes;
// when it sees `\u` it waits for all six characters before decoding so we
// never emit a half-formed code point.
// Decoded characters are batched per push(): each Gemini network chunk
// produces at most ONE onDelta call carrying every character decoded from
// it, instead of one call per character. This keeps the downstream SSE
// event count at the stream's natural chunk cadence (a few dozen events
// per hint) rather than one event per character, with no added latency.
// The final, fully-parsed `hintStream` from the server-side JSON parse
// still supersedes whatever we streamed — the client is told to prefer
// it — so this scanner is best-effort: it exists to hide 3-15s of
// perceived latency, not to be the authoritative source of the string.
export function createHintStreamScanner({ onDelta }) {
  const KEY = '"hintStream"';
  let buffer = "";
  let cursor = 0;
  let state = "SEARCH_KEY"; // SEARCH_KEY -> AWAIT_QUOTE -> IN_STRING -> DONE
  let escape = false;
  // Hex digits accumulated after `\u`; null means "not inside a \u escape".
  // (Must be null-sentinel, not "": an empty string can't distinguish
  // "just saw \u, expecting digits" from "no escape in progress".)
  let unicodePending = null;
  let pending = ""; // decoded chars accumulated during the current push()

  function emit(char) {
    if (!char) return;
    pending += char;
  }

  // Deliver everything decoded during this push() as a single chunk.
  function flush() {
    if (!pending) return;
    const chunk = pending;
    pending = "";
    try {
      onDelta(chunk);
    } catch (err) {
      console.error("[HintStreamScanner] onDelta threw:", err);
    }
  }

  function scan() {
    while (cursor < buffer.length && state !== "DONE") {
        if (state === "SEARCH_KEY") {
          const keyIdx = buffer.indexOf(KEY, cursor);
          if (keyIdx === -1) {
            // Keep the tail so a KEY split across two chunks still matches.
            cursor = Math.max(buffer.length - KEY.length, cursor);
            return;
          }
          cursor = keyIdx + KEY.length;
          state = "AWAIT_QUOTE";
          continue;
        }

        if (state === "AWAIT_QUOTE") {
          const ch = buffer[cursor];
          cursor += 1;
          if (ch === '"') {
            state = "IN_STRING";
          } else if (ch !== ":" && ch !== " " && ch !== "\t" && ch !== "\n") {
            // Unexpected between the key and its opening quote — bail
            // out silently rather than mis-emit garbage.
            state = "DONE";
            return;
          }
          continue;
        }

        if (state === "IN_STRING") {
          const ch = buffer[cursor];
          cursor += 1;
          if (unicodePending !== null) {
            unicodePending += ch;
            if (unicodePending.length === 4) {
              const code = parseInt(unicodePending, 16);
              unicodePending = null;
              if (Number.isFinite(code)) emit(String.fromCharCode(code));
            }
            continue;
          }
          if (escape) {
            escape = false;
            if (ch === "n") emit("\n");
            else if (ch === "t") emit("\t");
            else if (ch === "r") emit("\r");
            else if (ch === "u") unicodePending = "";
            else if (ch === "\\" || ch === '"' || ch === "/") emit(ch);
            else emit(ch); // unknown escape — pass through best-effort
            continue;
          }
          if (ch === "\\") {
            // The next character decides how to decode; if it hasn't
            // arrived yet we rewind so the next push() re-enters here.
            if (cursor >= buffer.length) {
              cursor -= 1;
              return;
            }
            escape = true;
            continue;
          }
          if (ch === '"') {
            state = "DONE";
            return;
          }
          emit(ch);
        }
      }
  }

  return {
    push(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) return;
      buffer += chunk;
      try {
        scan();
      } finally {
        // Emit whatever this chunk decoded, even when scan() bailed
        // early (split escape, key straddling chunks, string ended).
        flush();
      }
    },
    isDone() {
      return state === "DONE";
    },
  };
}

// Streaming twin of getClassworkAiFeedback. Runs the same Gemini call via
// generateContentStream, forwards decoded `hintStream` characters to
// `onHintDelta` the moment they arrive, and — once the full stream ends
// — parses the concatenated JSON exactly the same way the non-stream
// path does, so persistence + return shape stay identical.
export async function getClassworkAiFeedbackStream({
  questionText,
  questionImageText,
  answer,
  correctAnswer,
  derivedCorrectAnswer,
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
  submissionNumber,
  cachedContext,
  computeStandardSolution = false,
  computeCommonMistake = false,
  onHintDelta,
}) {
  const reqId = newReqId();
  const [MODEL, FALLBACK_MODEL, retryCfg, feedbackTuning] = await Promise.all([
    getAiModel(),
    getAiModel("fallback"),
    getAiRetry("classworkFeedback"),
    getAiTuning("feedback"),
  ]);
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
    questionImageText,
    answer,
    correctAnswer,
    derivedCorrectAnswer,
    questionImage,
    format,
    studentName,
    teacherId,
    interactionId,
    previousInteractionId,
    submissionNumber,
    cachedContext,
    computeStandardSolution,
    computeCommonMistake,
  });

  const resolvedMaxOutputTokens =
    Number(maxOutputTokens) > 0
      ? Number(maxOutputTokens)
      : feedbackTuning.defaultMaxOutputTokens;
  const thinkingBudget = resolveThinkingBudget(
    resolvedMaxOutputTokens,
    hasCachedSolution,
    format,
    feedbackTuning
  );

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: buildClassworkResponseSchema({
      includeStandardSolution: Boolean(computeStandardSolution),
    }),
    thinkingConfig: { thinkingBudget },
    maxOutputTokens: resolvedMaxOutputTokens,
  };

  console.log(`[ClassworkFeedback][req=${reqId}][stream] Gemini request:`, {
    model: MODEL,
    contents: summarizeContentsForLog(contents),
    config: {
      ...config,
      systemInstruction: `<${systemInstruction.length} chars — see PROMPT block above>`,
    },
  });

  const scanner = createHintStreamScanner({
    onDelta: typeof onHintDelta === "function" ? onHintDelta : () => {},
  });

  // The SDK's streaming call doesn't return a status code the retry
  // wrapper knows how to inspect until we start iterating — so we retry
  // the whole stream-open + drain sequence together. The classwork
  // budget is small (3 attempts) so failure is quickly visible.
  let responseText = "";
  let finalResponse = null;

  const openAndDrainWith = (modelId) => async () => {
    responseText = "";
    finalResponse = null;
    const stream = await ai.models.generateContentStream({
      model: modelId,
      contents,
      config,
    });
    for await (const chunk of stream) {
      const piece = chunk?.text ?? "";
      if (piece) {
        responseText += piece;
        scanner.push(piece);
      }
      if (chunk?.usageMetadata) finalResponse = chunk;
    }
    return finalResponse;
  };

  const usageBearingChunk = await withGeminiRetry(openAndDrainWith(MODEL), {
    maxAttempts: retryCfg.max,
    baseDelayMs: retryCfg.baseMs,
    maxDelayMs: retryCfg.capMs,
    tag: `ClassworkFeedback:${reqId}:stream`,
    fallbackCallFn: FALLBACK_MODEL ? openAndDrainWith(FALLBACK_MODEL) : undefined,
  });

  const usageMetadata = usageBearingChunk?.usageMetadata;
  logAiUsage(reqId, usageMetadata, "ClassworkFeedback:stream");

  const parsed = parseFirstJsonObject(responseText, {
    tag: `ClassworkFeedback:${reqId}:stream`,
  });
  logGeminiResponse(reqId, responseText, parsed);

  const feedback = shapeFeedback(parsed, responseText);
  feedback.standardPromptHash = standardPromptHash;
  feedback.standardPromptText = standardPromptText;
  feedback.teacherPromptText = teacherPromptText;

  setImmediate(() => {
    recordAiTokenUsage(usageMetadata, {
      sessionId,
      tag: `ClassworkFeedback:${reqId}:stream`,
    }).catch((err) => {
      console.error(
        `[ClassworkFeedback][req=${reqId}][stream] deferred token-usage write failed:`,
        err,
      );
    });
    recordAiCallLog({
      reqId,
      tag: "ClassworkFeedback:stream",
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
      usageMetadata,
    });
  });

  return feedback;
}
