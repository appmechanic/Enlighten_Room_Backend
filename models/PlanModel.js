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
    planCategory: {
      type: String,
      enum: ["individual", "school"],
      default: "individual",
      index: true,
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

    // Explicit per-currency price overrides. When present, the resolver
    // prefers these over the automatic base-price × FX-rate conversion,
    // which produces awkward numbers like "₹1,847". Shape:
    //   { USD: { monthly: 20,   yearly: 200 },
    //     INR: { monthly: 1999, yearly: 19999 },
    //     EUR: { monthly: 18,   yearly: 180 } }
    // Mongoose `Mixed` because currency codes are open-ended.
    pricesByCurrency: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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

    // Quota fields consumed by requirePlanLimit middleware. A null/undefined
    // value on any limit means "unlimited" for that dimension — makes it
    // safe to introduce new limits without retroactively bounding every
    // existing plan. Keep the shape flat so Stripe metadata can populate
    // it 1:1 on plan sync.
    limits: {
      maxStudents: { type: Number, default: null },
      maxTeachers: { type: Number, default: null },
      maxSessionsPerMonth: { type: Number, default: null },
      maxSessionMinutesPerMonth: { type: Number, default: null },
      maxAiCallsPerMonth: { type: Number, default: null },
      maxClassrooms: { type: Number, default: null },
    },

    // Feature-flag bag — checked by requireFeatureFlag middleware. Prefer
    // this over hard-coded plan-name checks (`if (plan === "pro")`) so a
    // plan rename or new tier doesn't cascade through the codebase.
    featureFlags: {
      aiClasswork: { type: Boolean, default: false },
      aiIndividualAssignments: { type: Boolean, default: false },
      test: { type: Boolean, default: false },
      whiteboard: { type: Boolean, default: false },
      excelImport: { type: Boolean, default: false },
      customBranding: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

const Plan = mongoose.model("Plan", planSchema);
export default Plan;
