// models/transactionModel.js
import mongoose from "mongoose";

const addressSchema = new mongoose.Schema(
  {
    line1: String,
    line2: String,
    city: String,
    state: String,
    postal_code: String,
    country: String,
  },
  { _id: false }
);

const transactionSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: true,
    },

    // Optional linkage to the buyer in your system (if you have one)
    customerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Stripe details
    stripe: {
      customerId: String,
      customerEmail: String,

      // identifiers
      invoiceId: String, // preferred for subscriptions
      paymentIntentId: String, // fallback for one-time / session PI
      chargeId: String, // charge id (ch_...)
      balanceTransactionId: {
        // canonical ledger id (txn_...)
        type: String,
        index: true,
      },
      subscriptionId: String,
      priceId: String,
      productId: String,

      // plan/price info
      planName: String, // price nickname or product name
      interval: String, // day | week | month | year
      intervalCount: Number, // e.g. 1, 12

      // subscription invoice period
      periodStart: Date,
      periodEnd: Date,

      // optional: de-dup webhook retries
      eventId: { type: String, index: true, sparse: true, unique: true }, // evt_...
    },

    planType: {
      type: String,
      enum: ["subscription", "one_time"],
      required: true,
    },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan" },
    amount: { type: Number, default: 0 }, // minor units (cents)
    currency: { type: String, default: "usd" },
    status: { type: String, default: "paid" }, // paid | failed | refunded...

    customerName: String,
    customerAddress: addressSchema,
    metadata: mongoose.Schema.Types.Mixed, // optional freeform JSON
  },
  { timestamps: true }
);

export default mongoose.model("Transaction", transactionSchema);
