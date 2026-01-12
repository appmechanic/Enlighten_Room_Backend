// models/articleModel.js
import mongoose from "mongoose";

const articleSchema = new mongoose.Schema(
  {
    // You likely want a title even if not listed — it’s required here.
    title: { type: String, required: true, trim: true },

    // Short/sub description shown in cards/lists
    subDescription: { type: String, default: "", trim: true, maxlength: 600 },

    // Long description from your editor (HTML or Markdown)
    longDescription: { type: String, required: true },

    // URL or local path (e.g., "uploads/articles/xyz.jpg")
    image: { type: String, default: "" },

    type: { type: String, enum: ["why choose us", "articles listing"] },

    // Who added the article
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // change to String if no User model

    // Category reference (or change to String if you don’t have a Category model)
    category: { type: String },

    // SEO tags / keywords
    metaTags: { type: [String], default: [] },

    // SEO-friendly slug from title
    slug: { type: String, index: true, unique: true, sparse: true },
  },
  { timestamps: true }
);

// Simple slugify (no external deps)
function slugify(str = "") {
  return str
    .toString()
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Generate slug if missing
articleSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    this.slug = slugify(this.title);
  }
  next();
});

// Text index for search
articleSchema.index({
  title: "text",
  subDescription: "text",
  longDescription: "text",
  metaTags: "text",
});

export default mongoose.model("Article", articleSchema);
