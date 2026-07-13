import mongoose from 'mongoose';

// Sub-shape mirrors the Gemini response schema from the admin's
// StandardPrompt.aiHintPrompt. Shared by ClassworkAiReport and
// AssignmentAiReport so both flows persist the same shape.
export const AdvancedChallengeSchema = new mongoose.Schema(
  {
    congratulations: { type: String, default: '' },
    question: { type: String, default: '' },
  },
  { _id: false }
);

// Running history of part3 advice strings, paired with the interaction they
// came from. Kept as a flat array of strings alongside the interactionId so
// reports can show all diagnostic-training suggestions in one place.
export const TrainingHistoryEntrySchema = new mongoose.Schema(
  {
    interactionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    part3: { type: [String], default: [] },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);
