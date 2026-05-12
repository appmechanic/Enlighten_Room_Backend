import nodemailer from "nodemailer";

// Email transporter (update with your SMTP or Gmail settings)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NODEMAILER_EMAIL, // replace with your email
    pass: process.env.NODEMAILER_PASSCODE, // use App Password if using Gmail
  },
});

/**
 * Generic email sender
 */
export const sendEmail = async ({ to, subject, html, replyTo }) => {
  console
    .log
    // `Sending email to ${to} with subject: ${subject} with html: ${html}`
    ();
  const mailOptions = {
    from: process.env.NODEMAILER_EMAIL,
    to,
    subject,
    html,
  };
  if (replyTo) mailOptions.replyTo = replyTo;

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent to ${to}`);
  } catch (error) {
    console.error(`Failed to send email to ${to}`, error);
  }
};
