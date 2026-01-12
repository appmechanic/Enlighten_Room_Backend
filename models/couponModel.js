import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Discount type
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      default: "percentage",
    },
    // Discount value (percentage: 0-100, fixed: amount)
    discountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    discountFixed: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Free access flag
    isFree: {
      type: Boolean,
      default: false,
    },
    // Status
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Usage limits
    maxUses: {
      type: Number,
      default: 0, // 0 = unlimited
      min: 0,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Validity period
    startsAt: {
      type: Date,
      default: () => new Date(),
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    // Applicable to specific plans (empty = all plans)
    applicablePlans: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Plan",
      },
    ],
    // Minimum purchase amount
    minPurchaseAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Restrictions
    maxDiscountAmount: {
      type: Number,
      default: null, // null = no limit
    },
    oneTimePerUser: {
      type: Boolean,
      default: false,
    },
    // Creator and notes
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for finding active, non-expired coupons
couponSchema.index({ isActive: 1, expiresAt: 1 });
couponSchema.index({ code: 1, isActive: 1 });

export default mongoose.model("Coupon", couponSchema);
