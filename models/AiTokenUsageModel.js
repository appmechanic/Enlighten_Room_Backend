import mongoose from "mongoose";

// Monthly aggregate of Gemini token usage. One document per calendar month
// (UTC), keyed on "YYYY-MM". Callers use aiTokenUsage.recordAiTokenUsage() to
// $inc the counters after each Gemini call, so writes stay atomic under
// concurrent classwork submissions.
const AiTokenUsageSchema = new mongoose.Schema(
  {
    monthKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    promptTokenCount: { type: Number, default: 0 },
    candidatesTokenCount: { type: Number, default: 0 },
    cachedContentTokenCount: { type: Number, default: 0 },
    totalThoughtTokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const AiTokenUsage = mongoose.model("AiTokenUsage", AiTokenUsageSchema);

export default AiTokenUsage;
