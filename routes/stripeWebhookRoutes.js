/**
 * Stripe Webhook Routes
 * Handles all webhook-related endpoints
 */

import express from "express";
import {
  handleStripeWebhook,
  getWebhookLogs,
  getWebhookEventDetails,
} from "../controllers/stripeWebhookController.js";
import auth_token from "../middleware/auth_token.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = express.Router();

/**
 * POST /api/stripe/webhook
 * Stripe webhook endpoint (public - requires signature verification)
 * IMPORTANT: Must use express.raw({ type: 'application/json' }) middleware
 * before this route to get raw body for signature verification
 */
router.post("/webhook", handleStripeWebhook);

/**
 * GET /api/stripe/webhook-logs
 * Retrieve webhook event logs (admin only)
 * Query params:
 *   - limit: number of results (default: 50)
 *   - skip: pagination offset (default: 0)
 *   - eventType: filter by event type (optional)
 *   - status: filter by status - "processed", "failed", "skipped" (optional)
 */
router.get(
  "/webhook-logs",
  auth_key_header,
  auth_token,
  auth_admin,
  getWebhookLogs
);

/**
 * GET /api/stripe/webhook-logs/:eventId
 * Get details of a specific webhook event (admin only)
 */
router.get(
  "/webhook-logs/:eventId",
  auth_key_header,
  auth_token,
  auth_admin,
  getWebhookEventDetails
);

export default router;
