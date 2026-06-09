import mongoose from "mongoose";

// One row of the AI class report's friction-point breakdown.
// _id is disabled via schema options — it can't be done inside the inline
// object literal because Mongoose treats `_id: false` there as a path
// declaration of type Boolean, which conflicts with the auto-generated
// ObjectId and silently breaks saves.
const StudentBreakdownSchema = new mongoose.Schema(
  {
    frictionPoint: { type: String, default: "" },
    affectedStudents: { type: [String], default: [] },
  },
  { _id: false }
);

const TargetedHomeworkFocusSchema = new mongoose.Schema(
  {
    focusSkill: { type: String, default: "" },
    pedagogicalReason: { type: String, default: "" },
  },
  { _id: false }
);

// A Lesson is a single occurrence of a Session. Only one Lesson per
// roomId can be `active` at a time; `endedAt` is stamped when the
// teacher ends the call (or leaves), and the row is preserved for
// reporting after that.
const LessonSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    roomId: { type: String, required: true, index: true },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      default: null,
    },
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      default: null,
    },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["active", "ended"],
      default: "active",
      index: true,
    },
    // Lesson-level AI summary generated when the teacher ends the lesson.
    // Stored separately from per-student ClassworkAiReport docs — this is
    // the "Class Report" the teacher sees by default in the View Report UI.
    classReport: {
      studentBreakdown: { type: [StudentBreakdownSchema], default: [] },
      nextLessonPivot: { type: [String], default: [] },
      targetedHomeworkFocus: {
        type: TargetedHomeworkFocusSchema,
        default: () => ({}),
      },
      generatedAt: { type: Date, default: null },
      model: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

LessonSchema.index({ roomId: 1, status: 1 });
LessonSchema.index({ classroomId: 1, startedAt: -1 });

export default mongoose.model("Lesson", LessonSchema);
