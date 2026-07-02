import mongoose from 'mongoose';

// Sub-shape mirrors the Gemini response schema from the admin's
// StandardPrompt. Keep the field names in lockstep with the prompt so
// nothing gets silently dropped on save.
const AdvancedChallengeSchema = new mongoose.Schema(
  {
    congratulations: { type: String, default: '' },
    question: { type: String, default: '' },
  },
  { _id: false }
);

// Each interaction carries its own `_id` — the "interaction_id" the
// trainingHistory entries pair back to. part1/part2/part3 are stored as
// string arrays exactly as the prompt schema declares them.
const InteractionSchema = new mongoose.Schema({
  questionText: { type: String, default: '' },
  studentAnswer: { type: mongoose.Schema.Types.Mixed },
  hintStream: { type: String, default: '' },
  part1: { type: [String], default: [] },
  part2: { type: [String], default: [] },
  part3: { type: [String], default: [] },
  advancedChallenge: { type: AdvancedChallengeSchema, default: () => ({}) },
  correct: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
});

// Running history of part3 advice strings, paired with the interaction they
// came from. Kept as a flat array of strings alongside the interactionId so
// reports can show all diagnostic-training suggestions in one place.
const TrainingHistoryEntrySchema = new mongoose.Schema(
  {
    interactionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    part3: { type: [String], default: [] },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ClassworkAiReportSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true },
    questionId: { type: String, required: true, index: true },
    studentId: { type: String, required: true, index: true },
    studentName: { type: String, default: '' },
    originalQuestion: { type: String, default: '' },
    interactions: { type: [InteractionSchema], default: [] },
    lastAnswer: { type: mongoose.Schema.Types.Mixed },
    // Latest student-facing hint (the streamed string from the most recent
    // interaction). Used by the report renderer to show the most recent
    // guidance without scanning interactions[].
    lastHintStream: { type: String, default: '' },
    // Diagnostic-training history paired with the interaction it belongs to.
    trainingHistory: { type: [TrainingHistoryEntrySchema], default: [] },
    // Audit-only: hash of the StandardPrompt aiHintPrompt that was sent to
    // Gemini on the most recent call for this (room, question, student).
    // Not read by application code — the full standard prompt is sent on
    // every call and Gemini's implicit cache handles cost amortisation.
    standardPromptHash: { type: String, default: '' },
  },
  { timestamps: true }
);

ClassworkAiReportSchema.index(
  { roomId: 1, questionId: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.model('ClassworkAiReport', ClassworkAiReportSchema);
