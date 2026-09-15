// One-shot backfill: walk every Plan doc, parse Plan.features into the
// numeric Plan.limits object, and (with --apply) write it back.
//
// Usage:
//   node scripts/syncPlanLimitsFromFeatures.js            # dry-run
//   node scripts/syncPlanLimitsFromFeatures.js --apply    # write to DB
//
// Idempotent — running with --apply twice is a no-op if nothing changed.
// Only fields the parser recognises are overwritten; existing values for
// keys the parser didn't produce are preserved, so a plan that had
// maxStudents manually set stays intact if no feature line derives it.

import "dotenv/config";
import mongoose from "mongoose";
import Plan from "../models/PlanModel.js";
import { parsePlanFeatures } from "../utils/parsePlanFeatures.js";

const APPLY = process.argv.includes("--apply");

function equalLimits(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

async function main() {
  await mongoose.connect(process.env.DB_URL);
  console.log("db:", mongoose.connection.name);
  console.log("mode:", APPLY ? "APPLY (writing changes)" : "DRY-RUN (no writes)");
  console.log("");

  const plans = await Plan.find({}).lean();
  console.log(`Found ${plans.length} plan(s).\n`);

  let changed = 0;
  let unchanged = 0;
  let withUnmatched = 0;

  for (const plan of plans) {
    const { limits: parsed, unmatched } = parsePlanFeatures(plan.features);
    const current = plan.limits || {};

    // Merge: parsed keys win, other current keys are preserved. This means
    // deleting a "Teachers: 10" feature line WILL NOT null out maxTeachers
    // — you'd have to null it manually. Deliberate: safer default.
    const merged = { ...current };
    for (const [k, v] of Object.entries(parsed)) merged[k] = v;

    const noop = equalLimits(current, merged);

    console.log(`▸ ${plan.name} (${plan.planType})  _id=${plan._id}`);
    console.log(`  features: ${plan.features?.length || 0} line(s)`);
    if (Object.keys(parsed).length === 0) {
      console.log("  parser matched: (nothing)");
    } else {
      for (const [k, v] of Object.entries(parsed)) {
        const before = current[k];
        const marker = before === v ? " " : "→";
        console.log(
          `  parser matched: ${marker} ${k.padEnd(35)} ${String(before ?? "null").padStart(15)}  =>  ${v}`
        );
      }
    }
    if (unmatched.length > 0) {
      withUnmatched++;
      console.log("  unmatched (kept as display text):");
      unmatched.forEach((s) => console.log(`    · ${s}`));
    }

    if (noop) {
      unchanged++;
      console.log("  status: no change\n");
      continue;
    }

    changed++;
    if (APPLY) {
      await Plan.updateOne({ _id: plan._id }, { $set: { limits: merged } });
      console.log("  status: UPDATED\n");
    } else {
      console.log("  status: would update (dry-run)\n");
    }
  }

  console.log("---");
  console.log(`changed:            ${changed}`);
  console.log(`unchanged:          ${unchanged}`);
  console.log(`with unmatched:     ${withUnmatched}`);
  console.log(`mode:               ${APPLY ? "APPLIED" : "dry-run — re-run with --apply to write"}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
