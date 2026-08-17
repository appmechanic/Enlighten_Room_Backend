import { Router } from "express";
import auth_admin from "../middleware/auth_admin.js";
import auth_key_header from "../middleware/auth_key_header.js";
import {
  listSchools,
  getSchool,
  createSchool,
  updateSchool,
  deleteSchool,
} from "../controllers/registeredSchoolController.js";

const router = Router();

router.get("/", auth_admin, auth_key_header, listSchools);
router.get("/:id", auth_admin, auth_key_header, getSchool);
router.post("/", auth_admin, auth_key_header, createSchool);
router.put("/:id", auth_admin, auth_key_header, updateSchool);
router.delete("/:id", auth_admin, auth_key_header, deleteSchool);

export default router;
