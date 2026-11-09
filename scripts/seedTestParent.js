// scripts/seedTestParent.js
//
// Seeds (or removes) a throw-away parent-User linked to a student so the
// Send-to-Both / Send-to-Parents email dispatch flow can be tested when the
// student record has no parent associated.
//
// In this app the student's parent is tracked via User.parentId pointing at
// another User (role='parent'), not via the Parent collection — the classroom
// controller resolves parentEmail from student.parentId.email. So we seed a
// parent-User and set student.parentId.
//
// This is a DEV ONLY helper. The seeded parent-User has a placeholder password
// hash and cannot log in — it exists only so the dispatch code sees a valid
// email to send to.
//
// Usage:
//   node scripts/seedTestParent.js <studentEmail> <parentEmail>   # seed + link
//   node scripts/seedTestParent.js <studentEmail> --remove         # unlink + delete
//
// Example:
//   node scripts/seedTestParent.js uraj4259@gmail.com uraj4259+parent@gmail.com
//   node scripts/seedTestParent.js uraj4259@gmail.com --remove

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../models/user.js";

const TEST_PARENT_TAG = "__test-seeded-parent__";

async function main() {
  const studentEmail = (process.argv[2] || "").trim();
  const second = (process.argv[3] || "").trim();
  if (!studentEmail || !second) {
    console.error(
      "Usage:\n  node scripts/seedTestParent.js <studentEmail> <parentEmail>\n  node scripts/seedTestParent.js <studentEmail> --remove"
    );
    process.exit(1);
  }
  const isRemove = second === "--remove";

  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(dbUrl);

  const student = await User.findOne({ email: studentEmail })
    .select("_id firstName lastName userName parentId")
    .lean();
  if (!student) {
    console.error(`No User row with email "${studentEmail}".`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (isRemove) {
    if (!student.parentId) {
      console.log(`Student ${studentEmail} has no parentId set. Nothing to remove.`);
      await mongoose.disconnect();
      return;
    }
    const parentUser = await User.findById(student.parentId).lean();
    if (!parentUser) {
      console.log(
        `Student.parentId=${student.parentId} does not resolve to any User. Clearing parentId anyway.`
      );
    } else if (!(parentUser.userName || "").startsWith(TEST_PARENT_TAG)) {
      console.error(
        `Refusing to remove parent id=${parentUser._id} — it is NOT a seeded test-parent (userName=${parentUser.userName}). Clear student.parentId manually if you really want to unlink.`
      );
      await mongoose.disconnect();
      process.exit(1);
    } else {
      await User.deleteOne({ _id: parentUser._id });
      console.log(`Removed seeded parent-User id=${parentUser._id} email=${parentUser.email}.`);
    }
    await User.updateOne({ _id: student._id }, { $unset: { parentId: "" } });
    console.log(`Cleared parentId on student ${studentEmail}.`);
    await mongoose.disconnect();
    return;
  }

  const parentEmail = second;
  if (student.parentId) {
    const existing = await User.findById(student.parentId).select("email userName").lean();
    console.log(
      `Student ${studentEmail} already has a parent linked (email=${existing?.email || "?"}, userName=${existing?.userName || "?"}). Remove it first with --remove if you want to replace it.`
    );
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash("test-only-not-usable", 10);
  const parent = await User.create({
    firstName: "Test",
    lastName: "Parent",
    userName: `${TEST_PARENT_TAG}-${Date.now()}`,
    email: parentEmail,
    password: passwordHash,
    userRole: "parent",
    is_verified: true,
    is_active: true,
  });
  await User.updateOne({ _id: student._id }, { $set: { parentId: parent._id } });

  console.log(`Seeded parent-User id=${parent._id} email=${parent.email}.`);
  console.log(`Linked student ${studentEmail} -> parentId=${parent._id}.`);
  console.log(`Remove with: node scripts/seedTestParent.js ${studentEmail} --remove`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
