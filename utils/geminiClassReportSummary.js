import { GoogleGenAI, Type } from "@google/genai";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import StandardPrompt from "../models/standardPromptModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry, getAiTuning, getAiDirective } from "./aiConfig.js";

// Output-token budget scales with class size (base + per-student × n) and
// thinking budget are resolved per call from StandardPrompt.tuning.report
// via getAiTuning("report"). Report generation is pattern-matching, not
// deep reasoning, so an unlimited budget (thinkingBudget: -1) adds many
// seconds of pre-response delay for no quality win — the tuning defaults
// keep the visible wait bounded.

function reportMaxOutputTokens(studentCount, reportTuning) {
  const n = Number(studentCount) > 0 ? Number(studentCount) : 0;
  return Math.min(
    reportTuning.baseMaxOutputTokens + reportTuning.perStudentTokens * n,
    reportTuning.maxOutputTokensCap,
  );
}

// Generates the lesson-level "Class Report" summary that the teacher sees by
// default on the View Report page. Distinct from getClassworkAiFeedback, which
// runs per student submission and produces individual feedback.
//
// The system instruction is built from the admin's editable
// StandardPrompt.reportPromptSections (5 sub-sections) and the per-teacher
// TeacherAIConfig.reportPrompt. The lesson's classwork questions and the
// students' submitted answers are passed in as the user content.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Model ID resolved per call via getAiModel() (StandardPrompt.models.default,
// 60s in-memory cache). Captured into a local const at the top of
// generateClassReportSummary so downstream closures see a stable value.

// Generation is now run in the background after the end-lesson HTTP response
// has been sent, so we can ride out long Gemini demand spikes instead of
// failing fast. Retry policy resolved per call via getAiRetry("classReport")
// — defaults to ~20 attempts / 60s cap (~15 minutes of retry headroom),
// enough to outlast typical 503/UNAVAILABLE windows without leaking work
// forever. An admin can tune it via StandardPrompt.retry.classReport.

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
    return prompt;
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
    return joined;
  } catch (err) {
    console.error("[ClassReportSummary] Failed to load StandardPrompt:", err);
    return "";
  }
}

// The report is generated as TWO parallel Gemini calls whose outputs are
// merged: (A) studentDifficulties (per-student pattern-matching over the
// snapshot) and (B) nextLessonStrategy + targetedHomework (planning derived
// from those difficulties). Splitting halves the per-call output-token
// budget, lets both calls run concurrently, and — because each call gets a
// narrower responseSchema — Gemini spends thinking tokens on the section it
// actually has to fill, cutting end-to-end latency roughly in half compared
// to one big triple-field call. Each call keeps its own subset of the
// admin-authored shape so structured-output enforcement stays strict.
const DIFFICULTIES_ONLY_SCHEMA = {
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
  },
  required: ["studentDifficulties"],
};

const STRATEGIES_ONLY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
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
  required: ["nextLessonStrategy", "targetedHomework"],
};

// Prompt suffixes appended to the snapshot per call to tell Gemini which
// section it's answering. The systemInstruction still carries the admin's
// full 3-section guidance so tone and structure are preserved; these
// suffixes just narrow the current call's focus. Text resolved per call via
// getAiDirective from StandardPrompt.directives — canonical defaults live
// in config/standardPromptDefaults.js.

// Compact the lesson's classwork + submissions into a textual snapshot the
// model can summarize. Per-student answers are listed under each question so
// the model can see the spread of responses.
function buildLessonSnapshot({ lessonName, questions, interactionId, previousInteractionId }) {
  const lines = [];
  if (interactionId) lines.push(`interaction_id: ${interactionId}`);
  lines.push(`previous_interaction_id: ${previousInteractionId || "null"}`);
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
  studentCount,
  sessionId,
  interactionId,
  previousInteractionId,
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

  const [
    standardSection,
    teacherSection,
    MODEL,
    retryCfg,
    reportTuning,
    DIFFICULTIES_DIRECTIVE,
    STRATEGIES_DIRECTIVE,
  ] = await Promise.all([
    buildStandardSection(),
    buildTeacherSection(teacherId),
    getAiModel(),
    getAiRetry("classReport"),
    getAiTuning("report"),
    getAiDirective("report.difficultiesDirective"),
    getAiDirective("report.strategiesDirective"),
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

  const snapshot = buildLessonSnapshot({
    lessonName,
    questions,
    interactionId,
    previousInteractionId,
  });

  const maxOutputTokens = reportMaxOutputTokens(studentCount, reportTuning);
  // Difficulties is the section whose length grows with class size
  // (one bullet per distinct difficulty × affectedStudents list). Strategies
  // + homework are effectively fixed-shape planning bullets and don't need
  // to scale with student count.
  const difficultiesMaxTokens = maxOutputTokens;
  // Strategies + homework are fixed-shape planning bullets; the tuning
  // default (900 tokens) is enough for a full-length plan without wasting
  // budget. Output tokens are the #1 latency driver.
  const strategiesMaxTokens = Math.min(
    reportTuning.strategiesMaxTokens,
    reportTuning.maxOutputTokensCap
  );
  console.log(
    `[ClassReportSummary] studentCount=${studentCount ?? "?"} → difficulties=${difficultiesMaxTokens}, strategies=${strategiesMaxTokens}`,
  );

  const callGemini = ({ tag, schema, directive, maxOutputTokensForCall }) =>
    withGeminiRetry(
      () =>
        ai.models.generateContent({
          model: MODEL,
          contents: [
            {
              role: "user",
              parts: [{ text: `${snapshot}\n\n${directive}` }],
            },
          ],
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema: schema,
            thinkingConfig: { thinkingBudget: reportTuning.thinkingBudget },
            maxOutputTokens: maxOutputTokensForCall,
          },
        }),
      {
        maxAttempts: retryCfg.max,
        baseDelayMs: retryCfg.baseMs,
        maxDelayMs: retryCfg.capMs,
        tag,
      },
    );

  // Run both calls concurrently. allSettled so a single-call failure still
  // returns a partial (but useful) report instead of nothing.
  const [difficultiesSettled, strategiesSettled] = await Promise.allSettled([
    callGemini({
      tag: "ClassReportSummary:difficulties",
      schema: DIFFICULTIES_ONLY_SCHEMA,
      directive: DIFFICULTIES_DIRECTIVE,
      maxOutputTokensForCall: difficultiesMaxTokens,
    }),
    callGemini({
      tag: "ClassReportSummary:strategies",
      schema: STRATEGIES_ONLY_SCHEMA,
      directive: STRATEGIES_DIRECTIVE,
      maxOutputTokensForCall: strategiesMaxTokens,
    }),
  ]);

  if (difficultiesSettled.status === "rejected") {
    console.error(
      "[ClassReportSummary] difficulties call failed:",
      difficultiesSettled.reason?.message || difficultiesSettled.reason,
    );
  }
  if (strategiesSettled.status === "rejected") {
    console.error(
      "[ClassReportSummary] strategies call failed:",
      strategiesSettled.reason?.message || strategiesSettled.reason,
    );
  }

  const difficultiesResult =
    difficultiesSettled.status === "fulfilled" ? difficultiesSettled.value : null;
  const strategiesResult =
    strategiesSettled.status === "fulfilled" ? strategiesSettled.value : null;

  // Both calls failed — give up like the single-call path used to.
  if (!difficultiesResult && !strategiesResult) return null;

  logAiUsage(null, difficultiesResult?.usageMetadata, "ClassReportSummary:difficulties");
  logAiUsage(null, strategiesResult?.usageMetadata, "ClassReportSummary:strategies");
  await Promise.all([
    difficultiesResult?.usageMetadata
      ? recordAiTokenUsage(difficultiesResult.usageMetadata, {
          sessionId,
          tag: "ClassReportSummary:difficulties",
        })
      : null,
    strategiesResult?.usageMetadata
      ? recordAiTokenUsage(strategiesResult.usageMetadata, {
          sessionId,
          tag: "ClassReportSummary:strategies",
        })
      : null,
  ].filter(Boolean));

  const difficultiesText = (difficultiesResult?.text || "").trim();
  const strategiesText = (strategiesResult?.text || "").trim();

  // Per-call audit log. Two rows so admins can inspect each split call
  // separately when investigating a bad summary.
  await Promise.all([
    difficultiesResult
      ? recordAiCallLog({
          tag: "ClassReportSummary:difficulties",
          model: MODEL,
          sessionId,
          teacherId,
          questionText: `Lesson: ${lessonName || ""} (${questions.length} questions, ${totalSubmissions} submissions)`,
          studentAnswer: snapshot,
          aiResponseSummary: difficultiesText,
          userPromptText: `${snapshot}\n\n${DIFFICULTIES_DIRECTIVE}`,
          standardPromptSnippet: standardSection,
          teacherPromptSnippet: teacherSection,
          usageMetadata: difficultiesResult.usageMetadata,
        })
      : null,
    strategiesResult
      ? recordAiCallLog({
          tag: "ClassReportSummary:strategies",
          model: MODEL,
          sessionId,
          teacherId,
          questionText: `Lesson: ${lessonName || ""} (${questions.length} questions, ${totalSubmissions} submissions)`,
          studentAnswer: snapshot,
          aiResponseSummary: strategiesText,
          userPromptText: `${snapshot}\n\n${STRATEGIES_DIRECTIVE}`,
          standardPromptSnippet: standardSection,
          teacherPromptSnippet: teacherSection,
          usageMetadata: strategiesResult.usageMetadata,
        })
      : null,
  ].filter(Boolean));

  // responseMimeType=application/json should guarantee raw JSON, but in
  // practice the model occasionally still wraps output in ```json fences
  // or leaks a leading note. Extract the first { ... } block defensively.
  const difficultiesParsed = difficultiesText
    ? parseFirstJsonObject(difficultiesText, { tag: "ClassReportSummary:difficulties" })
    : null;
  const strategiesParsed = strategiesText
    ? parseFirstJsonObject(strategiesText, { tag: "ClassReportSummary:strategies" })
    : null;

  const studentDifficulties = Array.isArray(difficultiesParsed?.studentDifficulties)
    ? difficultiesParsed.studentDifficulties
        .map((entry) => ({
          difficulty: String(entry?.difficulty || "").trim(),
          affectedStudents: Array.isArray(entry?.affectedStudents)
            ? entry.affectedStudents.map((s) => String(s).trim()).filter(Boolean)
            : [],
        }))
        .filter((entry) => entry.difficulty)
    : [];
  const nextLessonStrategy = Array.isArray(strategiesParsed?.nextLessonStrategy)
    ? strategiesParsed.nextLessonStrategy
        .map((entry) => ({
          difficulty: String(entry?.difficulty || "").trim(),
          teachingStrategy: String(entry?.teachingStrategy || "").trim(),
        }))
        .filter((entry) => entry.difficulty || entry.teachingStrategy)
    : [];
  const targetedHomework = Array.isArray(strategiesParsed?.targetedHomework)
    ? strategiesParsed.targetedHomework
        .map((entry) => ({
          kindsOfTraining: String(entry?.kindsOfTraining || "").trim(),
          link: String(entry?.link || "").trim(),
        }))
        .filter((entry) => entry.kindsOfTraining)
    : [];

  // If both parsed to nothing, the report is truly empty — bail like the
  // old path did on parse failure.
  if (
    studentDifficulties.length === 0 &&
    nextLessonStrategy.length === 0 &&
    targetedHomework.length === 0
  ) {
    console.warn(
      "[ClassReportSummary] Both split calls returned empty payloads — no report to save.",
    );
    return null;
  }

  return {
    studentDifficulties,
    nextLessonStrategy,
    targetedHomework,
    interactionId: interactionId || "",
    previousInteractionId: previousInteractionId || "",
    generatedAt: new Date(),
    model: MODEL,
  };
}
