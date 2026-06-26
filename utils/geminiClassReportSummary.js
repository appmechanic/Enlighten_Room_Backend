import { GoogleGenAI, Type } from "@google/genai";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";

// Generates the lesson-level "Class Report" summary that the teacher sees by
// default on the View Report page. Distinct from getClassworkAiFeedback, which
// runs per student submission and produces individual feedback.
//
// The system instruction is built from the admin's editable
// StandardPrompt.reportPromptSections (5 sub-sections) and the per-teacher
// TeacherAIConfig.reportPrompt. The lesson's classwork questions and the
// students' submitted answers are passed in as the user content.

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

// Pulls the admin's editable 5-section Class Report prompt. Falls back to the
// joined-string mirror for legacy docs written before the sectioned schema.
async function buildStandardSection() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("reportPromptSections reportPrompt")
      .lean();
    const sections = Array.isArray(doc?.reportPromptSections)
      ? doc.reportPromptSections
          .map((s) => (typeof s === "string" ? s.trim() : ""))
          .filter(Boolean)
      : [];
    const joined = sections.length
      ? sections.join("\n\n")
      : (doc?.reportPrompt || "").trim();
    return joined ? `Standard prompt: ${joined}` : "";
  } catch (err) {
    console.error("[ClassReportSummary] Failed to load StandardPrompt:", err);
    return "";
  }
}

// Gemini structured-output schema mirroring the Mongoose classReport subdoc.
// Forces the model to return valid JSON in the exact shape we persist.
const CLASS_REPORT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    studentDifficulties: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          difficulty: { type: Type.STRING },
          affectedStudents: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ["difficulty", "affectedStudents"],
      },
    },
    nextLessonStrategy: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          difficulty: { type: Type.STRING },
          teachingStrategy: { type: Type.STRING },
        },
        required: ["difficulty", "teachingStrategy"],
      },
    },
    targetedHomework: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kindsOfTraining: { type: Type.STRING },
          link: { type: Type.STRING },
        },
        required: ["kindsOfTraining"],
      },
    },
  },
  required: ["studentDifficulties", "nextLessonStrategy", "targetedHomework"],
};

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

  // Admin's editable Class Report prompt is the single source of truth for
  // pedagogical tone, language rules, and JSON-shape guidance. The teacher's
  // per-account override is appended after so it can layer preferences on
  // top without losing the admin's structure.
  const systemInstruction = [standardSection, teacherSection]
    .filter(Boolean)
    .join("\n\n");

  const snapshot = buildLessonSnapshot({ lessonName, questions });

  const result = await generateContentWithRetry({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: snapshot }],
      },
    ],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: CLASS_REPORT_RESPONSE_SCHEMA,
    },
  });

  const text = (result?.text || "").trim();
  if (!text) {
    console.warn("[ClassReportSummary] Gemini returned empty text.");
    return null;
  }

  // responseMimeType=application/json should guarantee raw JSON, but in
  // practice the model occasionally still wraps output in ```json fences
  // or leaks a leading note. Extract the first { ... } block defensively.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error("[ClassReportSummary] No JSON object in response:", text);
      return null;
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch (err) {
      console.error("[ClassReportSummary] JSON parse failed:", err, text);
      return null;
    }
  }

  const studentDifficulties = Array.isArray(parsed?.studentDifficulties)
    ? parsed.studentDifficulties
        .map((entry) => ({
          difficulty: String(entry?.difficulty || "").trim(),
          affectedStudents: Array.isArray(entry?.affectedStudents)
            ? entry.affectedStudents.map((s) => String(s).trim()).filter(Boolean)
            : [],
        }))
        .filter((entry) => entry.difficulty)
    : [];
  const nextLessonStrategy = Array.isArray(parsed?.nextLessonStrategy)
    ? parsed.nextLessonStrategy
        .map((entry) => ({
          difficulty: String(entry?.difficulty || "").trim(),
          teachingStrategy: String(entry?.teachingStrategy || "").trim(),
        }))
        .filter((entry) => entry.difficulty || entry.teachingStrategy)
    : [];
  const targetedHomework = Array.isArray(parsed?.targetedHomework)
    ? parsed.targetedHomework
        .map((entry) => ({
          kindsOfTraining: String(entry?.kindsOfTraining || "").trim(),
          link: String(entry?.link || "").trim(),
        }))
        .filter((entry) => entry.kindsOfTraining)
    : [];

  return {
    studentDifficulties,
    nextLessonStrategy,
    targetedHomework,
    generatedAt: new Date(),
    model: MODEL,
  };
}
