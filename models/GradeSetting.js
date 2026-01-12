import mongoose from "mongoose";

const gradeSchema = new mongoose.Schema({
  letter: { type: String, required: true }, // e.g. A+
  minPercent: { type: Number, required: true }, // e.g. 90
  maxPercent: { type: Number, required: true }, // e.g. 100
  // gradePoint: { type: Number, required: true }, // e.g. 10
});

const gradeSettingSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      //   required: true,
    },
    assignmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Assignment",
      default: null,
    }, // Optional
    grades: [gradeSchema],
  },
  { timestamps: true }
);

export default mongoose.model("GradeSetting", gradeSettingSchema);
