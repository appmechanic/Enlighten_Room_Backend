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

    // PayPal product and billing plan IDs (for Stripe-like parity)
    paypalProductId: { type: String },
    paypalPriceMonthly: { type: String }, // PayPal price ID for monthly
    paypalPriceYearly: { type: String },  // PayPal price ID for yearly
    paypalBillingPlanMonthly: { type: String }, // legacy, for compatibility
    paypalBillingPlanYearly: { type: String },  // legacy, for compatibility

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
