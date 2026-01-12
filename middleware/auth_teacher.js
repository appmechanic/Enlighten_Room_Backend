// middleware/auth_teacher.js
import jwt from "jsonwebtoken";

export const authTeacher = (req, res, next) => {
  try {
    const token = req.header("x-auth-token");

    if (!token) {
      return res
        .status(401)
        .json({ message: "Access denied. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    // console.log("Decoded token:", decoded);

    if (!decoded || decoded.role !== "teacher") {
      return res.status(403).json({ message: "Access denied. Teachers only." });
    }

    req.user = decoded;
    next();
  } catch (error) {
    console.error("Teacher auth error:", error.message);
    res.status(400).json({ message: "Invalid token", error: error.message });
  }
};
