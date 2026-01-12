import Classroom from "../models/classroomModel.js";
import Parent from "../models/parentModel.js";
import Report from "../models/ReportModel.js";
import Student from "../models/studentModel.js";
import Teacher from "../models/teacherModel.js";
import User from "../models/user.js";
import { sendReportEmail } from "../utils/emailSendReport.js";

// Generate Session Report
export const generateSessionReport = async (req, res) => {
  const {
    classroomId,
    teacherId,
    teacherName,
    performanceSummary,
    reportType,
  } = req.body;

  try {
    // Validate classroom
    const classroom = await Classroom.findById(classroomId);
    if (!classroom)
      return res.status(404).json({ error: "Classroom not found" });

    // Validate teacher
    const teacher = await User.findById(teacherId);
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    // Check if teacher is assigned to classroom
    if (!classroom.teacherId === teacherId) {
      return res
        .status(400)
        .json({ error: "Teacher is not assigned to this classroom" });
    }

    // Prevent duplicate for same type, class, teacher, and report type
    const existingReport = await Report.findOne({
      classroomId,
      teacherId,
      type: "session",
      reportType,
    });

    if (existingReport) {
      return res
        .status(409)
        .json({ error: `${reportType} session report already exists` });
    }

    // Create report
    const report = new Report({
      type: "session",
      classroomId,
      teacherId,
      teacherName,
      performanceSummary,
      reportType,
    });

    await report.save();
    res
      .status(201)
      .json({ message: `${reportType} session report created`, report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate session report" });
  }
};

// Generate Student Report
export const generateStudentReport = async (req, res) => {
  const {
    classroomId,
    teacherId,
    studentId,
    studentName,
    teacherName,
    performanceSummary,
    reportType,
  } = req.body;

  try {
    // Check classroom
    const classroom = await Classroom.findById(classroomId);
    if (!classroom)
      return res.status(404).json({ error: "Classroom not found" });

    // Check teacher
    const teacher = await User.findOne({ _id: teacherId, userRole: "teacher" });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    // Check student
    const student = await User.findOne({ _id: studentId, userRole: "student" });
    if (!student) return res.status(404).json({ error: "Student not found" });

    // Check if teacher is assigned to the classroom
    if (!classroom.teacherId === teacherId) {
      return res
        .status(400)
        .json({ error: "Teacher is not assigned to this classroom" });
    }

    // Check if student is in the classroom
    if (!classroom.studentIds?.includes(studentId)) {
      return res
        .status(400)
        .json({ error: "Student is not part of this classroom" });
    }

    // Prevent duplicate
    const existingReport = await Report.findOne({
      type: "student",
      classroomId,
      teacherId,
      studentId,
      reportType,
    });

    if (existingReport) {
      return res
        .status(409)
        .json({ error: `${reportType} student report already exists` });
    }

    // Save new report
    const report = new Report({
      type: "student",
      classroomId,
      teacherId,
      studentId,
      studentName,
      teacherName,
      performanceSummary,
      reportType,
    });

    await report.save();
    res.status(201).json({ message: "Student report created", report });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to generate student report" });
  }
};

// Send Reports to Parents (Simulated)
export const sendReportsToParents = async (req, res) => {
  const { classroomId, studentIds } = req.body;

  let successCount = 0;
  let failureLog = [];

  try {
    for (const studentId of studentIds) {
      const student = await User.findById({
        _id: studentId,
        userRole: "student",
      });
      if (!student) {
        failureLog.push(`Student with ID ${studentId} not found`);
        continue;
      }

      console.log("student", student);
      if (!student.parentId) {
        return res
          .status(400)
          .json({ error: "There is no parent associated with the student." });
      }
      const parent = await User.findById({
        _id: student.parentId,
        userRole: "parent",
      });
      const report = `Report for ${student.name} (ID: ${studentId}) in classroom ${classroomId}. Grades: A, B, C.`;

      try {
        await sendReportEmail(student, report, parent);
        successCount++;
      } catch (err) {
        const errMsg = `❌ Failed to send email to parent of ${student.name}: ${err.message}`;
        console.error(errMsg);
        failureLog.push(errMsg);
      }
    }

    res.status(200).json({
      message: `Reports sending complete. Success: ${successCount}, Failed: ${failureLog.length}`,
      // failures: failureLog,
    });
  } catch (error) {
    console.error("Fatal error:", error.message);
    res
      .status(500)
      .json({ error: "Failed to send reports due to internal error." });
  }
};
