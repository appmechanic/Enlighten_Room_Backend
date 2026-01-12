import stripe from "../config/stripe.js";
import User from "../models/user.js";
import Plan from "../models/PlanModel.js";
import PaymentLog from "../models/PaymentLogModel.js";
import Transaction from "../models/transactionModel.js";
import Subscription from "../models/SubscriptionModel.js";
import Coupon from "../models/couponModel.js";
import CurrencyRate from "../models/CurrencyRate.js";

// ============================================
// HELPER FUNCTIONS FOR CURRENCY & PRICING
// ============================================

/**
 * Get base price in dollars for a plan
 * @param {Object} planDoc - Plan document from DB
 * @param {String} interval - "monthly" or "yearly"
 * @returns {Number} Price in dollars
 */
function getPlanBaseDollars(planDoc, interval) {
  if (!planDoc) return 0;
  return interval === "yearly"
    ? planDoc.priceYearly || planDoc.priceMonthly || 0
    : planDoc.priceMonthly || 0;
}

/**
 * Normalize percentage value (convert decimal to 0..100 range)
 * @param {Number} value - Raw percentage value (could be 20 or 0.2)
 * @returns {Number} Normalized percentage (0..100)
 */
function normalizePercent(value) {
  if (!value || typeof value !== "number") return 0;
  // If value is between 0 and 1, assume it's a decimal (0.2 = 20%)
  if (value > 0 && value < 1) {
    return value * 100;
  }
  // Otherwise assume it's already in 0..100 range
  return Math.min(value, 100);
}

/**
 * Clamp percentage to max 100%
 * @param {Number} percent - Percentage value
 * @returns {Number} Clamped percentage (0..100)
 */
function clampPct(percent) {
  return Math.max(0, Math.min(percent, 100));
}

/**
 * Get active app discount by code
 * @param {String} discountCode - Coupon code
 * @returns {Promise<Object|null>} { code, percent } or null
 */
async function getActiveAppDiscount(discountCode) {
  if (!discountCode) return null;
  try {
    const coupon = await Coupon.findOne({
      code: String(discountCode).toUpperCase().trim(),
      isActive: true,
      expiresAt: { $gt: new Date() },
    }).lean();

    if (coupon && coupon.discountPercent > 0 && coupon.discountPercent <= 100) {
      return {
        code: coupon.code,
        percent: coupon.discountPercent,
      };
    }
  } catch (err) {
    console.error("Error fetching app discount:", err);
  }
  return null;
}

/**
 * Calculate final price in cents after discount
 * @param {Number} baseDollars - Base price in dollars
 * @param {Number} discountPercent - Discount percentage (0..100)
 * @returns {Number} Final price in cents
 */
function discountedCentsFromDollars(baseDollars, discountPercent) {
  const discountFraction = clampPct(discountPercent) / 100;
  const discountedDollars = baseDollars * (1 - discountFraction);
  return Math.round(discountedDollars * 100);
}

// ============================================
// PAYMENT INTENT & CHECKOUT
// ============================================

/**
 * Create a Stripe checkout session
 * POST /api/payments/intent
 * Body: { userId, planId, interval, couponCode }
 */
export const createPaymentIntent = async (req, res) => {
  try {
    const { userId, planId, interval = "monthly", couponCode } = req.body;

    console.log("Creating checkout session:", {
      userId,
      planId,
      interval,
      couponCode,
    });

    // Validate inputs
    if (!userId || !planId) {
      return res
        .status(400)
        .json({ success: false, error: "userId and planId are required" });
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Get plan
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ success: false, error: "Plan not found" });
    }

    // Validate coupon if provided
    let coupon = null;
    let discountAmount = 0;
    let discounts = null;

    if (couponCode) {
      coupon = await Coupon.findOne({
        code: String(couponCode).toUpperCase().trim(),
      });

      const now = new Date();

      // Check if coupon is valid
      const isInvalid =
        !coupon ||
        !coupon?.isActive ||
        coupon?.expiresAt < now ||
        (coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses);

      if (isInvalid) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid or expired coupon" });
      }
    }

    // 2) Build the **base price in dollars**
    const baseDollars = getPlanBaseDollars(plan, interval); // e.g., 20.00

    // --- Currency conversion logic ---
    // Fetch latest currency rates from DB
    let convertedBase = baseDollars;
    let conversionRate = 1;
    let currencySource = "USD";
    const currency = req.body.currency || "USD"; // Get currency from request

    try {
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
    const planDiscountPercent = normalizePercent(plan?.discountPrice); // e.g., 20 (or 0.2)
    const appDiscount = await getActiveAppDiscount(couponCode); // { code, percent } | null
    const promoPercent = normalizePercent(appDiscount?.percent || 0); // e.g., 30

    // 4) Merge → combined percentage (cap at 100)
    const combinedPercent = clampPct(planDiscountPercent + promoPercent); // e.g., 50

    console.log("Pricing calculation:", {
      baseDollars,
      conversionRate,
      convertedBase,
      currencySource,
      planDiscountPercent,
      promoPercent,
      combinedPercent,
    });

    // 5) Apply combined % **directly on converted amount**, then convert to **cents**
    const finalCents = discountedCentsFromDollars(
      convertedBase,
      combinedPercent
    );

    // Prepare line items with calculated amount
    const amountInCents = finalCents;

    // Get or create Stripe customer
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.firstName} ${user.lastName}`,
        metadata: {
          userId: userId,
        },
      });
      stripeCustomerId = customer.id;

      // Update user with Stripe customer ID
      await User.findByIdAndUpdate(userId, { stripeCustomerId });
    }

    // Handle 100% free coupon
    if (appDiscount && appDiscount.percent === 100) {
      // 100% FREE COUPON - Skip Stripe, create subscription directly
      const now = new Date();
      const endDate = new Date(now);
      if (interval === "yearly") {
        endDate.setFullYear(endDate.getFullYear() + 1);
      } else {
        endDate.setMonth(endDate.getMonth() + 1);
      }

      // Create subscription with free coupon
      const subscription = await Subscription.create({
        userId: user._id,
        planType: planId,
        status: "active",
        frequency: interval === "yearly" ? "yearly" : "monthly",
        currency: currencySource,
        promoCode: appDiscount.code,
      });

      // Mark user as paid
      await User.findByIdAndUpdate(userId, { isPaid: true });

      // Increment coupon usage
      if (appDiscount.code) {
        await Coupon.updateOne(
          { code: appDiscount.code },
          { $inc: { usedCount: 1 } }
        );
      }

      // Log transaction
      await Transaction.create({
        userId,
        planId,
        amount: 0,
        currency: currencySource,
        status: "succeeded",
        type: "payment",
        planName: plan.planType || plan.name,
        interval,
        description: `Free access granted via ${appDiscount.code} coupon`,
        couponCode: appDiscount.code,
      });

      return res.status(200).json({
        success: true,
        free: true,
        message: "Access granted via 100% coupon",
        subscriptionId: subscription._id,
        redirectUrl: process.env.FRONTEND_URL,
      });
    }

    // Build product data
    const productData = {
      name: plan.planType || plan.name,
      metadata: {
        planId: String(planId),
      },
    };

    // Only add description if it exists and is not empty
    if (plan.description && plan.description.trim()) {
      productData.description = plan.description;
    }

    const lineItems = [
      {
        price_data: {
          currency: currencySource.toLowerCase(),
          product_data: productData,
          unit_amount: amountInCents,
          recurring: {
            interval: interval === "yearly" ? "year" : "month",
            interval_count: 1,
          },
        },
        quantity: 1,
      },
    ];

    // Prepare session config
    const sessionConfig = {
      mode: "subscription",
      customer: stripeCustomerId,
      client_reference_id: String(user._id),
      line_items: lineItems,
      success_url: `${process.env.FRONTEND_URL}/subscription/success`,
      cancel_url: `${process.env.FRONTEND_URL}/subscription/failure`,
      metadata: {
        userId,
        planId,
        planName: plan.planType || plan.name,
        interval,
        couponCode: appDiscount?.code || "",
        currency: currencySource,
        conversionRate: conversionRate.toString(),
        baseDollars: baseDollars.toString(),
        discountPercent: combinedPercent.toString(),
      },
    };

    // Add discount if applicable (note: combinedPercent is already merged plan + promo)
    if (combinedPercent > 0 && combinedPercent < 100 && appDiscount) {
      // Create or use Stripe coupon/discount
      sessionConfig.discounts = [
        {
          coupon: appDiscount.code,
        },
      ];
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create(sessionConfig);

    // Calculate final amount for logging
    const finalAmountDollars = convertedBase * (1 - combinedPercent / 100);

    // Log the session creation with all details
    await PaymentLog.create({
      userId,
      amount: finalAmountDollars,
      currency: currencySource,
      status: "initiated",
      description: `Checkout session created for ${
        plan.planType || plan.name
      } (${interval}) - ${currencySource} ${finalAmountDollars.toFixed(2)}${
        appDiscount
          ? ` - Coupon: ${appDiscount.code} (${combinedPercent}% off)`
          : ""
      }`,
    });

    return res.status(200).json({
      success: true,
      sessionId: session.id,
      url: session.url,
      planName: plan.planType || plan.name,
      planDescription: plan.description,
      features: plan.features || [],
      billingCycle: interval === "yearly" ? "year" : "month",
      basePriceUSD: baseDollars,
      finalPrice: finalAmountDollars,
      currency: currencySource,
      conversionRate,
      discountPercent: combinedPercent,
      interval: interval,
      couponApplied: !!appDiscount,
      couponCode: appDiscount?.code || null,
    });
  } catch (error) {
    console.error("Checkout session error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// PLAN PRICING & DETAILS
// ============================================

/**
 * Get plan pricing details
 * GET /api/payments/plans/:planId?interval=monthly
 */
export const getPlanPricing = async (req, res) => {
  try {
    const { planId } = req.params;
    const { interval = "monthly" } = req.query;

    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ success: false, error: "Plan not found" });
    }

    const price =
      interval === "yearly"
        ? plan.priceYearly || plan.priceMonthly
        : plan.priceMonthly;
    const stripePriceId =
      interval === "yearly"
        ? plan.stripePriceIdYearly
        : plan.stripePriceIdMonthly;

    return res.status(200).json({
      success: true,
      planId: plan._id,
      planName: plan.planType || plan.name,
      description: plan.description,
      price,
      currency: "USD",
      billingCycle: interval === "yearly" ? "year" : "month",
      billingText: interval === "yearly" ? "per year" : "per month",
      features: plan.features || [],
      stripePriceId,
    });
  } catch (error) {
    console.error("Get plan pricing error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// PAYMENT STATUS & HISTORY
// ============================================

/**
 * Get user payment status
 * GET /api/payments/status/:userId
 */
export const getPaymentStatus = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Get transaction history
    const transactions = await Transaction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(10);

    // Get all transactions for count
    const allTransactions = await Transaction.find({ userId });

    return res.status(200).json({
      success: true,
      userId,
      isPaid: user.isPaid || false,
      hasStripeCustomer: !!user.stripeCustomerId,
      stripeCustomerId: user.stripeCustomerId,
      lastTransaction: transactions[0] || null,
      totalTransactions: allTransactions.length,
      recentTransactions: transactions,
    });
  } catch (error) {
    console.error("Get payment status error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// WEBHOOK HANDLERS
// ============================================

/**
 * Handle Stripe webhook events
 * POST /api/payments/webhook
 */
/**
 * Handle Stripe webhook events
 * POST /api/payments/webhook
 * Body: { event } OR Query: ?sessionId=cs_test_...
 */
export const handlePaymentWebhook = async (req, res) => {
  let event;
  const summary = {
    received: true,
    eventId: null,
    eventType: null,
    paid: false,
    details: {},
  };

  try {
    // Check if sessionId passed as query parameter
    const { sessionId } = req.query;

    if (sessionId) {
      // Retrieve session details from Stripe and construct event
      console.log("Processing checkout session from sessionId:", sessionId);

      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: [
          "subscription",
          "customer",
          "line_items.data.price.product",
          "payment_intent",
        ],
      });

      // Construct event object for processing
      event = {
        id: `evt_${Date.now()}`,
        type: "checkout.session.completed",
        data: {
          object: session,
        },
      };
    } else {
      // Standard webhook event from Stripe
      event = req.body;

      // Verify Stripe signature if available
      const sig = req.headers["stripe-signature"];
      const secret = process.env.STRIPE_WEBHOOK_SECRET;

      if (sig && secret) {
        try {
          event = stripe.webhooks.constructEvent(req.body, sig, secret);
        } catch (err) {
          console.warn("Webhook signature verification skipped:", err.message);
          // Continue with unverified event (for development)
        }
      }
    }

    summary.eventId = event.id;
    summary.eventType = event.type;

    // Process the event
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompletedEnhanced(
          event.data.object,
          summary
        );
        break;

      case "invoice.payment_succeeded":
        await handleInvoicePaymentSucceededEnhanced(
          event.data.object,
          event.id,
          summary
        );
        break;

      case "payment_intent.succeeded":
        await handlePaymentIntentSucceededEnhanced(event.data.object, summary);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentFailedEnhanced(event.data.object, summary);
        break;

      case "charge.refunded":
        await handleChargeRefundedEnhanced(event.data.object, summary);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
        summary.details = { note: "Unhandled event type" };
    }

    res.status(200).json(summary);
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({
      received: false,
      eventId: summary.eventId,
      eventType: summary.eventType,
      error: error.message,
    });
  }
};

/**
 * Handle checkout session completed with enhanced details retrieval
 */
async function handleCheckoutSessionCompletedEnhanced(session, summary) {
  try {
    console.log("Processing checkout session completed:", {
      sessionId: session.id,
      customerId: session.customer,
      subscriptionId: session.subscription,
      paymentStatus: session.payment_status,
    });

    // Verify payment was successful
    if (session.payment_status !== "paid") {
      console.log(
        `Payment not completed for session ${session.id}, status: ${session.payment_status}`
      );
      summary.paid = false;
      return;
    }

    const userId = session.client_reference_id;
    if (!userId) {
      console.log("No user ID in session client_reference_id");
      summary.details = { error: "No user ID provided" };
      return;
    }

    // Retrieve full session with expansions
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: [
        "subscription",
        "customer",
        "line_items.data.price.product",
        "payment_intent.charges.data.balance_transaction",
      ],
    });

    // Extract subscription details
    const subscriptionId =
      typeof fullSession.subscription === "string"
        ? fullSession.subscription
        : fullSession.subscription?.id;

    let subscription = null;
    if (subscriptionId) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price.product"],
      });
    }

    // Extract customer details
    const customer =
      typeof fullSession.customer === "object" ? fullSession.customer : null;

    // Extract payment intent details
    const paymentIntent =
      typeof fullSession.payment_intent === "object"
        ? fullSession.payment_intent
        : null;

    const charge = paymentIntent?.charges?.data?.[0] || null;

    // Extract line items and pricing
    const lineItems = fullSession.line_items?.data || [];
    const subLine = lineItems.find((l) => l.price) || lineItems[0] || null;

    const price = subLine?.price || null;
    const productObj =
      price && typeof price.product === "object" ? price.product : null;

    const priceId = price?.id || null;
    const productId = productObj?.id || null;
    const planName = price?.nickname || productObj?.name || null;
    const interval = price?.recurring?.interval || null;
    const intervalCount = price?.recurring?.interval_count || null;

    // Extract metadata
    const metadata = {
      ...fullSession.metadata,
      ...(subscription?.metadata || {}),
      ...(paymentIntent?.metadata || {}),
    };

    // Mark user as paid
    await User.findByIdAndUpdate(userId, { isPaid: true });

    // Create or update subscription record in our database
    if (subscriptionId) {
      const planId = metadata.planId || null;

      // Map interval to frequency field required by schema
      const frequency = interval === "year" ? "yearly" : "monthly";

      await Subscription.findOneAndUpdate(
        { userId },
        {
          $set: {
            userId,
            planType: planId || metadata.planId,
            status: "active",
            frequency: frequency,
            currency: fullSession.currency || "usd",
            promoCode: metadata.couponCode || null,
          },
        },
        { upsert: true, new: true }
      );
    }

    // Update PaymentLog
    await PaymentLog.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          amount: (fullSession.amount_total || 0) / 100,
          currency: fullSession.currency || "usd",
          status: "succeeded",
          description: `Checkout session payment for ${
            planName || "subscription"
          }`,
        },
      },
      { upsert: true }
    );

    // Build comprehensive summary
    summary.paid = true;
    summary.details = {
      sessionId: session.id,
      customerId: customer?.id || null,
      customerEmail: customer?.email || null,
      customerName: customer?.name || null,
      subscriptionId,
      paymentIntentId: paymentIntent?.id || null,
      chargeId: charge?.id || null,
      balanceTransactionId:
        typeof charge?.balance_transaction === "string"
          ? charge.balance_transaction
          : charge?.balance_transaction?.id || null,
      amount_total: fullSession.amount_total,
      currency: fullSession.currency,
      planName,
      priceId,
      productId,
      interval,
      intervalCount,
      billing_reason: "subscription_create",
      metadata,
    };

    console.log(`Checkout session completed for user ${userId}: ${session.id}`);
  } catch (error) {
    console.error("Error handling checkout session completed:", error);
    summary.paid = false;
    summary.details = { error: error.message };
  }
}

/**
 * Handle invoice payment succeeded with enhanced details retrieval
 */
async function handleInvoicePaymentSucceededEnhanced(
  invoice,
  eventId,
  summary
) {
  try {
    console.log("Processing invoice payment succeeded:", {
      invoiceId: invoice.id,
      subscription: invoice.subscription,
      amount_paid: invoice.amount_paid,
    });

    // Retrieve full invoice with expansions
    const fullInvoice = await stripe.invoices.retrieve(invoice.id, {
      expand: [
        "lines.data.price.product",
        "customer",
        "subscription",
        "payment_intent.payment_method",
        "payment_intent.charges.data.balance_transaction",
        "charge",
      ],
    });

    // Extract subscription ID
    let subscriptionId =
      typeof fullInvoice.subscription === "string"
        ? fullInvoice.subscription
        : fullInvoice.subscription?.id;

    let subscription =
      typeof fullInvoice.subscription === "object"
        ? fullInvoice.subscription
        : null;

    if (!subscription && subscriptionId) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price.product"],
      });
    }

    // Extract payment intent and charge
    const paymentIntent =
      typeof fullInvoice.payment_intent === "object"
        ? fullInvoice.payment_intent
        : null;

    const charge =
      typeof fullInvoice.charge === "object"
        ? fullInvoice.charge
        : paymentIntent?.charges?.data?.[0] || null;

    // Extract customer details
    const customer =
      typeof fullInvoice.customer === "object" ? fullInvoice.customer : null;

    // Merge metadata from all sources
    const metadata = {
      ...fullInvoice.metadata,
      ...(fullInvoice?.parent?.subscription_details?.metadata || {}),
      ...(subscription?.metadata || {}),
      ...(paymentIntent?.metadata || {}),
    };

    // Extract billing details
    const customerName =
      fullInvoice.customer_name ||
      customer?.name ||
      paymentIntent?.payment_method?.billing_details?.name ||
      charge?.billing_details?.name ||
      null;

    const customerEmail =
      fullInvoice.customer_email ||
      customer?.email ||
      paymentIntent?.payment_method?.billing_details?.email ||
      charge?.billing_details?.email ||
      null;

    // Find subscription line
    const lines = fullInvoice.lines?.data || [];
    const subLine =
      lines.find((l) => l.type === "subscription" && l.price) ||
      lines.find((l) => l.price) ||
      lines[0] ||
      null;

    const price = subLine?.price || null;
    const productObj =
      price && typeof price.product === "object" ? price.product : null;

    const priceId = metadata.priceId || price?.id || null;
    const productId =
      metadata.productId ||
      (typeof price?.product === "string" ? price.product : productObj?.id) ||
      null;

    const planName =
      metadata.planName || price?.nickname || productObj?.name || null;

    const interval = metadata.interval || price?.recurring?.interval || null;
    const intervalCount =
      metadata.intervalCount || price?.recurring?.interval_count || null;

    // Extract userId from metadata
    const userId = metadata.userId || metadata.teacherId || null;
    const planId = metadata.planId || null;

    if (!userId) {
      console.log("No userId found in invoice metadata");
      summary.details = { error: "No userId in metadata" };
      return;
    }

    // Mark user as paid
    await User.findByIdAndUpdate(userId, { isPaid: true });

    // Create or update subscription record
    if (subscriptionId) {
      // Map interval to frequency field required by schema
      const frequency = interval === "year" ? "yearly" : "monthly";

      await Subscription.findOneAndUpdate(
        { userId },
        {
          $set: {
            userId,
            planType: planId,
            status: "active",
            frequency: frequency,
            currency: fullInvoice.currency || "usd",
            promoCode: metadata.couponCode || null,
          },
        },
        { upsert: true, new: true }
      );
    }

    // Create transaction record
    const transaction = await Transaction.create({
      userId,
      planId,
      stripeInvoiceId: fullInvoice.id,
      stripeSubscriptionId: subscriptionId,
      stripePaymentIntentId: paymentIntent?.id || null,
      stripeChargeId: charge?.id || null,
      transactionId: fullInvoice.id,
      amount: fullInvoice.amount_paid / 100,
      currency: fullInvoice.currency.toUpperCase(),
      status: "succeeded",
      type: "payment",
      planName: planName || "Unknown Plan",
      interval,
      description: `Invoice payment succeeded for ${planName} subscription`,
      couponCode: metadata.couponCode || null,
      discountAmount: metadata.discountAmount || 0,
      metadata: metadata,
    });

    // Update PaymentLog
    await PaymentLog.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          amount: fullInvoice.amount_paid / 100,
          currency: fullInvoice.currency || "usd",
          status: "succeeded",
          description: `Invoice payment for ${planName || "subscription"}`,
        },
      },
      { upsert: true }
    );

    // Increment coupon usage if used
    if (metadata.couponCode) {
      await Coupon.updateOne(
        { code: metadata.couponCode.toUpperCase().trim() },
        { $inc: { usedCount: 1 } }
      );
    }

    // Build comprehensive summary
    summary.paid = true;
    summary.details = {
      invoiceId: fullInvoice.id,
      subscriptionId,
      customerId: customer?.id || null,
      customerEmail,
      customerName,
      paymentIntentId: paymentIntent?.id || null,
      chargeId: charge?.id || null,
      balanceTransactionId:
        typeof charge?.balance_transaction === "string"
          ? charge.balance_transaction
          : charge?.balance_transaction?.id || null,
      amount_paid: fullInvoice.amount_paid,
      currency: fullInvoice.currency,
      planName,
      priceId,
      productId,
      interval,
      intervalCount,
      billing_reason: fullInvoice.billing_reason,
      invoice_number: fullInvoice.number,
      hosted_invoice_url: fullInvoice.hosted_invoice_url,
      transactionId: transaction._id,
      metadata,
    };

    console.log(
      `Invoice payment succeeded for user ${userId}: ${fullInvoice.id}`
    );
  } catch (error) {
    console.error("Error handling invoice payment succeeded:", error);
    summary.paid = false;
    summary.details = { error: error.message };
  }
}

/**
 * Handle payment intent succeeded with enhanced details
 */
async function handlePaymentIntentSucceededEnhanced(paymentIntent, summary) {
  try {
    console.log("Processing payment intent succeeded:", {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
    });

    // Retrieve full payment intent with expansions
    const fullPI = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ["charges.data.balance_transaction", "customer", "invoice"],
    });

    const charge = fullPI.charges?.data?.[0] || null;
    const customer =
      typeof fullPI.customer === "object" ? fullPI.customer : null;

    const metadata = fullPI.metadata || {};
    const userId = metadata.userId || metadata.teacherId || null;
    const planId = metadata.planId || null;

    if (userId) {
      // Mark user as paid
      await User.findByIdAndUpdate(userId, { isPaid: true });

      // Create transaction
      const transaction = await Transaction.create({
        userId,
        planId,
        stripePaymentIntentId: fullPI.id,
        stripeChargeId: charge?.id || null,
        transactionId: fullPI.id,
        amount: fullPI.amount_received / 100,
        currency: fullPI.currency.toUpperCase(),
        status: "succeeded",
        type: "payment",
        planName: metadata.planName || "Unknown Plan",
        interval: metadata.interval || null,
        description: `Payment succeeded for ${metadata.planName}`,
        couponCode: metadata.couponCode || null,
        discountAmount: metadata.discountAmount || 0,
        metadata,
      });
    }

    // Build summary
    summary.paid = true;
    summary.details = {
      paymentIntentId: fullPI.id,
      paymentIntentStatus: fullPI.status,
      amount_received: fullPI.amount_received,
      currency: fullPI.currency,
      customerId: customer?.id || null,
      chargeId: charge?.id || null,
      balanceTransactionId:
        typeof charge?.balance_transaction === "string"
          ? charge.balance_transaction
          : charge?.balance_transaction?.id || null,
      invoiceId:
        typeof fullPI.invoice === "string"
          ? fullPI.invoice
          : fullPI.invoice?.id,
      metadata,
    };

    console.log(`Payment intent succeeded: ${fullPI.id}`);
  } catch (error) {
    console.error("Error handling payment intent succeeded:", error);
    summary.paid = false;
    summary.details = { error: error.message };
  }
}

/**
 * Handle payment failed with enhanced details
 */
async function handlePaymentFailedEnhanced(paymentIntent, summary) {
  try {
    console.log("Processing payment failed:", {
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
    });

    // Retrieve full payment intent
    const fullPI = await stripe.paymentIntents.retrieve(paymentIntent.id, {
      expand: ["last_payment_error", "customer"],
    });

    const customer =
      typeof fullPI.customer === "object" ? fullPI.customer : null;
    const metadata = fullPI.metadata || {};
    const userId = metadata.userId || metadata.teacherId || null;
    const planId = metadata.planId || null;

    if (userId) {
      // Create failed transaction record
      await Transaction.create({
        userId,
        planId,
        stripePaymentIntentId: fullPI.id,
        transactionId: fullPI.id,
        amount: fullPI.amount / 100,
        currency: fullPI.currency.toUpperCase(),
        status: "failed",
        type: "payment",
        planName: metadata.planName || "Unknown Plan",
        interval: metadata.interval || null,
        description: `Payment failed: ${
          fullPI.last_payment_error?.message || "Unknown error"
        }`,
        errorMessage: fullPI.last_payment_error?.message || null,
        errorCode: fullPI.last_payment_error?.code || null,
        metadata,
      });
    }

    // Build summary
    summary.paid = false;
    summary.details = {
      paymentIntentId: fullPI.id,
      paymentIntentStatus: fullPI.status,
      amount: fullPI.amount,
      currency: fullPI.currency,
      customerId: customer?.id || null,
      lastError: {
        code: fullPI.last_payment_error?.code || null,
        message: fullPI.last_payment_error?.message || null,
        type: fullPI.last_payment_error?.type || null,
      },
      metadata,
    };

    console.log(`Payment failed: ${fullPI.id}`);
  } catch (error) {
    console.error("Error handling payment failed:", error);
    summary.paid = false;
    summary.details = { error: error.message };
  }
}

/**
 * Handle charge refunded with enhanced details
 */
async function handleChargeRefundedEnhanced(charge, summary) {
  try {
    console.log("Processing charge refunded:", {
      chargeId: charge.id,
      amount: charge.amount,
    });

    // Find original transaction
    const originalTransaction = await Transaction.findOne({
      stripeChargeId: charge.id,
    });

    if (!originalTransaction) {
      console.log(`No original transaction found for charge ${charge.id}`);
      summary.details = { note: "No original transaction found" };
      return;
    }

    // Get refund reason
    const refundReason = charge.refunds?.data?.[0]?.reason || "unknown";

    // Create refund transaction
    const refundTransaction = await Transaction.create({
      userId: originalTransaction.userId,
      planId: originalTransaction.planId,
      stripeChargeId: charge.id,
      transactionId: `refund_${charge.id}`,
      amount: charge.amount / 100,
      currency: (charge.currency || "usd").toUpperCase(),
      status: "refunded",
      type: "refund",
      planName: originalTransaction.planName,
      interval: originalTransaction.interval,
      refundReason,
      description: `Refund processed: ${refundReason}`,
    });

    // Build summary
    summary.paid = false;
    summary.details = {
      chargeId: charge.id,
      amount_refunded: charge.amount,
      currency: charge.currency,
      refundReason,
      originalTransactionId: originalTransaction._id,
      refundTransactionId: refundTransaction._id,
    };

    console.log(
      `Charge refunded for user ${originalTransaction.userId}: ${charge.id}`
    );
  } catch (error) {
    console.error("Error handling charge refunded:", error);
    summary.paid = false;
    summary.details = { error: error.message };
  }
}

// ============================================
// LEGACY PAYMENT LOG FUNCTIONS
// ============================================

// CREATE
export const createPaymentLog = async (req, res) => {
  try {
    const newLog = new PaymentLog(req.body);
    await newLog.save();
    res.status(201).json({ success: true, data: newLog });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// READ ALL (with optional userId filter)
export const getAllPaymentLogs = async (req, res) => {
  const { userId } = req.query;
  const filter = userId ? { userId } : {};

  try {
    const logs = await PaymentLog.find(filter).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// READ ONE
export const getPaymentLogById = async (req, res) => {
  try {
    const log = await PaymentLog.findById(req.params.id);
    if (!log)
      return res
        .status(404)
        .json({ success: false, error: "Payment log not found" });

    res.status(200).json({ success: true, data: log });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

export const getPaymentsByUserId = async (req, res) => {
  try {
    const logs = await PaymentLog.find({ userId: req.params.userId }).populate(
      "subscriptionId"
    );
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// UPDATE
export const updatePaymentLog = async (req, res) => {
  try {
    const updatedLog = await PaymentLog.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true }
    );

    if (!updatedLog)
      return res
        .status(404)
        .json({ success: false, error: "Payment log not found" });

    res.status(200).json({ success: true, data: updatedLog });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE
export const deletePaymentLog = async (req, res) => {
  try {
    const deletedLog = await PaymentLog.findByIdAndDelete(req.params.id);
    if (!deletedLog)
      return res
        .status(404)
        .json({ success: false, error: "Payment log not found" });

    res
      .status(200)
      .json({ success: true, message: "Payment log deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
