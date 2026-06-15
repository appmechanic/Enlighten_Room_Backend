import mongoose from "mongoose";

const StandardPromptSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: "global",
      unique: true,
      index: true,
    },
    // Legacy joined view of aiHintPromptSections, kept so older callers
    // (e.g. controllers/geminiHintController.js) keep working unchanged.
    // The standard-prompt controller rewrites this on every save.
    aiHintPrompt: {
      type: String,
      trim: true,
      default: "",
    },
    // Admin-editable AI hint prompt, split into the 10 sections defined in
    // utils/aiHintSections.js. Used by geminiClassworkFeedback.js to
    // assemble the per-request rules block.
    aiHintPromptSections: {
      type: [String],
      default: undefined,
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
