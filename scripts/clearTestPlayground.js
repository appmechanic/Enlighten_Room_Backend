// Wipe every collection that carries classwork/assignment/test state so the
// teacher can re-run their end-to-end test flow from a clean slate. Keeps
// classrooms, users, sessions, lessons, assignment task docs, test task docs,
// and question banks intact — only the interaction / grading / report noise
// is removed.
//
// Runs dry-run by default. Set APPLY=1 to actually delete.
//
//   # dry-run
//   node --env-file=.env scripts/clearTestPlayground.js
//
//   # apply
//   APPLY=1 node --env-file=.env scripts/clearTestPlayground.js

import mongoose from "mongoose";
import connectToDatabase from "../config/db.js";
import ClassworkModel from "../models/ClassworkModel.js";
import ClassworkAiReport from "../models/ClassworkAiReportModel.js";
import Lesson from "../models/LessonModel.js";
import AssignmentAiReport from "../models/AssignmentAiReportModel.js";
import GradedAnswer from "../models/GradedAnswerModel.js";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import StudentAssignmentStatus from "../models/StudentAssignmentStatus.js";
import GradedTestAnswer from "../models/GradedTestAnswerModel.js";
import Test from "../models/TestModel.js";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";

async function main() {
  await connectToDatabase();

  const counts = {
    classworkDocs: await ClassworkModel.countDocuments({}),
    classworkAiReports: await ClassworkAiReport.countDocuments({}),
    lessonsTotal: await Lesson.countDocuments({}),
    assignmentAiReports: await AssignmentAiReport.countDocuments({}),
    gradedAnswers: await GradedAnswer.countDocuments({}),
    gradedSubmissions: await GradedSubmission.countDocuments({}),
    studentAssignmentStatuses: await StudentAssignmentStatus.countDocuments({}),
    gradedTestAnswers: await GradedTestAnswer.countDocuments({}),
  };

  // Test collection is trickier — we're clearing embedded arrays, not whole
  // docs. Count how many task subdocs currently carry submissions or a
  // classReport so the dry-run is honest about what will change.
  const testDocs = await Test.find({}).select("tests._id tests.submissions tests.classReport").lean();
  let testTasksWithSubmissions = 0;
  let testTasksWithClassReport = 0;
  let testSubmissionCount = 0;
  testDocs.forEach((td) => {
    (td.tests || []).forEach((t) => {
      if (Array.isArray(t.submissions) && t.submissions.length > 0) {
        testTasksWithSubmissions += 1;
        testSubmissionCount += t.submissions.length;
      }
      if (t.classReport && (t.classReport.generatedAt || t.classReport.body)) {
        testTasksWithClassReport += 1;
      }
    });
  });

  console.log("Current state:");
  console.table({
    ...counts,
    testTasksWithSubmissions,
    testSubmissionsTotal: testSubmissionCount,
    testTasksWithClassReport,
  });

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with APPLY=1 to actually delete.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nApplying deletions...\n");

  const results = {};

  results.classworkDocs = (await ClassworkModel.deleteMany({})).deletedCount;
  results.classworkAiReports = (await ClassworkAiReport.deleteMany({})).deletedCount;

  // Delete Lesson docs outright — with all classwork gone they render as
  // empty "0/0 answered" rows in the per-student My Reports list and just
  // clutter the UI. Nothing else in another collection hard-refs them.
  results.lessonsDeleted = (await Lesson.deleteMany({})).deletedCount;

  results.assignmentAiReports = (await AssignmentAiReport.deleteMany({})).deletedCount;
  results.gradedAnswers = (await GradedAnswer.deleteMany({})).deletedCount;
  results.gradedSubmissions = (await GradedSubmission.deleteMany({})).deletedCount;
  results.studentAssignmentStatuses = (await StudentAssignmentStatus.deleteMany({})).deletedCount;
  results.gradedTestAnswers = (await GradedTestAnswer.deleteMany({})).deletedCount;

  // Strip embedded submissions + classReport from every Test task. Keeps the
  // Test task docs themselves so the teacher's created tests stay listed.
  const testRes = await Test.updateMany(
    {},
    {
      $set: {
        "tests.$[].submissions": [],
        "tests.$[].classReport": { generatedAt: null, body: undefined },
      },
    },
  );
  results.testTasksReset = testRes.modifiedCount;

  console.log("Done:");
  console.table(results);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
