import mongoose from "mongoose";

// Per-recipient access token for the public tokenized lesson-report viewer.
// Issued when a teacher clicks "Send Report" on the Session Report page;
// consumed by the public GET /api/report-link/view/:token endpoint (no auth)
// so students/parents can open the report via an emailed link.
//
// One row per dispatched link. If a teacher re-sends the same lesson to the
// same student, a NEW row is created (old tokens keep working until they
// expire naturally — avoids breaking an already-opened email thread).
const ReportAccessTokenSchema = new mongoose.Schema(
  {
    // 64-char hex from crypto.randomBytes(32) — ~256 bits of entropy.
    // Unique index so collisions on the random draw get surfaced as a
    // retryable error (functionally never hits).
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Discriminator: "lesson" = Task 2 tokenized lesson report viewer;
    // "studentSummary" = Task 3 per-student date-range summary.
    // Default preserves backwards-compat for rows written before Task 3.
    kind: {
      type: String,
      enum: ["lesson", "studentSummary"],
      default: "lesson",
      index: true,
    },

    // Which lesson this link scopes to (Task 2 — only populated when
    // kind === "lesson"). Required-via-validate below rather than
    // schema-level required:true so summary-kind rows can leave it unset.
    lessonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lesson",
      index: true,
    },

    // Denormalised for lesson-kind lookups: the classwork collection is
    // indexed on roomId, so caching it here avoids an extra Lesson lookup
    // on every view. Not set for summary-kind rows.
    roomId: {
      type: String,
    },

    // Task 3 — only populated when kind === "studentSummary". Points at
    // the SummaryReport doc; the view handler looks up the perStudent[]
    // entry matching this row's studentId to render just that student's
    // section (never sibling students).
    summaryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SummaryReport",
      index: true,
    },

    // Which student's report this token exposes. Combined with roomId +
    // lessonId this is the access-control key — the viewer sees only this
    // student's attempts on this lesson, nothing else.
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Audit: which teacher sent this link.
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // 'student' | 'parent' — tracked per token so analytics can distinguish
    // "did the parent open the report" vs "did the student". When the teacher
    // chooses "both" we generate TWO rows (one each), not one shared link.
    recipientRole: {
      type: String,
      enum: ["student", "parent"],
      required: true,
    },

    // Actual email address the link was dispatched to. Kept for support
    // cases ("my parent didn't receive the email") without needing to
    // re-derive from Student/Parent docs.
    sentToEmail: {
      type: String,
      required: true,
    },

    // Exactly 90 days from creation (Task 2 spec). Mongo TTL index below
    // auto-purges rows ~24h after expiresAt so the collection doesn't grow
    // unbounded; the view endpoint also enforces expiry at request time.
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },

    // Analytics: incremented on every successful view request.
    viewCount: {
      type: Number,
      default: 0,
    },

    lastAccessedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// TTL index: Mongo deletes expired rows automatically ~once a minute after
// expiresAt passes. The view endpoint also checks expiresAt at request time
// so there's no gap between "token should be dead" and "token actually gone".
ReportAccessTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Lookup index for "re-list all active links for a student" (future admin UX).
ReportAccessTokenSchema.index({ studentId: 1, lessonId: 1, expiresAt: 1 });

const ReportAccessToken = mongoose.model(
  "ReportAccessToken",
  ReportAccessTokenSchema
);

export default ReportAccessToken;
