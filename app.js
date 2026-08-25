import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import multer from "multer";
import bodyParser from "body-parser";
import cron from "node-cron";
dotenv.config();
import fs from "fs";
import mongoose from "mongoose";

// Hardening middlewares are loaded dynamically so the server still boots
// on a checkout where `npm install` hasn't been re-run since they were
// added to package.json. Each returns null when missing; the wiring
// below no-ops for anything that failed to load. Recommended: run
// `npm install` to enable them all.
async function optionalImport(name) {
  try {
    const mod = await import(name);
    return mod.default ?? mod;
  } catch {
    console.warn(
      `[app] Optional middleware "${name}" not installed — skipping. Run \`npm install\` to enable it.`
    );
    return null;
  }
}
const [helmet, compression, morgan, rateLimit] = await Promise.all([
  optionalImport("helmet"),
  optionalImport("compression"),
  optionalImport("morgan"),
  optionalImport("express-rate-limit"),
]);
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/user.js";
import keysRoutes from "./routes/keys.js";
import crudRoutes from "./routes/crud.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import classworkRoutes from "./routes/classworkRoutes.js";
import studentRoutes from "./routes/studentRoutes.js";
import parentRoutes from "./routes/parentRoutes.js";
import driveRoutes from "./routes/driveRoutes.js";
import teacherDriveRoutes from "./routes/teacherDriveRoutes.js";
import studentDriveRoutes from "./routes/studentDriveRoutes.js";
import classroomRoutes from "./routes/classroomRoutes.js";
import reminderRoutes from "./routes/reminderRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import subscriptionRoutes from "./routes/subscriptionRoutes.js";
import planRoutes from "./routes/planRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import paypalRoutes from "./routes/paypalRoutes.js";
import questionRoutes from "./routes/questionRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import notificationRoutes from "./routes/notificationsRoutes.js";
import promotionRoutes from "./routes/promotionRoutes.js";
import languageRoutes from "./routes/languageRoutes.js";
import timezoneRoutes from "./routes/timezoneRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import assignmentRoutes from "./routes/assignmentRoutes.js";
import testRoutes from "./routes/testRoutes.js";
import assessmentRoutes from "./routes/assessmentRoutes.js";
import subjectRoutes from "./routes/subjectRoutes.js";
import sessionRoutes from "./routes/sessionRoutes.js";
import GradeSettingRoutes from "./routes/gradeSettingRoutes.js";
import GradeSubmissionRoutes from "./routes/gradedSubmissionRoutes.js";
import PrivacyPolicyRoutes from "./routes/privacyPolicyRoutes.js";
import ResourcesRoutes from "./routes/resourcesRoutes.js";
import testimonialRoutes from "./routes/testimonialRoutes.js";
import teamRoutes from "./routes/teamRoutes.js";
import partnerRoutes from "./routes/partnerRoutes.js";

import billingRoutes from "./routes/transactionRoutes.js";
import subscriberRoutes from "./routes/subscriberRoutes.js";
import articleRoutes from "./routes/articleRoutes.js";
import connectToDatabase from "./config/db.js";
import Keys from "./models/keys.js";
import adminDashboardRoutes from "./routes/adminDashboardRoute.js";
import registeredSchoolRoutes from "./routes/registeredSchoolRoutes.js";
import schoolAdminReviewRoutes from "./routes/schoolAdminReviewRoutes.js";
import aiConfigRoutes from "./routes/aiConfigRoutes.js";
import whiteBoardRoutes from "./routes/whiteBoardRoute.js";
import contactRoutes from "./routes/contactRoutes.js";
import howItWorksRoutes from "./routes/howItWorks.routes.js";
import appSettingRoutes from "./routes/appSettingRoutes.js";
import homeCounterRoutes from "./routes/homeCounterRoute.js";
import focusAlertRoutes from "./routes/focusAlertRoutes.js";
import waitlistRoutes from "./routes/waitlistRoutes.js";
import { callback as googleCallback } from "./controllers/driveController.js";
import { createInitialKeyIfNotExists } from "./controllers/keys.js";
import currencyRoutes from "./routes/currencyRoutes.js";
import { fetchAndStoreCurrencyRates } from "./controllers/currencyController.js";

const app = express();

// Trust the first proxy hop (nginx/ALB) so req.ip resolves correctly for
// rate-limiting and audit logs. Moved above rate-limit init.
app.set("trust proxy", 1);

// Security headers. `crossOriginResourcePolicy` is relaxed so /uploads
// static assets can be embedded from the FrontEnd origin (video app +
// React admin run on different ports/subdomains than the API).
if (helmet) {
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
      contentSecurityPolicy: false, // API server; CSP set by frontends
    })
  );
}

// CORS: whitelist from env (comma-separated). Empty/missing → allow all
// (dev default). Never leaves prod without CORS_ORIGINS set — the boot
// warning surfaces the misconfig.
const corsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (process.env.NODE_ENV === "production" && corsOrigins.length === 0) {
  console.warn(
    "WARNING: CORS_ORIGINS is empty in production — allowing all origins"
  );
}
app.use(
  cors({
    origin: corsOrigins.length ? corsOrigins : true,
    credentials: true,
  })
);

if (compression) app.use(compression());
if (morgan) {
  app.use(
    morgan(process.env.NODE_ENV === "production" ? "combined" : "dev", {
      // Health-check spam pollutes logs; skip 2xx GETs on /health.
      skip: (req, res) => req.path === "/health" && res.statusCode < 400,
    })
  );
}

// Baseline rate limit for /api. Chosen to be permissive — teachers on a
// classwork panel can burst hundreds of small requests. Tighter limits
// live on the individual routes that need them (auth, AI, payments).
if (rateLimit) {
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX_PER_MIN || 300),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." },
  });
  app.use("/api", apiLimiter);
}

// Increase payload size limits (adjust as needed)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
// Ensure upload folder exists
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
// Connect DB
connectToDatabase();

createInitialKeyIfNotExists()
  .then(() => console.log("Initial key check completed"))
  .catch((err) => console.error("Error initializing key:", err));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/keys", keysRoutes);
app.use("/api/crud", crudRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/parents", parentRoutes);
app.use("/api/drive", driveRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/drive/teacher", teacherDriveRoutes);
app.use("/api/drive/student", studentDriveRoutes);
app.use("/api/classrooms", classroomRoutes);
app.use("/api/plans", planRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/paypal", paypalRoutes);
app.use("/api/question-bank", questionRoutes);
app.use("/api/analytics", analyticsRoutes);

// Classwork routes
app.use("/api/classwork", classworkRoutes);

app.use("/api/notifications", notificationRoutes);
app.use("/api/admin/promotions", promotionRoutes);
app.use("/api/system/languages", languageRoutes);
app.use("/api/system/timezones", timezoneRoutes);
app.use("/api/assignment", assignmentRoutes);
app.use("/api/test", testRoutes);
app.use("/api/assessments", assessmentRoutes);
app.use("/api/subject", subjectRoutes);
app.use("/api/session", sessionRoutes);
app.use("/api/submitted-report", GradeSubmissionRoutes);
app.use("/api/privacy-policy", PrivacyPolicyRoutes);
app.use("/api/grade-setting", GradeSettingRoutes);
app.use("/api/resources", ResourcesRoutes);
//testimonials
app.use("/api/testimonials", testimonialRoutes);
// articles
app.use("/api/articles", articleRoutes);
//contact form
app.use("/api/contact_form", contactRoutes);
// mount under /api/settings
app.use("/api/settings", howItWorksRoutes);
app.use("/api/settings", appSettingRoutes);
//stripe
// 1) Webhook FIRST w/ raw body
app.use("/api/billing/webhook", bodyParser.raw({ type: "application/json" }));
// 3) Normal billing routes
app.use("/api/billing", billingRoutes);
// currency rates
app.use("/api/currency", currencyRoutes);

// Schedule currency rate fetch every 8 hours (3 times a day)
cron.schedule("0 */8 * * *", async () => {
  try {
    await fetchAndStoreCurrencyRates(
      {},
      { status: () => ({ json: () => {} }) }
    );
    console.log("Currency rates updated by cron job");
  } catch (err) {
    console.error("Currency rate cron job failed:", err);
  }
});

//subscribers model
app.use("/api/subscribers", subscriberRoutes);
//wait list
app.use("/api/waitlist", waitlistRoutes);
//team members
app.use("/api/team", teamRoutes);
// admin dashboard
app.use("/api/admin", adminDashboardRoutes);
app.use("/api/admin/registered-schools", registeredSchoolRoutes);
app.use("/api/admin/school-admins", schoolAdminReviewRoutes);
// public AI tuning config (grade bands, multipliers) — read-only, no auth
app.use("/api/ai-config", aiConfigRoutes);
//home page counter
app.use("/api/home", homeCounterRoutes);

// white board
app.use("/api/ai", whiteBoardRoutes);
//focus alert routes
app.use("/api/alerts", focusAlertRoutes);
// partner Routes
app.use("/api/partners", partnerRoutes);
//
app.use("/uploads", express.static("uploads"));

// Health Check Endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP" });
});

app.get("/oauth2/callback", googleCallback);
// 404 Handler
app.use((req, res, next) => {
  res.status(404).json({ message: "Route not found" });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Multer-specific errors
    switch (err.code) {
      case "LIMIT_UNEXPECTED_FILE":
        return res
          .status(400)
          .json({ message: "Unexpected file field or file count exceeded" });
      case "LIMIT_FILE_SIZE":
        return res.status(400).json({ message: "File size limit exceeded" });
      case "LIMIT_FILE_COUNT":
        return res.status(400).json({ message: "Too many files uploaded" });
      case "LIMIT_FIELD_KEY":
        return res.status(400).json({ message: "Field key too large" });
      default:
        return res.status(400).json({ message: err.message });
    }
  } else if (err) {
    // General errors
    console.error(err.stack);
    return res
      .status(500)
      .json({ message: "An internal server error occurred" });
  }
  next();
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown: stop accepting new connections, drain in-flight
// requests, close the mongoose pool, then exit. Force-exit after
// SHUTDOWN_TIMEOUT_MS so stuck connections can't wedge the process.
const shutdown = (signal) => {
  console.log(`${signal} received — starting graceful shutdown`);
  server.close(async (err) => {
    if (err) {
      console.error("Error closing HTTP server:", err);
      process.exit(1);
    }
    try {
      await mongoose.connection.close(false);
      console.log("Mongoose disconnected — exiting");
      process.exit(0);
    } catch (dbErr) {
      console.error("Error closing mongoose connection:", dbErr);
      process.exit(1);
    }
  });
  setTimeout(() => {
    console.error("Forcing shutdown after timeout");
    process.exit(1);
  }, Number(process.env.SHUTDOWN_TIMEOUT_MS || 15000)).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Log-and-continue rather than crash: an unhandled promise rejection is
// often a bug in one request; the whole server going down starves the
// other in-flight requests. Combine with an APM (Sentry) later.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
