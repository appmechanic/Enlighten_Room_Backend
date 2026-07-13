import mongoose from 'mongoose';
import {
  AdvancedChallengeSchema,
  TrainingHistoryEntrySchema,
} from './aiReportSchemas.js';

// Each interaction carries its own `_id` — the "interaction_id" the
// trainingHistory entries pair back to.
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

const AssignmentAiReportSchema = new mongoose.Schema(
  {
    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true,
      index: true,
    },
    subAssignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Question',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    studentName: { type: String, default: '' },
    originalQuestion: { type: String, default: '' },
    interactions: { type: [InteractionSchema], default: [] },
    lastAnswer: { type: mongoose.Schema.Types.Mixed },
    lastHintStream: { type: String, default: '' },
    trainingHistory: { type: [TrainingHistoryEntrySchema], default: [] },
    // Question stays active until AI marks the answer correct OR the
    // student burns through Question.maxAiHints. Both conditions are
    // per-student — the compound unique index below keys the doc that way.
    active: { type: Boolean, default: true },
    inactiveReason: {
      type: String,
      enum: ['hint-limit', 'correct', null],
      default: null,
    },
    // Audit-only, same semantics as ClassworkAiReport.standardPromptHash.
    standardPromptHash: { type: String, default: '' },
  },
  { timestamps: true }
);

AssignmentAiReportSchema.index(
  { subAssignmentId: 1, questionId: 1, studentId: 1 },
  { unique: true }
);

export default mongoose.model('AssignmentAiReport', AssignmentAiReportSchema);
