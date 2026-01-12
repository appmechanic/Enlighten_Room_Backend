import mongoose from "mongoose";
const { Schema, model } = mongoose;

const CmsPageSchema = new Schema(
  {
    title: {
      type: String,
      // enum: ["Terms and Condition", "Privacy Policy"],
      required: true,
      trim: true,
    },
    content: { type: String },
    type: {
      type: String,
      enum: ["terms-and-condition", "privacy-policy", "promotion-content"],
    },

    // soft delete & auditing
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// unique per locale
CmsPageSchema.index(
  { slug: 1, locale: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

export default model("PrivacyPolicy", CmsPageSchema);
