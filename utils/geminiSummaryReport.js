// Date-Range Summary Report Gemini generators (Task 3).
//
// Two public functions:
//   - generateClassSummary(...)   — one call for the whole class
//   - generateStudentSummary(...) — one call per student (caller fans out
//                                   with Promise.allSettled)
//
// Both follow the same recipe used by geminiTestClassReport:
//   1. Load the admin standard prompt (classSummaryPrompt / studentSummaryPrompt)
//   2. Load the teacher's personalised reportPrompt (TeacherAIConfig)
//   3. Stack them as systemInstruction (standard first, teacher appended)
//   4. Build a short structured user message from the aggregator output
//   5. Call Gemini with a strict responseSchema so the output is parseable
//   6. Log usage via recordAiTokenUsage + recordAiCallLog
//   7. Parse + return a typed object

import crypto from "crypto";
import { GoogleGenAI, Type } from "@google/genai";
import StandardPrompt from "../models/standardPromptModel.js";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry } from "./aiConfig.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Response shapes. Kept intentionally small so a prompt-driven shape change
// doesn't require a schema migration; the admin can still enrich the output
// via prompt text (Gemini will populate whichever declared fields it has
// content for).
const CLASS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    themes: { type: Type.ARRAY, items: { type: Type.STRING } },
    topDifficulties: { type: Type.ARRAY, items: { type: Type.STRING } },
    notableStrengths: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["summary", "themes", "topDifficulties"],
};

const STUDENT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
    growthAreas: { type: Type.ARRAY, items: { type: Type.STRING } },
    recommendedFocus: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ["summary", "strengths", "growthAreas", "recommendedFocus"],
};

// ---------------------------------------------------------------------------
// Prompt loaders
// ---------------------------------------------------------------------------

async function loadClassSummaryPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("classSummaryPrompt")
      .lean();
    return (doc?.classSummaryPrompt || "").trim();
  } catch (err) {
    console.error("[SummaryReport] Failed to load classSummaryPrompt:", err);
    return "";
  }
}

async function loadStudentSummaryPrompt() {
  try {
    const doc = await StandardPrompt.findOne({ key: "global" })
      .select("studentSummaryPrompt")
      .lean();
    return (doc?.studentSummaryPrompt || "").trim();
  } catch (err) {
    console.error("[SummaryReport] Failed to load studentSummaryPrompt:", err);
    return "";
  }
}

async function loadTeacherReportPrompt(teacherId) {
  if (!teacherId) return "";
  try {
    const cfg = await TeacherAIConfig.findOne({ user: teacherId })
      .select("reportPrompt")
      .lean();
    return (cfg?.reportPrompt || "").trim();
  } catch (err) {
    console.error("[SummaryReport] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

// Stable hash of the composed systemInstruction so SummaryReport cache
// lookups can detect "prompt changed since this summary was generated" and
// regenerate. Not security-sensitive — plain SHA-256 of the UTF-8 bytes.
export function hashPromptBundle(parts) {
  const text = parts.filter(Boolean).join("\n\n");
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Class Summary
// ---------------------------------------------------------------------------

/**
 * One Gemini call, one aggregated class-wide summary.
 *
 * Inputs:
 *   aggregated: output of aggregateClassSummaryInputs(...)
 *   teacherId:  owning teacher (for teacher-prompt + audit-log attribution)
 *   classroomName / dateRange: display metadata echoed into the user prompt
 *
 * Returns { body, promptHash, model } — the body is already-validated JSON.
 */
export async function generateClassSummary({
  teacherId,
  classroomName,
  dateRange,
  aggregated,
  instructionLanguage,
}) {
  const [classPrompt, teacherPrompt, MODEL, retryCfg] = await Promise.all([
    loadClassSummaryPrompt(),
    loadTeacherReportPrompt(teacherId),
    getAiModel(),
    getAiRetry("classReport"),
  ]);

  const systemInstruction = [classPrompt, teacherPrompt]
    .filter(Boolean)
    .join("\n\n");

  const userMessage = buildClassUserMessage({
    classroomName,
    dateRange,
    aggregated,
    instructionLanguage,
  });

  const result = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: CLASS_RESPONSE_SCHEMA,
        },
      }),
    {
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag: "SummaryReport:class",
    },
  );

  logAiUsage(null, result?.usageMetadata, "SummaryReport:class");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag: "SummaryReport:class",
  });

  const raw = (result?.text || "").trim();

  await recordAiCallLog({
    tag: "SummaryReport:class",
    model: MODEL,
    teacherId,
    questionText: `Class date-range summary (${formatDate(dateRange?.start)} to ${formatDate(dateRange?.end)})`,
    studentAnswer: userMessage,
    aiResponseSummary: raw,
    userPromptText: userMessage,
    standardPromptSnippet: classPrompt,
    teacherPromptSnippet: teacherPrompt,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag: "SummaryReport:class" }) || {};
  const body = {
    summary: String(parsed.summary || "").trim(),
    themes: toStringArray(parsed.themes),
    topDifficulties: toStringArray(parsed.topDifficulties),
    notableStrengths: toStringArray(parsed.notableStrengths),
  };

  return {
    body,
    promptHash: hashPromptBundle([classPrompt, teacherPrompt]),
    model: MODEL,
  };
}

function buildClassUserMessage({ classroomName, dateRange, aggregated, instructionLanguage }) {
  const lines = [
    `Instruction Language: ${normLang(instructionLanguage)}`,
    `Classroom: ${classroomName || "(unnamed)"}`,
    `Date range: ${formatDate(dateRange?.start)} to ${formatDate(dateRange?.end)}`,
    "",
  ];

  const cw = aggregated?.classwork || [];
  const as = aggregated?.assignments || [];
  const ts = aggregated?.tests || [];

  if (cw.length === 0 && as.length === 0 && ts.length === 0) {
    lines.push("(No class-level reports exist for the selected items.)");
    return lines.join("\n");
  }

  if (cw.length > 0) {
    lines.push("=== Classwork class reports (studentDifficulties) ===");
    for (const item of cw) {
      lines.push(`- Lesson "${item.lessonName}" (${formatDate(item.date)}):`);
      for (const d of item.studentDifficulties) {
        const who = d.affectedStudents.length ? ` [students: ${d.affectedStudents.join(", ")}]` : "";
        lines.push(`    - ${d.difficulty}${who}`);
      }
    }
    lines.push("");
  }

  if (as.length > 0) {
    lines.push("=== Assignment class reports (studentDifficulties) ===");
    for (const item of as) {
      lines.push(`- Assignment "${item.title}" (${formatDate(item.createdAt)}):`);
      for (const d of item.studentDifficulties) {
        const who = d.affectedStudents.length ? ` [students: ${d.affectedStudents.join(", ")}]` : "";
        lines.push(`    - ${d.difficulty}${who}`);
      }
    }
    lines.push("");
  }

  if (ts.length > 0) {
    lines.push("=== Test class reports (summary + topDifficulties) ===");
    for (const item of ts) {
      lines.push(`- Test "${item.title}" (${formatDate(item.createdAt)}):`);
      if (item.summary) lines.push(`    Summary: ${item.summary}`);
      if (item.topDifficulties.length > 0) {
        lines.push(`    Top difficulties:`);
        for (const d of item.topDifficulties) lines.push(`      - ${d}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Student Individual Summary (per student)
// ---------------------------------------------------------------------------

/**
 * One Gemini call for ONE student. Caller fans out with Promise.allSettled
 * so one failing student doesn't abort the whole request.
 *
 * Returns { body, promptHash, model } on success. Caller handles the thrown-
 * from-Gemini case (partial status + failureReason on the SummaryReport
 * perStudent entry).
 */
export async function generateStudentSummary({
  teacherId,
  studentId,
  studentName,
  classroomName,
  dateRange,
  aggregated,
  instructionLanguage,
}) {
  const [studentPrompt, teacherPrompt, MODEL, retryCfg] = await Promise.all([
    loadStudentSummaryPrompt(),
    loadTeacherReportPrompt(teacherId),
    getAiModel(),
    getAiRetry("classReport"),
  ]);

  const systemInstruction = [studentPrompt, teacherPrompt]
    .filter(Boolean)
    .join("\n\n");

  const userMessage = buildStudentUserMessage({
    studentName,
    classroomName,
    dateRange,
    aggregated,
    instructionLanguage,
  });

  const result = await withGeminiRetry(
    () =>
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        config: {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema: STUDENT_RESPONSE_SCHEMA,
        },
      }),
    {
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag: "SummaryReport:student",
    },
  );

  logAiUsage(null, result?.usageMetadata, "SummaryReport:student");
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag: "SummaryReport:student",
  });

  const raw = (result?.text || "").trim();

  await recordAiCallLog({
    tag: "SummaryReport:student",
    model: MODEL,
    teacherId,
    questionText: `Student date-range summary for ${studentName || studentId} (${formatDate(dateRange?.start)} to ${formatDate(dateRange?.end)})`,
    studentAnswer: userMessage,
    aiResponseSummary: raw,
    userPromptText: userMessage,
    standardPromptSnippet: studentPrompt,
    teacherPromptSnippet: teacherPrompt,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag: "SummaryReport:student" }) || {};
  const body = {
    summary: String(parsed.summary || "").trim(),
    strengths: toStringArray(parsed.strengths),
    growthAreas: toStringArray(parsed.growthAreas),
    recommendedFocus: toStringArray(parsed.recommendedFocus),
  };

  return {
    body,
    promptHash: hashPromptBundle([studentPrompt, teacherPrompt]),
    model: MODEL,
  };
}

function buildStudentUserMessage({
  studentName,
  classroomName,
  dateRange,
  aggregated,
  instructionLanguage,
}) {
  const lines = [
    `Instruction Language: ${normLang(instructionLanguage)}`,
    `Classroom: ${classroomName || "(unnamed)"}`,
    `Student: ${studentName || "(unknown)"}`,
    `Date range: ${formatDate(dateRange?.start)} to ${formatDate(dateRange?.end)}`,
    "",
  ];

  const cw = aggregated?.classwork || [];
  const as = aggregated?.assignments || [];
  const ts = aggregated?.tests || [];

  if (cw.length === 0 && as.length === 0 && ts.length === 0) {
    lines.push(`(No recorded attempts for ${studentName || "this student"} in the selected items.)`);
    return lines.join("\n");
  }

  if (cw.length > 0) {
    lines.push("=== Classwork (per-question diagnostic attempts) ===");
    for (const item of cw) {
      lines.push(`- Lesson "${item.lessonName}" (${formatDate(item.date)}):`);
      for (const q of item.questions) formatQuestionSlice(lines, q);
    }
    lines.push("");
  }

  if (as.length > 0) {
    lines.push("=== Assignments (per-question diagnostic attempts) ===");
    for (const item of as) {
      lines.push(`- Assignment "${item.title}" (${formatDate(item.createdAt)}):`);
      for (const q of item.questions) formatQuestionSlice(lines, q);
    }
    lines.push("");
  }

  if (ts.length > 0) {
    lines.push("=== Tests (per-question graded feedback) ===");
    for (const item of ts) {
      lines.push(`- Test "${item.title}" (${formatDate(item.createdAt)}):`);
      for (const q of item.questions) {
        lines.push(`    * Question: ${truncate(q.questionText, 200)}`);
        lines.push(`      Final attempt correct: ${q.finalCorrect ? "yes" : "no"}`);
        lines.push(`      Feedback: ${q.feedback}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatQuestionSlice(lines, q) {
  lines.push(`    * Question: ${truncate(q.questionText, 200)}`);
  lines.push(`      Final attempt correct: ${q.finalCorrect ? "yes" : "no"}`);
  if (q.misconceptionAttempts.length > 0) {
    lines.push(`      Misconception line per attempt:`);
    for (const a of q.misconceptionAttempts) {
      lines.push(`        [attempt ${a.attempt}, ${a.correct ? "correct" : "wrong"}] ${a.misconception}`);
    }
  }
  const last = q.last || {};
  if (
    (last.part1 && last.part1.length) ||
    (last.part2 && last.part2.length) ||
    (last.part3 && last.part3.length)
  ) {
    lines.push(`      Last attempt diagnostic:`);
    if (last.part1?.length) lines.push(`        part1: ${last.part1.join(" | ")}`);
    if (last.part2?.length) lines.push(`        part2: ${last.part2.join(" | ")}`);
    if (last.part3?.length) lines.push(`        part3: ${last.part3.join(" | ")}`);
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function normLang(lang) {
  return (typeof lang === "string" && lang.trim()) || "English";
}

function toStringArray(v) {
  return Array.isArray(v) ? v.map((x) => String(x || "").trim()).filter(Boolean) : [];
}

function formatDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

function truncate(s, n) {
  const str = String(s || "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}
