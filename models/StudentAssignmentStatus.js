import mongoose from "mongoose";

const StudentAssignmentStatusSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  assignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  startTime: Date,
  dueTime: Date,
  endTime: Date,
  isStarted: { type: Boolean, default: false },
  isCompleted: { type: Boolean, default: false },
  isAutoSubmitted: { type: Boolean, default: false },
  score: { type: Number, default: 0 },
  feedback: { type: String, default: "" },
  settings: {
    type: Object,
    default: {},
  },
});

export default mongoose.model(
  "StudentAssignmentStatus",
  StudentAssignmentStatusSchema
);
