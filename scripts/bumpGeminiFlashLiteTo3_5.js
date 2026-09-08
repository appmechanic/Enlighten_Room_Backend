/**
 * One-off migration: bump StandardPrompt.models.default/fallback from the
 * retired gemini-2.5-flash-lite to gemini-3.5-flash-lite.
 *
 * Background:
 *   Google 404'd new-user calls to models/gemini-2.5-flash-lite with a note
 *   pointing at gemini-3.5-flash-lite. The file defaults in
 *   config/standardPromptDefaults.js were bumped in the same change, but
 *   utils/aiConfig.js merges the DB doc OVER those defaults, so any install
 *   whose StandardPrompt doc still holds "gemini-2.5-flash-lite" keeps
 *   erroring on every classwork feedback / precompute / class-report call.
 *
 * Updates ONLY paths whose current value is the retired string, so any admin
 * who already flipped to a different model (e.g. gemini-2.5-flash) is left
 * alone. models.image is untouched.
 *
 * Note: aiConfig has a 60s in-memory cache per Node process. Existing running
 * backends won't pick up the DB change until the next TTL rollover (or a
 * process restart).
 *
 * Usage:
 *   node scripts/bumpGeminiFlashLiteTo3_5.js --dry-run
 *   node scripts/bumpGeminiFlashLiteTo3_5.js --yes
 */

import "dotenv/config";
import mongoose from "mongoose";
import StandardPrompt from "../models/standardPromptModel.js";

const RETIRED = "gemini-2.5-flash-lite";
const REPLACEMENT = "gemini-3.5-flash-lite";
const PATHS = ["models.default", "models.fallback"];

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
      "(A fresh install will auto-seed on the first AI call; file defaults already point at gemini-3.5-flash-lite.)",
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("\nCurrent DB values:");
  const willSet = {};
  for (const path of PATHS) {
    const current = getPath(doc, path);
    if (current === RETIRED) {
      console.log(`  - ${path}: "${current}" → will set to "${REPLACEMENT}"`);
      willSet[path] = REPLACEMENT;
    } else if (current === REPLACEMENT) {
      console.log(`  - ${path}: "${current}" (already migrated; skipping)`);
    } else if (current === undefined) {
      console.log(`  - ${path}: unset (file default wins; skipping)`);
    } else {
      console.log(
        `  - ${path}: "${current}" (admin override, not the retired model; skipping)`,
      );
    }
  }

  const pathsToSet = Object.keys(willSet);
  if (pathsToSet.length === 0) {
    console.log("\nNothing to update — no path currently holds the retired model.");
    await mongoose.disconnect();
    process.exit(0);
  }

  if (dryRun) {
    console.log(
      `\n[dry-run] Would $set ${pathsToSet.length} path(s) on StandardPrompt(key="global"):`,
    );
    pathsToSet.forEach((p) => console.log(`  - ${p} = "${willSet[p]}"`));
  } else {
    const result = await StandardPrompt.updateOne(
      { key: "global" },
      { $set: willSet },
    );
    console.log(
      `\n$set applied — matched=${result.matchedCount} modified=${result.modifiedCount}.`,
    );

    const after = await StandardPrompt.findOne({ key: "global" }).lean();
    console.log("\nPost-migration values:");
    for (const path of PATHS) {
      console.log(`  - ${path}: "${getPath(after, path)}"`);
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
