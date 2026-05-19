/**
 * Sync Stripe-like plans to PayPal
 * POST /api/paypal/sync-plans
 * Admin only
 *
 * For each active plan, create PayPal product and billing plans if missing,
 * save PayPal IDs to the plan, and return all plans with PayPal IDs.
 */
export const syncStripePlansToPayPal = async (req, res) => {
  try {
    const plans = await Plan.find({ status: 'active' });
    if (!plans.length) {
      return res.status(200).json({ success: true, message: 'No active plans found', plans: [] });
    }

    const results = [];
    for (const plan of plans) {
      try {
        // Create PayPal product if missing
        let updated = false;
        if (!plan.paypalProductId) {
          plan.paypalProductId = await getOrCreatePayPalProduct(plan);
          updated = true;
        }
        // Create PayPal monthly billing plan if missing
        if (!plan.paypalPriceMonthly) {
          plan.paypalPriceMonthly = await getOrCreatePayPalBillingPlan(plan, 'monthly');
          plan.paypalBillingPlanMonthly = plan.paypalPriceMonthly;
          updated = true;
        }
        // Create PayPal yearly billing plan if missing
        if (!plan.paypalPriceYearly) {
          plan.paypalPriceYearly = await getOrCreatePayPalBillingPlan(plan, 'yearly');
          plan.paypalBillingPlanYearly = plan.paypalPriceYearly;
          updated = true;
        }
        if (updated) await plan.save();
        results.push({
          _id: plan._id,
          name: plan.name,
          priceMonthly: plan.priceMonthly,
          priceYearly: plan.priceYearly,
          paypalProductId: plan.paypalProductId,
          paypalPriceMonthly: plan.paypalPriceMonthly,
          paypalPriceYearly: plan.paypalPriceYearly,
        });
      } catch (err) {
        results.push({
          _id: plan._id,
          name: plan.name,
          error: err.message,
        });
      }
    }
    return res.status(200).json({ success: true, plans: results });
  } catch (err) {
    console.error('PayPal sync plans error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
import { paypalClient } from '../config/paypal.js';
import * as paypal from '@paypal/checkout-server-sdk';// Initialize PayPal REST SDK (ensure config/paypal.js exports credentials)

import User from '../models/user.js';
import Plan from '../models/PlanModel.js';
import Subscription from '../models/SubscriptionModel.js';
import Coupon from '../models/couponModel.js';
import Transaction from '../models/transactionModel.js';
import { cancelPreviousSubscription } from '../utils/cancelPreviousSubscription.js';
import { sendSubscriptionConfirmationEmail } from '../utils/subscriptionEmails.js';
// Helper: Get base price in dollars for a plan
function getPlanBaseDollars(planDoc, interval) {
  if (!planDoc) return 0;
  return interval === 'yearly'
    ? planDoc.priceYearly || planDoc.priceMonthly || 0
    : planDoc.priceMonthly || 0;
}
function discountedCentsFromDollars(baseDollars, discountPercent) {
  const discountFraction = clampPct(discountPercent) / 100;
  const discountedDollars = baseDollars * (1 - discountFraction);
  return Math.round(discountedDollars * 100);
}

// Helper: Clamp percentage to max 100%
function clampPct(percent) {
  return Math.max(0, Math.min(percent, 100));
}

// Helper: Create PayPal Product if not exists

// utils/paypalAuth.js
import axios from 'axios';

export async function generateAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.post(
    'https://api-m.sandbox.paypal.com/v1/oauth2/token',
    'grant_type=client_credentials',
    {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  return response.data.access_token;
}
async function getOrCreatePayPalProduct(plan) {
  const accessToken = await generateAccessToken(); // you must implement this

  const response = await axios.post(
    'https://api-m.sandbox.paypal.com/v1/catalogs/products',
    {
      name: plan.name,
      description: `${plan.name} subscription plan`,
      type: 'SERVICE',
      category: 'SOFTWARE',
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  const productId = response.data.id; // ✅ IMPORTANT

  plan.paypalProductId = productId;
  await plan.save();

  return productId;
}


export async function getOrCreatePayPalBillingPlan(plan, interval) {
  try {
    if (plan.paypalPlans?.[interval]) {
      return plan.paypalPlans[interval];
    }

    const accessToken = await generateAccessToken();
    const productId = await getOrCreatePayPalProduct(plan);

    const price = interval === 'yearly'
      ? plan.priceYearly
      : plan.priceMonthly;

    const response = await axios.post(
      'https://api-m.sandbox.paypal.com/v1/billing/plans',
      {
        product_id: productId,
        name: `${plan.name} - ${interval}`,
        billing_cycles: [
          {
            frequency: {
              interval_unit: interval === 'yearly' ? 'YEAR' : 'MONTH',
              interval_count: 1,
            },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: price.toFixed(2),
                currency_code: 'USD',
              },
            },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: 'CONTINUE',
          payment_failure_threshold: 3,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const billingPlanId = response.data.id;

    if (!plan.paypalPlans) plan.paypalPlans = {};
    plan.paypalPlans[interval] = billingPlanId;

    await plan.save();

    console.log(`✅ Created PayPal billing plan: ${billingPlanId}`);

    return billingPlanId;
  } catch (err) {
    console.error('❌ Error creating billing plan:', err.response?.data || err);
    throw err;
  }
}
// Create PayPal order

export const createPayPalOrder = async (req, res) => {
  try {
    const {
      userId,
      planId,
      interval = 'monthly',
      currency = 'USD',
      couponCode,
      customer
    } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }

    const baseDollars = getPlanBaseDollars(plan, interval);
    if (!baseDollars || baseDollars <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid plan price' });
    }

    // Coupon
    let discountPercent = 0;
    if (couponCode) {
      const coupon = await Coupon.findOne({
        code: String(couponCode).toUpperCase().trim(),
        isActive: true,
        expiresAt: { $gt: new Date() },
      }).lean();

      if (coupon && coupon.discountPercent > 0 && coupon.discountPercent <= 100) {
        discountPercent = coupon.discountPercent;
      }
    }

    // Final price
    const finalCents = discountedCentsFromDollars(baseDollars, discountPercent);
    const finalPrice = (finalCents / 100).toFixed(2);

    // ✅ Ensure these return STRINGS
    const productId = await getOrCreatePayPalProduct(plan);
    const billingPlanId = await getOrCreatePayPalBillingPlan(plan, interval);

    // 🔍 Safety check (prevents your previous bug)
    const safeProductId =
      typeof productId === 'string' ? productId : productId?.id;

    const safeBillingPlanId =
      typeof billingPlanId === 'string' ? billingPlanId : billingPlanId?.id;

    // Create PayPal order using REST API
    const accessToken = await generateAccessToken();
    const orderPayload = {
      intent: 'CAPTURE',
      payer: {
        name: {
          given_name: customer?.name?.split(' ')[0] || user.firstName || 'Customer',
          surname: customer?.name?.split(' ').slice(1).join(' ') || user.lastName || 'Account',
        },
        email_address: customer?.email || user.email,
      },
      purchase_units: [
        {
          amount: {
            currency_code: currency,
            value: finalPrice,
            breakdown: {
              item_total: {
                currency_code: currency,
                value: finalPrice,
              },
            },
          },
          description: `${plan.name} Plan - ${interval} billing`,
          items: [
            {
              name: plan.name,
              description: `${plan.name} subscription (${interval})`,
              quantity: '1',
              unit_amount: {
                currency_code: currency,
                value: finalPrice,
              },
            },
          ],
          custom_id: safeBillingPlanId,
        },
      ],
      application_context: {
        brand_name: 'Enlighten Room',
        locale: 'en-US',
        user_action: 'PAY_NOW',
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/checkout?paypal=success`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/checkout?paypal=cancel`,
      },
    };

    const orderResponse = await axios.post(
      'https://api-m.sandbox.paypal.com/v2/checkout/orders',
      orderPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const order = orderResponse.data;

    return res.status(200).json({
      success: true,
      id: order.id,
      status: order.status,
      links: order.links,
      billingPlanId: safeBillingPlanId,
      productId: safeProductId,
    });

  } catch (err) {
    console.error('❌ PayPal order error:', err.response?.data || err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};


export const capturePayPalOrder = async (req, res) => {
  try {
    const { orderId, userId, planId, interval = 'monthly', couponCode } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'Order ID is required',
      });
    }

    // Capture PayPal order using REST API
    const accessToken = await generateAccessToken();
    const captureResponse = await axios.post(
      `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const capture = captureResponse.data;

    if (capture.status !== 'COMPLETED') {
      return res.status(400).json({
        success: false,
        error: 'Payment not completed',
        status: capture.status,
      });
    }
    console.log(capture, '✅ PayPal capture successful');

    // DB logic (unchanged, just safer)
    if (userId && planId) {
      // Idempotency: if we've already recorded a transaction for this PayPal
      // order, don't create another one. StrictMode re-renders, double-clicks,
      // or client retries can otherwise produce duplicate rows.
      const existingTxn = await Transaction.findOne({ "paypal.orderId": orderId });
      if (existingTxn) {
        return res.status(200).json({
          success: true,
          status: capture.status,
          order: capture,
          duplicate: true,
        });
      }

      const user = await User.findById(userId);

      if (user) {
        // Stop the user's previous active subscription with no refund
        // before activating the new one.
        await cancelPreviousSubscription(userId);

        const subscription = await Subscription.findOneAndUpdate(
          { userId },
          {
            $set: {
              userId,
              planType: planId,
              status: 'active',
              frequency: interval,
              currency: capture.purchase_units?.[0]?.amount?.currency_code || 'USD',
              promoCode: couponCode || null,
              provider: 'paypal',
              // One-time PayPal orders don't have a recurring subscription
              // id, so leave providerSubscriptionId null. (Set it to the
              // PayPal billing subscription id only if we switch to
              // /v1/billing/subscriptions in the future.)
              providerSubscriptionId: null,
              cancelledAt: null,
            },
          },
          { upsert: true, new: true }
        );

        const plan = await Plan.findById(planId);

        const amount =
          interval === 'yearly'
            ? plan.priceYearly
            : plan.priceMonthly;

        // Find capture details
        const purchaseUnit = capture.purchase_units?.[0];
        const captureObj = purchaseUnit?.payments?.captures?.[0];
        const captureId = captureObj?.id;
        const captureCurrency =
          capture.purchase_units?.[0]?.amount?.currency_code || 'USD';

        await Transaction.create({
          userId,
          amount,
          planType: 'subscription',
          teacherId: user._id,
          currency: captureCurrency,
          status: 'success',
          method: 'paypal',
          provider: 'paypal',
          paypal: {
            orderId,
            payerId: capture.payer?.payer_id,
            payerEmail: capture.payer?.email_address,
            captureId,
            planId: plan?.paypalPlans?.[interval] || plan?.paypalProductId,
            planName: plan?.name,
            // Normalize to "month"/"year" — computeExpiry uses Stripe vocabulary.
            interval: interval === "yearly" ? "year" : "month",
            intervalCount: 1,
          },
          planId,
          subscriptionId: subscription._id,
        });

        try {
          await sendSubscriptionConfirmationEmail({
            to: user.email,
            name:
              [user.firstName, user.lastName].filter(Boolean).join(' ') ||
              user.userName ||
              null,
            planName: plan?.name,
            interval,
            amount,
            currency: captureCurrency,
            referenceId: captureId || orderId,
            provider: 'PayPal',
          });
        } catch (mailErr) {
          console.error('Subscription confirmation email failed:', mailErr);
        }
      }
    }

    return res.status(200).json({
      success: true,
      status: capture.status,
      order: capture,
    });

  } catch (err) {
    console.error('❌ PayPal capture error:', err.response?.data || err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

/**
 * Initialize PayPal pricing for all active plans
 * POST /api/paypal/init-pricing
 * Admin only
 */
export const initializePayPalPricing = async (req, res) => {
  try {
    const activePlans = await Plan.find({ status: 'active' });

    if (activePlans.length === 0) {
      return res.status(200).json({ 
        success: true, 
        message: 'No active plans found',
        created: 0,
      });
    }

    let created = 0;
    const errors = [];

    for (const plan of activePlans) {
      try {
        // Create product if not exists
        if (!plan.paypalProductId) {
          await getOrCreatePayPalProduct(plan);
          created++;
        }

        // Create monthly billing plan if not exists
        if (!plan.paypalBillingPlanMonthly) {
          await getOrCreatePayPalBillingPlan(plan, 'monthly');
          created++;
        }

        // Create yearly billing plan if not exists
        if (!plan.paypalBillingPlanYearly) {
          await getOrCreatePayPalBillingPlan(plan, 'yearly');
          created++;
        }

        console.log(`✅ PayPal pricing initialized for plan: ${plan.name}`);
      } catch (err) {
        console.error(`❌ Error initializing PayPal pricing for ${plan.name}:`, err.message);
        errors.push({
          plan: plan.name,
          error: err.message,
        });
      }
    }

    return res.status(200).json({ 
      success: errors.length === 0, 
      created,
      processed: activePlans.length,
      errors: errors.length > 0 ? errors : [],
      message: `Processed ${activePlans.length} plans, created ${created} PayPal resources`,
    });
  } catch (err) {
    console.error('PayPal initialization error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Create/Update PayPal pricing for a single plan
 * POST /api/paypal/init-plan/:planId
 * Admin only
 */
export const initializePlanPayPalPricing = async (req, res) => {
  try {
    const { planId } = req.params;
    const plan = await Plan.findById(planId);
    if (!plan) {
      return res.status(404).json({ success: false, error: 'Plan not found' });
    }
    try {
      // Create or get PayPal product and plans
      const productId = await getOrCreatePayPalProduct(plan);
      const monthlyPlanId = await getOrCreatePayPalBillingPlan(plan, 'monthly');
      const yearlyPlanId = await getOrCreatePayPalBillingPlan(plan, 'yearly');

      // Save PayPal IDs to plan (Stripe-like)
      plan.paypalProductId = productId;
      plan.paypalPriceMonthly = monthlyPlanId;
      plan.paypalPriceYearly = yearlyPlanId;
      plan.paypalBillingPlanMonthly = monthlyPlanId; // for compatibility
      plan.paypalBillingPlanYearly = yearlyPlanId;   // for compatibility
      await plan.save();

      return res.status(200).json({
        success: true,
        message: `PayPal pricing initialized for ${plan.name}`,
        productId,
        paypalPriceMonthly: monthlyPlanId,
        paypalPriceYearly: yearlyPlanId,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  } catch (err) {
    console.error('Plan PayPal initialization error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};
