import express from "express";
// import {
//   sendTestEmail,
//   updateNotificationSetting,
// } from "../controllers/notificationSettingsController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import { listUserNotifications } from "../controllers/notificationSettingsController.js";

const router = express.Router();

router.get("/get", auth_key_header, auth_token, listUserNotifications);
// router.put("/settings", auth_key_header, auth_token, updateNotificationSetting);
// router.post("/email/test", auth_key_header, auth_token, sendTestEmail);

export default router;
