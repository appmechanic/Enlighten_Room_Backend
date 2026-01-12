// models/testimonialModel.js
import mongoose from "mongoose";

const testimonialSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    designation: { type: String, default: "", trim: true },
    // store a URL or a local relative path (e.g. "uploads/testimonials/abc.jpg")
    image: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Testimonial", testimonialSchema);
