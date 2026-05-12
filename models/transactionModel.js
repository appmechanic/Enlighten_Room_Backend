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


    // Stripe details (optional)
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

    // PayPal details (optional)
    paypal: {
      payerId: String,
      payerEmail: String,

      // identifiers
      orderId: String, // PayPal order ID
      subscriptionId: String, // PayPal subscription ID
      captureId: String, // PayPal capture ID (for one-time payments)
      productId: String, // PayPal product ID
      planId: String, // PayPal plan ID

      // plan/price info
      planName: String, // product/plan name
      interval: String, // day | week | month | year
      intervalCount: Number, // e.g. 1, 12

      // subscription period
      periodStart: Date,
      periodEnd: Date,

      // optional: webhook event id
      eventId: { type: String, index: true, sparse: true, unique: true },
    },

    planType: {
      type: String,
      enum: ["subscription", "one_time"],
      required: true,
    },
    provider: { type: String, enum: ["stripe", "paypal"] },
    method: { type: String },
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
