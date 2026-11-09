import crypto from "crypto";
import mongoose from "mongoose";
import nodemailer from "nodemailer";

import ReportAccessToken from "../models/ReportAccessTokenModel.js";
import Lesson from "../models/LessonModel.js";
import Session from "../models/SessionModel.js";
import ClassworkModel from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";
import User from "../models/user.js";
import LessonReportSent from "../models/LessonReportSentModel.js";
import {
  projectAiReport,
  getSubmittedAnswerImage,
  formatSubmittedAnswerText,
  resolveTeacherIdForRoom,
} from "./classworkController.js";
import { buildLessonReportEmail } from "../utils/emailTemplates/lessonReportEmail.js";

// Task 2: tokenized public lesson-report viewer.
// Replaces the previous CSV-by-email flow. Teacher clicks Send Report ->
// backend issues a 90-day random token per recipient, emails an HTML link
// (no attachment), and the recipient opens a public web viewer that renders
// LaTeX equations and handwritten images properly.

// Shared nodemailer instance — same gmail transport the rest of the app
// uses. Lazy-initialised so test environments without SMTP credentials
// still boot.
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.NODEMAILER_EMAIL,
      pass: process.env.NODEMAILER_PASSCODE,
    },
  });
  return _transporter;
}

// 90-day validity per Task 2 spec.
const TOKEN_TTL_DAYS = 90;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

// crypto.randomBytes(32) -> 64 hex chars -> 256 bits of entropy.
// Collision probability is astronomically low; we still catch the unique-index
// error and retry once in the (never-going-to-happen) edge case.
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Build the public viewer URL the recipient clicks in the email.
// FRONTEND_URL must be set in Backend .env (already used by paymentController
// for Stripe redirects, so this is a safe shared convention).
function buildViewUrl(token) {
  const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  return `${base}/reports/lesson/${token}`;
}

/**
 * POST /api/classwork/send-report
 * (Replaces the old CSV-attachment flow. Route path unchanged for frontend
 *  compatibility; implementation now issues tokens + HTML emails.)
 *
 * Teacher-only (route-level auth). Body:
 *   {
 *     roomId: string,
 *     lessonId: string,                          // NEW: single-lesson scope
 *     recipients: [{studentId, email, role}],    // role: 'student'|'parent'
 *     message: string?                           // optional custom note
 *   }
 *
 * Backwards-compat: also accepts the older `emailIds: [{studentId, email}]`
 * shape (no role field) and defaults role='student' for those. Delete this
 * fallback once the frontend has been updated for a release cycle.
 */
export const dispatchLessonReportLinks = async (req, res) => {
  try {
    const { roomId, lessonId, lessonName, message } = req.body || {};
    // Accept either `recipients` (new) or `emailIds` (old). Normalise to one shape.
    const rawRecipients = Array.isArray(req.body?.recipients)
      ? req.body.recipients
      : Array.isArray(req.body?.emailIds)
        ? req.body.emailIds.map((e) => ({ ...e, role: e.role || "student" }))
        : [];

    if (!roomId || !Array.isArray(rawRecipients) || rawRecipients.length === 0) {
      return res.status(400).json({
        message: "roomId and recipients[] are required.",
      });
    }
    if (!lessonId && !lessonName) {
      return res.status(400).json({
        message:
          "lessonId or lessonName is required. Please pick a lesson before sending the report.",
      });
    }

    // Session lookup moved up so we can resolve the room's classroomId before
    // falling back on it for the lesson lookup. Best-effort — some rooms
    // predate the Session model; if missing, we can't do the sibling-room
    // fallback and rely on the direct (roomId, name) match.
    const session = await Session.findOne({ sessionUrl: { $regex: roomId } })
      .select("_id topic classroomId")
      .lean();

    // Resolve lesson — accept either explicit lessonId, or lessonName.
    // The teacher's Session Report modal is a COMBINED view across sibling
    // sessions (same classroomId, different roomId), so the picked lesson may
    // live under a different roomId than the one the teacher first clicked.
    // We therefore:
    //   1) try (roomId, name) direct match (preserves single-room behaviour);
    //   2) fall back to (classroomId, name) via the Session classroomId lookup;
    //   3) hard-fail if neither finds a lesson.
    let lesson = null;
    if (lessonId && mongoose.Types.ObjectId.isValid(lessonId)) {
      lesson = await Lesson.findById(lessonId).lean();
    } else if (lessonName) {
      lesson = await Lesson.findOne({ roomId, name: lessonName }).lean();
      if (!lesson && session?.classroomId) {
        lesson = await Lesson.findOne({
          classroomId: session.classroomId,
          name: lessonName,
        }).lean();
      }
    }
    if (!lesson) {
      return res.status(404).json({
        message: "Lesson not found for the provided lessonId / lessonName.",
      });
    }
    // From here on, use the resolved lesson._id and its actual roomId. We
    // stop requiring lesson.roomId === roomId because sibling-session
    // combined reports legitimately pick lessons from a different room.
    const resolvedLessonId = lesson._id;
    const resolvedRoomId = String(lesson.roomId || roomId);

    // Resolve teacher by roomId (matches the existing /send-report route
    // which has no auth_token middleware, so req.user isn't available).
    // Falls back to req.user if middleware does get added later, or to an
    // explicit teacherId body param as an escape hatch for server-to-server
    // calls.
    const teacherId =
      (await resolveTeacherIdForRoom(roomId).catch(() => null)) ||
      req.user?._id ||
      req.user?.id ||
      req.body?.teacherId;
    if (!teacherId) {
      return res.status(401).json({
        message: "Could not identify the teacher for this room.",
      });
    }
    const teacher = await User.findById(teacherId)
      .select("firstName lastName name userName email")
      .lean();
    const teacherName =
      [teacher?.firstName, teacher?.lastName].filter(Boolean).join(" ") ||
      teacher?.name ||
      teacher?.userName ||
      "Your teacher";

    // Pre-resolve student names for all referenced studentIds in one query.
    const studentIds = [
      ...new Set(
        rawRecipients
          .map((r) => r.studentId)
          .filter((id) => id && mongoose.Types.ObjectId.isValid(id))
      ),
    ];
    const students = await User.find({ _id: { $in: studentIds } })
      .select("firstName lastName name userName")
      .lean();
    const studentById = new Map(students.map((s) => [String(s._id), s]));

    const transporter = getTransporter();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    // Parallel dispatch: one token + email per recipient. allSettled so a
    // single failing send doesn't abort the rest.
    const results = await Promise.allSettled(
      rawRecipients.map(async (r) => {
        const to = r.email || r.to;
        const studentId = r.studentId;
        const role = r.role === "parent" ? "parent" : "student";
        if (!to || !studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
          throw new Error(`Invalid recipient entry: ${JSON.stringify(r)}`);
        }

        // Create token row first so we can drop the email body on top.
        // Retry once on unique-index collision (effectively never fires).
        let token;
        for (let attempt = 0; attempt < 2; attempt++) {
          token = generateToken();
          try {
            await ReportAccessToken.create({
              token,
              lessonId: resolvedLessonId,
              roomId: resolvedRoomId,
              studentId,
              teacherId,
              recipientRole: role,
              sentToEmail: to,
              expiresAt,
            });
            break;
          } catch (err) {
            if (attempt === 1 || err?.code !== 11000) throw err;
            // else: token collision, loop to retry with new token
          }
        }

        // Compose personalised email body.
        const studentDoc = studentById.get(String(studentId));
        const studentName =
          [studentDoc?.firstName, studentDoc?.lastName].filter(Boolean).join(" ") ||
          studentDoc?.name ||
          studentDoc?.userName ||
          "the student";
        const recipientName = role === "parent" ? "Parent" : studentName;

        const { subject, html, text } = buildLessonReportEmail({
          recipientName,
          studentName,
          lessonName: lesson.name || "the lesson",
          sessionTopic: session?.topic || "",
          teacherName,
          viewUrl: buildViewUrl(token),
          customMessage: message || "",
          isParent: role === "parent",
        });

        await transporter.sendMail({
          from: process.env.NODEMAILER_EMAIL,
          to,
          subject,
          html,
          text,
        });

        // Log only the token prefix — never full tokens. Full token leaks via
        // DO Runtime Logs would grant report access to anyone with log access.
        console.log(
          `[LessonReport] sent to ${to} (${role}) — lesson=${resolvedLessonId} student=${studentId} token=${token.slice(0, 8)}...`
        );

        return { studentId, email: to, role };
      })
    );

    // Also stamp LessonReportSent so the existing per-month quota logic
    // (`requireUsageBudget('lessonReports', ...)` middleware) doesn't need
    // to be rewritten. One row per (teacherId, lessonId) — upsert so
    // multiple dispatches to different students for the same lesson only
    // count as 1 against the quota (matches the pre-tokenisation behaviour).
    try {
      await LessonReportSent.updateOne(
        { teacherId, lessonId: resolvedLessonId },
        {
          $setOnInsert: {
            teacherId,
            lessonId: resolvedLessonId,
            sentAt: new Date(),
          },
          $addToSet: { kinds: "tokenized-link" },
        },
        { upsert: true }
      );
    } catch (quotaErr) {
      // Non-fatal — the emails already went out. Log and continue.
      console.warn(
        "[LessonReport] Failed to stamp LessonReportSent:",
        quotaErr?.message
      );
    }

    const success = results.filter((r) => r.status === "fulfilled").length;
    const failed = results
      .filter((r) => r.status === "rejected")
      .map((r, i) => ({
        recipient: rawRecipients[i]?.email,
        error: r.reason?.message || String(r.reason),
      }));

    return res.status(200).json({
      message: "Report dispatch completed.",
      success,
      failed,
      total: results.length,
    });
  } catch (err) {
    console.error("[LessonReport] Dispatch error:", err);
    return res
      .status(500)
      .json({ message: "Failed to dispatch lesson report links.", error: err.message });
  }
};

/**
 * GET /api/report-link/view/:token
 * PUBLIC (no auth middleware).
 *
 * Returns the single-lesson report JSON that the public React page renders.
 * Expired/invalid tokens return 410/404 so the frontend can show the
 * appropriate "expired" / "not found" UI.
 */
export const viewLessonReportByToken = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || typeof token !== "string" || token.length < 32) {
      return res.status(404).json({ message: "Report link not found." });
    }

    const row = await ReportAccessToken.findOne({ token });
    if (!row) {
      return res.status(404).json({ message: "Report link not found." });
    }
    if (row.expiresAt.getTime() <= Date.now()) {
      return res.status(410).json({
        expired: true,
        message:
          "This report link has expired. Please log in to your Enlighten Room account to view past reports.",
      });
    }

    const { lessonId, roomId, studentId } = row;

    // Load the single lesson this token scopes to.
    const lesson = await Lesson.findById(lessonId)
      .select("_id name roomId status startedAt endedAt classReport")
      .lean();
    if (!lesson) {
      return res.status(404).json({
        message: "Lesson not found. It may have been removed.",
      });
    }

    // Load classwork for the room, filtered to this lesson's name. If the
    // lesson name has drifted from the classwork rows (rare but possible —
    // see the drift-recovery notes in classworkController.getStudentLessonReport),
    // fall back to any question whose student submission timestamp sits within
    // the lesson's [startedAt, endedAt] window.
    const allQuestions = await ClassworkModel.find({ roomId }).lean();
    let questions = allQuestions.filter(
      (q) => (q.lessonName || "") === (lesson.name || "")
    );
    if (questions.length === 0 && (lesson.startedAt || lesson.endedAt)) {
      const started = lesson.startedAt ? new Date(lesson.startedAt).getTime() : null;
      const ended = lesson.endedAt ? new Date(lesson.endedAt).getTime() : null;
      questions = allQuestions.filter((q) =>
        (q.submitted || []).some((s) => {
          if (String(s.studentId) !== String(studentId)) return false;
          if (!s.submittedAt) return false;
          const t = new Date(s.submittedAt).getTime();
          if (Number.isNaN(t)) return false;
          if (started != null && t < started) return false;
          if (ended != null && t > ended) return false;
          return true;
        })
      );
    }

    // Load this student's AI report rows for all questions in this room,
    // then index by questionId for per-question attempt-history lookup.
    const aiReports = await ClassworkAiReport.find({ roomId, studentId }).lean();
    const reportIndex = new Map();
    aiReports.forEach((r) => {
      reportIndex.set(String(r.questionId), r);
    });

    // Project each question for the student's view — SAME shape as the
    // authenticated StudentLessonReportModal consumes, so the shared
    // LessonReportView React component can render both. includeStudentAnswer
    // is true because the viewer is the student (or their parent) seeing
    // their own attempts.
    const projectedQuestions = questions.map((q) => {
      const submission = (q.submitted || []).find(
        (s) => String(s.studentId) === String(studentId)
      );
      const aiReport = reportIndex.get(String(q.id)) || null;
      return {
        id: q.id,
        _id: q._id,
        label: q.label,
        title: q.title,
        question: q.question,
        image: q.image || "",
        format: q.format || q.formatLabel || "",
        correctAnswer: q.correctAnswer,
        lessonName: q.lessonName || "",
        submission: submission
          ? {
              answer: formatSubmittedAnswerText(submission.answer),
              answerImage: getSubmittedAnswerImage(submission.answer),
              isCorrect: Boolean(submission.isCorrect),
              feedback: submission.feedback || "",
              submittedAt: submission.submittedAt || null,
            }
          : null,
        aiReport: aiReport
          ? projectAiReport(aiReport, { includeStudentAnswer: true })
          : null,
      };
    });

    // Student name for the report header. Best-effort — if the user doc is
    // missing (deleted student?), fall back to a generic label so the page
    // still renders.
    const studentDoc = await User.findById(studentId)
      .select("firstName lastName name userName")
      .lean();
    const studentName =
      [studentDoc?.firstName, studentDoc?.lastName].filter(Boolean).join(" ") ||
      studentDoc?.name ||
      studentDoc?.userName ||
      "Student";

    // Fire-and-forget access tracking. Don't await — slow Mongo write
    // shouldn't delay serving the page.
    ReportAccessToken.updateOne(
      { _id: row._id },
      { $inc: { viewCount: 1 }, $set: { lastAccessedAt: new Date() } }
    ).catch((err) =>
      console.warn("[LessonReport] Failed to update view analytics:", err?.message)
    );

    // Don't let public report URLs get cached by proxies/CDNs — the DB state
    // for attempts can change (e.g. teacher regenerates the class report).
    res.set("Cache-Control", "private, no-store, max-age=0");

    return res.status(200).json({
      // Mirror the shape of getStudentLessonReport({ lessons: [...] }) but
      // always exactly ONE lesson. Keeps the React LessonReportView generic.
      lessons: [
        {
          name: lesson.name,
          status: lesson.status,
          startedAt: lesson.startedAt,
          endedAt: lesson.endedAt,
          classReport:
            lesson.classReport && lesson.classReport.generatedAt
              ? {
                  studentDifficulties: Array.isArray(
                    lesson.classReport.studentDifficulties
                  )
                    ? lesson.classReport.studentDifficulties
                    : [],
                  nextLessonStrategy: Array.isArray(
                    lesson.classReport.nextLessonStrategy
                  )
                    ? lesson.classReport.nextLessonStrategy
                    : [],
                  targetedHomework: Array.isArray(
                    lesson.classReport.targetedHomework
                  )
                    ? lesson.classReport.targetedHomework
                    : [],
                  generatedAt: lesson.classReport.generatedAt,
                  model: lesson.classReport.model || "",
                }
              : null,
          questions: projectedQuestions,
        },
      ],
      student: { name: studentName },
      // Expose expiry to the frontend so the viewer can show "expires in X days"
      // if desired (not shown by default to keep the page clean).
      meta: {
        expiresAt: row.expiresAt,
        generatedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("[LessonReport] View error:", err);
    return res
      .status(500)
      .json({ message: "Failed to load report.", error: err.message });
  }
};
