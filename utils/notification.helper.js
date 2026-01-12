// utils/notify-helpers.js
import NotificationSetting from "../models/NotificationModel.js"; // ⬅️ adjust if needed

/** ------------ Plain helpers ------------ */
export function displayName(u) {
  if (u?.firstName || u?.lastName) {
    return [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  }
  return u?.userName || u?.name || "Student";
}

export function formatNameList(names = []) {
  if (!names.length) return "your student";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

export function extractParentIdsFromStudents(students) {
  const ids = new Set();
  for (const s of students) {
    const p1 = s?.parent?._id || s?.parent?._id?.toString?.();
    if (p1) ids.add(p1.toString());
    const p2 = s?.parentId || s?.parentId?.toString?.();
    if (p2) ids.add(p2.toString());
    if (Array.isArray(s?.parents)) {
      for (const p of s.parents) if (p) ids.add(p.toString());
    }
  }
  return [...ids];
}

export function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function safeRemarks(gradedDoc) {
  return (
    gradedDoc?.overall_remarks || // your field
    gradedDoc?.overallRemarks ||
    gradedDoc?.remarks ||
    gradedDoc?.generalFeedback ||
    gradedDoc?.aiRemarks ||
    ""
  );
}

export function buildReportLink(pathLike) {
  const base = process.env.APP_BASE_URL || "";
  try {
    return base ? new URL(pathLike, base).toString() : pathLike;
  } catch {
    return pathLike;
  }
}

/** ------------ Stats extractor ------------
 * Uses (in this order):
 * 1) gradedDoc.gradedAnswers[] (per-question, best)
 * 2) gradedDoc.gradedQuestions|questions|items|results (legacy arrays)
 * 3) Top-level fields only (summary-only)
 */
export function extractQuestionStats(gradedDoc = {}) {
  // Prefer the canonical gradedAnswers array
  const byGradedAnswers = Array.isArray(gradedDoc?.gradedAnswers)
    ? gradedDoc.gradedAnswers
    : [];

  if (byGradedAnswers.length) {
    const questions = byGradedAnswers.map((ga, i) => {
      const title =
        ga?.questionTitle ||
        ga?.questionText ||
        ga?.prompt ||
        `Question ${i + 1}`;
      const score = num(ga?.score, 0);
      const max = num(ga?.maxScore, 0);
      const attempted = Array.isArray(ga?.submittedAnswer)
        ? ga.submittedAnswer.length > 0
        : ga?.submittedAnswer != null;
      const correct = !!ga?.isCorrect;

      return {
        no: i + 1,
        title: String(title),
        score,
        max,
        attempted,
        correct,
        feedback: ga?.feedback || "",
      };
    });

    const totalQuestions = questions.length;
    const attempted = questions.filter((q) => q.attempted).length;
    const correct = questions.filter((q) => q.correct).length;
    const totalScore = questions.reduce((s, q) => s + num(q.score, 0), 0);
    const maxScore = questions.reduce((s, q) => s + num(q.max, 0), 0);
    const pct =
      gradedDoc?.percentage != null
        ? num(gradedDoc.percentage)
        : maxScore > 0
        ? (totalScore / maxScore) * 100
        : 0;

    return {
      questions,
      totalQuestions,
      attempted,
      correct,
      totalScore,
      maxScore,
      percentage: Number(pct.toFixed(2)),
    };
  }

  // Legacy arrays (if any)
  const raw =
    gradedDoc?.gradedQuestions ||
    gradedDoc?.questions ||
    gradedDoc?.items ||
    gradedDoc?.results ||
    [];

  if (Array.isArray(raw) && raw.length) {
    const normalized = raw.map((q, i) => {
      const title =
        q?.title ||
        q?.questionText ||
        q?.question ||
        q?.prompt ||
        `Question ${i + 1}`;

      const score =
        num(q?.score) ??
        num(q?.marksObtained) ??
        num(q?.awarded) ??
        num(q?.points);

      const max =
        num(q?.maxScore) ??
        num(q?.totalMarks) ??
        num(q?.pointsPossible) ??
        num(q?.maxPoints) ??
        0;

      const attempted =
        q?.answer != null ||
        (Array.isArray(q?.answers) && q.answers.length > 0) ||
        q?.response != null ||
        q?.selectedOption != null;

      const correct =
        typeof q?.isCorrect === "boolean"
          ? q.isCorrect
          : typeof q?.correct === "boolean"
          ? q.correct
          : max > 0 && score >= max;

      return {
        no: i + 1,
        title: String(title),
        score: num(score, 0),
        max: num(max, 0),
        attempted: !!attempted,
        correct: !!correct,
      };
    });

    const totalQuestions = normalized.length;
    const attempted = normalized.filter((q) => q.attempted).length;
    const correct = normalized.filter((q) => q.correct).length;
    const totalScore = normalized.reduce((s, q) => s + num(q.score, 0), 0);
    const docMax =
      num(gradedDoc?.maxScore) || num(gradedDoc?.totalMarks) || null;
    const computedMax = normalized.reduce((s, q) => s + num(q.max, 0), 0);
    const maxScore = docMax || computedMax;
    const percentage = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

    return {
      questions: normalized,
      totalQuestions,
      attempted,
      correct,
      totalScore,
      maxScore,
      percentage: Number(percentage.toFixed(2)),
    };
  }

  // Summary-only fallback
  const totalQuestions = num(
    gradedDoc?.totalQuestions ??
      gradedDoc?.questionCount ??
      gradedDoc?.total_items,
    0
  );
  const attempted = num(
    gradedDoc?.attemptedCount ??
      gradedDoc?.attemptedQuestions ??
      gradedDoc?.attempted ??
      totalQuestions,
    totalQuestions
  );
  const correct = num(
    gradedDoc?.correctCount ??
      gradedDoc?.correctQuestions ??
      gradedDoc?.correct,
    0
  );
  const totalScore = num(
    gradedDoc?.totalScore ??
      gradedDoc?.obtainedMarks ??
      gradedDoc?.score ??
      gradedDoc?.marks_obtained,
    0
  );
  const maxScore = num(
    gradedDoc?.maxScore ??
      gradedDoc?.totalMarks ??
      gradedDoc?.outOf ??
      gradedDoc?.max_marks,
    0
  );
  const percentage = Number(
    (gradedDoc?.percentage != null
      ? num(gradedDoc.percentage)
      : maxScore > 0
      ? (totalScore / maxScore) * 100
      : 0
    ).toFixed(2)
  );

  return {
    questions: [],
    totalQuestions,
    attempted,
    correct,
    totalScore,
    maxScore,
    percentage,
  };
}

/** ------------ Settings filter (DB) ------------
 * If no setting found, default to enabled=true.
 */
export async function filterBySettings(userIds, type) {
  const settings = await NotificationSetting.find({
    userId: { $in: userIds },
    notificationType: type,
  }).lean();

  const byUser = new Map(settings.map((s) => [s.userId.toString(), s]));
  const allowed = new Set();
  for (const uid of userIds) {
    const s = byUser.get(uid.toString());
    if (!s || s.enabled) allowed.add(uid.toString());
  }
  return [...allowed];
}
