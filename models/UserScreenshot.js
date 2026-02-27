import mongoose from "mongoose";

const userScreenshotSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    SessionId:{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      required: true,
    },
    screenshotUrl: {
      type: String,
      required: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const UserScreenshot = mongoose.model("UserScreenshot", userScreenshotSchema);
export default UserScreenshot;
