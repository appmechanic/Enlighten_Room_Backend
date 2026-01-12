import { Router } from "express";
import {
  getPage,
  createPage,
  updatePage,
  upsertPrivacyPolicy,
} from "../controllers/privacyPolicyController.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = Router();

router.post("/", auth_key_header, createPage);
router.post("/add/:type", auth_key_header, upsertPrivacyPolicy);
router.get("/get/:type", auth_key_header, getPage);
router.put("/:id", auth_key_header, updatePage);

export default router;
