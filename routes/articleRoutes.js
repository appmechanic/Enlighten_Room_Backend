// routes/articleRoutes.js
import express from "express";

import {
  createArticle,
  listArticles,
  getArticle,
  getArticleBySlug,
  updateArticle,
  deleteArticle,
} from "../controllers/articleController.js";
import upload from "../utils/multer.js";
import auth_token from "../middleware/auth_token.js";
import auth_key_header from "../middleware/auth_key_header.js";

const router = express.Router();

// Routes
router.post(
  "/",
  upload.single("image"),
  auth_token,
  auth_key_header,
  createArticle
);
router.get("/", auth_key_header, listArticles);
router.get("/slug/:slug", auth_key_header, getArticleBySlug); // fetch by slug
router.get("/:id", auth_key_header, getArticle);
router.put(
  "/:id",
  upload.single("image"),
  auth_token,
  auth_key_header,
  updateArticle
);
router.delete("/:id", auth_token, auth_key_header, deleteArticle);

export default router;
