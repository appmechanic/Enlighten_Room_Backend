import mongoose from "mongoose";

// Per-student record of a single fullscreen exit while taking the test.
// Written by the FrontEnd video app when the browser leaves fullscreen and
// rolled into the individual test report so the teacher can see integrity
// events at a glance.
const FullscreenExitSchema = new mongoose.Schema(
  {
    exitedAt: { type: Date, required: true },
    // Optional — the video app can set this when it detects the student
    // returned to fullscreen. Missing means "did not return before submit".
    returnedAt: { type: Date },
  },
  { _id: false },
);

const TestSubmissionSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  isCompleted: {
    type: Boolean,
    default: false,
  },
  // Set the first time `isCompleted` transitions true, so we can dedupe
  // completion emails and report on when the attempt actually finished
  // vs. when it was first started.
  completedAt: {
    type: Date,
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
  fullscreenExits: {
    type: [FullscreenExitSchema],
    default: [],
  },
  // Set the first time this submission crosses FULLSCREEN_EXIT_ALERT_THRESHOLD
  // and a parent email is dispatched. Presence prevents re-sending the
  // alert on every subsequent exit for the same submission.
  parentAlertSentAt: {
    type: Date,
  },
});

const TestTaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  testStatus: {
    type: String,
    default: "Pending",
  },
  // Becomes available to students at this time.
  startDate: {
    type: Date,
    default: Date.now,
  },
  // Test expiry. Students can no longer submit after this timestamp;
  // the class general report is generated automatically at this point.
  expiredDate: {
    type: Date,
    required: true,
  },
  // Session evidence window. The Create Test panel exposes this as two
  // datetime pickers. Backend uses it to find every session of this
  // classroom in the window and pull its reports/classwork feedback as
  // attachments for the generation call.
  sessionRange: {
    start: { type: Date },
    end: { type: Date },
  },
  duration: {
    type: Number, // minutes; optional
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
  // Per-format question counts (range 3-30) and image-generation flags
  // picked in the Create Test panel. Keys map 1:1 to the 4 classwork
  // formats. Counts default to 0 so an unselected format produces zero
  // questions.
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
  // Snapshot of the prompts used at generation time — keeps the audit
  // trail intact even if the teacher edits their testPrompt later.
  generation: {
    standardPrompt: { type: String, default: "" },
    teacherPrompt: { type: String, default: "" },
    sessionLessonName: { type: String, default: "" },
    model: { type: String, default: "" },
    imageModel: { type: String, default: "" },
    generatedAt: { type: Date },
    cachedContentName: { type: String, default: "" },
    cachedContentTokenCount: { type: Number, default: 0 },
  },
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
  submissions: [TestSubmissionSchema],
  // Auto-generated class general report body once the test expires. Empty
  // until the expiry cron fires. Kept as Mixed so the report shape can
  // evolve without a schema migration.
  classReport: {
    generatedAt: { type: Date },
    body: { type: mongoose.Schema.Types.Mixed },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const TestSchema = new mongoose.Schema(
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
    tests: {
      type: [TestTaskSchema],
      required: true,
      validate: [(arr) => arr.length > 0, "At least one test is required"],
    },
  },
  { timestamps: true },
);

const Test = mongoose.model("Test", TestSchema);
export default Test;
