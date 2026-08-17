import { sendEmail } from "./sendEmail.js";

// 👨‍🏫 Lesson Reminder
export const sendLessonReminderEmails = async (students, datetime) => {
  console.log("students ====", students);
  const subject = "Upcoming Lesson Reminder";
  const html = `
    <p>Dear Student,</p>
    <p>This is a reminder that you have an upcoming session scheduled at <strong>${datetime}</strong>.</p>
    <p>Please be on time.</p>
  `;

  const recipients = [...students.map((s) => s.email)];
  for (const email of recipients) {
    await sendEmail({ to: email, subject, html });
  }
};

// 💰 Fee Reminder
export const sendFeeReminderEmails = async (parents, students, amount) => {
  const subject = "Tuition Fee Due Reminder";

  const parentEmailJobs = parents.map((parent) => {
    const fullName =
      parent.firstName && parent.lastName
        ? `${parent.firstName} ${parent.lastName}`
        : "Parent";
    const parentHtml = `
      <p>Dear ${fullName},</p>
      <p>This is a friendly reminder that your child's tuition fee of <strong>$${amount}</strong> is due.</p>
      <p>Please make the payment at your earliest convenience.</p>
      <p>We appreciate your cooperation and support.</p>
    `;
    return sendEmail({ to: parent.email, subject, html: parentHtml });
  });

  const studentEmailJobs = students.map((student) => {
    const fullName =
      student.firstName && student.lastName
        ? `${student.firstName} ${student.lastName}`
        : "Student";
    const studentHtml = `
      <p>Dear ${fullName},</p>
      <p>This is a reminder that your tuition fee of <strong>$${amount}</strong> is due.</p>
      <p>Please remind your parent or guardian to make the payment.</p>
      <p>Thank you for staying responsible.</p>
    `;
    return sendEmail({ to: student.email, subject, html: studentHtml });
  });

  try {
    await Promise.all([...parentEmailJobs, ...studentEmailJobs]);
    console.log("✅ All fee reminders sent successfully.");
  } catch (err) {
    console.error("❌ Some fee reminders failed to send:", err.message);
    throw new Error("Failed to send some or all fee reminder emails.");
  }
};

// 📝 Homework Reminder
export const sendHomeworkReminderEmails = async (students, dueDate) => {
  const subject = "Assignment Due Reminder";

  for (const student of students) {
    const html = `
      <p>Dear ${student.firstName} ${student.lastName},</p>
      <p>This is a reminder that your assignment is due on <strong>${dueDate}</strong>.</p>
      <p>Please make sure to complete and submit it before the deadline.</p>
    `;
    await sendEmail({ to: student.email, subject, html });
  }
};
