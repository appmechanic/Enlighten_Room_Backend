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
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

const StandardPrompt = mongoose.model("StandardPrompt", StandardPromptSchema);

export default StandardPrompt;
