// scripts/findParentForStudent.js
//
// Finds the Parent row linked to a student (by Parent.userId -> User._id).
// Useful for test setup when you need to redirect the parent email to a
// developer inbox before testing the Send-to-Parents or Send-to-Both flow.
//
// Usage: node scripts/findParentForStudent.js <studentEmail>

import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/user.js";
import Parent from "../models/parentModel.js";

async function main() {
  const studentEmail = (process.argv[2] || "").trim();
  if (!studentEmail) {
    console.error("Usage: node scripts/findParentForStudent.js <studentEmail>");
    process.exit(1);
  }
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(dbUrl);

  const student = await User.findOne({ email: studentEmail })
    .select("_id firstName lastName userName email userRole")
    .lean();
  if (!student) {
    console.error(`No User row with email "${studentEmail}".`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(
    `Student: ${student.firstName || ""} ${student.lastName || ""} (${student.userName}) role=${student.userRole} id=${student._id}`
  );

  const parents = await Parent.find({ userId: student._id })
    .select("_id firstName lastName userName email relation")
    .lean();

  if (parents.length === 0) {
    console.log(`\nNo Parent rows linked to this student (userId=${student._id}).`);
    console.log(
      `\nTo test the parent-dispatch flow you'll need to either seed a Parent row via the app's normal signup, or skip to "Both" with a stand-in parentEmail on the student record if the SendReportModal supports that.`
    );
  } else {
    console.log(`\nFound ${parents.length} Parent row(s):`);
    parents.forEach((p, i) => {
      console.log(
        `  ${i + 1}. ${p.firstName || ""} ${p.lastName || ""} (${p.userName}) relation=${p.relation}`
      );
      console.log(`      email=${p.email}  id=${p._id}`);
    });
    console.log(
      `\nTo redirect the parent email to your inbox for testing, add to scripts/updateTestEmails.js MAPPINGS:`
    );
    parents.forEach((p) => {
      console.log(`  "${p.email}": "uraj4259+parent@gmail.com",`);
    });
    console.log(`then run:  node scripts/updateTestEmails.js --execute`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
