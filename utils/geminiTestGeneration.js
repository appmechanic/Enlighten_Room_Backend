import { GoogleGenAI } from "@google/genai";
import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry } from "./aiConfig.js";
import {
  QUESTION_RESPONSE_SCHEMA,
  getSchemaGuidance,
  normalizeQuestion,
} from "./geminiAssignmentQuestions.js";

// Generates the question batch for a Create Test AI call. Structurally
// identical to generateAssignmentQuestions — same 4 classwork formats,
// same response schema, same normalisation — but the *prompts* and the
// *evidence bundle* differ:
//
//  - Standard prompt: creatingTestPrompt (post-lesson assessment framing).
//  - Teacher prompt : TeacherAIConfig.generatingTestPrompt.
//  - Evidence bundle: aggregated across every session in the picked
//    date range, plus every assignment in the same window — that's what
//    the spec calls "Session reports and Assignment reports within the
//    range of days".
//
// The hints[] the AI produces per question are used by the teacher and
// class-report path only; the video-app test page never shows them to a
// student during the sitting.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function loadStandardPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("creatingTestPrompt")
      .lean();
    return (doc?.creatingTestPrompt || "").trim();
  } catch (err) {
    console.error("[TestGeneration] Failed to load StandardPrompt:", err);
    return "";
  }
}

async function loadTeacherTestPrompt(teacherId) {
  if (!teacherId) return "";
  try {
    const cfg = await TeacherAIConfig.findOne({ user: teacherId })
      .select("generatingTestPrompt")
      .lean();
    return (cfg?.generatingTestPrompt || "").trim();
  } catch (err) {
    console.error("[TestGeneration] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

function formatCountsBlock(perFormatCounts) {
  return Object.entries(perFormatCounts)
    .filter(([, n]) => Number(n) > 0)
    .map(([fmt, n]) => `- ${fmt}: ${n}`)
    .join("\n");
}

// Renders the evidence bundle passed in by the controller. `bundle` mirrors
// the sessionReport shape used by generateAssignmentQuestions but extends it
// with an `assignmentQuestions` list so the test call sees both surfaces.
function buildEvidenceSnapshot(bundle) {
  const lines = [];
  if (bundle?.rangeLabel) lines.push(`Evidence window: ${bundle.rangeLabel}`);
  if (bundle?.lessonNames?.length) {
    lines.push(`Lessons covered: ${bundle.lessonNames.join(", ")}`);
  }

  const cw = Array.isArray(bundle?.classworkQuestions)
    ? bundle.classworkQuestions
    : [];
  lines.push(`Total classwork questions in range: ${cw.length}`);
  cw.forEach((q, qi) => {
    lines.push("");
    lines.push(`[Classwork Q${qi + 1}] ${q.question || "(no text)"}`);
    if (q.format) lines.push(`   Format: ${q.format}`);
    if (q.correctAnswer != null && q.correctAnswer !== "") {
      lines.push(`   Reference answer: ${stringifyAnswer(q.correctAnswer)}`);
    }
    const submitted = Array.isArray(q.submitted) ? q.submitted : [];
    submitted.forEach((s, si) => {
      const who = s?.studentName || s?.studentId || `Student ${si + 1}`;
      if (s?.feedback) {
        lines.push(`   - ${who} | last Part 2 feedback: ${s.feedback}`);
      }
    });
    const training = Array.isArray(q.trainingHistory) ? q.trainingHistory : [];
    training.forEach((entry, i) => {
      const who = entry?.studentName || entry?.studentId || `Student ${i + 1}`;
      const items = Array.isArray(entry?.part3) ? entry.part3 : [];
      items
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
        .forEach((text) => lines.push(`   - ${who} | Part 3: ${text}`));
    });
  });

  const asg = Array.isArray(bundle?.assignmentQuestions)
    ? bundle.assignmentQuestions
    : [];
  lines.push("");
  lines.push(`Total assignment questions in range: ${asg.length}`);
  asg.forEach((q, qi) => {
    lines.push("");
    lines.push(`[Assignment Q${qi + 1}] ${q.question || "(no text)"}`);
    if (q.format) lines.push(`   Format: ${q.format}`);
    if (q.correctAnswer != null && q.correctAnswer !== "") {
      lines.push(`   Reference answer: ${stringifyAnswer(q.correctAnswer)}`);
    }
    const submitted = Array.isArray(q.submitted) ? q.submitted : [];
    submitted.forEach((s, si) => {
      const who = s?.studentName || s?.studentId || `Student ${si + 1}`;
      if (s?.feedback) {
        lines.push(`   - ${who} | assignment feedback: ${s.feedback}`);
      }
    });
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

// Public entry point. Returns { questions, generation } with the same shape
// generateAssignmentQuestions returns, so the controller can persist a
// snapshot the same way.
export async function generateTestQuestions({
  evidenceBundle, // { rangeLabel, lessonNames, classworkQuestions, assignmentQuestions }
  perFormatCounts, // { mcq, "fill-blanks", handwriting, textbox } -> int
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

  const [standardPrompt, teacherPrompt, MODEL, retryCfg, schemaGuidance] =
    await Promise.all([
      loadStandardPrompt(),
      loadTeacherTestPrompt(teacherId),
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
    `Topic: ${topic || evidenceBundle?.lessonNames?.[0] || ""}`,
    "",
    "Per-format counts requested:",
    formatCountsBlock(perFormatCounts) || "- (none)",
    "",
    "Evidence bundle (classwork + assignment questions in the picked date range, with the students' last Part 2 hint feedback and full Part 3 diagnostic history):",
    buildEvidenceSnapshot(evidenceBundle || {}),
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
      tag: "TestQuestions",
    },
  );

  logAiUsage(null, result?.usageMetadata, "TestQuestions");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag: "TestQuestions",
  });

  const raw = (result?.text || "").trim();

  await recordAiCallLog({
    tag: "TestQuestions",
    model: MODEL,
    teacherId,
    questionText: `Generate test: course=${course || ""} topic=${topic || ""} totalRequested=${totalRequested}`,
    studentAnswer: userMessage,
    aiResponseSummary: raw,
    userPromptText: userMessage,
    standardPromptSnippet: standardPrompt,
    teacherPromptSnippet: teacherPrompt,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag: "TestQuestions" });
  if (!parsed) throw new Error("AI returned an invalid response.");

  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  // Tests use hints for teacher/report review only; keep the same cap the
  // assignment path uses so schema shape stays consistent.
  const cleaned = list
    .map((q) => normalizeQuestion(q, { maxAiHints: 3 }))
    .filter(Boolean);

  return {
    questions: cleaned,
    generation: {
      standardPrompt,
      teacherPrompt,
      sessionLessonName: (evidenceBundle?.lessonNames || []).join(", "),
      model: MODEL,
      generatedAt: new Date(),
    },
  };
}
