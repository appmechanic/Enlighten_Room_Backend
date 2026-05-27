import mongoose from 'mongoose';

// Each interaction now carries its own `_id` (the "interaction_id" referenced
// by the report spec). Removing `{ _id: false }` lets Mongoose assign a stable
// ObjectId per push so the frontend can address a specific exchange (e.g. to
// pair an `allPart3` entry with the interaction it came from).
const InteractionSchema = new mongoose.Schema({
  questionText: { type: String, default: '' },
  studentAnswer: { type: mongoose.Schema.Types.Mixed },
  aiPart1: { type: String, default: '' },
  aiPart2: { type: String, default: '' },
  aiPart3: { type: String, default: '' },
  correct: { type: Boolean, default: false },
  newQuestion: { type: String, default: '' },
  timestamp: { type: Date, default: Date.now },
});

// `allPart3` stores the running history of part-3 strings tied to a specific
// interaction so we can reconstruct the report without scanning `interactions`.
const Part3EntrySchema = new mongoose.Schema(
  {
    interactionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    text: { type: String, default: '' },
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
    lastPart2: { type: String, default: '' },
    // Part-3 history paired with the interaction it belongs to.
    allPart3: { type: [Part3EntrySchema], default: [] },
  },
  { timestamps: true }
);

ClassworkAiReportSchema.index(
  { roomId: 1, questionId: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.model('ClassworkAiReport', ClassworkAiReportSchema);
