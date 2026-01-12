// routes/testimonialRoutes.js
import express from "express";

import {
  createTestimonial,
  listTestimonials,
  getTestimonial,
  updateTestimonial,
  deleteTestimonial,
} from "../controllers/testimonialController.js";
import upload from "../utils/multer.js";

const router = express.Router();

// Routes
router.post("/", upload.single("image"), createTestimonial); // body: description, name, [designation], [image URL or file]
router.get("/", listTestimonials); // ?page=&limit=&q=
router.get("/:id", getTestimonial);
router.put("/:id", upload.single("image"), updateTestimonial);
router.delete("/:id", deleteTestimonial);

export default router;
