import stripe from "./stripeClient.js";
import User from "../models/user.js";
import Plan from "../models/Plan.js";

/** Ensure a Stripe Customer for this user and keep its id on User */
export async function upsertCustomer(userId, payload = {}) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  if (user.stripeCustomerId) {
    await stripe.customers.update(user.stripeCustomerId, payload);
    return user.stripeCustomerId;
  }
  const customer = await stripe.customers.create(payload);
  user.stripeCustomerId = customer.id;
  await user.save();
  return customer.id;
}

export async function amountFromPlanId(planId, interval = "monthly") {
  const plan = await Plan.findById(planId).lean();
  if (!plan) throw new Error("Plan not found");

  const isYearly = interval === "yearly";

  // Base by interval
  const base = isYearly ? plan.priceYearly : plan.priceMonthly;
  if (base == null) throw new Error("Plan missing price for interval");

  // Prefer interval-specific discount if present; else use single discountPrice if present
  const intervalDiscount = isYearly
    ? plan.discountPriceYearly
    : plan.discountPriceMonthly; // optional fields (if you add later)

  let effective = base;
  if (typeof intervalDiscount === "number" && intervalDiscount > 0) {
    effective = intervalDiscount;
  } else if (typeof plan.discountPrice === "number" && plan.discountPrice > 0) {
    effective = plan.discountPrice; // ← your existing single field
  }

  const amount = Math.round(Number(effective) * 100); // dollars → cents
  return {
    amount,
    plan,
    effectivePrice: effective,
    usedDiscount: effective !== base,
  };
}

/** Return a priceId for plan+interval; create & cache on Plan if missing */
export async function ensureRecurringPrice(planId, interval = "monthly") {
  const plan = await Plan.findBYId({ _id: planId });
  if (!plan) throw new Error("Unknown planType");

  // Free plans: do not create a Stripe subscription
  const unitAmount =
    interval === "yearly"
      ? Math.round((plan.priceYearly || 0) * 100)
      : Math.round((plan.priceMonthly || 0) * 100);

  if (unitAmount <= 0) return null; // caller should handle "free" tier

  // Reuse cached IDs if present
  if (interval === "monthly" && plan.stripePriceMonthly)
    return plan.stripePriceMonthly;
  if (interval === "yearly" && plan.stripePriceYearly)
    return plan.stripePriceYearly;

  // Ensure product
  let productId = plan.stripeProductId;
  if (!productId) {
    const product = await stripe.products.create({
      name: `${plan.name} (${plan.planType})`,
    });
    productId = product.id;
    plan.stripeProductId = productId;
  }

  // Create price
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency: "usd",
    recurring: { interval: interval === "yearly" ? "year" : "month" },
  });

  if (interval === "monthly") plan.stripePriceMonthly = price.id;
  else plan.stripePriceYearly = price.id;

  await plan.save();
  return price.id;
}
