import express from "express";
import {
  callback,
  connect,
  createFolder,
  deleteFile,
  deleteFolder,
  disconnect,
  listItems,
  reconnectGoogleDrive,
  setupDrive,
  shareItem,
  sharePublic,
  updateFolder,
  upload,
  uploadFile,
} from "../controllers/driveController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

router.post("/setup", auth_key_header, auth_token, setupDrive);
router.post(
  "/storage/drive/reconnect",
  auth_key_header,
  auth_token,
  reconnectGoogleDrive
);

// Step 1: get Google consent URL
router.get("/connect", auth_token, connect);

// Step 2: Google redirects here (open in browser)
router.post("/callback", callback);

// User-owned Drive actions
router.post("/folder", auth_token, createFolder);
router.put("/update-folder", auth_token, updateFolder);
router.post("/upload", auth_token, upload.single("file"), uploadFile);
// share to public
router.post("/delete-file", auth_token, deleteFile);
router.post("/share/public", auth_token, sharePublic);
router.get("/list", auth_token, listItems);
router.post("/share", auth_token, shareItem);
router.post("/disconnect", auth_token, disconnect);
router.delete("/delete", auth_token, deleteFolder);
export default router;
