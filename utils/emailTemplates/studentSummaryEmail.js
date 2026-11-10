// HTML email template for the tokenized student date-range summary link (Task 3).
// Same inline-CSS conventions as lessonReportEmail.js — kept separate so the
// copy can evolve without tangling the Task 2 template.

const BRAND_COLOR = "#8B0000"; // Enlighten Room primary (dark red)
const BRAND_COLOR_DARK = "#6B0000";
const TEXT_COLOR = "#1f2937";
const MUTED_COLOR = "#6b7280";

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

function formatDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

/**
 * Build the HTML body for a date-range student summary email.
 *
 * @param {Object} opts
 * @param {string}  opts.recipientName  - "Alice" or "Alice's parent"
 * @param {string}  opts.studentName    - "Alice"
 * @param {string}  opts.teacherName    - "Ms. Kamboj"
 * @param {Date}    opts.rangeStart
 * @param {Date}    opts.rangeEnd
 * @param {string}  opts.viewUrl        - full URL with token
 * @param {string}  opts.customMessage  - optional teacher-provided note
 * @param {boolean} opts.isParent
 * @returns {{subject: string, html: string, text: string}}
 */
export function buildStudentSummaryEmail({
  recipientName,
  studentName,
  teacherName,
  rangeStart,
  rangeEnd,
  viewUrl,
  customMessage,
  isParent,
}) {
  const safeStudent = escapeHtml(studentName || "the student");
  const safeTeacher = escapeHtml(teacherName || "your teacher");
  const safeRecipient = escapeHtml(
    recipientName || (isParent ? "Parent" : safeStudent)
  );
  const rangeLabel = `${formatDate(rangeStart)} to ${formatDate(rangeEnd)}`;
  const safeRange = escapeHtml(rangeLabel);
  const safeMessage = escapeHtml(customMessage || "").trim();
  const safeUrl = escapeHtml(viewUrl);

  const subject = isParent
    ? `${studentName || "Your child"}'s learning summary (${rangeLabel})`
    : `Your learning summary (${rangeLabel})`;

  const greeting = isParent
    ? `Hi ${safeRecipient},`
    : `Hi ${safeRecipient},`;

  const intro = isParent
    ? `${safeTeacher} has shared a date-range summary of ${safeStudent}'s progress across ${safeRange}.`
    : `${safeTeacher} has shared a summary of your progress across ${safeRange}.`;

  const customBlock = safeMessage
    ? `
      <div style="margin:16px 0;padding:12px 14px;background:#f3f4f6;border-left:3px solid ${BRAND_COLOR};border-radius:4px;color:${TEXT_COLOR};font-style:italic;">
        ${safeMessage.replace(/\n/g, "<br>")}
      </div>`
    : "";

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT_COLOR};">
    <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <div style="background:${BRAND_COLOR};padding:24px;color:#ffffff;">
        <div style="font-size:20px;font-weight:600;letter-spacing:-0.3px;">EnlightenRoom</div>
        <div style="font-size:12px;opacity:0.85;margin-top:2px;">A Room to Enlighten</div>
      </div>
      <div style="padding:24px;">
        <p style="margin:0 0 12px;font-size:16px;">${greeting}</p>
        <p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${intro}</p>
        ${customBlock}
        <table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0;">
          <tr>
            <td align="center" style="background:${BRAND_COLOR};border-radius:6px;">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">View Summary</a>
            </td>
          </tr>
        </table>
        <p style="margin:12px 0 0;font-size:13px;color:${MUTED_COLOR};line-height:1.5;">
          Or copy this link:<br>
          <a href="${safeUrl}" style="color:${BRAND_COLOR_DARK};word-break:break-all;">${safeUrl}</a>
        </p>
        <p style="margin:20px 0 0;font-size:12px;color:${MUTED_COLOR};">
          This link is valid for 90 days from the date it was sent.
        </p>
      </div>
    </div>
  </body>
</html>`;

  const text = [
    greeting.replace(/<[^>]+>/g, ""),
    "",
    intro,
    safeMessage ? `\n"${customMessage}"\n` : "",
    `View your summary: ${viewUrl}`,
    "",
    "This link is valid for 90 days from the date it was sent.",
    "EnlightenRoom — A Room to Enlighten",
  ].join("\n");

  return { subject, html, text };
}
