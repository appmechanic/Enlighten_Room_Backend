// models/GradedAnswer.js
import mongoose from "mongoose";

const SingleGradedQuestionSchema = new mongoose.Schema({
  questionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Question",
    required: true,
  },
  submittedAnswer: {
    type: [String],
    required: true,
  },
  correctAnswer: {
    type: [String],
    default: [],
  },
  // isCorrect: {
  //   type: Boolean,
  //   required: true,
  // },
  score: {
    type: Number,
    default: 0,
  },
  maxScore: {
    type: Number,
  },
  feedback: {
    type: String,
    default: "",
  },
});

const GradedAnswerSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // or "Student" depending on your project
      required: true,
    },
    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      required: true,
    },
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
    },
    gradedBy: {
      type: String,
      enum: ["AI", "teacher"],
      default: "AI",
    },
    gradedAt: {
      type: Date,
      default: Date.now,
    },
    totalQuestions: {
      type: Number,
    },
    correctCount: {
      type: Number,
    },
    incorrectCount: {
      type: Number,
    },
    // gradePoint: {
    //   type: Number,
    // },
    percentage: {
      type: String,
    },
    grade: {
      type: String,
    },
    isAutoSubmitted: {
      type: Boolean,
      default: false,
    },
    overall_remarks: {
      type: String,
      default: "",
    },
    gradedAnswers: [SingleGradedQuestionSchema],
  },
  { timestamps: true }
);

export default mongoose.model("GradedAnswer", GradedAnswerSchema);
