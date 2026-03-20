import mongoose from 'mongoose';

const SubmittedSchema = new mongoose.Schema({
  studentId: String,
  studentName: String,
  answer: mongoose.Schema.Types.Mixed,
  isCorrect: { type: Boolean, default: false },
  aiScore: { type: Number, default: 0 },
  aiUsed: { type: String, default: '0x' },
  feedback: { type: String, default: '' },
});

const ClassworkSchema = new mongoose.Schema({
  id: { type: String, required: true },
  roomId: { type: String, required: true },
  label: { type: String, required: true },
  title: { type: String, required: true },
  question: { type: String, required: true },
  format: { type: String, required: true },
  formatLabel: { type: String },
  options: { type: [String], default: [] },
  blanks: { type: [String], default: [] },
  maxLength: { type: Number },
  correctAnswer: { type: mongoose.Schema.Types.Mixed },
  expiryTime: { type: Number, default: 30 },
  createdAt: { type: Date, default: Date.now },
  submitted: { type: [SubmittedSchema], default: [] },
});

export default mongoose.model('Classwork', ClassworkSchema);
