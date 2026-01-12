import mongoose from "mongoose";

const TeacherAIConfigSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // teacher / tutor
    },

    // WHAT to say to AI (criteria / focus)
    prompt: {
      type: String,
      required: true,
      trim: true,
    },

    // HOW reports & replies should sound (tone / format)
    style: {
      type: String,
      trim: true,
      default: "",
    },

    // WHICH features / behaviour to use (questions, hints, examples, etc.)
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
