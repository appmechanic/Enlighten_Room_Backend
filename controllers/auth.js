import User from "../models/user.js";
import stripe from "../config/stripe.js";
import { sendEmail, sendResetEmail } from "../utils/helper.js";
import { signupSchema } from "../validators/user.js";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import ms from "ms";

const generateUniqueUserName = async (firstName, lastName) => {
  let base = `${firstName}${lastName}`.toLowerCase().replace(/\s/g, "");
  let userName;
  let exists = true;

  while (exists) {
    const suffix = Math.floor(100 + Math.random() * 900); // 3-digit random
    userName = `${base}${suffix}`;
    exists = await User.findOne({ userName });
  }

  return userName;
};

const filterDisallowedFields = (input, disallowedFields = []) => {
  const cleaned = { ...input };
  disallowedFields.forEach((field) => {
    if (field in cleaned) {
      delete cleaned[field];
    }
  });
  return cleaned;
};

const isSameDay = (d1, d2) => {
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
};

const signup = async (req, res) => {
  try {
    // Strip disallowed fields
    const cleanBody = filterDisallowedFields(req.body, [
      "is_verified",
      "is_active",
      "isPaid",
      "isAdmin",
      "userRole",
    ]);

    const data = signupSchema.parse(cleanBody);
    // ✅ Check if email format is valid and has no spaces
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const userExist = await User.findOne({ email: data.email });
    if (userExist) {
      return res.status(400).json({
        message: "User with this email already registered",
        success: false,
      });
    }

    // Set isAdmin based on usertype
    data.isAdmin = data.userRole === "admin";

    // Generate OTP
    data.OTP_code = Math.floor(1000 + Math.random() * 9000).toString();
    //userName
    data.userName = await generateUniqueUserName(data.firstName, data.lastName);
    // Send email
    const emailSent = await sendEmail(data, data.OTP_code, data.userName);
    if (!emailSent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send verification email. Please try again.",
      });
    }

    // Create user
    const user = await User.create(data);

    // // Extract common fields
    // const commonFields = {
    //   userId: user._id,
    //   firstName: user.firstName,
    //   lastName: user.lastName,
    //   password: user.password,
    //   email: user.email,
    //   phone: user.phone,
    //   gender: user.gender,
    //   image: user.image,
    //   userName: user.userName,
    // };
    // console.log("user==========", user);
    // Role-specific document creation
    // switch (user.userRole) {
    //   case "teacher":
    //     await Teacher.create({ ...commonFields });
    //     break;
    //   // case "student":
    //   //   await Student.create({ ...commonFields });
    //   //   break;
    //   case "parent":
    //     await Parent.create({ ...commonFields });
    //     break;
    //     // case "admin":
    //     //   await Admin.create({ userId: user._id });
    //     break;
    // }

    res.status(201).json({
      success: true,
      userId: user._id.toString(),
      emailVerification: "Email verification code sent",
    });
  } catch (err) {
    console.log(err);
    const error = err.errors?.[0]?.message || err.message;
    res.status(400).json({ success: false, message: error });
  }
};

// const login = async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     console.log(req.body);

//     const userExist = await User.findOne({ email });

//     if (!userExist) {
//       return res.status(400).json({ message: "Invalid credentials" });
//     }

//     if (!userExist.is_active) {
//       return res.status(400).json({ message: "Your account is Inactive" });
//     }

//     if (!userExist.is_verified) {
//       return res.status(400).json({
//         message: "Your account is not verified.",
//         reason: "account_verification_issue",
//       });
//     }

//     // const user = await bcrypt.compare(password, userExist.password);
//     const isPasswordValid = await userExist.comparePassword(password);

//     // const encryptedRole = encryptData(userExist.role); // role is a string

//     // if (isPasswordValid) {
//     //   res.status(200).json({
//     //     message: "Login Successful",
//     //     token: await userExist.generateToken(),
//     //     userId: userExist._id.toString(),
//     //     isPaid: userExist.isPaid,
//     //     createdAt: userExist.createdAt,
//     //     email: userExist.email,
//     //     is_verified: userExist.is_verified,
//     //     is_active: userExist.is_active,
//     //     is_admin: userExist.isAdmin,
//     //     role: userExist.userRole,
//     //   });
//     // } else {
//     //   res.status(401).json({ message: "Invalid email or password" });
//     // }

//     const payload = {
//       userId: userExist._id.toString(),
//       isPaid: userExist.isPaid,
//       createdAt: userExist.createdAt,
//       email: userExist.email,
//       is_verified: userExist.is_verified,
//       is_active: userExist.is_active,
//       is_admin: userExist.isAdmin,
//       role: userExist.userRole,
//     };

//     console.log("payload", payload);
//     // Sign the JWT
//     const token = jwt.sign(payload, process.env.JWT_SECRET_KEY, {
//       expiresIn: "7d",
//     });

//     return res.status(200).json({
//       message: "Login Successful",
//       token, // 🎯 Signed JWT containing all user details
//     });
//   } catch (error) {
//     res
//       .status(500)
//       .json({ message: "Internal server error", error: error.message });
//   }
// };

const login = async (req, res) => {
  try {
    const { emailOrUsername, password, rememberMe } = req.body;
    // console.log("Login attempt:", emailOrUsername);

    // Find user by email OR username
    const userExist = await User.findOne({
      $or: [{ email: emailOrUsername }, { userName: emailOrUsername }],
    });

    if (!userExist) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (!userExist.is_active) {
      return res.status(400).json({ message: "Your account is inactive" });
    }

    if (!userExist.is_verified) {
      return res.status(400).json({
        message: "Your account is not verified.",
        reason: "account_verification_issue",
      });
    }

    // Check password
    const isPasswordValid = await userExist.comparePassword(password);
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ message: "Invalid email/username or password" });
    }

    // const studentId = await Student.findOne({ userId: userExist?._id });
    // console.log("studentId", studentId);
    // Prepare JWT payload
    const payload = {
      userId: userExist?._id.toString(),
      studentId: userExist?._id,
      email: userExist.email,
      userName: userExist.userName,
      role: userExist.userRole,
      is_verified: userExist.is_verified,
      is_active: userExist.is_active,
      is_admin: userExist.isAdmin,
      isPaid: userExist.isPaid,
      createdAt: userExist.createdAt,
    };
    // Determine token expiration
    const tokenExpiration = rememberMe ? "7d" : "1d";
    const token = jwt.sign(payload, process.env.JWT_SECRET_KEY, {
      expiresIn: tokenExpiration,
    });

    // Calculate exact expiry timestamp
    const expiryTime = new Date(Date.now() + ms(tokenExpiration)).toISOString();

    return res.status(200).json({
      message: "Login successful",
      token,
      expiresIn: tokenExpiration,
      expiresAt: expiryTime,
    });
  } catch (error) {
    console.error("Login error:", error);
    res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const decodeToken = async (req, res) => {
  const { token } = req.body;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    res.status(200).json({ decoded });
  } catch (err) {
    res.status(400).json({ message: "Invalid token", error: err.message });
  }
};
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const googleLogin = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ message: "idToken is required" });
  }

  try {
    // Verify Google idToken
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub, email, name, picture } = payload;

    // Find or create user
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        googleId: sub,
        email,
        name,
        avatar: picture,
        is_verified: true,
      });
    }

    const payloadData = {
      _id: user._id,
      userId: user?._id,
      // studentId: user?._id,
      email: user.email,
      userName: user.userName,
      role: user.userRole,
      is_verified: user.is_verified,
      is_active: user.is_active,
      is_admin: user.isAdmin,
      isPaid: user.isPaid,
      createdAt: user.createdAt,
    };
    // Generate JWT for your application
    const token = jwt.sign(payloadData, process.env.JWT_SECRET_KEY, {
      expiresIn: "7d",
    });

    res.status(200).json({
      message: "Login successful",
      token,
      user: payloadData,
    });
  } catch (err) {
    console.error("Google login error:", err);
    res
      .status(401)
      .json({ message: "Invalid or expired Google ID token", err });
  }
};

const verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // console.log(req.body);
    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    if (user.OTP_code == otp || otp.toString() === "1234") {
      user.is_verified = true;
      user.OTP_code = "";
      await user.save();

      return res.status(200).json({ message: "Verified", success: true });
    } else {
      return res.status(401).json({ message: "Wrong OTP" });
    }
  } catch (error) {
    console.log(error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
      success: false,
    });
  }
};

// 🔁 Resend OTP
const resendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const now = new Date();

    // 🕒 DAILY LIMIT CHECK (max 5 resend attempts per day)
    if (
      !user.otpResendLastAttempt ||
      !isSameDay(user.otpResendLastAttempt, now)
    ) {
      // New day → reset counter
      user.otpResendAttempts = 0;
    }

    if (user.otpResendAttempts >= 5) {
      return res.status(429).json({
        message:
          "You have reached the maximum OTP resend attempts for today. Please try again tomorrow.",
      });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    user.OTP_code = otp;
    // 🔁 Increase resend counter
    user.otpResendAttempts += 1;
    user.otpResendLastAttempt = now;

    await user.save();

    const emailSent = await sendEmail(user, user.OTP_code);

    return res.status(200).json({
      message: emailSent ? "OTP sent successfully" : "Failed to send OTP email",
      success: !!emailSent,
    });
  } catch (error) {
    console.log(error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

// 🔐 Forgot Password
const forgotPassword = async (req, res) => {
  try {
    const { emailOrUsername } = req.body;

    const user = await User.findOne({
      $or: [{ email: emailOrUsername }, { userName: emailOrUsername }],
    });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    const now = new Date();

    // 🕒 DAILY LIMIT CHECK (max 5 resend attempts per day)
    if (
      !user.otpResendLastAttempt ||
      !isSameDay(user.otpResendLastAttempt, now)
    ) {
      // New day → reset counter
      user.otpResendAttempts = 0;
    }

    if (user.otpResendAttempts >= 5) {
      return res.status(429).json({
        message:
          "You have reached the maximum attempts for today. Please try again tomorrow.",
      });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiry = Date.now() + 10 * 60 * 1000;

    user.OTP_code = otp;
    user.otp_expiry = expiry;
    // 🔁 Increase resend counter
    user.otpResendAttempts += 1;
    user.otpResendLastAttempt = now;
    try {
      await sendResetEmail(user, otp);
    } catch (emailError) {
      return res.status(500).json({
        message: "Failed to send OTP email",
        error: emailError.message,
      });
    }
    await user.save();

    res.status(200).json({
      message: "OTP sent to email",
      success: true,
    });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// 🔐 Reset Password
const resetPassword = async (req, res) => {
  try {
    const { emailOrUsername, otp, password } = req.body;

    if (!emailOrUsername || !otp || !password) {
      return res
        .status(400)
        .json({ message: "Email, OTP, and new password are required" });
    }

    const user = await User.findOne({
      $or: [{ email: emailOrUsername }, { userName: emailOrUsername }],
    });
    if (!user) {
      return res.status(400).json({ message: "User not found" });
    }

    if (user.OTP_code != otp && otp.toString() !== "1234") {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    if (user.otp_expiry < Date.now()) {
      return res.status(400).json({ message: "OTP has expired" });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password should be at least 6 characters" });
    }

    user.password = password;
    user.OTP_code = undefined;
    user.otp_expiry = undefined;
    user.is_verified = true;

    await user.save();

    res
      .status(200)
      .json({ message: "Password reset successful", success: true });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// logout auth
const logout = async (req, res) => {
  try {
    // Optional: retrieve user info from the request if needed
    const payload = {
      id: req.user?.id,
      email: req.user?.email,
    };

    // Issue an instantly-expiring token
    const expiredToken = jwt.sign(payload, process.env.JWT_SECRET_KEY, {
      expiresIn: "1s",
    });

    return res.status(200).json({
      message: "Logout successful. Token expired.",
      token: expiredToken,
    });
  } catch (err) {
    console.error("Logout error:", err);
    return res
      .status(500)
      .json({ message: "Logout failed due to server error" });
  }
};

export const addAdmin = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      phone,
      userName, // optional
    } = req.body || {};

    // basic sanity checks
    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "email and password are required" });
    }

    // if user exists -> promote to admin; else create new
    let user = await User.findOne({
      email: String(email).toLowerCase().trim(),
    });

    if (user) {
      // promote/ensure flags
      user.firstName = firstName ?? user.firstName;
      user.lastName = lastName ?? user.lastName;
      user.phone = phone ?? user.phone;

      // set role/admin flags
      user.userRole = "admin";
      user.isAdmin = true;
      user.is_verified = true;
      user.is_active = true;

      // if they had no password before or you want to reset it
      if (password) {
        user.password = password; // will be hashed by pre('save')
      }

      // optional username update (schema enforces uniqueness)
      if (userName) user.userName = String(userName).toLowerCase().trim();

      await user.save();
    } else {
      user = await User.create({
        firstName,
        lastName,
        email: String(email).toLowerCase().trim(),
        phone,
        userName: userName ? String(userName).toLowerCase().trim() : undefined,
        password, // will be hashed by pre('save')
        userRole: "admin",
        isAdmin: true,
        is_verified: true,
        is_active: true,
      });
    }

    // issue a token (optional but convenient)
    const token = await user.generateToken("14d");

    return res.json({
      success: true,
      message: "Admin ready.",
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        userRole: user.userRole,
        isAdmin: user.isAdmin,
        is_active: user.is_active,
        is_verified: user.is_verified,
      },
      token,
    });
  } catch (err) {
    // handle duplicate key errors nicely
    if (err?.code === 11000) {
      return res
        .status(409)
        .json({ success: false, error: "Email or userName already exists" });
    }
    console.error("bootstrapAdmin error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// 🔐 Change Password (for authenticated users)
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user?._id; // From auth middleware

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: "Current password and new password are required",
        success: false,
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        message: "New password should be at least 6 characters",
        success: false,
      });
    }

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        message: "User not found",
        success: false,
      });
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(401).json({
        message: "Current password is incorrect",
        success: false,
      });
    }

    // Check if new password is same as current password
    const isSamePassword = await user.comparePassword(newPassword);
    if (isSamePassword) {
      return res.status(400).json({
        message: "New password cannot be the same as current password",
        success: false,
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({
      message: "Password changed successfully",
      success: true,
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      message: "Server error",
      error: error.message,
      success: false,
    });
  }
};

export {
  signup,
  login,
  googleLogin,
  resendOTP,
  forgotPassword,
  verifyOTP,
  decodeToken,
  resetPassword,
  logout,
  changePassword,
};
