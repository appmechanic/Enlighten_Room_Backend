import mongoose from "mongoose";

const questionSchema = new mongoose.Schema(
  {
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      // required: true,
    },
    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
    },
    course: { type: String, required: true },
    topic: { type: String, required: true },
    questionText: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    type: { type: String, enum: ["mcq", "input"], default: "input" },
    options: [String], // for MCQs
    correctAnswer: [{ type: String }],
    hints: [{ type: String }],
    answer: [{ type: String }],
    metadata: {
      difficulty: { type: String, enum: ["easy", "medium", "hard"] },
      marks: { type: Number },
      tags: [{ type: String }],
      createdBy: { type: String },
    },
    fineTuningInstructions: String,
    language: { type: String, default: "English" },
    // ✅ NEW: References to answers
    studentAnswers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "StudentAnswer",
      },
    ],
    gradedAnswers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "GradedAnswer",
      },
    ],
  },
  { timestamps: true }
);

const Question = mongoose.model("Question", questionSchema);
export default Question;
