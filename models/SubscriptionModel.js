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
  // Marker used by teacherUsage's monthly counters. Every counter is
  // clamped to max(monthStart, usageResetAt), so bumping this to `now`
  // makes AI calls / sessions / session minutes / screen lock minutes /
  // lesson reports all read 0 immediately. Stripe webhooks bump it on
  // subscription.created and on any plan change (upgrade/downgrade);
  // admin-side plan edits should call touchUsageResetAt(userId) too.
  usageResetAt: {
    type: Date,
    default: Date.now,
  },
});

const Subscription = mongoose.model("Subscription", subscriptionSchema);
export default Subscription;
