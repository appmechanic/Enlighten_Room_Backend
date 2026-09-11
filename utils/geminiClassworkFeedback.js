
import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import fetch from "node-fetch";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import { getTeacherPromptCached } from "./promptCache.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import {
  getAiModel,
  getAiRetry,
  getAiStandardHintPrompt,
} from "./aiConfig.js";
import { getOrCreateClassworkFeedbackCache } from "./classworkGeminiCache.js";
import {
  classworkResponseCacheKey,
  getCachedClassworkResponse,
  setCachedClassworkResponse,
} from "./classworkResponseCache.js";

// Classwork feedback resolves its standard prompt + directives from the
// admin-edited StandardPrompt via aiConfig (60s in-memory cache). Both fall
// back to the canonical defaults in config/standardPromptDefaults.js if the
// DB is unseeded or unreachable, so behaviour degrades gracefully. To pin
// back to the source-tree copy in an emergency, replace the getters below
// with the AI_HINT_PROMPT_SECTION_DEFAULTS / DIRECTIVE_DEFAULTS constants.

// Feedback-tuning knobs hard-coded so the waiting-time-oriented values
// actually take effect regardless of what's seeded in Mongo. Same rationale
// as the prompt/schema hardcoding above: reproducible from source, no DB
// merge shadowing the values, iterate here to move student TTFT. Anything
// still admin-tuneable per teacher (retry budget, model choice) continues
// to come from getAiRetry / getAiModel.
const HARDCODED_FEEDBACK_TUNING = {
  defaultMaxOutputTokens: 500,
  thinkingBudgetRatio: 0.2,
  maxThinkingBudget: 2048,
  imageStudyFormats: ["handwriting"],
  equivalenceCheckBudget: 128,
  uncachedMinThinkingBudget: 192,
};

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
// No cached solution -> ratio-share for derivation, floored by
// tuning.uncachedMinThinkingBudget so the model has room to run the
// equivalence check on top. (Historically the raw share alone — 160 tokens
// at ratio 0.2 × 800 — collapsed equivalence to surface string matching
// and trivially-equivalent forms like -5sin5x vs -5sin(5x) got flagged
// wrong.)
// Cached solution present -> the model isn't deriving anything, but it STILL
// has to judge whether the student's answer is mathematically equivalent to
// the canonical final answer (e.g. -(5sin(5x)) vs -5\sin(5x)). With 0
// thinking that collapses to surface string matching. So we keep a small
// floor (tuning.equivalenceCheckBudget) dedicated to that comparison.
// imageStudy formats need enough on top to also read the handwriting.
// The result is capped by tuning.maxThinkingBudget so a huge output budget
// can't translate into a long pre-stream thinking delay before the hint
// appears.
function resolveThinkingBudget(resolvedMaxOutputTokens, hasCachedSolution, format, tuning) {
  const share = Math.round(resolvedMaxOutputTokens * tuning.thinkingBudgetRatio);
  const imageStudy = new Set(tuning.imageStudyFormats || []);
  const equivFloor = Number(tuning.equivalenceCheckBudget) > 0
    ? Number(tuning.equivalenceCheckBudget)
    : 256;
  if (!hasCachedSolution) {
    const uncachedFloor = Number(tuning.uncachedMinThinkingBudget) > 0
      ? Number(tuning.uncachedMinThinkingBudget)
      : equivFloor;
    return Math.min(Math.max(share, uncachedFloor), tuning.maxThinkingBudget);
  }
  if (imageStudy.has(format)) {
    return Math.min(Math.max(Math.round(share / 2), equivFloor), tuning.maxThinkingBudget);
  }
  return Math.min(equivFloor, tuning.maxThinkingBudget);
}

// The hint prompt is now assembled from just two admin-editable inputs:
// getAiStandardHintPrompt() (the joined aiHintPromptSections) and
// getTeacherPromptCached(teacherId) (per-teacher customization). Any rules
// the model must follow (equivalence, ask/tell, compute flags, etc.) live
// inside those sections in the AdminAiPrompts UI — no separate directives.

// Property order matters: Gemini emits structured-JSON fields in the
// order they appear in the schema.
// `correct` goes first (before the streamable text) so the client sees the
// verdict within a token or two of the first chunk and can render
// "✅ Correct" / "keep going" before the hint has finished streaming. This
// costs hintStream ~5-10 tokens of delay to its first character (one bool
// value + JSON syntax) but wins several seconds of perceived latency on
// handwriting/image submissions where the full JSON otherwise finishes only
// after image + hint reasoning.
// Everything after `correct` still follows the original ordering
// (hintStream, part1, part2 first for progressive rendering; heavier
// metadata like commonMistake/standardSolution last).
// Frozen response schema for the classwork feedback call. Property order
// matters: Gemini emits structured-JSON fields in the order they appear, so
// `correct` goes first — the client shows "✅ Correct" / "keep going" within
// a token or two of the first chunk, without waiting for the hint stream to
// finish. Two variants: with/without `standardSolution`, so callers pick
// instead of branching a schema factory at call time.
const CLASSWORK_SCHEMA_PROPERTIES = {
  correct: {
    type: Type.BOOLEAN,
    description:
      "true only when the student's answer is complete and correct; otherwise false. This field MUST be emitted first so the client can show the verdict without waiting for the hint.",
  },
  hintStream: {
    type: Type.STRING,
    description:
      "The concise live hint the student sees typing in real time. STRICT: 1-2 short sentences MAX in the question's language. Greet by first name and give the single most important next-step nudge toward the correct method WITHOUT revealing the final answer. Be terse — no acknowledgment paragraphs, no restatement of what they did, no filler. Must stand alone as a useful hint; never just a greeting and never a copy of part1.",
  },
  part1: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description:
      "Acknowledgment. EXACTLY ONE short string: greet by first name and name the last correct step. Do NOT add more entries.",
  },
  part2: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description:
      "Immediate Next Step Guidance. EXACTLY 4 strings in order: DON'T / WHAT / HOW / WHY. Each string starts with its subtitle in the question's language. WHY length scales with grade (≤1 sentence for grade ≤3, ≤50 words for grade 4–8, a paragraph for grade 8+). Use empty string for HOW or WHY if not needed.",
  },
  part3: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description:
      "Diagnostic training suggestions. EXACTLY 2 short strings: [0] training for the previous-milestone gap, [1] training for the current-milestone difficulty.",
  },
  advancedChallenge: {
    type: Type.OBJECT,
    description:
      "Only filled when correct is true: 1 short congratulation + 1 new question one level harder. Leave both fields empty strings when the answer is not yet correct.",
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

const CLASSWORK_SCHEMA_REQUIRED = [
  "hintStream",
  "part1",
  "part2",
  "correct",
  "part3",
  "advancedChallenge",
];

const CLASSWORK_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: CLASSWORK_SCHEMA_PROPERTIES,
  required: CLASSWORK_SCHEMA_REQUIRED,
};

const CLASSWORK_RESPONSE_SCHEMA_WITH_SOLUTION = {
  type: Type.OBJECT,
  properties: {
    ...CLASSWORK_SCHEMA_PROPERTIES,
    standardSolution: { type: Type.STRING },
  },
  required: CLASSWORK_SCHEMA_REQUIRED,
};

function pickClassworkResponseSchema(computeStandardSolution) {
  return computeStandardSolution
    ? CLASSWORK_RESPONSE_SCHEMA_WITH_SOLUTION
    : CLASSWORK_RESPONSE_SCHEMA;
}

// Purely mechanical cleanup applied to both the student answer and the
// reference answer before they hit Gemini. Removes invisible chars,
// canonicalises unicode, and collapses whitespace so trivially-equivalent
// strings look identical byte-for-byte at pattern-match time. NO semantic
// transforms — LaTeX commands, case, and math operators are preserved
// exactly as written. Anything the AI is supposed to decide (\\sin vs sin,
// -5 vs -(5)) stays for the equivalence rules.
function cleanTextForAi(text) {
  if (typeof text !== "string") return text;
  return text
    .normalize("NFC")                     // é+combining-mark → é
    .replace(/[\u200B-\u200D\uFEFF]/g, "")// zero-width space/joiner/non-joiner/BOM
    .replace(/[\u00A0\u2028\u2029]/g, " ")// NBSP, line/paragraph separators → space
    .replace(/\r\n|\r/g, "\n")            // normalise line endings
    .replace(/[ \t]+/g, " ")              // collapse horizontal whitespace runs
    .replace(/ *\n */g, "\n")             // strip padding around newlines
    .replace(/\n{3,}/g, "\n\n")           // collapse excess vertical whitespace
    .trim();
}

// Conservative deterministic normalization used ONLY by the server-side
// equivalence pre-check. Deliberately narrow: it collapses formatting
// differences (whitespace, LaTeX backslashes on function names, implicit
// vs explicit multiplication, implicit vs explicit function-argument
// parens) but does NOT do algebraic simplification, coefficient
// re-ordering, or negative-sign redistribution. Those richer equivalences
// still route to the AI equivalence rules where they belong.
// Rationale: the AI has been flipping trivial cases like `-5sin5x` vs
// `-5sin(5x)` to correct=false, sending students into 40+ attempt loops.
// A narrow deterministic normalizer that only catches formatting-only
// divergences gives us a low-false-positive fast lane. Anything richer
// stays with the AI.
function normalizeForEquivalencePreCheck(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  return text
    .toLowerCase()
    .replace(
      /\\(sin|cos|tan|cot|sec|csc|log|ln|sqrt|exp|pi|theta|alpha|beta|gamma|cdot|times|frac|left|right)/g,
      "$1",
    )
    .replace(/\bcdot\b|\btimes\b/g, "*")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, "")
    .replace(/\*/g, "")
    .replace(/·/g, "")
    .replace(
      /(sin|cos|tan|cot|sec|csc|log|ln|sqrt|exp)\(([-+]?[0-9]*[a-z]+(?:\^[-+]?[0-9]+)?)\)/g,
      "$1$2",
    );
}

// Returns true when the student's answer is deterministically equivalent
// to the reference under normalizeForEquivalencePreCheck. Deliberately
// scoped narrow — only fires for plain string answers with a single-string
// or single-element-array reference. Images, arrays (fill-in-blanks), and
// missing references fall through to the AI.
export function serverSideEquivalenceMatches(answer, correctAnswer, format) {
  if (format === "handwriting") return false;
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    if (answer.type === "image" || answer.imageUrl) return false;
  }
  if (Array.isArray(answer)) return false;

  const studentText =
    typeof answer === "string"
      ? answer
      : typeof answer?.text === "string"
        ? answer.text
        : typeof answer?.value === "string"
          ? answer.value
          : "";
  if (!studentText.trim()) return false;

  let referenceText = "";
  if (typeof correctAnswer === "string") {
    referenceText = correctAnswer;
  } else if (Array.isArray(correctAnswer)) {
    const nonEmpty = correctAnswer
      .map((v) => (typeof v === "string" ? v : ""))
      .filter((v) => v.trim());
    if (nonEmpty.length !== 1) return false;
    referenceText = nonEmpty[0];
  } else {
    return false;
  }
  if (!referenceText.trim()) return false;

  const normStudent = normalizeForEquivalencePreCheck(studentText);
  const normReference = normalizeForEquivalencePreCheck(referenceText);
  if (!normStudent || !normReference) return false;
  return normStudent === normReference;
}

function formatCorrectAnswerForPrompt(value) {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => cleanTextForAi(String(entry ?? "")))
      .filter(Boolean);
    if (items.length === 0) return "";
    if (items.length === 1) return items[0];
    return items.map((a, i) => `${i + 1}. ${a}`).join("\n");
  }
  if (value == null) return "";
  return cleanTextForAi(String(value));
}

function normalizeAnswerText(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => `Blank ${index + 1}: ${cleanTextForAi(String(entry ?? ""))}`)
      .join("\n");
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string" && value.text.trim()) {
      return cleanTextForAi(value.text);
    }
    if (typeof value.value === "string" && value.value.trim()) {
      return cleanTextForAi(value.value);
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
      : cleanTextForAi(value);
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
  if (typeof answer === "object") {
    // Prefer the in-memory base64 the client already sent. sourceToInlineData
    // recognises data: URLs and skips the fetch entirely, which saves the
    // Spaces CDN round trip on every handwriting submission.
    if (
      typeof answer.imageData === "string" &&
      /^data:image\//i.test(answer.imageData)
    ) {
      return answer.imageData;
    }
    if (typeof answer.imageUrl === "string" && answer.imageUrl.trim()) {
      return answer.imageUrl;
    }
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

async function buildGeminiRequest({
  reqId,
  questionText,
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
  // Only two admin-editable inputs feed the Gemini hint call now: the
  // global standardPrompt (aiHintPromptSections joined) and the per-teacher
  // teacherPrompt. All previous runtime-injected directives (math
  // equivalence, hint-stream rules, ask/tell pedagogy, compute/skip
  // solution+mistake, server pre-check override) and the cached canonical
  // solution / mistakes bank were removed — any rules the admin wants the
  // model to follow must live inside the aiHintPromptSections themselves.
  const [teacherPrompt, standardText] = await Promise.all([
    getTeacherPromptCached(teacherId),
    getAiStandardHintPrompt(),
  ]);
  const standardPromptHash = crypto
    .createHash("sha1")
    .update(standardText)
    .digest("hex");

  const systemInstruction = [standardText, teacherPrompt]
    .filter(Boolean)
    .join("\n\n");

  // Size sanity: classworkGeminiCache requires >=400 chars and Gemini itself
  // requires ~1024 tokens (~4096 chars) before caches.create will succeed.
  console.log(
    `[ClassworkFeedback][req=${reqId}] systemInstruction len=${systemInstruction.length} ~tokens=${Math.round(systemInstruction.length / 4)} slots={std=${standardText?.length || 0},teacher=${teacherPrompt?.length || 0}}`,
  );

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

  // Attach the raw question image whenever one exists. We deliberately do NOT
  // OCR-transcribe it up front — the transcription lost fidelity on math
  // notation (e.g. "d/dx(cos 5x)" flattened to "d cos5x/dx"), which broke the
  // correct/incorrect judgement. Sending the image lets Gemini read the real
  // notation on every submission. Latency > tokens here.
  const effectiveQuestionText = questionText || "";
  const includeRawQuestionImage = Boolean(questionImage);

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
        ? `Reference / Correct Answer (AI-derived from the canonical solution): ${derivedReferenceAnswer}`
        : null,
    `Student Answer: ${normalizedAnswerText || "[No text provided]"}`,
    includeRawQuestionImage ? "A question image is attached." : null,
    answerImageSource
      ? "A student answer image is attached. Inspect the handwriting/image carefully."
      : null,
  ].filter(Boolean);

  const parts = [];

  // Fetch both images in parallel — for handwriting submissions both are
  // present, so serializing the two round trips added the slower image's
  // full latency on top of the faster one before the Gemini call could
  // start.
  const [questionImageData, answerImageData] = await Promise.all([
    includeRawQuestionImage
      ? sourceToInlineData(questionImage).catch(() => null)
      : null,
    answerImageSource
      ? sourceToInlineData(answerImageSource).catch(() => null)
      : null,
  ]);

  if (questionImageData) {
    parts.push({ text: "Question image:" });
    parts.push({
      inlineData: { data: questionImageData.base64, mimeType: questionImageData.mimeType },
    });
  }

  if (answerImageData) {
    parts.push({ text: "Student answer image:" });
    parts.push({
      inlineData: { data: answerImageData.base64, mimeType: answerImageData.mimeType },
    });
  }

  parts.push({ text: promptLines.join("\n") });

  const userPromptText = promptLines.join("\n");

  return {
    systemInstruction,
    contents: [{ role: "user", parts }],
    standardPromptHash,
    standardPromptText: standardText,
    teacherPromptText: teacherPrompt,
    userPromptText,
    hasCachedSolution: false,
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

// Shape of the feedback we return when serverSideEquivalenceMatches says
// the student is definitively correct — the normalizer here is narrow
// enough that a match is authoritative and Gemini can't rationalise it
// away. The hint is deliberately generic (we don't have the model's
// question-language detection); pedagogy arrays stay empty because there
// is no error to coach through.
function buildCannedCorrectFeedback(studentName) {
  const greeting = studentName ? `${studentName}, ` : "";
  return {
    correct: true,
    hintStream: `${greeting}excellent work — your answer is correct. Keep going!`,
    part1: [],
    part2: [],
    part3: [],
    advancedChallenge: { congratulations: "", question: "" },
    standardSolution: "",
    commonMistake: { isCommon: false, title: "", answerLatex: "" },
    raw: "",
  };
}

export async function getClassworkAiFeedback({
  questionText,
  answer,
  correctAnswer,
  derivedCorrectAnswer,
  questionImage,
  format,
  studentName,
  studentId,
  classroomId,
  teacherId,
  questionId,
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
  const normalizedAnswer = normalizeAnswerText(answer);

  // Server-side equivalence pre-check — authoritative when it matches, so
  // we can skip Gemini entirely. Runs BEFORE the response cache because
  // it's still cheaper (one string normalise + compare) and safer
  // (guaranteed correctness verdict; the response cache could hold an
  // older correct=false verdict from before the teacher fixed a bad
  // correctAnswer, and we'd rather trust the current server check).
  if (serverSideEquivalenceMatches(answer, correctAnswer, format)) {
    const canned = buildCannedCorrectFeedback(studentName);
    console.log(
      `[ClassworkFeedback][req=${reqId}] server-side equivalence match — skipping Gemini call`,
    );
    // Log a lightweight audit row so the admin dashboard still shows this
    // submission. usageMetadata=null means zero tokens billed.
    recordAiCallLog({
      reqId,
      tag: "ClassworkFeedback:preCheck",
      model: "",
      sessionId,
      classroomId,
      teacherId,
      studentId,
      studentName,
      questionText,
      studentAnswer: normalizedAnswer,
      aiResponseSummary: JSON.stringify(canned),
      userPromptText: "",
      standardPromptSnippet: "",
      standardPromptHash: "",
      teacherPromptSnippet: "",
      usageMetadata: null,
    });
    const preCheckKey = classworkResponseCacheKey({
      teacherId,
      questionId,
      normalizedAnswer,
    });
    if (preCheckKey) setCachedClassworkResponse(preCheckKey, canned);
    return canned;
  }

  // Response-level cache: if the same (teacher, question, normalizedAnswer)
  // has been graded within TTL, return the previous feedback and skip
  // Gemini entirely. Image-only submissions produce an empty normalized
  // answer and are not cached.
  const responseCacheKey = classworkResponseCacheKey({
    teacherId,
    questionId,
    normalizedAnswer,
  });
  const cachedResponse = responseCacheKey
    ? getCachedClassworkResponse(responseCacheKey)
    : null;
  if (cachedResponse) {
    console.log(
      `[ClassworkFeedback][req=${reqId}] response-cache HIT — skipping Gemini call`,
    );
    return cachedResponse;
  }

  const [MODEL, FALLBACK_MODEL, retryCfg] = await Promise.all([
    getAiModel(),
    getAiModel("fallback"),
    getAiRetry("classworkFeedback"),
  ]);
  const feedbackTuning = HARDCODED_FEEDBACK_TUNING;
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

  // Explicit prompt cache: the systemInstruction (standard + teacher + solution
  // block) is stable across every submission for this (teacher, question) so
  // we let Gemini keep it server-side. Cutting thousands of prefill tokens off
  // every call is the biggest single win for time-to-first-token on the
  // student's screen; see waiting_time_plans.txt lever A. Falls through to
  // inline systemInstruction if the cache create fails or the payload is under
  // the model's min-cache-token threshold.
  const cacheResult = await getOrCreateClassworkFeedbackCache({
    model: MODEL,
    teacherId,
    questionId,
    systemInstruction,
    tag: `ClassworkFeedback:${reqId}`,
  });

  // One-shot MAX_TOKENS retry: bilingual prompts + long thinking budgets can
  // truncate the JSON right before its closing brace, and parseFirstJsonObject
  // then returns null — the student sees "AI didn't return any hints." Re-issue
  // the call once with 2× the output budget. Capped so a runaway prompt can't
  // burn the full context window.
  const MAX_TOKENS_HARD_CAP = 16000;
  const callWithBudget = (tokens) => {
    const thinking = resolveThinkingBudget(
      tokens,
      hasCachedSolution,
      format,
      feedbackTuning,
    );
    const commonCfg = {
      responseMimeType: "application/json",
      responseSchema: pickClassworkResponseSchema(Boolean(computeStandardSolution)),
      thinkingConfig: { thinkingBudget: thinking },
      maxOutputTokens: tokens,
    };
    const primaryCfg = cacheResult.ok
      ? { cachedContent: cacheResult.name, ...commonCfg }
      : { systemInstruction, ...commonCfg };
    const fallbackCfg = { systemInstruction, ...commonCfg };
    return withGeminiRetry(
      () =>
        ai.models.generateContent({ model: MODEL, contents, config: primaryCfg }),
      {
        maxAttempts: retryCfg.max,
        baseDelayMs: retryCfg.baseMs,
        maxDelayMs: retryCfg.capMs,
        tag: `ClassworkFeedback:${reqId}`,
        fallbackCallFn:
          FALLBACK_MODEL && FALLBACK_MODEL !== MODEL
            ? () =>
                ai.models.generateContent({
                  model: FALLBACK_MODEL,
                  contents,
                  config: fallbackCfg,
                })
            : undefined,
      },
    );
  };

  const apiStartMs = Date.now();
  console.log(
    `[ClassworkFeedback][req=${reqId}] AI hint API start: ${new Date(apiStartMs).toISOString()}`,
  );
  let result = await callWithBudget(resolvedMaxOutputTokens);
  let finishReason = result?.candidates?.[0]?.finishReason;
  if (
    finishReason === "MAX_TOKENS" &&
    resolvedMaxOutputTokens < MAX_TOKENS_HARD_CAP
  ) {
    const bumped = Math.min(resolvedMaxOutputTokens * 2, MAX_TOKENS_HARD_CAP);
    console.warn(
      `[ClassworkFeedback][req=${reqId}] MAX_TOKENS at ${resolvedMaxOutputTokens} → retrying once at ${bumped}`,
    );
    const retried = await callWithBudget(bumped);
    const retriedFinish = retried?.candidates?.[0]?.finishReason;
    // Only accept the retry if it didn't also truncate — otherwise keep the
    // first result so downstream logging/shaping stays consistent.
    if (retriedFinish !== "MAX_TOKENS") {
      result = retried;
      finishReason = retriedFinish;
    }
  }
  const apiEndMs = Date.now();
  console.log(
    `[ClassworkFeedback][req=${reqId}] AI hint API end: ${new Date(apiEndMs).toISOString()} (duration ${apiEndMs - apiStartMs}ms)`,
  );

  logAiUsage(
    reqId,
    result?.usageMetadata,
    "ClassworkFeedback",
    finishReason,
  );

  const responseText = result.text || "";
  const parsed = parseFirstJsonObject(responseText, {
    tag: `ClassworkFeedback:${reqId}`,
  });

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

  // Populate the response cache so an identical resubmit within TTL
  // returns immediately without a Gemini call.
  if (responseCacheKey) {
    setCachedClassworkResponse(responseCacheKey, feedback);
  }

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
// Sibling of createHintStreamScanner that watches for the first
// `"correct":true|false` in the growing JSON buffer and fires `onVerdict`
// exactly once with the boolean value. Because the response schema now
// declares `correct` as the very first property, Gemini emits it within
// the first handful of tokens — the client can render "correct"/"keep
// going" seconds before the full hint has finished streaming.
// Deliberately narrow: doesn't try to be a JSON parser. Looks for the
// literal key `"correct"`, then the next non-whitespace char after `:`
// starting with `t` (true) or `f` (false). Fires once and stays quiet
// for the rest of the stream.
export function createVerdictScanner({ onVerdict }) {
  const KEY = '"correct"';
  let buffer = "";
  let state = "SEARCH_KEY"; // SEARCH_KEY -> AWAIT_COLON -> AWAIT_VALUE -> DONE
  let cursor = 0;
  let fired = false;

  function fire(value) {
    if (fired) return;
    fired = true;
    state = "DONE";
    try {
      onVerdict(value);
    } catch (err) {
      console.error("[VerdictScanner] onVerdict threw:", err);
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
        state = "AWAIT_COLON";
        continue;
      }
      if (state === "AWAIT_COLON") {
        const ch = buffer[cursor];
        if (ch === ":") {
          cursor += 1;
          state = "AWAIT_VALUE";
          continue;
        }
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
          cursor += 1;
          continue;
        }
        // Unexpected — bail out silently rather than mis-report a verdict.
        state = "DONE";
        return;
      }
      if (state === "AWAIT_VALUE") {
        const ch = buffer[cursor];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
          cursor += 1;
          continue;
        }
        // We need enough tail to disambiguate "true" from "false" — wait
        // for the next chunk if the literal is split across the boundary.
        if (ch === "t") {
          if (buffer.length - cursor < 4) return;
          if (buffer.slice(cursor, cursor + 4) === "true") {
            fire(true);
            return;
          }
        } else if (ch === "f") {
          if (buffer.length - cursor < 5) return;
          if (buffer.slice(cursor, cursor + 5) === "false") {
            fire(false);
            return;
          }
        }
        // Not a boolean literal — bail out silently.
        state = "DONE";
        return;
      }
    }
  }

  return {
    push(chunk) {
      if (fired || typeof chunk !== "string" || chunk.length === 0) return;
      buffer += chunk;
      scan();
    },
    isDone() {
      return state === "DONE";
    },
  };
}

export function createHintStreamScanner({ onDelta, onClose }) {
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
  // Full decoded hintStream text so onClose can hand the assembled string
  // to callers (e.g. the SSE layer) without re-scanning.
  let decoded = "";
  // Distinguishes graceful end-of-string ('"' terminator) from error bail-outs
  // ("Unexpected between…" branches also set state=DONE) so onClose fires only
  // when we actually saw the closing quote.
  let sawStringEnd = false;
  let onCloseFired = false;

  function emit(char) {
    if (!char) return;
    pending += char;
    decoded += char;
  }

  // Deliver everything decoded during this push() as a single chunk.
  // When more data may still arrive (`final=false`), hold back a trailing
  // high-surrogate so it stays paired with the low-surrogate that arrives
  // in the next push(); splitting a supplementary-plane code point across
  // two onDelta calls corrupts emoji like 🛑 / 🔨 / 🔍 on the wire.
  function flush(final = false) {
    if (!pending) return;
    let chunk = pending;
    pending = "";
    if (!final) {
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        pending = chunk[chunk.length - 1];
        chunk = chunk.slice(0, -1);
        if (!chunk) return;
      }
    }
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
            sawStringEnd = true;
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
        // At DONE the closing '"' has been consumed, so release any
        // held-back surrogate too.
        flush(state === "DONE");
      }
      if (sawStringEnd && !onCloseFired && typeof onClose === "function") {
        onCloseFired = true;
        try {
          onClose(decoded);
        } catch (err) {
          console.error("[HintStreamScanner] onClose threw:", err);
        }
      }
    },
    isDone() {
      return state === "DONE";
    },
  };
}

// Incremental scanner that walks a top-level JSON array of strings and
// forwards decoded chars for each element as they arrive. Mirrors
// createHintStreamScanner's escape/unicode handling. `fieldName` is the
// bare property name (e.g. "part1"); the scanner looks for `"part1"` at
// the buffer's top level. Callbacks fire in order:
//   onDelta(index, chunk)     — decoded chars for the item at `index`,
//                               batched per push() call
//   onItemClose(index, full)  — item's closing quote seen; delivers the
//                               fully decoded string for that item
//   onArrayClose()            — array's closing `]` seen; scanner is done
// A bare literal `"part1"` cannot appear inside another JSON string value
// (the quotes would be escaped as `\"`), so top-level indexOf is safe.
export function createArrayStreamScanner({ fieldName, onDelta, onItemClose, onArrayClose }) {
  const KEY = `"${fieldName}"`;
  let buffer = "";
  let cursor = 0;
  // SEARCH_KEY → AWAIT_COLON → AWAIT_ARRAY → BETWEEN_ITEMS → IN_STRING → DONE
  let state = "SEARCH_KEY";
  let escape = false;
  let unicodePending = null;
  let currentIndex = -1;
  let currentDecoded = "";
  let currentPending = "";
  let arrayCloseFired = false;

  const safeFire = (name, fn, ...args) => {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (err) {
      console.error(`[ArrayStreamScanner:${fieldName}] ${name} threw:`, err);
    }
  };

  // Hold back a trailing high-surrogate unless `final=true`, so a
  // supplementary-plane code point (🛑/🔨/🔍…) never straddles two
  // onDelta calls. Item-close and array-close pass final=true so the
  // sum of deltas still equals currentDecoded.
  const flushDelta = (final = false) => {
    if (!currentPending || currentIndex < 0) return;
    let chunk = currentPending;
    currentPending = "";
    if (!final) {
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        currentPending = chunk[chunk.length - 1];
        chunk = chunk.slice(0, -1);
        if (!chunk) return;
      }
    }
    safeFire("onDelta", onDelta, currentIndex, chunk);
  };

  const emitChar = (ch) => {
    if (!ch) return;
    currentPending += ch;
    currentDecoded += ch;
  };

  const isWs = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

  function scan() {
    while (cursor < buffer.length && state !== "DONE") {
      if (state === "SEARCH_KEY") {
        const idx = buffer.indexOf(KEY, cursor);
        if (idx === -1) {
          cursor = Math.max(buffer.length - KEY.length, cursor);
          return;
        }
        cursor = idx + KEY.length;
        state = "AWAIT_COLON";
        continue;
      }

      if (state === "AWAIT_COLON") {
        const ch = buffer[cursor];
        cursor += 1;
        if (ch === ":") state = "AWAIT_ARRAY";
        else if (!isWs(ch)) {
          state = "DONE";
          return;
        }
        continue;
      }

      if (state === "AWAIT_ARRAY") {
        const ch = buffer[cursor];
        cursor += 1;
        if (ch === "[") state = "BETWEEN_ITEMS";
        else if (!isWs(ch)) {
          state = "DONE";
          return;
        }
        continue;
      }

      if (state === "BETWEEN_ITEMS") {
        const ch = buffer[cursor];
        cursor += 1;
        if (ch === '"') {
          currentIndex += 1;
          currentDecoded = "";
          currentPending = "";
          state = "IN_STRING";
        } else if (ch === "]") {
          state = "DONE";
          arrayCloseFired = true;
          safeFire("onArrayClose", onArrayClose);
          return;
        } else if (ch !== "," && !isWs(ch)) {
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
            if (Number.isFinite(code)) emitChar(String.fromCharCode(code));
          }
          continue;
        }
        if (escape) {
          escape = false;
          if (ch === "n") emitChar("\n");
          else if (ch === "t") emitChar("\t");
          else if (ch === "r") emitChar("\r");
          else if (ch === "u") unicodePending = "";
          else if (ch === "\\" || ch === '"' || ch === "/") emitChar(ch);
          else emitChar(ch);
          continue;
        }
        if (ch === "\\") {
          if (cursor >= buffer.length) {
            cursor -= 1;
            return;
          }
          escape = true;
          continue;
        }
        if (ch === '"') {
          // Close of current item — flush any pending delta first so
          // onItemClose fires strictly after the last onDelta for this
          // index. Then continue scanning; the array may close in the
          // same push(). `final=true` releases a lone trailing high
          // surrogate so the delta stream matches currentDecoded.
          flushDelta(true);
          safeFire("onItemClose", onItemClose, currentIndex, currentDecoded);
          state = "BETWEEN_ITEMS";
          continue;
        }
        emitChar(ch);
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
        // Once the array has closed no more chunks can arrive, so
        // release any trailing high surrogate rather than pinning it.
        flushDelta(state === "DONE");
      }
    },
    isDone() {
      return state === "DONE";
    },
    isArrayClosed() {
      return arrayCloseFired;
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
  answer,
  correctAnswer,
  derivedCorrectAnswer,
  questionImage,
  format,
  studentName,
  studentId,
  classroomId,
  teacherId,
  questionId,
  maxOutputTokens,
  sessionId,
  interactionId,
  previousInteractionId,
  submissionNumber,
  cachedContext,
  computeStandardSolution = false,
  computeCommonMistake = false,
  onHintDelta,
  onHintClose,
  onVerdict,
  onBodyDelta,
  onBodyClose,
}) {
  const reqId = newReqId();
  const normalizedAnswer = normalizeAnswerText(answer);

  const safeCall = (fn, ...args) => {
    if (typeof fn !== "function") return;
    try {
      fn(...args);
    } catch (err) {
      console.error(
        `[ClassworkFeedback][req=${reqId}][stream] callback threw:`,
        err,
      );
    }
  };

  const replayFeedbackThroughCallbacks = (feedback) => {
    safeCall(onVerdict, Boolean(feedback.correct));
    if (feedback.hintStream) safeCall(onHintDelta, feedback.hintStream);
    safeCall(onHintClose, feedback.hintStream || "");
    for (const field of ["part1", "part2"]) {
      const items = Array.isArray(feedback[field]) ? feedback[field] : [];
      items.forEach((text, index) => {
        safeCall(onBodyDelta, field, index, text);
        safeCall(onBodyClose, field, index, text);
      });
    }
  };

  // Server-side equivalence pre-check — authoritative when it matches, so
  // we skip Gemini entirely and replay a canned "correct" feedback through
  // the streaming callbacks.
  if (serverSideEquivalenceMatches(answer, correctAnswer, format)) {
    const canned = buildCannedCorrectFeedback(studentName);
    console.log(
      `[ClassworkFeedback][req=${reqId}][stream] server-side equivalence match — skipping Gemini call`,
    );
    replayFeedbackThroughCallbacks(canned);
    recordAiCallLog({
      reqId,
      tag: "ClassworkFeedback:stream:preCheck",
      model: "",
      sessionId,
      classroomId,
      teacherId,
      studentId,
      studentName,
      questionText,
      studentAnswer: normalizedAnswer,
      aiResponseSummary: JSON.stringify(canned),
      userPromptText: "",
      standardPromptSnippet: "",
      standardPromptHash: "",
      teacherPromptSnippet: "",
      usageMetadata: null,
    });
    const preCheckKey = classworkResponseCacheKey({
      teacherId,
      questionId,
      normalizedAnswer,
    });
    if (preCheckKey) setCachedClassworkResponse(preCheckKey, canned);
    return canned;
  }

  // Response-level cache: replay a previously-cached response through the
  // streaming callbacks so the SSE controller emits the exact same event
  // sequence it would for a live stream, but skips the Gemini call. No
  // artificial delays — deltas fire back-to-back and the client sees the
  // full response essentially instantly.
  const responseCacheKey = classworkResponseCacheKey({
    teacherId,
    questionId,
    normalizedAnswer,
  });
  const cachedResponse = responseCacheKey
    ? getCachedClassworkResponse(responseCacheKey)
    : null;
  if (cachedResponse) {
    console.log(
      `[ClassworkFeedback][req=${reqId}][stream] response-cache HIT — replaying cached response`,
    );
    replayFeedbackThroughCallbacks(cachedResponse);
    return cachedResponse;
  }

  const [MODEL, FALLBACK_MODEL, retryCfg] = await Promise.all([
    getAiModel(),
    getAiModel("fallback"),
    getAiRetry("classworkFeedback"),
  ]);
  const feedbackTuning = HARDCODED_FEEDBACK_TUNING;
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

  // Explicit prompt cache: same rationale as the non-stream path — the
  // systemInstruction is stable per (teacher, question), so caching it on
  // Gemini's side removes thousands of prefill tokens from every submission
  // and is the largest single lever for time-to-first-hint-chunk. Falls back
  // to inline systemInstruction if cache create fails or the payload is under
  // the min-cache-token threshold.
  const cacheResult = await getOrCreateClassworkFeedbackCache({
    model: MODEL,
    teacherId,
    questionId,
    systemInstruction,
    tag: `ClassworkFeedback:${reqId}:stream`,
  });

  const config = cacheResult.ok
    ? {
        cachedContent: cacheResult.name,
        responseMimeType: "application/json",
        responseSchema: pickClassworkResponseSchema(Boolean(computeStandardSolution)),
        thinkingConfig: { thinkingBudget },
        maxOutputTokens: resolvedMaxOutputTokens,
      }
    : {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: pickClassworkResponseSchema(Boolean(computeStandardSolution)),
        thinkingConfig: { thinkingBudget },
        maxOutputTokens: resolvedMaxOutputTokens,
      };

  // Kept in scope for the FALLBACK_MODEL retry slot below — the fallback
  // model doesn't share the primary's cache so we hand it inline context.
  const inlineConfig = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: pickClassworkResponseSchema(Boolean(computeStandardSolution)),
    thinkingConfig: { thinkingBudget },
    maxOutputTokens: resolvedMaxOutputTokens,
  };

  // Fires once when the hintStream string terminates in the JSON stream —
  // signals that everything the student sees typing has landed and the
  // trailing pedagogy fields (part1/2/3/advancedChallenge) are still
  // streaming. Lets the SSE layer flip the modal from "checking" to
  // "feedback ready" ~3-5s before the full response completes.
  let hintCloseFired = false;
  const scanner = createHintStreamScanner({
    onDelta: typeof onHintDelta === "function" ? onHintDelta : () => {},
    onClose: (fullHint) => {
      if (hintCloseFired) return;
      hintCloseFired = true;
      if (typeof onHintClose === "function") {
        try {
          onHintClose(fullHint);
        } catch (err) {
          console.error(
            `[ClassworkFeedback][req=${reqId}][stream] onHintClose threw:`,
            err,
          );
        }
      }
    },
  });
  // Fires once, as soon as `"correct":true|false` shows up in the stream —
  // usually within the first Gemini chunk since the schema puts `correct`
  // first. Lets the SSE layer surface a verdict before the hint finishes.
  let verdictFired = false;
  const verdictScanner = createVerdictScanner({
    onVerdict: (value) => {
      if (verdictFired) return;
      verdictFired = true;
      if (typeof onVerdict === "function") {
        try {
          onVerdict(value);
        } catch (err) {
          console.error(
            `[ClassworkFeedback][req=${reqId}][stream] onVerdict threw:`,
            err,
          );
        }
      }
    },
  });

  // Body streaming: part1 (acknowledgment) + part2 (DON'T/WHAT/HOW/WHY)
  // arrive after hintStream in schema order. We fan each into the SSE
  // layer as it decodes so the client can type them out live under the
  // hint instead of receiving them all at once in the terminal payload.
  const bodyFieldsSeen = new Set(); // "part1"|"part2" — remembered so the
  // done-time fallback below only fires for fields whose scanner truly
  // never saw a close (e.g. malformed / fenced JSON).
  const bodyItemClosed = new Set(); // "field:index" — same rationale, but
  // per item, so the fallback can top up individual missed items.
  const makeArrayScanner = (fieldName) =>
    createArrayStreamScanner({
      fieldName,
      onDelta: (index, chunk) => {
        if (typeof onBodyDelta !== "function") return;
        try {
          onBodyDelta({ field: fieldName, index, chunk });
        } catch (err) {
          console.error(
            `[ClassworkFeedback][req=${reqId}][stream] onBodyDelta threw:`,
            err,
          );
        }
      },
      onItemClose: (index, text) => {
        bodyItemClosed.add(`${fieldName}:${index}`);
        if (typeof onBodyClose !== "function") return;
        try {
          onBodyClose({ field: fieldName, index, text });
        } catch (err) {
          console.error(
            `[ClassworkFeedback][req=${reqId}][stream] onBodyClose threw:`,
            err,
          );
        }
      },
      onArrayClose: () => {
        bodyFieldsSeen.add(fieldName);
      },
    });
  const part1Scanner = makeArrayScanner("part1");
  const part2Scanner = makeArrayScanner("part2");

  // The SDK's streaming call doesn't return a status code the retry
  // wrapper knows how to inspect until we start iterating — so we retry
  // the whole stream-open + drain sequence together. The classwork
  // budget is small (3 attempts) so failure is quickly visible.
  let responseText = "";
  let finalResponse = null;

  const openAndDrainWith = (modelId, cfg) => async () => {
    responseText = "";
    finalResponse = null;
    const stream = await ai.models.generateContentStream({
      model: modelId,
      contents,
      config: cfg,
    });
    for await (const chunk of stream) {
      const piece = chunk?.text ?? "";
      if (piece) {
        responseText += piece;
        verdictScanner.push(piece);
        scanner.push(piece);
        part1Scanner.push(piece);
        part2Scanner.push(piece);
      }
      // Keep the LAST chunk that carries either usage or a finishReason —
      // Gemini emits finishReason on the final chunk (usually the same chunk
      // that carries usageMetadata, but not always).
      if (chunk?.usageMetadata || chunk?.candidates?.[0]?.finishReason) {
        finalResponse = chunk;
      }
    }
    return finalResponse;
  };

  const apiStartMs = Date.now();
  console.log(
    `[ClassworkFeedback][req=${reqId}][stream] AI hint API start: ${new Date(apiStartMs).toISOString()}`,
  );
  const usageBearingChunk = await withGeminiRetry(openAndDrainWith(MODEL, config), {
    maxAttempts: retryCfg.max,
    baseDelayMs: retryCfg.baseMs,
    maxDelayMs: retryCfg.capMs,
    tag: `ClassworkFeedback:${reqId}:stream`,
    fallbackCallFn: FALLBACK_MODEL && FALLBACK_MODEL !== MODEL
      ? openAndDrainWith(FALLBACK_MODEL, inlineConfig)
      : undefined,
  });
  const apiEndMs = Date.now();
  console.log(
    `[ClassworkFeedback][req=${reqId}][stream] AI hint API end: ${new Date(apiEndMs).toISOString()} (duration ${apiEndMs - apiStartMs}ms)`,
  );

  const usageMetadata = usageBearingChunk?.usageMetadata;
  const finishReason = usageBearingChunk?.candidates?.[0]?.finishReason;
  logAiUsage(reqId, usageMetadata, "ClassworkFeedback:stream", finishReason);

  const parsed = parseFirstJsonObject(responseText, {
    tag: `ClassworkFeedback:${reqId}:stream`,
  });

  const feedback = shapeFeedback(parsed, responseText);
  feedback.standardPromptHash = standardPromptHash;
  feedback.standardPromptText = standardPromptText;
  feedback.teacherPromptText = teacherPromptText;

  // Fallback: if the scanner never saw a boolean literal (schema quirk, JSON
  // wrapped in ```fences, etc.) still deliver the verdict once from the
  // fully-parsed result so the SSE layer's contract holds.
  if (!verdictFired && typeof onVerdict === "function") {
    verdictFired = true;
    try {
      onVerdict(Boolean(feedback.correct));
    } catch (err) {
      console.error(
        `[ClassworkFeedback][req=${reqId}][stream] fallback onVerdict threw:`,
        err,
      );
    }
  }

  // Same fallback for onHintClose: if the incremental scanner never fired
  // (fenced JSON, hintStream not first key, malformed stream) still hand
  // the client the final hint so it can transition out of "checking".
  if (!hintCloseFired && typeof onHintClose === "function") {
    hintCloseFired = true;
    try {
      onHintClose(String(feedback.hintStream || ""));
    } catch (err) {
      console.error(
        `[ClassworkFeedback][req=${reqId}][stream] fallback onHintClose threw:`,
        err,
      );
    }
  }

  // Body fallback: for any part1/part2 item the incremental scanner missed
  // (fenced JSON, malformed stream, or an interior string that ended after
  // the maxOutputTokens cutoff) synthesize a single delta + close from the
  // shaped result so the client's per-line accumulator lands with the same
  // final text as feedback.part1/part2. Skips items the scanner already
  // closed — those are authoritative from the live stream.
  const fallbackBodyField = (fieldName, items) => {
    if (!Array.isArray(items) || !items.length) return;
    items.forEach((rawText, index) => {
      const key = `${fieldName}:${index}`;
      if (bodyItemClosed.has(key)) return;
      const text = String(rawText ?? "");
      if (typeof onBodyDelta === "function" && text) {
        try {
          onBodyDelta({ field: fieldName, index, chunk: text });
        } catch (err) {
          console.error(
            `[ClassworkFeedback][req=${reqId}][stream] fallback onBodyDelta threw:`,
            err,
          );
        }
      }
      if (typeof onBodyClose === "function") {
        try {
          onBodyClose({ field: fieldName, index, text });
        } catch (err) {
          console.error(
            `[ClassworkFeedback][req=${reqId}][stream] fallback onBodyClose threw:`,
            err,
          );
        }
      }
      bodyItemClosed.add(key);
    });
  };
  fallbackBodyField("part1", feedback.part1);
  fallbackBodyField("part2", feedback.part2);

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

  // Populate the response cache so an identical resubmit within TTL is
  // served straight from memory without another Gemini call.
  if (responseCacheKey) {
    setCachedClassworkResponse(responseCacheKey, feedback);
  }

  return feedback;
}

// Establish the Gemini explicit prompt-cache entry for a question BEFORE the
// first student submits, so the first submit hits a warm cache instead of
// paying the cache-creation round-trip (typically 500ms-1.5s of TTFT). The
// systemInstruction here mirrors buildGeminiRequest's stable prefix exactly
// (standard prompt + teacher prompt + canonical solution), otherwise the
// digest wouldn't match and the on-submit path would create a second entry.
//
// Silent no-op on failure: on-submit will just fall through to inline
// systemInstruction as it did before.
export async function warmClassworkFeedbackCache({
  teacherId,
  questionId,
  standardSolution,
}) {
  try {
    if (!questionId) return { ok: false, reason: "no-question" };
    const [MODEL, teacherPrompt, standardText] = await Promise.all([
      getAiModel(),
      getTeacherPromptCached(teacherId),
      getAiStandardHintPrompt(),
    ]);
    // Order MUST match buildGeminiRequest's systemInstruction assembly —
    // any drift changes the digest and the on-submit path would create a
    // second cache entry instead of reusing this one.
    const systemInstruction = [standardText, teacherPrompt]
      .filter(Boolean)
      .join("\n\n");
    console.log(
      `[ClassworkFeedback][warm][q=${questionId}] systemInstruction len=${systemInstruction.length} ~tokens=${Math.round(systemInstruction.length / 4)} slots={std=${standardText?.length || 0},teacher=${teacherPrompt?.length || 0}}`,
    );
    const result = await getOrCreateClassworkFeedbackCache({
      model: MODEL,
      teacherId,
      questionId,
      systemInstruction,
      tag: `WarmCache:${questionId}`,
    });
    console.log(
      `[ClassworkFeedback][warm][q=${questionId}] cache=${result.ok ? (result.reused ? "hit" : "created") : `miss:${result.reason || "unknown"}`}`,
    );
    return result;
  } catch (err) {
    console.warn(
      `[ClassworkFeedback][warm][q=${questionId}] failed:`,
      err?.message || err,
    );
    return { ok: false, reason: "warm-failed" };
  }
}

