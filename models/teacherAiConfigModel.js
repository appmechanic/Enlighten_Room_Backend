import mongoose from "mongoose";

const TeacherAIConfigSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // teacher / tutor
    },

    // Classwork and Assignment AI Feedback Prompt.
    // Optional: an empty string means "use the admin's standard prompt only";
    // per-teacher customisation is layered on top of it when non-empty.
    prompt: {
      type: String,
      trim: true,
      default: "",
    },

    // Generating Assignment Prompt
    assignmentPrompt: {
      type: String,
      trim: true,
      default: "",
    },

    // Generating Test Prompt
    generatingTestPrompt: {
      type: String,
      trim: true,
      default: "",
    },

    // Generating Report Prompt
    reportPrompt: {
      type: String,
      trim: true,
      default: "",
    },

    style: {
      type: String,
      trim: true,
      default: "",
    },

    features: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

// 1 config per user
TeacherAIConfigSchema.index({ user: 1 }, { unique: true });

const TeacherAIConfig = mongoose.model(
  "TeacherAIConfig",
  TeacherAIConfigSchema
);

export default TeacherAIConfig;
