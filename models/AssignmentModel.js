import mongoose from "mongoose";

const SubmissionSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  submittedAt: {
    type: Date,
    default: Date.now,
  },
  autoSubmitted: {
    type: Boolean,
    default: false,
  },
  isCompleted: {
    type: Boolean,
    default: false,
  },
  questions: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Question",
    },
  ],
  marks: {
    type: Number,
    default: 0,
  },
  feedback: {
    type: String,
    default: "",
  },
});

const AssignmentTaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  assignmentStatus: {
    type: String,
    default: "Pending",
  },
  dueDate: {
    type: Date,
    required: true,
  },
  duration: {
    type: Number, // duration in minutes (optional if you’re using `StudentAssignmentStatus`)
    default: 30,
  },
  resources: {
    type: [String],
    default: [],
  },
  maxMarks: {
    type: Number,
    required: true,
  },
  // filePath: {
  //   type: String,
  // },
  // originalFileName: {
  //   type: String,
  // },
  studentIds: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  ],
  questions: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Question",
    },
  ],
  // submissions: [SubmissionSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const AssignmentSchema = new mongoose.Schema(
  {
    classroomId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Classroom",
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      required: true,
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignments: {
      type: [AssignmentTaskSchema],
      required: true,
      validate: [
        (arr) => arr.length > 0,
        "At least one assignment is required",
      ],
    },
    // 🔔 reminder flags
    reminders: {
      // used by send24hHomeworkReminders()
      homework24hSent: {
        type: Boolean,
        default: false,
      },
    },
  },
  { timestamps: true }
);

const Assignment = mongoose.model("Assignment", AssignmentSchema);
export default Assignment;
