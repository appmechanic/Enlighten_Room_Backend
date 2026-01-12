// models/Waitlist.js
import mongoose from "mongoose";

const waitlistSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      validate: {
        validator: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        message: (p) => `${p.value} is not a valid email`,
      },
    },
    name: { type: String, trim: true }, // optional
    source: { type: String, trim: true }, // optional (e.g., "landing", "referral")
    notes: { type: String, trim: true }, // optional (admin notes)
    status: {
      type: String,
      enum: ["pending", "invited", "joined", "rejected"],
      default: "pending",
    },
  },
  { timestamps: true }
);

waitlistSchema.index({ email: 1 }, { unique: true });

const Waitlist = mongoose.model("Waitlist", waitlistSchema);
export default Waitlist;
