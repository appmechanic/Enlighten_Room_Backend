import express from "express";
import {
  sendLessonReminder,
  sendFeeReminder,
  sendHomeworkReminder,
  listReminders,
  createReminder,
  getReminder,
  updateReminder,
  setReminderStatus,
  deleteReminder,
  listAllAdminReminders,
  send24hHomeworkReminders,
  send24hLessonReminders,
} from "../controllers/reminderController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";
import { startReminderCron } from "../utils/jobs/reminderCron.js";
import auth_admin from "../middleware/auth_admin.js";

const router = express.Router();

router.post("/lesson", auth_key_header, auth_token, sendLessonReminder);
router.post("/fee", auth_key_header, auth_token, sendFeeReminder);
router.post("/assignment", auth_key_header, auth_token, sendHomeworkReminder);

//crud remainders routes
// List + filter + paginate
router.get("/:id", auth_key_header, auth_token, listReminders);
router.get(
  "/admin-remainders",
  auth_key_header,
  auth_admin,
  listAllAdminReminders
);

// router.post("/test-lesson-reminders", async (req, res) => {
//   try {
//     await send24hLessonReminders();
//     res.json({ ok: true, message: "Lesson 24h reminder function executed" });
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// router.post("/test-homework-reminders", async (req, res) => {
//   try {
//     await send24hHomeworkReminders();
//     res.json({ ok: true, message: "Homework 24h reminder function executed" });
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({ ok: false, error: e.message });
//   }
// });

// Create
router.post("/", auth_key_header, createReminder);

// Read
router.get("/:id", auth_key_header, getReminder);

// Update
router.put("/:id", auth_key_header, updateReminder);

// Activate/Deactivate
router.patch("/:id/status", auth_key_header, setReminderStatus);

// Delete
router.delete("/:id", auth_key_header, deleteReminder);

// ⚠️ Optional QA endpoint (lock down with your auth middleware)
router.post(
  "/run-cron-now",
  /* authAdmin, */ async (req, res) => {
    try {
      await startReminderCron();
      res.json({ ok: true, message: "Cron tick executed" });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

export default router;
