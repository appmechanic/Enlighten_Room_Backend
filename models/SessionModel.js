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
    duration: {
      type: Number,
    },
    recurrence: {
      type: {
        type: String,
        enum: ["none", "daily", "weekly", "monthly"],
        default: "none",
      },
      slots: [
        {
          _id: false,
          weekday: { type: Number, min: 0, max: 6 },
          time: { type: String },
        },
      ],
      untilDate: { type: Date },
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
    // When true, students see a "View My Report" button on their session card
    // that opens the per-lesson individual classwork report for this room.
    // Defaults to false so reports stay hidden until the teacher opts in.
    studentReportVisible: {
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
