import Promotion from "../models/PromotionModel.js";

// Create a new promotion
export const createPromotion = async (req, res) => {
  try {
    const { code, discount, endDate, startDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "required fields missing" });
    }

    const promotion = await Promotion.create({
      code,
      discount,
      endDate,
      startDate,
    });

    res.status(201).json(promotion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get all promotions
export const getAllPromotions = async (req, res) => {
  try {
    const promotions = await Promotion.find().sort({ createdAt: -1 });
    res.status(200).json(promotions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get single promotion by ID
export const getPromotionById = async (req, res) => {
  try {
    const promotion = await Promotion.findById(req.params.id);
    if (!promotion)
      return res.status(404).json({ error: "Promotion not found" });
    res.status(200).json(promotion);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update promotion
export const updatePromotion = async (req, res) => {
  try {
    const { code, discount, status, endDate, startDate } = req.body;
    const updatedPromotion = await Promotion.findByIdAndUpdate(
      req.params.id,
      { code, discount, status, endDate, startDate },
      { new: true }
    );
    if (!updatedPromotion)
      return res.status(404).json({ error: "Promotion not found" });
    res.status(200).json(updatedPromotion);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Delete promotion
export const deletePromotion = async (req, res) => {
  try {
    const deleted = await Promotion.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Promotion not found" });
    res.status(200).json({ message: "Promotion deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Toggle status (Pause/Activate)
export const togglePromotionStatus = async (req, res) => {
  try {
    const promotion = await Promotion.findById(req.params.id);
    if (!promotion)
      return res.status(404).json({ error: "Promotion not found" });

    promotion.status = promotion.status === "active" ? "paused" : "active";
    await promotion.save();
    res.status(200).json(promotion);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
