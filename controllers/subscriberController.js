// controllers/subscriberController.js
import Subscriber from "../models/subscriberModel.js";

// Create (IP is captured from req.ip automatically)
export const createSubscriber = async (req, res) => {
  try {
    const { email, message = "", type } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });

    const emailExists = await Subscriber.findOne({ email });
    if (emailExists) {
      return res.status(400).json({ error: "Already Subscribed" });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "";
    const userAgent = req.headers["user-agent"] || "";

    const doc = await Subscriber.create({
      ip,
      email,
      message,
      type,
      userAgent,
    });
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return res
      .status(400)
      .json({ error: err?.message || "Failed to create subscriber" });
  }
};

// List (pagination + search by email/ip)
export const listSubscribers = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);
    const q = (req.query.q || "").trim();

    const filter = q
      ? {
          $or: [
            { email: { $regex: q, $options: "i" } },
            { ip: { $regex: q, $options: "i" } },
            { message: { $regex: q, $options: "i" } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      Subscriber.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Subscriber.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Get one
export const getSubscriber = async (req, res) => {
  try {
    const doc = await Subscriber.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Subscriber not found" });
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};

// Update (email/message; keep original IP)
export const updateSubscriber = async (req, res) => {
  try {
    const { email, message } = req.body || {};
    const doc = await Subscriber.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Subscriber not found" });

    if (typeof email !== "undefined") doc.email = email;
    if (typeof message !== "undefined") doc.message = message;

    // refresh userAgent if provided this request
    doc.userAgent = req.headers["user-agent"] || doc.userAgent;

    await doc.save();
    return res.json({ success: true, data: doc });
  } catch (err) {
    return res
      .status(400)
      .json({ error: err?.message || "Failed to update subscriber" });
  }
};

// Delete
export const deleteSubscriber = async (req, res) => {
  try {
    const doc = await Subscriber.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "Subscriber not found" });
    await doc.deleteOne();
    return res.json({ success: true, message: "Deleted" });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
};
