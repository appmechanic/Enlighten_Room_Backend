import nodemailer from "nodemailer";

// Send Email
const sendEmail = async (user, verificationCode, userName) => {
  console.log("user", user);
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "paknight1786m@gmail.com",
        pass: "mpip bbaf esig clzs", // Store in env in production
      },
    });

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
      from: `"Enlighten Room" <paknight1786m@gmail.com>`,
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
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "paknight1786m@gmail.com",
        pass: "mpip bbaf esig clzs", // Store in env in production
      },
    });

    const subject = "You're Invited to Enlighten Room!";
    const html = `
      <p>Hello ${user.firstName} ${user.lastName},</p>

      <p><strong>Email:</strong> ${user.email}</p>
      <p><strong>Verification Code:</strong> ${verificationCode}</p>
      <p>Please log in with the provided password. If this wasn't initiated by you, kindly ignore this email.</p>
      <p>Thanks,<br/>Enlighten Room Team</p>
    `;

    const mailOptions = {
      from: `"Enlighten Room"`,
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

export { sendEmail, sendResetEmail };
