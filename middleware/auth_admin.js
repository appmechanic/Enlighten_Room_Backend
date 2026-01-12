import User from "../models/user.js";
import jwt from "jsonwebtoken";
export default async (req, res, next) => {
  // Get token from header
  const token = req.header("x-auth-token");
  // Check if token exists
  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    // Verify token
    jwt.verify(token, process.env.JWT_SECRET_KEY, async (error, decoded) => {
      if (error) {
        console.log("Token Expired or Invalid");
        return res.status(401).json({ error: "Token expired or invalid" });
      }

      // Find user by ID
      const user = await User.findById(decoded.userId).lean();

      if (!user) {
        return res.status(401).json({ error: "User not found" });
      }

      // Check if user is admin
      if (!user.isAdmin) {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Attach user to req and proceed
      delete user.password;
      req.user = user;
      next();
    });
  } catch (error) {
    console.error("Error in admin auth middleware:", error);
    res.status(500).json({ error: "Authentication Failed" });
  }
};
