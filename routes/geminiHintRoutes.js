import express from "express";

import { sendParentFocusAlert } from "../controllers/focusAlert.controller.js";

import getGeminiHint from "../controllers/geminiHintController.js";

const router = express.Router();

// POST /api/gemini-hint
router.post('/', getGeminiHint);

export default router;
