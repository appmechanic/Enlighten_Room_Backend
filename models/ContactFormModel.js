import mongoose from "mongoose";

const ContactMessageSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    ip: { type: String, required: true, index: true },
    ua: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model("ContactMessage", ContactMessageSchema);
