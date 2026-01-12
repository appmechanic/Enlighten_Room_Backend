// routes/howItWorks.routes.js
import { Router } from "express";
import {
  getHowItWorks,
  upsertHowItWorks,
  toggleHowItWorks,
} from "../controllers/howItWorks.controller.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = Router();

// Public fetch (frontend will consume this for the popup)
router.get("/how-it-works", auth_key_header, getHowItWorks);

// Admin management
router.put("/how-it-works", auth_admin, auth_key_header, upsertHowItWorks);
router.patch(
  "/how-it-works/toggle",
  auth_admin,
  auth_key_header,
  toggleHowItWorks
);

export default router;
