// routes/ai.routes.js
import express from "express";
import multer from "multer";
import {
  analyzeWhiteboard,
  analyzeWhiteboardBase64,
} from "../controllers/whiteBoardController.js";

const router = express.Router();

// Multer: in-memory, 5MB, images only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpeg|jpg|webp)$/i.test(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPEG/WEBP images are allowed"), ok);
  },
});

// POST /api/ai/whiteboard  (FormData: image=<blob>, prompt?)
// Example front-end: canvas.toBlob → FormData → fetch
router.post("/whiteboard", upload.single("image"), analyzeWhiteboard);

// POST /api/ai/whiteboard/base64  (JSON: { image: "data:image/png;base64,...", prompt? })
router.post(
  "/whiteboard/base64",
  express.json({ limit: "10mb" }),
  analyzeWhiteboardBase64
);

export default router;
