import express from "express";
import {
  createLanguage,
  getLanguages,
  getLanguageById,
  updateLanguage,
  deleteLanguage,
} from "../controllers/languageController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

// CRUD Routes for Languages
router.post("/", auth_key_header, auth_token, createLanguage); // Create
router.get("/", auth_key_header, auth_token, getLanguages); // Read all
router.get("/:id", auth_key_header, auth_token, getLanguageById); // Read one
router.put("/:id", auth_key_header, auth_token, updateLanguage); // Update
router.delete("/:id", auth_key_header, auth_token, deleteLanguage); // Delete

export default router;
