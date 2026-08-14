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
    // Set by createTestWithAI so the Test-by-question lookup mirrors the
    // Assignment-by-question one. Empty on legacy / classwork questions.
    testId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Test",
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
    // Step-by-step worked solution emitted by the AI at generation time. Shown
    // to the teacher on the Test page as the "suggested answer" they can edit
    // before the start date; also usable as reference when hint-grading.
    solution: { type: String, default: "" },
    // When the parent assignment is in "individual" mode, this is the student
    // this question was personalised for. Empty on general (class-wide) or
    // legacy questions — those apply to every student in the classroom.
    belongsToStudentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Per-question image URL (DO Spaces) when image generation is on.
    image: { type: String, default: "" },
    // Cap on AI hints copied from the parent assignment task. Enforced by the
    // student answer endpoint, surfaced in the student UI.
    maxAiHints: { type: Number, default: 0, min: 0, max: 10 },
    // Cooldown (in seconds) between successive AI hint requests on this
    // question. Copied from the parent task; drives the student-side
    // countdown that re-enables the "Get hints" button when it hits zero.
    aiHintCooldownSeconds: { type: Number, default: 0, min: 0, max: 3600 },
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
