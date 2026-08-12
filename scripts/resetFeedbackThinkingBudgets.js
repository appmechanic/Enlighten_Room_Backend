/**
 * One-off migration: clear stale StandardPrompt.tuning.feedback thinking
 * budget overrides so the trimmed file defaults win.
 *
 * Background:
 *   waiting_time_plans.txt lever G shipped a trim of the classwork feedback
 *   thinking budgets in config/standardPromptDefaults.js:
 *     - equivalenceCheckBudget:    384 → 256
 *     - uncachedMinThinkingBudget: 256 → 192
 *   utils/aiConfig.js merges the DB doc OVER those defaults (deepMergeStrings
 *   picks any admin-set number ahead of the file value), so any install with
 *   pre-trim numbers persisted in Mongo keeps paying the old ~150-250ms
 *   thinking-budget cost on every submission. The Admin UI can also clear
 *   these — this script exists so ops can flip them across environments
 *   without a manual click-through.
 *
 * Unsets ONLY those two paths. Grade bands, cache TTLs, multipliers and any
 * other admin-set tuning survive untouched.
 *
 * Note: aiConfig has a 60s in-memory cache per Node process. Existing
 * running backends won't pick up the DB change until the next TTL rollover
 * (or process restart). Fresh boots read the trimmed defaults immediately.
 *
 * Usage:
 *   node scripts/resetFeedbackThinkingBudgets.js --dry-run
 *   node scripts/resetFeedbackThinkingBudgets.js --yes
 */

import "dotenv/config";
import mongoose from "mongoose";
import StandardPrompt from "../models/standardPromptModel.js";
import { TUNING_DEFAULTS } from "../config/standardPromptDefaults.js";

const PATHS_TO_CLEAR = [
  "tuning.feedback.equivalenceCheckBudget",
  "tuning.feedback.uncachedMinThinkingBudget",
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirmed = args.has("--yes");

function getPath(doc, dotted) {
  return dotted.split(".").reduce((acc, key) => acc?.[key], doc);
}

async function main() {
  if (!process.env.DB_URL) {
    console.error("DB_URL is not set. Aborting.");
    process.exit(1);
  }
  if (!dryRun && !confirmed) {
    console.error(
      "Refusing to run without --yes. Use --dry-run to preview, or --yes to apply.",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URL);
  console.log("Connected to MongoDB.");

  const doc = await StandardPrompt.findOne({ key: "global" }).lean();
  if (!doc) {
    console.log('No StandardPrompt doc with key="global" found — nothing to do.');
    console.log(
      "(A fresh install will auto-seed on the first AI call; file defaults are already trimmed.)",
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  const fileDefaults = {
    "tuning.feedback.equivalenceCheckBudget":
      TUNING_DEFAULTS.feedback.equivalenceCheckBudget,
    "tuning.feedback.uncachedMinThinkingBudget":
      TUNING_DEFAULTS.feedback.uncachedMinThinkingBudget,
  };

  console.log("\nCurrent DB values vs file defaults:");
  const willClear = [];
  for (const path of PATHS_TO_CLEAR) {
    const dbValue = getPath(doc, path);
    const fileValue = fileDefaults[path];
    const status =
      dbValue === undefined
        ? "unset (already using file default)"
        : dbValue === fileValue
          ? `= ${dbValue} (matches file default; will still unset so file wins)`
          : `= ${dbValue} (OVERRIDES file default ${fileValue})`;
    console.log(`  - ${path}: ${status}`);
    if (dbValue !== undefined) willClear.push(path);
  }

  if (willClear.length === 0) {
    console.log("\nNothing to unset — every path is already using the file default.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const unsetSpec = Object.fromEntries(willClear.map((p) => [p, ""]));

  if (dryRun) {
    console.log(
      `\n[dry-run] Would $unset ${willClear.length} path(s) on StandardPrompt(key="global"):`,
    );
    willClear.forEach((p) => console.log(`  - ${p}`));
  } else {
    const result = await StandardPrompt.updateOne(
      { key: "global" },
      { $unset: unsetSpec },
    );
    console.log(
      `\n$unset applied — matched=${result.matchedCount} modified=${result.modifiedCount}.`,
    );

    const after = await StandardPrompt.findOne({ key: "global" }).lean();
    console.log("\nPost-migration values:");
    for (const path of PATHS_TO_CLEAR) {
      const v = getPath(after, path);
      console.log(
        `  - ${path}: ${v === undefined ? "unset (file default wins)" : `= ${v}`}`,
      );
    }
    console.log(
      "\nReminder: running backends cache aiConfig for up to 60s. Restart or wait one TTL for the change to take effect on live traffic.",
    );
  }

  await mongoose.disconnect();
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
