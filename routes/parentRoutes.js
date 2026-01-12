import express from "express";
import {
  createParent,
  getParents,
  getParentById,
  updateParent,
  deleteParent,
  getParentDashboard,
} from "../controllers/parentController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

const allowTeacherOrAdmin = (req, res, next) => {
  const role = req.user?.userRole;

  if (role === "teacher" || role === "admin") return next();
  return res
    .status(403)
    .json({ message: "Access denied. Teacher or Admin only." });
};

router.post(
  "/",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  createParent
);
router.get(
  "/",
  auth_key_header,
  auth_token,
  auth_token,
  allowTeacherOrAdmin,
  getParents
);
router.get(
  "/dashboard/:parentId",
  auth_key_header,
  auth_token,
  getParentDashboard
);
router.get("/:id", auth_key_header, auth_token, getParentById);
router.put(
  "/:id",
  auth_key_header,
  auth_token,
  // auth_token,
  // allowTeacherOrAdmin,
  updateParent
);
router.delete(
  "/:id",
  auth_key_header,
  auth_token,
  allowTeacherOrAdmin,
  deleteParent
);

export default router;
