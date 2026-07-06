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
});

export default mongoose.model('Classwork', ClassworkSchema);
