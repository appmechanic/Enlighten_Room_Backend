// Smoke test for the school-admin signup path.
//
// Runs three verifySchool scenarios (match / wrong-domain / garbage-org),
// then simulates the signup controller's decision by writing real User docs
// and asserting userRole + schoolVerification land correctly.
//
// The SMTP-based sendEmail() path is intentionally bypassed — this test only
// covers the new logic (role selection + verification write). Test users are
// deleted at the start and end so the script is idempotent.
//
// Usage:
//   node --env-file=.env scripts/testSchoolAdminSignup.js

import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/user.js";
import RegisteredSchool from "../models/RegisteredSchool.js";
import { verifySchool } from "../utils/schoolVerifier.js";

const TEST_EMAIL_TAG = "schooladmin-test";
const isTestUser = { email: { $regex: `${TEST_EMAIL_TAG}-` } };

const SCENARIOS = [
  {
    label: "MATCH — known school, matching domain",
    email: `${TEST_EMAIL_TAG}-verified@dpsrkp.net`,
    organization: "DPS RK Puram",
    expected: "verified",
  },
  {
    label: "REJECT — known school, wrong domain",
    email: `${TEST_EMAIL_TAG}-baddomain@gmail.com`,
    organization: "Diocesan Boys' School",
    expected: "rejected",
  },
  {
    label: "REJECT — org not in registry",
    email: `${TEST_EMAIL_TAG}-noorg@fictional-school-xyz.edu`,
    organization: "Totally Fictional Academy 999",
    expected: "rejected",
  },
];

const check = (label, ok, extra = "") => {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) process.exitCode = 1;
};

const simulateSignup = async ({ email, organization, requestedRole }) => {
  let schoolVerification = {
    status: "pending",
    matchedSchoolId: null,
    reason: "",
    verifiedAt: null,
  };
  let userRole = "teacher";

  if (requestedRole === "schoolAdmin") {
    const result = await verifySchool({ email, organization });
    if (result.verified) {
      userRole = "schoolAdmin";
      schoolVerification = {
        status: "verified",
        matchedSchoolId: result.matchedSchoolId,
        reason: result.reason,
        verifiedAt: new Date(),
      };
    } else {
      schoolVerification = {
        status: "rejected",
        matchedSchoolId: null,
        reason: result.reason,
        verifiedAt: null,
      };
    }
  }

  const user = await User.create({
    firstName: "Test",
    lastName: "SchoolAdmin",
    email,
    phone: "0000000000",
    password: "password123",
    organization,
    userName: `${TEST_EMAIL_TAG}-${Date.now()}${Math.floor(Math.random() * 1000)}`,
    OTP_code: "0000",
    userRole,
    schoolVerification,
  });
  return user;
};

async function main() {
  if (!process.env.DB_URL) {
    console.error("DB_URL is not set. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DB_URL);
  console.log("Connected to MongoDB.\n");

  // Clean out prior test users so the script is idempotent.
  const cleaned = await User.deleteMany(isTestUser);
  if (cleaned.deletedCount) {
    console.log(`Cleaned ${cleaned.deletedCount} leftover test user(s).\n`);
  }

  const registeredCount = await RegisteredSchool.countDocuments({
    status: "active",
  });
  console.log(`Registered schools in DB: ${registeredCount}`);
  if (!registeredCount) {
    console.error(
      "No active RegisteredSchool docs — run scripts/seedRegisteredSchools.js first."
    );
    process.exit(1);
  }
  console.log("");

  // ─── Part 1: verifySchool direct calls ────────────────────────────────
  console.log("── verifySchool direct calls ──");
  for (const s of SCENARIOS) {
    const t0 = Date.now();
    const result = await verifySchool({
      email: s.email,
      organization: s.organization,
    });
    const ms = Date.now() - t0;
    const gotStatus = result.verified ? "verified" : "rejected";
    console.log(
      `  ${s.label}\n    → ${gotStatus} in ${ms}ms (reason: ${result.reason || "n/a"})`
    );
    check(
      `verifySchool status matches expected (${s.expected})`,
      gotStatus === s.expected
    );
    if (s.expected === "verified") {
      check("matchedSchoolId is set on verified result", !!result.matchedSchoolId);
    } else {
      check(
        "matchedSchoolId is null on rejected result",
        result.matchedSchoolId === null
      );
    }
  }

  // ─── Part 2: full simulated signup writes User docs ────────────────────
  console.log("\n── simulated signup → User.create ──");
  const created = [];

  // 2a: schoolAdmin + valid school → user should become schoolAdmin
  {
    const u = await simulateSignup({
      email: `${TEST_EMAIL_TAG}-ok@enlightendemo.edu`,
      organization: "Enlighten Demo School",
      requestedRole: "schoolAdmin",
    });
    created.push(u);
    console.log(
      `  A) schoolAdmin request + valid school → role=${u.userRole}, status=${u.schoolVerification?.status}`
    );
    check("role is schoolAdmin", u.userRole === "schoolAdmin");
    check(
      "schoolVerification.status is verified",
      u.schoolVerification?.status === "verified"
    );
    check(
      "matchedSchoolId is populated",
      !!u.schoolVerification?.matchedSchoolId
    );
  }

  // 2b: schoolAdmin + fake school → user should fall back to teacher
  {
    const u = await simulateSignup({
      email: `${TEST_EMAIL_TAG}-fallback@nowhere.example`,
      organization: "Made Up College Of Nothing",
      requestedRole: "schoolAdmin",
    });
    created.push(u);
    console.log(
      `  B) schoolAdmin request + fake school → role=${u.userRole}, status=${u.schoolVerification?.status}`
    );
    check("role falls back to teacher", u.userRole === "teacher");
    check(
      "schoolVerification.status is rejected",
      u.schoolVerification?.status === "rejected"
    );
    check(
      "matchedSchoolId is null",
      u.schoolVerification?.matchedSchoolId == null
    );
    check(
      "reason is populated",
      !!u.schoolVerification?.reason
    );
  }

  // 2c: teacher request → schoolVerification stays 'pending'
  {
    const u = await simulateSignup({
      email: `${TEST_EMAIL_TAG}-teacher@example.com`,
      organization: "Some Tuition Center",
      requestedRole: "teacher",
    });
    created.push(u);
    console.log(
      `  C) teacher request → role=${u.userRole}, status=${u.schoolVerification?.status}`
    );
    check("role is teacher", u.userRole === "teacher");
    check(
      "schoolVerification.status stays pending",
      u.schoolVerification?.status === "pending"
    );
  }

  // Round-trip read to confirm docs really persisted with the new fields.
  const roundTrip = await User.find(isTestUser)
    .select("email userRole schoolVerification")
    .lean();
  console.log(`\n  Round-trip: ${roundTrip.length} test user(s) in DB:`);
  for (const u of roundTrip) {
    console.log(
      `    - ${u.email}  role=${u.userRole}  status=${u.schoolVerification?.status}`
    );
  }
  check(
    "all three test users persisted",
    roundTrip.length === 3
  );

  // Clean up test users so the DB isn't polluted.
  const removed = await User.deleteMany(isTestUser);
  console.log(`\nCleaned ${removed.deletedCount} test user(s).`);

  await mongoose.disconnect();
  console.log(
    process.exitCode ? "\n✗ Some assertions failed." : "\n✓ All assertions passed."
  );
  process.exit(process.exitCode || 0);
}

main().catch(async (err) => {
  console.error("Test failed:", err);
  try {
    await User.deleteMany(isTestUser);
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
