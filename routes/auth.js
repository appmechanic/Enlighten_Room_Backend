import express from "express";
const router = express.Router();
import auth_token from "../middleware/auth_token.js";
import auth_key_header from "../middleware/auth_key_header.js";
import { validate } from "../middleware/validate.js";
import { signupSchema } from "../validators/user.js";
import upload from "../utils/multer.js";
import {
  signup,
  login,
  resetPassword,
  verifyOTP,
  resendOTP,
  forgotPassword,
  googleLogin,
  logout,
  decodeToken,
  addAdmin,
  changePassword,
} from "../controllers/auth.js";

// Signup User
router.post(
  "/signup",
  auth_key_header,

  validate(signupSchema),
  signup
);

// Login User
router.post("/login", auth_key_header, login);
router.post("/create_admin", auth_key_header, addAdmin);
router.post("/decode-token", auth_key_header, auth_token, decodeToken);

router.post("/logout", auth_key_header, logout);
//login in with google
router.post("/google-login", auth_key_header, googleLogin);

// Send OTP
router.post("/resend-otp", auth_key_header, resendOTP);

// Verify OTP
router.post("/verify-otp", auth_key_header, verifyOTP);

//forget password send otp

router.post("/forget-password", auth_key_header, forgotPassword);
// Reset Password
router.post("/reset-password", auth_key_header, resetPassword);

// Change Password (for authenticated users)
router.post("/change-password", auth_key_header, auth_token, changePassword);

export default router;
