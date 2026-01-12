import express from "express";
import {
  // New payment functions
  createPaymentIntent,
  getPlanPricing,
  getPaymentStatus,
  handlePaymentWebhook,
  // Legacy payment log functions
  createPaymentLog,
  updatePaymentLog,
  deletePaymentLog,
  getPaymentsByUserId,
  getAllPaymentLogs,
  getPaymentLogById,
} from "../controllers/paymentController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import auth_admin from "../middleware/auth_admin.js";

const router = express.Router();

// ============================================
// CORE PAYMENT ENDPOINTS
// ============================================

// Create payment intent (for checkout)
router.post("/intent", auth_key_header, auth_token, createPaymentIntent);

// Get plan pricing details
router.get("/plans/:planId", auth_key_header, getPlanPricing);

// Get user payment status
router.get("/status/:userId", auth_key_header, auth_token, getPaymentStatus);

// Handle Stripe webhooks (NO AUTH - Stripe sends this)
router.post("/webhook", auth_key_header, auth_token, handlePaymentWebhook);

// ============================================
// LEGACY PAYMENT LOG ENDPOINTS
// ============================================

// Create payment log
router.post("/log", auth_key_header, auth_token, createPaymentLog);

// Get all payment logs
router.get("/logs", auth_key_header, auth_token, getAllPaymentLogs);

// Get payment log by ID
router.get("/logs/:id", auth_key_header, auth_token, getPaymentLogById);

// Get payments by user ID
router.get("/user/:userId", auth_key_header, auth_token, getPaymentsByUserId);

// Update payment log
router.put("/logs/:id", auth_key_header, auth_token, updatePaymentLog);

// Delete payment log (admin only)
router.delete(
  "/logs/:id",
  auth_key_header,
  auth_token,
  auth_admin,
  deletePaymentLog
);

export default router;
