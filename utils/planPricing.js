// utils/planPricing.js
//
// Resolves the price a user should be charged for a plan in a specific
// currency. Order of precedence:
//   1. Plan.pricesByCurrency[<CCY>][<interval>]  — explicit override set
//      by admin (e.g., a marketing price of ₹1,999/mo rather than an
//      FX-converted ₹1,847.32).
//   2. Base USD price × current FX rate from CurrencyRate model.
//   3. Base USD price (last-resort fallback when no rate is cached).
//
// Returns { amount, currency, source } — `source` is one of
//   "override" | "fx-converted" | "usd-fallback"
// so the payment controller can log/telemeter which path fired.
import CurrencyRate from "../models/CurrencyRate.js";

function baseDollars(plan, interval) {
  if (interval === "yearly") {
    return Number(plan?.priceYearly || plan?.priceMonthly || 0);
  }
  return Number(plan?.priceMonthly || 0);
}

export async function getEffectivePlanPrice(plan, currency, interval) {
  const ccy = String(currency || "USD").toUpperCase();
  const override = plan?.pricesByCurrency?.[ccy]?.[interval];
  if (override != null && Number.isFinite(Number(override))) {
    return {
      amount: Number(override),
      currency: ccy,
      source: "override",
    };
  }

  const usd = baseDollars(plan, interval);
  if (ccy === "USD") {
    return { amount: usd, currency: "USD", source: "usd-fallback" };
  }

  try {
    const latest = await CurrencyRate.findOne({ base: "USD" })
      .sort({ fetchedAt: -1 })
      .lean();
    const rate = latest?.rates?.[ccy];
    if (rate) {
      return {
        amount: usd * Number(rate),
        currency: ccy,
        source: "fx-converted",
      };
    }
  } catch (err) {
    console.error("getEffectivePlanPrice FX lookup failed:", err.message);
  }
  // Ran out of options — surface USD so we don't accidentally charge zero.
  return { amount: usd, currency: "USD", source: "usd-fallback" };
}
