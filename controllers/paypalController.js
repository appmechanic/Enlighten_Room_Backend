import { paypalClient } from '../config/paypal.js';
import User from '../models/user.js';
import Plan from '../models/PlanModel.js';
import Subscription from '../models/SubscriptionModel.js';
import Coupon from '../models/couponModel.js';
import Transaction from '../models/transactionModel.js';

// Helper: Get base price in dollars for a plan
function getPlanBaseDollars(planDoc, interval) {
  if (!planDoc) return 0;
  return interval === 'yearly'
    ? planDoc.priceYearly || planDoc.priceMonthly || 0
    : planDoc.priceMonthly || 0;
}

// Helper: Clamp percentage to max 100%
function clampPct(percent) {
  return Math.max(0, Math.min(percent, 100));
}

// Helper: Create PayPal Product if not exists
async function getOrCreatePayPalProduct(plan) {
  try {
    // Check if product ID already exists in plan
    if (plan.paypalProductId) {
      return plan.paypalProductId;
    }

    const PayPalProductsSDK = (await import('@paypal/checkout-server-sdk')).default;
    const client = paypalClient();

    // Create product
    const createProductRequest = new PayPalProductsSDK.catalog.ProductCreateRequest();
    createProductRequest.requestBody({
      name: plan.name,
      description: plan.name + ' subscription plan',
      type: 'SERVICE',
      category: 'SOFTWARE',
    });

    const productResponse = await client.execute(createProductRequest);
    const productId = productResponse.result.id;

    // Save product ID to plan
    plan.paypalProductId = productId;
    await plan.save();

    console.log(`Created PayPal product ${productId} for plan ${plan.name}`);
    return productId;
  } catch (err) {
    console.error('Error creating PayPal product:', err);
    throw err;
  }
}

// Helper: Create PayPal Billing Plan if not exists
async function getOrCreatePayPalBillingPlan(plan, interval) {
  try {
    const planKey = interval === 'yearly' ? 'paypalBillingPlanYearly' : 'paypalBillingPlanMonthly';
    
    if (plan[planKey]) {
      return plan[planKey];
    }

    const PayPalBillingSDK = (await import('@paypal/checkout-server-sdk')).default;
    const client = paypalClient();

    // First ensure product exists
    const productId = await getOrCreatePayPalProduct(plan);

    const baseDollars = getPlanBaseDollars(plan, interval);
    const billingCycles = interval === 'yearly' ? 1 : 1;
    const tenureType = interval === 'yearly' ? 'REGULAR' : 'REGULAR';

    // Create billing plan
    const createBillingPlanRequest = new PayPalBillingSDK.billing.PlanCreateRequest();
    createBillingPlanRequest.requestBody({
      product_id: productId,
      name: `${plan.name} - ${interval.toUpperCase()}`,
      description: `${plan.name} subscription (${interval} billing)`,
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: {
            interval_unit: interval === 'yearly' ? 'YEAR' : 'MONTH',
            interval_count: 1,
          },
          tenure_type: tenureType,
          sequence: 1,
          total_cycles: 0, // 0 = infinite
          pricing_scheme: {
            fixed_price: {
              currency_code: 'USD',
              value: String(baseDollars.toFixed(2)),
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_amount: 'YES',
        payment_failure_threshold: 3,
        setup_fee_failure_action: 'CANCEL',
      },
    });

    const billingPlanResponse = await client.execute(createBillingPlanRequest);
    const billingPlanId = billingPlanResponse.result.id;

    // Save billing plan ID to plan
    plan[planKey] = billingPlanId;
    await plan.save();

    console.log(`Created PayPal billing plan ${billingPlanId} for ${plan.name} (${interval})`);
    return billingPlanId;
  } catch (err) {
    console.error('Error creating PayPal billing plan:', err);
    throw err;
  }
}

// Create PayPal order
export const createPayPalOrder = async (req, res) => {
  try {
    const { userId, planId, interval = 'monthly', currency = 'USD', couponCode, customer } = req.body;
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    
    const plan = await Plan.findById(planId);
    if (!plan) return res.status(404).json({ success: false, error: 'Plan not found' });
    
    const baseDollars = getPlanBaseDollars(plan, interval);
    if (!baseDollars || baseDollars <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid plan price' });
    }

    // Handle coupon discount
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

    // Calculate final price in cents, then convert to dollars
    const finalCents = discountedCentsFromDollars(baseDollars, discountPercent);
    const finalPrice = (finalCents / 100).toFixed(2);

    // Create or get PayPal product and billing plan IDs
    const productId = await getOrCreatePayPalProduct(plan);
    const billingPlanId = await getOrCreatePayPalBillingPlan(plan, interval);

    // Create PayPal order
    const PayPalOrdersSDK = (await import('@paypal/checkout-server-sdk')).default;
    const request = new PayPalOrdersSDK.orders.OrderCreateRequest();
    request.prefer('return=representation');
    
    request.requestBody({
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
          custom_id: billingPlanId, // Link to billing plan
        },
      ],
      application_context: {
        brand_name: 'Enlighten Room',
        locale: 'en-US',
        user_action: 'PAY_NOW',
        return_url: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/checkout?paypal=success`,
        cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:5174'}/checkout?paypal=cancel`,
      },
    });

    const client = paypalClient();
    const order = await client.execute(request);
    
    return res.status(200).json({ 
      success: true, 
      id: order.result.id, 
      status: order.result.status,
      links: order.result.links,
      billingPlanId, // Return billing plan ID for future reference
    });
  } catch (err) {
    console.error('PayPal order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Capture PayPal order
export const capturePayPalOrder = async (req, res) => {
  try {
    const { orderId, userId, planId, interval = 'monthly', couponCode } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ success: false, error: 'Order ID is required' });
    }

    const PayPalOrdersSDK = (await import('@paypal/checkout-server-sdk')).default;
    const request = new PayPalOrdersSDK.orders.OrderCaptureRequest(orderId);
    request.requestBody({});
    
    const client = paypalClient();
    const capture = await client.execute(request);

    if (capture.result.status !== 'COMPLETED') {
      return res.status(400).json({ 
        success: false, 
        error: 'Payment not completed',
        status: capture.result.status,
      });
    }

    // Create/update subscription in database
    if (userId && planId) {
      const user = await User.findById(userId);
      if (user) {
        const subscription = await Subscription.findOneAndUpdate(
          { userId },
          {
            userId,
            planId,
            status: 'active',
            billingInterval: interval,
            paymentMethod: 'paypal',
            paypalOrderId: orderId,
            startDate: new Date(),
            renewalDate: interval === 'yearly' 
              ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
              : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
          { upsert: true, new: true }
        );

        // Create transaction record
        const plan = await Plan.findById(planId);
        const amount = interval === 'yearly' ? plan.priceYearly : plan.priceMonthly;
        
        await Transaction.create({
          userId,
          amount,
          currency: 'USD',
          status: 'success',
          method: 'paypal',
          provider: 'paypal',
          paypal: {
            orderId,
            payerId: capture.result.payer?.payer_id,
            amount: capture.result.purchase_units?.[0]?.amount?.value,
            created: new Date(),
          },
          planId,
          subscriptionId: subscription._id,
        });
      }
    }

    return res.status(200).json({ 
      success: true, 
      status: capture.result.status,
      order: capture.result,
    });
  } catch (err) {
    console.error('PayPal capture error:', err);
    res.status(500).json({ success: false, error: err.message });
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
      const productId = await getOrCreatePayPalProduct(plan);
      const monthlyPlanId = await getOrCreatePayPalBillingPlan(plan, 'monthly');
      const yearlyPlanId = await getOrCreatePayPalBillingPlan(plan, 'yearly');

      return res.status(200).json({ 
        success: true, 
        message: `PayPal pricing initialized for ${plan.name}`,
        productId,
        monthlyBillingPlanId: monthlyPlanId,
        yearlyBillingPlanId: yearlyPlanId,
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
