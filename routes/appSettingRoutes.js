import { Router } from "express";
import {
  getAppSetting,
  upsertAppSetting,
} from "../controllers/appSettingController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_admin from "../middleware/auth_admin.js";

const router = Router();

router.get("/app/:key", auth_key_header, getAppSetting);
router.put("/app/:key", auth_key_header, auth_admin, upsertAppSetting);

export default router;
