// Delete every Assignment (plus its Questions, GradedAnswers, and
// StudentAssignmentStatus timing rows) for a specific classroom, so the
// teacher can start fresh without residue from earlier grading experiments.
//
// Runs in dry-run mode unless APPLY=1 is set. Prints exactly what would be
// touched so you can eyeball scope before nuking.
//
// Run:
//   # dry-run
//   CLASSROOM_ID=6a46242e0a7cd009141114ab node --env-file=.env scripts/deleteClassroomAssignments.js
//
//   # apply
//   APPLY=1 CLASSROOM_ID=6a46242e0a7cd009141114ab node --env-file=.env scripts/deleteClassroomAssignments.js

import mongoose from "mongoose";
import connectToDatabase from "../config/db.js";
import Assignment from "../models/AssignmentModel.js";
import Question from "../models/QuestionModel.js";
import GradedAnswerModel from "../models/GradedAnswerModel.js";
import StudentAssignmentStatus from "../models/StudentAssignmentStatus.js";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const CLASSROOM_ID = process.env.CLASSROOM_ID;

async function main() {
  if (!CLASSROOM_ID) {
    console.error(
      "CLASSROOM_ID env var is required.\n" +
        "Example: CLASSROOM_ID=6a46242e0a7cd009141114ab node --env-file=.env scripts/deleteClassroomAssignments.js",
    );
    process.exit(2);
  }

  await connectToDatabase();
  const classroomObjId = new mongoose.Types.ObjectId(CLASSROOM_ID);

  const assignments = await Assignment.find({
    classroomId: classroomObjId,
  })
    .select("_id assignments")
    .lean();

  const parentIds = assignments.map((a) => a._id);
  const subIds = assignments.flatMap((a) =>
    (a.assignments || []).map((sub) => sub._id),
  );
  const questionIds = assignments.flatMap((a) =>
    (a.assignments || []).flatMap((sub) => sub.questions || []),
  );

  console.log(
    `Classroom ${CLASSROOM_ID}: ${assignments.length} parent Assignment docs, ${subIds.length} sub-assignments, ${questionIds.length} question refs.`,
  );

  const gradedCount = await GradedAnswerModel.countDocuments({
    $or: [
      { classroomId: classroomObjId },
      { assignmentId: { $in: parentIds } },
      { subAssignmentId: { $in: subIds } },
    ],
  });
  const statusCount = await StudentAssignmentStatus.countDocuments({
    assignmentId: { $in: [...parentIds, ...subIds] },
  });
  const questionRowCount = await Question.countDocuments({
    _id: { $in: questionIds },
  });

  console.log(
    `Would delete: Assignments=${assignments.length}, Questions=${questionRowCount}, GradedAnswers=${gradedCount}, StudentAssignmentStatus=${statusCount}`,
  );

  if (!APPLY) {
    console.log("\nDry-run only. Re-run with APPLY=1 to actually delete.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nApplying deletions...");

  const graded = await GradedAnswerModel.deleteMany({
    $or: [
      { classroomId: classroomObjId },
      { assignmentId: { $in: parentIds } },
      { subAssignmentId: { $in: subIds } },
    ],
  });
  const status = await StudentAssignmentStatus.deleteMany({
    assignmentId: { $in: [...parentIds, ...subIds] },
  });
  const questions = await Question.deleteMany({
    _id: { $in: questionIds },
  });
  const parent = await Assignment.deleteMany({
    classroomId: classroomObjId,
  });

  console.log(
    `Done. Deleted GradedAnswers=${graded.deletedCount}, StudentAssignmentStatus=${status.deletedCount}, Questions=${questions.deletedCount}, Assignments=${parent.deletedCount}`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
