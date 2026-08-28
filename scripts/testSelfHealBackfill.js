// End-to-end test of the on-read self-healing class-report backfill.
//   1. Snapshots lesson 6's current classReport.
//   2. Wipes generatedAt (simulates the endLessonForRoom silent-catch failure).
//   3. Hits GET /api/classwork/class-report/:roomId — this is the read that
//      should schedule the backfill.
//   4. Polls the Lesson doc every 2 seconds for up to 90 seconds waiting for
//      classReport.generatedAt to reappear.
//   5. Prints before/after so the result is auditable, and restores the
//      original if the test fails.
import "dotenv/config";
import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";

const ROOM_ID = "TxSQmBqK";
const LESSON_NAME = "lesson 6";
const API_BASE = `http://localhost:${process.env.PORT || 5003}`;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(process.env.DB_URL);
  console.log(`db: ${mongoose.connection.name}`);

  const before = await Lesson.findOne({ roomId: ROOM_ID, name: LESSON_NAME }).lean();
  if (!before) throw new Error(`lesson "${LESSON_NAME}" not found in ${ROOM_ID}`);
  console.log(`\nStep 1 — before:`);
  console.log(`  lesson._id: ${before._id}`);
  console.log(`  classReport.generatedAt: ${before.classReport?.generatedAt || "(null)"}`);
  console.log(`  difficulties=${before.classReport?.studentDifficulties?.length || 0}, ` +
    `strategies=${before.classReport?.nextLessonStrategy?.length || 0}, ` +
    `homework=${before.classReport?.targetedHomework?.length || 0}`);

  const originalClassReport = before.classReport;

  console.log(`\nStep 2 — wiping classReport (simulating background-gen failure)…`);
  await Lesson.updateOne(
    { _id: before._id },
    {
      $set: {
        "classReport.generatedAt": null,
        "classReport.studentDifficulties": [],
        "classReport.nextLessonStrategy": [],
        "classReport.targetedHomework": [],
        "classReport.model": "",
      },
    },
  );
  const wiped = await Lesson.findById(before._id).lean();
  console.log(`  classReport.generatedAt is now: ${wiped.classReport?.generatedAt}`);

  console.log(`\nStep 3 — hitting GET ${API_BASE}/api/classwork/class-report/${ROOM_ID}`);
  const readStart = Date.now();
  const res = await fetch(`${API_BASE}/api/classwork/class-report/${ROOM_ID}`);
  const payload = await res.json();
  console.log(`  HTTP ${res.status} in ${Date.now() - readStart}ms`);
  const returnedLesson = (payload.lessons || []).find((l) => l.name === LESSON_NAME);
  console.log(`  server returned classReport.generatedAt for "${LESSON_NAME}": ` +
    `${returnedLesson?.classReport?.generatedAt || "(null)"}`);
  console.log(`  (this SHOULD still be null — the fix returns current state and heals in the background)`);

  console.log(`\nStep 4 — polling DB for backfill completion (up to ${POLL_TIMEOUT_MS / 1000}s)…`);
  const pollStart = Date.now();
  let healed = null;
  while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const current = await Lesson.findById(before._id).lean();
    const gen = current.classReport?.generatedAt;
    process.stdout.write(`  [+${Math.round((Date.now() - pollStart) / 1000)}s] generatedAt=${gen || "(null)"}\n`);
    if (gen) {
      healed = current;
      break;
    }
  }

  if (!healed) {
    console.error(`\n❌ TIMEOUT — the backfill did not complete inside ${POLL_TIMEOUT_MS}ms.`);
    console.error(`Restoring the original classReport so the DB isn't left broken.`);
    await Lesson.updateOne({ _id: before._id }, { $set: { classReport: originalClassReport } });
    await mongoose.disconnect();
    process.exit(1);
  }

  const elapsedS = Math.round((Date.now() - pollStart) / 1000);
  console.log(`\n✅ HEALED in ~${elapsedS}s`);
  console.log(`  classReport.generatedAt: ${healed.classReport?.generatedAt}`);
  console.log(`  difficulties=${healed.classReport?.studentDifficulties?.length || 0}, ` +
    `strategies=${healed.classReport?.nextLessonStrategy?.length || 0}, ` +
    `homework=${healed.classReport?.targetedHomework?.length || 0}`);
  console.log(`  model: ${healed.classReport?.model || "(unset)"}`);

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch(async (err) => {
  console.error("Test failed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
