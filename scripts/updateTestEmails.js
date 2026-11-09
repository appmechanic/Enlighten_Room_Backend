// scripts/updateTestEmails.js
//
// Dev convenience: rewrites email addresses on test accounts in User / Parent
// collections so dispatched emails (e.g. the Task 2 lesson-report link) land
// in the developer's own inbox instead of the test accounts' real mailboxes.
//
// Usage:
//   1. Edit MAPPINGS below. Each key is the CURRENT email in Mongo; the value
//      is what to replace it with.
//   2. Dry-run (default — writes NOTHING):
//        node scripts/updateTestEmails.js
//   3. Actually apply:
//        node scripts/updateTestEmails.js --execute
//
// Safety:
//   - Dry-run prints every match + the exact change it would make. Review
//     carefully before adding --execute.
//   - Prints rollback commands (reverse mapping) at the end so you can undo.
//   - User/Parent emails are also the LOGIN identifier — changing a teacher's
//     or admin's email will lock them out of logging in until you change it
//     back. Only change STUDENT or PARENT emails for the dispatch-flow test.
//   - Script opens a new Mongoose connection using the Backend's DB_URL env
//     var. It does NOT depend on the running Backend process.

import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/user.js";
import Parent from "../models/parentModel.js";

// ─────────────────────────────────────────────────────────────────────────────
// EDIT THIS. Keys are the CURRENT email in Mongo. Values are what to write.
// Keep the admin and teacher accounts out of here unless you also plan to
// update your copy of Param's test credentials.
// ─────────────────────────────────────────────────────────────────────────────
const MAPPINGS = {
  // Example — replace with your own mappings before running:
  //   "test-student@example.com": "your-inbox@example.com",
  //   "test-parent@example.com":  "your-inbox+parent@example.com",
  // Gmail treats +tag as the same inbox, so student and parent emails can
  // both arrive in one inbox with different "To:" lines for easier triage.
};
// ─────────────────────────────────────────────────────────────────────────────

const EXECUTE = process.argv.includes("--execute");

function mask(email) {
  if (!email) return "(none)";
  const [local, domain] = String(email).split("@");
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}***@${domain}`;
}

async function main() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }

  const entries = Object.entries(MAPPINGS);
  if (entries.length === 0) {
    console.error(
      "MAPPINGS is empty. Edit scripts/updateTestEmails.js and set at least one { oldEmail: newEmail } pair."
    );
    process.exit(1);
  }

  console.log(
    `Mode: ${EXECUTE ? "EXECUTE (writes will be applied)" : "DRY-RUN (no writes)"}`
  );
  console.log(`DB: ${dbUrl.replace(/\/\/[^@]*@/, "//***:***@")}`);
  console.log(`Mappings: ${entries.length} email(s) to rewrite`);
  console.log("");

  await mongoose.connect(dbUrl);

  const rollback = [];
  let userHits = 0;
  let parentHits = 0;

  for (const [from, to] of entries) {
    if (!from || !to || from === to) {
      console.warn(`  SKIP — invalid mapping: ${from} -> ${to}`);
      continue;
    }

    // --- User collection ---
    const userMatches = await User.find({ email: from })
      .select("_id firstName lastName userName role email")
      .lean();
    for (const u of userMatches) {
      const display = [u.firstName, u.lastName].filter(Boolean).join(" ") ||
        u.userName || String(u._id);
      console.log(
        `  User  ${display} (${u.role || "?"})  ${mask(u.email)} -> ${mask(to)}`
      );
      rollback.push(`  "${to}": "${from}",`);
      userHits += 1;
      if (EXECUTE) {
        await User.updateOne({ _id: u._id }, { $set: { email: to } });
      }
    }
    if (userMatches.length === 0) {
      console.log(`  User  (no match for ${mask(from)})`);
    }

    // --- Parent collection ---
    const parentMatches = await Parent.find({ email: from })
      .select("_id firstName lastName userName email")
      .lean();
    for (const p of parentMatches) {
      const display = [p.firstName, p.lastName].filter(Boolean).join(" ") ||
        p.userName || String(p._id);
      console.log(
        `  Parent ${display}  ${mask(p.email)} -> ${mask(to)}`
      );
      rollback.push(`  "${to}": "${from}",`);
      parentHits += 1;
      if (EXECUTE) {
        await Parent.updateOne({ _id: p._id }, { $set: { email: to } });
      }
    }
    if (parentMatches.length === 0) {
      console.log(`  Parent (no match for ${mask(from)})`);
    }
  }

  console.log("");
  console.log(
    `Summary: User rows ${EXECUTE ? "updated" : "would update"}: ${userHits}, Parent rows: ${parentHits}`
  );

  if (rollback.length > 0) {
    console.log("");
    console.log("Rollback: to undo, paste this into MAPPINGS and re-run:");
    console.log("const MAPPINGS = {");
    // de-duplicate rollback lines
    const seen = new Set();
    for (const line of rollback) {
      if (seen.has(line)) continue;
      seen.add(line);
      console.log(line);
    }
    console.log("};");
  }

  if (!EXECUTE) {
    console.log("");
    console.log(
      "Dry-run complete. Re-run with --execute to apply the changes above."
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
