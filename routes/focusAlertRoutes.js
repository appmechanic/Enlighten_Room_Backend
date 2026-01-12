import { Router } from "express";
import { sendParentFocusAlert } from "../controllers/focusAlert.controller.js";
import { focusCooldown } from "../utils/focusCooldown.js";

const router = Router();

/**
 * POST /api/alerts/focus
 * Body: {
 *   studentId?: string,
 *   studentName: string,
 *   parentEmails: string[],
 *   className: string,
 *   sessionId?: string,
 *   occurredAt?: string | Date,
 *   reason?: "tab_blur" | "window_minimized" | "app_switched" | "network_lost" | "other",
 *   details?: string,
 *   screenshotUrl?: string,
 *   device?: string,
 *   meta?: object
 * }
 */
router.post("/focus", focusCooldown, sendParentFocusAlert);

export default router;
