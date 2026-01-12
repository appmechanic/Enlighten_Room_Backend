/**
 * Stripe Webhook Controller
 * Handles all Stripe webhook events including:
 * - Payment intents (succeeded, failed)
 * - Invoices (payment succeeded, payment failed)
 * - Subscriptions (created, updated, deleted)
 * - Charges (refunded, failed)
 * - Customer events
 */

import stripe from "../config/stripe.js";
import Transaction from "../models/transactionModel.js";
import User from "../models/user.js";
import Plan from "../models/PlanModel.js";
import Subscription from "../models/SubscriptionModel.js";
import PaymentLog from "../models/PaymentLogModel.js";

// ==================== HELPERS ====================

/**
 * Safely extract customer ID from Stripe object
 */
const getCustomerId = (obj) => {
  if (typeof obj === "string") return obj;
  return obj?.id || null;
};

/**
 * Safely extract subscription ID from Stripe object
 */
const getSubscriptionId = (obj) => {
  if (typeof obj === "string") return obj;
  return obj?.id || null;
};

/**
 * Log webhook event for debugging
 */
const logWebhookEvent = async (eventType, eventId, status, details = {}) => {
  try {
    await PaymentLog.create({
      eventId,
      eventType,
      status, // "processed", "failed", "skipped"
      details,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("Failed to log webhook event:", err.message);
  }
};

/**
 * Find user by Stripe customer ID
 */
const findUserByCustomerId = async (customerId) => {
  return User.findOne({ stripeCustomerId: customerId });
};

/**
 * Update transaction status
 */
const updateTransactionStatus = async (externalId, status, details = {}) => {
  try {
    return await Transaction.findOneAndUpdate(
      { externalId },
      { status, ...details, updatedAt: new Date() },
      { new: true }
    );
  } catch (err) {
    console.error("Failed to update transaction:", err.message);
    return null;
  }
};

// ==================== EVENT HANDLERS ====================

/**
 * Handle payment_intent.succeeded
 */
async function handlePaymentIntentSucceeded(event) {
  try {
    const pi = event.data.object;
    const customerId = getCustomerId(pi.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(`Customer ${customerId} not found for PI ${pi.id}`);
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const charge = pi.charges?.data?.[0] || null;
    const transaction = {
      userId: user._id,
      externalId: pi.id,
      type: "payment_intent",
      status: "completed",
      amount: pi.amount_received / 100, // Convert cents to dollars
      currency: pi.currency.toUpperCase(),
      description: pi.description || "Payment successful",
      chargeId: charge?.id || null,
      balanceTransactionId: charge?.balance_transaction || null,
      metadata: pi.metadata || {},
      stripeResponse: {
        paymentIntentId: pi.id,
        status: pi.status,
      },
    };

    const savedTransaction = await Transaction.findOneAndUpdate(
      { externalId: pi.id },
      transaction,
      { upsert: true, new: true }
    );

    // Mark user as paid if not already
    if (!user.isPaid) {
      await User.findByIdAndUpdate(user._id, { isPaid: true });
    }

    await logWebhookEvent("payment_intent.succeeded", event.id, "processed", {
      paymentIntentId: pi.id,
      userId: user._id,
      amount: transaction.amount,
    });

    return {
      status: "processed",
      transaction: savedTransaction,
    };
  } catch (err) {
    console.error("Error handling payment_intent.succeeded:", err.message);
    await logWebhookEvent("payment_intent.succeeded", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle payment_intent.payment_failed
 */
async function handlePaymentIntentFailed(event) {
  try {
    const pi = event.data.object;
    const customerId = getCustomerId(pi.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(`Customer ${customerId} not found for PI ${pi.id}`);
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const transaction = {
      userId: user._id,
      externalId: pi.id,
      type: "payment_intent",
      status: "failed",
      amount: pi.amount / 100,
      currency: pi.currency.toUpperCase(),
      description: pi.last_payment_error?.message || "Payment failed",
      metadata: pi.metadata || {},
      errorDetails: {
        code: pi.last_payment_error?.code || null,
        message: pi.last_payment_error?.message || null,
        type: pi.last_payment_error?.type || null,
      },
    };

    await Transaction.findOneAndUpdate({ externalId: pi.id }, transaction, {
      upsert: true,
      new: true,
    });

    await logWebhookEvent(
      "payment_intent.payment_failed",
      event.id,
      "processed",
      {
        paymentIntentId: pi.id,
        userId: user._id,
        error: pi.last_payment_error?.message,
      }
    );

    return {
      status: "processed",
      failureReason: pi.last_payment_error?.message,
    };
  } catch (err) {
    console.error("Error handling payment_intent.payment_failed:", err.message);
    await logWebhookEvent("payment_intent.payment_failed", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle invoice.payment_succeeded
 */
async function handleInvoicePaymentSucceeded(event) {
  try {
    const invoice = event.data.object;
    const customerId = getCustomerId(invoice.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(
        `Customer ${customerId} not found for Invoice ${invoice.id}`
      );
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const subscriptionId = getSubscriptionId(invoice.subscription);
    const totalAmount = invoice.total / 100;
    const tax = invoice.tax ? invoice.tax / 100 : 0;
    const amountPaid = invoice.amount_paid / 100;

    // Create/update transaction
    const transaction = {
      userId: user._id,
      externalId: invoice.id,
      type: "invoice",
      status: "completed",
      amount: amountPaid,
      currency: invoice.currency.toUpperCase(),
      description: `Invoice ${invoice.number || invoice.id}`,
      invoiceId: invoice.id,
      subscriptionId,
      metadata: invoice.metadata || {},
      breakdown: {
        total: totalAmount,
        amountPaid,
        tax,
        amountDue: invoice.amount_due / 100,
      },
    };

    await Transaction.findOneAndUpdate(
      { externalId: invoice.id },
      transaction,
      { upsert: true, new: true }
    );

    // Update subscription status if exists
    if (subscriptionId) {
      await Subscription.findOneAndUpdate(
        { externalId: subscriptionId },
        {
          status: "active",
          lastPaymentDate: new Date(),
          totalBilled:
            (
              await Transaction.aggregate([
                { $match: { subscriptionId, status: "completed" } },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ])
            )[0]?.total || 0,
        },
        { upsert: true }
      );
    }

    // Mark user as paid
    if (!user.isPaid) {
      await User.findByIdAndUpdate(user._id, { isPaid: true });
    }

    await logWebhookEvent("invoice.payment_succeeded", event.id, "processed", {
      invoiceId: invoice.id,
      userId: user._id,
      amount: amountPaid,
      subscriptionId,
    });

    return {
      status: "processed",
      transaction,
    };
  } catch (err) {
    console.error("Error handling invoice.payment_succeeded:", err.message);
    await logWebhookEvent("invoice.payment_succeeded", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle invoice.payment_failed
 */
async function handleInvoicePaymentFailed(event) {
  try {
    const invoice = event.data.object;
    const customerId = getCustomerId(invoice.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(
        `Customer ${customerId} not found for Invoice ${invoice.id}`
      );
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const transaction = {
      userId: user._id,
      externalId: invoice.id,
      type: "invoice",
      status: "failed",
      amount: invoice.total / 100,
      currency: invoice.currency.toUpperCase(),
      description: `Invoice payment failed: ${invoice.number || invoice.id}`,
      invoiceId: invoice.id,
      errorDetails: {
        attemptCount: invoice.attempt_count,
        nextPaymentAttempt: invoice.next_payment_attempt,
        lastError: invoice.last_finalization_error?.message,
      },
    };

    await Transaction.findOneAndUpdate(
      { externalId: invoice.id },
      transaction,
      { upsert: true, new: true }
    );

    await logWebhookEvent("invoice.payment_failed", event.id, "processed", {
      invoiceId: invoice.id,
      userId: user._id,
      attemptCount: invoice.attempt_count,
    });

    return {
      status: "processed",
      failureReason: invoice.last_finalization_error?.message,
    };
  } catch (err) {
    console.error("Error handling invoice.payment_failed:", err.message);
    await logWebhookEvent("invoice.payment_failed", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle customer.subscription.created
 */
async function handleSubscriptionCreated(event) {
  try {
    const subscription = event.data.object;
    const customerId = getCustomerId(subscription.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(
        `Customer ${customerId} not found for Subscription ${subscription.id}`
      );
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const item = subscription.items?.data?.[0];
    const priceId = item?.price?.id;
    const plan = await Plan.findOne({ stripePriceId: priceId });

    const subscriptionDoc = {
      userId: user._id,
      externalId: subscription.id,
      status: subscription.status,
      planId: plan?._id || null,
      stripePriceId: priceId,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      metadata: subscription.metadata || {},
    };

    const saved = await Subscription.findOneAndUpdate(
      { externalId: subscription.id },
      subscriptionDoc,
      { upsert: true, new: true }
    );

    await logWebhookEvent(
      "customer.subscription.created",
      event.id,
      "processed",
      {
        subscriptionId: subscription.id,
        userId: user._id,
        status: subscription.status,
      }
    );

    return {
      status: "processed",
      subscription: saved,
    };
  } catch (err) {
    console.error("Error handling customer.subscription.created:", err.message);
    await logWebhookEvent("customer.subscription.created", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle customer.subscription.updated
 */
async function handleSubscriptionUpdated(event) {
  try {
    const subscription = event.data.object;
    const customerId = getCustomerId(subscription.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(
        `Customer ${customerId} not found for Subscription ${subscription.id}`
      );
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const item = subscription.items?.data?.[0];
    const priceId = item?.price?.id;
    const plan = await Plan.findOne({ stripePriceId: priceId });

    const updated = await Subscription.findOneAndUpdate(
      { externalId: subscription.id },
      {
        status: subscription.status,
        planId: plan?._id || null,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        canceledAt: subscription.canceled_at
          ? new Date(subscription.canceled_at * 1000)
          : null,
        metadata: subscription.metadata || {},
      },
      { upsert: true, new: true }
    );

    await logWebhookEvent(
      "customer.subscription.updated",
      event.id,
      "processed",
      {
        subscriptionId: subscription.id,
        userId: user._id,
        status: subscription.status,
      }
    );

    return {
      status: "processed",
      subscription: updated,
    };
  } catch (err) {
    console.error("Error handling customer.subscription.updated:", err.message);
    await logWebhookEvent("customer.subscription.updated", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle customer.subscription.deleted
 */
async function handleSubscriptionDeleted(event) {
  try {
    const subscription = event.data.object;
    const customerId = getCustomerId(subscription.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(
        `Customer ${customerId} not found for Subscription ${subscription.id}`
      );
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const updated = await Subscription.findOneAndUpdate(
      { externalId: subscription.id },
      {
        status: "canceled",
        canceledAt: new Date(),
      },
      { new: true }
    );

    await logWebhookEvent(
      "customer.subscription.deleted",
      event.id,
      "processed",
      {
        subscriptionId: subscription.id,
        userId: user._id,
      }
    );

    return {
      status: "processed",
      subscription: updated,
    };
  } catch (err) {
    console.error("Error handling customer.subscription.deleted:", err.message);
    await logWebhookEvent("customer.subscription.deleted", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle charge.refunded
 */
async function handleChargeRefunded(event) {
  try {
    const charge = event.data.object;
    const customerId = getCustomerId(charge.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(`Customer ${customerId} not found for Charge ${charge.id}`);
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    // Find original transaction and create refund record
    const originalTransaction = await Transaction.findOne({
      chargeId: charge.id,
    });

    const refundDoc = {
      userId: user._id,
      externalId: charge.refunds?.data?.[0]?.id || `refund_${charge.id}`,
      type: "refund",
      status: "completed",
      amount: charge.refunded / 100,
      currency: charge.currency.toUpperCase(),
      description: `Refund for charge ${charge.id}`,
      originalTransactionId: originalTransaction?._id || null,
      chargeId: charge.id,
      reason: charge.refunds?.data?.[0]?.reason || null,
    };

    const savedRefund = await Transaction.create(refundDoc);

    await logWebhookEvent("charge.refunded", event.id, "processed", {
      chargeId: charge.id,
      userId: user._id,
      refundAmount: charge.refunded / 100,
    });

    return {
      status: "processed",
      refund: savedRefund,
    };
  } catch (err) {
    console.error("Error handling charge.refunded:", err.message);
    await logWebhookEvent("charge.refunded", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

/**
 * Handle charge.failed
 */
async function handleChargeFailed(event) {
  try {
    const charge = event.data.object;
    const customerId = getCustomerId(charge.customer);
    const user = await findUserByCustomerId(customerId);

    if (!user) {
      console.warn(`Customer ${customerId} not found for Charge ${charge.id}`);
      return {
        status: "skipped",
        reason: "customer_not_found",
      };
    }

    const transaction = {
      userId: user._id,
      externalId: charge.id,
      type: "charge",
      status: "failed",
      amount: charge.amount / 100,
      currency: charge.currency.toUpperCase(),
      description: `Charge failed: ${charge.failure_message}`,
      chargeId: charge.id,
      errorDetails: {
        failureCode: charge.failure_code,
        failureMessage: charge.failure_message,
        failureBalanceTransaction: charge.failure_balance_transaction,
      },
    };

    await Transaction.findOneAndUpdate({ externalId: charge.id }, transaction, {
      upsert: true,
      new: true,
    });

    await logWebhookEvent("charge.failed", event.id, "processed", {
      chargeId: charge.id,
      userId: user._id,
      failureMessage: charge.failure_message,
    });

    return {
      status: "processed",
      failureReason: charge.failure_message,
    };
  } catch (err) {
    console.error("Error handling charge.failed:", err.message);
    await logWebhookEvent("charge.failed", event.id, "failed", {
      error: err.message,
    });
    throw err;
  }
}

// ==================== MAIN WEBHOOK HANDLER ====================

/**
 * Main webhook endpoint
 * POST /api/stripe/webhook
 * Requires raw body (not JSON parsed)
 */
export async function handleStripeWebhook(req, res) {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !secret) {
      return res.status(400).json({
        error: "Missing webhook signature or secret",
      });
    }

    // Verify webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err?.message);
    return res.status(400).json({
      error: `Webhook Error: ${err?.message}`,
    });
  }

  // Acknowledge receipt immediately
  res.json({ received: true });

  // Process webhook asynchronously
  try {
    console.log(`📨 Processing webhook event: ${event.type} (${event.id})`);

    let result = {
      eventType: event.type,
      eventId: event.id,
      processed: false,
    };

    // Route to appropriate handler
    switch (event.type) {
      case "payment_intent.succeeded":
        result = await handlePaymentIntentSucceeded(event);
        break;

      case "payment_intent.payment_failed":
        result = await handlePaymentIntentFailed(event);
        break;

      case "invoice.payment_succeeded":
        result = await handleInvoicePaymentSucceeded(event);
        break;

      case "invoice.payment_failed":
        result = await handleInvoicePaymentFailed(event);
        break;

      case "customer.subscription.created":
        result = await handleSubscriptionCreated(event);
        break;

      case "customer.subscription.updated":
        result = await handleSubscriptionUpdated(event);
        break;

      case "customer.subscription.deleted":
        result = await handleSubscriptionDeleted(event);
        break;

      case "charge.refunded":
        result = await handleChargeRefunded(event);
        break;

      case "charge.failed":
        result = await handleChargeFailed(event);
        break;

      default:
        console.log(`⏭️  Unhandled event type: ${event.type}`);
        await logWebhookEvent(event.type, event.id, "skipped", {
          reason: "unhandled_event_type",
        });
        return;
    }

    console.log(`✅ Webhook processed:`, result);
  } catch (err) {
    console.error("❌ Error processing webhook:", err.message);
  }
}

/**
 * Retrieve webhook events (for debugging/audit)
 * GET /api/stripe/webhook-logs
 */
export async function getWebhookLogs(req, res) {
  try {
    const { limit = 50, skip = 0, eventType = null, status = null } = req.query;

    const filter = {};
    if (eventType) filter.eventType = eventType;
    if (status) filter.status = status;

    const logs = await PaymentLog.find(filter)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await PaymentLog.countDocuments(filter);

    res.json({
      logs,
      total,
      limit: parseInt(limit),
      skip: parseInt(skip),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve webhook logs",
      details: err.message,
    });
  }
}

/**
 * Get specific webhook event details
 * GET /api/stripe/webhook-logs/:eventId
 */
export async function getWebhookEventDetails(req, res) {
  try {
    const { eventId } = req.params;

    const log = await PaymentLog.findOne({ eventId });

    if (!log) {
      return res.status(404).json({
        error: "Webhook event not found",
      });
    }

    res.json(log);
  } catch (err) {
    res.status(500).json({
      error: "Failed to retrieve webhook event",
      details: err.message,
    });
  }
}

export default {
  handleStripeWebhook,
  getWebhookLogs,
  getWebhookEventDetails,
};
