import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";

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

const JSON_RESPONSE_RULES = `
You MUST respond with a single JSON object only (no prose, no markdown fences). Schema:
{
  "correct": boolean,           // true only if every content/step and answer is complete and correct
  "part1": string,              // (incorrect case) which step is correct just before the student got stuck; "" if correct
  "part2": string,              // (incorrect case) guidance for the first stuck step; (correct case) a brief confirmation that the student's answer is correct
  "part3": string,              // (incorrect case) practice recommendations for after class; "" if correct
  "newQuestion": string         // (correct case) the more advanced similar question with a positive message; "" if incorrect
}
Use the student's name when given. Keep each field child-friendly and concise.
`.trim();

// For the streaming variant: structured schema with propertyOrdering so part2
// (the field the student sees first) is emitted first by the model. That lets
// us tail the JSON stream and surface part2 characters as they arrive.
const FEEDBACK_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    part2: { type: Type.STRING },
    part1: { type: Type.STRING },
    part3: { type: Type.STRING },
    correct: { type: Type.BOOLEAN },
    newQuestion: { type: Type.STRING },
  },
  required: ["part2", "part1", "part3", "correct", "newQuestion"],
  propertyOrdering: ["part2", "part1", "part3", "correct", "newQuestion"],
};

const STREAM_RESPONSE_RULES = `
You MUST respond with a single JSON object matching the provided schema. The
"part2" field MUST come first in the JSON output so the student sees the most
important guidance immediately.
- "correct": true only if every content/step and answer is complete and correct.
- "part1": (incorrect case) which step is correct just before the student got stuck; "" if correct.
- "part2": (incorrect case) guidance for the first stuck step; (correct case) a brief confirmation that the student's answer is correct.
- "part3": (incorrect case) practice recommendations for after class; "" if correct.
- "newQuestion": (correct case) the more advanced similar question with a positive message; "" if incorrect.
Use the student's name when given. Keep each field child-friendly and concise.
`.trim();

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

// Short reminder sent on every call AFTER the first one for a given
// (room, question, student) interaction. Keeps token usage low while
// re-anchoring the model on the standard prompt it already saw and on the
// JSON schema the caller expects back.
const STANDARD_PROMPT_REMINDER =
  "Standard prompt: continue to follow the standard guidance you received "
  + "earlier for this student and return feedback in the same JSON schema.";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateContentWithRetry(request) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.error?.code;
      if (!RETRYABLE_STATUSES.has(status) || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
      console.warn(
        `[ClassworkFeedback] Gemini ${status} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${backoff + jitter}ms`
      );
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

function parseJsonResponse(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("[ClassworkFeedback] JSON parse failed:", err, text);
    return null;
  }
}

// Builds the Gemini request payload (systemInstruction + contents) from the
// same inputs both the streaming and non-streaming entry points take.
//
// Standard-prompt delivery strategy:
//   - First AI call for a (room, question, student) interaction sends the
//     FULL standard prompt body (caller passes lastSentStandardPromptHash="" ).
//   - Subsequent calls for the same interaction send a SHORT reminder that
//     re-anchors the model on the previously-seen standard guidance and the
//     JSON schema, saving tokens.
//   - The teacher's personal prompt is attached EVERY time (teachers tune it
//     freely; we never assume Gemini has it cached).
//   - When the admin edits StandardPrompt, its content changes and so does
//     its hash; the next call for every interaction will detect the mismatch
//     and re-send the full body, then store the new hash on the report.
//
// The function returns `standardPromptHash` so the caller can persist it on
// the ClassworkAiReport after the call succeeds.
async function buildGeminiRequest({
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
  rulesSection,
  lastSentStandardPromptHash,
}) {
  console.log("[ClassworkFeedback] teacherId:", teacherId || "(missing)");
  const [{ text: standardText, hash: standardPromptHash }, teacherPrompt] = await Promise.all([
    loadStandardPrompt(),
    buildTeacherSection(teacherId),
  ]);

  const reuseStandard =
    Boolean(standardPromptHash) && lastSentStandardPromptHash === standardPromptHash;

  const standardSection = standardText
    ? (reuseStandard ? STANDARD_PROMPT_REMINDER : `Standard prompt: ${standardText}`)
    : "";

  console.log("[ClassworkFeedback] Standard prompt:", standardText
    ? (reuseStandard ? "reminder (cached)" : "full body (first send or version changed)")
    : "none configured"
  );
  console.log(
    "[ClassworkFeedback] Using teacher prompt:",
    teacherPrompt ? "yes" : "no"
  );

  const systemInstruction = [standardSection, teacherPrompt, rulesSection]
    .filter(Boolean)
    .join("\n\n");

  const normalizedAnswerText = normalizeAnswerText(answer);
  const referenceAnswer = normalizeAnswerText(correctAnswer);
  const answerImageSource = getAnswerImageSource(answer);

  const promptLines = [
    studentName ? `Student name: ${studentName}` : null,
    `Question: ${questionText}`,
    format ? `Answer Format: ${format}` : null,
    referenceAnswer ? `Reference / Correct Answer: ${referenceAnswer}` : null,
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

  return {
    systemInstruction,
    contents: [{ role: "user", parts }],
    standardPromptHash,
  };
}

function buildEmptyFeedback(responseText) {
  return {
    correct: false,
    part1: "",
    part2: "Sorry, I couldn't generate feedback this time. Please try again.",
    part3: "",
    newQuestion: "",
    raw: responseText,
  };
}

function shapeFeedback(parsed, responseText) {
  if (!parsed) return buildEmptyFeedback(responseText);
  return {
    correct: Boolean(parsed.correct),
    part1: typeof parsed.part1 === "string" ? parsed.part1 : "",
    part2: typeof parsed.part2 === "string" ? parsed.part2 : "",
    part3: typeof parsed.part3 === "string" ? parsed.part3 : "",
    newQuestion: typeof parsed.newQuestion === "string" ? parsed.newQuestion : "",
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
  teacherId,
  lastSentStandardPromptHash,
}) {
  const { systemInstruction, contents, standardPromptHash } = await buildGeminiRequest({
    questionText,
    answer,
    correctAnswer,
    questionImage,
    format,
    studentName,
    teacherId,
    rulesSection: JSON_RESPONSE_RULES,
    lastSentStandardPromptHash,
  });

  console.log("[ClassworkFeedback] Gemini request:", {
    model: MODEL,
    contents,
    config: { systemInstruction, responseMimeType: "application/json" },
  });

  const result = await generateContentWithRetry({
    model: MODEL,
    contents,
    config: { systemInstruction, responseMimeType: "application/json" },
  });

  const cachedTokens = result?.usageMetadata?.cachedContentTokenCount;
  if (cachedTokens) {
    console.log(`[ClassworkFeedback] Implicit cache hit: ${cachedTokens} tokens reused`);
  }

  const responseText = result.text || "";
  const feedback = shapeFeedback(parseJsonResponse(responseText), responseText);
  feedback.standardPromptHash = standardPromptHash;
  return feedback;
}

// Scans a streaming JSON response for the "part2" string value and emits its
// characters as they arrive. Designed to be fed chunks of an in-flight JSON
// response — handles chunk boundaries, common backslash escapes, and stops
// when the closing quote of the part2 value is reached.
class Part2StreamScanner {
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
      const re = /"part2"\s*:\s*"/;
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
//   { type: 'part2-delta', text }         — characters of part2 as they arrive
//   { type: 'done', feedback, cachedTokens, standardPromptHash } — once Gemini finishes
//   { type: 'error', message }            — terminal failure (after retries)
//
// Callers should iterate via `for await`. The feedback object on 'done' has
// the same shape as getClassworkAiFeedback's return value. The 'done' event
// also carries `standardPromptHash` so the caller can persist it on the
// ClassworkAiReport — that is what makes the next call short-circuit to a
// reminder instead of resending the full standard prompt.
export async function* getClassworkAiFeedbackStream(input) {
  const { systemInstruction, contents, standardPromptHash } = await buildGeminiRequest({
    ...input,
    rulesSection: STREAM_RESPONSE_RULES,
  });

  console.log("[ClassworkFeedback] Gemini stream request:", {
    model: MODEL,
    contents,
    config: { systemInstruction, responseMimeType: "application/json" },
  });

  let stream;
  try {
    stream = await ai.models.generateContentStream({
      model: MODEL,
      contents,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: FEEDBACK_RESPONSE_SCHEMA,
      },
    });
  } catch (err) {
    console.error("[ClassworkFeedback] generateContentStream failed:", err);
    yield { type: "error", message: err?.message || "Stream init failed" };
    return;
  }

  const scanner = new Part2StreamScanner();
  let fullText = "";
  let cachedTokens = 0;

  try {
    for await (const chunk of stream) {
      const piece = chunk?.text || "";
      if (piece) {
        fullText += piece;
        const delta = scanner.feed(piece);
        if (delta) yield { type: "part2-delta", text: delta };
      }
      const cached = chunk?.usageMetadata?.cachedContentTokenCount;
      if (cached) cachedTokens = cached;
    }
  } catch (err) {
    console.error("[ClassworkFeedback] Stream iteration failed:", err);
    yield { type: "error", message: err?.message || "Stream read failed" };
    return;
  }

  if (cachedTokens) {
    console.log(`[ClassworkFeedback] Implicit cache hit: ${cachedTokens} tokens reused`);
  }

  const feedback = shapeFeedback(parseJsonResponse(fullText), fullText);
  feedback.standardPromptHash = standardPromptHash;
  yield { type: "done", feedback, cachedTokens, standardPromptHash };
}
