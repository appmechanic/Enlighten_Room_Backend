import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail", // or your SMTP provider
  auth: {
    user: process.env.NODEMAILER_EMAIL,
    pass: process.env.NODEMAILER_PASSCODE,
  },
});

export const sendReportEmail = async (student, report, parent) => {
  try {
    if (!parent || !parent.email) {
      throw new Error(`Missing parent email for student ${student.name}`);
    }

    // console.log("parent======", parent);
    const mailOptions = {
      from: process.env.NODEMAILER_EMAIL,
      to: parent.email,
      subject: `Report for ${student.name}`,
      text: `Dear Parent,\n\nHere is the report for your child, ${student.name}:\n\n${report}`,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${parent.email} for student ${student.name}`);
  } catch (error) {
    console.error(
      `❌ Failed to send email to parent of ${student.name}:`,
      error.message
    );
    throw error; // Re-throw to be caught by the calling function if needed
  }
};
