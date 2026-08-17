import Subscription from "../models/SubscriptionModel.js";
import User from "../models/user.js";
import { cancelPreviousSubscription } from "../utils/cancelPreviousSubscription.js";

// Create
export const createSubscription = async (req, res) => {
  try {
    const { userId, planType, currency, frequency, addons, promoCode } =
      req.body;

    const existing = await Subscription.findOne({ userId });
    if (existing) {
      return res
        .status(400)
        .json({ message: "Subscription already exists for this user." });
    }

    const subscription = new Subscription({
      userId,
      planType,
      currency,
      frequency,
      addons,
      promoCode,
    });
    await subscription.save();
    res.status(201).json(subscription);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Read All
export const getAllSubscriptions = async (req, res) => {
  try {
    const subscriptions = await Subscription.find().populate(
      "userId",
      "name email"
    );
    res.json(subscriptions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Read One
export const getSubscriptionByUserId = async (req, res) => {
  try {
    const { userId } = req.params;
    const subscription = await Subscription.findOne({ userId }).populate(
      "userId",
      "name email"
    );
    if (!subscription)
      return res.status(404).json({ message: "Subscription not found." });
    res.json(subscription);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Update
export const updateSubscription = async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;

    const subscription = await Subscription.findOneAndUpdate(
      { userId },
      updates,
      { new: true }
    );
    if (!subscription)
      return res.status(404).json({ message: "Subscription not found." });

    res.json(subscription);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Cancel — usable by an admin OR the subscription owner themselves.
// Cancels with the payment provider and flips the user's isPaid flag.
export const cancelSubscription = async (req, res) => {
  try {
    const { userId } = req.params;
    const caller = req.user;
    if (!caller) return res.status(401).json({ error: "Not authenticated." });

    const isSelf = String(caller._id) === String(userId);
    if (!isSelf && !caller.isAdmin) {
      return res.status(403).json({ error: "Not allowed." });
    }

    const cancelled = await cancelPreviousSubscription(userId);
    await User.findByIdAndUpdate(userId, { $set: { isPaid: false } });

    if (!cancelled) {
      return res.json({
        message: "No active subscription to cancel.",
        subscription: null,
      });
    }
    return res.json({
      message: "Subscription cancelled successfully.",
      subscription: cancelled,
    });
  } catch (err) {
    console.error("cancelSubscription failed:", err);
    return res.status(500).json({ error: err.message });
  }
};

// Delete
export const deleteSubscription = async (req, res) => {
  try {
    const { userId } = req.params;
    const subscription = await Subscription.findOneAndDelete({ userId });
    if (!subscription)
      return res.status(404).json({ message: "Subscription not found." });

    res.json({ message: "Subscription deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
