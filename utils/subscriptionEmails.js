import { sendEmail } from "./sendEmail.js";

const BRAND = "Enlighten Room";
const SITE_URL = "https://enlightenroom.com";
const LOGO_URL = `${SITE_URL}/assets/site-logo-BJqgHiRE.png`;

const escape = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const formatAmount = (amount, currency = "USD") => {
  if (amount == null || Number.isNaN(Number(amount))) return "-";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
    }).format(Number(amount));
  } catch {
    return `${Number(amount).toFixed(2)} ${currency}`;
  }
};

/**
 * Email a teacher / school admin after a successful subscription payment
 * (Stripe or PayPal). Welcomes them to Enlighten Room, walks them through
 * next steps, and tells them how to unsubscribe / request a formal invoice.
 */
export async function sendSubscriptionConfirmationEmail({
  to,
  name,
  planName,
  interval,
  amount,
  currency,
  referenceId,
  provider,
}) {
  if (!to) return;

  const supportEmail =
    process.env.SUBSCRIPTION_REPLY_EMAIL ||
    process.env.NODEMAILER_EMAIL ||
    "support@enlightenroom.com";

  const subject = `Welcome to ${BRAND}! 🌟 Your classroom is ready.`;

  const greetingName = escape(name) || "Teacher";
  const planLabel = escape(planName) || "your plan";
  const intervalLabel = escape(interval) || "-";
  const amountLabel = escape(formatAmount(amount, currency));
  const providerLabel = escape(provider) || "-";
  const referenceLabel = escape(referenceId) || "-";

  const html = `
    <div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:640px;margin:0 auto;padding:24px">
      <p>Dear ${greetingName},</p>

      <p>Thank you for joining <strong>${BRAND} Inc.</strong> Your subscription has been successfully processed, and we are honored to provide the digital space for your teaching journey.</p>

      <p>At ${BRAND}, we believe that technology should serve the human connection. By combining a full online classroom suite with our specialized AI-assisted handwriting analysis, we aim to help you focus on what truly matters: inspiring your students.</p>

      <h3 style="margin-top:24px;margin-bottom:8px;color:#111827">Next Steps to Get Started:</h3>
      <p style="margin:6px 0"><strong>Log In:</strong> Access your dashboard at <a href="${SITE_URL}" target="_blank" style="color:#2563eb;text-decoration:none">enlightenroom.com</a> using your registered email.</p>
      <p style="margin:6px 0"><strong>Create Your First Room:</strong> You can now set up your online classroom, add students, and begin using our AI-driven assessment tools.</p>
      <p style="margin:6px 0"><strong>Support:</strong> If you need assistance with technical setup or integrating your curriculum, simply reply to this email. We are here to support you every step of the way.</p>

      <h3 style="margin-top:24px;margin-bottom:8px;color:#111827">Important Information:</h3>
      <p style="margin:6px 0"><strong>Official Records:</strong> Please keep this email as confirmation of your payment. If your school or board requires a formal invoice with our Business Registration details for reimbursement, you can download it directly from your account.</p>
      <p style="margin:6px 0"><strong>Our Philosophy:</strong> We are committed to growth. If you ever feel our platform no longer meets your needs, you can unsubscribe by replying to this email with your reason. We value your feedback as it helps us build a more effective learning environment for everyone.</p>

      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:20px 0;font-size:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px">
        <tr><td><strong>Plan</strong></td><td>${planLabel}</td></tr>
        <tr><td><strong>Billing</strong></td><td>${intervalLabel}</td></tr>
        <tr><td><strong>Amount</strong></td><td>${amountLabel}</td></tr>
        <tr><td><strong>Payment Method</strong></td><td>${providerLabel}</td></tr>
        <tr><td><strong>Reference ID</strong></td><td>${referenceLabel}</td></tr>
      </table>

      <p>Thank you for the vital work you do. Let's enlighten the future of education together.</p>

      <p style="margin-top:24px">With gratitude and peace,<br/><strong>${BRAND} Inc.</strong><br/><a href="${SITE_URL}" target="_blank" style="color:#2563eb;text-decoration:none">${SITE_URL}</a></p>

      <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center">
        <img src="${LOGO_URL}" alt="${BRAND}" style="max-width:160px;height:auto;display:block;margin:0 auto 12px" />
        <p style="color:#6b7280;font-size:13px;font-style:italic;margin:0">Enlighten every STEM classroom: Mastering the process with personalized AI and multimodal intelligence.</p>
      </div>
    </div>
  `;

  await sendEmail({
    to,
    subject,
    html,
    replyTo: supportEmail,
  });
}
