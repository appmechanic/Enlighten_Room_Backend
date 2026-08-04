import { GoogleGenAI, Type } from "@google/genai";
import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry, getAiDirective } from "./aiConfig.js";

// Generates the question batch for a Create Assignment AI call. Produces a
// mixed list covering up to all 4 classwork formats (mcq / fill-blanks /
// handwriting / textbox) using the teacher-chosen per-format counts.
//
// Prompt assembly mirrors what other Gemini callers do:
//  1. SCHEMA_GUIDANCE — describes the response shape so structured output is
//     consistent.
//  2. Standard prompt — StandardPrompt.creatingAssignmentPrompt, seeded on
//     first read from config/standardPromptDefaults.js.
//  3. Teacher prompt — TeacherAIConfig.assignmentPrompt for the teacher,
//     appended after the standard prompt per spec.
//
// The user content is the session report snapshot: every classwork question
// from the source session, plus each student's latest hint feedback and the
// full diagnostic-training history. That's exactly the attachment
// the spec calls for.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Model ID and retry policy resolved per call via getAiModel() / getAiRetry
// (StandardPrompt.models / StandardPrompt.retry, 60s in-memory cache).

// The creatingAssignmentPrompt field is guaranteed populated by the seed
// helper in config/standardPromptDefaults.js (runs on first admin GET and
// on aiConfig cache-miss). If the DB read fails or the field is somehow
// empty, we return "" and let the caller compose without it — the seed
// path will fill it in on the next request.
async function loadStandardPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("creatingAssignmentPrompt")
      .lean();
    return (doc?.creatingAssignmentPrompt || "").trim();
  } catch (err) {
    console.error("[AssignmentQuestions] Failed to load StandardPrompt:", err);
    return "";
  }
}

async function loadTeacherAssignmentPrompt(teacherId) {
  if (!teacherId) return "";
  try {
    const cfg = await TeacherAIConfig.findOne({ user: teacherId })
      .select("assignmentPrompt")
      .lean();
    return (cfg?.assignmentPrompt || "").trim();
  } catch (err) {
    console.error("[AssignmentQuestions] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

// Structured-output schema: a flat array of questions. type is constrained to
// the 4 classwork formats; the model fills in the right ancillary fields
// (options/blanks/correctAnswer/hints) based on which format it picked.
const QUESTION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          format: {
            type: Type.STRING,
            enum: ["mcq", "fill-blanks", "handwriting", "textbox"],
          },
          questionText: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          blanks: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctAnswer: { type: Type.ARRAY, items: { type: Type.STRING } },
          hints: { type: Type.ARRAY, items: { type: Type.STRING } },
          imagePromptHint: { type: Type.STRING },
          difficulty: {
            type: Type.STRING,
            enum: ["easy", "medium", "hard"],
          },
          // Step-by-step worked solution, in the student's language, with math
          // in LaTeX. Persisted on the Question doc so the teacher can review
          // and edit it before the assignment start date.
          solution: { type: Type.STRING },
        },
        required: ["format", "questionText", "correctAnswer", "solution"],
      },
    },
  },
  required: ["questions"],
};

// SCHEMA_GUIDANCE text lives in config/standardPromptDefaults.js under
// directives["assignment.schemaGuidance"] — resolved per call via
// getSchemaGuidance() so admins can tune it in the DB without a code edit.
async function getSchemaGuidance() {
  return getAiDirective("assignment.schemaGuidance");
}

function buildSessionReportSnapshot({ lessonName, questions }) {
  const lines = [];
  if (lessonName) lines.push(`Source lesson: ${lessonName}`);
  lines.push(`Total classwork questions: ${questions.length}`);
  lines.push("");

  questions.forEach((q, qi) => {
    lines.push(`Q${qi + 1}. ${q.question || "(no text)"}`);
    if (q.format) lines.push(`   Format: ${q.format}`);
    if (q.correctAnswer != null && q.correctAnswer !== "") {
      lines.push(`   Reference answer: ${stringifyAnswer(q.correctAnswer)}`);
    }
    const submitted = Array.isArray(q.submitted) ? q.submitted : [];
    lines.push(`   Submissions: ${submitted.length}`);
    submitted.forEach((s, si) => {
      const who = s?.studentName || s?.studentId || `Student ${si + 1}`;
      if (s?.feedback) {
        lines.push(`     - ${who} | latest hint feedback: ${s.feedback}`);
      }
    });
    // Per-question diagnostic-training history is the strongest signal of
    // where the cohort got stuck — that's the spec's "weaknesses".
    const training = Array.isArray(q.trainingHistory) ? q.trainingHistory : [];
    if (training.length) {
      lines.push(`   Diagnostic-training history for this Q:`);
      training.forEach((entry, i) => {
        const who = entry?.studentName || entry?.studentId || `Student ${i + 1}`;
        const items = Array.isArray(entry?.part3) ? entry.part3 : [];
        items
          .map((s) => String(s ?? "").trim())
          .filter(Boolean)
          .forEach((text) => lines.push(`     - ${who}: ${text}`));
      });
    }
    lines.push("");
  });
  return lines.join("\n");
}

function stringifyAnswer(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((x) => String(x ?? "")).join(" | ");
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatCountsBlock(perFormatCounts) {
  return Object.entries(perFormatCounts)
    .filter(([, n]) => Number(n) > 0)
    .map(([fmt, n]) => `- ${fmt}: ${n}`)
    .join("\n");
}

// Public entry point. Returns { questions, generation } where generation
// captures the prompts and model used so the caller can persist a snapshot
// on the Assignment doc.
export async function generateAssignmentQuestions({
  sessionReport, // { lessonName, questions: [{ question, format, correctAnswer, submitted: [{studentName, feedback}], trainingHistory: [{studentName, part3: [string, ...]}] }] }
  perFormatCounts, // { mcq, "fill-blanks", handwriting, textbox } -> int
  maxAiHints,
  course,
  topic,
  classroomPrompt,
  teacherId,
}) {
  const totalRequested = Object.values(perFormatCounts || {}).reduce(
    (n, v) => n + (Number(v) || 0),
    0,
  );
  if (!totalRequested) {
    throw new Error("perFormatCounts must request at least one question.");
  }

  const [standardPrompt, teacherPrompt, MODEL, retryCfg, schemaGuidance] = await Promise.all([
    loadStandardPrompt(),
    loadTeacherAssignmentPrompt(teacherId),
    getAiModel(),
    getAiRetry("assignmentQuestions"),
    getSchemaGuidance(),
  ]);

  const systemInstruction = [
    schemaGuidance,
    standardPrompt,
    teacherPrompt,
    classroomPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  const userMessage = [
    `Course: ${course || ""}`,
    `Topic: ${topic || sessionReport?.lessonName || ""}`,
    `maxAiHints (cap for hints[] per question): ${maxAiHints}`,
    "",
    "Per-format counts requested:",
    formatCountsBlock(perFormatCounts) || "- (none)",
    "",
    "Session report (classwork questions + last Part 2 feedback + full Part 3 history):",
    buildSessionReportSnapshot(sessionReport || { questions: [] }),
  ].join("\n");

  const result = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: QUESTION_RESPONSE_SCHEMA,
        },
      }),
    {
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag: "AssignmentQuestions",
    },
  );

  logAiUsage(null, result?.usageMetadata, "AssignmentQuestions");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag: "AssignmentQuestions",
  });

  const raw = (result?.text || "").trim();

  await recordAiCallLog({
    tag: "AssignmentQuestions",
    model: MODEL,
    teacherId,
    questionText: `Generate assignment: course=${course || ""} topic=${topic || ""} totalRequested=${totalRequested}`,
    studentAnswer: userMessage,
    aiResponseSummary: raw,
    userPromptText: userMessage,
    standardPromptSnippet: standardPrompt,
    teacherPromptSnippet: teacherPrompt,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag: "AssignmentQuestions" });
  if (!parsed) throw new Error("AI returned an invalid response.");

  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const cleaned = list
    .map((q) => normalizeQuestion(q, { maxAiHints }))
    .filter(Boolean);

  return {
    questions: cleaned,
    generation: {
      standardPrompt,
      teacherPrompt,
      sessionLessonName: sessionReport?.lessonName || "",
      model: MODEL,
      generatedAt: new Date(),
    },
  };
}

function normalizeQuestion(q, { maxAiHints }) {
  const format = q?.format;
  if (!format) return null;
  const text = String(q?.questionText || "").trim();
  if (!text) return null;
  const hintsCap = Math.max(0, Math.min(Number(maxAiHints) || 0, 10));
  const hints = Array.isArray(q?.hints)
    ? q.hints
        .map((h) => String(h).trim())
        .filter(Boolean)
        .slice(0, hintsCap)
    : [];
  const options = Array.isArray(q?.options)
    ? q.options.map((o) => String(o).trim()).filter(Boolean)
    : [];
  const blanks = Array.isArray(q?.blanks)
    ? q.blanks.map((b) => String(b).trim())
    : [];
  const correctAnswer = Array.isArray(q?.correctAnswer)
    ? q.correctAnswer.map((c) => String(c).trim()).filter(Boolean)
    : [];
  return {
    format,
    questionText: text,
    options,
    blanks,
    correctAnswer,
    hints,
    imagePromptHint: String(q?.imagePromptHint || "").trim(),
    difficulty: ["easy", "medium", "hard"].includes(q?.difficulty)
      ? q.difficulty
      : "medium",
    solution: String(q?.solution || "").trim(),
  };
}

// Re-exported so the individual-assignment generator can share the same
// schema + guidance + normalisation without duplicating them.
export {
  QUESTION_RESPONSE_SCHEMA,
  getSchemaGuidance,
  normalizeQuestion,
  loadStandardPrompt,
  loadTeacherAssignmentPrompt,
};

// Retained as an async helper for callers that only need the model ID for
// audit metadata (e.g. assignmentController's stats.questionModel).
export async function getAssignmentQuestionModel() {
  return getAiModel();
}
