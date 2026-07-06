import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import { recordAiTokenUsage } from "./aiTokenUsage.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";
// Latency knobs applied to every classwork-feedback call.
//   - thinkingConfig.thinkingBudget = -1 lets 2.5-flash decide how much
//     internal reasoning to spend per prompt (dynamic thinking).
//   - maxOutputTokens is passed per-call by the teacher (defaults to the
//     grade/language-based value stored on the session).
const FEEDBACK_THINKING_CONFIG = { thinkingBudget: -1 };
const DEFAULT_FEEDBACK_MAX_OUTPUT_TOKENS = 800;

// Renders the teacher's per-question correctAnswer for the prompt. An array of
// strings is treated as a set of acceptable answers (any one of them counts as
// correct); a single string is used verbatim. We keep this separate from
// normalizeAnswerText because the student's `answer` array means "one entry
// per blank", not "any of these is acceptable".
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

function getAnswerImageSource(answer) {
  if (!answer) return null;
  if (typeof answer === "string") {
    return /^data:image\//i.test(answer) ? answer : null;
  }
  if (typeof answer === "object" && typeof answer.imageUrl === "string" && answer.imageUrl.trim()) {
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
  return { base64: Buffer.from(buffer).toString("base64"), mimeType: "image/jpeg" };
}

async function buildTeacherSection(teacherId) {
  if (!teacherId) return "";
  try {
    const config = await TeacherAIConfig.findOne({ user: teacherId })
      .select("prompt")
      .lean();
    const prompt = (config?.prompt || "").trim();
    return prompt ? `Teacher prompt: ${prompt}` : "";
  } catch (err) {
    console.error("[ClassworkFeedback] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

// Stable hash of the standard prompt text. Used as a per-interaction cache
// key: when the report's stored hash matches this, we send a short reminder
// instead of the full prompt. Admin edits change the text and therefore the
// hash, which invalidates every report at once on its next AI call.
function hashStandardPrompt(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  return crypto.createHash("sha1").update(trimmed).digest("hex");
}

// Returns the trimmed standard-prompt body and its hash. Hash is "" when no
// prompt is configured so any non-empty stored hash on a report still counts
// as a mismatch (forces a re-send if the admin later adds a prompt).
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

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

// Short correlation id printed on every log line for a single Gemini call so
// prompt + response entries line up in the log stream when multiple students
// submit concurrently.
function newReqId() {
  return crypto.randomBytes(3).toString("hex");
}

// contents[].parts includes base64 image blobs that would otherwise flood the
// log. Replace their inlineData with a size marker so the shape stays visible
// but the payload is short.
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

// Fields the Mongo InteractionSchema in ClassworkAiReportModel.js persists.
// Used only for logging a mismatch warning — the code itself passes Gemini's
// output through untouched.
const PERSISTED_INTERACTION_KEYS = new Set([
  "hintStream",
  "part1",
  "part2",
  "part3",
  "advancedChallenge",
  "correct",
]);

// Prints the parsed response with two extra breadcrumbs:
//   - which top-level keys Gemini actually emitted
//   - which of those keys the persistence layer will silently drop (because
//     they're not in the Mongoose sub-schemas)
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
    const droppedByMongo = keys.filter(
      (k) => !PERSISTED_INTERACTION_KEYS.has(k),
    );
    if (droppedByMongo.length > 0) {
      console.warn(
        `[ClassworkFeedback][req=${reqId}] ⚠ Schema mismatch — these keys will be DROPPED on save:`,
        droppedByMongo,
        `(persisted keys: ${[...PERSISTED_INTERACTION_KEYS].join(", ")})`,
      );
    }
    const missingPersisted = [...PERSISTED_INTERACTION_KEYS].filter(
      (k) => !(k in parsed),
    );
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

// Builds the Gemini request payload (systemInstruction + contents) from the
// same inputs both the streaming and non-streaming entry points take.
//
// The admin's standard prompt now carries BOTH the JSON schema description
// and the per-field content rules, so it is sent in full on every call.
// Gemini's server-side implicit cache (cachedContentTokenCount in the
// response) handles cost amortisation when the same body is sent repeatedly.
// The function still returns `standardPromptHash` for callers that persist
// it on ClassworkAiReport, but the value no longer gates what we send.
async function buildGeminiRequest({
  reqId,
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
}) {
  console.log(`[ClassworkFeedback][req=${reqId}] === PROMPT ===`);
  console.log(
    `[ClassworkFeedback][req=${reqId}] teacherId:`,
    teacherId || "(missing)",
  );
  const [{ text: standardText, hash: standardPromptHash }, teacherPrompt] = await Promise.all([
    loadStandardPrompt(),
    buildTeacherSection(teacherId),
  ]);

  const standardSection = standardText ? `Standard prompt: ${standardText}` : "";

  console.log(
    `[ClassworkFeedback][req=${reqId}] Standard prompt (${standardText.length} chars):\n${standardText || "(none configured)"}`,
  );
  console.log(
    `[ClassworkFeedback][req=${reqId}] Teacher prompt:\n${teacherPrompt || "(none)"}`,
  );
  console.log(
    `[ClassworkFeedback][req=${reqId}] standardPromptHash:`,
    standardPromptHash,
  );

  const systemInstruction = [standardSection, teacherPrompt]
    .filter(Boolean)
    .join("\n\n");

  const normalizedAnswerText = normalizeAnswerText(answer);
  const referenceAnswer = formatCorrectAnswerForPrompt(correctAnswer);
  const referenceCount = Array.isArray(correctAnswer)
    ? correctAnswer.filter((c) => String(c ?? "").trim()).length
    : referenceAnswer ? 1 : 0;
  const answerImageSource = getAnswerImageSource(answer);

  const promptLines = [
    studentName ? `Student name: ${studentName}` : null,
    `Question: ${questionText}`,
    format ? `Answer Format: ${format}` : null,
    referenceAnswer
      ? (referenceCount > 1
          ? `Acceptable correct answers (any one counts as correct):\n${referenceAnswer}`
          : `Reference / Correct Answer: ${referenceAnswer}`)
      : null,
    `Student Answer: ${normalizedAnswerText || "[No text provided]"}`,
    questionImage ? "A question image is attached." : null,
    answerImageSource ? "A student answer image is attached. Inspect the handwriting/image carefully." : null,
  ].filter(Boolean);

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
      parts.push({ inlineData: { data: answerImageData.base64, mimeType: answerImageData.mimeType } });
    }
  }

  parts.push({ text: promptLines.join("\n") });

  console.log(
    `[ClassworkFeedback][req=${reqId}] User prompt (${promptLines.join("\n").length} chars):\n${promptLines.join("\n")}`,
  );
  console.log(
    `[ClassworkFeedback][req=${reqId}] Question image attached:`,
    Boolean(questionImage),
    "· Answer image attached:",
    Boolean(answerImageSource),
  );
  console.log(
    `[ClassworkFeedback][req=${reqId}] Final systemInstruction (${systemInstruction.length} chars):\n${systemInstruction}`,
  );
  console.log(`[ClassworkFeedback][req=${reqId}] === END PROMPT ===`);

  return {
    systemInstruction,
    contents: [{ role: "user", parts }],
    standardPromptHash,
  };
}

// Pass-through: whatever Gemini emits as JSON is what the caller gets. The
// shape (field names, enums, nested keys) is dictated entirely by the admin's
// standard prompt. Downstream code (controller + Mongo schema) defaults
// missing fields, so a malformed/empty response degrades safely.
function shapeFeedback(parsed, responseText) {
  return { ...(parsed || {}), raw: responseText };
}
 
export async function getClassworkAiFeedback({
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
  maxOutputTokens,
}) {
  const reqId = newReqId();
  const { systemInstruction, contents, standardPromptHash } = await buildGeminiRequest({
    reqId,
    questionText,
    answer,
    correctAnswer,
    questionImage,
    format,
    studentName,
    teacherId,
  });

  const resolvedMaxOutputTokens =
    Number(maxOutputTokens) > 0
      ? Number(maxOutputTokens)
      : DEFAULT_FEEDBACK_MAX_OUTPUT_TOKENS;

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    thinkingConfig: FEEDBACK_THINKING_CONFIG,
    maxOutputTokens: resolvedMaxOutputTokens,
  };

  console.log(`[ClassworkFeedback][req=${reqId}] Gemini request:`, {
    model: MODEL,
    contents: summarizeContentsForLog(contents),
    config: { ...config, systemInstruction: `<${systemInstruction.length} chars — see PROMPT block above>` },
  });

  const result = await withGeminiRetry(
    () => ai.models.generateContent({ model: MODEL, contents, config }),
    {
      maxAttempts: MAX_ATTEMPTS,
      baseDelayMs: BASE_DELAY_MS,
      tag: `ClassworkFeedback:${reqId}`,
    }
  );

  const cachedTokens = result?.usageMetadata?.cachedContentTokenCount;
  if (cachedTokens) {
    console.log(
      `[ClassworkFeedback][req=${reqId}] Implicit cache hit: ${cachedTokens} tokens reused`,
    );
  }
  console.log(
    `[ClassworkFeedback][req=${reqId}] Usage metadata:`,
    result?.usageMetadata || "(none)",
  );
  await recordAiTokenUsage(result?.usageMetadata, {
    tag: `ClassworkFeedback:${reqId}`,
  });

  const responseText = result.text || "";
  const parsed = parseFirstJsonObject(responseText, {
    tag: `ClassworkFeedback:${reqId}`,
  });
  logGeminiResponse(reqId, responseText, parsed);
  const feedback = shapeFeedback(parsed, responseText);
  feedback.standardPromptHash = standardPromptHash;
  return feedback;
}

// Scans a streaming JSON response for the "hintStream" string value and emits
// its characters as they arrive. Designed to be fed chunks of an in-flight
// JSON response — handles chunk boundaries, common backslash escapes, and
// stops when the closing quote of the hintStream value is reached.
class HintStreamScanner {
  constructor() {
    this.buffer = "";
    this.state = "searching"; // searching | inValue | done
    this.cursor = 0; // index in buffer; only matters in 'inValue'
    this.escape = false;
  }

  feed(chunk) {
    if (!chunk) return "";
    this.buffer += chunk;
    const out = [];

    if (this.state === "searching") {
      const re = /"hintStream"\s*:\s*"/;
      const match = this.buffer.match(re);
      if (!match) return "";
      this.state = "inValue";
      this.cursor = match.index + match[0].length;
    }

    if (this.state !== "inValue") return "";

    while (this.cursor < this.buffer.length) {
      const ch = this.buffer[this.cursor];
      if (this.escape) {
        if (ch === "n") out.push("\n");
        else if (ch === "r") out.push("\r");
        else if (ch === "t") out.push("\t");
        else if (ch === '"') out.push('"');
        else if (ch === "\\") out.push("\\");
        else if (ch === "/") out.push("/");
        else out.push(ch); // \uXXXX and friends: fall through, the final parsed JSON will repair this for the persisted copy
        this.escape = false;
        this.cursor += 1;
        continue;
      }
      if (ch === "\\") {
        if (this.cursor + 1 >= this.buffer.length) break; // wait for the next chunk
        this.escape = true;
        this.cursor += 1;
        continue;
      }
      if (ch === '"') {
        this.state = "done";
        break;
      }
      out.push(ch);
      this.cursor += 1;
    }

    return out.join("");
  }
}

// Streaming counterpart to getClassworkAiFeedback. Yields incremental events:
//   { type: 'hint-delta', text }          — characters of hintStream as they arrive
//   { type: 'done', feedback, cachedTokens, standardPromptHash } — once Gemini finishes
//   { type: 'error', message }            — terminal failure (after retries)
//
// Callers should iterate via `for await`. The feedback object on 'done' has
// the same shape as getClassworkAiFeedback's return value. The 'done' event
// also carries `standardPromptHash` so the caller can persist it on the
// ClassworkAiReport — that is what makes the next call short-circuit to a
// reminder instead of resending the full standard prompt.
export async function* getClassworkAiFeedbackStream(input) {
  const reqId = newReqId();
  const { systemInstruction, contents, standardPromptHash } = await buildGeminiRequest({
    reqId,
    ...input,
  });

  const resolvedMaxOutputTokens =
    Number(input?.maxOutputTokens) > 0
      ? Number(input.maxOutputTokens)
      : DEFAULT_FEEDBACK_MAX_OUTPUT_TOKENS;

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    thinkingConfig: FEEDBACK_THINKING_CONFIG,
    maxOutputTokens: resolvedMaxOutputTokens,
  };

  console.log(`[ClassworkFeedback][req=${reqId}] Gemini stream request:`, {
    model: MODEL,
    contents: summarizeContentsForLog(contents),
    config: { ...config, systemInstruction: `<${systemInstruction.length} chars — see PROMPT block above>` },
  });

  let stream;
  try {
    stream = await ai.models.generateContentStream({
      model: MODEL,
      contents,
      config,
    });
  } catch (err) {
    console.error(
      `[ClassworkFeedback][req=${reqId}] generateContentStream failed:`,
      err,
    );
    yield { type: "error", message: err?.message || "Stream init failed" };
    return;
  }

  const scanner = new HintStreamScanner();
  let fullText = "";
  let cachedTokens = 0;
  let chunkCount = 0;
  // Gemini emits usageMetadata on the final chunk. Keep the latest non-null
  // one so we can aggregate the monthly totals once the stream closes.
  let finalUsageMetadata = null;

  try {
    for await (const chunk of stream) {
      const piece = chunk?.text || "";
      if (piece) {
        chunkCount += 1;
        fullText += piece;
        const delta = scanner.feed(piece);
        if (delta) yield { type: "hint-delta", text: delta };
      }
      if (chunk?.usageMetadata) {
        finalUsageMetadata = chunk.usageMetadata;
      }
      const cached = chunk?.usageMetadata?.cachedContentTokenCount;
      if (cached) cachedTokens = cached;
    }
  } catch (err) {
    console.error(
      `[ClassworkFeedback][req=${reqId}] Stream iteration failed after ${chunkCount} chunks (${fullText.length} chars so far):`,
      err,
    );
    console.error(
      `[ClassworkFeedback][req=${reqId}] Partial raw text:\n${fullText}`,
    );
    yield { type: "error", message: err?.message || "Stream read failed" };
    return;
  }

  console.log(
    `[ClassworkFeedback][req=${reqId}] Stream finished — ${chunkCount} chunks, ${fullText.length} chars total`,
  );
  if (cachedTokens) {
    console.log(
      `[ClassworkFeedback][req=${reqId}] Implicit cache hit: ${cachedTokens} tokens reused`,
    );
  }
  await recordAiTokenUsage(finalUsageMetadata, {
    tag: `ClassworkFeedback:${reqId}`,
  });

  const parsed = parseFirstJsonObject(fullText, {
    tag: `ClassworkFeedback:${reqId}`,
  });
  logGeminiResponse(reqId, fullText, parsed);
  const feedback = shapeFeedback(parsed, fullText);
  feedback.standardPromptHash = standardPromptHash;
  yield { type: "done", feedback, cachedTokens, standardPromptHash };
}
