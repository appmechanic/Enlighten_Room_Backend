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
    // "input" is the legacy bucket for descriptive answers. New assignments
    // emit one of the 4 classwork formats so the student form can render the
    // matching widget (radio / blanks / canvas / textarea).
    type: {
      type: String,
      enum: ["mcq", "input", "fill-blanks", "handwriting", "textbox"],
      default: "input",
    },
    options: [String], // for MCQs
    // Per-blank answers for fill-blanks (one string per blank).
    blanks: { type: [String], default: [] },
    correctAnswer: [{ type: String }],
    // Per-question image URL (DO Spaces) when image generation is on.
    image: { type: String, default: "" },
    // Cap on AI hints copied from the parent assignment task. Enforced by the
    // student answer endpoint, surfaced in the student UI.
    maxAiHints: { type: Number, default: 0, min: 0, max: 10 },
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
