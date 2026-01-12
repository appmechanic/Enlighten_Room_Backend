import mongoose from "mongoose";

const gradedSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },
    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
    },
    assignmentTaskId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    totalScore: {
      type: Number,
      required: true,
    },
    maxScore: {
      type: Number,
      required: true,
    },
    graded: [
      {
        questionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Question",
          required: true,
        },
        questionText: {
          type: String,
          required: true,
        },
        answer: {
          type: String,
          required: true,
        },
        score: {
          type: Number,
          required: true,
          min: 0,
        },
        feedback: {
          type: String,
          required: true,
        },
      },
    ],
    gradedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const GradedSubmission = mongoose.model("GradedSubmission", gradedSchema);
export default GradedSubmission;
