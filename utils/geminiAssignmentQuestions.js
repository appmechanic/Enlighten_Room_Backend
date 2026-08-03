import { GoogleGenAI, Type } from "@google/genai";
import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel } from "./aiModels.js";

// Generates the question batch for a Create Assignment AI call. Produces a
// mixed list covering up to all 4 classwork formats (mcq / fill-blanks /
// handwriting / textbox) using the teacher-chosen per-format counts.
//
// Prompt assembly mirrors what other Gemini callers do:
//  1. SCHEMA_GUIDANCE — describes the response shape so structured output is
//     consistent.
//  2. Standard prompt — taken from StandardPrompt.creatingAssignmentPrompt
//     if set, otherwise the hardcoded DEFAULT_STANDARD_PROMPT below
//     (the user-provided "a/b/c" instructions).
//  3. Teacher prompt — TeacherAIConfig.assignmentPrompt for the teacher,
//     appended after the standard prompt per spec.
//
// The user content is the session report snapshot: every classwork question
// from the source session, plus each student's latest hint feedback and the
// full diagnostic-training history. That's exactly the attachment
// the spec calls for.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Model ID resolved per call via getAiModel() (StandardPrompt.models.default,
// 60s in-memory cache).

const MAX_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30 * 1000;

// Default standard prompt if the admin hasn't seeded
// StandardPrompt.creatingAssignmentPrompt yet. Lifted verbatim from the spec
// so the feature works out of the box; an admin can override later by
// writing to the StandardPrompt doc.
const DEFAULT_STANDARD_PROMPT = `My students just completed my lesson and I want to give them ___ questions in _____ format, ... , ... as assignments.
The attachments are the questions used in my lesson, the contents/steps my student got stuck at, and your suggestions focusing on their weaknesses.
a) Please provide some questions very similar to the classwork questions attached.
b) Also some questions focus on their weaknesses (Please count the frequencies of the issues and consider the major weaknesses). Please give them hints for this type of questions.
c) Also give them some more advanced questions that are one level, two levels and even three levels (if some students are very smart and the number of questions allows) deeper and challenging for the abled students.
Please add a message of love, peace or a positive value to the context if possible. But it's not a must when the question doesn't fit a context.
The following is my teacher's personalized prompt. Please follow his/her advice and the above structure to generate questions if the personalized prompt is good to my learning. But please ignore it if it doesn't fit my needs.`;

async function loadStandardPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("creatingAssignmentPrompt")
      .lean();
    const fromDb = (doc?.creatingAssignmentPrompt || "").trim();
    return fromDb || DEFAULT_STANDARD_PROMPT;
  } catch (err) {
    console.error("[AssignmentQuestions] Failed to load StandardPrompt:", err);
    return DEFAULT_STANDARD_PROMPT;
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

const SCHEMA_GUIDANCE = `
You are generating a homework assignment for a real lesson the students just
finished. Respect these rules exactly:
- Honor the per-format question counts from the user message. The sum of
  emitted questions per format must equal the requested counts. Do not pad
  or shrink any format.
- For each format, use the structure the student form expects:
  * mcq: 4 options, correctAnswer must be exactly one of options.
  * fill-blanks: include the "blanks" array with the answer per blank, in
    order. correctAnswer should mirror blanks joined by " | ".
  * handwriting: descriptive open-ended question; no options, no blanks.
    correctAnswer is a short rubric of what the canvas drawing should show.
  * textbox: short-answer question. correctAnswer is the ideal 1-3 line answer.
- hints: provide up to the maxAiHints cap supplied by the user. If the cap
  is 0, return an empty hints array.
- difficulty: tag each question easy / medium / hard based on the lesson
  evidence; reserve hard for the "level 2/3 deeper" challenge questions
  in part c).
- imagePromptHint: optional 1-line phrase that would help a downstream
  image generator illustrate the question. Leave empty if visualisation
  doesn't add value (e.g. a pure vocabulary item).
- solution: REQUIRED. A step-by-step worked solution the teacher will review
  before the assignment starts and the grader may reference at hint time. Show
  the reasoning path a strong student would follow — not just the final
  answer. Number the steps ("1) …", "2) …") when there are 2+ steps. Keep
  each step to one or two short sentences. If the format is mcq, explain why
  the correct option is correct AND why each distractor is wrong. If
  fill-blanks, walk through what determines each blank in order.
- math: write every math expression as LaTeX so it renders identically on
  the teacher and student sides. Use inline delimiters \\( ... \\) (or $ ... $)
  and display delimiters \\[ ... \\] for standalone equations. This applies to
  questionText, options, correctAnswer, blanks, solution, and any
  explanation/rubric — emit literal LaTeX commands (\\frac, \\sqrt, \\int,
  \\alpha, ...) inside the JSON strings; the renderer is MathJax. Prose stays
  in the question language; only the math itself is LaTeX.
Return ONLY the JSON object that matches the schema; no prose.
`.trim();

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

  const [standardPrompt, teacherPrompt, MODEL] = await Promise.all([
    loadStandardPrompt(),
    loadTeacherAssignmentPrompt(teacherId),
    getAiModel(),
  ]);

  const systemInstruction = [
    SCHEMA_GUIDANCE,
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
      maxAttempts: MAX_ATTEMPTS,
      baseDelayMs: BASE_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
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
  SCHEMA_GUIDANCE,
  normalizeQuestion,
  loadStandardPrompt,
  loadTeacherAssignmentPrompt,
  DEFAULT_STANDARD_PROMPT,
};

// Retained as an async helper for callers that only need the model ID for
// audit metadata (e.g. assignmentController's stats.questionModel).
export async function getAssignmentQuestionModel() {
  return getAiModel();
}
