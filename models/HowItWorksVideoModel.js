// models/HowItWorksVideo.js
import mongoose from "mongoose";

const howItWorksVideoSchema = new mongoose.Schema(
  {
    // we keep a singleton doc using a fixed key
    key: { type: String, unique: true, default: "howItWorksVideo" },

    // original YouTube link provided by admin
    url: { type: String, required: true, trim: true },

    isEnabled: { type: Boolean, default: true },

    // optional: track who updated this (if you pass req.user._id)
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("HowItWorksVideo", howItWorksVideoSchema);
