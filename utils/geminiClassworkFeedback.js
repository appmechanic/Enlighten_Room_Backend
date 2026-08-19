
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
import { getAiModel, getAiRetry, getAiDirective } from "./aiConfig.js";
import { getOrCreateClassworkFeedbackCache } from "./classworkGeminiCache.js";
import {
  AI_HINT_PROMPT_SECTION_DEFAULTS,
  DIRECTIVE_DEFAULTS,
} from "../config/standardPromptDefaults.js";

// Classwork feedback runs on a fully hard-coded standard prompt + response
// schema. The DB-backed StandardPrompt / directives are still edited via the
// admin UI, but this call intentionally bypasses them so behaviour is
// reproducible from the source tree alone. Text is imported from
// standardPromptDefaults.js so there's a single canonical source; flip the
// imports below to inline literals if the config module ever needs to diverge.
const HARDCODED_STANDARD_PROMPT_TEXT = AI_HINT_PROMPT_SECTION_DEFAULTS
  .filter((s) => typeof s === "string" && s.length > 0)
  .join("\n\n");
const HARDCODED_STANDARD_PROMPT_HASH = crypto
  .createHash("sha1")
  .update(HARDCODED_STANDARD_PROMPT_TEXT)
  .digest("hex");
const HARDCODED_SOLUTION_COMPUTE = DIRECTIVE_DEFAULTS["classwork.solutionCompute"];
const HARDCODED_SOLUTION_SKIP = DIRECTIVE_DEFAULTS["classwork.solutionSkip"];
const HARDCODED_MISTAKE_COMPUTE = DIRECTIVE_DEFAULTS["classwork.mistakeCompute"];
const HARDCODED_MISTAKE_SKIP = DIRECTIVE_DEFAULTS["classwork.mistakeSkip"];
const HARDCODED_HINT_STREAM = DIRECTIVE_DEFAULTS["classwork.hintStream"];
const HARDCODED_MATH_EQUIVALENCE = DIRECTIVE_DEFAULTS["classwork.mathEquivalence"];
const HARDCODED_ASK_MODE = DIRECTIVE_DEFAULTS["classwork.askMode"];
const HARDCODED_TELL_MODE = DIRECTIVE_DEFAULTS["classwork.tellMode"];

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

// Every prompt directive attached below is resolved per call via
// getAiDirective(key). The canonical text lives in
// config/standardPromptDefaults.js and is seeded into StandardPrompt on
// first read; admin edits in the AdminAiPrompts UI override the seed value.
// See utils/aiConfig.js for the DB-read + 60s cache.

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
  // Standard prompt + all classwork directives are hard-coded (see top of
  // file). Only the per-teacher prompt is still DB-backed.
  const standardText = HARDCODED_STANDARD_PROMPT_TEXT;
  const standardPromptHash = HARDCODED_STANDARD_PROMPT_HASH;
  const STANDARD_SOLUTION_COMPUTE_INSTRUCTION = HARDCODED_SOLUTION_COMPUTE;
  const STANDARD_SOLUTION_SKIP_INSTRUCTION = HARDCODED_SOLUTION_SKIP;
  const COMMON_MISTAKE_COMPUTE_INSTRUCTION = HARDCODED_MISTAKE_COMPUTE;
  const COMMON_MISTAKE_SKIP_INSTRUCTION = HARDCODED_MISTAKE_SKIP;
  const HINT_STREAM_INSTRUCTION = HARDCODED_HINT_STREAM;
  const MATH_EQUIVALENCE_INSTRUCTION = HARDCODED_MATH_EQUIVALENCE;
  const ASK_MODE_INSTRUCTION = HARDCODED_ASK_MODE;
  const TELL_MODE_INSTRUCTION = HARDCODED_TELL_MODE;
  const teacherPrompt = await getTeacherPromptCached(teacherId);

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

  // Attach the raw question image whenever one exists. We deliberately do NOT
  // OCR-transcribe it up front — the transcription lost fidelity on math
  // notation (e.g. "d/dx(cos 5x)" flattened to "d cos5x/dx"), which broke the
  // correct/incorrect judgement. Sending the image lets Gemini read the real
  // notation on every submission. Latency > tokens here.
  const effectiveQuestionText = questionText || "";
  const includeRawQuestionImage = Boolean(questionImage);

  // Ask/Tell pedagogy directive, derived from the runtime attempt number.
  // Odd -> ASK (coach recall), even -> TELL (explain). Skipped entirely when
  // no valid number was supplied so older callers behave as before.
  //
  // Wrapped in an explicit STEP 1 / 2 / 3 gate so the correctness judgment
  // happens BEFORE the pedagogy directive frames the response as a hint.
  // Previously the "if correct, ignore" caveat was a single line stapled at
  // the END of the block; the model would read the ASK/TELL directive
  // first, commit to a hint framing, then rationalise correct=false to
  // justify the hint it was already writing. Putting the correctness gate
  // at the top forces evaluation before framing.
  //
  // The displayed attempt number is capped: very high counts (a student
  // stuck in a loop, often because the AI kept mis-judging correctness)
  // telegraphed "this student can't get it" and biased the correctness
  // judgment toward false. Parity for ASK/TELL still comes from the raw
  // number so the mode still alternates.
  const rawAttemptNo = Number(submissionNumber);
  const isValidAttempt = Number.isInteger(rawAttemptNo) && rawAttemptNo > 0;
  const displayedAttempt = isValidAttempt ? Math.min(rawAttemptNo, 5) : rawAttemptNo;
  const askTellInstruction = isValidAttempt
    ? [
        "STEP 1 — JUDGE CORRECTNESS FIRST: Compare the student answer to the reference using the MATHEMATICAL EQUIVALENCE rules below. Judge by mathematical value, not string form.",
        "STEP 2 — IF EQUIVALENT: Set correct=true, write a warm congratulation in hintStream, and fill advancedChallenge. SKIP the pedagogy mode entirely — do NOT generate 🛑/✅/🔨 hints.",
        "STEP 3 — IF NOT EQUIVALENT: Apply the pedagogy mode below.",
        `Submission attempt #${displayedAttempt} for this student on this question.`,
        rawAttemptNo % 2 === 1 ? ASK_MODE_INSTRUCTION : TELL_MODE_INSTRUCTION,
      ].join("\n")
    : null;

  // Deterministic server-side equivalence pre-check. When it fires we KNOW
  // the student is correct (the normalizer is narrow enough that a match
  // is authoritative). Injected at the TOP of the user prompt as an
  // override so the model can't rationalise it away — everything else in
  // the prompt is subordinate.
  const serverSideMatch = serverSideEquivalenceMatches(answer, correctAnswer, format);
  const serverEquivalenceOverride = serverSideMatch
    ? [
        "SERVER-SIDE EQUIVALENCE PRE-CHECK: PASSED.",
        "The student's answer has been normalized by the backend (whitespace stripped, LaTeX backslashes on function names removed, implicit-vs-explicit function-argument parentheses collapsed) and is IDENTICAL to the reference answer.",
        "This match is AUTHORITATIVE. You MUST set correct=true. Do NOT generate 🛑/✅/🔨 hints. Write a warm hintStream congratulating the student by first name, put a brief acknowledgment in part1, leave part2 as an empty array, and fill advancedChallenge with a harder question in the language of the original question.",
        "Ignore any pedagogy mode directive below.",
      ].join("\n")
    : null;

  const promptLines = [
    serverEquivalenceOverride,
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

  // Fallback callable used both by the retry wrapper's regular-fallback slot
  // AND locally on a `cachedContent`-specific error (deleted/expired cache
  // in the window between our TTL bookkeeping and Gemini's own expiry).
  const inlineConfig = {
    systemInstruction,
    responseMimeType: "application/json",
    responseSchema: pickClassworkResponseSchema(Boolean(computeStandardSolution)),
    thinkingConfig: { thinkingBudget },
    maxOutputTokens: resolvedMaxOutputTokens,
  };

  const apiStartMs = Date.now();
  console.log(
    `[ClassworkFeedback][req=${reqId}] AI hint API start: ${new Date(apiStartMs).toISOString()}`,
  );
  const result = await withGeminiRetry(
    () => ai.models.generateContent({ model: MODEL, contents, config }),
    {
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag: `ClassworkFeedback:${reqId}`,
      fallbackCallFn: FALLBACK_MODEL && FALLBACK_MODEL !== MODEL
        ? () =>
            ai.models.generateContent({
              model: FALLBACK_MODEL,
              contents,
              config: inlineConfig,
            })
        : undefined,
    },
  );
  const apiEndMs = Date.now();
  console.log(
    `[ClassworkFeedback][req=${reqId}] AI hint API end: ${new Date(apiEndMs).toISOString()} (duration ${apiEndMs - apiStartMs}ms)`,
  );

  logAiUsage(
    reqId,
    result?.usageMetadata,
    "ClassworkFeedback",
    result?.candidates?.[0]?.finishReason,
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
  onVerdict,
}) {
  const reqId = newReqId();
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

  const scanner = createHintStreamScanner({
    onDelta: typeof onHintDelta === "function" ? onHintDelta : () => {},
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

// Fast-hint call: plain-text, no responseSchema, no thinkingConfig, tight
// output cap. Runs in parallel with the full structured call so the student
// sees a 1-2 sentence live hint in ~1-2s instead of waiting the full 4-9s
// for the structured JSON to complete. Uses the fallback (smaller) model
// so it's both faster and cheaper than the primary reasoning model.
// The authoritative structured hintStream still overwrites this on the
// server side before persistence — this exists purely to hide latency.
export async function getClassworkAiFastHint({
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
  onHintDelta,
}) {
  const reqId = newReqId();
  // Fast-hint uses a DEDICATED compact system prompt (`classwork.fastHintSystem`)
  // instead of the full aiHintPrompt. The full prompt carries thousands of tokens
  // of JSON/LaTeX/schema guidance that fast-hint doesn't need (plain-text output),
  // and every one of those tokens rides prefill on every call. Swapping to the
  // ~120-token distillation cuts Gemini's time-to-first-character noticeably.
  // Teacher prompt is still layered in for per-teacher voice — it's typically
  // short, and the explicit prompt cache below still scopes per (teacher, model)
  // so voice differences don't fragment the cache further than they already did.
  const [MODEL, FALLBACK_MODEL, fastHintSystemText, teacherPrompt] = await Promise.all([
    getAiModel(),
    getAiModel("fallback"),
    getAiDirective("classwork.fastHintSystem"),
    getTeacherPromptCached(teacherId),
  ]);
  // Prefer fallback (flash-lite) — it's a 1-sentence hint, no reasoning needed.
  const fastModel = FALLBACK_MODEL || MODEL;

  const systemInstruction = [fastHintSystemText, teacherPrompt].filter(Boolean).join("\n\n");

  // For fast-hint, only pay for image OCR when the format genuinely needs
  // it (handwriting / image-based answers). Text/MCQ/fill-blanks questions
  // with a decorative image get zero benefit from shipping ~200KB base64
  // to Gemini for a one-sentence nudge — and pay for it in prefill time.
  const answerImageSource = getAnswerImageSource(answer);
  const needsImageOcr = format === "handwriting" || Boolean(answerImageSource);
  const includeRawQuestionImage = needsImageOcr && Boolean(questionImage);
  const [questionImageData, answerImageData] = await Promise.all([
    includeRawQuestionImage ? sourceToInlineData(questionImage).catch(() => null) : null,
    answerImageSource ? sourceToInlineData(answerImageSource).catch(() => null) : null,
  ]);

  // OUTPUT rules live in the system prompt (`classwork.fastHintSystem`)
  // now — don't duplicate them here on every submission.
  const promptText = [
    studentName ? `Student name: ${studentName}` : null,
    `Question: ${questionText || ""}`,
    format ? `Answer Format: ${format}` : null,
    correctAnswer
      ? `Reference / Correct Answer: ${formatCorrectAnswerForPrompt(correctAnswer)}`
      : null,
    `Student Answer: ${normalizeAnswerText(answer) || "[No text provided]"}`,
    includeRawQuestionImage ? "A question image is attached." : null,
    answerImageSource ? "A student answer image is attached." : null,
  ]
    .filter(Boolean)
    .join("\n");

  const parts = [];
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
  parts.push({ text: promptText });

  // Explicit prompt cache: systemInstruction here is standard + teacher
  // prompt only (no question/solution), so the natural scope is per
  // (teacher, model) and a single cache entry serves every submission from
  // every student in every class that teacher runs. Use a sentinel
  // questionId so the shared cache module keeps fast-hint entries in their
  // own namespace and question-level invalidation can't sweep them.
  const cacheResult = await getOrCreateClassworkFeedbackCache({
    model: fastModel,
    teacherId,
    questionId: "__fast_hint__",
    systemInstruction,
    tag: `FastHint:${reqId}`,
  });

  // 120 tokens ≈ 90 words, plenty for a 1-2 sentence nudge. Was 180 —
  // the extra 60-token headroom just let the model wander longer before
  // hitting its own stop rather than adding useful content.
  const config = cacheResult.ok
    ? {
        cachedContent: cacheResult.name,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 120,
      }
    : {
        systemInstruction,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 120,
      };

  const apiStartMs = Date.now();
  console.log(
    `[FastHint][req=${reqId}] AI fast hint API start (model=${fastModel}, cache=${cacheResult.ok ? (cacheResult.reused ? "hit" : "created") : `miss:${cacheResult.reason || "unknown"}`}): ${new Date(apiStartMs).toISOString()}`,
  );

  let hintText = "";
  try {
    const stream = await ai.models.generateContentStream({
      model: fastModel,
      contents: [{ role: "user", parts }],
      config,
    });
    for await (const chunk of stream) {
      const piece = chunk?.text ?? "";
      if (piece) {
        hintText += piece;
        if (typeof onHintDelta === "function") {
          try {
            onHintDelta(piece);
          } catch (err) {
            console.error(`[FastHint][req=${reqId}] onHintDelta threw:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[FastHint][req=${reqId}] stream failed:`, err?.message || err);
    throw err;
  }

  const apiEndMs = Date.now();
  console.log(
    `[FastHint][req=${reqId}] AI fast hint API end: ${new Date(apiEndMs).toISOString()} (duration ${apiEndMs - apiStartMs}ms, chars=${hintText.length})`,
  );

  return hintText.trim();
}
