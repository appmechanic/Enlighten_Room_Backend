import { Router } from "express";
import {
  createPaymentIntent,
  startSubscription,
  webhook,
  getTeacherTransactions,
  getAllTransactions,
  attachAndPay,
} from "../controllers/transactionController.js";
import auth_token from "../middleware/auth_token.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_admin from "../middleware/auth_admin.js";

const router = Router();

// Create a one-off PaymentIntent (client confirms with Stripe.js)
router.post("/intent", auth_token, auth_key_header, createPaymentIntent);

// Create a subscription (no priceId from FE; backend figures it out)
router.post(
  "/subscriptions/start",
  auth_token,
  auth_key_header,
  startSubscription
);

// Optional: finalize/order writeback (webhooks preferred)
// router.post("/finish", finish);
router.post("/finish", attachAndPay);

// Webhook (must be raw body) - mounted at /api/billing/webhook in server.js
router.post("/webhook", auth_token, auth_key_header, webhook);
router.get(
  "/transactions/all",
  // auth_admin,
  auth_key_header,
  getAllTransactions
);
router.get(
  "/teacher/:teacherId",
  auth_token,
  auth_key_header,
  getTeacherTransactions
);

// Test-only helpers (DEV ONLY)
// router.post("/test/confirm-intent", testConfirmIntent);
// router.post("/test/confirm-subscription", testConfirmSubscription);
// router.post("/test/confirm-setup", testConfirmSetupIntent);
// router.get("/subscriptions/:id", getSubscription);
// router.get("/payment-intents/:id", getPaymentIntent);

export default router;
