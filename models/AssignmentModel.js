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
  // Cooldown (in seconds) enforced on the student side between successive AI
  // hint requests on the same question. 0 = no cooldown, i.e. back-to-back
  // requests are allowed until maxAiHints is exhausted.
  aiHintCooldownSeconds: {
    type: Number,
    default: 0,
    min: 0,
    max: 3600,
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
    // Gemini explicit-cache handle name (e.g. "cachedContents/…") that was
    // reused across per-student calls in individual mode. Kept for audit /
    // billing debugging; not used at runtime.
    cachedContentName: { type: String, default: "" },
    // Sum of `cachedContentTokenCount` reported by the fan-out calls.
    cachedContentTokenCount: { type: Number, default: 0 },
  },
  // "general" (default) = one question set shared by every student in the
  // classroom (the historic behaviour). "individual" = per-student personalised
  // sets driven by each student's own classwork interactions/reports.
  assignmentMode: {
    type: String,
    enum: ["general", "individual"],
    default: "general",
  },
  // For individual mode, the per-student split of `questions[]`. Each entry
  // lists the question IDs that belong to one student; on read, the student
  // endpoint filters `questions[]` down to their own subset. Empty on general.
  perStudentQuestions: {
    type: [
      new mongoose.Schema(
        {
          studentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
          },
          questionIds: [
            { type: mongoose.Schema.Types.ObjectId, ref: "Question" },
          ],
        },
        { _id: false },
      ),
    ],
    default: [],
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
  // AI class-general report generated once the sub-assignment expires.
  // Same shape as Lesson.classReport / the classwork Class Report — filled
  // by ensureAssignmentClassReport (idempotent on body existence). Never
  // updated after first successful generation unless an admin deletes it.
  classReport: {
    studentDifficulties: {
      type: [
        new mongoose.Schema(
          {
            difficulty: { type: String, default: "" },
            affectedStudents: { type: [String], default: [] },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    nextLessonStrategy: {
      type: [
        new mongoose.Schema(
          {
            difficulty: { type: String, default: "" },
            teachingStrategy: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    targetedHomework: {
      type: [
        new mongoose.Schema(
          {
            kindsOfTraining: { type: String, default: "" },
            link: { type: String, default: "" },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    generatedAt: { type: Date },
    model: { type: String, default: "" },
  },
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
