import express from "express";
import {
  createPartner,
  getPartnersAdmin,
  getPartnerById,
  updatePartner,
  deletePartner,
  getPublicPartners,
} from "../controllers/partnerController.js";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import upload from "../utils/multer.js";

const router = express.Router();

// PUBLIC – used on frontend "Partnered by" section
router.get("/", getPublicPartners);

// ADMIN – all need auth + admin check (inside controller)
router.use(auth_admin, auth_key_header);

router.get("/", getPartnersAdmin);
router.post("/", upload.single("logo"), createPartner);
router.get("/:id", getPartnerById);
router.put("/:id", upload.single("logo"), updatePartner);
router.delete("/:id", deletePartner);

export default router;
