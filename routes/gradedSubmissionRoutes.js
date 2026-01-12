import express from "express";
import {
  getAllGradedSubmissions,
  getAssignmentsReport,
  getClassroomAssignmentReport,
  getGradedSubmissionBySubAssignmentId,
  getParentChildrenAssignmentReports,
  getReportByAssignmentId,
  getStudentClassroomsAssignmentReports,
} from "../controllers/gradedSubmissionController.js";
import auth_key_header from "../middleware/auth_key_header.js";
import auth_token from "../middleware/auth_token.js";

const router = express.Router();

// @route GET /api/graded-submissions

//get all assignment report

router.get(
  "/class_report/parent",
  auth_key_header,
  auth_token,
  getParentChildrenAssignmentReports
);

router.get(
  "/overAll_report/:id",
  auth_key_header,
  auth_token,
  getAssignmentsReport
);

// students all graded submissions
router.get(
  "/student/:id",
  auth_key_header,
  auth_token,
  getAllGradedSubmissions
);
// get subassignment
router.get(
  "/:subAssignmentId",
  auth_key_header,
  auth_token,
  getGradedSubmissionBySubAssignmentId
);

// get specific answered assignment report
router.get(
  "/report_per_assignment/:id",
  auth_key_header,
  auth_token,
  getReportByAssignmentId
);

// @route GET /api/graded-submissions/report/:classroomId
// @desc Get all graded submissions for a classroom
router.get(
  "/class_report/:classroomId",
  auth_key_header,
  auth_token,
  getClassroomAssignmentReport
);

router.get(
  "/class_report/student/:id",
  auth_key_header,
  auth_token,
  getStudentClassroomsAssignmentReports
);

export default router;
