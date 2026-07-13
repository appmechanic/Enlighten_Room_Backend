import mongoose from 'mongoose';

const SubmittedSchema = new mongoose.Schema({
  studentId: String,
  studentName: String,
  answer: mongoose.Schema.Types.Mixed,
  isCorrect: { type: Boolean, default: false },
  aiScore: { type: Number, default: 0 },
  aiUsed: { type: String, default: '0x' },
  feedback: { type: String, default: '' },
  preSubmitAnswers: { type: [mongoose.Schema.Types.Mixed], default: [] },
  aiHintsUsed: { type: [String], default: [] },
  submittedAt: { type: Date, default: Date.now },
});

const CachedCommonMistakeSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    studentId: { type: String, default: "" },
    studentName: { type: String, default: "" },
    studentAnswer: { type: String, default: "" },
    feedback: { type: String, default: "" },
    answerLatex: { type: String, default: "" },
    interactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AiFeedbackCacheSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    threshold: { type: Number, default: 0 },
    cachedAt: { type: Date, default: null },
    promptSnapshot: { type: String, default: "" },
    questionSnapshot: { type: String, default: "" },
    teacherPromptSnapshot: { type: String, default: "" },
    standardSolution: { type: String, default: "" },
    commonMistakes: { type: [CachedCommonMistakeSchema], default: [] },
  },
  { _id: false }
);

const ClassworkSchema = new mongoose.Schema({
  id: { type: String, required: true },
  roomId: { type: String, required: true },
  lessonName: { type: String, default: '' },
  label: { type: String, required: true },
  title: { type: String, required: true },
  question: { type: String, required: true },
  format: { type: String, required: true },
  formatLabel: { type: String },
  options: { type: [String], default: [] },
  blanks: { type: [String], default: [] },
  maxLength: { type: Number },
  correctAnswer: { type: mongoose.Schema.Types.Mixed },
  image: { type: String }, // URL of the question image (optional)
  expiryTime: { type: Number, default: 30 },
  aiAllowed: { type: Boolean, default: true },
  aiExpiryTime: { type: Number, default: 30 },
  maxOutputTokens: { type: Number },
  createdAt: { type: Date, default: Date.now },
  released: { type: Boolean, default: true },
  releasedAt: { type: Date, default: null },
  submitted: { type: [SubmittedSchema], default: [] },
  standardSolution: { type: String, default: "" },
  solutionCapturedAt: { type: Date, default: null },
  commonMistakeBank: { type: [CachedCommonMistakeSchema], default: [] },
  aiFeedbackCache: { type: AiFeedbackCacheSchema, default: () => ({}) },
});

export default mongoose.model('Classwork', ClassworkSchema);
