import express from "express";
import {
  getAllTimezones,
  getTimezoneById,
  createTimezone,
  updateTimezone,
  deleteTimezone,
} from "../controllers/timezoneController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.get("/", auth_key_header, auth_token, getAllTimezones);
router.get("/:id", auth_key_header, auth_token, getTimezoneById);
router.post("/", auth_key_header, auth_token, createTimezone);
router.put("/:id", auth_key_header, auth_token, updateTimezone);
router.delete("/:id", auth_key_header, auth_token, deleteTimezone);

export default router;
