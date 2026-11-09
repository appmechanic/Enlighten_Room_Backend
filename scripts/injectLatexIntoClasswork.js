// scripts/injectLatexIntoClasswork.js
//
// DEV ONLY. Rewrites the question text of one existing Classwork row to
// contain a LaTeX expression, so the Task 2 tokenized viewer can be tested
// against a question that renders math — without having to run the
// VideoApp and create fresh classwork + submission end-to-end.
//
// Prints the original text up front so you can restore it with --restore
// after testing.
//
// Usage:
//   node scripts/injectLatexIntoClasswork.js <lessonName>           # inject
//   node scripts/injectLatexIntoClasswork.js <lessonName> --restore # restore
//
// Example:
//   node scripts/injectLatexIntoClasswork.js "2026-09-29 19:05"
//   node scripts/injectLatexIntoClasswork.js "2026-09-29 19:05" --restore
//
// The restore uses an on-disk snapshot file next to the script.

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Classwork from "../models/ClassworkModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_PATH = path.join(__dirname, ".latex-inject-snapshot.json");

const LATEX_TEXT =
  "Evaluate $\\int_0^1 x^2 \\, dx$ and give the answer as a fraction. Also simplify $\\frac{a^2 - b^2}{a - b}$ where $a \\neq b$.";

async function main() {
  const lessonName = (process.argv[2] || "").trim();
  const isRestore = (process.argv[3] || "").trim() === "--restore";
  if (!lessonName) {
    console.error(
      'Usage: node scripts/injectLatexIntoClasswork.js "<lessonName>" [--restore]'
    );
    process.exit(1);
  }
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(dbUrl);

  if (isRestore) {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
      console.error(
        `No snapshot found at ${SNAPSHOT_PATH}. Cannot auto-restore — if you need to revert, update the question text manually in Mongo.`
      );
      await mongoose.disconnect();
      process.exit(1);
    }
    const snapshots = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    const match = snapshots.find((s) => s.lessonName === lessonName);
    if (!match) {
      console.error(
        `No snapshot entry for lessonName="${lessonName}" in ${SNAPSHOT_PATH}.`
      );
      await mongoose.disconnect();
      process.exit(1);
    }
    const res = await Classwork.updateOne(
      { _id: match.classworkId },
      { $set: { question: match.originalQuestion } }
    );
    console.log(
      `Restored classwork ${match.classworkId} question to original. matched=${res.matchedCount} modified=${res.modifiedCount}`
    );
    // Drop that entry from the snapshot file.
    const remaining = snapshots.filter((s) => s.lessonName !== lessonName);
    if (remaining.length === 0) fs.unlinkSync(SNAPSHOT_PATH);
    else fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(remaining, null, 2));
    await mongoose.disconnect();
    return;
  }

  // Pick the first classwork row for the lesson that has at least one submission,
  // falling back to any row with that lessonName. Having a real submission makes
  // the tokenized viewer render actual answer attempts for a more useful test.
  const candidates = await Classwork.find({ lessonName })
    .select("_id question submitted roomId")
    .lean();
  if (candidates.length === 0) {
    console.error(`No Classwork rows with lessonName="${lessonName}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  const target =
    candidates.find((c) => Array.isArray(c.submitted) && c.submitted.length > 0) ||
    candidates[0];

  // Snapshot before writing.
  const existingSnapshots = fs.existsSync(SNAPSHOT_PATH)
    ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"))
    : [];
  // De-dupe: if we already have a snapshot for this lesson, keep the oldest
  // (so you can always restore to the TRUE original even after multiple injects).
  if (!existingSnapshots.find((s) => s.lessonName === lessonName)) {
    existingSnapshots.push({
      lessonName,
      classworkId: String(target._id),
      roomId: target.roomId,
      originalQuestion: target.question,
      snapshotAt: new Date().toISOString(),
    });
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(existingSnapshots, null, 2));
  }

  const res = await Classwork.updateOne(
    { _id: target._id },
    { $set: { question: LATEX_TEXT } }
  );
  console.log(
    `Injected LaTeX into classwork ${target._id} (lessonName="${lessonName}", room=${target.roomId}).`
  );
  console.log(`  Original: ${target.question}`);
  console.log(`  New:      ${LATEX_TEXT}`);
  console.log(`  Submissions on this row: ${(target.submitted || []).length}`);
  console.log(`  mongo update: matched=${res.matchedCount} modified=${res.modifiedCount}`);
  console.log(
    `\nRestore with: node scripts/injectLatexIntoClasswork.js "${lessonName}" --restore`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
