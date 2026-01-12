// models/TeacherDrive.js
import mongoose from "mongoose";

const teacherDriveSchema = new mongoose.Schema({
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "User",
  },
  folderUrl: {
    type: String,
    required: true,
  },
  fileMeta: {
    type: Object, // or define specific fields if known (e.g. { name, size, type })
    required: true,
  },
  uploadedAt: {
    type: Date,
    default: Date.now,
  },
});

const TeacherDrive = mongoose.model("TeacherDrive", teacherDriveSchema);
export default TeacherDrive;
