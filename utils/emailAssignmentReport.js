// utils/emailAssignmentReport.js
import User from "../models/user.js";
import Question from "../models/QuestionModel.js"; // adjust path if needed
import { sendEmail } from "./sendEmail.js";
import {
  displayName,
  escapeHtml,
  safeRemarks,
  extractQuestionStats,
  filterBySettings,
  buildReportLink,
  num,
} from "./notification.helper.js";

/** Populate question titles from DB by gradedAnswers.questionId (best effort) */
async function buildStatsFromGradedDoc(gradedDoc = {}) {
  const items = Array.isArray(gradedDoc?.gradedAnswers)
    ? gradedDoc.gradedAnswers
    : [];

  if (!items.length) return null;

  const ids = items
    .map((ga) => ga?.questionId)
    .filter(Boolean)
    .map((id) => id.toString());

  const qDocs = ids.length
    ? await Question.find(
        { _id: { $in: ids } },
        { _id: 1, title: 1, questionText: 1, prompt: 1 }
      ).lean()
    : [];

  const qMap = new Map(qDocs.map((q) => [q._id.toString(), q]));

  const questions = items.map((ga, i) => {
    const qDoc = qMap.get(ga?.questionId?.toString?.() || "");
    const title =
      ga?.questionTitle || // snapshot if saved in controller
      qDoc?.title ||
      qDoc?.questionText ||
      qDoc?.prompt ||
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

export async function sendAssignmentReportEmails({
  studentId,
  subAssignmentTitle,
  parentAssignmentId,
  sessionId,
  classroomId,
  gradedDoc,
  percentage, // optional override
  grade,
  includeRemarks,
}) {
  const student = await User.findById(studentId, {
    _id: 1,
    firstName: 1,
    lastName: 1,
    userName: 1,
    email: 1,
    parent: 1,
    parentId: 1,
    parents: 1,
  }).lean();
  if (!student) return;

  const studentName = displayName(student);

  const parentIds = (() => {
    const ids = [];
    if (student?.parent?._id) ids.push(String(student.parent._id));
    if (student?.parentId) ids.push(String(student.parentId));
    if (Array.isArray(student?.parents)) {
      for (const p of student.parents) if (p) ids.push(String(p));
    }
    return Array.from(new Set(ids));
  })();

  const [allowedStudentIds, allowedParentIds] = await Promise.all([
    filterBySettings([studentId], "assignment_report"),
    filterBySettings(parentIds, "assignment_report"),
  ]);

  const statsFromDb = await buildStatsFromGradedDoc(gradedDoc || {});
  const stats = statsFromDb || extractQuestionStats(gradedDoc || {});
  const finalPercentage =
    typeof percentage === "number" ? percentage : stats.percentage;
  const remarks = includeRemarks ? safeRemarks(gradedDoc) : "";

  const linkPath = `/app/assignments/${parentAssignmentId}/reports/${
    gradedDoc?._id || ""
  }`;
  const link = buildReportLink(linkPath);

  const emailTargets = [];
  if (allowedStudentIds.includes(String(studentId)) && student?.email) {
    emailTargets.push({
      to: student.email,
      isParent: false,
      studentName,
    });
  }

  if (allowedParentIds?.length) {
    const parents = await User.find(
      { _id: { $in: allowedParentIds } },
      { _id: 1, firstName: 1, lastName: 1, userName: 1, email: 1 }
    ).lean();

    for (const pdoc of parents) {
      if (!pdoc?.email) continue;
      emailTargets.push({
        to: pdoc.email,
        isParent: true,
        studentName,
        parentName: displayName(pdoc),
      });
    }
  }

  if (!emailTargets.length) return;

  const htmlFor = ({ isParent }) => {
    const title = isParent
      ? `${escapeHtml(studentName)}'s assignment report: ${escapeHtml(
          subAssignmentTitle
        )}`
      : `Your assignment report: ${escapeHtml(subAssignmentTitle)}`;

    const scoreLine = `Score: <strong>${Number(stats.totalScore).toFixed(
      2
    )} / ${stats.maxScore}</strong> &nbsp;•&nbsp; Percentage: <strong>${Number(
      finalPercentage
    ).toFixed(2)}%${grade ? ` (${escapeHtml(grade)})` : ""}</strong>`;

    const metaLine = `Questions: <strong>${stats.totalQuestions}</strong> &nbsp;•&nbsp; Attempted: <strong>${stats.attempted}</strong> &nbsp;•&nbsp; Correct: <strong>${stats.correct}</strong>`;

    // Build table rows with mobile labels included inside each cell (shown on mobile)
    const rows = stats.questions.length
      ? stats.questions
          .map(
            (q) => `
              <tr class="row">
                <td class="cell num" style="padding:12px;border:1px solid #eee;">
                  <span class="mobile-label" style="display:none;font-weight:600;">#</span>${
                    q.no
                  }
                </td>
                <td class="cell q" style="padding:12px;border:1px solid #eee;">
                  <span class="mobile-label" style="display:none;font-weight:600;">Question</span>${escapeHtml(
                    q.title
                  )}
                </td>
                <td class="cell att" style="padding:12px;border:1px solid #eee;text-align:center;">
                  <span class="mobile-label" style="display:none;font-weight:600;">Attempted</span>${
                    q.attempted ? "Yes" : "No"
                  }
                </td>
                <td class="cell cor" style="padding:12px;border:1px solid #eee;text-align:center;">
                  <span class="mobile-label" style="display:none;font-weight:600;">Correct</span>${
                    q.correct ? "✅" : "—"
                  }
                </td>
                <td class="cell score" style="padding:12px;border:1px solid #eee;text-align:right;">
                  <span class="mobile-label" style="display:none;font-weight:600;">Score</span>${Number(
                    q.score
                  ).toFixed(2)} / ${Number(q.max).toFixed(2)}
                </td>
              </tr>
              ${
                q.feedback
                  ? `<tr class="row">
                       <td class="cell fb" colspan="5" style="padding:12px;border:1px solid #eee;color:#444;">
                         <span class="mobile-label" style="display:none;font-weight:600;">Feedback</span>
                         <em>Feedback:</em> ${escapeHtml(q.feedback)}
                       </td>
                     </tr>`
                  : ""
              }`
          )
          .join("")
      : `<tr class="row">
             <td class="cell" colspan="5" style="padding:12px;border:1px solid #eee;text-align:center;color:#666;">
               No question-level data
             </td>
           </tr>`;

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="x-ua-compatible" content="ie=edge">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Assignment Report</title>
    <style>
      /* Resets + base */
      body, table, td, a { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
      table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
      img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
      table { border-collapse: collapse !important; }
      body { margin: 0 !important; padding: 0 !important; width: 100% !important; background: #f6f7f9; }
      a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
      .container { width: 720px; max-width: 100%; background:#ffffff; border:1px solid #eee; border-radius:10px; }
      .content { padding: 24px; }
      .title { margin: 0 0 12px; font-size: 22px; line-height: 1.3; color: #111; }
      .muted { color: #333; }
      .btn { display: inline-block; padding: 10px 16px; border-radius: 8px; background: #111; color: #fff !important; text-decoration: none; }
      .table { width: 100%; border-collapse: collapse; font-size: 14px; }
      .table th, .table td { border: 1px solid #eee; padding: 12px; }
      .thead th { text-align: left; background: #fafafa; }
      .remarks { background:#f9fafb; border:1px solid #eee; border-radius:8px; padding:12px; margin:12px 0; }
      .mobile-label { display: none; } /* shown on mobile */

      /* Mobile */
      @media screen and (max-width: 600px) {
        .content { padding: 16px !important; }
        .title { font-size: 20px !important; }
        .btn { display:block !important; width:100% !important; text-align:center !important; }
        .table { font-size: 15px !important; }
        .thead { display: none !important; }
        /* Turn each row into a card; show labels inside cells */
        .row { display: block !important; border: 1px solid #eee !important; border-radius: 8px !important; margin-bottom: 10px !important; }
        .row .cell { display: block !important; width: 100% !important; border: none !important; border-bottom: 1px solid #eee !important; padding: 10px !important; text-align: left !important; }
        .row .cell:last-child { border-bottom: none !important; }
        .mobile-label { display: block !important; font-weight: 600 !important; margin-bottom: 4px !important; color:#111 !important; }
        .score { text-align: right !important; }
      }

      /* Outlook-specific font fallback */
      /*[if mso]*/
      .fallback-font { font-family: Arial, Helvetica, sans-serif !important; }
      /*[endif]*/
    </style>
    <!--[if mso]>
      <style type="text/css">
        .content, .table, .btn { font-family: Arial, Helvetica, sans-serif !important; }
      </style>
    <![endif]-->
  </head>
  <body class="fallback-font">
    <center role="article" aria-roledescription="email" lang="en">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f6f7f9;">
        <tr>
          <td align="center" style="padding:16px;">
            <table role="presentation" width="720" class="container">
              <tr>
                <td class="content">
                  <h2 class="title">${title}</h2>
                  <p style="margin:0 0 8px;">${scoreLine}</p>
                  <p class="muted" style="margin:0 0 12px;">${metaLine}</p>

                  ${
                    remarks
                      ? `<div class="remarks">
                           <div style="font-weight:600;margin-bottom:6px;">Remarks</div>
                           <div>${escapeHtml(remarks).replace(
                             /\n/g,
                             "<br/>"
                           )}</div>
                         </div>`
                      : ""
                  }

                  <table role="presentation" class="table">
                    <thead class="thead">
                      <tr>
                        <th style="text-align:left;">#</th>
                        <th style="text-align:left;">Question</th>
                        <th style="text-align:center;">Attempted</th>
                        <th style="text-align:center;">Correct</th>
                        <th style="text-align:right;">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rows}
                    </tbody>
                  </table>

                  
                  <p class="muted" style="margin-top:16px;">This is an automated message.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </center>
  </body>
</html>`;
  };

  const tasks = emailTargets.map((t) => {
    const html = htmlFor({ isParent: !!t.isParent });
    const subject = t.isParent
      ? `${t.studentName}'s assignment report: ${subAssignmentTitle} — ${stats.totalScore}/${stats.maxScore} (${finalPercentage}%)`
      : `Your assignment report: ${subAssignmentTitle} — ${stats.totalScore}/${stats.maxScore} (${finalPercentage}%)`;

    return sendEmail({ to: t.to, subject, html });
  });

  await Promise.allSettled(tasks);
}
