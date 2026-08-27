// Persisted grade record for a student's attempt at one Test task.
// Mirrors GradedAnswerModel — same fields, different foreign keys — so the
// student panel and details page can render "score card + per-question
// breakdown" the same way they do for Assignments. Test submissions used to
// live only inside TestModel.tests[].submissions[] as a rolled-up marks
// number + human-readable feedback log, which was fine for the class report
// but couldn't be indexed or joined per student.
import mongoose from "mongoose";

const SingleGradedTestQuestionSchema = new mongoose.Schema({
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
  isCorrect: {
    type: Boolean,
  },
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

const GradedTestAnswerSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    testId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Test",
      required: true,
    },
    // Analogous to subAssignmentId — the specific task inside Test.tests[].
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
    },
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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
    totalQuestions: { type: Number },
    correctCount: { type: Number },
    incorrectCount: { type: Number },
    percentage: { type: String },
    grade: { type: String },
    isAutoSubmitted: {
      type: Boolean,
      default: false,
    },
    overall_remarks: {
      type: String,
      default: "",
    },
    gradedAnswers: [SingleGradedTestQuestionSchema],
  },
  { timestamps: true }
);

GradedTestAnswerSchema.index({ studentId: 1, taskId: 1 }, { unique: true });

export default mongoose.model("GradedTestAnswer", GradedTestAnswerSchema);
