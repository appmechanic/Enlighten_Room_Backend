import stripe from "../config/stripe.js";
import Plan from "../models/PlanModel.js";
import Transaction from "../models/transactionModel.js";
import {
  upsertCustomer,
  amountFromPlanId,
  ensureRecurringPriceByPlanId,
} from "../utils/billing.helpers.js";
import Discount from "../models/PromotionModel.js";
import User from "../models/user.js";
import CurrencyRate from "../models/CurrencyRate.js";

// ---- helpers ----

// If you sometimes store percent as 0.5 (i.e. 50%), normalize it:
const normalizePercent = (v) => {
  const n = Number(v) || 0;
  // treat 0..1 as fraction, 1..100 as percent
  if (n > 0 && n <= 1) return n * 100;
  return clampPct(n);
};

const toCents = (v) => Math.max(0, Number(v) || 0);
const clampPct = (v) => Math.min(100, Math.max(0, Number(v) || 0));

// Get the plan price in **dollars** for the interval
const getPlanBaseDollars = (planDoc, interval) =>
  interval === "yearly"
    ? Number(planDoc?.priceYearly) || 0
    : Number(planDoc?.priceMonthly) || 0;

// baseDollars (e.g., 20.00), combinedPercent (e.g., 50)  -> integer cents
const discountedCentsFromDollars = (baseDollars, combinedPercent) =>
  Math.max(
    0,
    Math.round(
      (Number(baseDollars) || 0) * 100 * (1 - clampPct(combinedPercent) / 100)
    )
  );

// Find an active app discount by code
async function getActiveAppDiscount(code) {
  if (!code) return null;
  const doc = await Discount.findOne({ code, status: "active" }).lean();
  if (!doc || typeof doc.discount !== "number" || doc.discount <= 0)
    return null;
  return { code: doc.code, percent: doc.discount, id: String(doc._id) };
}

function planNameFromSub(sub) {
  const price = sub?.items?.data?.[0]?.price;
  const productName =
    price?.product && typeof price.product === "object"
      ? price.product?.name
      : null;
  return productName || price?.nickname || "previous plan";
}

function proratedCreditCentsFromStripeSub(sub) {
  try {
    const price =
      sub?.items?.data?.[0]?.price || sub?.items?.data?.[0]?.plan || {};
    const unit = Number(price?.unit_amount || price?.amount || 0);
    const now = Math.floor(Date.now() / 1000);
    const start = Number(sub?.current_period_start || now);
    const end = Number(sub?.current_period_end || now);
    if (!unit || end <= start || now >= end) return 0;

    const fractionRemaining = (end - now) / (end - start); // 0..1
    return Math.max(0, Math.round(unit * fractionRemaining));
  } catch {
    return 0;
  }
}

// Old sub → compute upgrade credit per policy:
// - If upgraded within first 7 days of the current period => 100% of old plan price
// - Else => prorated remaining fraction of old plan price
// Returns { creditCents, usedDays, periodDays, creditPercent }
function computeUpgradeCreditCents(oldSub, finalCents) {
  try {
    const n = (v) => ((v = +v) > 0 ? v : 0);
    const now = Math.floor(Date.now() / 1000);
    const item = oldSub?.items?.data?.[0] || {};
    const price = item.price || {};
    const oldPriceCents = (n(price.unit_amount) || 0) * (n(item.quantity) || 1);
    const cap = n(finalCents);
    if (!oldPriceCents || !cap) return 0;

    let start =
      n(oldSub?.current_period_start) ||
      n(oldSub?.billing_cycle_anchor) ||
      n(oldSub?.start_date) ||
      n(oldSub?.created);
    let end = n(oldSub?.current_period_end);
    let period = end > start ? end - start : 0;

    if (!period) {
      const d = 86400,
        c = n(price?.recurring?.interval_count) || 1;
      const per =
        price?.recurring?.interval === "day"
          ? d
          : price?.recurring?.interval === "week"
          ? 7 * d
          : price?.recurring?.interval === "year"
          ? 365 * d
          : 30 * d;
      period = c * per;
      if (!start) start = now - period;
      end = start + period;
    }
    if (!(period = end - start) || period <= 0) return 0;

    const used = Math.max(0, Math.min(now - start, period));
    const ratio = used <= 15 * 86400 ? 0.5 : (period - used) / period;

    return Math.max(0, Math.min(Math.round(oldPriceCents * ratio), cap));
  } catch {
    return 0;
  }
}

/** POST /api/billing/intent
 * Body: { userId, amount, currency, customer, metadata }
 */
export async function createPaymentIntent(req, res) {
  try {
    const {
      userId,
      planId,
      interval = "monthly", // "monthly" | "yearly"
      currency = "usd",
      customer = {},
      metadata = {},
      customerAddress,
    } = req.body;

    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!planId) return res.status(400).json({ error: "planId required" });

    // derive amount from your Plan
    const { amount, plan } = await amountFromPlanId(planId, interval);

    // free plans skip Stripe entirely
    if (amount <= 0) {
      return res.json({
        clientSecret: null,
        paymentIntentId: null,
        status: "free",
        note: "Amount is 0. Activate this plan in your DB (no PaymentIntent).",
      });
    }

    const customerId = await upsertCustomer(userId, {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
    });

    const pi = await stripe.paymentIntents.create({
      amount,
      currency,
      customer: customerId,
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId,
        planId,
        planType: plan.planType,
        interval,
        ...metadata,
      },
    });

    res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

/** POST /api/billing/subscriptions/start
 * Body: { userId, planType, interval, coupon, customer }
 */
export async function startSubscription(req, res) {
  try {
    const {
      userId,
      planType, // "one_time" | "subscription"
      planId,
      interval = "monthly",
      currency = "usd",
      // Keep these for backward compatibility, but we won't send Stripe coupons
      // when using merged % to avoid double-discount:
      coupon,
      discountCode,
      customer = {},
      metadata = {},
      customerAddress,
    } = req.body || {};

    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!planType) return res.status(400).json({ error: "planType required" });
    if (!planId) return res.status(400).json({ error: "planId required" });

    // Load plan (for name & base pricing)
    const planDoc = await Plan.findById(planId).lean();
    const planName = planDoc?.name || metadata?.planName || null;

    // 2) Build the **base price in dollars**
    const baseDollars = getPlanBaseDollars(planDoc, interval); // e.g., 20.00

    // --- Currency conversion logic ---
    // Fetch latest currency rates from DB
    let convertedBase = baseDollars;
    let conversionRate = 1;
    let currencySource = "USD";
    try {
      // Use import statement at the top of the file:
      // import CurrencyRate from "../models/CurrencyRate.js";
      const latestRates = await CurrencyRate.findOne({ base: "USD" })
        .sort({ fetchedAt: -1 })
        .lean();
      if (
        currency &&
        currency.toUpperCase() !== "USD" &&
        latestRates &&
        latestRates.rates[currency.toUpperCase()]
      ) {
        conversionRate = latestRates.rates[currency.toUpperCase()];
        convertedBase = baseDollars * conversionRate;
        currencySource = currency.toUpperCase();
      }
    } catch (err) {
      console.error("Currency conversion failed, using USD base.", err);
    }

    // 3) Percentages (plan % + promo %), both normalized to 0..100
    const planDiscountPercent = normalizePercent(planDoc?.discountPrice); // e.g., 20 (or 0.2)
    const appDiscount = await getActiveAppDiscount(discountCode); // { code, percent } | null
    const promoPercent = normalizePercent(appDiscount?.percent || 0); // e.g., 30

    // 4) Merge → combined percentage (cap at 100)
    const combinedPercent = clampPct(planDiscountPercent + promoPercent); // e.g., 50

    // console.log(
    //   "convertedBase, planDiscountPercent, promoPercent, combinedPercent",
    //   convertedBase,
    //   planDiscountPercent,
    //   promoPercent,
    //   combinedPercent
    // );
    // 5) Apply combined % **directly on converted amount**, then convert to **cents**
    const finalCents = discountedCentsFromDollars(
      convertedBase,
      combinedPercent
    ); // e.g., 20.00 & 50% => 1000

    // console.log("finalCents", finalCents);
    // For metadata and transaction records, use convertedBase and conversionRate
    // ...existing code...

    // Create/Update Stripe customer
    const customerId = await upsertCustomer(userId, {
      name: customer?.name,
      email: customer?.email,
      phone: customer?.phone,
      address: customer?.address,
    });

    /* ---------------- ONE-TIME ---------------- */
    if (planType === "one_time") {
      if (finalCents <= 0) {
        const tx = await Transaction.create({
          teacherId: userId,
          planType: "one_time",
          amount: 0,
          currency,
          status: "paid",
          stripe: {
            customerId,
            planName,
            interval: interval === "yearly" ? "year" : "month",
            intervalCount: interval === "yearly" ? 12 : 1,
          },
          customerName: customer?.name || null,
          customerAddress: customer?.address || null,
          metadata: {
            ...metadata,
            planBaseAmount: convertedBase,
            planDiscountPercent,
            promoDiscountPercent: promoPercent,
            combinedDiscountPercent: combinedPercent,
            discountCode: appDiscount?.code || null,
            discountApplied: combinedPercent > 0,
            finalAmount: 0,
            conversionRate,
            currencySource,
          },
          planId,
        });
        return res.json({
          intentType: "none",
          clientSecret: null,
          status: "free",
          transactionId: tx._id,
        });
      }

      const pi = await stripe.paymentIntents.create({
        amount: finalCents,
        currency,
        customer: customerId,
        automatic_payment_methods: { enabled: true },
        metadata: {
          userId,
          planId,
          planType,
          interval,
          intervalCount: interval === "yearly" ? 12 : 1,
          currency,
          planName,
          // snapshot
          planBaseAmount: convertedBase,
          planDiscountPercent,
          promoDiscountPercent: promoPercent,
          combinedDiscountPercent: combinedPercent,
          discountCode: appDiscount?.code || "",
          finalAmount: finalCents,
          conversionRate,
          currencySource,
          ...metadata,
        },
      });

      const pending = await Transaction.create({
        teacherId: userId,
        planType: "one_time",
        amount: finalCents,
        currency,
        status: pi.status || "requires_payment_method",
        stripe: {
          customerId,
          customerEmail: customer?.email || null,
          paymentIntentId: pi.id,
          planName,
          interval: interval === "yearly" ? "year" : "month",
          intervalCount: interval === "yearly" ? 12 : 1,
        },
        customerName: customer?.name || null,
        customerAddress: customer?.address || null,
        metadata: {
          ...metadata,
          planBaseAmount: convertedBase,
          planDiscountPercent,
          promoDiscountPercent: promoPercent,
          combinedDiscountPercent: combinedPercent,
          discountCode: appDiscount?.code || null,
          discountApplied: combinedPercent > 0,
          finalAmount: finalCents,
          conversionRate,
          currencySource,
        },
        planId,
      });

      return res.json({
        intentType: "payment",
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        transactionId: pending._id,
      });
    }

    /* -------------- SUBSCRIPTION -------------- */
    if (planType === "subscription") {
      // Ensure the Stripe Price equals the final discounted cents
      const ensured = await ensureRecurringPriceByPlanId(planId, interval, {
        currency,
        preferredUnitAmountCents: finalCents, // <- key: we charge the merged discounted price
      });
      const priceId = typeof ensured === "string" ? ensured : ensured?.priceId;

      // Refresh plan to get product id
      const planAfter = await Plan.findById(planId).lean();
      const productId = planAfter?.stripeProductId || null;

      if (!priceId) {
        const tx = await Transaction.create({
          teacherId: userId,
          planType: "subscription",
          amount: 0,
          currency,
          status: "paid",
          stripe: {
            customerId,
            customerEmail: customer?.email || null,
            planName,
            interval: interval === "yearly" ? "year" : "month",
            intervalCount: interval === "yearly" ? 12 : 1,
          },
          customerName: customer?.name || null,
          customerAddress: customerAddress || null,
          metadata: {
            ...metadata,
            planBaseAmount: baseDollars,
            planDiscountPercent,
            promoDiscountPercent: promoPercent,
            combinedDiscountPercent: combinedPercent,
            discountCode: appDiscount?.code || null,
            discountApplied: combinedPercent > 0,
            stripeCouponIdIgnored: coupon || null,
            stripeCouponIdApplied: null,
            upgradeCouponMode: req.body.upgradeCouponMode || "auto",
          },
          planId,
        });
        return res.json({
          intentType: "none",
          clientSecret: null,
          status: "free",
          transactionId: tx._id,
        });
      }

      // ---------- UPGRADE FLOW (restart cycle, charge new minus credit) ----------
      const upgradeFromSubscriptionId = req.body.upgradeFromSubscriptionId;
      const upgradeCouponMode = (
        req.body.upgradeCouponMode || "auto"
      ).toLowerCase(); // "auto" | "stack" | "never"
      let creditCents = 0;

      if (upgradeFromSubscriptionId) {
        // 1) Read the old subscription
        const oldSub = await stripe.subscriptions.retrieve(
          upgradeFromSubscriptionId,
          { expand: ["items.data.price.product"] }
        );

        // Safety: old sub must belong to this customer
        if (oldSub.customer !== customerId) {
          return res
            .status(400)
            .json({ error: "Subscription/customer mismatch" });
        }

        // 2) Remaining-time credit (in cents) from old sub
        creditCents = computeUpgradeCreditCents(oldSub, finalCents);

        console.log("creditCents", creditCents);

        // 3) Negative invoice item (credit) for the NEXT invoice
        if (creditCents > 0) {
          await stripe.invoiceItems.create({
            customer: customerId,
            currency,
            amount: -creditCents,
            description: `Credit for unused time on ${planNameFromSub(oldSub)}`,
          });
        }

        // 4) Cancel old sub immediately WITHOUT Stripe proration
        await stripe.subscriptions.cancel(upgradeFromSubscriptionId, {
          prorate: false,
          invoice_now: false,
        });
      }

      // Coupon application policy
      const shouldApplyStripeCoupon =
        !!coupon &&
        (upgradeCouponMode === "stack"
          ? true // always apply coupon (stacks)
          : upgradeCouponMode === "never"
          ? false
          : combinedPercent === 0); // "auto": only when no merged % discount

      // ---------- Create the NEW subscription (cycle restarts now) ----------
      // DO NOT also pass Stripe coupons here (to avoid double-discount).
      // If you need backward compatibility, only use `coupon` when combinedPercent == 0.
      const createParams = {
        customer: customerId,
        items: [{ price: priceId }],
        payment_behavior: "default_incomplete",
        collection_method: "charge_automatically",
        payment_settings: {
          save_default_payment_method: "on_subscription",
          payment_method_types: ["card"],
        },
        expand: ["latest_invoice.payment_intent", "pending_setup_intent"],
        metadata: {
          userId,
          planId,
          planType,
          interval,
          currency,
          planName,
          priceId,
          productId,
          intervalCount: interval === "yearly" ? 12 : 1,
          // snapshot
          planBaseAmount: convertedBase,
          planDiscountPercent,
          promoDiscountPercent: promoPercent,
          combinedDiscountPercent: combinedPercent,
          discountCode: appDiscount?.code || "",
          // upgrade trace
          upgradeFromSubscriptionId: upgradeFromSubscriptionId || "",
          manualCreditCents: creditCents,
          // coupon trace
          stripeCouponIdApplied: shouldApplyStripeCoupon ? coupon : null,
          stripeCouponIdIgnored:
            !shouldApplyStripeCoupon && coupon ? coupon : null,
          upgradeCouponMode,
          effectiveChargeCents: Math.max(0, finalCents - creditCents),
          conversionRate,
          currencySource,
          ...metadata,
        },
      };

      // If you MUST keep supporting `coupon`, only apply it when we did NOT merge any discounts:
      if (shouldApplyStripeCoupon) {
        createParams.discounts = [{ coupon }];
      }

      const sub = await stripe.subscriptions.create(createParams);

      // Normalize invoice & intents
      let invoice = sub.latest_invoice;
      let setupIntent = sub.pending_setup_intent;

      if (typeof invoice === "string" || (invoice && !invoice.payment_intent)) {
        const invId = typeof invoice === "string" ? invoice : invoice.id;
        invoice = await stripe.invoices.retrieve(invId, {
          expand: ["payment_intent", "lines.data.price.product"],
        });
      }

      if (invoice?.status === "draft") {
        invoice = await stripe.invoices.finalizeInvoice(invoice.id, {
          expand: ["payment_intent", "lines.data.price.product"],
        });
      }

      let paymentIntent = invoice?.payment_intent || null;
      if (typeof paymentIntent === "string") {
        paymentIntent = await stripe.paymentIntents.retrieve(paymentIntent);
      }
      if (typeof setupIntent === "string") {
        setupIntent = await stripe.setupIntents.retrieve(setupIntent);
      }

      const firstLine = invoice?.lines?.data?.[0];

      const filter = {
        $or: [
          { "stripe.subscriptionId": sub.id },
          { "stripe.invoiceId": invoice?.id || "never" },
        ],
      };

      // Build updates using dot-paths (prevents whole-object overwrite)
      await Transaction.findOneAndUpdate(
        {
          $or: [
            { "stripe.subscriptionId": sub.id },
            { "stripe.invoiceId": invoice?.id || "never" },
          ],
        },
        {
          $set: {
            teacherId: userId,
            planType: "subscription",
            amount:
              typeof invoice?.amount_due === "number" ? invoice.amount_due : 0,
            currency,
            status: sub.status,
            customerName: customer?.name ?? null,
            customerAddress: customer?.address ?? null,
            planId,

            // stripe.*
            "stripe.customerId": customerId,
            "stripe.customerEmail": customer?.email || null,
            "stripe.subscriptionId": sub.id,
            "stripe.invoiceId": invoice?.id || null,
            "stripe.paymentIntentId": paymentIntent?.id || null,
            "stripe.priceId": priceId,
            "stripe.productId": productId,
            "stripe.planName": planName,
            "stripe.interval": interval === "yearly" ? "year" : "month",
            "stripe.intervalCount": interval === "yearly" ? 12 : 1,
            ...(firstLine?.period?.start
              ? {
                  "stripe.periodStart": new Date(firstLine.period.start * 1000),
                }
              : {}),
            ...(firstLine?.period?.end
              ? { "stripe.periodEnd": new Date(firstLine.period.end * 1000) }
              : {}),
            customerName: customer?.name || null,
            customerAddress: customer?.address || null,

            // metadata snapshot
            "metadata.planBaseAmount": baseDollars,
            "metadata.planDiscountPercent": planDiscountPercent,
            "metadata.promoDiscountPercent": promoPercent,
            "metadata.combinedDiscountPercent": combinedPercent,
            "metadata.discountCode": appDiscount?.code ?? null,
            "metadata.discountApplied": combinedPercent > 0,
            "metadata.subscriptionId": sub.id,
            "metadata.manualCreditCents": creditCents,
            "metadata.upgradeFromSubscriptionId":
              upgradeFromSubscriptionId || null,
            "metadata.stripeCouponIdApplied": shouldApplyStripeCoupon
              ? coupon
              : null,
            "metadata.stripeCouponIdIgnored":
              !shouldApplyStripeCoupon && coupon ? coupon : null,
            "metadata.upgradeCouponMode": upgradeCouponMode,
            "metadata.effectiveChargeCents": Math.max(
              0,
              finalCents - creditCents
            ),
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );

      if (paymentIntent?.client_secret) {
        return res.json({
          intentType: "payment",
          subscriptionId: sub.id,
          paymentIntentId: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
        });
      }

      if (setupIntent?.client_secret) {
        return res.json({
          intentType: "setup",
          subscriptionId: sub.id,
          setupIntentId: setupIntent.id,
          clientSecret: setupIntent.client_secret,
        });
      }

      if ((invoice?.amount_due ?? 0) > 0) {
        const createdSI = await stripe.setupIntents.create({
          customer: customerId,
          payment_method_types: ["card"],
          usage: "off_session",
          metadata: {
            userId,
            planId,
            subscriptionId: sub.id,
            invoiceId: invoice?.id || "",
            planName,
            priceId,
            productId,
            interval,
            intervalCount: interval === "yearly" ? 12 : 1,
            planBaseAmount: baseDollars,
            planDiscountPercent,
            promoDiscountPercent: promoPercent,
            combinedDiscountPercent: combinedPercent,
            discountCode: appDiscount?.code || "",
          },
        });
        return res.json({
          intentType: "setup",
          subscriptionId: sub.id,
          setupIntentId: createdSI.id,
          clientSecret: createdSI.client_secret,
        });
      }

      return res.json({
        intentType: "none",
        subscriptionId: sub.id,
        clientSecret: null,
        status: sub.status,
      });
    }

    return res.status(400).json({ error: "Invalid planType" });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
}

/** POST /api/billing/finish
 * Optional: confirm in your DB after client confirmation
 * Body: { paymentIntentId }
 */
export async function finish(req, res) {
  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId)
      return res.status(400).json({ error: "paymentIntentId required" });

    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    // TODO: mark order/subscription active in your DB using pi.metadata.userId etc.
    // This is optional. Prefer webhooks for reliability.
    res.json({ ok: true, status: pi.status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

export async function attachAndPay(req, res) {
  try {
    const { subscriptionId, paymentMethodId } = req.body || {};
    if (!subscriptionId)
      return res.status(400).json({ error: "subscriptionId required" });
    if (!paymentMethodId)
      return res.status(400).json({ error: "paymentMethodId required" });

    // 1) Load subscription/customer
    const sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice", "customer"],
    });
    const customerId =
      typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
    if (!customerId)
      return res.status(400).json({ error: "subscription has no customer" });

    // 2) Attach PM (ignore "already attached")
    try {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });
    } catch (e) {
      if (!(e?.code === "resource_already_exists")) throw e;
    }

    // 3) Set default PM for invoices
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // 4) Normalize / finalize invoice
    let invoice = sub.latest_invoice;
    if (typeof invoice === "string" || (invoice && !invoice.payment_intent)) {
      const invId = typeof invoice === "string" ? invoice : invoice.id;
      invoice = await stripe.invoices.retrieve(invId, {
        expand: ["payment_intent"],
      });
    }
    if (invoice?.status === "draft") {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id, {
        expand: ["payment_intent"],
      });
    }

    // 5) $0 due → nothing to pay
    if ((invoice?.amount_due ?? 0) === 0) {
      return res.json({
        ok: true,
        paid: invoice?.status === "paid",
        state: "no_charge_needed",
        invoice: {
          id: invoice?.id,
          status: invoice?.status,
          amount_due: invoice?.amount_due,
        },
      });
    }

    // 6) Pay using the just-attached PM
    await stripe.invoices.pay(invoice.id, { payment_method: paymentMethodId });

    // 7) Re-read invoice to inspect PI state
    const paidInvoice = await stripe.invoices.retrieve(invoice.id, {
      expand: ["payment_intent"],
    });

    let pi = paidInvoice.payment_intent || null;
    if (typeof pi === "string") pi = await stripe.paymentIntents.retrieve(pi);

    // 3DS needed => return client_secret for FE confirm
    if (
      pi &&
      (pi.status === "requires_action" || pi.status === "requires_confirmation")
    ) {
      return res.json({
        ok: false,
        paid: false,
        state: "requires_action",
        intentType: "payment",
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        invoice: {
          id: paidInvoice.id,
          status: paidInvoice.status,
          amount_due: paidInvoice.amount_due,
        },
      });
    }

    // Success
    if (
      (pi && (pi.status === "succeeded" || pi.status === "requires_capture")) ||
      paidInvoice.status === "paid"
    ) {
      return res.json({
        ok: true,
        paid: true,
        state: "paid",
        paymentIntentId: pi?.id || null,
        invoice: {
          id: paidInvoice.id,
          status: paidInvoice.status,
          amount_due: paidInvoice.amount_due,
        },
      });
    }

    // Still not paid (requires_payment_method, etc.)
    return res.json({
      ok: false,
      paid: false,
      state: pi?.status || paidInvoice.status || "unknown",
      invoice: {
        id: paidInvoice.id,
        status: paidInvoice.status,
        amount_due: paidInvoice.amount_due,
      },
    });
  } catch (e) {
    console.error("attach-and-pay error:", e);
    res.status(400).json({ error: e.message });
  }
}
/** POST /api/billing/webhook (raw body)
 * Set STRIPE_WEBHOOK_SECRET in .env and use Stripe CLI for local testing.
 */
export async function webhook(req, res) {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (sig && secret) {
      // req.body is raw Buffer when using express.raw({ type: 'application/json' })
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } else {
      // Dev/Postman: allow JSON body (not signed)
      event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    }
  } catch (err) {
    console.error("Webhook signature verification failed:", err?.message);
    return res.status(400).send(`Webhook Error: ${err?.message}`);
  }

  const summary = {
    received: true,
    eventId: event.id,
    eventType: event.type,
    paid: false,
    details: {},
  };

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const base = event.data.object;
        const pi = await stripe.paymentIntents.retrieve(base.id, {
          expand: ["charges.data.balance_transaction", "customer"],
        });

        await upsertFromPaymentIntent(pi, event.id);

        const charge = pi.charges?.data?.[0] || null;
        summary.paid = true;
        summary.details = {
          paymentIntentId: pi.id,
          paymentIntentStatus: pi.status,
          amount_received: pi.amount_received,
          currency: pi.currency,
          customerId:
            typeof pi.customer === "string"
              ? pi.customer
              : pi.customer?.id || null,
          chargeId: charge?.id || null,
          balanceTransactionId: charge?.balance_transaction || null,
          invoiceId:
            (typeof pi.invoice === "string" ? pi.invoice : pi.invoice?.id) ||
            null,
          metadata: pi.metadata || {},
        };
        break;
      }

      case "payment_intent.payment_failed": {
        const base = event.data.object;
        const pi = await stripe.paymentIntents.retrieve(base.id, {
          expand: ["last_payment_error", "customer"],
        });

        summary.paid = false;
        summary.details = {
          paymentIntentId: pi.id,
          paymentIntentStatus: pi.status,
          lastError: {
            code: pi.last_payment_error?.code || null,
            message: pi.last_payment_error?.message || null,
            type: pi.last_payment_error?.type || null,
          },
          customerId:
            typeof pi.customer === "string"
              ? pi.customer
              : pi.customer?.id || null,
          metadata: pi.metadata || {},
        };
        break;
      }

      case "invoice.payment_succeeded": {
        const base = event.data.object;

        // 1) Retrieve the invoice with rich expansions
        const invoice = await stripe.invoices.retrieve(base.id, {
          expand: [
            "lines.data.price.product", // price & product on each line
            "customer", // customer snapshot
            "subscription", // subscription object if possible
            "payment_intent.payment_method", // PI & PM (may be null)
            "payment_intent.charges.data.balance_transaction",
            "charge", // invoice-level charge (if any)
          ],
        });

        // 2) Robust subscription id (Stripe sometimes sticks this under parent)
        let subscriptionId =
          (typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription?.id) ||
          invoice?.parent?.subscription_details?.subscription ||
          null;

        // Load subscription when we need fallback price/product
        let subObj =
          typeof invoice.subscription === "object"
            ? invoice.subscription
            : null;
        if (!subObj && subscriptionId) {
          subObj = await stripe.subscriptions.retrieve(subscriptionId, {
            expand: ["items.data.price.product"],
          });
        }

        // 3) PI and Charge (either/both can be null on success)
        const pi =
          typeof invoice.payment_intent === "string"
            ? await stripe.paymentIntents.retrieve(invoice.payment_intent, {
                expand: [
                  "payment_method",
                  "customer",
                  "charges.data.balance_transaction",
                ],
              })
            : invoice.payment_intent || null;

        const charge =
          (typeof invoice.charge === "object" && invoice.charge) ||
          (invoice.charge && (await stripe.charges.retrieve(invoice.charge))) ||
          (pi?.charges?.data?.[0] ?? null);

        // 4) Metadata merge: invoice → parent.subscription_details.metadata → subscription → PI
        const meta = {
          ...(invoice.metadata || {}),
          ...(invoice?.parent?.subscription_details?.metadata || {}),
          ...(subObj?.metadata || {}),
          ...(pi?.metadata || {}),
        };

        // 5) Billing info: prefer invoice snapshot, then customer, then PM/charge
        const customer =
          typeof invoice.customer === "object" ? invoice.customer : null;
        const pm =
          typeof pi?.payment_method === "object" ? pi.payment_method : null;

        const customerName =
          invoice.customer_name ||
          customer?.name ||
          pm?.billing_details?.name ||
          charge?.billing_details?.name ||
          null;

        const customerEmail =
          invoice.customer_email ||
          customer?.email ||
          pm?.billing_details?.email ||
          charge?.billing_details?.email ||
          null;

        const customerAddress =
          mapAddress(invoice.customer_address) ||
          mapAddress(customer?.address) ||
          mapAddress(pm?.billing_details?.address) ||
          mapAddress(charge?.billing_details?.address) ||
          null;

        // 6) Find the subscription line on the invoice (best source of billed price)
        const lines = invoice.lines?.data || [];
        const subLine =
          lines.find((l) => l.type === "subscription" && l.price) ||
          lines.find((l) => l.price) ||
          lines[0] ||
          null;

        // Price/product from the line, else fallback to subscription.items[0]
        let price = subLine?.price || null;
        let productObj =
          price && typeof price.product === "object" ? price.product : null;

        if (!price && subObj?.items?.data?.length) {
          price = subObj.items.data[0].price || null;
          productObj =
            price && typeof price.product === "object"
              ? price.product
              : productObj;
        }

        // 7) Derive plan/price/product/interval
        const priceId = meta.priceId || price?.id || null;
        const productId =
          meta.productId ||
          (price?.product && typeof price.product === "string"
            ? price.product
            : productObj?.id) ||
          null;

        const planName =
          meta.planName || price?.nickname || productObj?.name || null;

        const interval = meta.interval || price?.recurring?.interval || null;
        const intervalCount =
          meta.intervalCount || price?.recurring?.interval_count || null;

        // Period window (if available on the invoiced sub line)
        const period = subLine?.period || {};
        const periodStart = period.start
          ? new Date(period.start * 1000)
          : undefined;
        const periodEnd = period.end ? new Date(period.end * 1000) : undefined;

        // 8) Build update (dot-paths; don't overwrite nested "stripe" doc)
        const update = {
          teacherId: meta.teacherId || meta.userId, // ensure you set one of these at sub-create
          customerUserId: meta.userId || undefined,
          planType: meta.planType || "subscription",
          amount:
            typeof invoice.amount_paid === "number"
              ? invoice.amount_paid
              : invoice.amount_due ?? 0,
          currency: invoice.currency,
          status: "paid",

          customerName,
          customerAddress,

          "stripe.eventId": event.id,
          "stripe.customerId":
            (typeof invoice.customer === "string"
              ? invoice.customer
              : customer?.id) || null,
          "stripe.customerEmail": customerEmail,
          "stripe.invoiceId": invoice.id,
          "stripe.subscriptionId": subscriptionId,
          "stripe.paymentIntentId":
            (typeof invoice.payment_intent === "string"
              ? invoice.payment_intent
              : pi?.id) || null,
          "stripe.chargeId": charge?.id || null,
          "stripe.balanceTransactionId":
            (typeof charge?.balance_transaction === "string"
              ? charge.balance_transaction
              : charge?.balance_transaction?.id) || null,

          "stripe.priceId": priceId,
          "stripe.productId": productId,
          "stripe.planName": planName,
          "stripe.interval": interval,
          "stripe.intervalCount": intervalCount,
        };
        if (periodStart) update["stripe.periodStart"] = periodStart;
        if (periodEnd) update["stripe.periodEnd"] = periodEnd;

        // 9) Upsert by invoiceId (primary) or paymentIntentId (secondary if present)
        const filter = {
          $or: [
            { "stripe.invoiceId": invoice.id },
            update["stripe.paymentIntentId"]
              ? { "stripe.paymentIntentId": update["stripe.paymentIntentId"] }
              : { _id: null },
          ],
        };

        await Transaction.findOneAndUpdate(
          filter,
          { $set: update },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await User.findByIdAndUpdate(update.teacherId, {
          $set: { isPaid: true },
        });

        // 10) Build response summary
        summary.paid = true;
        summary.details = {
          invoiceId: invoice.id,
          subscriptionId,
          paymentIntentId: update["stripe.paymentIntentId"],
          chargeId: update["stripe.chargeId"],
          amount_paid: invoice.amount_paid,
          currency: invoice.currency,
          planName,
          priceId,
          productId,
          interval,
          intervalCount,
          // helpful context
          billing_reason: invoice.billing_reason, // e.g., "subscription_create"
          number: invoice.number, // e.g., "E62A3566-0286"
          hosted_invoice_url: invoice.hosted_invoice_url, // useful to surface in UI
        };
        break;
      }

      case "invoice.payment_failed": {
        const base = event.data.object;
        const invoice = await stripe.invoices.retrieve(base.id, {
          expand: ["payment_intent", "customer"],
        });

        const pi =
          typeof invoice.payment_intent === "string"
            ? await stripe.paymentIntents.retrieve(invoice.payment_intent)
            : invoice.payment_intent;

        summary.paid = false;
        summary.details = {
          invoiceId: invoice.id,
          invoiceStatus: invoice.status,
          amount_due: invoice.amount_due,
          currency: invoice.currency,
          subscriptionId:
            (typeof invoice.subscription === "string"
              ? invoice.subscription
              : invoice.subscription?.id) || null,
          customerId:
            (typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id) || null,
          paymentIntentId: pi?.id || null,
          paymentIntentStatus: pi?.status || null,
          next_payment_attempt: invoice.next_payment_attempt || null,
          hosted_invoice_url: invoice.hosted_invoice_url || null,
        };
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const base = event.data.object;
        summary.details = {
          subscriptionId: base?.id || null,
          status: base?.status || null,
          customerId:
            (typeof base?.customer === "string"
              ? base?.customer
              : base?.customer?.id) || null,
        };
        break;
      }

      default: {
        summary.details = { note: "Unhandled event type" };
        break;
      }
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).json({
      received: false,
      eventId: event?.id,
      eventType: event?.type,
      error: err.message,
    });
  }
}

/** ----- Helpers to persist to Transaction ----- */

function mapAddress(addr) {
  if (!addr) return undefined;
  const out = {
    line1: addr.line1 || undefined,
    line2: addr.line2 || undefined,
    city: addr.city || undefined,
    state: addr.state || undefined,
    postal_code: addr.postal_code || undefined,
    country: addr.country || undefined,
  };
  // remove undefined keys
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return Object.keys(out).length ? out : undefined;
}

async function upsertFromPaymentIntent(pi, eventId) {
  const charge = (pi.charges && pi.charges.data && pi.charges.data[0]) || null;
  const balanceTransactionId = charge?.balance_transaction || null;

  const customerId =
    typeof pi.customer === "string" ? pi.customer : pi.customer?.id;

  const { userId, teacherId, planId, planType, interval } = pi.metadata || {};

  const amount = pi.amount_received ?? pi.amount;
  const currency = pi.currency;

  // Try to expand or fetch customer if needed (pi may already include it)
  let stripeCustomer = typeof pi.customer === "object" ? pi.customer : null;
  if (!stripeCustomer && customerId) {
    try {
      stripeCustomer = await stripe.customers.retrieve(customerId);
    } catch (_) {}
  }

  // Prefer billing_details from PM; then from the charge; then fall back
  const pm = typeof pi.payment_method === "object" ? pi.payment_method : null;
  const billingDetails = pm?.billing_details || charge?.billing_details || {};

  const customerEmail =
    billingDetails.email ||
    pi.receipt_email ||
    stripeCustomer?.email ||
    undefined;

  // ✅ Prefer the *payer-entered* values over the stored Stripe Customer profile
  const customerName = billingDetails.name || stripeCustomer?.name || undefined;
  const customerPhone =
    billingDetails.phone || stripeCustomer?.phone || undefined;
  const customerAddr =
    mapAddress(billingDetails.address) || mapAddress(stripeCustomer?.address);

  const update = {
    teacherId: teacherId, // your schema
    customerUserId: userId || undefined,
    planType: planType || "one_time",
    amount,
    currency,
    status: "paid",

    customerName,
    customerAddress: customerAddr,

    stripe: {
      eventId,
      customerId,
      customerEmail,
      paymentIntentId: pi.id,
      chargeId: charge?.id,
      balanceTransactionId,
      planName: pi.metadata?.planName,
      priceId: pi.metadata?.priceId,
      productId: pi.metadata?.productId,
      interval:
        interval === "yearly"
          ? "year"
          : interval === "monthly"
          ? "month"
          : undefined,
      intervalCount:
        interval === "yearly" ? 12 : interval === "monthly" ? 1 : undefined,
    },
  };

  await Transaction.findOneAndUpdate(
    {
      $or: [
        { "stripe.paymentIntentId": pi.id },
        balanceTransactionId
          ? { "stripe.balanceTransactionId": balanceTransactionId }
          : { _id: null },
      ],
    },
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// ---------- GET: all transactions of a teacher ----------
export const getTeacherTransactions = async (req, res) => {
  try {
    const teacherId = req.params.teacherId;
    if (!teacherId) return res.status(400).json({ error: "Invalid teacherId" });

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);

    const [items, total] = await Promise.all([
      Transaction.find({ teacherId })
        .populate("planId")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Transaction.countDocuments({ teacherId }),
    ]);

    const data = items.map((t) => ({
      transactionId: t._id,
      planType: t.planType,
      plan: t?.stripe?.planName || "",
      name: t?.customerName || "",
      duration: t?.stripe?.interval,
      userAddress: t?.customerAddress || null,
      stripe: {
        invoiceId: t?.stripe?.invoiceId || "",
        paymentIntentId: t?.stripe?.paymentIntentId || "",
        chargeId: t?.stripe?.chargeId || "",
        balanceTransactionId: t?.stripe?.balanceTransactionId || "",
        subscriptionId: t?.stripe?.subscriptionId || "",
        periodEnd: t?.stripe?.periodEnd || null,
        periodStart: t?.stripe?.periodStart || null,
      },
      planId: t.planId,
    }));

    return res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};
export const getAllTransactions = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);

    const [items, total] = await Promise.all([
      Transaction.find()
        .populate("planId")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Transaction.countDocuments(),
    ]);

    const data = items.map((t) => ({
      transactionId: t._id,
      planType: t.planType,
      plan: t?.stripe?.planName || "",
      name: t?.customerName || "",
      duration: t?.stripe?.interval,
      userAddress: t?.customerAddress || null,
      stripe: {
        invoiceId: t?.stripe?.invoiceId || "",
        paymentIntentId: t?.stripe?.paymentIntentId || "",
        chargeId: t?.stripe?.chargeId || "",
        balanceTransactionId: t?.stripe?.balanceTransactionId || "",
        subscriptionId: t?.stripe?.subscriptionId || "",
        periodEnd: t?.stripe?.periodEnd || null,
        periodStart: t?.stripe?.periodStart || null,
      },
      planId: t.planId,
    }));

    return res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};
export async function getPaymentIntent(req, res) {
  try {
    const pi = await stripe.paymentIntents.retrieve(req.params.id);
    res.json(pi);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}
