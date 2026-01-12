// utils/notify.js
import Notification from "../models/NotificationModel.js";
import NotificationModel from "../models/NotificationModel.js";
import NotificationSetting from "../models/NotificationModel.js";
import User from "../models/user.js";

/**
 * Returns unique ObjectId list of parents for given student docs
 * Tries: student.parent?._id, student.parentId, student.parents (array)
 */
function extractParentIdsFromStudents(students) {
  const ids = new Set();
  for (const s of students) {
    // parent?._id (populated or embedded)
    const p1 = s?.parent?._id || s?.parent?._id?.toString?.();
    if (p1) ids.add(p1.toString());

    // parentId
    const p2 = s?.parentId || s?.parentId?.toString?.();
    if (p2) ids.add(p2.toString());

    // parents array
    if (Array.isArray(s?.parents)) {
      for (const p of s.parents) {
        if (p) ids.add(p.toString());
      }
    }
  }
  return [...ids];
}

/**
 * Optionally check NotificationSetting to see if user allows this type.
 * If no setting found, default to enabled=true.
 */
async function filterBySettings(userIds, type) {
  const settings = await NotificationSetting.find({
    userId: { $in: userIds },
    notificationType: type,
  });
  const allowed = new Set();
  const settingsByUser = new Map(settings.map((s) => [s.userId.toString(), s]));

  for (const uid of userIds) {
    const s = settingsByUser.get(uid.toString());
    if (!s || s.enabled) allowed.add(uid.toString());
  }
  return [...allowed];
}

/**
 * Fan out "new_assignment" notifications to students + parents.
 * @param {Object} params
 *  - assignmentDoc: the Assignment document (after create/append)
 *  - tasks: the array passed (assignments)
 *  - actorId: user who triggered (teacherId)
 *  - classroomId, sessionId: for safety/meta
 *  - io: optional Socket.IO server instance
 */
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
      // no specific studentIds — fetch all students from classroom
      const classroomStudents = await User.find(
        { classrooms: classroomId, userRole: "student" }, // adjust if your schema stores classroom membership differently
        { _id: 1 }
      ).lean();
      classroomStudents.forEach((s) => allStudentIds.add(s._id.toString()));
    }
  }

  const studentIds = [...allStudentIds];

  console.log("studentIds", studentIds);
  // Fetch student docs to resolve parents
  const students = studentIds.length
    ? await User.find(
        { _id: { $in: studentIds } },
        { _id: 1, parent: 1, parentId: 1, parents: 1 }
      ).lean()
    : [];

  console.log("students", students);
  const parentIds = extractParentIdsFromStudents(students);

  console.log("parentIds", parentIds);
  // Respect per-user notification settings (if you added "new_assignment" to settings)
  const allowedStudentIds = await filterBySettings(
    studentIds,
    "new_assignment"
  );
  const allowedParentIds = parentIds.length
    ? await filterBySettings(parentIds, "new_assignment")
    : [];

  const now = new Date();

  // Build notifications
  const docs = [];
  for (const a of tasks) {
    const title = `New assignment: ${a.title}`;
    const description = a.dueDate
      ? `Due on ${new Date(a.dueDate).toLocaleString()}`
      : `A new assignment has been posted.`;
    const link = a.deepLink || `/app/assignments/${assignmentDoc._id}`; // adjust to your route

    const meta = {
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

    // decide recipients for this task (specific students or entire class)
    let recipients = [];
    if (Array.isArray(a.studentIds) && a.studentIds.length) {
      recipients = a.studentIds
        .map(String)
        .filter((id) => allowedStudentIds.includes(id));
    } else {
      recipients = allowedStudentIds;
    }

    // push student notifications
    for (const uid of recipients) {
      docs.push({
        userId: uid,
        actorId: actorId || null,
        type: "new_assignment",
        title,
        description,
        metadata: meta,
        link,
        isRead: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    // parents of those recipients
    if (allowedParentIds.length) {
      // limit to parents of the recipients of this task
      const studentsInTask = await User.find(
        { _id: { $in: recipients } },
        { _id: 1, parent: 1, parentId: 1, parents: 1 }
      ).lean();
      const taskParentIds = extractParentIdsFromStudents(studentsInTask).filter(
        (pid) => allowedParentIds.includes(pid)
      );

      for (const pid of taskParentIds) {
        docs.push({
          userId: pid,
          actorId: actorId || null,
          type: "new_assignment",
          title: `Your student has a new assignment: ${a.title}`,
          description,
          metadata: meta,
          link,
          isRead: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  if (!docs.length) return;

  // Bulk insert
  const inserted = await Notification.insertMany(docs, { ordered: false });

  // Emit socket.io events (optional)
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

  // TODO: enqueue emails if you send emails for "new_assignment"
}

/* ---------- NEW: notifyAssignmentReport ---------- */

export async function notifyAssignmentReport(p) {
  const {
    studentId,
    subAssignmentTitle,
    parentAssignmentId,
    sessionId,
    classroomId,
    gradedDoc,
    percentage,
    grade,
    includeRemarks,
    actorId,
    io,
  } = p;

  const student = await User.findById(studentId, {
    _id: 1,
    firstName: 1,
    lastName: 1,
    userName: 1,
    parent: 1,
    parentId: 1,
    parents: 1,
  }).lean();

  if (!student) return;

  const studentName = displayName(student);
  const parentIds = extractParentIdsFromStudents([student]);

  // Respect NotificationSetting (if configured)
  const [allowedStudentIds, allowedParentIds] = await Promise.all([
    filterBySettings([studentId], "assignment_report"),
    filterBySettings(parentIds, "assignment_report"),
  ]);

  const link = `/app/assignments/${parentAssignmentId}/reports/${
    gradedDoc?._id || ""
  }`; // adjust your route

  const meta = {
    assignmentId: parentAssignmentId,
    sessionId,
    classroomId,
    gradedAnswerId: gradedDoc?._id || null,
    percentage,
    grade,
    includeRemarks,
    student: { _id: studentId, name: studentName },
  };

  const now = new Date();
  const docs = [];

  // Student notification
  if (allowedStudentIds.includes(String(studentId))) {
    docs.push({
      userId: studentId,
      actorId: actorId || null,
      type: "assignment_report",
      title: `Assignment report available: ${subAssignmentTitle}`,
      description: `You scored ${percentage}%${grade ? ` (${grade})` : ""}.`,
      metadata: meta,
      link,
      isRead: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Parent notification (with student name)
  for (const pid of allowedParentIds) {
    docs.push({
      userId: pid,
      actorId: actorId || null,
      type: "assignment_report",
      title: `${studentName}'s assignment report: ${subAssignmentTitle}`,
      description: `Score: ${percentage}%${grade ? ` (${grade})` : ""}.`,
      metadata: meta,
      link,
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

export async function listUserNotifications(req, res, next) {
  try {
    const userId = req.user._id;
    if (!userId) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    const notification = await NotificationModel.find({ userId });
    if (notification.length == 0) {
      return res.status(400).json({ message: "notifications not found" });
    }

    return res.status(200).json({ success: true, notification });
  } catch (err) {
    next(err);
  }
}
