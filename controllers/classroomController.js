// controllers/classroomController.js
import mongoose from "mongoose";
import Classroom from "../models/classroomModel.js";
import Student from "../models/studentModel.js";
import Teacher from "../models/teacherModel.js";
import Session from "../models/SessionModel.js";
import User from "../models/user.js";

export const createClassroom = async (req, res) => {
  try {
    const {
      teacherId,
      studentIds,
      dateTime,
      frequency,
      durationInWeeks = 4,
      classroom_prompt,
    } = req.body;

    // if(teacherId||studentIds ||dateTime ||frequency)

    if (!mongoose.Types.ObjectId.isValid(teacherId)) {
      return res.status(400).json({ error: "Invalid teacher ID format" });
    }

    // ✅ Correct findById usage
    const teacherExists = await User.findOne({
      _id: teacherId,
      userRole: "teacher",
    });
    if (!teacherExists) {
      return res.status(400).json({ error: "Teacher not found" });
    }

    // Check if all student IDs exist
    const students = await User.find({
      _id: { $in: studentIds },
      userRole: "student",
    });
    // if (students.length !== studentIds.length) {
    //   return res.status(400).json({ error: "One or more students not found" });
    // }
    // ✅ Calculate expiryDateTime based on frequency
    const startDate = new Date(dateTime);
    let expiryDateTime = new Date(startDate);

    if (frequency === "daily") {
      expiryDateTime.setDate(expiryDateTime.getDate() + durationInWeeks * 7);
    } else if (frequency === "weekly") {
      expiryDateTime.setDate(expiryDateTime.getDate() + durationInWeeks * 7);
    } else if (frequency === "monthly") {
      expiryDateTime.setMonth(
        expiryDateTime.getMonth() + Math.ceil(durationInWeeks / 4)
      );
    }

    // ✅ Add expiryDateTime into the request body before saving
    const classroomData = {
      ...req.body,
      expiryDateTime,
    };

    const classroom = new Classroom(classroomData);
    const saved = await classroom.save();

    // Populate teacher and students after saving
    const populated = await Classroom.findById(saved._id)
      .populate({
        path: "teacherId",
        model: "User",
        select: "firstName lastName email userName",
      })
      .populate({
        path: "studentIds",
        model: "User",
        match: { userRole: "student" },
        select: "firstName lastName email userName",
      });
    res.status(201).json(populated);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to create classroom", details: err.message });
  }
};

export const getClassrooms = async (req, res) => {
  try {
    const classrooms = await Classroom.find();

    res.status(200).json(classrooms);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch classrooms", details: err.message });
  }
};

export const getClassroomById = async (req, res) => {
  try {
    const classroom = await Classroom.findById(req.params.id)
      .populate("subject")
      .populate("studentIds", "firstName lastName email userName")
      .populate("teacherId", "firstName lastName email username");

    if (!classroom)
      return res.status(404).json({ error: "Classroom not found" });

    res.status(200).json(classroom);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to get classroom", details: err.message });
  }
};
export const getTeacherAddedClassrooms = async (req, res) => {
  try {
    const { teacherId } = req.params; // this is actually the userId

    // Step 1: Find the teacher using the userId (teacherId in classroom)
    const teacher = await User.findOne({ _id: teacherId, userRole: "teacher" });
    if (!teacher) {
      return res.status(404).json({ error: "Teacher not found" });
    }

    // Step 2: Find classrooms where teacherId equals the userId
    const classrooms = await Classroom.find({ teacherId })
      .populate({
        path: "teacherId",
        model: "User",
        select: "image firstName lastName email phone ",
      })
      .populate({
        path: "studentIds",
        model: "User",
        match: { userRole: "student" },
        select:
          "firstName lastName email userName age country city language createdAt settings",
      })
      .populate("subject", "name code")
      .populate("sessions", "sessionDate topic notes sessionUrl");

    if (!classrooms || classrooms.length === 0) {
      return res
        .status(404)
        .json({ error: "No classrooms found for this teacher" });
    }

    res.status(200).json(classrooms);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to get classroom", details: err.message });
  }
};

export const updateClassroom = async (req, res) => {
  try {
    const updated = await Classroom.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!updated) return res.status(404).json({ error: "Classroom not found" });
    res.status(200).json(updated);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to update classroom", details: err.message });
  }
};

export const deleteClassroom = async (req, res) => {
  try {
    const deleted = await Classroom.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Classroom not found" });
    res.status(200).json({ message: "Classroom deleted successfully" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to delete classroom", details: err.message });
  }
};

// Remove the teacher from the classroom (set to null)
export const removeTeacher = async (req, res) => {
  try {
    const { id } = req.params;

    const updated = await Classroom.findByIdAndUpdate(
      id,
      { $unset: { teacherId: "" } },
      { new: true }
    )
      .populate("teacherId")
      .populate("studentIds");

    if (!updated) return res.status(404).json({ error: "Classroom not found" });
    res.status(200).json(updated);
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to remove teacher", details: err.message });
  }
};

export const addStudentsToClassroom = async (req, res) => {
  try {
    const classroomId = req.params.id;
    const { studentIds } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds array is required" });
    }

    // Validate student existence
    const existingStudents = await User.find({
      _id: { $in: studentIds },
      userRole: "student",
    });
    if (existingStudents.length !== studentIds.length) {
      return res.status(404).json({ error: "One or more students not found" });
    }

    // Fetch classroom
    const classroom = await Classroom.findById(classroomId);
    if (!classroom) {
      return res.status(404).json({ error: "Classroom not found" });
    }

    // Identify already added students
    const alreadyAdded = studentIds.filter((id) =>
      classroom.studentIds.map((sid) => sid.toString()).includes(id)
    );

    if (alreadyAdded.length > 0) {
      return res.status(400).json({
        error: "Some students are already in the classroom",
        alreadyAdded,
      });
    }

    // Add new students
    classroom.studentIds.push(...studentIds);
    await classroom.save();

    // Populate student details
    const populatedClassroom = await Classroom.findById(classroomId)
      .populate({
        path: "studentIds",
        model: "User",
        match: { userRole: "student" },
        select: "firstName lastName email userName",
      })
      .populate({
        path: "teacherId",
        model: "User",
        select: "firstName lastName email userName",
      })
      .populate("subject", "name code");

    res.status(200).json(populatedClassroom);
  } catch (err) {
    res.status(500).json({
      error: "Failed to add students",
      details: err.message,
    });
  }
};

// ➖ Remove Students from Classroom
export const removeStudentsFromClassroom = async (req, res) => {
  try {
    const classroomId = req.params.id;
    const { studentIds } = req.body;

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: "studentIds array is required" });
    }

    const classroom = await Classroom.findById(classroomId);
    if (!classroom) {
      return res.status(404).json({ error: "Classroom not found" });
    }

    // Remove student IDs
    classroom.studentIds = classroom.studentIds.filter(
      (id) => !studentIds.includes(id.toString())
    );

    await classroom.save();
    res
      .status(200)
      .json({ success: true, message: "Students removed successfully" });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to remove students", details: err.message });
  }
};

export const updateClassroomSettings = async (req, res) => {
  try {
    const classroomId = req.params.id;
    const settings = req.body;

    // Validate classroom exists
    const classroom = await Classroom.findById(classroomId);
    if (!classroom) {
      return res.status(404).json({ error: "Classroom not found" });
    }

    // Allowed settings keys
    const allowedFields = [
      "screenLocked",
      "sendReport",
      "saveMaterials",
      "reminders",
      "room",
      "online",
      "resources",
    ];

    // Filter only valid keys
    const filteredSettings = {};
    for (const key of allowedFields) {
      if (settings.hasOwnProperty(key)) {
        filteredSettings[key] = settings[key];
      }
    }
    // Update only the provided settings
    classroom.settings = {
      ...classroom.settings,
      ...filteredSettings,
    };

    const updated = await classroom.save();
    res.status(200).json({
      message: "Settings updated successfully",
      settings: updated.settings,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to update settings",
      details: err.message,
    });
  }
};

export const updateClassSchedule = async (req, res) => {
  try {
    const classroomId = req.params.id;
    const { dateTime, frequency, duration, lastDate } = req.body;
    if (!dateTime || !frequency || !duration || !lastDate) {
      return res.status(400).json({
        error:
          "All scheduled fields (dateTime, frequency, duration, lastDate) are required",
      });
    }
    const classroom = await Classroom.findById(classroomId);
    if (!classroom) {
      return res.status(404).json({ error: "Classroom not found" });
    }
    classroom.dateTime = new Date(dateTime);
    classroom.frequency = frequency;
    classroom.duration = duration;
    classroom.lastDate = new Date(lastDate);

    const updated = await classroom.save();
    res
      .status(200)
      .json({ message: "Class schedule updated", classroom: updated });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Failed to update class schedule", details: err.message });
  }
};

export const updateClassroomRemarks = async (req, res) => {
  try {
    const classroomId = req.params.id;
    const { remarks, scope } = req.body;

    if (!remarks || !scope) {
      return res.status(400).json({
        error: "Both 'remarks' and 'scope' fields are required",
      });
    }

    const classroom = await Classroom.findById(classroomId);
    if (!classroom) {
      return res.status(404).json({ error: "Classroom not found" });
    }

    classroom.remarks = remarks;
    classroom.scope = scope;

    const updated = await classroom.save();
    res
      .status(200)
      .json({ message: "Classroom remarks updated", classroom: updated });
  } catch (err) {
    res.status(500).json({
      error: "Failed to update classroom remarks",
      details: err.message,
    });
  }
};

export const addClassSession = async (req, res) => {
  const { id: classroomId } = req.params;
  const { sessionDate, topic, notes, sessionUrl } = req.body;

  if (!sessionDate || !topic) {
    return res
      .status(400)
      .json({ error: "sessionDate and topic are required" });
  }

  if (!classroomId) {
    return res.status(400).json({ error: "Classroom ID is required." });
  }
  try {
    const session = await Session.create({
      classroomId,
      sessionDate,
      topic,
      notes,
      sessionUrl,
    });
    res.status(201).json({ message: "Session created", session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const assignStudentsToSession = async (req, res) => {
  const { id } = req.params;
  const { studentIds } = req.body;

  if (!Array.isArray(studentIds)) {
    return res.status(400).json({ error: "studentIds must be an array" });
  }

  try {
    const session = await Session.findById(id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    session.studentIds = studentIds;
    await session.save();

    res
      .status(200)
      .json({ message: "Students assigned successfully", session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getAllClassSessions = async (req, res) => {
  const { id: classroomId } = req.params;

  if (!classroomId) {
    return res.status(400).json({ error: "Classroom ID is required." });
  }

  try {
    const sessions = await Session.find({ classroomId }).sort({
      sessionDate: -1,
    });

    if (!sessions || sessions.length === 0) {
      return res
        .status(404)
        .json({ error: "No sessions found for this classroom." });
    }

    res.status(200).json({ sessions });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to retrieve sessions", details: err.message });
  }
};

export const getSessionById = async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }

  try {
    const session = await Session.findById(sessionId);
    if (!session && session.length === 0) {
      return res.status(404).json({ error: "Session not found." });
    }

    res.status(200).json({ session });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid session ID format." });
    }
    res
      .status(500)
      .json({ error: "Failed to retrieve session", details: err.message });
  }
};

export const updateSession = async (req, res) => {
  const { sessionId } = req.params;
  const updateData = req.body; // Accept any fields from body

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: "No fields to update provided." });
  }

  try {
    const updatedSession = await Session.findByIdAndUpdate(
      sessionId,
      updateData,
      { new: true, runValidators: true }
    );

    if (!updatedSession) {
      return res.status(404).json({ error: "Session not found." });
    }

    res
      .status(200)
      .json({ message: "Session updated", session: updatedSession });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid session ID format." });
    }
    res
      .status(500)
      .json({ error: "Failed to update session", details: err.message });
  }
};

export const deleteSession = async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: "Session ID is required." });
  }

  try {
    const deleted = await Session.findByIdAndDelete(sessionId);
    if (!deleted) {
      return res.status(404).json({ error: "Session not found." });
    }

    res.status(200).json({ message: "Session deleted successfully." });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(400).json({ error: "Invalid session ID format." });
    }
    res
      .status(500)
      .json({ error: "Failed to delete session", details: err.message });
  }
};

export const getAllSessions = async (req, res) => {
  try {
    const sessions = await Session.find().sort({ sessionDate: -1 });

    res.status(200).json({ sessions });
  } catch (err) {
    console.log(err);
    res.status(500).json({
      error: "Failed to fetch all sessions",
      details: err.message,
    });
  }
};

export const searchSessions = async (req, res) => {
  try {
    const teacherId = req.user._id;
    const { topic, startDate, endDate } = req.query;

    // Step 1: Get all classrooms for this teacher
    const classrooms = await Classroom.find({ teacherId });

    if (!classrooms || classrooms.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No classrooms found for this teacher",
      });
    }

    // Extract ObjectId array
    const classroomIds = classrooms.map(
      (c) => new mongoose.Types.ObjectId(c._id)
    );

    // Step 2: Build session filter
    const filter = {
      classroomId: { $in: classroomIds },
    };

    // Step 3: Apply optional topic filter (case-insensitive)
    if (topic && topic.trim() !== "") {
      filter.topic = { $regex: topic, $options: "i" };
    }

    // Step 4: Apply optional date range filter
    if (startDate || endDate) {
      filter.sessionDate = {};
      if (startDate) {
        const parsedStart = new Date(startDate);
        if (!isNaN(parsedStart)) {
          filter.sessionDate.$gte = parsedStart;
        }
      }
      if (endDate) {
        const parsedEnd = new Date(endDate);
        if (!isNaN(parsedEnd)) {
          filter.sessionDate.$lte = parsedEnd;
        }
      }
    }

    // Step 5: Fetch sessions
    const sessions = await Session.find(filter)
      .populate("classroomId", "subject description")
      .sort({ sessionDate: -1 });

    if (!sessions.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No sessions found for the given criteria",
      });
    }
    res.status(200).json({
      success: true,
      count: sessions.length,
      sessions,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to search sessions",
      success: false,
      details: err.message,
    });
  }
};

// get all teacher sessions
export const getAllTeacherSessions = async (req, res) => {
  try {
    const teacherId = req.user._id;

    // Step 1: Find all classrooms of the teacher
    const classrooms = await Classroom.find({ teacherId });

    if (!classrooms || classrooms.length === 0) {
      return res
        .status(404)
        .json({ error: "No classrooms found for this teacher" });
    }

    // Step 2: Extract classroom IDs
    const classroomIds = classrooms.map((classroom) => classroom._id);

    // Step 3: Find all sessions for those classroom IDs
    const sessions = await Session.find({ classroomId: { $in: classroomIds } })
      .populate("classroomId") // optional populate
      .sort({ sessionDate: -1 });

    res.status(200).json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({
      error: "Failed to get sessions",
      details: err.message,
    });
  }
};

export const getClassroomStudents = async (req, res) => {
  const { id: classroomId } = req.params;

  // ✅ Validate classroomId
  if (!classroomId || !mongoose.Types.ObjectId.isValid(classroomId)) {
    return res.status(400).json({ error: "Valid Classroom ID is required." });
  }

  try {
    // ✅ Fetch classroom with student population
    const classroom = await Classroom.findById(classroomId).populate({
      path: "studentIds",
      select:
        "firstName lastName email userName age country city language createdAt settings userRole",
    });

    // ✅ Check if classroom exists
    if (!classroom) {
      return res.status(404).json({ error: "Classroom not found." });
    }

    // ✅ Handle case where no students are linked
    if (!classroom.studentIds || classroom.studentIds.length === 0) {
      return res
        .status(404)
        .json({ error: "No students found in this classroom." });
    }

    // ✅ Filter to only include students with userRole: "student"
    const validStudents = classroom.studentIds.filter(
      (student) => student.userRole === "student"
    );

    if (validStudents.length === 0) {
      return res
        .status(404)
        .json({ error: "No valid student users found in this classroom." });
    }

    // ✅ Return successful response
    return res.status(200).json({ students: validStudents });
  } catch (err) {
    console.error("❌ Error fetching students:", err.message);
    res.status(500).json({
      error: "Failed to retrieve students",
      details: err.message,
    });
  }
};

/**
 * Validate Session for User
 * Checks if a session is valid for the given user ID and returns user and session details
 */
export const validateSessionForUser = async (req, res) => {
  try {
    const { sessionId: rawSessionId, userId: rawUserId } = req.params;
    let sessionId = rawSessionId;
    let userId = rawUserId;

    // Validate input
    if (!sessionId || !userId) {
      return res.status(400).json({
        error: "Missing required fields",
        message: "Both sessionId and userId are required in URL parameters",
      });
    }

    // Handle custom IDs - search by custom identifier instead of converting to ObjectId
    let actualSessionId = sessionId;
    let actualUserId = userId;
    
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      // Try to find session by sessionUrl or custom identifier
      const sessionByUrl = await Session.findOne({ 
        sessionUrl: { $regex: sessionId, $options: 'i' } 
      });
      if (sessionByUrl) {
        actualSessionId = sessionByUrl._id.toString();
        console.log(`✅ Found session by URL: ${rawSessionId} -> ${actualSessionId}`);
      } else {
        return res.status(400).json({
          error: "Session not found",
          message: `No session found with identifier '${rawSessionId}'`,
          hint: "Make sure the session exists and the identifier is correct"
        });
      }
    }
    
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      // Try to find user by email, username, or other identifier
      const userByIdentifier = await User.findOne({
        $or: [
          { email: userId },
          { username: userId },
          { customId: userId }
        ]
      });
      if (userByIdentifier) {
        actualUserId = userByIdentifier._id.toString();
        console.log(`✅ Found user by identifier: ${rawUserId} -> ${actualUserId}`);
      } else {
        return res.status(400).json({
          error: "User not found", 
          message: `No user found with identifier '${rawUserId}'`,
          hint: "Make sure the user exists and the identifier is correct"
        });
      }
    }

    // Use the found actual IDs
    sessionId = actualSessionId;
    userId = actualUserId;

    // Fetch the session
    const session = await Session.findById(sessionId).populate({
      path: "classroomId",
      populate: [
        {
          path: "teacherId",
          model: "User",
          select: "firstName lastName email",
        },
        {
          path: "studentIds",
          model: "User",
          match: { userRole: "student" },
          select: "firstName lastName email userName",
        },
      ],
    });

    if (!session) {
      return res.status(404).json({
        error: "Session not found",
        message: `Session with ID ${sessionId} does not exist`,
      });
    }

    // Fetch the user
    const user = await User.findById(userId).select("-password");

    if (!user) {
      return res.status(404).json({
        error: "User not found",
        message: `User with ID ${userId} does not exist`,
      });
    }

    // Check if the user is part of the session's classroom
    const classroom = session.classroomId;
    const isTeacher = classroom.teacherId._id.toString() === userId;
    const isStudent = classroom.studentIds.some(
      (student) => student._id.toString() === userId
    );

    if (!isTeacher && !isStudent) {
      return res.status(403).json({
        error: "Access denied",
        message: "User is not part of this session's classroom",
      });
    }

    // Check if session is still valid (not in the past)
    const now = new Date();
    const sessionDate = new Date(session.sessionDate);
    const isExpired = sessionDate < now;

    // Return user and session details
    res.status(200).json({
      valid: !isExpired,
      expired: isExpired,
      userRole: isTeacher ? "teacher" : "student",
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        userName: user.userName,
        userRole: user.userRole,
        image: user.image,
      },
      session: {
        id: session._id,
        topic: session.topic,
        sessionDate: session.sessionDate,
        sessionUrl: session.sessionUrl,
        notes: session.notes,
        classroom: {
          id: classroom._id,
          teacherId: classroom.teacherId._id,
          teacherName: `${classroom.teacherId.firstName} ${classroom.teacherId.lastName}`,
          studentCount: classroom.studentIds.length,
        },
        reminders: session.reminders,
      },
    });
  } catch (err) {
    console.error("❌ Error validating session for user:", err.message);
    res.status(500).json({
      error: "Failed to validate session",
      details: err.message,
    });
  }
};

/**
 * Report Off Screen Activity
 * Logs when a student goes off-screen during a session
 */
export const reportOffScreen = async (req, res) => {
  try {
    const { sessionId: rawSessionId, userId: rawUserId } = req.params;
    let sessionId = rawSessionId;
    let userId = rawUserId;

    // Validate input
    if (!sessionId || !userId) {
      return res.status(400).json({
        error: "Missing required fields",
        message: "Both sessionId and userId are required in URL parameters",
      });
    }

    // Handle custom IDs - search by custom identifier
    let actualSessionId = sessionId;
    let actualUserId = userId;
    
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      const sessionByUrl = await Session.findOne({ 
        sessionUrl: { $regex: sessionId, $options: 'i' } 
      });
      if (sessionByUrl) {
        actualSessionId = sessionByUrl._id.toString();
        console.log(`✅ Found session by URL: ${rawSessionId} -> ${actualSessionId}`);
      } else {
        return res.status(400).json({
          error: "Session not found",
          message: `No session found with identifier '${rawSessionId}'`
        });
      }
    }
    
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      const userByIdentifier = await User.findOne({
        $or: [
          { email: userId },
          { username: userId },
          { customId: userId }
        ]
      });
      if (userByIdentifier) {
        actualUserId = userByIdentifier._id.toString();
        console.log(`✅ Found user by identifier: ${rawUserId} -> ${actualUserId}`);
      } else {
        return res.status(400).json({
          error: "User not found", 
          message: `No user found with identifier '${rawUserId}'`
        });
      }
    }

    sessionId = actualSessionId;
    userId = actualUserId;

    // Get user details
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        error: "User not found",
        message: `User with ID ${userId} does not exist`
      });
    }

    // Verify session exists
    const session = await Session.findById(sessionId);
    if (!session) {
      return res.status(404).json({
        error: "Session not found",
        message: `Session with ID ${sessionId} does not exist`
      });
    }

    // Import and create off-screen report
    const OffScreenReport = (await import("../models/OffScreenReportModel.js")).default;
    
    const report = await OffScreenReport.create({
      sessionId,
      userId,
      userEmail: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      timestamp: new Date()
    });

    console.log(`📝 Off-screen report created: Session ${sessionId}, User ${user.email}`);

    return res.status(201).json({
      success: true,
      message: "Off-screen activity reported successfully",
      report: {
        id: report._id,
        sessionId: report.sessionId,
        userId: report.userId,
        userEmail: report.userEmail,
        firstName: report.firstName,
        lastName: report.lastName,
        timestamp: report.timestamp
      }
    });

  } catch (err) {
    console.error("❌ Error reporting off-screen activity:", err.message);
    res.status(500).json({
      error: "Failed to report off-screen activity",
      details: err.message,
    });
  }
};
