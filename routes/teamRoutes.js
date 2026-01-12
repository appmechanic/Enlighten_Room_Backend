// routes/team.routes.js
import { Router } from "express";
import {
  createTeam,
  listTeams,
  getTeamById,
  updateTeam,
  deleteTeam,
} from "../controllers/teamController.js";

import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import upload from "../utils/multer.js";

const router = Router();

// All endpoints are admin-protected
router.post(
  "/",
  auth_admin,
  auth_key_header,
  upload.single("image"),
  createTeam
);
router.get("/", auth_admin, auth_key_header, listTeams);
router.get("/:id", auth_admin, auth_key_header, getTeamById);
router.patch(
  "/:id",
  auth_admin,
  auth_key_header,
  upload.single("image"),
  updateTeam
);
router.delete("/:id", auth_admin, auth_key_header, deleteTeam);

export default router;
