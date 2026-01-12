import express from "express";
import GradedAnswerModel from "../models/GradedAnswerModel.js";
import User from "../models/user.js";
import mongoose from "mongoose";
import { OpenAI } from "openai";
import GradeSetting from "../models/GradeSetting.js";
import Assignment from "../models/AssignmentModel.js";
import Classroom from "../models/classroomModel.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
export const getAllGradedSubmissions = async (req, res) => {
  try {
    // const userId = req.user?._id;
    const userId = req.params?.id;
    if (!userId) {
      return res
        .status(404)
        .json({ success: false, message: "user authentication required" });
    }

    const submissions = await GradedAnswerModel.find({
      studentId: userId,
    })
      .populate("studentId", "firstName lastName email city userName parentId")
      .populate({
        path: "assignmentId",
        // select:""
        populate: [
          {
            path: "assignments",
            select:
              "title description dueDate duration resources maxMarks questions createdAt updatedAt",
          },
          {
            path: "assignments.questions",
            model: "Question",
            select:
              "course topic questionText type options correctAnswer hints fineTuningInstructions createdAt updatedAt",
          },
          {
            path: "assignments.studentIds",
            model: "User",
            select:
              "firstName lastName email userName phone image userRole city state country streetAddress zip parentId",
            populate: {
              path: "parentId",
              model: "User",
              select:
                "firstName lastName email userName phone image userRole city state country streetAddress zip",
            },
          },
        ],
      })
      .populate("sessionId", "sessionDate topic notes createdAt")
      .populate({
        path: "classroomId",
        select:
          "teacherId subject dateTime frequency duration lastDate expiryDateTime settings remarks scope",
        populate: [
          {
            path: "teacherId",
            model: "User",
            select:
              "firstName lastName email userName phone gender userRole city state country streetAddress zip",
          },
          {
            path: "subject",
            model: "Subject",
            select: "name code classLevel ",
          },
        ],
        // "teacherId subject dateTime frequency duration lastDate expiryDateTime settings remarks scope "
      })
      .lean();

    // const results = submissions.map((submission) => {
    //   const percentage = (
    //     (submission.totalScore / submission.maxScore) *
    //     100
    //   ).toFixed(2);
    //   return {
    //     ...submission,
    //     percentage: `${percentage}%`,
    //   };
    // });

    res.status(200).json({ success: true, data: submissions });
  } catch (error) {
    console.error("Error fetching graded submissions:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getGradedSubmissionBySubAssignmentId = async (req, res) => {
  try {
    const userId = req.user?._id;
    console.log("userId", userId);

    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const { subAssignmentId } = req.params;

    const submissions = await GradedAnswerModel.find({
      studentId: userId,
    })
      .populate({
        path: "gradedAnswers.questionId",
        model: "Question",
        select:
          "course topic questionText type options hints fineTuningInstructions createdAt updatedAt",
      })
      .populate({
        path: "assignmentId",
        match: {
          "assignments._id": subAssignmentId,
        },
        populate: [
          {
            path: "assignments",
            match: { _id: subAssignmentId },
            select:
              "title description dueDate duration resources maxMarks questions createdAt updatedAt",
            // populate: [
            // {
            //   path: "questions",
            //   model: "Question",
            //   select:
            //     "course topic questionText type options correctAnswer hints fineTuningInstructions createdAt updatedAt",
            // },
            // {
            //   path: "studentIds",
            //   model: "User",
            //   select:
            //     "firstName lastName email userName phone image userRole city state country streetAddress zip parentId",
            //   populate: {
            //     path: "parentId",
            //     model: "User",
            //     select:
            //       "firstName lastName email userName phone image userRole city state country streetAddress zip",
            //   },
            // },
            // ],
          },
        ],
      })
      .populate("studentId", "firstName lastName email city userName parentId")
      .populate("sessionId", "sessionDate topic notes createdAt")
      .populate({
        path: "classroomId",
        select:
          "teacherId subject dateTime frequency duration lastDate expiryDateTime settings remarks scope",
        populate: [
          {
            path: "teacherId",
            model: "User",
            select:
              "firstName lastName email userName phone gender userRole city state country streetAddress zip",
          },
          {
            path: "subject",
            model: "Subject",
            select: "name code classLevel",
          },
        ],
      })

      .lean();

    const filteredSubmissions = submissions.filter(
      (submission) =>
        submission.assignmentId &&
        submission.assignmentId.assignments &&
        submission.assignmentId.assignments.some(
          (sub) => sub._id.toString() === subAssignmentId
        )
    );

    if (filteredSubmissions.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No submissions found for the given sub-assignment ID",
      });
    }

    res.status(200).json({ success: true, data: filteredSubmissions });
  } catch (error) {
    console.error(
      "Error fetching graded submission by sub-assignment ID:",
      error
    );
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getReportByAssignmentId = async (req, res) => {
  try {
    const { id } = req.params; // This is the _id of the GradedAnswerModel

    if (!id) {
      return res
        .status(400)
        .json({ success: false, message: "Missing submission ID" });
    }

    const submission = await GradedAnswerModel.findById(id)
      .populate({
        path: "assignmentId",
        model: "Assignment",
        select: "assignments",
        populate: {
          path: "assignments",
          select:
            "title description assignmentStatus dueDate duration resources maxMarks",
        },
      })
      .populate({
        path: "studentId",
        select: "firstName lastName email city userName parentId",
        populate: {
          path: "parentId",
          model: "User",
          select: "firstName lastName email ",
        },
      })
      .populate("sessionId", "sessionDate topic notes createdAt")
      .populate({
        path: "classroomId",
        select:
          "teacherId subject dateTime frequency duration lastDate expiryDateTime scope",
        populate: [
          {
            path: "teacherId",
            model: "User",
            select: "firstName lastName email userName phone gender userRole",
          },
          {
            path: "subject",
            model: "Subject",
            select: "name code classLevel",
          },
        ],
      })
      .select(
        "updatedAt createdAt gradedAt overall_remarks grade percentage incorrectCount correctCount totalQuestions "
      )
      .lean();

    if (!submission) {
      return res
        .status(404)
        .json({ success: false, message: "Submission not found" });
    }
    const rawSubAssignment = submission.assignmentId?.assignments[0];

    const subAssignment = rawSubAssignment
      ? {
          title: rawSubAssignment.title,
          description: rawSubAssignment.description,
          assignmentStatus: rawSubAssignment.assignmentStatus,
          dueDate: rawSubAssignment.dueDate,
          duration: rawSubAssignment.duration,
          resources: rawSubAssignment.resources,
          maxMarks: rawSubAssignment.maxMarks,
        }
      : null;

    // Remove full assignments array from the assignmentId
    if (submission.assignmentId) {
      submission.assignmentId.assignments = subAssignment ? subAssignment : [];
    }

    res.status(200).json({
      success: true,
      // subAssignment,
      submission,
    });
  } catch (error) {
    console.error("Error fetching submission by ID:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getClassroomAssignmentReport = async (req, res) => {
  try {
    const { classroomId } = req.params;
    const studentId = req.user._id;
    if (!classroomId) {
      return res
        .status(400)
        .json({ success: false, message: "Missing classroom ID" });
    }
    const classroom = await Classroom.findById(classroomId)
      .select("teacherId")
      .lean();
    const teacherId = classroom?.teacherId;
    console.log("teacherId", teacherId);
    // 1. Fetch all graded submissions for this classroom
    const submissions = await GradedAnswerModel.find({ classroomId })
      .populate({
        path: "studentId",
        select: "firstName lastName email city userName parentId",
        populate: {
          path: "parentId",
          model: "User",
          select:
            "firstName lastName email userName phone image userRole city state country streetAddress zip",
        },
      })
      .lean();

    // console.log("Submissions:", submissions);
    if (!submissions.length) {
      return res.status(404).json({
        success: false,
        message: "No submissions found for this classroom",
      });
    }

    const result = await Assignment.aggregate([
      { $unwind: "$assignments" },
      {
        $match: {
          "assignments.studentIds": new mongoose.Types.ObjectId(studentId),
        },
      },
      { $count: "totalAssignedToStudent" },
    ]);
    const totalAssignments = result[0]?.totalAssignedToStudent || 0;

    // console.log("Total Assignments:", TotalAssignments);

    // 2. Fetch grade setting if exists
    const gradeSetting = await GradeSetting.findOne({ teacherId }).lean();

    // ✅ 4. Compute stats
    let totalPercentage = 0;
    let submittedAssignments = 0;

    for (const submission of submissions) {
      const percent = parseFloat(submission.percentage);
      if (!isNaN(percent)) {
        totalPercentage += percent;
        submittedAssignments += 1;
      }
    }

    const averagePercentage = submittedAssignments
      ? (totalPercentage / submittedAssignments).toFixed(2)
      : "0.00";

    let grade = "N/A";
    if (gradeSetting?.grades?.length) {
      const match = gradeSetting.grades.find(
        (g) =>
          Number(averagePercentage) >= g.minPercent &&
          Number(averagePercentage) <= g.maxPercent
      );
      grade = match?.letter || "N/A";
    }

    const student = submissions[0].studentId;

    const report = {
      studentId: student._id,
      name: `${student.firstName} ${student.lastName}`,
      email: student.email,
      userName: student.userName,
      city: student.city,
      parent: student.parentId,
      submittedAssignments,
      totalAssignments,
      averagePercentage,
      grade,
    };

    return res.status(200).json({
      success: true,
      report,
    });
  } catch (error) {
    console.error("Error generating classroom report:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getAssignmentsReport = async (req, res) => {
  try {
    // const userId = req.user?._id;
    const userId = req.params?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // 1. Fetch all submissions by student
    const submissions = await GradedAnswerModel.find({ studentId: userId })
      .select("gradedAnswers overall_remarks")
      .populate({
        path: "studentId",
        select: "firstName lastName email city userName parentId",
        populate: {
          path: "parentId",
          model: "User",
          select:
            "firstName lastName email userName phone image userRole city state country streetAddress zip",
        },
      })
      .lean();

    // console.log(submissions);

    const studentDetails = submissions[0]?.studentId || {};
    if (!submissions.length) {
      return res
        .status(404)
        .json({ success: false, message: "No submissions found" });
    }

    // 2. Total score & remarks
    let totalScore = 0;
    let totalMaxScore = 0;
    const allRemarks = [];

    submissions.forEach((sub, index) => {
      sub.gradedAnswers.forEach((ans) => {
        totalScore += ans.score || 0;
        totalMaxScore += ans.maxScore || 0;
      });
      if (sub.overall_remarks) {
        allRemarks.push(`Assignment ${index + 1}: ${sub.overall_remarks}`);
      }
    });

    const percentage =
      totalMaxScore > 0 ? ((totalScore / totalMaxScore) * 100).toFixed(2) : 0;

    // 3. Use predefined grade logic
    const getGrade = (percent) => {
      percent = Number(percent);
      if (percent >= 90) return "A+";
      if (percent >= 80) return "A";
      if (percent >= 75) return "B+";
      if (percent >= 70) return "B";
      if (percent >= 65) return "C+";
      if (percent >= 60) return "C";
      if (percent >= 40) return "D";
      return "F";
    };

    const grade = getGrade(percentage);

    // 4. AI summary
    const prompt = `You are an academic evaluator. Based on the following assignment remarks, generate a performance summary for the student using simple words :\n\n${allRemarks.join(
      "\n\n"
    )}\n\nThe student's overall percentage is ${percentage}%, and their grade is ${grade}. Provide a concise and encouraging summary with in 2-4 lines.`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are an academic assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });

    const summary = aiResponse.choices?.[0]?.message?.content;

    // 5. Return response
    return res.status(200).json({
      success: true,
      summary,
      studentDetails,
      totalAssignments: submissions.length,
      totalScore,
      totalMaxScore,
      percentage: Number(percentage),
      grade,
    });
  } catch (error) {
    console.error("Error generating assignment report:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

export const getStudentClassroomsAssignmentReports = async (req, res) => {
  try {
    // const studentId = req.user?._id;
    const studentId = req.params.id;
    if (!studentId) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: missing user" });
    }

    const studentObjId = new mongoose.Types.ObjectId(studentId);

    // 0) Fetch all classrooms this student belongs to
    const classrooms = await Classroom.find({ studentIds: studentObjId })
      .select("_id title subject teacherId")
      .populate("teacherId")
      .populate("subject")
      .lean();

    if (!classrooms.length) {
      return res.status(404).json({
        success: false,
        message: "No classrooms found for this student",
        reports: [],
        overall: {
          submittedAssignments: 0,
          totalAssignments: 0,
          averagePercentage: "0.00",
          grade: "N/A",
          method: "weighted_by_submissions",
        },
      });
    }

    // 1) (Optional) Fetch student once to populate parent/contact info in each report
    const student = await User.findById(studentObjId)
      .select("firstName lastName email city userName parentId")
      .populate({
        path: "parentId",
        model: "User",
        select:
          "firstName lastName email userName phone image userRole city state country streetAddress zip",
      })
      .lean();

    // Fallback grade scale (used if no teacher grade setting found)
    const FALLBACK_GRADES = [
      { letter: "A+", minPercent: 90, maxPercent: 100 },
      { letter: "A", minPercent: 85, maxPercent: 89 },
      { letter: "A−", minPercent: 80, maxPercent: 84 },
      { letter: "B+", minPercent: 75, maxPercent: 78 },
      { letter: "B", minPercent: 70, maxPercent: 74 },
      { letter: "C+", minPercent: 65, maxPercent: 69 },
      { letter: "C", minPercent: 60, maxPercent: 64 },
      { letter: "D+", minPercent: 55, maxPercent: 59 },
      { letter: "D", minPercent: 50, maxPercent: 54 },
      { letter: "E", minPercent: 40, maxPercent: 49 },
      { letter: "F", minPercent: 0, maxPercent: 39 },
    ];

    const letterFromScale = (avg, scale) => {
      if (!scale?.length) return "N/A";
      const g = scale.find(
        (x) => avg >= Number(x.minPercent) && avg <= Number(x.maxPercent)
      );
      return g?.letter || "N/A";
    };

    // Globals to compute overall
    let globalSubmitted = 0; // total number of graded submissions across all classes
    let globalSumPercent = 0; // sum of percentages across all submissions
    let globalTotalAssignments = 0; // total number of assignments assigned to the student across all classes
    let overallScale = null; // remember the first available teacher scale to grade the overall

    // 2) Build reports per classroom in parallel
    const reports = await Promise.all(
      classrooms.map(async (c) => {
        const classId = c._id;

        // 2a) Count total assignments assigned to THIS student in THIS class
        //    Assumes your Assignment schema has an `assignments` array
        //    with `assignments.studentIds` listing targeted students.
        const totalAssignedAgg = await Assignment.aggregate([
          { $match: { classroomId: classId } },
          { $unwind: "$assignments" },
          {
            $match: {
              "assignments.studentIds": studentObjId,
            },
          },
          { $count: "totalAssignedToStudent" },
        ]);
        const totalAssignments =
          totalAssignedAgg[0]?.totalAssignedToStudent || 0;

        // 2b) Fetch ONLY THIS student's graded submissions for this classroom
        const submissions = await GradedAnswerModel.find({
          classroomId: classId,
          studentId: studentObjId,
        })
          .select("percentage")
          .lean();

        // 2c) Compute averages for THIS student in THIS class
        let totalPercentage = 0;
        let submittedAssignments = 0;

        for (const s of submissions) {
          const pct = parseFloat(s.percentage);
          if (!Number.isNaN(pct)) {
            totalPercentage += pct;
            submittedAssignments += 1;
          }
        }

        const averagePercentage = submittedAssignments
          ? (totalPercentage / submittedAssignments).toFixed(2)
          : "0.00";

        // 2d) Grade setting from the class teacher
        const gradeSetting = c.teacherId
          ? await GradeSetting.findOne({ teacherId: c.teacherId }).lean()
          : null;

        let grade = "N/A";
        if (gradeSetting?.grades?.length) {
          const avg = Number(averagePercentage);
          const match = gradeSetting.grades.find(
            (g) => avg >= g.minPercent && avg <= g.maxPercent
          );
          grade = match?.letter || "N/A";
        }

        // Update globals (weighted by submissions)
        globalSubmitted += submittedAssignments;
        globalSumPercent += totalPercentage;
        globalTotalAssignments += totalAssignments;
        // 2e) Assemble one report entry for this classroom
        return {
          classroomId: classId,
          classroomTitle: c.title || "",
          subject: c.subject || "",
          teacherId: c.teacherId || null,

          // student info
          student: {
            studentId: student?._id,
            name:
              (student?.firstName || "") +
              (student?.lastName ? ` ${student.lastName}` : ""),
            email: student?.email || "",
            userName: student?.userName || "",
            city: student?.city || "",
          },
          parent: student?.parentId || null,

          // stats
          submittedAssignments,
          totalAssignments,
          averagePercentage,
          grade,
        };
      })
    );

    // 3) Compute overall (across all classrooms) percentage + grade
    const overallAveragePercentage = globalSubmitted
      ? (globalSumPercent / globalSubmitted).toFixed(2)
      : "0.00";

    const overallAvgNum = Number(overallAveragePercentage);
    const overallGrade =
      overallScale && overallScale.length
        ? letterFromScale(overallAvgNum, overallScale)
        : letterFromScale(overallAvgNum, FALLBACK_GRADES);

    return res.status(200).json({
      success: true,
      count: reports.length,
      reports,
      overall: {
        submittedAssignments: globalSubmitted,
        totalAssignments: globalTotalAssignments,
        averagePercentage: overallAveragePercentage,
        grade: overallGrade,
        method: "weighted_by_submissions", // each assignment counts equally
      },
    });
  } catch (error) {
    console.error("Error generating per-classroom reports:", error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

//remarks grade totalassigment percentage

export const getParentChildrenAssignmentReports = async (req, res) => {
  try {
    console.log("req.user?._id", req.user?._id);
    const parentId = req.user?._id;
    console.log("parentId", parentId);
    if (!parentId) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized: missing user" });
    }

    // 1) Fetch all children of this parent
    const children = await User.find({ parentId, userRole: "student" })
      .select("firstName lastName email city userName")
      .lean();

    if (!children.length) {
      return res.status(404).json({
        success: false,
        message: "No children found for this parent",
        reports: [],
      });
    }

    // 2) Build report per child
    const childReports = await Promise.all(
      children.map(async (child) => {
        const studentObjId = new mongoose.Types.ObjectId(child._id);

        // 2a) Get classrooms for this child
        const classrooms = await Classroom.find({ studentIds: studentObjId })
          .select("_id title subject teacherId")
          .populate("teacherId", "firstName lastName email userName")
          .lean();

        // 2b) For each classroom, compute stats (like student endpoint)
        const classroomReports = await Promise.all(
          classrooms.map(async (c) => {
            const classId = c._id;

            // Total assignments assigned to this student in this class
            const totalAssignedAgg = await Assignment.aggregate([
              { $match: { classroomId: classId } },
              { $unwind: "$assignments" },
              {
                $match: {
                  "assignments.studentIds": studentObjId,
                },
              },
              { $count: "totalAssignedToStudent" },
            ]);
            const totalAssignments =
              totalAssignedAgg[0]?.totalAssignedToStudent || 0;

            // Graded submissions for this child in this classroom
            const submissions = await GradedAnswerModel.find({
              classroomId: classId,
              studentId: studentObjId,
            })
              .select("percentage assignmentId correctness")
              .populate("assignmentId", "title sessionId")
              .lean();

            // Stats
            let totalPercentage = 0;
            let submittedAssignments = 0;
            for (const s of submissions) {
              const pct = parseFloat(s.percentage);
              if (!Number.isNaN(pct)) {
                totalPercentage += pct;
                submittedAssignments += 1;
              }
            }
            const averagePercentage = submittedAssignments
              ? (totalPercentage / submittedAssignments).toFixed(2)
              : "0.00";

            // Grade setting
            const gradeSetting = c.teacherId
              ? await GradeSetting.findOne({ teacherId: c.teacherId }).lean()
              : null;

            let grade = "N/A";
            if (gradeSetting?.grades?.length) {
              const avg = Number(averagePercentage);
              const match = gradeSetting.grades.find(
                (g) => avg >= g.minPercent && avg <= g.maxPercent
              );
              grade = match?.letter || "N/A";
            }

            return {
              classroomId: classId,
              classroomTitle: c.title,
              subject: c.subject,
              teacher: c.teacherId,
              totalAssignments,
              submittedAssignments,
              averagePercentage,
              grade,
              assignments: submissions.map((s) => ({
                assignmentId: s.assignmentId?._id,
                title: s.assignmentId?.title || "",
                sessionId: s.assignmentId?.sessionId || null,
                marks: s.percentage,
                correctness: s.correctness,
              })),
            };
          })
        );

        return {
          childId: child._id,
          childName: `${child.firstName} ${child.lastName}`,
          childEmail: child.email,
          userName: child.userName,
          city: child.city,
          classrooms: classroomReports,
        };
      })
    );

    res.json({ success: true, reports: childReports });
  } catch (err) {
    console.error("Error in parent reports:", err);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};
