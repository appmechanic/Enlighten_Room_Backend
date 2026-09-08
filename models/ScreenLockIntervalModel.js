import mongoose from "mongoose";

// One row per screen-lock ON→OFF pair. `endedAt` stays null while the lock is
// still active; the aggregator clips open intervals to `Date.now()` when
// summing minutes for the current month.
//
// Written by the classroom/student settings toggle endpoint: on true → open a
// new interval, on false → close the most recent open interval for the same
// (teacherId, sessionId?, studentId?).
const ScreenLockIntervalSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      default: null,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    startedAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ScreenLockIntervalSchema.index({ teacherId: 1, startedAt: 1 });

const ScreenLockInterval = mongoose.model(
  "ScreenLockInterval",
  ScreenLockIntervalSchema
);

export default ScreenLockInterval;
