import mongoose from "mongoose";

// Monthly aggregate of Gemini token usage, keyed by (monthKey, sessionId).
// One document per session per calendar month (UTC). Rows with sessionId=null
// hold usage from calls that weren't scoped to a session (kept for
// completeness — a "sessionless" bucket per month).
//
// Callers use aiTokenUsage.recordAiTokenUsage() to $inc the counters after
// each Gemini call, so writes stay atomic under concurrent classwork
// submissions.
const AiTokenUsageSchema = new mongoose.Schema(
  {
    monthKey: {
      type: String,
      required: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      default: null,
      index: true,
    },
    promptTokenCount: { type: Number, default: 0 },
    candidatesTokenCount: { type: Number, default: 0 },
    cachedContentTokenCount: { type: Number, default: 0 },
    totalThoughtTokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One row per (month, session). Nulls collide in a regular unique index, so
// keep it sparse — the sessionless-bucket row can still be a singleton per
// month because we always pass monthKey.
AiTokenUsageSchema.index({ monthKey: 1, sessionId: 1 }, { unique: true });

const AiTokenUsage = mongoose.model("AiTokenUsage", AiTokenUsageSchema);

export default AiTokenUsage;
