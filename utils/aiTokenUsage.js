import mongoose from "mongoose";
import AiTokenUsage from "../models/AiTokenUsageModel.js";
import AiCallLog from "../models/AiCallLogModel.js";

const CALL_LOG_MAX_STRING = 4000;

function truncate(value, max = CALL_LOG_MAX_STRING) {
  if (value == null) return "";
  const s = typeof value === "string" ? value : safeStringify(value);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [truncated, ${s.length - max} chars omitted]`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function currentMonthKey(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  try {
    return new mongoose.Types.ObjectId(String(value));
  } catch {
    return null;
  }
}

// Grep-friendly one-line summary of a Gemini call's token usage. Printed
// per call so devs can `grep '\[AI '` the logs and see input/output/cached
// counts without dumping the full usageMetadata blob. Call site passes a
// reqId (may be null) plus a short tag identifying which util made the call.
export function logAiUsage(reqId, usageMetadata, tag) {
  if (!usageMetadata) {
    console.log(`[AI req=${reqId || "-"}][${tag || "AI"}] (no usageMetadata)`);
    return;
  }
  const input = Number(usageMetadata.promptTokenCount) || 0;
  const output = Number(usageMetadata.candidatesTokenCount) || 0;
  const cached = Number(usageMetadata.cachedContentTokenCount) || 0;
  const thoughts =
    Number(
      usageMetadata.thoughtsTokenCount ??
        usageMetadata.total_thought_tokens ??
        usageMetadata.totalThoughtTokens ??
        0,
    ) || 0;
  const total =
    Number(usageMetadata.totalTokenCount) || input + output + thoughts;
  console.log(
    `[AI req=${reqId || "-"}][${tag || "AI"}] input=${input} output=${output} cached=${cached} thoughts=${thoughts} total=${total}`,
  );
}

// Persists a single per-call audit row so the admin panel can show the
// question / student answer / AI response side-by-side with token counts.
// Every field is optional — assignment-generation and image-gen calls have
// no session/student and pass null for those. Long strings are truncated
// before write to keep individual documents small.
export async function recordAiCallLog({
  reqId,
  tag,
  model,
  sessionId,
  classroomId,
  teacherId,
  studentId,
  studentName,
  questionText,
  studentAnswer,
  aiResponseSummary,
  standardPromptSnippet,
  standardPromptHash,
  teacherPromptSnippet,
  usageMetadata,
  error,
}) {
  try {
    const promptTokenCount = Number(usageMetadata?.promptTokenCount) || 0;
    const candidatesTokenCount =
      Number(usageMetadata?.candidatesTokenCount) || 0;
    const cachedContentTokenCount =
      Number(usageMetadata?.cachedContentTokenCount) || 0;
    const totalThoughtTokens =
      Number(
        usageMetadata?.thoughtsTokenCount ??
          usageMetadata?.total_thought_tokens ??
          usageMetadata?.totalThoughtTokens ??
          0,
      ) || 0;
    const totalTokens =
      Number(usageMetadata?.totalTokenCount) ||
      promptTokenCount + candidatesTokenCount + totalThoughtTokens;

    await AiCallLog.create({
      reqId: reqId || "",
      tag: tag || "AI",
      model: model || "",
      sessionId: sessionId || null,
      classroomId: classroomId || null,
      teacherId: teacherId || null,
      studentId: studentId || null,
      studentName: (studentName || "").slice(0, 200),
      questionText: truncate(questionText),
      studentAnswer: truncate(studentAnswer),
      aiResponseSummary: truncate(aiResponseSummary),
      standardPromptSnippet: truncate(standardPromptSnippet, 800),
      standardPromptHash: (standardPromptHash || "").slice(0, 80),
      teacherPromptSnippet: truncate(teacherPromptSnippet, 800),
      promptTokenCount,
      candidatesTokenCount,
      cachedContentTokenCount,
      totalThoughtTokens,
      totalTokens,
      error: truncate(error, 800),
    });
  } catch (err) {
    console.error(
      `[${tag || "AI"}] Failed to persist AI call log (reqId=${reqId || "-"}):`,
      err,
    );
  }
}

// Sums Gemini's per-call usageMetadata into the (month, session) row. Uses
// an upsert + $inc so concurrent classwork submissions don't clobber each
// other. Reads both camelCase (SDK field) and snake_case (raw REST field)
// for the thoughts count so we survive a future SDK rename.
export async function recordAiTokenUsage(
  usageMetadata,
  { sessionId = null, tag = "AI" } = {},
) {
  if (!usageMetadata) return;
  const promptTokenCount = Number(usageMetadata.promptTokenCount) || 0;
  const candidatesTokenCount = Number(usageMetadata.candidatesTokenCount) || 0;
  const cachedContentTokenCount =
    Number(usageMetadata.cachedContentTokenCount) || 0;
  const totalThoughtTokens =
    Number(
      usageMetadata.thoughtsTokenCount ??
        usageMetadata.total_thought_tokens ??
        usageMetadata.totalThoughtTokens ??
        0,
    ) || 0;

  if (
    promptTokenCount === 0 &&
    candidatesTokenCount === 0 &&
    cachedContentTokenCount === 0 &&
    totalThoughtTokens === 0
  ) {
    return;
  }

  const monthKey = currentMonthKey();
  const sessionObjectId = toObjectId(sessionId);
  try {
    await AiTokenUsage.updateOne(
      { monthKey, sessionId: sessionObjectId },
      {
        $inc: {
          promptTokenCount,
          candidatesTokenCount,
          cachedContentTokenCount,
          totalThoughtTokens,
        },
        $setOnInsert: { monthKey, sessionId: sessionObjectId },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error(
      `[${tag}] Failed to persist AI token usage for ${monthKey} session=${sessionObjectId || "none"}:`,
      err,
    );
  }
}
