// services/emailService.js
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    // Gmail address jahan se emails jayengi
    user: process.env.NODEMAILER_EMAIL,
    // Gmail App Password (16-character code), NOT your normal password
    pass: process.env.NODEMAILER_PASSCODE,
  },
});

/**
 * Send welcome email to teacher with their login credentials
 */
export async function sendTeacherWelcomeEmail({ email, name, password }) {
  if (!email) {
    throw new Error("Recipient email is required");
  }

  const fromEmail =
    // agar tumne custom FROM_EMAIL set kiya hua hai to woh use hoga
    process.env.FROM_EMAIL ||
    // warna jo NODEMAILER_EMAIL hai usi se send hoga
    process.env.NODEMAILER_EMAIL ||
    '"EnlightenRoom" <no-reply@enlightenroom.com>';

  const mailOptions = {
    from: fromEmail,
    to: email,
    subject: "Your Teacher Account has been created",
    html: `
      <p>Hi ${name || "Teacher"},</p>
      <p>Your teacher account has been created on <strong>EnlightenRoom</strong>.</p>
      <p><strong>Login Email:</strong> ${email}<br/>
      <strong>Password:</strong> ${password}</p>
      <p>Please login and change your password after first login.</p>
      <p>Login here: <a href="https://enlightenmenthub.com/login" target="_blank">https://enlightenmenthub.com/login</a></p>
      <p>Best regards,<br/>EnlightenRoom Team</p>
    `,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log("Sending welcome email to:", info.envelope.to[0]);

  return info; // optional, but useful if you want to log messageId etc.
}

export default transporter;
