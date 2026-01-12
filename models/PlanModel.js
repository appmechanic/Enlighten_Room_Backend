import mongoose from "mongoose";

const planSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    planType: {
      type: String,
      // enum: ["basic", "pro", "enterprise"], Free, Standard, Premium, Enterprise
      required: true,
      unique: true,
    },
    priceMonthly: {
      type: Number,
      required: true,
    },
    priceYearly: {
      type: Number,
      required: true,
    },
    discountPrice: {
      type: Number,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    // Optional cache (recommended for reuse)
    subtitle: { type: String },
    stripeProductId: { type: String },
    stripePriceMonthly: { type: String },
    stripePriceYearly: { type: String },

    features: [
      {
        type: String,
      },
    ],
  },
  {
    timestamps: true,
  }
);

const Plan = mongoose.model("Plan", planSchema);
export default Plan;
