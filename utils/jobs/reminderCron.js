// jobs/reminderCron.js
import cron from "node-cron";
import Reminder from "../../models/ReminderModel.js";
import User from "../../models/user.js";
import { sendEmail } from "../sendEmail.js";
import NotificationModel from "../../models/NotificationModel.js";
import { addSendEmail } from "../addSendEmail.js";
import {
  send24hHomeworkReminders,
  send24hLessonReminders,
} from "../../controllers/reminderController.js";

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

// ---------- helpers ----------
const addDays = (d, days) => {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
};

function nextOccurrence(base, frequency) {
  const x = new Date(base);
  switch (frequency) {
    case "daily":
      return addDays(x, 1);
    case "weekly":
      return addDays(x, 7);
    case "monthly":
      x.setMonth(x.getMonth() + 1);
      return x;
    case "yearly":
      x.setFullYear(x.getFullYear() + 1);
      return x;
    default:
      return null;
  }
}

function computeNextDueAt(rem) {
  const now = new Date();
  const lastOccurrence = rem._lastOccurrenceDate
    ? new Date(rem._lastOccurrenceDate)
    : rem.startDate
    ? new Date(rem.startDate)
    : now;

  const nextOcc = nextOccurrence(lastOccurrence, rem.frequency);
  if (!nextOcc) return null;

  const triggerAt = addDays(nextOcc, -(rem.remindBeforeDays || 0));
  return { triggerAt, occurrenceDate: nextOcc };
}

function targetForNotification(studentDoc, sendNotificationToParent) {
  if (sendNotificationToParent && studentDoc.parentId)
    return studentDoc.parentId._id;
  return studentDoc._id;
}
// ---------- /helpers ----------

async function processOneReminder() {
  const now = new Date();
  const staleLockBefore = new Date(now.getTime() - LOCK_STALE_MS);

  // A reminder is due if:
  // - status=active AND
  // - (nextDueAt <= now) OR (first run) startDate - remindBeforeDays <= now
  // And not currently locked (processingAt null or stale).
  const dueFilter = {
    status: "active",
    $and: [
      {
        $or: [
          { nextDueAt: { $lte: now } },
          {
            $and: [
              { nextDueAt: { $exists: false } },
              {
                $expr: {
                  $lte: [
                    {
                      $dateSubtract: {
                        startDate: "$startDate",
                        unit: "day",
                        amount: { $ifNull: ["$remindBeforeDays", 0] },
                      },
                    },
                    now,
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
    $or: [{ processingAt: null }, { processingAt: { $lt: staleLockBefore } }],
  };

  // Atomically lock one due reminder
  const reminder = await Reminder.findOneAndUpdate(
    dueFilter,
    { $set: { processingAt: now } },
    { sort: { nextDueAt: 1, startDate: 1 }, new: true }
  );

  if (!reminder) return false; // nothing due

  try {
    // Load students + parents
    const students = await User.find({ _id: { $in: reminder.students || [] } })
      .select("firstName lastName email parentId")
      .populate("parentId", "firstName lastName email")
      .lean();

    // Build notifications (always)
    const title = reminder.title?.trim() || `${reminder.subject} — Reminder`;
    const notifDocs = students.map((stu) => ({
      userId: targetForNotification(stu, reminder.sendNotificationToParent),
      actorId: reminder.teacherId || undefined,
      type: "reminder_email", // must be in Notification enum
      title,
      description: reminder.statement || `${reminder.subject} — Reminder`,
      metadata: {
        reminderId: reminder._id,
        studentId: stu._id,
        frequency: reminder.frequency,
        startDate: reminder.startDate,
        type: reminder.type,
      },
      link: null,
    }));

    if (notifDocs.length) {
      await NotificationModel.insertMany(notifDocs, { ordered: false });
    }

    // Conditionally email parents
    if (reminder.sendEmailToParent) {
      await Promise.all(
        students.map(async (stu) => {
          const parentEmail = stu?.parentId?.email;
          if (!parentEmail) return;

          const subject = `Reminder: ${title}`;
          const html = `
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
              <h3 style="margin:0 0 8px">Reminder: ${title}</h3>
              <p style="margin:0 0 8px"><strong>Subject:</strong> ${
                reminder.subject
              }</p>
              ${
                reminder.statement
                  ? `<p style="margin:0 0 8px">${reminder.statement}</p>`
                  : ""
              }
              <p style="margin:12px 0 0;color:#555">
                Student: ${stu.firstName || ""} ${stu.lastName || ""}<br/>
                Frequency: ${reminder.frequency}<br/>
                Start Date: ${new Date(reminder.startDate).toLocaleDateString()}
              </p>
            </div>
          `;
          try {
            // non-blocking retry mode for transient 450/451/452
            await addSendEmail(parentEmail, subject, html, {
              blockUntilSent: false,
            });
          } catch (e) {
            await Reminder.findByIdAndUpdate(reminder._id, {
              $inc: { errorCount: 1 },
            }).lean();
            console.warn(
              "[reminderCron] email failed:",
              parentEmail,
              e?.responseCode || e?.message || e
            );
          }
        })
      );
    }

    // Schedule the next run and unlock
    let nextDueAt = null;
    let occurrenceDate = reminder._lastOccurrenceDate || reminder.startDate;

    if (!reminder.nextDueAt) {
      occurrenceDate = new Date(reminder.startDate);
    } else if (reminder._lastOccurrenceDate) {
      occurrenceDate = new Date(reminder._lastOccurrenceDate);
    } else {
      const occ = addDays(reminder.nextDueAt, reminder.remindBeforeDays || 0);
      occurrenceDate = new Date(occ);
    }

    const next = computeNextDueAt({
      startDate: reminder.startDate,
      frequency: reminder.frequency,
      remindBeforeDays: reminder.remindBeforeDays || 0,
      _lastOccurrenceDate: occurrenceDate,
    });

    if (next) {
      nextDueAt = next.triggerAt;
      occurrenceDate = next.occurrenceDate;
    }

    await Reminder.findByIdAndUpdate(
      reminder._id,
      {
        $set: {
          lastProcessedAt: new Date(),
          nextDueAt,
          _lastOccurrenceDate: occurrenceDate,
          processingAt: null, // release lock
        },
      },
      { new: false }
    );

    return true;
  } catch (err) {
    console.error("[reminderCron] processing error:", err);
    await Reminder.findByIdAndUpdate(reminder._id, {
      $set: { processingAt: null },
      $inc: { errorCount: 1 },
    });
    return true;
  }
}

// schedule: every minute; delay actual work by 10s
export function startReminderCron() {
  console.log("Starting reminder cron job...");
  cron.schedule("0 * * * * *", () => {
    setTimeout(async () => {
      // 1) Auto lesson + homework reminders (no ReminderModel, no flags)
      await send24hLessonReminders();
      await send24hHomeworkReminders();

      processOneReminder().catch((e) =>
        console.error("[reminderCron] fatal:", e)
      );
    }, 10_000); // 10 seconds
  });
}
