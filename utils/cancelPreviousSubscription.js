import axios from "axios";
import stripe from "../config/stripe.js";
import Subscription from "../models/SubscriptionModel.js";

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const { data } = await axios.post(
    "https://api-m.sandbox.paypal.com/v1/oauth2/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return data.access_token;
}

async function cancelOnProvider(sub) {
  if (!sub?.providerSubscriptionId) return;

  if (sub.provider === "stripe") {
    try {
      await stripe.subscriptions.cancel(sub.providerSubscriptionId, {
        invoice_now: false,
        prorate: false,
      });
    } catch (err) {
      console.error(
        "Stripe cancel previous subscription failed:",
        err?.message || err
      );
    }
    return;
  }

  if (sub.provider === "paypal") {
    // The PayPal billing-subscriptions cancel endpoint only accepts
    // recurring subscription IDs (prefixed with "I-"). One-time order IDs
    // produced by /v2/checkout/orders are not auto-renewing and cannot — and
    // need not — be cancelled. Skip the API call in that case.
    if (!String(sub.providerSubscriptionId || "").startsWith("I-")) {
      return;
    }
    try {
      const token = await getPayPalAccessToken();
      await axios.post(
        `https://api-m.sandbox.paypal.com/v1/billing/subscriptions/${sub.providerSubscriptionId}/cancel`,
        { reason: "Replaced by a new subscription" },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      console.error(
        "PayPal cancel previous subscription failed:",
        err?.response?.data || err?.message || err
      );
    }
  }
}

/**
 * Cancel the user's current active subscription with the payment provider
 * (no refund issued). Marks the local row as cancelled so the next upsert
 * starts clean. Safe to call when no previous subscription exists.
 */
export async function cancelPreviousSubscription(userId) {
  if (!userId) return null;

  const existing = await Subscription.findOne({
    userId,
    status: "active",
  });

  if (!existing) return null;

  await cancelOnProvider(existing);

  existing.status = "cancelled";
  existing.cancelledAt = new Date();
  await existing.save();

  return existing;
}
