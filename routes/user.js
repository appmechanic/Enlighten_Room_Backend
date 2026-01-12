import express from "express";
const router = express.Router();
import auth_token from "../middleware/auth_token.js";
import auth_key_header from "../middleware/auth_key_header.js";
import upload from "../utils/multer.js";
import {
  userProfile,
  updateProfile,
  setUserRole,
  getAllUsers,
  getUserById,
  suspendUser,
  deleteUser,
} from "../controllers/user.js";
import auth_admin from "../middleware/auth_admin.js";

// User Profile
router.get("/user-profile", auth_key_header, auth_token, userProfile);
router.put("/role", auth_key_header, auth_admin, setUserRole);
// GET /admin/users - Get all users
router.get("/", auth_key_header, auth_admin, getAllUsers);

// GET /admin/users/:userId - View specific user
router.get("/:userId", auth_key_header, auth_admin, getUserById);

// PATCH /admin/users/:userId/suspend - Suspend or unsuspend user
router.patch("/:userId/suspend", auth_key_header, auth_admin, suspendUser);

// DELETE /admin/users/:userId - Delete user
router.delete("/:userId", auth_key_header, auth_admin, deleteUser);

// Edit User Profile
router.put(
  "/update-profile",
  auth_key_header,
  auth_token,
  upload.single("image"),
  updateProfile
);

export default router;
