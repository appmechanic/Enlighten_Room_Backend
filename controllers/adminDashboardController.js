// controllers/adminDashboard.controller.js
import User from "../models/user.js";
import Classroom from "../models/classroomModel.js";
import Session from "../models/SessionModel.js";
import Assignment from "../models/AssignmentModel.js";
import subscriberModel from "../models/subscriberModel.js";
import { sendTeacherWelcomeEmail } from "../utils/emailService.js";
import { parseTeachersFromExcel } from "../utils/parseTeachersFromExcel.js";
import { parseStudentsFromExcel } from "../utils/parseStudentsFromExcel.js";
import { addSendEmail } from "../utils/addSendEmail.js";
import Plan from "../models/PlanModel.js";
import Subscription from "../models/SubscriptionModel.js";
import multer from "multer";
import bcrypt from "bcrypt";
import { generateStrongPassword } from "../utils/passwordGenerator.js";
import axios from "axios";

// Look up the current active plan for a user and return the numeric limit
// for `dimension`, or Infinity when unlimited/plan missing. Used by bulk
// import to trim the batch to remaining capacity BEFORE inserting, so we
// never partially exceed a cap.
async function getPlanLimit(userId, dimension) {
  const sub = await Subscription.findOne({ userId, status: "active" })
    .populate("planType")
    .lean();
  const cap = sub?.planType?.limits?.[dimension];
  return cap == null ? Infinity : Number(cap);
}

// Shared with createStudent — kept local to avoid a controller-to-controller
// import cycle. Suffix retries on username collision (rare but possible under
// bulk insert of similar names).
async function generateUniqueStudentUserName(firstName, lastName) {
  const base = `${firstName || ""}${lastName || ""}`
    .toLowerCase()
    .replace(/\s+/g, "");
  let userName;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const suffix = Math.floor(100 + Math.random() * 900);
    userName = `${base}${suffix}`;
    const clash = await User.findOne({ userName }).lean();
    if (!clash) return userName;
  }
}

export const getAdminDashboardMetrics = async (req, res) => {
  try {
    const { start, end } = req.query; // optional: filter by createdAt
    const dateMatch = {};
    if (start || end) {
      dateMatch.createdAt = {};
      if (start) dateMatch.createdAt.$gte = new Date(start);
      if (end) dateMatch.createdAt.$lte = new Date(end);
    }
    const withDates = (extra = {}) =>
      Object.keys(dateMatch).length ? { ...extra, ...dateMatch } : extra;

    const [
      totalTeachers,
      totalParents,
      totalStudents,
      totalClasses,
      totalSessions,
      totalAssignments,
      totalSubscribers, // users flagged as paid
    ] = await Promise.all([
      User.countDocuments(withDates({ userRole: "teacher" })),
      User.countDocuments(withDates({ userRole: "parent" })),
      User.countDocuments(withDates({ userRole: "student" })),
      Classroom.countDocuments(withDates()),
      Session.countDocuments(withDates()),
      Assignment.countDocuments(withDates()),
      subscriberModel.countDocuments(withDates()),
    ]);

    return res.json({
      success: true,
      asOf: new Date().toISOString(),
      filters: { start: start || null, end: end || null },
      data: {
        totalTeachers,
        totalParents,
        totalStudents,
        totalClasses,
        totalSessions,
        totalAssignments,
        totalSubscribers,
      },
    });
  } catch (err) {
    console.error("getAdminDashboardMetrics error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

// Multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// export this middleware for the route
export const excelUploadMiddleware = upload.single("file");

export async function bulkCreateTeachers(req, res) {
  try {
    let buffer;
    let excelUrl = req.body.excelUrl;

    if (req.file) {
      // CASE 1: uploaded Excel file
      buffer = req.file.buffer;
    } else if (excelUrl) {
      if (excelUrl.includes("docs.google.com/spreadsheets")) {
        const match = excelUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (match && match[1]) {
          const sheetId = match[1];
          excelUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
        }
      }

      // CASE 2: Excel URL
      const response = await axios.get(excelUrl, {
        responseType: "arraybuffer",
      });
      buffer = Buffer.from(response.data);
    } else {
      return res
        .status(400)
        .json({ error: "Please upload an Excel file OR provide excelUrl." });
    }

    const parsedTeachers = parseTeachersFromExcel(buffer);
    // console.log(parsedTeachers);
    if (!parsedTeachers.length) {
      return res
        .status(400)
        .json({ error: "No valid teacher rows found in the Excel file." });
    }

    const docsToInsert = [];
    const emailsToSend = [];

    for (const t of parsedTeachers) {
      const existing = await User.findOne({ email: t.email });
      if (existing) {
        // skip existing emails
        continue;
      }

      const plainPassword = generateStrongPassword(10);
      const passwordHash = await bcrypt.hash(plainPassword, 10);

      docsToInsert.push({
        firstName: t.firstName,
        lastName: t.lastName,
        email: t.email,
        phone: t.phone,
        organization: t.organization,
        gender: t.gender,
        userRole: "teacher",
        userName: t.userName,
        is_active: true,
        is_verified: true,
        password: passwordHash,
        referedBy: req.user._id,
      });

      emailsToSend.push({
        email: t.email,
        name: t.firstName,
        password: plainPassword,
      });
    }

    if (!docsToInsert.length) {
      return res.status(400).json({
        error: "All emails already exist or invalid. No new teacher created.",
      });
    }

    const created = await User.insertMany(docsToInsert);

    // Email sending with 5-second delay
    emailsToSend.forEach((info, index) => {
      const delay = index * 5000; // 5 sec gap
      setTimeout(async () => {
        try {
          await sendTeacherWelcomeEmail(info);
        } catch (err) {
          console.error(
            "Failed to send welcome email to",
            info.email,
            err.message
          );
        }
      }, delay);
    });

    return res.status(201).json({
      message:
        "Teachers created successfully. Welcome emails are being sent with 5-second delay.",
      totalCreated: created.length,
    });
  } catch (error) {
    console.error("bulkCreateTeachers error:", error);
    return res.status(500).json({
      error: "Failed to process teacher Excel file.",
      details: error.message,
    });
  }
}

// POST /api/admin/students/bulk-upload
// Mirrors bulkCreateTeachers: accepts multipart file OR JSON { excelUrl }.
// Per-row outcome is reported back in `results` so the admin can fix a few
// bad rows without re-uploading a huge sheet. Rows are validated
// individually; a bad row is skipped, not fatal — matches how single-student
// create fails with a 4xx per-request today.
export async function bulkCreateStudents(req, res) {
  try {
    let buffer;
    let excelUrl = req.body.excelUrl;

    if (req.file) {
      buffer = req.file.buffer;
    } else if (excelUrl) {
      if (excelUrl.includes("docs.google.com/spreadsheets")) {
        const match = excelUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
        if (match && match[1]) {
          excelUrl = `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=xlsx`;
        }
      }
      const response = await axios.get(excelUrl, {
        responseType: "arraybuffer",
      });
      buffer = Buffer.from(response.data);
    } else {
      return res
        .status(400)
        .json({ error: "Please upload an Excel file OR provide excelUrl." });
    }

    const parsedStudents = parseStudentsFromExcel(buffer);
    if (!parsedStudents.length) {
      return res
        .status(400)
        .json({ error: "No valid student rows found in the Excel file." });
    }

    // Cap check BEFORE resolving refs / hashing passwords — cheapest short-
    // circuit. Rejects the whole request when even inserting one row would
    // exceed the plan, rather than silently truncating.
    const cap = await getPlanLimit(req.user._id, "maxStudents");
    if (Number.isFinite(cap)) {
      const currentCount = await User.countDocuments({
        userRole: "student",
        referedBy: req.user._id,
      });
      const room = cap - currentCount;
      if (room <= 0) {
        return res.status(402).json({
          error: "Plan limit reached",
          dimension: "maxStudents",
          limit: cap,
          current: currentCount,
          upgradeUrl: "/pricing",
        });
      }
      if (parsedStudents.length > room) {
        return res.status(402).json({
          error: `Upload would exceed your student cap. Room for ${room}, sheet has ${parsedStudents.length}.`,
          dimension: "maxStudents",
          limit: cap,
          current: currentCount,
          upgradeUrl: "/pricing",
        });
      }
    }

    // Resolve parent/teacher references in one round-trip each, rather than
    // querying per row (a 500-row sheet with parent emails would otherwise
    // fire 500 lookups).
    const parentEmails = [
      ...new Set(parsedStudents.map((s) => s.parentEmail).filter(Boolean)),
    ];
    const teacherEmails = [
      ...new Set(parsedStudents.map((s) => s.teacherEmail).filter(Boolean)),
    ];
    const [parentUsers, teacherUsers] = await Promise.all([
      parentEmails.length
        ? User.find({ email: { $in: parentEmails }, userRole: "parent" })
            .select("_id email")
            .lean()
        : [],
      teacherEmails.length
        ? User.find({ email: { $in: teacherEmails }, userRole: "teacher" })
            .select("_id email")
            .lean()
        : [],
    ]);
    const parentByEmail = new Map(parentUsers.map((u) => [u.email, u._id]));
    const teacherByEmail = new Map(teacherUsers.map((u) => [u.email, u._id]));

    const results = { created: [], skipped: [] };
    const emailsToSend = [];

    for (const row of parsedStudents) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(row.email)) {
        results.skipped.push({ email: row.email, reason: "Invalid email" });
        continue;
      }
      if (!row.date_of_birth) {
        results.skipped.push({
          email: row.email,
          reason: "Missing date_of_birth",
        });
        continue;
      }
      if (!row.lastName) {
        results.skipped.push({ email: row.email, reason: "Missing lastName" });
        continue;
      }
      if (row.parentEmail && !parentByEmail.has(row.parentEmail)) {
        results.skipped.push({
          email: row.email,
          reason: `Parent not found: ${row.parentEmail}`,
        });
        continue;
      }
      if (row.teacherEmail && !teacherByEmail.has(row.teacherEmail)) {
        results.skipped.push({
          email: row.email,
          reason: `Teacher not found: ${row.teacherEmail}`,
        });
        continue;
      }

      const existing = await User.findOne({ email: row.email })
        .select("_id")
        .lean();
      if (existing) {
        results.skipped.push({ email: row.email, reason: "Email exists" });
        continue;
      }

      const plainPassword = generateStrongPassword(10);
      const passwordHash = await bcrypt.hash(plainPassword, 10);
      const userName = await generateUniqueStudentUserName(
        row.firstName,
        row.lastName
      );

      try {
        // Uses `new User(...).save()` (not insertMany) so mongoose validators
        // fire per-doc — insertMany silently drops invalid docs otherwise.
        const user = new User({
          email: row.email,
          password: passwordHash,
          firstName: row.firstName,
          lastName: row.lastName,
          userName,
          userRole: "student",
          is_verified: true,
          is_active: true,
          phone: row.phone,
          gender: row.gender,
          date_of_birth: row.date_of_birth,
          age: row.age,
          city: row.city,
          country: row.country,
          language: row.language,
          parentId: parentByEmail.get(row.parentEmail) || undefined,
          teacherId: teacherByEmail.get(row.teacherEmail) || undefined,
          referedBy: req.user?._id,
        });
        await user.save();
        results.created.push({ email: row.email, _id: user._id });
        emailsToSend.push({
          email: row.email,
          firstName: row.firstName,
          userName,
          password: plainPassword,
        });
      } catch (err) {
        results.skipped.push({
          email: row.email,
          reason: err.message || "Save failed",
        });
      }
    }

    // Fire-and-forget welcome emails, staggered so we don't burst the SMTP
    // provider. Matches the teacher path's 5-second cadence.
    emailsToSend.forEach((info, index) => {
      setTimeout(() => {
        const html = `
          <h3>Welcome to Enlighten Room!</h3>
          <p>Your account has been created.</p>
          <p><strong>Email:</strong> ${info.email}</p>
          <p><strong>Username:</strong> ${info.userName}</p>
          <p><strong>Password:</strong> ${info.password}</p>
          <p>You can now log in and start using the platform.</p>
        `;
        addSendEmail(info.email, "Your Enlighten Room Account", html).catch(
          (err) =>
            console.error(
              "Failed to send student welcome email to",
              info.email,
              err.message
            )
        );
      }, index * 5000);
    });

    return res.status(201).json({
      message: `Processed ${parsedStudents.length} rows. Created ${results.created.length}, skipped ${results.skipped.length}.`,
      totalCreated: results.created.length,
      totalSkipped: results.skipped.length,
      results,
    });
  } catch (error) {
    console.error("bulkCreateStudents error:", error);
    return res.status(500).json({
      error: "Failed to process student Excel file.",
      details: error.message,
    });
  }
}
