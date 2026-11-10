import mongoose from "mongoose";

// Date-Range Summary Report (Task 3).
//
// Covers both report kinds:
//   kind="class"    — one aggregated class-wide summary; body is the Gemini
//                     response for the whole class; perStudent is empty.
//   kind="student"  — one row per request; perStudent[] holds the Gemini
//                     response for each selected student. We keep both class
//                     and student requests on ONE model so the admin UI,
//                     cache, and token-link plumbing stay unified.
//
// The doc is BOTH the persisted artifact (teacher revisits weeks later) AND
// the cache record (same-request lookup returns this doc when it's younger
// than CACHE_TTL_MS and its standardPromptHash matches the current admin
// prompt). We never auto-expire the doc — the cache logic is a query
// predicate, not a TTL index — because the emailed student-summary tokens
// (90-day link) must keep resolving to a real doc after the cache window
// has passed.

const PerStudentBodySchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    studentName: { type: String, default: "" },
    // Gemini's JSON response for this student. Mixed because the output
    // schema is prompt-driven (admin-editable) — we don't want a model
    // migration every time Francis tweaks the summary shape.
    body: { type: mongoose.Schema.Types.Mixed, default: null },
    generatedAt: { type: Date, default: Date.now },
    // Was the Gemini call for THIS student successful? Partial-success is
    // normal when one student's aggregate is empty or the API blips —
    // Promise.allSettled lets the overall request still return the
    // successful ones.
    status: {
      type: String,
      enum: ["ok", "failed", "skipped"],
      default: "ok",
    },
    failureReason: { type: String, default: "" },
  },
  { _id: false }
);

const SelectedItemsSchema = new mongoose.Schema(
  {
    // Lesson documents in scope. Classwork rows are discovered via the
    // Lesson.roomId + Lesson.name key the aggregator already knows how to
    // navigate.
    lessonIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lesson" }],
      default: [],
    },
    // References into Assignment.assignments[]._id. Not a separate collection,
    // so we store the sub-document ids directly — same shape the Assignment
    // controller already uses when it calls sub-task endpoints.
    assignmentTaskIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId }],
      default: [],
    },
    // Refs into Test.tests[]._id — same pattern as assignmentTaskIds.
    testTaskIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId }],
      default: [],
    },
  },
  { _id: false }
);

const SummaryReportSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["class", "student"],
      required: true,
      index: true,
    },

    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
      index: true,
    },

    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    dateRange: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
    },

    selectedItems: {
      type: SelectedItemsSchema,
      required: true,
      default: () => ({}),
    },

    // Instruction Language pulled from the most recent Lesson in the window
    // (per spec). Used by the Gemini prompt so the output matches the live
    // class language even when the admin prompt is in English.
    instructionLanguage: {
      type: String,
      default: "English",
    },

    // Audit + cache-invalidation key. Hash of StandardPrompt.classSummaryPrompt
    // or .studentSummaryPrompt (whichever this doc used) + the teacher's
    // reportPrompt. A mismatch at lookup time means "admin or teacher edited
    // the prompt since this doc was generated — regenerate rather than
    // return stale output".
    standardPromptHash: {
      type: String,
      default: "",
    },

    // Deterministic request-signature for cache lookup. Built from (kind,
    // classroomId, dateRange, selectedItems sorted, studentIds sorted for
    // student kind). Indexed because that's the hot cache lookup path.
    cacheKey: {
      type: String,
      required: true,
      index: true,
    },

    // Class-kind: the whole-class Gemini output. Null for student kind.
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Student-kind: one entry per selected student, in the order the teacher
    // picked them. Empty for class kind.
    perStudent: {
      type: [PerStudentBodySchema],
      default: [],
    },

    // Analytics / display: how many AI calls this report cost (1 for class,
    // N for student). Rolls up to the Admin dashboard without re-counting
    // AiCallLog rows.
    aiCallCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Cache-lookup index: a prior request with the same cacheKey + matching
// standardPromptHash within the TTL window returns this doc instead of
// regenerating. Non-unique because an admin prompt edit (hash change)
// produces a second row for the same key — we keep both so the old
// emailed token links still resolve.
SummaryReportSchema.index({ cacheKey: 1, createdAt: -1 });

// Dashboard list: "show me all summaries for this classroom in reverse
// chronological order" is the most common teacher query.
SummaryReportSchema.index({ classroomId: 1, kind: 1, createdAt: -1 });

export default mongoose.model("SummaryReport", SummaryReportSchema);
