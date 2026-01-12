import mongoose from "mongoose";

const SessionSchema = new mongoose.Schema(
  {
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
    },
    sessionDate: {
      type: Date,
      required: true,
    },
    topic: {
      type: String,
      required: true,
    },
    sessionUrl: {
      type: String,
      required: true,
    },
    // session_url: {
    //   type: String,
    // },
    notes: {
      type: String,
    },
    // 🔔 reminder flags
    reminders: {
      // used by send24hLessonReminders()
      lesson24hSent: {
        type: Boolean,
        default: false,
      },
      // used by send24hHomeworkReminders()
      homework24hSent: {
        type: Boolean,
        default: false,
      },
    },
    restrict_student_wb: {
      type: Boolean,
      default: false,
    },
    // studentIds: [
    //   {
    //     type: mongoose.Schema.Types.ObjectId,
    //     ref: "Student", // or "Student" if you have a separate model
    //   },
    // ],
  },
  { timestamps: true }
);

const Session = mongoose.model("Session", SessionSchema);

export default Session;
