import mongoose from "mongoose";

const StandardPromptSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "global",
      unique: true,
      index: true,
    },
    aiHintPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    reportPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    emailPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    // System-level prompt prepended to every Create Assignment AI call.
    // The teacher's per-account assignmentPrompt is appended after this so
    // the structure of the request stays consistent across teachers, while
    // letting each teacher inject their own tone/preferences at the end.
    creatingAssignmentPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const StandardPrompt = mongoose.model("StandardPrompt", StandardPromptSchema);

export default StandardPrompt;
