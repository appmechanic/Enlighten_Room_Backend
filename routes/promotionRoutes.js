import express from "express";
import {
  createPromotion,
  deletePromotion,
  getAllPromotions,
  getPromotionById,
  togglePromotionStatus,
  updatePromotion,
} from "../controllers/promotionController.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

// Base: /admin/promotions
router.post("/", auth_key_header, auth_admin, createPromotion);
router.get("/", auth_key_header, auth_token, getAllPromotions);
router.get("/:id", auth_key_header, auth_token, getPromotionById);
router.put("/:id", auth_key_header, auth_admin, updatePromotion);
router.delete("/:id", auth_key_header, auth_admin, deletePromotion);
router.patch("/:id/toggle", auth_key_header, auth_admin, togglePromotionStatus); // Toggle status: pause/activate

export default router;
