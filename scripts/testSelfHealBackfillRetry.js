// Proper end-to-end test of the on-read self-heal backfill.
// Unlike the single-shot version, this simulates real user behaviour:
// the teacher opens the modal, sees "not generated yet", refreshes, sees
// it again, refreshes again, etc. Each fresh read re-schedules the
// backfill. Once one attempt gets a non-empty Gemini response the DB
// becomes healed and subsequent reads skip.
//
// Passes as soon as the DB shows classReport.generatedAt populated.
import "dotenv/config";
import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";

const ROOM_ID = "TxSQmBqK";
const LESSON_NAME = "lesson 6";
const API_BASE = `http://localhost:${process.env.PORT || 5003}`;
const MAX_ATTEMPTS = 6;
const WAIT_BETWEEN_ATTEMPTS_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(process.env.DB_URL);
  console.log(`db: ${mongoose.connection.name}`);

  const before = await Lesson.findOne({ roomId: ROOM_ID, name: LESSON_NAME }).lean();
  if (!before) throw new Error(`lesson "${LESSON_NAME}" not found`);
  const originalClassReport = before.classReport;
  console.log(`\nOriginal generatedAt: ${before.classReport?.generatedAt || "(null)"}`);

  console.log(`\nWiping classReport…`);
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

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n--- attempt ${attempt}/${MAX_ATTEMPTS} ---`);
    const res = await fetch(`${API_BASE}/api/classwork/class-report/${ROOM_ID}`);
    console.log(`  HTTP ${res.status}`);
    await sleep(WAIT_BETWEEN_ATTEMPTS_MS);
    const current = await Lesson.findById(before._id).lean();
    const gen = current.classReport?.generatedAt;
    const d = current.classReport?.studentDifficulties?.length || 0;
    const s = current.classReport?.nextLessonStrategy?.length || 0;
    const h = current.classReport?.targetedHomework?.length || 0;
    console.log(`  after ${WAIT_BETWEEN_ATTEMPTS_MS / 1000}s: generatedAt=${gen || "(null)"} · d=${d} s=${s} h=${h}`);
    if (gen) {
      console.log(`\n✅ HEALED after ${attempt} attempt(s).`);
      await mongoose.disconnect();
      return;
    }
  }

  console.error(`\n❌ Not healed after ${MAX_ATTEMPTS} attempts.`);
  console.error(`Restoring the original classReport so the DB isn't left broken.`);
  await Lesson.updateOne({ _id: before._id }, { $set: { classReport: originalClassReport } });
  await mongoose.disconnect();
  process.exit(1);
}

main().catch(async (err) => {
  console.error("Test failed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
