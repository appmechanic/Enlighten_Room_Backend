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
    enum: ["active", "inactive"],
    default: "active",
  },
  frequency: {
    type: String,
    enum: ["monthly", "yearly"],
    required: true,
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
