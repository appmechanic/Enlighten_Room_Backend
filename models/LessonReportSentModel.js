import mongoose from "mongoose";

// One row per (teacherId, lessonId) — enforces the "1 report = 1 lesson" rule
// so that a teacher who sends the classwork CSV email AND the AI class report
// for the same lesson only burns 1 unit of their lessonReportsPerMonth quota.
//
// `kind` tracks *which* report types have been sent; it's informational and
// not part of the uniqueness key.
const LessonReportSentSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    lessonId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lesson",
      required: true,
    },
    kinds: {
      type: [String],
      default: [],
    },
    sentAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true }
);

LessonReportSentSchema.index({ teacherId: 1, lessonId: 1 }, { unique: true });

const LessonReportSent = mongoose.model(
  "LessonReportSent",
  LessonReportSentSchema
);

export default LessonReportSent;
