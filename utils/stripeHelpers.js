// utils/stripeHelpers.js
export async function getBalanceTxnIdFromCharge(stripe, chargeIdOrObj) {
  let charge = chargeIdOrObj;
  if (!charge || typeof charge === "string") {
    charge = await stripe.charges.retrieve(chargeIdOrObj, {
      expand: ["balance_transaction"],
    });
  }
  const bt = charge.balance_transaction;
  return typeof bt === "string" ? bt : bt?.id || null; // returns txn_...
}

export async function getChargeFromPaymentIntent(stripe, paymentIntentId) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge.balance_transaction"],
  });

  if (pi.latest_charge && typeof pi.latest_charge !== "string") {
    return pi.latest_charge; // expanded charge object (with balance_transaction)
  }
  if (typeof pi.latest_charge === "string") {
    return await stripe.charges.retrieve(pi.latest_charge, {
      expand: ["balance_transaction"],
    });
  }

  const list = await stripe.charges.list({
    payment_intent: paymentIntentId,
    limit: 1,
  });
  return list.data?.[0] || null;
}
