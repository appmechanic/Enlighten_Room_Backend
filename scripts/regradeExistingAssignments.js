// Re-grade every existing GradedAnswerModel doc via the new Gemini-backed
// gradeDynamic() and flip its sub-assignment to "graded".
//
// Motivation: the deployed backend previously ran ai-grader.js against
// OpenAI using what turned out to be a Google Gemini key, so every AI call
// 401'd and every submission fell into the rule-based fallback. That meant
// scores stuck at 0, feedback stuck at "Awaiting teacher review." (the UI
// surfaces this as "Pending grading"), and every sub-assignment stayed at
// `assignmentStatus: "submitted"` instead of "graded".
//
// The graded doc already stores each student's raw answer (per question),
// so we can rebuild the input to the AI grader without needing the student
// to resubmit anything. Re-grading is idempotent — re-running just overwrites
// with fresher scores.
//
// Run:
//   # dry-run: shows what would change, no writes
//   node --env-file=.env scripts/regradeExistingAssignments.js
//
//   # limit to one student
//   STUDENT_ID=69bcfa91caf9745522af698a node --env-file=.env scripts/regradeExistingAssignments.js
//
//   # actually persist
//   APPLY=1 node --env-file=.env scripts/regradeExistingAssignments.js
//
//   # limit to one classroom
//   CLASSROOM_ID=6a46242e0a7cd009141114ab APPLY=1 node --env-file=.env scripts/regradeExistingAssignments.js

import mongoose from "mongoose";
import connectToDatabase from "../config/db.js";
import GradedAnswerModel from "../models/GradedAnswerModel.js";
import Assignment from "../models/AssignmentModel.js";
import Question from "../models/QuestionModel.js";
import GradeSetting from "../models/GradeSetting.js";
import { gradeDynamic } from "../controllers/Ai-tasks/ai-grader.js";

const APPLY = process.env.APPLY === "1" || process.env.APPLY === "true";
const STUDENT_ID = process.env.STUDENT_ID || null;
const CLASSROOM_ID = process.env.CLASSROOM_ID || null;

function stripQuotes(v) {
  return String(v ?? "").replace(/^["'`]+|["'`]+$/g, "");
}

async function loadGradeScale(teacherId) {
  if (!teacherId) return null;
  const setting = await GradeSetting.findOne({ teacherId }).lean();
  return setting && Array.isArray(setting.grades) ? setting.grades : null;
}

function letterFor(scale, pct) {
  if (!scale) return "Grades not defined";
  const match = scale.find(
    (g) => pct >= g.minPercent && pct <= g.maxPercent,
  );
  return match ? match.letter : "Grades not defined";
}

async function regradeOne(doc) {
  // Pull each question document so the AI grader gets the real question text
  // + type. The GradedAnswer copy of `correctAnswer` is enough as a fallback
  // if the Question row was deleted, but the model wants text to reason about.
  const questionIds = doc.gradedAnswers
    .map((ga) => ga.questionId)
    .filter(Boolean);
  const questionRows = await Question.find({ _id: { $in: questionIds } })
    .select("_id questionText type format correctAnswer")
    .lean();
  const byId = new Map(questionRows.map((q) => [String(q._id), q]));

  // Separate empty-answer questions out — an empty submission must score 0
  // without asking Gemini. The model was returning "your answer is correct"
  // for blank inputs, giving students free 10/10 on questions they didn't
  // even attempt.
  const emptyAnswerGrades = [];
  const questionsWithAnswers = doc.gradedAnswers
    .map((ga) => {
      const q = byId.get(String(ga.questionId));
      const submittedAnswer = Array.isArray(ga.submittedAnswer)
        ? ga.submittedAnswer.join(", ")
        : String(ga.submittedAnswer ?? "");
      const correctAnswer =
        (q?.correctAnswer && q.correctAnswer.length
          ? q.correctAnswer
          : ga.correctAnswer) || [];
      return {
        questionId: String(ga.questionId),
        question: q?.questionText || "(question text unavailable)",
        type: q?.type || q?.format || "textbox",
        correctAnswer,
        answer: submittedAnswer,
        maxMarks: ga.maxScore || 10,
      };
    })
    .filter((q) => q.question !== "(question text unavailable)")
    .filter((q) => {
      if (String(q.answer ?? "").trim() === "") {
        emptyAnswerGrades.push({
          questionId: q.questionId,
          submittedAnswer: [],
          correctAnswer: Array.isArray(q.correctAnswer)
            ? q.correctAnswer.map((s) => String(s).trim())
            : [],
          isCorrect: false,
          score: 0,
          maxScore: q.maxMarks,
          feedback: "No answer submitted.",
          subAssignmentId: doc.subAssignmentId,
        });
        return false;
      }
      return true;
    });

  // If every question is blank we can settle it locally — no AI needed.
  if (questionsWithAnswers.length === 0 && emptyAnswerGrades.length === 0) {
    return { status: "skipped", reason: "no questions resolvable" };
  }

  let aiResults = { graded: [], overall_remarks: "" };
  if (questionsWithAnswers.length > 0) {
    aiResults = await gradeDynamic(questionsWithAnswers, {
      includeRemarks: true,
      teacherId: null,
    });
    if (!aiResults?.graded?.length) {
      return { status: "skipped", reason: "AI grader returned nothing" };
    }
  }

  const normText = (s) =>
    String(s ?? "")
      .replace(/\\+/g, " ")
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  let totalScore = 0;
  let maxScore = 0;
  let correctCount = 0;
  const nextGradedAnswers = [];
  aiResults.graded.forEach((result, idx) => {
    const resultId = result.id != null ? String(result.id) : null;
    const original =
      (resultId &&
        questionsWithAnswers.find((q) => q.questionId === resultId)) ||
      questionsWithAnswers.find(
        (q) => normText(q.question) === normText(result.question),
      ) ||
      questionsWithAnswers[idx];
    if (!original) return;
    const submittedAnswerArray = String(result.answer ?? "")
      .split(",")
      .map((s) => stripQuotes(s?.trim()));
    const correctAnswerArray = Array.isArray(original.correctAnswer)
      ? original.correctAnswer.map((s) => s?.trim())
      : [];
    const isCorrect = result.score === result.maxMarks;
    if (isCorrect) correctCount++;
    totalScore += Number(result.score) || 0;
    maxScore += Number(result.maxMarks) || 0;
    nextGradedAnswers.push({
      questionId: original.questionId,
      submittedAnswer: submittedAnswerArray,
      correctAnswer: correctAnswerArray,
      isCorrect,
      score: Number(result.score) || 0,
      maxScore: Number(result.maxMarks) || 0,
      feedback: result.feedback || "",
      subAssignmentId: doc.subAssignmentId,
    });
  });

  // Merge the empty-answer 0s back in so totals and per-question rows include them.
  for (const g of emptyAnswerGrades) {
    maxScore += g.maxScore || 0;
    nextGradedAnswers.push(g);
  }

  const percentage =
    maxScore > 0 ? Number(((totalScore / maxScore) * 100).toFixed(2)) : 0;

  const parent = await Assignment.findById(doc.assignmentId)
    .select("teacherId")
    .lean();
  const scale = await loadGradeScale(parent?.teacherId);
  const grade = letterFor(scale, percentage);

  const before = {
    percentage: doc.percentage,
    grade: doc.grade,
    correctCount: doc.correctCount,
    firstFeedback: doc.gradedAnswers?.[0]?.feedback?.slice(0, 60),
  };
  const after = {
    percentage,
    grade,
    correctCount,
    firstFeedback: nextGradedAnswers?.[0]?.feedback?.slice(0, 60),
  };

  if (!APPLY) {
    return { status: "dry-run", before, after };
  }

  doc.gradedAnswers = nextGradedAnswers;
  doc.totalQuestions = nextGradedAnswers.length;
  doc.correctCount = correctCount;
  doc.incorrectCount = nextGradedAnswers.length - correctCount;
  doc.percentage = String(percentage);
  doc.grade = grade;
  doc.overall_remarks = aiResults.overall_remarks || doc.overall_remarks || "";
  doc.gradedBy = "AI";
  await doc.save();

  if (doc.subAssignmentId) {
    await Assignment.updateOne(
      { "assignments._id": doc.subAssignmentId },
      { $set: { "assignments.$.assignmentStatus": "graded" } },
    );
  }

  return { status: "updated", before, after };
}

async function main() {
  await connectToDatabase();
  const query = {};
  if (STUDENT_ID) query.studentId = new mongoose.Types.ObjectId(STUDENT_ID);
  if (CLASSROOM_ID) query.classroomId = new mongoose.Types.ObjectId(CLASSROOM_ID);
  console.log(
    `Loading GradedAnswer docs (query=${JSON.stringify(query)}, apply=${APPLY})`,
  );
  const docs = await GradedAnswerModel.find(query);
  console.log(`Found ${docs.length} docs.\n`);
  let updated = 0;
  let skipped = 0;
  for (const doc of docs) {
    const short = `${doc._id} subAssignmentId=${doc.subAssignmentId} student=${doc.studentId}`;
    try {
      const result = await regradeOne(doc);
      if (result.status === "updated") updated++;
      if (result.status === "skipped") skipped++;
      console.log(`${short} -> ${result.status}`);
      if (result.before) {
        console.log(
          `   before: pct=${result.before.percentage} grade=${result.before.grade} correct=${result.before.correctCount} feedback0="${result.before.firstFeedback}"`,
        );
        console.log(
          `   after : pct=${result.after.percentage} grade=${result.after.grade} correct=${result.after.correctCount} feedback0="${result.after.firstFeedback}"`,
        );
      } else if (result.reason) {
        console.log(`   reason: ${result.reason}`);
      }
    } catch (err) {
      console.error(`${short} FAILED:`, err.message);
    }
  }
  console.log(
    `\nDone. ${docs.length} scanned, ${updated} ${APPLY ? "updated" : "would update"}, ${skipped} skipped.`,
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
