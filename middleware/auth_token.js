import jwt from "jsonwebtoken";
import User from "../models/user.js";
// import dotenv from "dotenv";
// dotenv.config();

export default (req, res, next) => {
  // get token from header
  const token = req.header("x-auth-token");

  // check if token exists
  if (!token) {
    return res.status(401).json({ error: "no-token provided" });
  }

  // Verify token
  try {
    jwt.verify(token, process.env.JWT_SECRET_KEY, async (error, decoded) => {
      // console.log("Decoded Token:", decoded);
      if (error) {
        console.log("Token Expired");
        return res.status(401).json({ error: "Token Expired or invalid" });
      } else {
        const decodedUser = decoded.userId || decoded.id;
        let user = await User.findById(decodedUser).lean();
        if (!user) {
          return res.status(401).json({ error: "user not found" });
        }
        delete user.password;
        req.user = user;
        next();
      }
    });
  } catch (error) {
    console.error("something wrong with auth middleware");
    res.status(500).json({ error: "Authentication Failed" });
  }
};
