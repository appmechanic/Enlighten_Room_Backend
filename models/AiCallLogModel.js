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

    // Question / answer content (truncated in recordAiCallLog).
    questionText: { type: String, default: "" },
    studentAnswer: { type: String, default: "" },
    aiResponseSummary: { type: String, default: "" },

    // Full user prompt actually sent to Gemini (question, cached context,
    // runtime compute/skip directives). Captured so the admin panel can
    // see the exact bytes on the wire.
    userPromptText: { type: String, default: "" },

    // Full standard + teacher prompt content sent as systemInstruction.
    // Field name kept as "Snippet" for schema compatibility with earlier
    // rows; documents may now hold up to CALL_LOG_PROMPT_MAX chars.
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
