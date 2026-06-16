import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";
// Latency knobs applied to every classwork-feedback call.
//   - thinkingConfig.thinkingBudget = 0 disables 2.5-flash's internal
//     reasoning pass, which otherwise adds ~2–4s before the first token.
//     Hint-quality is good enough without it for short classroom Q&A.
//   - maxOutputTokens caps total response length so the model can't ramble;
//     full latency scales with output token count, so this directly
//     shortens both time-to-last-token and overall student wait.
const FEEDBACK_THINKING_CONFIG = { thinkingBudget: 0 };
const FEEDBACK_MAX_OUTPUT_TOKENS = 500;

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

  const systemInstruction = [standardSection, teacherPrompt]
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

// Default empty shape — kept in sync with the JSON structure the admin's
// standard prompt instructs Gemini to return, so the controller and frontend
// never have to branch on missing nested objects.
function emptyStudentCanDo() {
  return { subjectTrack: "STEM", message: "" };
}
function emptyNextStep() {
  return {
    dont: "",
    what: "",
    how: "",
    explanation: { gradeBand: "G4_TO_G8", text: "" },
  };
}
function emptyDiagnosticTraining() {
  return { underlyingGap: "", todaysDifficulty: "" };
}
function emptyAdvancedChallenge() {
  return {
    congratulations: "",
    question: "",
    useImage: false,
    positiveContext: { theme: "", message: "" },
  };
}

function buildEmptyFeedback(responseText) {
  return {
    correct: false,
    hintStream: "Sorry, I couldn't generate feedback this time. Please try again.",
    studentCanDo: emptyStudentCanDo(),
    nextStep: emptyNextStep(),
    diagnosticTraining: emptyDiagnosticTraining(),
    advancedChallenge: emptyAdvancedChallenge(),
    raw: responseText,
  };
}

function pickString(value) {
  return typeof value === "string" ? value : "";
}

function shapeStudentCanDo(value) {
  if (!value || typeof value !== "object") return emptyStudentCanDo();
  const subjectTrack = value.subjectTrack === "HUMANITIES_LANGUAGES"
    ? "HUMANITIES_LANGUAGES"
    : "STEM";
  return { subjectTrack, message: pickString(value.message) };
}

function shapeNextStep(value) {
  if (!value || typeof value !== "object") return emptyNextStep();
  const explanation = value.explanation && typeof value.explanation === "object"
    ? value.explanation
    : {};
  const allowedBands = new Set(["G3_OR_LOWER", "G4_TO_G8", "G9_PLUS"]);
  const gradeBand = allowedBands.has(explanation.gradeBand) ? explanation.gradeBand : "G4_TO_G8";
  return {
    dont: pickString(value.dont),
    what: pickString(value.what),
    how: pickString(value.how),
    explanation: { gradeBand, text: pickString(explanation.text) },
  };
}

function shapeDiagnosticTraining(value) {
  if (!value || typeof value !== "object") return emptyDiagnosticTraining();
  return {
    underlyingGap: pickString(value.underlyingGap),
    todaysDifficulty: pickString(value.todaysDifficulty),
  };
}

function shapeAdvancedChallenge(value) {
  if (!value || typeof value !== "object") return emptyAdvancedChallenge();
  const pc = value.positiveContext && typeof value.positiveContext === "object"
    ? value.positiveContext
    : {};
  return {
    congratulations: pickString(value.congratulations),
    question: pickString(value.question),
    useImage: Boolean(value.useImage),
    positiveContext: {
      theme: pickString(pc.theme),
      message: pickString(pc.message),
    },
  };
}

function shapeFeedback(parsed, responseText) {
  if (!parsed) return buildEmptyFeedback(responseText);
  return {
    correct: Boolean(parsed.correct),
    hintStream: pickString(parsed.hintStream),
    studentCanDo: shapeStudentCanDo(parsed.studentCanDo),
    nextStep: shapeNextStep(parsed.nextStep),
    diagnosticTraining: shapeDiagnosticTraining(parsed.diagnosticTraining),
    advancedChallenge: shapeAdvancedChallenge(parsed.advancedChallenge),
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
    lastSentStandardPromptHash,
  });

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    thinkingConfig: FEEDBACK_THINKING_CONFIG,
    maxOutputTokens: FEEDBACK_MAX_OUTPUT_TOKENS,
  };

  console.log("[ClassworkFeedback] Gemini request:", {
    model: MODEL,
    contents,
    config,
  });

  const result = await generateContentWithRetry({
    model: MODEL,
    contents,
    config,
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
  const { systemInstruction, contents, standardPromptHash } = await buildGeminiRequest({
    ...input,
  });

  const config = {
    systemInstruction,
    responseMimeType: "application/json",
    thinkingConfig: FEEDBACK_THINKING_CONFIG,
    maxOutputTokens: FEEDBACK_MAX_OUTPUT_TOKENS,
  };

  console.log("[ClassworkFeedback] Gemini stream request:", {
    model: MODEL,
    contents,
    config,
  });

  let stream;
  try {
    stream = await ai.models.generateContentStream({
      model: MODEL,
      contents,
      config,
    });
  } catch (err) {
    console.error("[ClassworkFeedback] generateContentStream failed:", err);
    yield { type: "error", message: err?.message || "Stream init failed" };
    return;
  }

  const scanner = new HintStreamScanner();
  let fullText = "";
  let cachedTokens = 0;

  try {
    for await (const chunk of stream) {
      const piece = chunk?.text || "";
      if (piece) {
        fullText += piece;
        const delta = scanner.feed(piece);
        if (delta) yield { type: "hint-delta", text: delta };
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
