// routes/subscriberRoutes.js
import express from "express";
import {
  createSubscriber,
  listSubscribers,
  getSubscriber,
  updateSubscriber,
  deleteSubscriber,
} from "../controllers/subscriberController.js";

const router = express.Router();

router.post("/", createSubscriber);
router.get("/", listSubscribers);
router.get("/:id", getSubscriber);
router.put("/:id", updateSubscriber);
router.delete("/:id", deleteSubscriber);

export default router;
