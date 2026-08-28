// One-off wipe: hard-delete every doc in the lesson/classwork/assignment
// collections on the currently-configured DB_URL. Run from Backend/:
//   node scripts/wipeLessonsAndAssignments.js
//
// Intentionally does NOT touch Session, Classroom, Student, Teacher, or Test
// docs. Prints before/after counts so the result is auditable.
import "dotenv/config";
import mongoose from "mongoose";

import Lesson from "../models/LessonModel.js";
import Classwork from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";
import Assignment from "../models/AssignmentModel.js";
import AssignmentAiReport from "../models/AssignmentAiReportModel.js";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import GradedAnswer from "../models/GradedAnswerModel.js";
import StudentAssignmentStatus from "../models/StudentAssignmentStatus.js";

const targets = [
  ["Lesson", Lesson],
  ["Classwork", Classwork],
  ["ClassworkAiReport", ClassworkAiReport],
  ["Assignment", Assignment],
  ["AssignmentAiReport", AssignmentAiReport],
  ["GradedSubmission", GradedSubmission],
  ["GradedAnswer", GradedAnswer],
  ["StudentAssignmentStatus", StudentAssignmentStatus],
];

async function main() {
  if (!process.env.DB_URL) {
    throw new Error("DB_URL is not set in the environment.");
  }
  await mongoose.connect(process.env.DB_URL);
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName}`);

  const before = {};
  for (const [label, Model] of targets) {
    before[label] = await Model.estimatedDocumentCount();
  }
  console.log("Doc counts BEFORE wipe:", before);

  const results = {};
  for (const [label, Model] of targets) {
    const res = await Model.deleteMany({});
    results[label] = res.deletedCount ?? 0;
    console.log(`Deleted ${results[label]} doc(s) from ${label}`);
  }

  const after = {};
  for (const [label, Model] of targets) {
    after[label] = await Model.estimatedDocumentCount();
  }
  console.log("Doc counts AFTER wipe:", after);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error("Wipe failed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
