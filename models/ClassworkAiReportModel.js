import mongoose from 'mongoose';

// Sub-shapes mirror the Gemini response schema in
// `utils/geminiClassworkFeedback.js` so the controller can persist the parsed
// feedback object directly without flattening.
const StudentCanDoSchema = new mongoose.Schema(
  {
    subjectTrack: { type: String, enum: ['STEM', 'HUMANITIES_LANGUAGES'], default: 'STEM' },
    message: { type: String, default: '' },
  },
  { _id: false }
);

const NextStepExplanationSchema = new mongoose.Schema(
  {
    gradeBand: {
      type: String,
      enum: ['G3_OR_LOWER', 'G4_TO_G8', 'G9_PLUS'],
      default: 'G4_TO_G8',
    },
    text: { type: String, default: '' },
  },
  { _id: false }
);

const NextStepSchema = new mongoose.Schema(
  {
    dont: { type: String, default: '' },
    what: { type: String, default: '' },
    how: { type: String, default: '' },
    explanation: { type: NextStepExplanationSchema, default: () => ({}) },
  },
  { _id: false }
);

const DiagnosticTrainingSchema = new mongoose.Schema(
  {
    underlyingGap: { type: String, default: '' },
    todaysDifficulty: { type: String, default: '' },
  },
  { _id: false }
);

const PositiveContextSchema = new mongoose.Schema(
  {
    theme: { type: String, default: '' },
    message: { type: String, default: '' },
  },
  { _id: false }
);

const AdvancedChallengeSchema = new mongoose.Schema(
  {
    congratulations: { type: String, default: '' },
    question: { type: String, default: '' },
    useImage: { type: Boolean, default: false },
    positiveContext: { type: PositiveContextSchema, default: () => ({}) },
  },
  { _id: false }
);

// Each interaction carries its own `_id` (the "interaction_id" referenced by
// the report spec). The training-history entries pair back to a specific
// interaction via interactionId.
const InteractionSchema = new mongoose.Schema({
  questionText: { type: String, default: '' },
  studentAnswer: { type: mongoose.Schema.Types.Mixed },
  hintStream: { type: String, default: '' },
  studentCanDo: { type: StudentCanDoSchema, default: () => ({}) },
  nextStep: { type: NextStepSchema, default: () => ({}) },
  diagnosticTraining: { type: DiagnosticTrainingSchema, default: () => ({}) },
  advancedChallenge: { type: AdvancedChallengeSchema, default: () => ({}) },
  correct: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
});

// Running history of diagnostic-training advice, paired with the interaction
// it came from, so the report can show both trainings per interaction.
const TrainingHistoryEntrySchema = new mongoose.Schema(
  {
    interactionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    underlyingGap: { type: String, default: '' },
    todaysDifficulty: { type: String, default: '' },
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
    // Hash of the StandardPrompt aiHintPrompt last sent to Gemini for this
    // (room, question, student) exchange. Subsequent AI calls compare this to
    // the current hash: match → send a short reminder; mismatch (or empty) →
    // send the full standard prompt again and update this field. Admin edits
    // to the standard prompt change its content and therefore its hash, which
    // automatically forces every report to resend the full prompt on its next
    // call — no separate invalidation pass needed.
    standardPromptHash: { type: String, default: '' },
  },
  { timestamps: true }
);

ClassworkAiReportSchema.index(
  { roomId: 1, questionId: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.model('ClassworkAiReport', ClassworkAiReportSchema);
