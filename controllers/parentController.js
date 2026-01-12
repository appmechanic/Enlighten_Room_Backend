import mongoose from "mongoose";
import Parent from "../models/parentModel.js";
import Student from "../models/studentModel.js";
import User from "../models/user.js";
import { addSendEmail } from "../utils/addSendEmail.js";
import Assignment from "../models/AssignmentModel.js";
import Classroom from "../models/classroomModel.js";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import Session from "../models/SessionModel.js";
// export const createParent = async (req, res) => {
//   try {
//     // Check if email already exists
//     const existingParent = await Parent.findOne({ email: req.body.email });
//     if (existingParent) {
//       return res.status(409).json({ error: "Email already exists" });
//     }
//     const parent = await Parent.create(req.body);
//     res.status(201).json({ message: "Parent created successfully", parent });
//   } catch (err) {
//     res.status(400).json({ error: err.message });
//   }
// };

const generateUniqueUserName = async (firstName, lastName) => {
  let base = `${firstName}${lastName}`.toLowerCase().replace(/\s/g, "");
  let userName;
  let exists = true;

  while (exists) {
    const suffix = Math.floor(100 + Math.random() * 900); // 3-digit random
    userName = `${base}${suffix}`;
    exists = await User.findOne({ userName });
  }

  return userName;
};

export const createParent = async (req, res) => {
  try {
    const { email, password, firstName, lastName, ...rest } = req.body;

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res
        .status(409)
        .json({ error: "User with this email already registered" });
    }
    const existingParent = await User.findOne({ email });
    if (existingParent) {
      return res
        .status(409)
        .json({ error: "User with this email already registered" });
    }

    // Generate unique userName
    const userName = await generateUniqueUserName(firstName, lastName);

    // Create user entry
    const user = new User({
      email,
      password,
      userRole: "parent",
      userName,
      firstName,
      lastName,
      is_verified: true,
      is_active: true,
      teacherId: req.user._id,
      ...rest,
    });

    // // Create Parent-specific record
    // const parent = new Parent({
    //   userId: user._id,
    //   email,
    //   password,
    //   is_verified: true,
    //   userName,
    //   firstName,
    //   lastName,
    //   ...rest,
    // });

    // ✅ Send Email
    const html = `
      <h3>Welcome to Enlighten Room!</h3>
      <p>Your account has been created.</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Password:</strong> ${password}</p>
      <p><strong>Username:</strong> ${userName}</p>
      <p>You can now log in and start using the platform.</p>
    `;

    // const emailSent = await addSendEmail(
    //   email,
    //   "Your AI Tutoring Account",
    //   html
    // );
    // await user.save();

    let populatedUser;
    try {
      await addSendEmail(email, "Your Enlighten Room Account", html);
      // ✅ Populate parentId and teacherId
      await user.save();
      populatedUser = await User.findOne({ _id: user._id }).select(
        "-__v -OTP_code -password -is_active -is_verified -isPaid -isAdmin"
      );
      // res.status(201).json({ populatedUser });

      // await student.save();
    } catch (error) {
      console.error("Error sending email:", error);
    }

    // await parent.save();

    res
      .status(201)
      .json({ message: "Parent created successfully", populatedUser });
  } catch (err) {
    console.log(err);
    res.status(400).json({ error: err.message });
  }
};

export const getParents = async (req, res) => {
  try {
    const userId = req.user._id;
    const getUser = await User.findById(userId);

    console.log("Requesting User:", getUser);
    if (!getUser) {
      return res.status(404).json({ message: "User not found" });
    }

    let filters = { ...req.query, userRole: "parent" };

    console.log("Filters before role check:", filters);
    // If teacher, filter parents by teacherId (only their added parents)
    if (getUser.userRole === "teacher") {
      filters.teacherId = userId;
    }
    // If admin, return all parents (no additional filter needed)
    else if (getUser.userRole === "admin") {
      // Admin sees all parents - no extra filter
    }
    // If neither teacher nor admin, deny access
    else {
      return res.status(403).json({
        message: "Access denied. Teachers and Admins only.",
      });
    }

    const parents = await User.find(filters).select(
      "firstName lastName userName email userRole settings image phone city is_active is_verified relation country language teacherId"
    );

    if (!parents || parents.length === 0) {
      return res
        .status(404)
        .json({ message: "Parents Not Found", success: false });
    }

    res.json(parents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getParentById = async (req, res) => {
  try {
    const parentId = req.params.id;

    // Step 1: Find the parent
    const parent = await User.findOne({
      _id: parentId,
      userRole: "parent",
    }).select(
      "firstName lastName userName email userRole settings image phone city relation language country"
    );
    if (!parent) {
      return res.status(404).json({ message: "Parent not found" });
    }

    // Step 2: Find students linked with this parent
    const students = await User.find({
      userRole: "student",
      parentId: parent._id,
    })
      .select(
        "email userName firstName lastName language age date_of_birth createdAt"
      )
      .lean();

    // Step 3: Respond with both parent and students
    res.status(200).json({
      success: true,
      parent,
      students,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateParent = async (req, res) => {
  try {
    const disallowedFields = [
      "email",
      "userRole",
      "password",
      "userName",
      "is_verified",
      "referedBy",
    ];
    disallowedFields.forEach((field) => delete req.body[field]);

    // const users = await User.find({ email: req.body.email });
    // if (users.length > 0) {
    //   return res
    //     .status(409)
    //     .json({ error: "User with this email already registered" });
    // }
    const parent = await User.findOneAndUpdate(
      { _id: req.params.id, userRole: "parent" },
      req.body,
      {
        new: true,
      }
    ).select(
      "firstName lastName userName email userRole settings image phone city relation"
    );
    if (!parent) return res.status(404).json({ message: "Parent not found" });
    res.json({ message: "Parent updated successfully", parent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

export const deleteParent = async (req, res) => {
  try {
    const parent = await User.findByIdAndDelete({
      _id: req.params.id,
      userRole: "parent",
    });
    if (!parent) return res.status(404).json({ message: "Parent not found" });
    res.json({ message: "Parent deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getParentDashboard = async (req, res) => {
  try {
    const { parentId } = req.params;

    if (!parentId || !mongoose.Types.ObjectId.isValid(parentId)) {
      return res.status(400).json({ error: "Valid parentId is required." });
    }

    // 0) Parent
    const parent = await User.findOne({ _id: parentId, userRole: "parent" })
      .select(
        "firstName lastName userName email userRole image phone gender city country language"
      )
      .lean();

    if (!parent) {
      return res.status(404).json({ error: "Parent not found." });
    }

    // 1) Children (students of this parent)
    const children = await User.find({
      parentId: parentId,
      userRole: "student",
    })
      .select(
        "firstName lastName userName email userRole settings image phone gender city country"
      )
      .lean();

    const parentChildIds = new Set(children.map((c) => String(c._id)));

    if (!children.length) {
      return res.status(200).json({
        parent,
        children: [],
        perChild: [],
        assignmentDeadlines: {
          today: { count: 0, items: [] },
          past15Days: { count: 0, items: [] },
          upcoming30Days: { count: 0, items: [] },
        },
        todayAssignments: [],
        thisWeekAssignments: [],
        todaySessions: [],
        thisWeekSessions: [],
        allAssignments: [],
        submissionStatuses: [],
        reports: {
          averageScore: "No submissions graded yet",
          completedAssignments: 0,
          autoSubmittedAssignments: 0,
          pendingAssignments: 0,
        },
        calendar: {
          rangeStart: null,
          rangeEnd: null,
          counts: { classes: 0, sessions: 0, assignments: 0 },
          events: [],
        },
        success: true,
        message: "No children found for this parent.",
      });
    }

    // ---------- shared helpers ----------
    const ymdUTC = (d) => new Date(d).toISOString().split("T")[0];
    const dayIndex = (ymd) => {
      const [y, m, d] = ymd.split("-").map(Number);
      return Date.UTC(y, m - 1, d) / 86400000;
    };
    const addMinutes = (date, min) => {
      const d = new Date(date);
      d.setMinutes(d.getMinutes() + (Number(min) || 60));
      return d;
    };
    const incByFrequency = (date, freq) => {
      const d = new Date(date);
      const f = String(freq || "once").toLowerCase();
      if (f === "daily") d.setDate(d.getDate() + 1);
      else if (f === "weekly") d.setDate(d.getDate() + 7);
      else if (f === "biweekly") d.setDate(d.getDate() + 14);
      else if (f === "monthly") d.setMonth(d.getMonth() + 1);
      else return null; // "once"
      return d;
    };

    // ---------- student snapshot ----------
    const buildStudentSnapshot = async (studentDoc, parentChildIds) => {
      const studentId = String(studentDoc._id);

      // Window helpers (today, week)
      const now = new Date();
      const startOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );
      const endOfDay = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999
      );
      const weekEnd = new Date();
      weekEnd.setDate(weekEnd.getDate() + 7);

      // 1) Assignments where this student is assigned
      const allAssignments = await Assignment.find({
        "assignments.studentIds": studentId,
      })
        .select("classroomId sessionId teacherId assignments")
        .populate("sessionId", "topic sessionDate sessionUrl classroomId")
        .lean();

      // One-time map for all studentIds referenced
      const idsForLookup = new Set();
      for (const ag of allAssignments) {
        for (const t of ag.assignments || []) {
          for (const sid of t.studentIds || []) idsForLookup.add(String(sid));
        }
      }
      const studentsLookup = idsForLookup.size
        ? await User.find({ _id: { $in: [...idsForLookup] } })
            .select("firstName lastName userName email image _id")
            .lean()
        : [];
      const studentMap = new Map(studentsLookup.map((s) => [String(s._id), s]));

      const todayStr = ymdUTC(new Date());
      const todayAssignments = [];
      const thisWeekAssignments = [];

      for (const ag of allAssignments) {
        for (const task of ag.assignments || []) {
          if (!task?.dueDate) continue;
          if (!task.studentIds?.some((id) => String(id) === studentId))
            continue;

          const dueStr = ymdUTC(task.dueDate);

          // only this parent's kids in the students array
          const filteredIds = (task.studentIds || []).filter((id) =>
            parentChildIds.has(String(id))
          );
          const taskWithStudents = {
            ...task,
            studentId, // the child this snapshot belongs to
            students: filteredIds.map(
              (id) => studentMap.get(String(id)) || { _id: id }
            ),
            studentsCount: filteredIds.length,
            // link the session info from group
            sessionId: ag?.sessionId?._id || ag?.sessionId,
            session:
              typeof ag?.sessionId === "object" ? ag.sessionId : undefined,
          };

          if (dueStr === todayStr) todayAssignments.push(taskWithStudents);
          else thisWeekAssignments.push(taskWithStudents);
        }
      }

      // 2) Classrooms (limit students to this parent's kids)
      const classrooms = await Classroom.find({ studentIds: studentId })
        .select(
          "subject sessions teacherId studentIds settings room dateTime createdAt frequency scope duration lastDate expiryDateTime"
        )
        .populate("subject")
        .populate("teacherId", "firstName lastName email image _id")
        .populate("studentIds", "firstName lastName userName email image _id")
        .lean();

      const classroomIds = classrooms.map((c) => c._id);
      const classroomMap = new Map(classrooms.map((c) => [String(c._id), c]));

      const classmatesByClassroom = classrooms.map((cls) => {
        const studentsLimited = (cls.studentIds || []).filter((st) =>
          parentChildIds.has(String(st._id))
        );
        // if you want classmates too, you can add it back filtered

        return {
          subject: cls.subject,
          teacherId: cls.teacherId,
          dateTime: cls.dateTime,
          frequency: cls.frequency,
          createdAt: cls.createdAt,
          duration: cls.duration,
          lastDate: cls.lastDate,
          expiryDateTime: cls.expiryDateTime,
          settings: cls?.settings,
          scope: cls?.scope,
          students: studentsLimited || [],
        };
      });

      // 3) Today/This week sessions
      const mapSession = (s) => {
        // IMPORTANT: handle both ObjectId and populated classroom doc
        const classroomKey = String(s.classroomId?._id ?? s.classroomId);
        const cls = classroomMap.get(classroomKey);
        return {
          ...s,
          studentId,
          // subject: cls?.subject ?? null,
          students: (cls?.studentIds ?? []).map((st) => st?._id ?? st),
        };
      };

      const [todaySessionsRaw, thisWeekSessionsRaw] = await Promise.all([
        Session.find({
          classroomId: { $in: classroomIds },
          sessionDate: { $gte: startOfDay, $lte: endOfDay },
        })
          .select("_id topic sessionDate sessionUrl classroomId")
          .populate({
            path: "classroomId",
            populate: [
              {
                path: "teacherId",
                select: "firstName lastName email image _id",
              },
              { path: "subject" }, // e.g. select: "name code _id"
            ],
          })

          .lean(),
        Session.find({
          classroomId: { $in: classroomIds },
          sessionDate: { $gte: new Date(), $lte: weekEnd },
        })
          .select("_id topic sessionDate sessionUrl classroomId")
          .populate({
            path: "classroomId",
            populate: [
              {
                path: "teacherId",
                select: "firstName lastName email image _id",
              },
              { path: "subject" }, // e.g. select: "name code _id"
            ],
          })

          .lean(),
      ]);

      const todaySessions = todaySessionsRaw.map(mapSession);
      const thisWeekSessions = thisWeekSessionsRaw.map(mapSession);

      // 4) Submission statuses
      const statuses = await User.find({
        _id: studentId,
        userRole: "student",
      }).lean();
      const completed = statuses.filter(
        (s) => s.isCompleted && !s.isAutoSubmitted
      ).length;
      const autoSubmitted = statuses.filter((s) => s.isAutoSubmitted).length;
      const pending = statuses.filter((s) => !s.isCompleted).length;

      // 5) Graded results
      const gradedSubmissions = await GradedSubmission.find({
        studentId,
      }).lean();
      const avgScore =
        gradedSubmissions.length > 0
          ? Math.round(
              gradedSubmissions.reduce((sum, s) => sum + s.totalScore, 0) /
                gradedSubmissions.length
            )
          : null;

      // 6) Calendar range (prev 1 month → next 2 months)
      const now2 = new Date();
      const rangeStart = new Date(now2);
      rangeStart.setMonth(rangeStart.getMonth() - 1);
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(now2);
      rangeEnd.setMonth(rangeEnd.getMonth() + 2);
      rangeEnd.setHours(23, 59, 59, 999);

      // A) Class events
      const classEvents = [];
      for (const cls of classrooms) {
        if (!cls?.dateTime) continue;

        const durationMin = Number(cls?.duration) || 60;
        const freq = String(cls?.frequency || "once").toLowerCase();
        const hardStop = new Date(
          Math.min(
            rangeEnd.getTime(),
            cls?.expiryDateTime
              ? new Date(cls.expiryDateTime).getTime()
              : rangeEnd.getTime(),
            cls?.lastDate
              ? new Date(cls.lastDate).getTime()
              : rangeEnd.getTime()
          )
        );

        const pushClassEvent = (start) => {
          const end = addMinutes(start, durationMin);
          if (end >= rangeStart && start <= rangeEnd) {
            classEvents.push({
              id: cls._id,
              studentId,
              type: "class",
              title: cls?.settings?.room ? cls.settings.room : "Class",
              start,
              end,
              allDay: false,
              students:
                (cls.studentIds || []).filter((st) =>
                  parentChildIds.has(String(st._id))
                ) || [],
            });
          }
        };

        if (!["daily", "weekly", "biweekly", "monthly"].includes(freq)) {
          pushClassEvent(new Date(cls.dateTime));
        } else {
          let cursor = new Date(cls.dateTime);
          while (cursor < rangeStart) {
            const next = incByFrequency(cursor, freq);
            if (!next || next <= cursor) break;
            cursor = next;
            if (cursor > hardStop) break;
          }
          let safety = 0;
          while (cursor <= hardStop && safety < 500) {
            safety++;
            pushClassEvent(new Date(cursor));
            const next = incByFrequency(cursor, freq);
            if (!next || next <= cursor) break;
            cursor = next;
          }
        }
      }

      // B) Session events
      const calendarSessions = await Session.find({
        classroomId: { $in: classrooms.map((c) => c._id) },
        sessionDate: { $gte: rangeStart, $lte: rangeEnd },
      })
        .select("_id topic sessionDate classroomId duration")
        .lean();

      const sessionEvents = calendarSessions
        .map((s) => {
          const classroomKey = String(s.classroomId?._id ?? s.classroomId);
          const cls = classroomMap.get(classroomKey);
          const start = new Date(s.sessionDate);
          const dur =
            Number(s?.duration) > 0
              ? Number(s.duration)
              : Number(cls?.duration) || 60;
          return {
            id: s._id,
            _id: s._id, // keep both for robust keys later
            studentId,
            type: "session",
            title: s.topic || "Session",
            start,
            end: addMinutes(start, dur),
            allDay: false,
            classroomId: s.classroomId,
            subject: cls?.subject ?? null,
            students:
              (cls?.studentIds || []).filter((st) =>
                parentChildIds.has(String(st._id))
              ) || [],
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);

      // C) Assignment deadline events (filter students to parent's kids)
      const assignmentEvents = [];
      for (const group of allAssignments) {
        for (const task of group.assignments || []) {
          if (!task?.dueDate) continue;
          const isMine = (task.studentIds || []).some(
            (id) => String(id) === studentId
          );
          if (!isMine) continue;

          const due = new Date(task.dueDate);
          if (due >= rangeStart && due <= rangeEnd) {
            const start = new Date(due.setHours(0, 0, 0, 0));
            const end = new Date(due.setHours(23, 59, 59, 999));

            const filteredIds = (task.studentIds || []).filter((id) =>
              parentChildIds.has(String(id))
            );

            assignmentEvents.push({
              id: group._id,
              studentId,
              type: "assignment",
              title: task?.title || "Assignment Deadline",
              description: task?.description,
              assignmentStatus: task?.assignmentStatus,
              sessionId: group?.sessionId?._id || group?.sessionId,
              session:
                typeof group?.sessionId === "object"
                  ? group.sessionId
                  : undefined,
              students: filteredIds.map(
                (id) => studentMap.get(String(id)) || { _id: id }
              ),
              start,
              end,
              allDay: true,
            });
          }
        }
      }

      const calendarEvents = [
        ...classEvents,
        ...sessionEvents,
        ...assignmentEvents,
      ].sort((a, b) => new Date(a.start) - new Date(b.start));

      // Buckets for assignmentDeadlines (filter students to parent's kids)
      const todayKey = ymdUTC(new Date());
      const todayIdx = dayIndex(todayKey);
      const _buckets = { today: [], past15Days: [], upcoming30Days: [] };

      for (const group of allAssignments || []) {
        const tasks = Array.isArray(group.assignments) ? group.assignments : [];
        for (const t of tasks) {
          if (!t?.dueDate) continue;
          const list = Array.isArray(t.studentIds) ? t.studentIds : [];
          if (!list.some((id) => String(id) === studentId)) continue;

          const dueKey = ymdUTC(t.dueDate);
          const dueIdx = dayIndex(dueKey);
          const diff = dueIdx - todayIdx;

          const filteredIds = list.filter((sid) =>
            parentChildIds.has(String(sid))
          );

          const item = {
            id: t?._id || `${group._id}:${dueKey}`,
            title: t?.title || "Assignment Deadline",
            dueAt: new Date(t.dueDate).toISOString(),
            allDay: true,
            course: t?.course || null,
            topic: t?.topic || null,
            classroomId: group?.classroomId || null,
            sessionId: group?.sessionId?._id || group?.sessionId,
            session:
              typeof group?.sessionId === "object"
                ? group.sessionId
                : undefined,
            teacherId: group?.teacherId || null,
            students: filteredIds.map(
              (sid) => studentMap.get(String(sid)) || { _id: sid }
            ),
            studentsCount: filteredIds.length,
            studentId,
          };

          if (diff === 0) _buckets.today.push(item);
          else if (diff < 0 && diff >= -15) _buckets.past15Days.push(item);
          else if (diff > 0 && diff <= 30) _buckets.upcoming30Days.push(item);
        }
      }

      const byDueAsc = (a, b) => new Date(a.dueAt) - new Date(b.dueAt);
      _buckets.today.sort(byDueAsc);
      _buckets.past15Days.sort(byDueAsc);
      _buckets.upcoming30Days.sort(byDueAsc);

      const assignmentDeadlines = {
        today: { count: _buckets.today.length, items: _buckets.today },
        past15Days: {
          count: _buckets.past15Days.length,
          items: _buckets.past15Days,
        },
        upcoming30Days: {
          count: _buckets.upcoming30Days.length,
          items: _buckets.upcoming30Days,
        },
      };

      return {
        student: studentDoc,
        classClalender: classmatesByClassroom,
        assignmentDeadlines,
        todayAssignments, // filtered students per parent
        thisWeekAssignments, // filtered students per parent
        todaySessions,
        thisWeekSessions,
        allAssignments, // raw groups (still fine)
        submissionStatuses: statuses,
        reports: {
          averageScore:
            avgScore !== null ? avgScore : "No submissions graded yet",
          completedAssignments: completed,
          autoSubmittedAssignments: autoSubmitted,
          pendingAssignments: pending,
        },
        calendar: {
          rangeStart,
          rangeEnd,
          counts: {
            classes: classEvents.length,
            sessions: sessionEvents.length,
            assignments: assignmentEvents.length,
          },
          events: calendarEvents,
        },
      };
    };

    // 2) Build per-child in parallel
    const perChild = await Promise.all(
      children.map((s) => buildStudentSnapshot(s, parentChildIds))
    );

    // 3) Merge for top-level (all children)
    let mergedRangeStart = null;
    let mergedRangeEnd = null;
    let mergedEvents = [];
    let totalClasses = 0,
      totalSessions = 0,
      totalAssignments = 0;

    const mergedTodayAssignments = [];
    const mergedThisWeekAssignments = [];
    const mergedTodaySessions = [];
    const mergedThisWeekSessions = [];
    const mergedAllAssignments = [];
    const mergedSubmissionStatuses = [];
    let mergedCompleted = 0;
    let mergedAutoSubmitted = 0;
    let mergedPending = 0;
    const numericAverages = [];

    const mergedAD = { today: [], past15Days: [], upcoming30Days: [] };

    for (const snap of perChild) {
      if (snap.calendar?.rangeStart) {
        if (
          !mergedRangeStart ||
          new Date(snap.calendar.rangeStart) < new Date(mergedRangeStart)
        ) {
          mergedRangeStart = snap.calendar.rangeStart;
        }
      }
      if (snap.calendar?.rangeEnd) {
        if (
          !mergedRangeEnd ||
          new Date(snap.calendar.rangeEnd) > new Date(mergedRangeEnd)
        ) {
          mergedRangeEnd = snap.calendar.rangeEnd;
        }
      }
      totalClasses += snap.calendar?.counts?.classes ?? 0;
      totalSessions += snap.calendar?.counts?.sessions ?? 0;
      totalAssignments += snap.calendar?.counts?.assignments ?? 0;
      mergedEvents = mergedEvents.concat(snap.calendar?.events ?? []);

      mergedTodayAssignments.push(...(snap.todayAssignments ?? []));
      mergedThisWeekAssignments.push(...(snap.thisWeekAssignments ?? []));
      mergedTodaySessions.push(...(snap.todaySessions ?? []));
      mergedThisWeekSessions.push(...(snap.thisWeekSessions ?? []));

      const sid = String(snap.student?._id || "");
      (snap.allAssignments ?? []).forEach((grp) =>
        mergedAllAssignments.push({ ...grp, _forStudentId: sid })
      );

      mergedSubmissionStatuses.push(...(snap.submissionStatuses ?? []));
      mergedCompleted += snap.reports?.completedAssignments ?? 0;
      mergedAutoSubmitted += snap.reports?.autoSubmittedAssignments ?? 0;
      mergedPending += snap.reports?.pendingAssignments ?? 0;

      const avg = snap.reports?.averageScore;
      if (typeof avg === "number") numericAverages.push(avg);

      if (snap.assignmentDeadlines?.today?.items?.length)
        mergedAD.today.push(...snap.assignmentDeadlines.today.items);
      if (snap.assignmentDeadlines?.past15Days?.items?.length)
        mergedAD.past15Days.push(...snap.assignmentDeadlines.past15Days.items);
      if (snap.assignmentDeadlines?.upcoming30Days?.items?.length)
        mergedAD.upcoming30Days.push(
          ...snap.assignmentDeadlines.upcoming30Days.items
        );
    }

    // ---- SESSION DE-DUPLICATION (merge step) ----
    const dedupeSessionsAndMergeStudents = (items) => {
      const byKey = new Map();
      for (const s of items || []) {
        // build a robust key
        const sid = s?._id || s?.id;
        const classroomKey =
          s?.classroomId?._id || s?.classroomId || s?.classroom?._id || "";
        const when = s?.sessionDate || s?.start || s?.date || s?.time || "";
        const key = sid
          ? String(sid)
          : `${String(classroomKey)}|${
              when ? new Date(when).toISOString() : ""
            }`;

        const prev = byKey.get(key);

        // merge students arrays (unique ids)
        const prevIds = (prev?.students ?? []).map((st) =>
          String(st?._id ?? st)
        );
        const curIds = (s?.students ?? []).map((st) => String(st?._id ?? st));
        const uniqIds = Array.from(new Set([...prevIds, ...curIds]));

        // pick first-seen full objects
        const pick = new Map(
          [...(prev?.students ?? []), ...(s?.students ?? [])].map((st) => [
            String(st?._id ?? st),
            st,
          ])
        );
        const mergedStudents = uniqIds.map((id) => pick.get(id) ?? { _id: id });

        byKey.set(key, { ...(prev || s), students: mergedStudents });
      }
      return [...byKey.values()];
    };

    // De-dupe merged session arrays across children
    const dedupedTodaySessions =
      dedupeSessionsAndMergeStudents(mergedTodaySessions);
    const dedupedThisWeekSessions = dedupeSessionsAndMergeStudents(
      mergedThisWeekSessions
    );

    // De-dupe calendar "session" events across children
    const calSessions = dedupeSessionsAndMergeStudents(
      (mergedEvents || []).filter((e) => e?.type === "session")
    );

    // Keep class/assignment events as-is
    const calNonSessions = (mergedEvents || []).filter(
      (e) => e?.type !== "session"
    );

    // Rebuild mergedEvents with unique sessions
    mergedEvents = [...calNonSessions, ...calSessions].sort(
      (a, b) => new Date(a.start) - new Date(b.start)
    );

    // --------------------------------------------

    const assignmentDeadlines = {
      today: {
        count: mergedAD.today.length,
        items: mergedAD.today.sort(
          (a, b) => new Date(a.dueAt) - new Date(b.dueAt)
        ),
      },
      past15Days: {
        count: mergedAD.past15Days.length,
        items: mergedAD.past15Days.sort(
          (a, b) => new Date(a.dueAt) - new Date(b.dueAt)
        ),
      },
      upcoming30Days: {
        count: mergedAD.upcoming30Days.length,
        items: mergedAD.upcoming30Days.sort(
          (a, b) => new Date(a.dueAt) - new Date(b.dueAt)
        ),
      },
    };

    const mergedAverageScore =
      numericAverages.length > 0
        ? Math.round(
            numericAverages.reduce((s, n) => s + n, 0) / numericAverages.length
          )
        : "No submissions graded yet";

    // FINAL
    return res.status(200).json({
      parent,
      children,
      perChild,

      // Top-level merged fields (sessions arrays are de-duped)
      assignmentDeadlines,
      todayAssignments: mergedTodayAssignments,
      thisWeekAssignments: mergedThisWeekAssignments,
      todaySessions: dedupedTodaySessions,
      thisWeekSessions: dedupedThisWeekSessions,
      allAssignments: mergedAllAssignments,
      submissionStatuses: mergedSubmissionStatuses,
      reports: {
        averageScore: mergedAverageScore,
        completedAssignments: mergedCompleted,
        autoSubmittedAssignments: mergedAutoSubmitted,
        pendingAssignments: mergedPending,
      },

      calendar: {
        rangeStart: mergedRangeStart,
        rangeEnd: mergedRangeEnd,
        counts: {
          classes: totalClasses,
          sessions: calSessions.length, // ✅ unique sessions count
          assignments: totalAssignments,
        },
        events: mergedEvents, // ✅ sessions de-duped
      },

      success: true,
    });
  } catch (err) {
    console.error("Parent dashboard error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
