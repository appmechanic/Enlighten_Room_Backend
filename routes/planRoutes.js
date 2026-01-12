import express from "express";
import {
  createPlan,
  getAllPlans,
  getPlanById,
  updatePlan,
  deletePlan,
} from "../controllers/planController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import auth_admin from "../middleware/auth_admin.js";

const router = express.Router();

router.post("/", auth_key_header, createPlan);
router.get("/", auth_key_header, getAllPlans);
router.get("/:id", auth_key_header, getPlanById);
router.put("/:id", auth_key_header, updatePlan);
router.delete("/:id", auth_key_header, auth_admin, deletePlan);

export default router;
