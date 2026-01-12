// controllers/waitlist.controller.js
import Waitlist from "../models/waitlistModel.js";

/* ========== Public: join (create) ========== */
export const joinWaitlist = async (req, res) => {
  try {
    const { email, name, source } = req.body || {};
    if (!email)
      return res
        .status(400)
        .json({ success: false, error: "Email is required" });

    const doc = await Waitlist.findOneAndUpdate(
      { email: String(email).toLowerCase().trim() },
      {
        $setOnInsert: { email: String(email).toLowerCase().trim() },
        $set: { name, source },
      },
      { new: true, upsert: true }
    );

    return res.json({ success: true, data: doc, message: "Added to waitlist" });
  } catch (err) {
    if (err?.code === 11000) {
      return res
        .status(409)
        .json({ success: false, error: "Email already on waitlist" });
    }
    console.error("joinWaitlist error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

/* ========== Admin: list (with basic filters/pagination) ========== */
export const listWaitlist = async (req, res) => {
  try {
    const {
      q, // search email/name
      status, // pending|invited|joined|rejected
      page = "1",
      limit = "20",
      sort_by = "createdAt",
      order = "desc",
    } = req.query;

    const match = {};
    if (status) match.status = status;
    if (q) {
      const rx = new RegExp(String(q).trim(), "i");
      match.$or = [{ email: rx }, { name: rx }];
    }

    const p = Math.max(1, parseInt(page));
    const l = Math.max(1, Math.min(200, parseInt(limit)));
    const sort = { [sort_by]: order === "asc" ? 1 : -1 };

    const [items, total] = await Promise.all([
      Waitlist.find(match)
        .sort(sort)
        .skip((p - 1) * l)
        .limit(l),
      Waitlist.countDocuments(match),
    ]);

    res.json({
      success: true,
      data: items,
      page: p,
      limit: l,
      total,
      totalPages: Math.ceil(total / l),
    });
  } catch (err) {
    console.error("listWaitlist error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/* ========== Admin: get one ========== */
export const getWaitlistById = async (req, res) => {
  try {
    const item = await Waitlist.findById(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: item });
  } catch (err) {
    console.error("getWaitlistById error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/* ========== Admin: update (status/notes/name/source) ========== */
export const updateWaitlist = async (req, res) => {
  try {
    const { name, source, notes, status } = req.body || {};
    const item = await Waitlist.findByIdAndUpdate(
      req.params.id,
      { $set: { name, source, notes, status } },
      { new: true, runValidators: true }
    );
    if (!item)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: item, message: "Updated" });
  } catch (err) {
    console.error("updateWaitlist error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

/* ========== Admin: delete ========== */
export const deleteWaitlist = async (req, res) => {
  try {
    const item = await Waitlist.findByIdAndDelete(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    console.error("deleteWaitlist error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
};
