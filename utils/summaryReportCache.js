// Date-Range Summary Report cache (Task 3).
//
// Unlike an in-process Map, this cache IS the SummaryReport collection
// itself. A cache hit = finding an existing SummaryReport doc that:
//   1. matches the deterministic request signature (cacheKey), AND
//   2. was generated under the current standard-prompt hash (invalidated
//      automatically when the admin edits classSummaryPrompt /
//      studentSummaryPrompt / the teacher's reportPrompt), AND
//   3. is younger than CACHE_TTL_MS.
//
// We don't delete-on-prompt-save because the emailed student-summary tokens
// have 90-day validity — the doc itself must live as long as its tokens.
// The hash predicate is enough to ensure stale output is never served.

import crypto from "crypto";
import SummaryReport from "../models/SummaryReportModel.js";

// 24h per Francis's confirmation.
export const SUMMARY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic signature of a summary request. Two requests with the same
 * (kind, classroomId, dateRange, selectedItems, studentIds sorted) will
 * produce the same cacheKey so a repeat click returns the cached doc.
 *
 * The signature is NOT prompt-aware on purpose — prompt-hash changes
 * invalidate at lookup time (see findCachedSummary), not at key-build time,
 * so an admin edit doesn't fragment the cache.
 */
export function buildSummaryCacheKey({
  kind,
  classroomId,
  dateRange,
  selectedItems,
  studentIds, // only used for kind="student"
}) {
  const normalized = {
    kind: String(kind || ""),
    classroomId: String(classroomId || ""),
    start: dateRange?.start ? new Date(dateRange.start).toISOString() : "",
    end: dateRange?.end ? new Date(dateRange.end).toISOString() : "",
    lessonIds: sortedIds(selectedItems?.lessonIds),
    assignmentTaskIds: sortedIds(selectedItems?.assignmentTaskIds),
    testTaskIds: sortedIds(selectedItems?.testTaskIds),
    studentIds: kind === "student" ? sortedIds(studentIds) : [],
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function sortedIds(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => String(x)).sort();
}

/**
 * Look up a cached summary. Returns the SummaryReport doc on hit, null on
 * miss. The caller inspects the returned doc's shape (body vs perStudent)
 * based on kind.
 */
export async function findCachedSummary({ cacheKey, standardPromptHash, ttlMs = SUMMARY_CACHE_TTL_MS }) {
  const cutoff = new Date(Date.now() - ttlMs);
  const doc = await SummaryReport.findOne({
    cacheKey,
    standardPromptHash,
    createdAt: { $gte: cutoff },
  })
    .sort({ createdAt: -1 })
    .lean();
  return doc || null;
}
