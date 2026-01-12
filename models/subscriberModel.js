// models/subscriberModel.js
import mongoose from "mongoose";

const subscriberSchema = new mongoose.Schema(
  {
    ip: {
      type: String,
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    message: {
      type: String,
      default: "",
      trim: true,
    },
    userAgent: {
      type: String,
      default: "",
    },
    type: {
      type: String,
      enum: ["Subscriber", "Waiting for Join"],
    },
  },
  { timestamps: true }
);

// (optional) basic email validator
subscriberSchema.path("email").validate(function (v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}, "Invalid email");

export default mongoose.model("Subscriber", subscriberSchema);
