// HTML email template for the tokenized lesson-report viewer link.
// Inline CSS only — email clients (Outlook especially) strip <style> blocks
// and external stylesheets. Keep this plain and conservative.
//
// Called by tokenizedReportController when a teacher dispatches a lesson
// report. Each recipient gets their own token, so each gets their own
// personalised viewUrl. No CSV attachment (that's the whole point of Task 2).

const BRAND_COLOR = "#8B0000"; // Enlighten Room primary (dark red)
const BRAND_COLOR_DARK = "#6B0000";
const TEXT_COLOR = "#1f2937";
const MUTED_COLOR = "#6b7280";

// Escape untrusted strings so teacher messages / names can't break the HTML.
// Covers the standard five XSS chars plus backtick (just in case).
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/**
 * Build the HTML body for the lesson report email.
 *
 * @param {Object} opts
 * @param {string} opts.recipientName    - "Alice" or "Alice's parent"
 * @param {string} opts.studentName      - "Alice"
 * @param {string} opts.lessonName       - "Lesson 3: Fractions"
 * @param {string} opts.sessionTopic     - optional, e.g. "Week 4 Math"
 * @param {string} opts.teacherName      - "Ms. Kamboj"
 * @param {string} opts.viewUrl          - full URL with token
 * @param {string} opts.customMessage    - optional teacher-provided note
 * @param {boolean} opts.isParent        - true if recipient is the parent
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildLessonReportEmail({
  recipientName,
  studentName,
  lessonName,
  sessionTopic,
  teacherName,
  viewUrl,
  customMessage,
  isParent,
}) {
  const safeStudent = escapeHtml(studentName || "the student");
  const safeLesson = escapeHtml(lessonName || "the lesson");
  const safeTeacher = escapeHtml(teacherName || "your teacher");
  const safeTopic = escapeHtml(sessionTopic || "");
  const safeRecipient = escapeHtml(
    recipientName || (isParent ? "Parent" : safeStudent)
  );
  const safeMessage = escapeHtml(customMessage || "").trim();
  const safeUrl = escapeHtml(viewUrl);

  const greeting = isParent
    ? `Dear ${safeRecipient},`
    : `Hi ${safeRecipient},`;

  const intro = isParent
    ? `${safeTeacher} has shared ${safeStudent}'s lesson report for <strong>${safeLesson}</strong>${safeTopic ? ` (${safeTopic})` : ""}.`
    : `${safeTeacher} has shared your lesson report for <strong>${safeLesson}</strong>${safeTopic ? ` (${safeTopic})` : ""}.`;

  const subject = isParent
    ? `${studentName}'s report: ${lessonName}`
    : `Your lesson report: ${lessonName}`;

  // Plain-text fallback for email clients that reject HTML (and for
  // accessibility / spam-filter heuristics).
  const text = [
    isParent
      ? `Dear ${recipientName},`
      : `Hi ${recipientName},`,
    "",
    isParent
      ? `${teacherName} has shared ${studentName}'s lesson report for "${lessonName}".`
      : `${teacherName} has shared your lesson report for "${lessonName}".`,
    "",
    "View the report (equations and handwritten answers render properly in the web viewer):",
    viewUrl,
    "",
    customMessage ? `Note from ${teacherName}:` : null,
    customMessage || null,
    customMessage ? "" : null,
    "This link is valid for 90 days. After it expires, please log in to your Enlighten Room account to view past reports.",
    "",
    "— Enlighten Room",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:${TEXT_COLOR};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">

            <!-- Brand header -->
            <tr>
              <td style="background-color:${BRAND_COLOR};padding:20px 28px;">
                <div style="color:#ffffff;font-size:20px;font-weight:600;letter-spacing:0.3px;">
                  EnlightenRoom
                </div>
                <div style="color:rgba(255,255,255,0.8);font-size:12px;margin-top:2px;">
                  A Room to Enlighten
                </div>
              </td>
            </tr>

            <!-- Greeting + intro -->
            <tr>
              <td style="padding:28px 28px 8px 28px;">
                <p style="margin:0 0 12px 0;font-size:16px;line-height:1.5;">${greeting}</p>
                <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
                  ${intro}
                </p>
              </td>
            </tr>

            ${
              safeMessage
                ? `
            <!-- Optional teacher message -->
            <tr>
              <td style="padding:0 28px 8px 28px;">
                <div style="background-color:#fef9f2;border-left:4px solid ${BRAND_COLOR};padding:12px 16px;border-radius:6px;">
                  <div style="font-size:12px;color:${MUTED_COLOR};margin-bottom:4px;font-weight:600;">Note from ${safeTeacher}:</div>
                  <div style="font-size:14px;line-height:1.5;color:${TEXT_COLOR};white-space:pre-wrap;">${safeMessage}</div>
                </div>
              </td>
            </tr>
            `
                : ""
            }

            <!-- CTA button (table-based so Outlook renders it) -->
            <tr>
              <td align="center" style="padding:24px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td align="center" bgcolor="${BRAND_COLOR}" style="border-radius:8px;">
                      <a href="${safeUrl}"
                         target="_blank"
                         rel="noopener"
                         style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;background-color:${BRAND_COLOR};">
                        View Report
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:12px 0 0 0;font-size:12px;color:${MUTED_COLOR};text-align:center;">
                  Or copy this link: <br/>
                  <a href="${safeUrl}" style="color:${BRAND_COLOR_DARK};word-break:break-all;">${safeUrl}</a>
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:16px 28px 28px 28px;border-top:1px solid #e5e7eb;">
                <p style="margin:0 0 8px 0;font-size:12px;line-height:1.5;color:${MUTED_COLOR};">
                  Equations and handwritten answers render properly in the web viewer — much better than plain text or PDF.
                </p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED_COLOR};">
                  This link is valid for <strong>90 days</strong>. After it expires, please log in to your Enlighten Room account to view past reports.
                </p>
              </td>
            </tr>

          </table>

          <p style="max-width:560px;margin:16px auto 0 auto;font-size:11px;color:${MUTED_COLOR};text-align:center;">
            Sent by Enlighten Room on behalf of ${safeTeacher}. If you did not expect this report, please ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, html, text };
}
