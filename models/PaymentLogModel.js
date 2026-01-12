import mongoose from "mongoose";

const PaymentLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: "USD",
  },
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Subscription",
  },
  //   planType: {
  //     type: mongoose.Schema.Types.ObjectId,
  //     ref: "Plan", // 👈 linked to same Plan
  //     required: true,
  //   },
  paymentMethod: {
    type: String,
  },
  status: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const PaymentLog = mongoose.model("PaymentLog", PaymentLogSchema);
export default PaymentLog;
