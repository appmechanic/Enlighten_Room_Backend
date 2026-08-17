import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.NODEMAILER_EMAIL,
    pass: process.env.NODEMAILER_PASSCODE,
  },
});

const fromAddress = `"Enlighten Room" <${process.env.NODEMAILER_EMAIL}>`;

// Send Email
const sendEmail = async (user, verificationCode, userName) => {
  console.log("user", user);
  try {
    const subject = "You're Invited to Enlighten Room!";
    const html = `
      <p>Hello ${user.firstName} ${user.lastName},</p>
      <p>You have been invited to join <strong>Enlighten Room</strong>.</p>

      <p>User Name: <strong>${userName}</strong></p>
      <p><strong>Email:</strong> ${user.email}</p>
      <p><strong>Password:</strong> ${user.password}</p>
      <p><strong>Verification Code:</strong> ${verificationCode}</p>
      <p>Please log in with the provided password. If this wasn't initiated by you, kindly ignore this email.</p>
      <p>Thanks,<br/>Enlighten Room Team</p>
    `;

    const mailOptions = {
      from: fromAddress,
      to: user.email,
      subject,
      html,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Invitation email sent to: ${user.email}`);
    return true;
  } catch (error) {
    console.error("Error sending invitation email:", error.message);
    return false;
  }
};
const sendResetEmail = async (user, verificationCode) => {
  try {
    const subject = "You're Invited to Enlighten Room!";
    const html = `
      <p>Hello ${user.firstName} ${user.lastName},</p>

      <p><strong>Email:</strong> ${user.email}</p>
      <p><strong>Verification Code:</strong> ${verificationCode}</p>
      <p>Please log in with the provided password. If this wasn't initiated by you, kindly ignore this email.</p>
      <p>Thanks,<br/>Enlighten Room Team</p>
    `;

    const mailOptions = {
      from: fromAddress,
      to: user.email,
      subject,
      html,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Invitation email sent to: ${user.email}`);
    return true;
  } catch (error) {
    console.error("Error sending invitation email:", error.message);
    return false;
  }
};

// Sent when a school-admin signup successfully matches a registered school.
const sendSchoolAdminApprovedEmail = async (user, matchedSchoolName) => {
  try {
    const subject = "Your School Administrator account is approved";
    const html = `
      <p>Hello ${user.firstName} ${user.lastName},</p>
      <p>Your school <strong>${matchedSchoolName || user.organization}</strong> has been verified. Your account is now active as <strong>School Administrator</strong>.</p>
      <p>You can subscribe to school subscription plans and later add teachers to your school.</p>
      <p>Thanks,<br/>Enlighten Room Team</p>
    `;
    await transporter.sendMail({
      from: fromAddress,
      to: user.email,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("Error sending school-admin approval email:", error.message);
    return false;
  }
};

// Sent when a school-admin signup does not match any registered school —
// the account falls back to a Teacher role and requires manual verification.
const sendSchoolAdminPendingEmail = async (user, reason) => {
  try {
    const subject = "Further verification required for your School Administrator request";
    const html = `
      <p>Hello ${user.firstName} ${user.lastName},</p>
      <p>We could not automatically verify <strong>${user.organization || "your school"}</strong> against our registered schools list${reason ? ` (${reason})` : ""}.</p>
      <p>Your account has been created with the <strong>Teacher</strong> role for now. Reply to this email with your school's official documentation so our team can review and upgrade your account to School Administrator.</p>
      <p>Thanks,<br/>Enlighten Room Team</p>
    `;
    await transporter.sendMail({
      from: fromAddress,
      to: user.email,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("Error sending school-admin pending email:", error.message);
    return false;
  }
};

export {
  sendEmail,
  sendResetEmail,
  sendSchoolAdminApprovedEmail,
  sendSchoolAdminPendingEmail,
};
