import Reminder from "../models/ReminderModel.js";
import Student from "../models/studentModel.js";
import Parent from "../models/parentModel.js";
import {
  sendLessonReminderEmails,
  sendFeeReminderEmails,
  sendHomeworkReminderEmails,
} from "../utils/reminderEmails.js";
import User from "../models/user.js";
import { sendEmail } from "../utils/sendEmail.js";
import Session from "../models/SessionModel.js";
import mongoose from "mongoose";
import Assignment from "../models/AssignmentModel.js";
import { addSendEmail } from "../utils/addSendEmail.js";

const isId = (v) => mongoose.isValidObjectId(v);

// 🔁 Helper to validate IDs
const validateIds = async (ids, model) => {
  const invalid = await Promise.all(
    ids.map(async (id) => {
      const exists = await model.findById(id);
      return exists ? null : id;
    })
  );
  return invalid.filter((id) => id);
};

/* -------------------- helpers -------------------- */
// students + their parents (via parentId)
async function getStudentsAndParents(studentIds = []) {
  if (!studentIds.length) return { students: [], parents: [] };

  const students = await User.find({
    _id: { $in: studentIds },
    userRole: "student",
  })
    .select("firstName lastName email parentId")
    .populate("parentId", "firstName lastName email")
    .lean();

  const parents = [];
  for (const stu of students) {
    if (stu.parentId?.email) {
      parents.push({
        _id: stu.parentId._id,
        firstName: stu.parentId.firstName,
        lastName: stu.parentId.lastName,
        email: stu.parentId.email,
      });
    }
  }

  return { students, parents };
}

function formatSessionDateParts(sessionDate, tz) {
  const d = new Date(sessionDate);

  // locale-agnostic readable date/time
  const dateStr = d.toLocaleDateString("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "2-digit",
  });

  const timeStr = d.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });

  const iso = new Date(
    tz ? new Date(d.toLocaleString("en-US", { timeZone: tz })) : d
  ).toISOString();

  // If you intend to schedule “1h before”, compute here for convenience:
  const sendAt = new Date(new Date(iso).getTime() - 60 * 60 * 1000);

  return { dateStr, timeStr, iso, sendAt };
}
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function dedupeByEmail(users = []) {
  const seen = new Set();
  const out = [];
  for (const u of users) {
    const email = (u.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(u);
  }
  return out;
}

async function sendLessonReminderEmailsToUsers({
  users,
  session,
  parts,
  timezone,
  meta = {},
}) {
  const { dateStr, timeStr } = parts;

  const title = meta.title || session.topic || "Upcoming Session";
  const subject = `Reminder: ${title} — ${dateStr} at ${timeStr}${
    timezone ? ` (${timezone})` : ""
  }`;

  const htmlFor = (name) => `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;">
      <h2 style="margin:0 0 12px;">${escapeHtml(title)}</h2>
      <p style="margin:0 0 8px;">Hi ${escapeHtml(name || "there")},</p>
      <p style="margin:0 0 8px;">This is a reminder for your session.</p>

      <table style="margin:8px 0 12px;border-collapse:collapse;">
        <tr>
          <td style="padding:4px 8px;"><strong>Date</strong></td>
          <td style="padding:4px 8px;">${escapeHtml(dateStr)}</td>
        </tr>
        <tr>
          <td style="padding:4px 8px;"><strong>Time</strong></td>
          <td style="padding:4px 8px;">${escapeHtml(timeStr)}${
    timezone ? ` (${escapeHtml(timezone)})` : ""
  }</td>
        </tr>
        ${
          session.sessionUrl
            ? `<tr><td style="padding:4px 8px;"><strong>Link</strong></td><td style="padding:4px 8px;"><a href="${escapeAttr(
                session.sessionUrl
              )}" target="_blank" rel="noopener">Join Session</a></td></tr>`
            : ""
        }
        ${
          session.topic
            ? `<tr><td style="padding:4px 8px;"><strong>Topic</strong></td><td style="padding:4px 8px;">${escapeHtml(
                session.topic
              )}</td></tr>`
            : ""
        }
        ${
          session.notes
            ? `<tr><td style="padding:4px 8px;vertical-align:top;"><strong>Notes</strong></td><td style="padding:4px 8px;">${escapeHtml(
                session.notes
              )}</td></tr>`
            : ""
        }
      </table>

      ${
        meta.notes
          ? `<p style="margin:0 0 8px;"><em>${escapeHtml(meta.notes)}</em></p>`
          : ""
      }

      <p style="margin:0;">See you there!</p>
    </div>
  `;

  await Promise.all(
    users.map((u) =>
      sendEmail({
        to: u.email,
        subject,
        html: htmlFor(u.name || u.fullName || u.username || ""),
      })
    )
  );
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(str = "") {
  // conservative attribute escaping (href)
  return escapeHtml(str).replace(/"/g, "%22").replace(/'/g, "%27");
}

// 📩 LESSON REMINDER
export const sendLessonReminder = async (req, res) => {
  try {
    const {
      sessionId,
      studentIds = [],
      teacherIds = [],
      timezone, // e.g., "Asia/Karachi"
      meta = {},
    } = req.body;

    // 0) Must have a session and at least one recipient group
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required." });
    }
    if (!studentIds?.length && !teacherIds?.length) {
      return res.status(400).json({
        error: "Provide at least one of studentIds or teacherIds.",
      });
    }

    // 1) Load session
    const session = await Session.findById(sessionId).lean();
    if (!session) {
      return res.status(404).json({ error: "Session not found." });
    }
    if (!session.sessionDate) {
      return res.status(400).json({ error: "Session has no sessionDate." });
    }

    // 2) Format session date/time (separate) in requested timezone (if provided)
    const { dateStr, timeStr, iso, sendAt } = formatSessionDateParts(
      session.sessionDate,
      timezone
    );

    // 3) Validate IDs exist (document existence)
    const missingStudents = studentIds.length
      ? await validateIds(studentIds, User)
      : [];
    const missingTeachers = teacherIds.length
      ? await validateIds(teacherIds, User)
      : [];

    if (missingStudents.length || missingTeachers.length) {
      return res.status(404).json({
        error: "Some recipients not found",
        missingStudents,
        missingTeachers,
      });
    }

    // 4) Fetch recipients with role filters
    const [validStudents, validTeachers] = await Promise.all([
      studentIds.length
        ? User.find({ _id: { $in: studentIds }, userRole: "student" }).lean()
        : [],
      teacherIds.length
        ? User.find({ _id: { $in: teacherIds }, userRole: "teacher" }).lean()
        : [],
    ]);

    if (!validStudents.length && !validTeachers.length) {
      return res.status(404).json({
        error: "No valid recipients found for given IDs and roles.",
      });
    }

    // 5) Persist the reminder (store session snapshot for audit)
    const reminder = new Reminder({
      type: "Session",
      studentIds,
      teacherIds,
      sessionId,
      datetime: session.sessionDate, // keep original session datetime
      meta: {
        ...meta,
        sessionSnapshot: {
          topic: session.topic,
          classroomId: session.classroomId,
          sessionUrl: session.sessionUrl,
          notes: session.notes,
          sessionDateISO: iso,
        },
      },
      // Optional: fields to support scheduling later (e.g., 1-hour before)
      sendAt, // if you later run a job using this
    });
    await reminder.save();

    // 6) Email everyone
    const recipients = dedupeByEmail([...validStudents, ...validTeachers]);

    await sendLessonReminderEmailsToUsers({
      users: recipients,
      session,
      parts: { dateStr, timeStr },
      timezone,
      meta,
    });

    return res.status(201).json({
      message: "Session reminder sent.",
      counts: {
        students: validStudents.length,
        teachers: validTeachers.length,
        totalEmailed: recipients.length,
      },
      reminder,
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
};

// 💰 FEE REMINDER
export const sendFeeReminder = async (req, res) => {
  try {
    const { parentIds, amount } = req.body;

    // Validate parent IDs
    const missingParents = await validateIds(parentIds, User);
    if (missingParents.length) {
      return res
        .status(404)
        .json({ error: "Some parents not found", missingParents });
    }

    // Save reminder to DB
    const reminder = new Reminder({ type: "fee", parentIds, amount });
    await reminder.save();

    // Fetch valid parents and their students using parentId
    const validParents = await User.find({
      _id: { $in: parentIds },
      userRole: "parent",
    });
    const students = await User.find({
      parentId: { $in: parentIds },
      userRole: "student",
    })
      .populate("parentId", "_id firstName lastName email")
      .select("firstName lastName email _id");

    // Send fee reminders to both
    await sendFeeReminderEmails(validParents, students, amount);

    res.status(201).json({ message: "Fee reminder sent" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
};

// 📝 HOMEWORK REMINDER
export const sendHomeworkReminder = async (req, res) => {
  try {
    const { studentIds, dueDate } = req.body;

    const missingStudents = await validateIds(studentIds, User);
    if (missingStudents.length) {
      return res
        .status(404)
        .json({ error: "Some students not found", missingStudents });
    }

    const reminder = new Reminder({ type: "Assignment", studentIds, dueDate });
    await reminder.save();

    const validStudents = await User.find({
      _id: { $in: studentIds },
      userRole: "student",
    });

    // console.log("validStudents", validStudents);
    await sendHomeworkReminderEmails(validStudents, dueDate);

    res.status(201).json({ message: "Homework reminder sent", reminder });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
};

// crud

const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];
const TYPES = ["Fee", "Other"];
const STATUSES = ["active", "inactive"];

// Helpers
const toBool = (v, def = false) => (typeof v === "boolean" ? v : def);
const toInt = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const uniqObjectIds = (arr = []) => {
  const seen = new Set();
  return arr
    .map(String)
    .filter((id) => isId(id))
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .map((id) => new mongoose.Types.ObjectId(id));
};
const computeInitialNextDueAt = (startDate, remindBeforeDays) => {
  const start = new Date(startDate);
  return new Date(start.getTime() - remindBeforeDays * 86400000);
};

export const createReminder = async (req, res) => {
  try {
    let {
      teacherId,
      students = [],

      title,
      subject,
      statement = "",
      type,
      startDate,
      frequency,
      remindBeforeDays = 0,
      untilDate = null,

      sendEmailToParent = false,
      sendNotificationToParent = true,
      status = "active",
    } = req.body;

    // Required & enums
    if (!isId(teacherId))
      return res
        .status(400)
        .json({ success: false, message: "Invalid teacherId" });
    if (!title?.trim())
      return res
        .status(400)
        .json({ success: false, message: "Title is required" });
    if (!subject?.trim())
      return res
        .status(400)
        .json({ success: false, message: "Subject is required" });
    if (!startDate)
      return res
        .status(400)
        .json({ success: false, message: "Start date is required" });
    if (!FREQUENCIES.includes(frequency))
      return res
        .status(400)
        .json({ success: false, message: "Invalid frequency" });
    if (!TYPES.includes(type))
      return res.status(400).json({ success: false, message: "Invalid type" });
    if (!STATUSES.includes(status))
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });

    // Normalize
    students = uniqObjectIds(students);
    remindBeforeDays = toInt(remindBeforeDays, 0);
    sendEmailToParent = toBool(sendEmailToParent, false);
    sendNotificationToParent = toBool(sendNotificationToParent, true);

    // Guard: for your cron flow, if emailing parents, we expect students to map to parents
    if (sendEmailToParent && students.length === 0) {
      return res.status(400).json({
        success: false,
        message: "students array cannot be empty when sendEmailToParent=true",
      });
    }

    // Compute first trigger
    const nextDueAt = computeInitialNextDueAt(startDate, remindBeforeDays);

    const doc = await Reminder.create({
      teacherId,
      students,
      title: title.trim(),
      subject: subject.trim(),
      statement: String(statement || ""),
      type,
      startDate,
      frequency,
      remindBeforeDays,
      untilDate: untilDate || null,
      sendEmailToParent,
      sendNotificationToParent,
      status,
      nextDueAt, // 👈 important for cron
      lastProcessedAt: null, // new doc
      errorCount: 0,
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

const toId = (v) => (typeof v === "string" ? v : v?.toString());

export const listReminders = async (req, res) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const authTeacherObjId = new mongoose.Types.ObjectId(req.user._id);

    // 2) Accept :id or ?id=..., default to logged-in teacher
    const teacherIdRaw =
      req.params.id || req.query.id || authTeacherObjId.toString();

    // Validate teacher id shape
    let teacherObjId;
    try {
      teacherObjId = new mongoose.Types.ObjectId(teacherIdRaw);
    } catch {
      return res
        .status(400)
        .json({ success: false, message: "Invalid teacher id" });
    }

    // 3) Enforce: teachers can only read their own reminders
    if (!teacherObjId.equals(authTeacherObjId)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: you can only access your own reminders.",
      });
    }

    // Basic pagination (optional)
    const page = Math.max(parseInt(req.query.page ?? "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit ?? "20", 10), 1),
      100
    );
    const skip = (page - 1) * limit;

    const filter = { teacherId: teacherObjId };

    // Optional status filter e.g. ?status=active
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      Reminder.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Reminder.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};
export const listAllAdminReminders = async (req, res) => {
  try {
    const { teacherId, status, type, q, page = 1, limit = 10 } = req.query;

    const filter = {};
    if (teacherId && isId(teacherId)) filter.teacherId = teacherId;
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: "i" } },
        { subject: { $regex: q, $options: "i" } },
        { statement: { $regex: q, $options: "i" } },
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [items, total] = await Promise.all([
      Reminder.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Reminder.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: items,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const getReminder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id))
      return res.status(400).json({ success: false, message: "Invalid id" });
    const reminder = await Reminder.findById(id);
    if (!reminder)
      return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: reminder });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const updateReminder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id))
      return res.status(400).json({ success: false, message: "Invalid id" });

    const existing = await Reminder.findById(id);
    if (!existing)
      return res.status(404).json({ success: false, message: "Not found" });

    // Build payload carefully (don’t allow teacherId change)
    const payload = {};
    const body = req.body || {};

    // Optional updatable fields
    if (body.title !== undefined) {
      if (!body.title?.trim())
        return res
          .status(400)
          .json({ success: false, message: "Title cannot be empty" });
      payload.title = body.title.trim();
    }
    if (body.subject !== undefined) {
      if (!body.subject?.trim())
        return res
          .status(400)
          .json({ success: false, message: "Subject cannot be empty" });
      payload.subject = body.subject.trim();
    }
    if (body.statement !== undefined)
      payload.statement = String(body.statement || "");

    if (body.type !== undefined) {
      if (!TYPES.includes(body.type))
        return res
          .status(400)
          .json({ success: false, message: "Invalid type" });
      payload.type = body.type;
    }
    if (body.frequency !== undefined) {
      if (!FREQUENCIES.includes(body.frequency))
        return res
          .status(400)
          .json({ success: false, message: "Invalid frequency" });
      payload.frequency = body.frequency;
    }

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status))
        return res
          .status(400)
          .json({ success: false, message: "Invalid status" });
      payload.status = body.status;
    }

    if (body.startDate !== undefined) {
      if (!body.startDate)
        return res
          .status(400)
          .json({ success: false, message: "startDate cannot be empty" });
      payload.startDate = body.startDate;
    }

    if (body.remindBeforeDays !== undefined) {
      const n = toInt(body.remindBeforeDays, 0);
      if (n < 0)
        return res.status(400).json({
          success: false,
          message: "remindBeforeDays cannot be negative",
        });
      payload.remindBeforeDays = n;
    }

    if (body.untilDate !== undefined) {
      payload.untilDate = body.untilDate || null;
    }

    if (body.sendEmailToParent !== undefined) {
      payload.sendEmailToParent = toBool(body.sendEmailToParent, false);
    }
    if (body.sendNotificationToParent !== undefined) {
      payload.sendNotificationToParent = toBool(
        body.sendNotificationToParent,
        true
      );
    }

    if (body.students !== undefined) {
      const list = uniqObjectIds(body.students);
      payload.students = list;

      // Guard with your cron flow: if emailing parents, need students
      const effectiveSendEmail =
        payload.sendEmailToParent !== undefined
          ? payload.sendEmailToParent
          : existing.sendEmailToParent;
      if (effectiveSendEmail && list.length === 0) {
        return res.status(400).json({
          success: false,
          message: "students array cannot be empty when sendEmailToParent=true",
        });
      }
    }

    // Recompute nextDueAt if time drivers changed OR if it was not set
    const startDate = payload.startDate ?? existing.startDate;
    const remindBeforeDays =
      payload.remindBeforeDays ?? existing.remindBeforeDays;
    let shouldRecompute = false;

    if (
      payload.startDate !== undefined ||
      payload.remindBeforeDays !== undefined ||
      !existing.nextDueAt
    ) {
      shouldRecompute = true;
    }

    if (shouldRecompute) {
      payload.nextDueAt = computeInitialNextDueAt(startDate, remindBeforeDays);
    }

    // If turning inactive, you may want to clear nextDueAt (optional)
    if (payload.status === "inactive") {
      payload.nextDueAt = null;
    }

    const updated = await Reminder.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    return res.json({ success: true, data: updated });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const setReminderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // "active" | "inactive"
    if (!isId(id))
      return res.status(400).json({ success: false, message: "Invalid id" });
    if (!["active", "inactive"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }
    const updated = await Reminder.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );
    if (!updated)
      return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, data: updated });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

export const deleteReminder = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isId(id))
      return res.status(400).json({ success: false, message: "Invalid id" });
    const deleted = await Reminder.findByIdAndDelete(id);
    if (!deleted)
      return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, message: "Deleted" });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
};

// cron job remainders

export async function send24hLessonReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + ONE_DAY_MS);

  // Only upcoming sessions in next 24h where we did NOT send the 24h reminder yet
  const sessions = await Session.find({
    sessionDate: { $gte: now, $lte: in24h },
    "reminders.lesson24hSent": { $ne: true },
  })
    .populate("classroomId")
    .select(
      "sessionDate topic classroomId studentIds students teacherIds reminders"
    )
    .lean();
  // console.log(sessions);
  // console.log(`[reminderCron] Found ${sessions} sessions in next 24h`);
  if (!sessions.length) return;

  for (const session of sessions) {
    // support either session.studentIds or session.students
    // const studentIds = session.studentIds || session.students || [];
    const studentIds = session.classroomId?.studentIds || [];

    const teacherIds = session.teacherIds || [];

    const [{ students, parents }, teachers] = await Promise.all([
      getStudentsAndParents(studentIds),
      teacherIds.length
        ? User.find({
            _id: { $in: teacherIds },
            userRole: "teacher",
          })
            .select("firstName lastName email")
            .lean()
        : [],
    ]);
    // console.log("students", students);
    // console.log("parents", parents);
    // console.log("teachers", teachers);
    const recipients = dedupeByEmail([...students, ...parents, ...teachers]);
    // console.log("recipients", recipients);
    if (!recipients.length) {
      // still mark as sent to avoid looping forever on empty
      await Session.updateOne(
        { _id: session._id },
        { $set: { "reminders.lesson24hSent": true } }
      );
      continue;
    }

    const title = session.topic || "Upcoming session";
    const dateStr = session.sessionDate.toLocaleDateString();
    const timeStr = session.sessionDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    await Promise.all(
      recipients.map(async (u) => {
        const subject = `Session reminder: ${title}`;
        const html = `
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
             
            <p style="margin:0 0 8px">This is a reminder for your upcoming session:</p>
            <p style="margin:0 0 8px"><strong>Topic:</strong> ${title}</p>
            <p style="margin:0 0 8px"><strong>Date:</strong> ${dateStr} ${timeStr}</p>
            <p style="margin:0 0 8px">Please be ready for your session on time.</p>
            <p style="margin:12px 0 0;color:#555">
              This is an automated reminder for your upcoming session (24 hours in advance).
            </p>
          </div>
        `;
        try {
          await addSendEmail(u.email, subject, html, { blockUntilSent: false });
        } catch (e) {
          console.warn(
            "[reminderCron] 24h lesson email failed:",
            u.email,
            e?.responseCode || e?.message || e
          );
          // we still continue; we don't want infinite resends every minute
        }
      })
    );

    // mark 24h reminder as sent so we don't send again
    await Session.updateOne(
      { _id: session._id },
      { $set: { "reminders.lesson24hSent": true } }
    );
  }
}

export async function send24hHomeworkReminders() {
  const now = new Date();
  const in24h = new Date(now.getTime() + ONE_DAY_MS); // 24h or test window

  // 1) Get all docs that have at least one assignment due in the window
  const docs = await Assignment.find({
    "assignments.dueDate": { $gte: now, $lte: in24h },
    "reminders.homework24hSent": { $ne: true },
  })
    .select("assignments classroomId sessionId teacherId")
    .lean();

  if (!docs.length) return;

  for (const doc of docs) {
    // 2) Pick only the child assignments that fall in the window
    const dueAssignments = (doc.assignments || []).filter((a) => {
      if (!a.dueDate) return false;
      const d = new Date(a.dueDate);
      return d >= now && d <= in24h;
    });

    if (!dueAssignments.length) continue;

    for (const hw of dueAssignments) {
      // console.log("Processing child assignment", hw);

      const studentIds = hw.studentIds || hw.students || [];
      // console.log("studentIds", studentIds);

      if (!studentIds.length) continue;

      const { students, parents } = await getStudentsAndParents(studentIds);
      const recipients = dedupeByEmail([...students, ...parents]);
      if (!recipients.length) continue;

      const dueStr = hw.dueDate
        ? new Date(hw.dueDate).toLocaleDateString()
        : "";
      const title = hw.title || "Assignment";

      await Promise.all(
        recipients.map(async (u) => {
          const subject = `Assignment reminder: ${title}`;
          const html = `
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
              <p style="margin:0 0 8px"><strong>Task:</strong> ${title}</p>
              ${
                dueStr
                  ? `<p style="margin:0 0 8px"><strong>Due date:</strong> ${dueStr}</p>`
                  : ""
              }
              <p style="margin:12px 0 0;color:#555">
                This is an automated reminder to complete the assignment 24 hours before the due date.
              </p>
            </div>
          `;
          try {
            await addSendEmail(u.email, subject, html, {
              blockUntilSent: false,
            });
          } catch (e) {
            console.warn(
              "[reminderCron] 24h homework email failed:",
              u.email,
              e?.responseCode || e?.message || e
            );
          }
        })
      );

      await Assignment.updateOne(
        { _id: doc._id },
        { $set: { "reminders.homework24hSent": true } }
      );
    }
  }
}
