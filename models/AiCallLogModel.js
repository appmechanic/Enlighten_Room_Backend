import mongoose from "mongoose";

// Per-call audit log for every Gemini call the backend makes. Complements
// the aggregated AiTokenUsage (monthly rollup): this collection records the
// full context of each individual call so the admin panel can show the
// student's question, the student's answer, and the AI response side-by-side
// with the token counts. Meant for dev-stage visibility — trim retention
// before scaling.
//
// Long strings (question / answer / response / prompts) are truncated at
// write time in recordAiCallLog to keep individual documents small.
const AiCallLogSchema = new mongoose.Schema(
  {
    reqId: { type: String, index: true },
    tag: { type: String, required: true, index: true },
    model: { type: String, default: "" },

    // Context — nullable because assignment-generation / image-gen calls
    // have no session or student attached.
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      default: null,
      index: true,
    },
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      default: null,
      index: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    studentName: { type: String, default: "" },

    // Question / answer content (truncated).
    questionText: { type: String, default: "" },
    studentAnswer: { type: String, default: "" },
    aiResponseSummary: { type: String, default: "" },

    // First N chars of each prompt for a quick eyeball; the full text is
    // still in the console logs by reqId.
    standardPromptSnippet: { type: String, default: "" },
    teacherPromptSnippet: { type: String, default: "" },
    standardPromptHash: { type: String, default: "" },

    // Per-call token counts as reported by Gemini's usageMetadata.
    promptTokenCount: { type: Number, default: 0 },
    candidatesTokenCount: { type: Number, default: 0 },
    cachedContentTokenCount: { type: Number, default: 0 },
    totalThoughtTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    // Populated when the call errored so admin can see failures too.
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

// Recent-first listing is the common query — index on createdAt.
AiCallLogSchema.index({ createdAt: -1 });

const AiCallLog = mongoose.model("AiCallLog", AiCallLogSchema);

export default AiCallLog;
