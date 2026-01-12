import mongoose from "mongoose";

const studentDriveSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
  },
  folderUrl: {
    type: String,
    required: true,
  },
  fileMeta: {
    type: Object, // You can define exact shape if needed
    required: true,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
});

const StudentDrive = mongoose.model("StudentDrive", studentDriveSchema);
export default StudentDrive;
