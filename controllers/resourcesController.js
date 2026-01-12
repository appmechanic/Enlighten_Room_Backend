import Classroom from "../models/classroomModel.js";
import Assignment from "../models/AssignmentModel.js";

// tiny safe array helper
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// normalize a file entry (string URL or object with url/path/href)
const normalizeFile = (f) => {
  if (!f) return null;
  if (typeof f === "string") return { url: f, name: "file" };
  const url = f.url || f.path || f.href || f.key || null;
  if (!url) return null;
  return {
    url,
    name: f.name || "file",
    mime: f.mime || f.mimetype || null,
    size: f.size || null,
  };
};

// unify item shape
const mkItem = ({ file, createdAt, sourceType, ctx }) => {
  const nf = normalizeFile(file);
  if (!nf) return null;
  return {
    id: ctx.id,
    title: nf.name,
    url: nf.url,
    mime: nf.mime || null,
    size: nf.size || null,
    createdAt: new Date(createdAt || Date.now()).toISOString(),
    sourceType, // "classroom" | "assignment"
    context: ctx, // minimal related data
  };
};

// dedupe by url + source + context.id
const dedupe = (items) => {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = `${it.url}::${it.sourceType}::${it.context?.id || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
};

/**
 * STUDENT: GET /api/resources/student/:studentId
 * Pulls classroom resources where student belongs,
 * plus assignment resources (assignment.resources OR per-task resources)
 * that are either in those classrooms OR directly assigned to the student.
 */
export const getStudentResources = async (req, res) => {
  try {
    const { studentId } = req.params;
    if (!studentId) {
      return res.status(400).json({ error: "Student ID is required." });
    }

    // pagination controls
    const page = Math.max(parseInt(req.query.page || "1", 10), 1); // others
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1); // others
    const prevPage = Math.max(parseInt(req.query.prevPage || "1", 10), 1); // previous
    const prevLimit = Math.max(parseInt(req.query.prevLimit || "20", 10), 1); // previous

    // window sizes
    const RECENT_COUNT = 10;
    const PREVIOUS_COUNT = 150;

    // 1) Classrooms the student belongs to
    const classrooms = await Classroom.find({ studentIds: studentId })
      .select(
        "_id subject teacherId subject resources settings updatedAt createdAt title"
      )
      .populate("subject")
      .lean();
    const classroomIds = classrooms.map((c) => c._id);

    // 2) Assignments: in student classrooms OR directly assigned to student
    const assignments = await Assignment.find({
      $or: [
        { classroomId: { $in: classroomIds } },
        { "assignments.studentIds": studentId },
      ],
    })
      .select(
        "_id title classroomId teacherId subject resources assignments updatedAt createdAt"
      )
      // .populate("subject")
      .lean();

    const items = [];

    // 3) Classroom-level resources
    for (const c of classrooms) {
      const files = [...arr(c.resources), ...arr(c?.settings?.resources)];
      for (const f of files) {
        const item = mkItem({
          file: f,
          createdAt: c.updatedAt || c.createdAt,
          sourceType: "classroom",
          ctx: {
            id: String(c._id),
            title: c.title || "Classroom",
            classroomId: String(c._id),
            subject: c.subject || null,
            teacherId: c.teacherId || null,
          },
        });
        if (item) items.push(item);
      }
    }

    // 4) Assignment-level resources (top-level + per-task)
    for (const a of assignments) {
      for (const f of arr(a.resources)) {
        const item = mkItem({
          file: f,
          createdAt: a.updatedAt || a.createdAt,
          sourceType: "assignment",
          ctx: {
            id: String(a._id),
            title: a.title || "Assignment",
            assignmentId: String(a._id),
            classroomId: a.classroomId || null,
            subject: a.subject || null,
            teacherId: a.teacherId || null,
          },
        });
        if (item) items.push(item);
      }

      for (const t of arr(a.assignments)) {
        for (const f of arr(t.resources)) {
          const item = mkItem({
            file: f,
            createdAt: t.updatedAt || t.dueDate || a.updatedAt || a.createdAt,
            sourceType: "assignment",
            ctx: {
              id: String(a._id),
              title: t.title || a.title || "Assignment Task",
              assignmentId: String(a._id),
              taskId: t._id || null,
              classroomId: a.classroomId || null,
              subject: a.subject || null,
              teacherId: a.teacherId || null,
              topic: t.topic || null,
              course: t.course || null,
            },
          });
          if (item) items.push(item);
        }
      }
    }

    // 5) Deduplicate + sort newest → oldest
    const all = dedupe(items).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const totalCount = all.length;

    // 6) Buckets
    const recentItems = all.slice(0, RECENT_COUNT);

    // previous window (next 150) with pagination
    const previousWindowEnd = Math.min(
      RECENT_COUNT + PREVIOUS_COUNT,
      totalCount
    );
    const previousAll = all.slice(RECENT_COUNT, previousWindowEnd);
    const previousTotal = previousAll.length;
    const previousTotalPages = Math.max(
      Math.ceil(previousTotal / prevLimit),
      1
    );
    const previousStart = (prevPage - 1) * prevLimit;
    const previousItems = previousAll.slice(
      previousStart,
      previousStart + prevLimit
    );

    // others (everything after the previous window) with pagination
    const othersAll = all.slice(previousWindowEnd);
    const othersTotal = othersAll.length;
    const othersTotalPages = Math.max(Math.ceil(othersTotal / limit), 1);
    const othersStart = (page - 1) * limit;
    const paginatedOthers = othersAll.slice(othersStart, othersStart + limit);

    // 7) Response (same structure as teacher)
    res.json({
      success: true,
      totalCount,

      recent: {
        count: recentItems.length,
        items: recentItems,
      },

      previous: {
        windowCount: previousTotal,
        currentPage: prevPage,
        perPage: prevLimit,
        totalPages: previousTotalPages,
        hasPrev: prevPage > 1,
        hasNext: prevPage < previousTotalPages,
        items: previousItems,
      },

      others: {
        count: othersTotal,
        currentPage: page,
        perPage: limit,
        totalPages: othersTotalPages,
        hasPrev: page > 1,
        hasNext: page < othersTotalPages,
        items: paginatedOthers,
      },
    });
  } catch (err) {
    console.error("getStudentResources error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * TEACHER: GET /api/resources/teacher/:teacherId
 * Pulls classroom resources for the teacher’s classrooms,
 * plus assignment resources created by the teacher.
 */
export const getTeacherResources = async (req, res) => {
  try {
    const { teacherId } = req.params;
    if (!teacherId)
      return res.status(400).json({ error: "Teacher ID is required." });

    // pagination for "previous" and "others"
    const page = Math.max(parseInt(req.query.page || "1", 10), 1); // others
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1); // others
    const prevPage = Math.max(parseInt(req.query.prevPage || "1", 10), 1); // previous
    const prevLimit = Math.max(parseInt(req.query.prevLimit || "20", 10), 1); // previous

    // constants for recent/previous buckets
    const RECENT_COUNT = 10;
    const PREVIOUS_COUNT = 150;

    const classrooms = await Classroom.find({ teacherId })
      .select(
        "_id subject teacherId resources scope remarks settings updatedAt createdAt title"
      )
      .populate("subject")
      .lean();

    const assignments = await Assignment.find({ teacherId })
      .select(
        "_id title classroomId teacherId subject resources assignments updatedAt createdAt"
      )
      .lean();

    const items = [];

    // Classroom-level
    for (const c of classrooms) {
      const files = [...arr(c.resources), ...arr(c?.settings?.resources)];
      for (const f of files) {
        const item = mkItem({
          file: f,
          createdAt: c.updatedAt || c.createdAt,
          sourceType: "classroom",
          ctx: {
            id: String(c._id),
            title: c.title || "Classroom",
            classroomId: String(c._id),
            subject: c.subject || null,
            teacherId,
          },
        });
        if (item) items.push(item);
      }
    }

    // Assignment-level (top + per-task)
    for (const a of assignments) {
      for (const f of arr(a.resources)) {
        const item = mkItem({
          file: f,
          createdAt: a.updatedAt || a.createdAt,
          sourceType: "assignment",
          ctx: {
            id: String(a._id),
            title: a.title || "Assignment",
            assignmentId: String(a._id),
            classroomId: a.classroomId || null,
            subject: a.subject || null,
            teacherId,
          },
        });
        if (item) items.push(item);
      }

      for (const t of arr(a.assignments)) {
        for (const f of arr(t.resources)) {
          const item = mkItem({
            file: f,
            createdAt: t.updatedAt || t.dueDate || a.updatedAt || a.createdAt,
            sourceType: "assignment",
            ctx: {
              id: String(a._id),
              title: t.title || a.title || "Assignment Task",
              assignmentId: String(a._id),
              taskId: t._id || null,
              classroomId: a.classroomId || null,
              subject: a.subject || null,
              teacherId,
              topic: t.topic || null,
              course: t.course || null,
            },
          });
          if (item) items.push(item);
        }
      }
    }

    // Deduplicate + sort newest → oldest
    const all = dedupe(items).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    const totalCount = all.length;

    // Recent (fixed)
    const recentItems = all.slice(0, RECENT_COUNT);

    // Previous (slice window, then paginate inside that window)
    const previousWindowEnd = Math.min(
      RECENT_COUNT + PREVIOUS_COUNT,
      totalCount
    );
    const previousAll = all.slice(RECENT_COUNT, previousWindowEnd);
    const previousTotal = previousAll.length;
    const previousTotalPages = Math.max(
      Math.ceil(previousTotal / prevLimit),
      1
    );
    const previousStart = (prevPage - 1) * prevLimit;
    const previousItems = previousAll.slice(
      previousStart,
      previousStart + prevLimit
    );

    // Others (everything after the previous window), paginated
    const othersAll = all.slice(previousWindowEnd);
    const othersTotal = othersAll.length;
    const othersTotalPages = Math.max(Math.ceil(othersTotal / limit), 1);
    const othersStart = (page - 1) * limit;
    const paginatedOthers = othersAll.slice(othersStart, othersStart + limit);

    res.json({
      success: true,
      totalCount,

      recent: {
        count: recentItems.length,
        items: recentItems,
      },

      previous: {
        windowCount: previousTotal, // total items inside the 150-window
        currentPage: prevPage,
        perPage: prevLimit,
        totalPages: previousTotalPages,
        hasPrev: prevPage > 1,
        hasNext: prevPage < previousTotalPages,
        items: previousItems,
      },

      others: {
        count: othersTotal,
        currentPage: page,
        perPage: limit,
        totalPages: othersTotalPages,
        hasPrev: page > 1,
        hasNext: page < othersTotalPages,
        items: paginatedOthers,
      },
    });
  } catch (err) {
    console.error("getTeacherResources error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
