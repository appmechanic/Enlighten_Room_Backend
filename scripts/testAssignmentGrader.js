// Standalone runner that reproduces the "Feedback: Pending grading" bug for
// the Student Assignment submission flow.
//
// Runs gradeDynamic() against the exact question set from the reported UI
// screenshot (LaTeX-heavy Q3, plain Q1/Q2, one correct textbox match, one
// clearly wrong answer). Then applies the same matching logic used inside
// submitAssignment() and prints, per question:
//
//   - what the AI grader returned raw
//   - which original question it was matched to (id / text / positional)
//   - the score + feedback the DB would end up with
//
// If any question ends up unmatched (dropped) OR feedback is blank, the
// script exits non-zero. That's the signal that the AI grader is not
// returning proper ids/text and the rule-based fallback is silently
// taking over — which is exactly what surfaces as "Pending grading" in
// the UI.
//
// Run:   node --env-file=.env scripts/testAssignmentGrader.js

import { gradeDynamic } from "../controllers/Ai-tasks/ai-grader.js";

// Same three questions as the reported screenshot. `questionId` is a stub
// but stable — this is what we ask the AI to echo back as `id`.
const questionsWithAnswers = [
  {
    questionId: "q1_variable",
    question: "In computer programming, what is the primary role of a variable?",
    type: "textbox",
    correctAnswer: ["A container for storing data values."],
    answer: "A container for storing data values.",
    maxMarks: 10,
  },
  {
    questionId: "q2_algorithm",
    question:
      "Which of the following best defines an algorithm in computer science?",
    type: "textbox",
    correctAnswer: [
      "A step-by-step procedure or formula for solving a problem or accomplishing a task.",
    ],
    answer:
      "A step-by-step procedure or formula for solving a problem or accomplishing a task.",
    maxMarks: 10,
  },
  {
    questionId: "q3_pseudocode",
    question:
      'Evaluate the output of the following pseudocode segment given \\(A = 5\\) and \\(B = 10\\):\nIf \\(A > 5\\) OR \\(B \\geq 10\\):\n  Print "First Condition"\nElse:\n  Print "Second Condition"',
    type: "mcq",
    correctAnswer: ['A) "First Condition"'],
    answer: 'B) "Second Condition"',
    maxMarks: 10,
  },
];

// Same normalizer submitAssignment uses for text-based matching.
const normText = (s) =>
  String(s ?? "")
    .replace(/\\+/g, " ")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function matchOriginal(result, resultIdx) {
  const resultId = result.id != null ? String(result.id) : null;
  if (resultId) {
    const byId = questionsWithAnswers.find(
      (q) => String(q.questionId) === resultId,
    );
    if (byId) return { how: "id", original: byId };
  }
  const byText = questionsWithAnswers.find(
    (q) => normText(q.question) === normText(result.question),
  );
  if (byText) return { how: "normalized-text", original: byText };
  const byPos = questionsWithAnswers[resultIdx];
  if (byPos) return { how: "positional", original: byPos };
  return { how: "none", original: null };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      "OPENAI_API_KEY missing. Run with:\n  node --env-file=.env scripts/testAssignmentGrader.js",
    );
    process.exit(2);
  }

  console.log("=== Assignment grader smoke test ===");
  console.log(`Sending ${questionsWithAnswers.length} questions to gradeDynamic...\n`);

  const t0 = Date.now();
  const aiResults = await gradeDynamic(questionsWithAnswers, {
    includeRemarks: false,
    // teacherId omitted so we skip TeacherAIConfig lookup (no DB in this
    // script). Grading rules and matching behavior are unaffected.
  });
  const elapsed = Date.now() - t0;
  console.log(`gradeDynamic returned in ${elapsed}ms`);
  console.log(`aiResults.graded.length = ${aiResults?.graded?.length ?? 0}\n`);

  if (!aiResults?.graded?.length) {
    console.error(
      "FAIL: AI grader returned no items — the whole submission would fall through to the rule-based fallback.",
    );
    return;
  }

  let failures = 0;

  aiResults.graded.forEach((result, idx) => {
    const { how, original } = matchOriginal(result, idx);
    const line = `#${idx + 1} match=${how} score=${result.score}/${result.maxMarks} feedbackLen=${
      (result.feedback || "").length
    }`;
    if (!original) {
      console.error(`${line}  <-- DROPPED (would fall through to fallback)`);
      failures++;
      return;
    }
    console.log(line);
    console.log(`   AI echoed id      : ${JSON.stringify(result.id ?? null)}`);
    console.log(`   AI echoed question: ${JSON.stringify((result.question || "").slice(0, 80))}`);
    console.log(`   matched original  : ${original.questionId}`);
    console.log(`   feedback          : ${JSON.stringify(result.feedback || "")}`);
    if (!result.feedback || !result.feedback.trim()) {
      console.error("   FAIL: blank feedback would surface as 'Pending grading' in the UI");
      failures++;
    }
    console.log("");
  });

  if (failures) {
    console.error(`\n${failures} failure(s) — this is the bug the user is seeing.`);
    process.exit(1);
  }
  console.log("PASS: every AI result matched an original question and carries feedback.");
}

// Also simulate the rule-based fallback (what happens when the AI grader
// returns an empty array, e.g. wrong API key). This is the code path the
// user is currently hitting in production.
function runFallback() {
  console.log("\n=== Rule-based fallback simulation ===");
  const stripQuotes = (v) => String(v ?? "").replace(/^["'`]+|["'`]+$/g, "");
  const norm = (v) =>
    String(v ?? "")
      .replace(/\\[()[\]]/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const rows = questionsWithAnswers.map((q) => {
    const submittedAnswerArray = q.answer
      .split(",")
      .map((s) => stripQuotes(s?.trim()));
    const correctAnswerArray = Array.isArray(q.correctAnswer)
      ? q.correctAnswer.map((s) => s?.trim())
      : [];
    let isCorrect = false;
    let score = 0;
    let feedback = "Awaiting teacher review.";
    if (correctAnswerArray.length > 0) {
      const normSubmitted = submittedAnswerArray.map(norm);
      const normCorrect = correctAnswerArray.map(norm);
      const allMatch =
        normCorrect.length === 1
          ? normSubmitted.some((s) => s === normCorrect[0])
          : normCorrect.every(
              (c, i) =>
                normSubmitted[i] !== undefined && normSubmitted[i] === c,
            );
      if (allMatch) {
        isCorrect = true;
        score = q.maxMarks || 0;
        feedback = "Correct.";
      } else {
        feedback = "Incorrect.";
      }
    }
    return { questionId: q.questionId, score, isCorrect, feedback };
  });
  rows.forEach((r) =>
    console.log(
      `  ${r.questionId}: ${r.score}/10  ${r.isCorrect ? "correct" : "wrong"}  → "${r.feedback}"`,
    ),
  );
}

main()
  .catch((err) => {
    console.error("Unexpected error:", err);
  })
  .finally(() => {
    runFallback();
  });
