// scripts/seedHandwritingWithImage.js
//
// DEV ONLY. Finds an existing assignment question in the test classroom
// and mutates it to type="handwriting" with an attached image URL so the
// Task 4 "Add question image" button becomes visible on the student's
// handwriting board without having to click through the subscription-
// gated Create Assignment flow.
//
// Reuses an image URL that's already in the DO Spaces bucket (picked
// from any existing question that has image set) so CORS works
// automatically once the one-off configureSpacesCors.js has been run
// on that bucket.
//
// Prints the original values up front so you can restore with --restore.
//
// Usage:
//   node scripts/seedHandwritingWithImage.js                              # dry-run (lists candidates)
//   node scripts/seedHandwritingWithImage.js --apply                      # mutate FIRST candidate
//   node scripts/seedHandwritingWithImage.js --apply <subAssignmentId>    # mutate a SPECIFIC task
//   node scripts/seedHandwritingWithImage.js --restore                    # revert using the snapshot
//
// Snapshot lives at scripts/.handwriting-seed-snapshot.json next to the
// script (gitignored via your existing snapshot ignore pattern).

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Assignment from "../models/AssignmentModel.js";
import Question from "../models/QuestionModel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SNAPSHOT_PATH = path.join(__dirname, ".handwriting-seed-snapshot.json");

async function pickImageUrl() {
  // Any existing question with a non-empty image URL will do. All such
  // URLs live in the same DO Spaces bucket, which (after the CORS script)
  // serves cross-origin headers.
  const q = await Question.findOne({ image: { $ne: "" } }).select("image").lean();
  return q?.image || null;
}

async function listCandidates() {
  // Every Assignment task that has at least one question — these are
  // the ones we can safely mutate (the question doc already exists;
  // we just flip type + set image).
  const docs = await Assignment.find({ "assignments.0": { $exists: true } })
    .select("_id classroomId assignments._id assignments.title assignments.questions")
    .lean();
  const out = [];
  for (const doc of docs) {
    for (const task of doc.assignments || []) {
      if (!Array.isArray(task.questions) || task.questions.length === 0) continue;
      out.push({
        assignmentId: String(doc._id),
        classroomId: String(doc.classroomId),
        subAssignmentId: String(task._id),
        title: task.title,
        firstQuestionId: String(task.questions[0]),
        questionCount: task.questions.length,
      });
    }
  }
  return out;
}

async function doApply(subAssignmentIdArg) {
  const candidates = await listCandidates();
  if (candidates.length === 0) {
    console.error("No assignment tasks with questions found. Aborting.");
    process.exit(1);
  }
  let target;
  if (subAssignmentIdArg) {
    target = candidates.find(
      (c) => String(c.subAssignmentId) === String(subAssignmentIdArg),
    );
    if (!target) {
      console.error(
        `No candidate assignment task found with subAssignmentId=${subAssignmentIdArg}. Re-run without args to see the full list.`,
      );
      process.exit(1);
    }
  } else {
    target = candidates[0];
  }
  console.log(`Target assignment task:`);
  console.log(`  classroomId      = ${target.classroomId}`);
  console.log(`  subAssignmentId  = ${target.subAssignmentId}`);
  console.log(`  title            = ${target.title}`);
  console.log(`  firstQuestionId  = ${target.firstQuestionId}`);

  const imageUrl = await pickImageUrl();
  if (!imageUrl) {
    console.error(
      "No existing question image found in the DB to reuse. Upload any image via Create Classwork once, then retry — or edit this script to hardcode a URL."
    );
    process.exit(1);
  }
  console.log(`Image URL to attach: ${imageUrl}`);

  const original = await Question.findById(target.firstQuestionId)
    .select("type image questionText")
    .lean();
  if (!original) {
    console.error("First question doc not found. Aborting.");
    process.exit(1);
  }

  if (fs.existsSync(SNAPSHOT_PATH)) {
    console.warn(
      `Snapshot already exists at ${SNAPSHOT_PATH}. Run --restore first or delete the file if you intentionally want to overwrite.`
    );
    process.exit(1);
  }

  fs.writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify(
      {
        questionId: String(target.firstQuestionId),
        original: { type: original.type, image: original.image },
        appliedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  const res = await Question.updateOne(
    { _id: target.firstQuestionId },
    { $set: { type: "handwriting", image: imageUrl } }
  );
  console.log(
    `Mutated question. matched=${res.matchedCount} modified=${res.modifiedCount}`
  );
  console.log("");
  console.log(`Original values snapshotted:`);
  console.log(`  type  = ${original.type}`);
  console.log(`  image = ${original.image || "(empty)"}`);
  console.log("");
  console.log(`Restore with: node scripts/seedHandwritingWithImage.js --restore`);
  console.log("");
  console.log(
    `Now log in as the student assigned to "${target.title}" and open this assignment — the first question will render the handwriting board with the Add question image button.`
  );
}

async function doRestore() {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    console.error(`No snapshot at ${SNAPSHOT_PATH}. Nothing to restore.`);
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  const res = await Question.updateOne(
    { _id: snap.questionId },
    { $set: { type: snap.original.type, image: snap.original.image || "" } }
  );
  console.log(
    `Restored question ${snap.questionId}. matched=${res.matchedCount} modified=${res.modifiedCount}`
  );
  fs.unlinkSync(SNAPSHOT_PATH);
}

async function doList() {
  const candidates = await listCandidates();
  if (candidates.length === 0) {
    console.log("No assignment tasks with questions found.");
    return;
  }
  console.log(`Found ${candidates.length} candidate assignment task(s):`);
  candidates.forEach((c, i) => {
    console.log(
      `  ${i + 1}. title="${c.title}"  subAssignmentId=${c.subAssignmentId}  questions=${c.questionCount}`
    );
  });
  console.log("");
  console.log(
    "The --apply command would mutate the FIRST candidate's first question. Re-run with --apply to proceed."
  );
}

async function main() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(dbUrl);

  const mode = process.argv[2] || "";
  const arg = process.argv[3] || "";
  if (mode === "--apply") await doApply(arg);
  else if (mode === "--restore") await doRestore();
  else await doList();

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
