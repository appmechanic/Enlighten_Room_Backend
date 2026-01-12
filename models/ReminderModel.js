import mongoose from "mongoose";

const REMINDER_TYPES = ["Fee", "Other"];
const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];
const STATUSES = ["active", "inactive"];

const reminderSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    students: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // parentId: {
    //   type: mongoose.Schema.Types.ObjectId,
    //   ref: "User",
    //   required: true,
    //   index: true,
    // },
    title: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    statement: { type: String, default: "", trim: true },
    type: { type: String, enum: REMINDER_TYPES, required: true }, // Fee | Other
    startDate: { type: Date, required: true },
    frequency: { type: String, enum: FREQUENCIES, required: true }, // daily|weekly|monthly|yearly
    remindBeforeDays: { type: Number, default: 0, min: 0 },
    untilDate: { type: Date },
    sendEmailToParent: { type: Boolean, default: false },
    sendNotificationToParent: { type: Boolean, default: true },
    status: { type: String, enum: STATUSES, default: "active", index: true },
    lastProcessedAt: { type: Date },
    nextDueAt: { type: Date }, // when to trigger next send
    errorCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Optional sanity check: untilDate >= startDate
reminderSchema.pre("save", function (next) {
  if (this.untilDate && this.startDate && this.untilDate < this.startDate) {
    return next(new Error("Until date cannot be earlier than start date."));
  }
  next();
});

export default mongoose.model("Reminder", reminderSchema);
export { REMINDER_TYPES, FREQUENCIES, STATUSES };
