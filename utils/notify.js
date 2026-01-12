// utils/notify.js
import Notification from "../models/NotificationModel.js";
import User from "../models/user.js";
import {
  displayName,
  formatNameList,
  extractParentIdsFromStudents,
  filterBySettings,
  extractQuestionStats,
} from "./notification.helper.js";

/** ---------- New Assignment (notifications only) ---------- */
export async function notifyNewAssignment({
  assignmentDoc,
  tasks,
  actorId,
  classroomId,
  sessionId,
  io,
}) {
  // Collect all studentIds across tasks
  let allStudentIds = new Set();
  for (const a of tasks) {
    if (Array.isArray(a.studentIds) && a.studentIds.length) {
      a.studentIds.forEach((id) => allStudentIds.add(id.toString()));
    } else {
      const classroomStudents = await User.find(
        { classrooms: classroomId, userRole: "student" },
        { _id: 1 }
      ).lean();
      classroomStudents.forEach((s) => allStudentIds.add(s._id.toString()));
    }
  }
  const studentIds = [...allStudentIds];

  // Fetch once to resolve parents (and names)
  const students = studentIds.length
    ? await User.find(
        { _id: { $in: studentIds } },
        {
          _id: 1,
          firstName: 1,
          lastName: 1,
          userName: 1,
          parent: 1,
          parentId: 1,
          parents: 1,
        }
      ).lean()
    : [];

  const parentIds = extractParentIdsFromStudents(students);
  const allowedStudentIds = await filterBySettings(
    studentIds,
    "new_assignment"
  );
  const allowedParentIds = parentIds.length
    ? await filterBySettings(parentIds, "new_assignment")
    : [];

  // Quick lookup map
  const studentById = new Map(students.map((s) => [s._id.toString(), s]));

  const now = new Date();
  const docs = [];

  for (const a of tasks) {
    const title = `New assignment: ${a.title}`;
    const description = a.dueDate
      ? `Due on ${new Date(a.dueDate).toLocaleString()}`
      : `A new assignment has been posted.`;

    const baseMeta = {
      assignmentId: assignmentDoc._id,
      classroomId,
      sessionId,
      task: {
        title: a.title,
        dueDate: a.dueDate || null,
        maxMarks: a.maxMarks ?? null,
        questionIds: a.questions || [],
      },
    };

    // recipients for this task
    const recipients =
      Array.isArray(a.studentIds) && a.studentIds.length
        ? a.studentIds
            .map(String)
            .filter((id) => allowedStudentIds.includes(id))
        : allowedStudentIds;

    // Student notifications
    for (const uid of recipients) {
      docs.push({
        userId: uid,
        actorId: actorId || null,
        type: "new_assignment",
        title,
        description,
        metadata: { ...baseMeta },
        isRead: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Parent notifications (with student names)
    if (allowedParentIds.length && recipients.length) {
      const parentToStudents = new Map(); // parentId -> [{_id, name}]
      for (const sid of recipients) {
        const stu = studentById.get(sid);
        if (!stu) continue;
        const sName = displayName(stu);

        const potentialParentIds = extractParentIdsFromStudents([stu]);
        for (const pid of potentialParentIds) {
          if (!allowedParentIds.includes(pid)) continue;
          const arr = parentToStudents.get(pid) || [];
          arr.push({ _id: sid, name: sName });
          parentToStudents.set(pid, arr);
        }
      }

      for (const [pid, kids] of parentToStudents.entries()) {
        const names = kids.map((k) => k.name);
        const namesText = formatNameList(names);
        docs.push({
          userId: pid,
          actorId: actorId || null,
          type: "new_assignment",
          title: `${namesText} ${
            names.length > 1 ? "have" : "has"
          } a new assignment: ${a.title}`,
          description,
          metadata: { ...baseMeta, students: kids },
          isRead: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (!docs.length) return;
  const inserted = await Notification.insertMany(docs, { ordered: false });

  if (io) {
    for (const n of inserted) {
      io.to(n.userId.toString()).emit("notification:new", {
        _id: n._id,
        type: n.type,
        title: n.title,
        description: n.description,
        link: n.link,
        metadata: n.metadata,
        createdAt: n.createdAt,
      });
    }
  }
}

/** ---------- Assignment Report (notifications only) ---------- */
export async function notifyAssignmentReport({
  studentId,
  subAssignmentTitle,
  parentAssignmentId,
  sessionId,
  classroomId,
  gradedDoc,
  percentage, // optional override
  grade,
  includeRemarks, // not used in notification text, but kept in metadata
  actorId,
  io,
}) {
  const student = await User.findById(studentId, {
    _id: 1,
    firstName: 1,
    lastName: 1,
    userName: 1,
    email: 1,
    parent: 1,
    parentId: 1,
    parents: 1,
  }).lean();
  if (!student) return;

  const studentName = displayName(student);
  const parentIds = extractParentIdsFromStudents([student]);

  const [allowedStudentIds, allowedParentIds] = await Promise.all([
    filterBySettings([studentId], "assignment_report"),
    filterBySettings(parentIds, "assignment_report"),
  ]);

  // Stats for metadata and summary
  const stats = extractQuestionStats(gradedDoc || {});
  const finalPercentage =
    typeof percentage === "number" ? percentage : stats.percentage;

  const meta = {
    assignmentId: parentAssignmentId,
    sessionId,
    classroomId,
    gradedAnswerId: gradedDoc?._id || null,
    percentage: finalPercentage,
    grade,
    includeRemarks,
    student: { _id: studentId, name: studentName },
    totals: {
      totalQuestions: stats.totalQuestions,
      attempted: stats.attempted,
      correct: stats.correct,
      totalScore: stats.totalScore,
      maxScore: stats.maxScore,
      percentage: finalPercentage,
    },
    questions: stats.questions.map((q) => ({
      no: q.no,
      score: q.score,
      max: q.max,
      correct: q.correct,
      attempted: q.attempted,
      title: q.title,
    })),
  };

  const now = new Date();
  const docs = [];

  if (allowedStudentIds.includes(String(studentId))) {
    docs.push({
      userId: studentId,
      actorId: actorId || null,
      type: "assignment_report",
      title: `Assignment report available: ${subAssignmentTitle}`,
      description: `You scored ${stats.totalScore}/${
        stats.maxScore
      } (${finalPercentage}%)${grade ? ` — ${grade}` : ""}.`,
      metadata: meta,
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const pid of allowedParentIds) {
    docs.push({
      userId: pid,
      actorId: actorId || null,
      type: "assignment_report",
      title: `${studentName}'s assignment report: ${subAssignmentTitle}`,
      description: `Score: ${stats.totalScore}/${
        stats.maxScore
      } (${finalPercentage}%)${grade ? ` — ${grade}` : ""}.`,
      metadata: meta,
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (!docs.length) return;
  const inserted = await Notification.insertMany(docs, { ordered: false });

  if (io) {
    for (const n of inserted) {
      io.to(n.userId.toString()).emit("notification:new", {
        _id: n._id,
        type: n.type,
        title: n.title,
        description: n.description,
        link: n.link,
        metadata: n.metadata,
        createdAt: n.createdAt,
      });
    }
  }
}
