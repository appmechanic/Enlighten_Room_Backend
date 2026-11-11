// scripts/resetStudentAssignmentSubmission.js
//
// DEV ONLY. Clears a student's submission for a specific assignment task
// so the assignment flips back from "graded" to "pending" and the student
// can re-take it. Needed when testing changes to the answer-input UI
// (e.g. Task 4's handwriting board) because fresh Create Assignment is
// paywalled in test environments.
//
// Removes:
//   - GradedSubmission docs for (studentId, assignmentTaskId)
//   - GradedAnswer docs for (studentId, subAssignmentId)
//   - AssignmentAiReport docs for (studentId, subAssignmentId)
//
// Also clears the "sent" flag so the student's submitted/graded counters
// reset. Does NOT touch the assignment task itself (questions, dueDate,
// etc.) — that stays intact.
//
// Usage:
//   node scripts/resetStudentAssignmentSubmission.js <studentEmail> <subAssignmentId>

import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/user.js";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import GradedAnswer from "../models/GradedAnswerModel.js";
import AssignmentAiReport from "../models/AssignmentAiReportModel.js";
import StudentAssignmentStatus from "../models/StudentAssignmentStatus.js";

async function main() {
  const studentEmail = (process.argv[2] || "").trim();
  const subAssignmentIdArg = (process.argv[3] || "").trim();
  if (!studentEmail || !subAssignmentIdArg) {
    console.error(
      "Usage: node scripts/resetStudentAssignmentSubmission.js <studentEmail> <subAssignmentId>",
    );
    process.exit(1);
  }
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(dbUrl);

  const student = await User.findOne({ email: studentEmail })
    .select("_id firstName lastName userName")
    .lean();
  if (!student) {
    console.error(`No User with email "${studentEmail}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(
    `Student: ${student.firstName || ""} ${student.lastName || ""} (${student.userName}) id=${student._id}`,
  );
  console.log(`subAssignmentId: ${subAssignmentIdArg}`);
  console.log("");

  const subObjId = new mongoose.Types.ObjectId(subAssignmentIdArg);

  const gsRes = await GradedSubmission.deleteMany({
    studentId: student._id,
    assignmentTaskId: subObjId,
  });
  console.log(`GradedSubmission removed: ${gsRes.deletedCount}`);

  // GradedAnswer may key on subAssignmentId OR taskId depending on when
  // it was written — try both fields to be safe.
  const gaRes1 = await GradedAnswer.deleteMany({
    studentId: student._id,
    subAssignmentId: subObjId,
  });
  const gaRes2 = await GradedAnswer.deleteMany({
    studentId: student._id,
    taskId: subObjId,
  });
  console.log(
    `GradedAnswer removed: ${gaRes1.deletedCount + gaRes2.deletedCount}`,
  );

  const aiRes = await AssignmentAiReport.deleteMany({
    studentId: student._id,
    subAssignmentId: subObjId,
  });
  console.log(`AssignmentAiReport removed: ${aiRes.deletedCount}`);

  // StudentAssignmentStatus is the per-student isCompleted flag the
  // student-assignments API unions with GradedAnswer to decide the
  // "graded" badge. Without wiping this the badge sticks even after
  // every other record is gone.
  const sasRes = await StudentAssignmentStatus.deleteMany({
    studentId: student._id,
    assignmentId: subObjId,
  });
  console.log(`StudentAssignmentStatus removed: ${sasRes.deletedCount}`);

  console.log("");
  console.log(
    `Done. Refresh the student's Assignments page — the assignment should move from 'Graded' back to 'Pending'.`,
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
