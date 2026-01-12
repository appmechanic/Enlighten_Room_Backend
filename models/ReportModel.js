import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  type: { type: String, enum: ["session", "student"], required: true },

  classroomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Classroom",
    required: true,
  },
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  studentName: { type: String },
  teacherName: { type: String },

  performanceSummary: { type: String, required: true },
  reportType: {
    type: String,
    enum: ["daily", "weekly", "monthly"],
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});

const Report = mongoose.model("Report", reportSchema);
export default Report;
