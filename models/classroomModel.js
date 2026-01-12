// models/Classroom.js
import mongoose from "mongoose";

const classroomSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    studentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    subject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subject",
      required: true,
    },
    sessions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Session",
        // required: true,
      },
    ],
    dateTime: {
      type: Date,
      required: true,
    },
    frequency: {
      type: String, // e.g., 'daily', 'weekly', etc.
      enum: ["daily", "weekly", "monthly"],
      required: true,
    },
    duration: {
      type: Number, // in minutes
      required: true,
    },
    lastDate: {
      type: Date,
      required: true,
    },
    expiryDateTime: {
      type: Date,
      required: false, // optional; add frontend support if needed
    },
    settings: {
      type: Object,
      default: {
        screenLocked: false,
        emailNotFocus: false,
        sendReport: false,
        saveMaterials: false,
        reminders: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Reminder",
        },
        room: { type: String, default: "" },
        online: { type: Boolean, default: false },
        resources: [], // assuming array of resource links or names
      },
    },
    remarks: {
      type: String,
      default: "",
    },
    scope: {
      type: String, // e.g., 'subject', 'location', 'general'
      default: "general",
    },
    lesson_report: {
      type: String,
    },
    classroom_prompt: {
      type: String,
    },
  },
  { timestamps: true }
);

const Classroom = mongoose.model("Classroom", classroomSchema);

export default Classroom;
