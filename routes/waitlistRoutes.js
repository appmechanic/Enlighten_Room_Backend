// routes/waitlist.routes.js
import { Router } from "express";
import {
  joinWaitlist,
  listWaitlist,
  getWaitlistById,
  updateWaitlist,
  deleteWaitlist,
} from "../controllers/waitlistController.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = Router();

// Public
router.post("/join", auth_key_header, joinWaitlist);

// Admin-only
router.get("/", auth_admin, auth_key_header, listWaitlist);
router.get("/:id", auth_admin, auth_key_header, getWaitlistById);
router.patch("/:id", auth_admin, auth_key_header, updateWaitlist);
router.delete("/:id", auth_admin, auth_key_header, deleteWaitlist);

export default router;
