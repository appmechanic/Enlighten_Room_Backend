import Assignment from "../models/AssignmentModel.js";
import Classroom from "../models/classroomModel.js";
import GradedSubmission from "../models/GradedSubmissionModel.js";
import Session from "../models/SessionModel.js";
import Student from "../models/studentModel.js";
import Teacher from "../models/teacherModel.js";
import transactionModel from "../models/transactionModel.js";
import User from "../models/user.js";
import { addSendEmail } from "../utils/addSendEmail.js";

// Create new teacher
// export const createTeacher = async (req, res) => {
//   try {
//     const newTeacher = new Teacher(req.body);
//     await newTeacher.save();
//     res.status(201).json(newTeacher);
//   } catch (error) {
//     console.log(error);
//     res.status(400).json({ error: error.message });
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
export const createTeacher = async (req, res) => {
  try {
    const { email, password, firstName, lastName, ...rest } = req.body;

    // ✅ Check if email format is valid and has no spaces
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
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
      userRole: "teacher",
      userName,
      firstName,
      lastName,
      // teacherId:
      is_verified: true,
      ...rest,
    });
    // // Create Teacher-specific record
    // const teacher = new Teacher({
    //   userId: user._id,
    //   email,
    //   password,
    //   userName,
    //   firstName,
    //   lastName,
    //   is_verified: true,
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
    // user.teacherId = teacher._id;
    // await user.save();
    // await addSendEmail(email, "Your Enlighten Room Account", html);
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

    // await teacher.save();

    res
      .status(201)
      .json({ message: "Teacher created successfully", populatedUser });
  } catch (error) {
    console.log(error.message);
    res.status(400).json({ error: error.message });
  }
};

// Get all teachers
export const getAllTeachers = async (req, res) => {
  try {
    const teachers = await User.find({ userRole: "teacher" }).select(
      "image firstName lastName userName email phone userRole city province is_active is_verified country language settings"
    );
    res.json(teachers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Get teacher by ID
export const getTeacherByUid = async (req, res) => {
  try {
    const { userId } = req.params;
    const teacher = await User.findOne({
      _id: userId,
      userRole: "teacher",
    }).select(
      "image firstName lastName userName email phone userRole city province  country language settings"
    );
    if (!teacher) return res.status(404).json({ message: "Teacher not found" });
    res.json(teacher);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update teacher by UID
export const updateTeacher = async (req, res) => {
  try {
    const disallowedFields = [
      "email",
      "userName",
      "userRole",
      "password",
      "is_verified",
      "isAdmin",
      "referedBy",
    ];

    disallowedFields.forEach((field) => delete req.body[field]);

    if (req.file) {
      console.log(req.file);
      req.body.image = req.file.path;
    }
    // const { id } = req.params;
    // const users = await User.find({ email: req.body.email });
    // if (users.length > 0) {
    //   return res
    //     .status(409)
    //     .json({ error: "Teacher with this email already registered" });
    // }

    const updated = await User.findOneAndUpdate(
      { _id: req.params.id, userRole: "teacher" },
      req.body,
      {
        new: true,
      }
    ).select(
      "firstName lastName userName email userRole settings image phone city province "
    );
    if (!updated) return res.status(404).json({ message: "Teacher not found" });
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Delete teacher by UID
export const deleteTeacher = async (req, res) => {
  try {
    const deleted = await User.findOneAndDelete({
      _id: req.params.id,
      userRole: "teacher",
    });

    if (!deleted) return res.status(404).json({ message: "Teacher not found" });
    if (deleted.userId) {
      await User.findByIdAndDelete(deleted.userId);
    }
    res.json({ message: "Teacher deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ---- date helpers ----
const atStart = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const atEnd = (d) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const inRange = (d, a, b) => d >= a && d <= b;
const byDue = (a, b) => new Date(a.dueAt) - new Date(b.dueAt);

// Dashboard
export const getTeacherDashboard = async (req, res) => {
  try {
    const { teacherId } = req.params;

    if (!teacherId) {
      return res.status(400).json({ error: "Teacher ID is required." });
    }

    const teacher = await User.findOne({ _id: teacherId, userRole: "teacher" })
      .select(
        "image firstName lastName userName email phone userRole city country language fullAddress settings streetAddress province  zip state"
      )
      .lean();
    if (!teacher) {
      return res.status(404).json({ error: "Teacher not found." });
    }

    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    const endOfDay = new Date(now.setHours(23, 59, 59, 999));
    const weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);

    // ✅ 1. Find classrooms assigned to the teacher
    const classrooms = await Classroom.find({ teacherId })
      .populate({
        path: "studentIds",
        select: "firstName lastName username email age country city parentId",
        populate: {
          path: "parentId",
          select: "firstName lastName email userId country city",
        },
      })
      .populate(
        "teacherId",
        "firstName lastName username email phone gender zip streetAddress state province fullAddress city"
      )
      .populate("subject", "_id name code classLevel")
      .populate("sessions");
    const classroomIds = classrooms.map((c) => c._id);

    const classroomMap = new Map(classrooms.map((c) => [String(c._id), c]));

    // ✅ 2. Today's Sessions (by classroom)
    const todaySessions = await Session.find({
      classroomId: { $in: classroomIds },
      sessionDate: { $gte: startOfDay, $lte: endOfDay },
    })
      .populate({
        path: "classroomId",
        populate: {
          path: "subject",
        },
      })
      .lean();

    // ✅ 3. This Week's Sessions (by classroom)
    const thisWeekSessions = await Session.find({
      classroomId: { $in: classroomIds },
      sessionDate: { $gte: new Date(), $lte: weekEnd },
    })
      .populate("classroomId")
      .lean();

    // ✅ 4. All Assignments Created by this Teacher
    const allAssignments = await Assignment.find({ teacherId })
      .populate({
        path: "classroomId",
        select:
          "teacherId studentIds dateTime scope remarks settings expiryDateTime lastDate duration",
        populate: [
          {
            path: "teacherId",
            select:
              "firstName lastName username email phone gender zip streetAddress state province  fullAddress city",
          },

          {
            path: "studentIds",
            select:
              "firstName lastName username email age country city parentId",
            populate: {
              path: "parentId",
              select: "firstName lastName email userId country city",
            },
          },

          {
            path: "subject",
            select: "_id name code classLevel",
          },
        ],
      })
      .populate("sessionId")
      // .populate("sessionId")
      .lean();

    // ✅ 5. Submission Statuses (accurate model)
    const statuses = await User.find({ teacherId }).lean();

    // ✅ 6. Grade Summary
    const graded = await GradedSubmission.find({ teacherId }).lean();
    const avgScore =
      graded.length > 0
        ? Math.round(
            graded.reduce((sum, g) => sum + g.totalScore, 0) / graded.length
          )
        : null;

    // =========================================================
    // NEW: Calendar data (prev 1 month → next 2 months)
    // =========================================================
    const now2 = new Date();
    const rangeStart = new Date(now2);
    rangeStart.setMonth(rangeStart.getMonth() - 1);
    rangeStart.setHours(0, 0, 0, 0);

    const rangeEnd = new Date(now2);
    rangeEnd.setMonth(rangeEnd.getMonth() + 2);
    rangeEnd.setHours(23, 59, 59, 999);

    // tiny helpers
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
      else return null; // once
      return d;
    };

    // A) CLASS EVENTS from classrooms (expand simple recurrence)
    const classEvents = [];
    for (const cls of classrooms) {
      const startDate = cls?.dateTime ? new Date(cls.dateTime) : null;
      if (!startDate) continue;

      const durationMin = Number(cls?.duration) || 60;
      const freq = String(cls?.frequency || "once").toLowerCase();
      const hardStop = new Date(
        Math.min(
          rangeEnd.getTime(),
          cls?.expiryDateTime
            ? new Date(cls.expiryDateTime).getTime()
            : rangeEnd.getTime(),
          cls?.lastDate ? new Date(cls.lastDate).getTime() : rangeEnd.getTime()
        )
      );

      // once
      if (!["daily", "weekly", "biweekly", "monthly"].includes(freq)) {
        const s = startDate;
        const e = addMinutes(s, durationMin);
        if (e >= rangeStart && s <= rangeEnd) {
          classEvents.push({
            id: cls._id,
            type: "class",
            title: cls?.settings?.room
              ? `Class • ${cls.settings.room}`
              : "Class",
            start: s,
            end: e,
            allDay: false,
          });
        }
      } else {
        // recurring
        let cursor = new Date(startDate);
        while (cursor < rangeStart) {
          const next = incByFrequency(cursor, freq);
          if (!next || next <= cursor) break;
          cursor = next;
          if (cursor > hardStop) break;
        }
        let safety = 0;
        while (cursor <= hardStop && safety < 500) {
          safety++;
          const s = new Date(cursor);
          const e = addMinutes(s, durationMin);
          if (e >= rangeStart && s <= rangeEnd) {
            classEvents.push({
              id: cls._id,
              type: "class",
              dateTime: cls.dateTime,
              duration: cls.duration,
              frequency: cls.frequency,
              settings: cls.settings,
              title: cls?.settings?.room ? cls.settings.room : "Class",
              start: s,
              end: e,
              allDay: false,
            });
          }
          const next = incByFrequency(cursor, freq);
          if (!next || next <= cursor) break;
          cursor = next;
        }
      }
    }

    // B) SESSION EVENTS (for full calendar range)
    const calendarSessions = await Session.find({
      classroomId: { $in: classroomIds },
      sessionDate: { $gte: rangeStart, $lte: rangeEnd },
    })
      .select("_id title sessionDate duration classroomId status sessionUrl")
      .lean();

    // console.log("calendarSessions", calendarSessions);

    const sessionEvents = calendarSessions.map((s) => {
      const sDate = new Date(s.sessionDate);

      const cls = classroomMap.get(String(s.classroomId));
      console.log("cls for session", s._id, cls);
      const className =
        cls?.settings?.room || // e.g., “Room A-101”
        cls?.subject?.name || // e.g., “Algebra”
        cls?.subject?.code || // e.g., “MATH-101”
        "Class";

      return {
        id: s._id,
        type: "session",
        title: s.title || "Session",
        start: sDate,
        sessionUrl: s.sessionUrl,
        classroomId: s.classroomId,
        className,
        end: addMinutes(sDate, Number(s.duration) || 60),
        allDay: false,
      };
    });

    const getClassName = (cls) =>
      cls?.settings?.room ||
      cls?.subject?.name ||
      cls?.subject?.code ||
      "Class";
    // C) ASSIGNMENT DEADLINES (from allAssignments already fetched)
    const assignmentEvents = [];
    for (const group of allAssignments) {
      // session may be populated or just an ObjectId
      const sess =
        group?.sessionId && typeof group.sessionId === "object"
          ? group.sessionId
          : null;

      // decide which classroom to use to compute className
      const classroomIdForSession =
        (sess?.classroomId && String(sess.classroomId)) ||
        (group?.classroomId?._id && String(group.classroomId._id)) ||
        (group?.classroomId && String(group.classroomId)) ||
        null;

      const cls = classroomIdForSession
        ? classroomMap.get(String(classroomIdForSession))
        : null;

      const className = getClassName(cls);

      for (const task of group.assignments || []) {
        if (!task?.dueDate) continue;
        const due = new Date(task.dueDate);
        if (due >= rangeStart && due <= rangeEnd) {
          const start = new Date(due.setHours(0, 0, 0, 0));
          const end = new Date(due.setHours(23, 59, 59, 999));
          assignmentEvents.push({
            id: group?._id,
            type: "assignment",
            description: task?.description || "",
            title: task?.title || "Assignment Deadline",
            // session: group?.sessionId,
            start,
            end,
            allDay: true,
            // keep raw id for backward compatibility
            // sessionId: sess?._id || group?.sessionId || null,

            // ✅ full embedded session details (when populated)
            session: sess
              ? {
                  _id: sess._id,
                  title: sess.title,
                  status: sess.status,
                  sessionUrl: sess.sessionUrl,
                  sessionDate: sess.sessionDate,
                  duration: sess.duration,
                  classroomId: sess.classroomId,
                  className, // ✅ requested
                }
              : null,

            // also expose at top-level if you want easy filtering/grouping
            // classroomId: classroomIdForSession,
            // className,
          });
        }
      }
    }

    // Combine + sort
    const calendarEvents = [
      ...classEvents,
      ...sessionEvents,
      ...assignmentEvents,
    ].sort((a, b) => new Date(a.start) - new Date(b.start));

    const _now = new Date();
    const _todayStart = new Date(
      _now.getFullYear(),
      _now.getMonth(),
      _now.getDate()
    );
    const _todayEnd = new Date(
      _now.getFullYear(),
      _now.getMonth(),
      _now.getDate(),
      23,
      59,
      59,
      999
    );
    const _pastStart = new Date(_todayStart);
    _pastStart.setDate(_pastStart.getDate() - 15);
    const _pastEnd = new Date(_todayStart.getTime() - 1);
    const _upStart = new Date(_todayEnd.getTime() + 1);
    const _upEnd = new Date(_todayEnd);
    _upEnd.setDate(_upEnd.getDate() + 30);

    const _buckets = { today: [], past15Days: [], upcoming30Days: [] };

    for (const group of allAssignments || []) {
      const tasks = Array.isArray(group.assignments) ? group.assignments : [];
      for (const t of tasks) {
        if (!t || !t.dueDate) continue;

        // If you're in the STUDENT dashboard, keep this guard:
        // (remove it in Teacher dashboard)
        if (typeof studentId !== "undefined") {
          const list = Array.isArray(t.studentIds) ? t.studentIds : [];
          const isMine = list.some((id) => String(id) === String(studentId));
          if (!isMine) continue;
        }

        const due = new Date(t.dueDate);
        if (isNaN(due)) continue;

        // Minimal merged data (only what you already have)
        const item = {
          id: t._id || `${group._id}:${due.getTime()}`,
          title: t?.title || "Assignment Deadline",
          description: t?.description,
          assignmentStatus: t?.assignmentStatus,
          session: group?.sessionId,
          dueAt: due.toISOString(),
          allDay: true,

          // merged fields (will be ObjectIds if you didn't populate)
          course: t?.course || null,
          topic: t?.topic || null,
          classroomId: group.classroomId || null,
          teacherId: group.teacherId || null,

          // audience
          students: (Array.isArray(t.studentIds) ? t.studentIds : []).map((s) =>
            s?.toString ? s.toString() : String(s)
          ),
          studentsCount: Array.isArray(t.studentIds) ? t.studentIds.length : 0,
        };

        if (due >= _todayStart && due <= _todayEnd) {
          _buckets.today.push(item);
        } else if (due >= _pastStart && due <= _pastEnd) {
          _buckets.past15Days.push(item);
        } else if (due >= _upStart && due <= _upEnd) {
          _buckets.upcoming30Days.push(item);
        }
      }
    }

    // optional: sort by due date
    _buckets.today.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    _buckets.past15Days.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    _buckets.upcoming30Days.sort(
      (a, b) => new Date(a.dueAt) - new Date(b.dueAt)
    );

    // final object to include in your res.json
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

    const transactions = await transactionModel
      .find({ teacherId })
      .populate("planId");

    res.status(200).json({
      teacher,
      classrooms,
      assignmentDeadlines,
      todaySessions,
      thisWeekSessions,
      allAssignments,
      transactions,
      assignmentStats: {
        totalAssignments: allAssignments.length,
        totalSessions: todaySessions.length + thisWeekSessions.length,
        submissionsTracked: statuses.length,
        averageScore: avgScore !== null ? avgScore : "No grades yet",
      },
      // NEW: Month/Week/Day-ready calendar payload
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
    });
  } catch (err) {
    console.error("Teacher Dashboard Error:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
