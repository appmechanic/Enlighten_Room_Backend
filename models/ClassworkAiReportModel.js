import mongoose from 'mongoose';

const InteractionSchema = new mongoose.Schema(
  {
    questionText: { type: String, default: '' },
    studentAnswer: { type: mongoose.Schema.Types.Mixed },
    aiPart1: { type: String, default: '' },
    aiPart2: { type: String, default: '' },
    aiPart3: { type: String, default: '' },
    correct: { type: Boolean, default: false },
    newQuestion: { type: String, default: '' },
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
    allPart3: { type: [String], default: [] },
  },
  { timestamps: true }
);

ClassworkAiReportSchema.index(
  { roomId: 1, questionId: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.model('ClassworkAiReport', ClassworkAiReportSchema);
