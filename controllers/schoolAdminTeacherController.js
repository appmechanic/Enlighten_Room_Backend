// SchoolAdmin-facing teacher management. Mirrors the admin bulk-upload flow
// (adminDashboardController.bulkCreateTeachers) but scoped to the school
// admin's own school and capped at their Subscription → Plan.limits.maxTeachers.
//
// Auth guarantees: routes go through auth_token + requireSchoolAdmin, so
// req.user.userRole === "schoolAdmin" and schoolVerification.status
// === "verified" (with a matchedSchoolId) by the time these handlers run.

import bcrypt from "bcrypt";
import axios from "axios";
import User from "../models/user.js";
import Subscription from "../models/SubscriptionModel.js";
import { parseTeachersFromExcel } from "../utils/parseTeachersFromExcel.js";
import { generateStrongPassword } from "../utils/passwordGenerator.js";
import { sendTeacherWelcomeEmail } from "../utils/emailService.js";

// Middleware: reject anyone who isn't an approved schoolAdmin. Also loads the
// remaining seat count onto req.schoolContext so handlers don't re-query.
export const requireSchoolAdmin = async (req, res, next) => {
  const user = req.user;
  if (!user || user.userRole !== "schoolAdmin") {
    return res
      .status(403)
      .json({ message: "Access denied. School admins only." });
  }
  const schoolId = user.schoolVerification?.matchedSchoolId || null;
  if (!schoolId || user.schoolVerification?.status !== "verified") {
    return res.status(403).json({
      message:
        "Your school admin account is not yet verified. Contact support.",
    });
  }
  req.schoolContext = { schoolId, schoolAdminId: user._id };
  next();
};

// Look up the schoolAdmin's active plan and return `maxTeachers`, or Infinity
// when unlimited / no active plan. Missing plan → 0 (so the SA can't add
// teachers without a subscription; safer than silently uncapped).
async function getSeatLimit(schoolAdminId) {
  const sub = await Subscription.findOne({
    userId: schoolAdminId,
    status: "active",
  })
    .populate({ path: "planType", select: "limits name planType" })
    .lean();
  const cap = sub?.planType?.limits?.maxTeachers;
  if (cap == null) {
    // No plan attached → treat as zero seats; the SA must subscribe before
    // adding teachers. If they have an active sub but its plan has null
    // maxTeachers, that legitimately means unlimited.
    return { limit: sub ? Infinity : 0, plan: sub?.planType || null };
  }
  return { limit: Number(cap), plan: sub?.planType || null };
}

async function countSchoolTeachers(schoolId) {
  return User.countDocuments({ userRole: "teacher", schoolId });
}

// GET /api/school-admin/teachers
// Returns the list of teachers belonging to this school PLUS the current
// seat headroom so the UI can render "X / Y seats used" without a second call.
export const listSchoolTeachers = async (req, res) => {
  try {
    const { schoolId, schoolAdminId } = req.schoolContext;
    const [teachers, { limit, plan }] = await Promise.all([
      User.find({ userRole: "teacher", schoolId })
        .select(
          "firstName lastName email phone organization gender createdAt is_active"
        )
        .sort({ createdAt: -1 })
        .lean(),
      getSeatLimit(schoolAdminId),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        teachers,
        seats: {
          used: teachers.length,
          limit: Number.isFinite(limit) ? limit : null,
          plan: plan
            ? { _id: String(plan._id), name: plan.name, planType: plan.planType }
            : null,
        },
      },
    });
  } catch (err) {
    console.error("listSchoolTeachers error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/school-admin/teachers
// Creates a single teacher, tagged with schoolId + schoolAdminId. Rejects
// (409) on duplicate email and (402/LIMIT_REACHED) when the seat cap is
// already hit — matches the requireUsageBudget middleware's shape so the
// UI can reuse its quota-hit modal.
export const createSchoolTeacher = async (req, res) => {
  try {
    const { schoolId, schoolAdminId } = req.schoolContext;
    const { firstName, lastName, email, phone, gender, organization } =
      req.body || {};
    if (!firstName || !email) {
      return res
        .status(400)
        .json({ success: false, message: "firstName and email are required" });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: normalizedEmail }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: "A user with this email already exists.",
      });
    }

    const [{ limit }, used] = await Promise.all([
      getSeatLimit(schoolAdminId),
      countSchoolTeachers(schoolId),
    ]);
    if (used >= limit) {
      return res.status(402).json({
        success: false,
        error: "LIMIT_REACHED",
        category: "teachers",
        used,
        limit: Number.isFinite(limit) ? limit : null,
        message:
          "You've reached the teacher seat limit for your current plan.",
      });
    }

    const plainPassword = generateStrongPassword(10);
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const fn = String(firstName).trim();
    const ln = lastName ? String(lastName).trim() : "";

    const teacher = await User.create({
      firstName: fn,
      lastName: ln,
      email: normalizedEmail,
      phone: phone ? String(phone).trim() : "",
      organization: organization ? String(organization).trim() : "",
      gender: gender ? String(gender).trim() : undefined,
      userRole: "teacher",
      userName: `${fn}.${ln}`.toLowerCase(),
      is_active: true,
      is_verified: true,
      password: passwordHash,
      schoolId,
      schoolAdminId,
      referedBy: schoolAdminId,
    });

    sendTeacherWelcomeEmail({
      email: teacher.email,
      name: teacher.firstName,
      password: plainPassword,
    }).catch((e) =>
      console.error("welcome email failed:", teacher.email, e?.message)
    );

    const created = teacher.toObject();
    delete created.password;
    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    console.error("createSchoolTeacher error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/school-admin/teachers/bulk-upload
// Accepts multipart/form-data (Excel file under "file") OR JSON { excelUrl }.
// The parser mirrors the admin route so a school admin can use the same
// template. Rows that would exceed the seat cap are truncated (with a note in
// the response) rather than partially inserted — never leave the SA in a
// half-imported state.
export const bulkCreateSchoolTeachers = async (req, res) => {
  try {
    const { schoolId, schoolAdminId } = req.schoolContext;

    let buffer;
    let excelUrl = req.body?.excelUrl;
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
      return res.status(400).json({
        success: false,
        message: "Please upload an Excel file OR provide excelUrl.",
      });
    }

    const parsedTeachers = parseTeachersFromExcel(buffer);
    if (!parsedTeachers.length) {
      return res.status(400).json({
        success: false,
        message: "No valid teacher rows found in the Excel file.",
      });
    }

    const [{ limit }, used] = await Promise.all([
      getSeatLimit(schoolAdminId),
      countSchoolTeachers(schoolId),
    ]);
    const remaining = Number.isFinite(limit) ? Math.max(limit - used, 0) : Infinity;
    if (remaining === 0) {
      return res.status(402).json({
        success: false,
        error: "LIMIT_REACHED",
        category: "teachers",
        used,
        limit,
        message:
          "You've reached the teacher seat limit for your current plan.",
      });
    }

    const docsToInsert = [];
    const emailsToSend = [];
    const skippedExisting = [];
    let truncated = 0;

    for (const t of parsedTeachers) {
      if (docsToInsert.length >= remaining) {
        truncated++;
        continue;
      }
      const normalizedEmail = String(t.email).trim().toLowerCase();
      const existing = await User.findOne({ email: normalizedEmail }).lean();
      if (existing) {
        skippedExisting.push(normalizedEmail);
        continue;
      }
      const plainPassword = generateStrongPassword(10);
      const passwordHash = await bcrypt.hash(plainPassword, 10);
      docsToInsert.push({
        firstName: t.firstName,
        lastName: t.lastName,
        email: normalizedEmail,
        phone: t.phone,
        organization: t.organization,
        gender: t.gender || undefined,
        userRole: "teacher",
        userName: t.userName,
        is_active: true,
        is_verified: true,
        password: passwordHash,
        schoolId,
        schoolAdminId,
        referedBy: schoolAdminId,
      });
      emailsToSend.push({
        email: normalizedEmail,
        name: t.firstName,
        password: plainPassword,
      });
    }

    if (!docsToInsert.length) {
      return res.status(400).json({
        success: false,
        message:
          "No new teachers were created — all emails already exist or seat cap reached.",
        skippedExisting,
        truncated,
      });
    }

    const created = await User.insertMany(docsToInsert);

    emailsToSend.forEach((info, index) => {
      const delay = index * 5000;
      setTimeout(async () => {
        try {
          await sendTeacherWelcomeEmail(info);
        } catch (err) {
          console.error(
            "welcome email failed:",
            info.email,
            err.message
          );
        }
      }, delay);
    });

    return res.status(201).json({
      success: true,
      totalCreated: created.length,
      skippedExisting,
      truncated,
      seats: {
        used: used + created.length,
        limit: Number.isFinite(limit) ? limit : null,
      },
    });
  } catch (err) {
    console.error("bulkCreateSchoolTeachers error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to process teacher Excel file.",
      details: err.message,
    });
  }
};
