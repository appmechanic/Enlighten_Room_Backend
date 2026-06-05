import { GoogleGenAI } from "@google/genai";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";

// Generates the lesson-level "Class Report" summary that the teacher sees by
// default on the View Report page. Distinct from getClassworkAiFeedback, which
// runs per student submission and produces individual feedback.
//
// Both StandardPrompt.reportPrompt (global) and TeacherAIConfig.reportPrompt
// (per-teacher) are included in the system instruction — labeled and joined —
// mirroring the per-student feedback flow. The lesson's classwork questions
// and the students' submitted answers are passed in as the user content so
// Gemini has the material to summarize.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-2.5-flash";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
// Generation is now run in the background after the end-lesson HTTP response
// has been sent, so we can ride out long Gemini demand spikes instead of
// failing fast. ~20 attempts with exponential backoff capped at 60s gives
// ~15 minutes of retry headroom — long enough to outlast typical 503/UNAVAILABLE
// windows without leaking work forever.
const MAX_ATTEMPTS = 20;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60 * 1000;

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
      const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
      const backoff = Math.min(exp, MAX_DELAY_MS);
      const jitter = Math.floor(Math.random() * 500);
      console.warn(
        `[ClassReportSummary] Gemini ${status} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${backoff + jitter}ms`
      );
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

function normalizeAnswerText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => `Blank ${index + 1}: ${String(entry ?? "")}`)
      .join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string" && value.text.trim()) return value.text.trim();
    if (typeof value.value === "string" && value.value.trim()) return value.value.trim();
    if (value.type === "image") return "[Image / handwriting answer]";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (typeof value === "string") {
    return /^data:image\//i.test(value) ? "[Image / handwriting answer]" : value;
  }
  return String(value);
}

async function buildTeacherSection(teacherId) {
  if (!teacherId) return "";
  try {
    const cfg = await TeacherAIConfig.findOne({ user: teacherId })
      .select("reportPrompt")
      .lean();
    const prompt = (cfg?.reportPrompt || "").trim();
    return prompt ? `Teacher prompt: ${prompt}` : "";
  } catch (err) {
    console.error("[ClassReportSummary] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

async function buildStandardSection() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("reportPrompt")
      .lean();
    const prompt = (doc?.reportPrompt || "").trim();
    return prompt ? `Standard prompt: ${prompt}` : "";
  } catch (err) {
    console.error("[ClassReportSummary] Failed to load StandardPrompt:", err);
    return "";
  }
}

// Fallback prompt used if neither the teacher-specific nor the global
// reportPrompt is configured. Without this the AI call would still happen
// but with an empty system instruction.
const FALLBACK_REPORT_PROMPT = `
You are summarizing one classroom lesson for the teacher. Produce a concise
class-level report (not per-student): how the class engaged with each
question, common strengths, common misconceptions, and one or two suggested
follow-up actions. Plain text, a few short paragraphs, no markdown.
`.trim();

// Compact the lesson's classwork + submissions into a textual snapshot the
// model can summarize. Per-student answers are listed under each question so
// the model can see the spread of responses.
function buildLessonSnapshot({ lessonName, questions }) {
  const lines = [];
  if (lessonName) lines.push(`Lesson: ${lessonName}`);
  lines.push(`Total questions: ${questions.length}`);
  lines.push("");

  questions.forEach((q, qi) => {
    lines.push(`Q${qi + 1}. ${q.question || "(no text)"}`);
    if (q.format) lines.push(`   Format: ${q.format}`);
    if (q.correctAnswer != null && q.correctAnswer !== "") {
      lines.push(`   Reference: ${normalizeAnswerText(q.correctAnswer)}`);
    }
    const submitted = Array.isArray(q.submitted) ? q.submitted : [];
    lines.push(`   Submissions: ${submitted.length}`);
    submitted.forEach((s, si) => {
      const who = s?.studentName || s?.studentId || `Student ${si + 1}`;
      const ans = normalizeAnswerText(s?.answer);
      lines.push(`     - ${who}: ${ans || "[no answer]"}`);
    });
    lines.push("");
  });

  return lines.join("\n");
}

export async function generateClassReportSummary({
  lessonName,
  questions,
  teacherId,
}) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }
  const totalSubmissions = questions.reduce(
    (n, q) => n + (Array.isArray(q.submitted) ? q.submitted.length : 0),
    0
  );
  if (totalSubmissions === 0) {
    // No student answers to summarize — skip generation so callers can show
    // "No class report yet" rather than a hallucinated summary.
    return null;
  }

  const [standardSection, teacherSection] = await Promise.all([
    buildStandardSection(),
    buildTeacherSection(teacherId),
  ]);

  console.log(
    "[ClassReportSummary] Using standard prompt:",
    standardSection ? "yes" : "no"
  );
  console.log(
    "[ClassReportSummary] Using teacher prompt:",
    teacherSection ? "yes" : "no"
  );

  const combined = [standardSection, teacherSection].filter(Boolean).join("\n\n");
  const systemInstruction = combined || FALLBACK_REPORT_PROMPT;

  const snapshot = buildLessonSnapshot({ lessonName, questions });

  const result = await generateContentWithRetry({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: snapshot }],
      },
    ],
    config: { systemInstruction },
  });

  const text = (result?.text || "").trim();
  if (!text) return null;

  return {
    summary: text,
    generatedAt: new Date(),
    model: MODEL,
  };
}
