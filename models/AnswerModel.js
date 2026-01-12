import mongoose from "mongoose";

const studentAnswerSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "student",
      required: true,
    },
    questionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Question",
      required: true,
    },
    submittedAnswer: [{ type: String, required: true }],
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    status: {
      type: String,
      enum: ["submitted", "pending", "withdrawn"],
      default: "submitted",
    },
    attempt: { type: Number, default: 1 }, // For multi-attempt tracking
  },
  { timestamps: true }
);

const StudentAnswer = mongoose.model("StudentAnswer", studentAnswerSchema);
export default StudentAnswer;
