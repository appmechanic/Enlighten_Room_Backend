import { serverSideEquivalenceMatches } from "./geminiClassworkFeedback.js";

function normalizeBlank(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function fillBlanksAllMatch(studentArr, correctArr) {
  if (!Array.isArray(studentArr) || !Array.isArray(correctArr)) return false;
  if (studentArr.length === 0 || correctArr.length === 0) return false;
  if (studentArr.length !== correctArr.length) return false;
  for (let i = 0; i < correctArr.length; i += 1) {
    const s = normalizeBlank(studentArr[i]);
    const c = normalizeBlank(correctArr[i]);
    if (!s || !c || s !== c) return false;
  }
  return true;
}

function pickFirstName(studentName) {
  const raw = String(studentName || "").trim();
  if (!raw) return "";
  return raw.split(/\s+/)[0];
}

// Canned "you got it" reply reused when the fast path fires. Kept short and
// language-neutral so it works across the classroom-supported languages
// without triggering a translation call. Mirrors the shape shapeFeedback()
// produces so downstream persistence + SSE handlers don't have to branch.
function buildCannedCorrectResult({ studentName }) {
  const firstName = pickFirstName(studentName);
  const greeting = firstName
    ? `Nice work, ${firstName}! That answer is correct.`
    : "Nice work! That answer is correct.";
  return {
    correct: true,
    hintStream: greeting,
    part1: [greeting],
    part2: [],
    part3: [],
    advancedChallenge: { congratulations: "", question: "" },
    standardSolution: "",
    commonMistake: { title: "", isCommon: false, answerLatex: "" },
    raw: "",
    fastPath: true,
  };
}

// Returns a canned aiResult when the student's answer deterministically
// matches the teacher's correct answer AND we're on a format where an
// exact match is safe to short-circuit on. Returns null otherwise, in
// which case the caller should fall through to the normal Gemini path.
//
// Scope on purpose:
//   mcq          — single-string reference, exact match under narrow normalize
//   textbox      — same, plus the math-notation equivalence rules
//                  (whitespace, LaTeX backslashes on function names,
//                   sin(5x) vs sin5x) that serverSideEquivalenceMatches
//                  already ships with
//   fill-blanks  — per-blank case-insensitive compare, all blanks must match
//
// Anything else (handwriting, images, arrays for non-fill formats,
// follow-up questions with no reference answer) returns null.
export function tryFastPathAiResult({
  answer,
  correctAnswer,
  format,
  studentName,
  isFollowUp,
}) {
  if (isFollowUp) return null;
  if (!format || correctAnswer == null) return null;

  if (format === "mcq" || format === "textbox") {
    if (serverSideEquivalenceMatches(answer, correctAnswer, format)) {
      return buildCannedCorrectResult({ studentName });
    }
    return null;
  }

  if (format === "fill-blanks") {
    if (fillBlanksAllMatch(answer, correctAnswer)) {
      return buildCannedCorrectResult({ studentName });
    }
    return null;
  }

  return null;
}
