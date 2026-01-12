import stripe from "../config/stripe.js";
import User from "../models/user.js";
import Plan from "../models/PlanModel.js";

/* ---------- helpers: address mappers ---------- */
function toStripeAddress(addr) {
  if (!addr) return undefined;
  const { line1, line2, city, state, postal_code, country } = addr;
  // Only pass defined keys to Stripe (avoid sending nulls)
  const out = {};
  if (line1) out.line1 = line1;
  if (line2) out.line2 = line2;
  if (city) out.city = city;
  if (state) out.state = state;
  if (postal_code) out.postal_code = postal_code;
  if (country) out.country = country;
  return Object.keys(out).length ? out : undefined;
}

function fromStripeAddress(addr) {
  if (!addr) return undefined;
  return {
    line1: addr.line1 || undefined,
    line2: addr.line2 || undefined,
    city: addr.city || undefined,
    state: addr.state || undefined,
    postal_code: addr.postal_code || undefined,
    country: addr.country || undefined,
  };
}

/* ------------ Pricing helpers using your discountPrice ------------ */
/**
 * Effective price logic:
 * - If interval === 'yearly' → base=priceYearly
 * - If interval === 'monthly' → base=priceMonthly
 * - Discount preference order (first found wins):
 *   1) interval-specific discountPriceYearly/discountPriceMonthly (if you add them later)
 *   2) single discountPrice
 *   3) falls back to base
 */
export async function amountFromPlanId(planId, interval = "monthly") {
  const plan = await Plan.findById(planId).lean();
  if (!plan) throw new Error("Plan not found");

  const isYearly = interval === "yearly";
  const base = isYearly ? plan.priceYearly : plan.priceMonthly;
  if (base == null) throw new Error("Plan missing price for interval");

  const intervalDiscount = isYearly ? plan.discountPrice : plan.discountPrice;

  let effective = base;
  if (typeof intervalDiscount === "number" && intervalDiscount > 0) {
    effective = intervalDiscount;
  } else if (typeof plan.discountPrice === "number" && plan.discountPrice > 0) {
    effective = plan.discountPrice;
  }

  const amount = Math.round(Number(effective) * 100); // dollars → cents
  return {
    amount,
    plan,
    effectivePrice: effective,
    usedDiscount: effective !== base,
  };
}

export async function upsertCustomer(userId, payload = {}) {
  const user = await User.findById(userId);
  if (!user) throw new Error("User not found");

  // Build Stripe customer input using payload first, then user as fallback (no empty strings)
  const stripeInput = {
    name: payload.name ?? user.name ?? undefined,
    email: payload.email ?? user.email ?? undefined,
    phone: payload.phone ?? user.phone ?? undefined,
    address: toStripeAddress(payload.address ?? user.address),
  };

  // Remove undefined keys so Stripe ignores them
  Object.keys(stripeInput).forEach(
    (k) => stripeInput[k] === undefined && delete stripeInput[k]
  );

  let customer;
  if (user.stripeCustomerId) {
    customer = await stripe.customers.update(
      user.stripeCustomerId,
      stripeInput
    );
  } else {
    customer = await stripe.customers.create(stripeInput);
    user.stripeCustomerId = customer.id;
  }

  // Persist user details (do not overwrite with empty values)
  if (payload.name && payload.name.trim()) user.name = payload.name.trim();
  // Prefer payload.email; otherwise, sync from Stripe if user's email is missing
  if (payload.email && payload.email.trim()) {
    user.email = payload.email.trim();
  } else if (!user.email && customer.email) {
    user.email = customer.email;
  }
  if (payload.phone && payload.phone.trim()) user.phone = payload.phone.trim();

  // Address: prefer payload; else, sync Stripe address if user.address is missing
  if (payload.address) {
    user.address = { ...user.address, ...payload.address };
  } else if (!user.address && customer.address) {
    user.address = fromStripeAddress(customer.address);
  }

  // Store a Stripe snapshot for quick reads/debug (adjust to your User schema)
  user.stripeProfile = {
    customerId: customer.id,
    email: customer.email || null,
    name: customer.name || null,
    phone: customer.phone || null,
    address: fromStripeAddress(customer.address) || null,
    invoiceSettings: {
      defaultPaymentMethod:
        customer.invoice_settings?.default_payment_method || null,
    },
    // You can add more here if you like:
    // preferredLocales: customer.preferred_locales ?? [],
    // taxExempt: customer.tax_exempt ?? "none",
  };

  // await user.save();
  return customer.id; // keep existing return contract
}

// For subscriptions: ensure (and cache) a recurring Price on Stripe for this planId+interval
export async function ensureRecurringPriceByPlanId(
  planId,
  interval = "monthly",
  { currency = "usd", preferredUnitAmountCents } = {}
) {
  const plan = await Plan.findById(planId);

  if (!plan) throw new Error("Plan not found");

  // 1) Ensure product
  let productId = plan.stripeProductId;
  if (!productId) {
    const product = await stripe.products.create({
      name: plan.name || `Plan ${plan._id}`,
      metadata: { planId: String(plan._id) },
    });
    productId = product.id;
    plan.stripeProductId = productId;
    await plan.save();
  }

  // 2) Try to find an EXACT matching price (currency, interval, unit_amount)
  const wanted = {
    currency: currency.toLowerCase(),
    interval: interval === "yearly" ? "year" : "month",
    unit_amount: Number(preferredUnitAmountCents) || 0,
  };

  // Optional: use a lookup_key to make reuse easy & deterministic
  const lookup_key = `plan:${planId}:interval:${wanted.interval}:cur:${wanted.currency}:amount:${wanted.unit_amount}`;

  // Try to find by lookup_key first
  const searchByLookup = await stripe.prices.search({
    query: `active:'true' AND lookup_key:'${lookup_key}'`,
    limit: 1,
  });
  if (searchByLookup.data.length) {
    return { priceId: searchByLookup.data[0].id };
  }

  // Otherwise list all prices on product and find exact match
  let starting_after = undefined;
  while (true) {
    const list = await stripe.prices.list({
      product: productId,
      active: true,
      limit: 100,
      starting_after,
      expand: ["data.tiers"],
    });

    const match = list.data.find(
      (p) =>
        p.currency === wanted.currency &&
        p.recurring?.interval === wanted.interval &&
        Number(p.unit_amount) === wanted.unit_amount
    );
    if (match) {
      return { priceId: match.id };
    }

    if (!list.has_more) break;
    starting_after = list.data[list.data.length - 1].id;
  }

  // 3) No exact match → create the correct price at final cents
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: wanted.unit_amount,
    currency: wanted.currency,
    recurring: { interval: wanted.interval, interval_count: 1 },
    lookup_key, // helps future reuse
    metadata: {
      planId: String(plan._id),
      interval: wanted.interval,
      finalAmountCents: String(wanted.unit_amount),
    },
  });

  return { priceId: price.id };
}
