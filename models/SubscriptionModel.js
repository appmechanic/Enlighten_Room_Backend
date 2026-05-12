import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    unique: true,
  },
  planType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Plan", // 👈 reference to Plan collection
    required: true,
  },
  currency: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ["active", "inactive", "cancelled"],
    default: "active",
  },
  frequency: {
    type: String,
    enum: ["monthly", "yearly"],
    required: true,
  },
  provider: {
    type: String,
    enum: ["stripe", "paypal"],
  },
  providerSubscriptionId: {
    type: String,
  },
  cancelledAt: {
    type: Date,
  },
  addons: [
    {
      type: String,
    },
  ],
  promoCode: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const Subscription = mongoose.model("Subscription", subscriptionSchema);
export default Subscription;
