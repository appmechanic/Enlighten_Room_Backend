import express from "express";
import {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionByUserId,
  updateSubscription,
  deleteSubscription,
} from "../controllers/subscriptionController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import auth_admin from "../middleware/auth_admin.js";

const router = express.Router();
// Manage teacher subscription
router.post("/", auth_key_header, auth_token, createSubscription);
router.get("/", auth_key_header, auth_token, getAllSubscriptions);
router.get("/:userId", auth_key_header, auth_token, getSubscriptionByUserId);
router.put("/:userId", auth_key_header, auth_token, updateSubscription);
router.delete(
  "/:userId",
  auth_key_header,
  auth_token,
  auth_admin,
  deleteSubscription
);

export default router;
