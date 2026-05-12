import { sendEmail } from "./sendEmail.js";

const BRAND = "EnlightenRoom";

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
 * Email a teacher / school admin after a successful subscription payment.
 * Tells them: (a) subscription is active and paid, (b) reply to this email
 * to unsubscribe and stop future payments.
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

  const subject = `Your ${BRAND} subscription is active`;
  const html = `
    <div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5">
      <p>Hi ${escape(name) || "there"},</p>
      <p>Thank you — your <strong>${escape(planName) || "subscription"}</strong> on <strong>${BRAND}</strong> has been activated and your payment was received successfully.</p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;margin:12px 0;font-size:14px">
        <tr><td><strong>Plan</strong></td><td>${escape(planName) || "-"}</td></tr>
        <tr><td><strong>Billing</strong></td><td>${escape(interval) || "-"}</td></tr>
        <tr><td><strong>Amount</strong></td><td>${escape(formatAmount(amount, currency))}</td></tr>
        <tr><td><strong>Payment Method</strong></td><td>${escape(provider) || "-"}</td></tr>
        <tr><td><strong>Reference ID</strong></td><td>${escape(referenceId) || "-"}</td></tr>
      </table>
      <p><strong>To unsubscribe and stop future payments, simply reply to this email</strong> and our team will cancel your subscription. Please include the Reference ID above so we can match your account.</p>
      <p style="margin-top:24px">Best regards,<br/>${BRAND} Team</p>
    </div>
  `;

  await sendEmail({
    to,
    subject,
    html,
    replyTo: supportEmail,
  });
}
