import { GoogleGenAI } from "@google/genai";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import {
  QUESTION_RESPONSE_SCHEMA,
  getSchemaGuidance,
  normalizeQuestion,
  loadStandardPrompt,
  loadTeacherAssignmentPrompt,
} from "./geminiAssignmentQuestions.js";
import { getAiModel, getAiRetry, getAiTuning, getAiDirective } from "./aiConfig.js";

// Individual-assignment generator: one AI call per selected student, all
// sharing a single Gemini explicit-cache handle. The cache holds:
//   - systemInstruction (schema + guidance + standard prompt + teacher prompt
//     + classroom prompt + assignment structure)
//   - a user "context" turn containing every classwork question + its
//     standard solution for the picked lesson(s)
// The per-student call adds a user message with that student's interaction
// history and reports, plus instructions to (1) discuss those reports first,
// (2) then emit tier-A (hard-difficulty) questions with step-by-step
// solutions that target the weaknesses surfaced.
//
// Cache TTL is 1 hour — long enough for a slow fan-out, short enough that
// abandoned generations don't linger. If cache creation fails (usually
// because the shared payload is under Gemini's ~1024-token cache minimum),
// we transparently fall back to embedding the shared payload in each
// per-student call.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Model ID resolved per call via getAiModel() (StandardPrompt.models.default,
// 60s in-memory cache) and threaded into helpers so the shared explicit-cache
// and every per-student call use the same value.
// Gemini explicit-cache TTL comes from tuning.cache.geminiExplicitCacheTtlSeconds
// (default 3600). Resolved inside the entry function so admin edits take
// effect within one 60s config-cache TTL.

// Retry policy + parallel-student concurrency resolved per call via
// getAiRetry("individualAssignment"). Admin can tune both via
// StandardPrompt.retry.individualAssignment (.max/.baseMs/.capMs/.concurrency).
// Higher concurrency halves wall time for larger classes but risks 429s.

// Per-student task directive resolved per call via getAiDirective. Canonical
// text lives in config/standardPromptDefaults.js under
// directives["assignment.perStudentTask"].

function buildSharedContextTurn({
  perFormatCounts,
  maxAiHints,
  course,
  topic,
  classworkQuestions,
}) {
  const lines = [];
  lines.push("=== Shared assignment context (same for every student) ===");
  lines.push(`Course: ${course || ""}`);
  lines.push(`Topic: ${topic || ""}`);
  lines.push(`maxAiHints (cap for hints[] per question): ${maxAiHints}`);
  lines.push("");
  lines.push("Per-format counts requested (for EACH student):");
  Object.entries(perFormatCounts || {})
    .filter(([, n]) => Number(n) > 0)
    .forEach(([fmt, n]) => lines.push(`- ${fmt}: ${n}`));
  lines.push("");
  lines.push(
    `Classwork bank (${classworkQuestions.length} question${classworkQuestions.length === 1 ? "" : "s"}) — every emitted question should build on, extend, or diagnose weaknesses in these:`,
  );
  classworkQuestions.forEach((q, i) => {
    lines.push(`Q${i + 1}. [${q.format || "?"}] ${q.question || "(no text)"}`);
    if (q.correctAnswer)
      lines.push(`   Reference answer: ${stringifyAnswer(q.correctAnswer)}`);
    if (q.standardSolution) {
      lines.push(`   Standard solution: ${q.standardSolution}`);
    }
  });
  return lines.join("\n");
}

function buildStudentTurn({ studentName, studentReports, taskPrompt }) {
  const lines = [];
  lines.push(`=== Individual reports for ${studentName || "this student"} ===`);
  if (!studentReports.length) {
    lines.push("(no per-question interaction reports available)");
  }
  studentReports.forEach((r, i) => {
    lines.push("");
    lines.push(
      `Report ${i + 1}. Q: ${r.originalQuestion || "(no text)"}`,
    );
    if (r.lastAnswer != null && r.lastAnswer !== "") {
      lines.push(`   Latest answer: ${stringifyAnswer(r.lastAnswer)}`);
    }
    (r.interactions || []).forEach((it, j) => {
      lines.push(`   Interaction ${j + 1} (interaction_id=${it._id}):`);
      const p1 = joinPart(it.part1);
      const p2 = joinPart(it.part2);
      const p3 = joinPart(it.part3);
      if (p1) lines.push(`     Part1: ${p1}`);
      if (p2) lines.push(`     Part2: ${p2}`);
      if (p3) lines.push(`     Part3: ${p3}`);
      if (it.correct) lines.push(`     Marked correct.`);
    });
    const t = Array.isArray(r.trainingHistory) ? r.trainingHistory : [];
    if (t.length) {
      lines.push(`   Diagnostic-training history (Part-3 rollup):`);
      t.forEach((e) => {
        const items = Array.isArray(e?.part3) ? e.part3 : [];
        items
          .map((s) => String(s ?? "").trim())
          .filter(Boolean)
          .forEach((text) => lines.push(`     - ${text}`));
      });
    }
  });
  lines.push("");
  lines.push(taskPrompt || "");
  return lines.join("\n");
}

function joinPart(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map((s) => String(s ?? "").trim()).filter(Boolean).join(" | ");
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

async function createSharedCache({
  systemInstruction,
  contextTurnText,
  tag,
  model,
  ttlSeconds,
}) {
  try {
    const cache = await ai.caches.create({
      model,
      config: {
        systemInstruction,
        contents: [{ role: "user", parts: [{ text: contextTurnText }] }],
        ttl: `${ttlSeconds}s`,
      },
    });
    return { name: cache?.name || "", ok: true };
  } catch (err) {
    // Most common failure: shared payload under the min-cache-token
    // threshold (~1024 for gemini-2.5-flash). Fall back to inlining.
    console.warn(
      `[${tag}] caches.create failed — falling back to inline context:`,
      err?.message || err,
    );
    return { name: "", ok: false };
  }
}

async function generateForStudent({
  studentName,
  studentReports,
  cacheName,
  systemInstruction,
  contextTurnText,
  teacherId,
  studentId,
  tag,
  model,
  retryCfg,
  taskPrompt,
}) {
  const studentTurnText = buildStudentTurn({ studentName, studentReports, taskPrompt });

  const contents = cacheName
    ? [{ role: "user", parts: [{ text: studentTurnText }] }]
    : [
        { role: "user", parts: [{ text: contextTurnText }] },
        { role: "user", parts: [{ text: studentTurnText }] },
      ];

  const config = cacheName
    ? {
        cachedContent: cacheName,
        responseMimeType: "application/json",
        responseSchema: QUESTION_RESPONSE_SCHEMA,
      }
    : {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: QUESTION_RESPONSE_SCHEMA,
      };

  const result = await withGeminiRetry(
    () => ai.models.generateContent({ model, contents, config }),
    {
      maxAttempts: retryCfg.max,
      baseDelayMs: retryCfg.baseMs,
      maxDelayMs: retryCfg.capMs,
      tag,
    },
  );

  logAiUsage(null, result?.usageMetadata, tag);
  await recordAiTokenUsage(result?.usageMetadata, {
    sessionId: null,
    tag,
  });

  const raw = (result?.text || "").trim();
  await recordAiCallLog({
    tag,
    model,
    teacherId,
    studentId,
    studentName,
    questionText: `Individual assignment for ${studentName || studentId}`,
    studentAnswer: studentTurnText,
    aiResponseSummary: raw,
    userPromptText: studentTurnText,
    usageMetadata: result?.usageMetadata,
  });

  const parsed = parseFirstJsonObject(raw, { tag });
  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return {
    questions: list
      .map((q) => normalizeQuestion(q, { maxAiHints: 0 }))
      .filter(Boolean),
    usageMetadata: result?.usageMetadata || {},
  };
}

// Public entry point. `perStudentData` is an array of
// { studentId, studentName, studentReports } (studentReports are
// AssignmentAiReport-shaped records for that student's classwork, in
// serialisable POJO form). Returns
//   {
//     perStudent: [{ studentId, questions }],
//     generation: { ..., cachedContentName, cachedContentTokenCount },
//   }
export async function generateIndividualAssignmentQuestions({
  classworkQuestions, // [{ question, format, correctAnswer, standardSolution }]
  perFormatCounts,
  maxAiHints,
  course,
  topic,
  classroomPrompt,
  teacherId,
  perStudentData, // [{ studentId, studentName, studentReports }]
}) {
  if (!Array.isArray(perStudentData) || perStudentData.length === 0) {
    throw new Error("perStudentData must include at least one student.");
  }
  const totalRequested = Object.values(perFormatCounts || {}).reduce(
    (n, v) => n + (Number(v) || 0),
    0,
  );
  if (!totalRequested) {
    throw new Error("perFormatCounts must request at least one question.");
  }

  const [standardPrompt, teacherPrompt, MODEL, retryCfg, cacheTuning, taskPrompt] = await Promise.all([
    loadStandardPrompt(),
    loadTeacherAssignmentPrompt(teacherId),
    getAiModel(),
    getAiRetry("individualAssignment"),
    getAiTuning("cache"),
    getAiDirective("assignment.perStudentTask"),
  ]);
  const STUDENT_CONCURRENCY = Math.max(1, Number(retryCfg.concurrency) || 5);
  const explicitCacheTtl = Math.max(60, Number(cacheTuning?.geminiExplicitCacheTtlSeconds) || 3600);

  const systemInstruction = [
    SCHEMA_GUIDANCE,
    standardPrompt,
    teacherPrompt,
    classroomPrompt,
    "This is an INDIVIDUAL assignment — every emitted question must be personalised to the single student described in the per-call user turn.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const contextTurnText = buildSharedContextTurn({
    perFormatCounts,
    maxAiHints,
    course,
    topic,
    classworkQuestions,
  });

  const tag = "IndividualAssignment";
  const { name: cacheName, ok: cacheOk } = await createSharedCache({
    systemInstruction,
    contextTurnText,
    tag,
    model: MODEL,
    ttlSeconds: explicitCacheTtl,
  });

  const perStudent = new Array(perStudentData.length);
  let cachedContentTokenCount = 0;
  let cursor = 0;
  const lanes = Array.from(
    { length: Math.min(STUDENT_CONCURRENCY, perStudentData.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= perStudentData.length) return;
        const s = perStudentData[idx];
        try {
          const { questions, usageMetadata } = await generateForStudent({
            studentName: s.studentName,
            studentReports: s.studentReports || [],
            cacheName,
            systemInstruction,
            contextTurnText,
            teacherId,
            studentId: s.studentId,
            tag,
            model: MODEL,
            retryCfg,
            taskPrompt,
          });
          cachedContentTokenCount +=
            Number(usageMetadata?.cachedContentTokenCount) || 0;
          perStudent[idx] = { studentId: s.studentId, questions };
        } catch (err) {
          console.error(
            `[${tag}] student ${s.studentId} failed:`,
            err?.message || err,
          );
          perStudent[idx] = { studentId: s.studentId, questions: [] };
        }
      }
    },
  );
  await Promise.all(lanes);

  // Best-effort cache cleanup. Ignored on failure — TTL will reap it.
  if (cacheOk && cacheName) {
    try {
      await ai.caches.delete({ name: cacheName });
    } catch (err) {
      console.warn(`[${tag}] caches.delete failed:`, err?.message || err);
    }
  }

  return {
    perStudent,
    generation: {
      standardPrompt,
      teacherPrompt,
      sessionLessonName: "",
      model: MODEL,
      generatedAt: new Date(),
      cachedContentName: cacheName,
      cachedContentTokenCount,
    },
  };
}

// Retained as an async helper for callers that only need the model ID for
// audit metadata (e.g. assignmentController's stats.questionModel).
export async function getIndividualAssignmentQuestionModel() {
  return getAiModel();
}
