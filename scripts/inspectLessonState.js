import "dotenv/config";
import mongoose from "mongoose";
import Lesson from "../models/LessonModel.js";
import Classwork from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";

async function main() {
  await mongoose.connect(process.env.DB_URL);
  console.log("db:", mongoose.connection.name);

  const lessons = await Lesson.find({}).lean();
  console.log(`\n=== ${lessons.length} Lesson(s) ===`);
  lessons.forEach((l) => {
    console.log({
      _id: String(l._id),
      roomId: l.roomId,
      name: JSON.stringify(l.name),
      status: l.status,
      startedAt: l.startedAt,
      endedAt: l.endedAt,
      classReportGeneratedAt: l.classReport?.generatedAt || null,
      classReportDifficulties: l.classReport?.studentDifficulties?.length ?? 0,
    });
  });

  const classwork = await Classwork.find({}).lean();
  console.log(`\n=== ${classwork.length} Classwork question(s) ===`);
  classwork.forEach((q) => {
    console.log({
      _id: String(q._id),
      id: q.id,
      roomId: q.roomId,
      lessonName: JSON.stringify(q.lessonName),
      question: (q.question || "").slice(0, 60),
      submittedCount: (q.submitted || []).length,
      submitters: (q.submitted || []).map((s) => ({
        studentId: String(s.studentId || ""),
        name: s.studentName,
        isCorrect: s.isCorrect,
      })),
    });
  });

  const reports = await ClassworkAiReport.find({}).lean();
  console.log(`\n=== ${reports.length} ClassworkAiReport(s) ===`);
  reports.forEach((r) => {
    console.log({
      _id: String(r._id),
      roomId: r.roomId,
      studentId: String(r.studentId || ""),
      questionId: r.questionId,
      interactions: (r.interactions || []).length,
    });
  });

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
