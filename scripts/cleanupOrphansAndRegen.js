// One-off cleanup for room TxSQmBqK's report artifacts:
//   1. Deletes orphan Lesson docs (ended, but no Classwork tagged with their
//      lessonName — leftovers from the pre-fix flow that removed classwork
//      but kept the Lesson row).
//   2. Deletes stale ClassworkAiReport docs whose questionId no longer
//      exists in the Classwork collection.
//   3. Regenerates the class report for any ended Lesson doc that HAS
//      attached classwork but a null `classReport.generatedAt` (lesson 6
//      failed silently — the AI call errored under the .catch in
//      endLessonForRoom).
//
// Prints everything it touches so the run is auditable.
import "dotenv/config";
import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";
import ClassworkModel from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";
import Classroom from "../models/classroomModel.js";
import Session from "../models/SessionModel.js";
import { generateClassReportSummary } from "../utils/geminiClassReportSummary.js";

async function regenerateLessonReport(lessonDoc) {
  const questions = await ClassworkModel.find({
    roomId: lessonDoc.roomId,
    lessonName: lessonDoc.name,
  }).lean();
  const submissionCount = questions.reduce(
    (n, q) => n + (Array.isArray(q.submitted) ? q.submitted.length : 0),
    0,
  );
  if (questions.length === 0 || submissionCount === 0) {
    console.log(
      `  → skip: lesson "${lessonDoc.name}" has ${questions.length} q(s), ${submissionCount} submission(s).`,
    );
    return null;
  }
  const classroomDoc = lessonDoc.classroomId
    ? await Classroom.findById(lessonDoc.classroomId)
        .select("teacherId studentIds scope")
        .lean()
    : null;
  const teacherId = classroomDoc?.teacherId || null;
  const studentCount = Array.isArray(classroomDoc?.studentIds)
    ? classroomDoc.studentIds.length
    : 0;
  const sessionDoc = lessonDoc.sessionId
    ? await Session.findById(lessonDoc.sessionId)
        .select("instructionLanguage")
        .lean()
    : null;

  console.log(
    `  → generating: ${questions.length} q(s), ${submissionCount} submission(s), ${studentCount} student(s)`,
  );
  const classReport = await generateClassReportSummary({
    lessonName: lessonDoc.name,
    questions,
    teacherId,
    studentCount,
    scope: classroomDoc?.scope || null,
    instructionLanguage: sessionDoc?.instructionLanguage || "English",
    sessionId: lessonDoc.sessionId,
  });
  if (!classReport) {
    console.warn(`  → AI returned null. Something upstream (Gemini?) failed.`);
    return null;
  }
  await Lesson.updateOne({ _id: lessonDoc._id }, { $set: { classReport } });
  console.log(
    `  → saved: ${classReport.studentDifficulties.length} difficulties, ` +
      `${classReport.nextLessonStrategy.length} strategies, ` +
      `${classReport.targetedHomework.length} homework items`,
  );
  return classReport;
}

async function main() {
  await mongoose.connect(process.env.DB_URL);
  console.log(`db: ${mongoose.connection.name}`);

  // --- 1) Orphan Lesson docs ---
  const lessons = await Lesson.find({ status: "ended" }).lean();
  const orphans = [];
  for (const l of lessons) {
    const count = await ClassworkModel.countDocuments({
      roomId: l.roomId,
      lessonName: l.name,
    });
    if (count === 0) orphans.push({ ...l, _classworkCount: 0 });
  }
  console.log(`\nOrphan ended lessons (0 attached classwork): ${orphans.length}`);
  orphans.forEach((l) =>
    console.log(`  - ${l.roomId} · "${l.name}" · _id=${l._id}`),
  );
  if (orphans.length > 0) {
    const ids = orphans.map((l) => l._id);
    const res = await Lesson.deleteMany({ _id: { $in: ids } });
    console.log(`  → deleted ${res.deletedCount} orphan Lesson doc(s)`);
  }

  // --- 2) Stale ClassworkAiReport docs ---
  const allReports = await ClassworkAiReport.find({}).lean();
  const stale = [];
  for (const r of allReports) {
    const exists = await ClassworkModel.exists({
      roomId: r.roomId,
      id: r.questionId,
    });
    if (!exists) stale.push(r);
  }
  console.log(
    `\nStale ClassworkAiReport rows (questionId no longer in Classwork): ${stale.length}`,
  );
  stale.forEach((r) =>
    console.log(`  - ${r.roomId}/${r.studentId}/${r.questionId} · _id=${r._id}`),
  );
  if (stale.length > 0) {
    const ids = stale.map((r) => r._id);
    const res = await ClassworkAiReport.deleteMany({ _id: { $in: ids } });
    console.log(`  → deleted ${res.deletedCount} stale AI-report row(s)`);
  }

  // --- 3) Regenerate reports for ended lessons whose classReport is null ---
  const needsRegen = await Lesson.find({
    status: "ended",
    $or: [
      { "classReport.generatedAt": null },
      { "classReport.generatedAt": { $exists: false } },
    ],
  });
  console.log(
    `\nEnded lessons with no generated report: ${needsRegen.length}`,
  );
  for (const l of needsRegen) {
    console.log(`- ${l.roomId} · "${l.name}" · _id=${l._id}`);
    try {
      await regenerateLessonReport(l);
    } catch (err) {
      console.error(`  → regen threw:`, err?.message || err);
    }
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch(async (err) => {
  console.error("Cleanup failed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
