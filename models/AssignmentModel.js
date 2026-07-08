import mongoose from "mongoose";

const SubmissionSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  autoSubmitted: {
    type: Boolean,
    default: false,
  },
  isCompleted: {
    type: Boolean,
    default: false,
  },
  questions: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Question",
    },
  ],
  marks: {
    type: Number,
    default: 0,
  },
  feedback: {
    type: String,
    default: "",
  },
});

const AssignmentTaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  assignmentStatus: {
    type: String,
    default: "Pending",
  },
  // Becomes available to students at this time. Defaults to createdAt for
  // legacy rows where the field was never set.
  startDate: {
    type: Date,
    default: Date.now,
  },
  // Submission deadline. The Create Assignment flow exposes this as
  // "expired date time"; older code calls it dueDate so we keep the name.
  dueDate: {
    type: Date,
    required: true,
  },
  duration: {
    type: Number, // duration in minutes (optional if you’re using `StudentAssignmentStatus`)
    default: 30,
  },
  resources: {
    type: [String],
    default: [],
  },
  maxMarks: {
    type: Number,
    required: true,
  },
  // Per-format question counts (range 3-30) and image-generation flags chosen
  // in the Create Assignment panel. Keys map 1:1 to the 4 classwork formats.
  // Counts default to 0 so an unselected format produces zero questions.
  perFormatCounts: {
    mcq: { type: Number, default: 0, min: 0, max: 30 },
    "fill-blanks": { type: Number, default: 0, min: 0, max: 30 },
    handwriting: { type: Number, default: 0, min: 0, max: 30 },
    textbox: { type: Number, default: 0, min: 0, max: 30 },
  },
  perFormatImages: {
    mcq: { type: Boolean, default: false },
    "fill-blanks": { type: Boolean, default: false },
    handwriting: { type: Boolean, default: false },
    textbox: { type: Boolean, default: false },
  },
  // Cap on how many AI hints a student can use per question in this
  // assignment. Picker shows 0-5; 0 means "no AI hints allowed".
  maxAiHints: {
    type: Number,
    default: 0,
    min: 0,
    max: 10,
  },
  // Snapshot of the prompts used at generation time — keeps the audit trail
  // intact even if the teacher edits their assignmentPrompt later.
  generation: {
    standardPrompt: { type: String, default: "" },
    teacherPrompt: { type: String, default: "" },
    sessionLessonName: { type: String, default: "" },
    model: { type: String, default: "" },
    imageModel: { type: String, default: "" },
    generatedAt: { type: Date },
  },
  // filePath: {
  //   type: String,
  // },
  // originalFileName: {
  //   type: String,
  // },
  studentIds: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  questions: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Question",
    },
  ],
  // submissions: [SubmissionSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const AssignmentSchema = new mongoose.Schema(
  {
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignments: {
      type: [AssignmentTaskSchema],
      required: true,
      validate: [
        (arr) => arr.length > 0,
        "At least one assignment is required",
      ],
    },
    // 🔔 reminder flags
    reminders: {
      // used by send24hHomeworkReminders()
      homework24hSent: {
        type: Boolean,
        default: false,
      },
    },
  },
  { timestamps: true }
);

const Assignment = mongoose.model("Assignment", AssignmentSchema);
export default Assignment;
