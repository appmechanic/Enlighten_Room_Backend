// controllers/adminDashboard.controller.js
import User from "../models/user.js";
import Classroom from "../models/classroomModel.js";
import Session from "../models/SessionModel.js";
import Assignment from "../models/AssignmentModel.js";
import subscriberModel from "../models/subscriberModel.js";
import { sendTeacherWelcomeEmail } from "../utils/emailService.js";
import { parseTeachersFromExcel } from "../utils/parseTeachersFromExcel.js";
import multer from "multer";
import bcrypt from "bcrypt";
import { generateStrongPassword } from "../utils/passwordGenerator.js";
import axios from "axios";

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
