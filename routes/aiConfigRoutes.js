import { Router } from "express";
import { getPublicTuning } from "../controllers/aiConfigController.js";

const router = Router();

// Public tuning knobs for browsers (grade bands, multipliers). No auth: the
// values are the same for every user and never contain secrets.
router.get("/tuning", getPublicTuning);

export default router;
