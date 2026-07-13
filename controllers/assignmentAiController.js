import mongoose from "mongoose";
import Assignment from "../models/AssignmentModel.js";
import Question from "../models/QuestionModel.js";
import User from "../models/user.js";
import AssignmentAiReport from "../models/AssignmentAiReportModel.js";
import { getClassworkAiFeedback } from "../utils/geminiClassworkFeedback.js";

// Coerces whatever Gemini returned for part1/part2/part3 into a string array,
// matching the Mongo sub-schema. Same shape defensive as classworkController.
function toStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

// Student-facing projection of the AI feedback JSON. part3 is teacher-only
// (diagnostic-training advice) so it never leaves this function to the student.
function projectAiForStudent(aiResult) {
  if (!aiResult || typeof aiResult !== "object") return null;
  return {
    correct: Boolean(aiResult.correct),
    hintStream: aiResult.hintStream || "",
    part1: toStringArray(aiResult.part1),
    part2: toStringArray(aiResult.part2),
    advancedChallenge: {
      congratulations: aiResult.advancedChallenge?.congratulations || "",
      question: aiResult.advancedChallenge?.question || "",
    },
  };
}

// POST /api/assignment/ai-hint
// Body: { subAssignmentId, questionId, studentId, studentName?, studentAnswer }
// Returns: { active, inactiveReason, remainingHints, feedback, correct, correctAnswer? }
export const getAssignmentAiHint = async (req, res) => {
  try {
    const {
      subAssignmentId,
      questionId,
      studentId,
      studentName: studentNameFromBody,
      studentAnswer,
    } = req.body || {};

    if (!subAssignmentId || !questionId || !studentId) {
      return res.status(400).json({
        message: "subAssignmentId, questionId, and studentId are required.",
      });
    }
    if (
      !mongoose.Types.ObjectId.isValid(subAssignmentId) ||
      !mongoose.Types.ObjectId.isValid(questionId) ||
      !mongoose.Types.ObjectId.isValid(studentId)
    ) {
      return res.status(400).json({ message: "Invalid ObjectId in request." });
    }

    const parent = await Assignment.findOne({
      "assignments._id": subAssignmentId,
    }).lean();
    if (!parent) {
      return res.status(404).json({ message: "Sub-assignment not found." });
    }
    const sub = parent.assignments.find(
      (a) => a._id.toString() === String(subAssignmentId)
    );
    if (!sub) {
      return res.status(404).json({ message: "Sub-assignment not found." });
    }

    const belongsToSub = (sub.questions || []).some(
      (qid) => qid.toString() === String(questionId)
    );
    if (!belongsToSub) {
      return res
        .status(404)
        .json({ message: "Question does not belong to this sub-assignment." });
    }

    const question = await Question.findById(questionId).lean();
    if (!question) {
      return res.status(404).json({ message: "Question not found." });
    }

    // Max-hints cap lives on both the sub-assignment and the question doc; the
    // question is authoritative because generation copies the parent value in.
    const maxAiHints = Number.isFinite(question.maxAiHints)
      ? Number(question.maxAiHints)
      : Number(sub.maxAiHints) || 0;

    const existing = await AssignmentAiReport.findOne({
      subAssignmentId,
      questionId,
      studentId,
    }).lean();

    if (existing && existing.active === false) {
      return res.status(409).json({
        message:
          existing.inactiveReason === "correct"
            ? "This question is already marked correct."
            : "AI hint limit reached for this question.",
        active: false,
        inactiveReason: existing.inactiveReason,
        remainingHints: 0,
      });
    }

    const usedHints = existing?.interactions?.length || 0;
    if (maxAiHints > 0 && usedHints >= maxAiHints) {
      // Guard: if the cap was reached but the previous request never got as
      // far as flipping `active`, close it out now.
      await AssignmentAiReport.updateOne(
        { subAssignmentId, questionId, studentId },
        { $set: { active: false, inactiveReason: "hint-limit" } }
      );
      return res.status(409).json({
        message: "AI hint limit reached for this question.",
        active: false,
        inactiveReason: "hint-limit",
        remainingHints: 0,
      });
    }

    // Resolve the display name once so the prompt matches the classwork path.
    let studentName = (studentNameFromBody || "").trim();
    if (!studentName) {
      try {
        const student = await User.findById(studentId)
          .select("firstName lastName name userName")
          .lean();
        studentName =
          [student?.firstName, student?.lastName].filter(Boolean).join(" ") ||
          student?.name ||
          student?.userName ||
          "";
      } catch (_) {}
    }

    let aiResult;
    try {
      aiResult = await getClassworkAiFeedback({
        questionText: question.questionText,
        answer: studentAnswer,
        correctAnswer: question.correctAnswer,
        questionImage: question.image,
        format: question.type,
        studentName,
        teacherId: parent.teacherId,
        // Question has no maxOutputTokens; util applies its own default.
        sessionId: parent.sessionId,
      });
    } catch (aiErr) {
      console.error("[AssignmentAi] Gemini call failed:", aiErr);
      return res.status(503).json({
        message: "AI feedback is temporarily unavailable. Please try again.",
        aiFailed: true,
      });
    }

    const isCorrect = Boolean(aiResult.correct);
    const interactionId = new mongoose.Types.ObjectId();
    const interactionAt = new Date();
    const part1 = toStringArray(aiResult.part1);
    const part2 = toStringArray(aiResult.part2);
    const part3 = toStringArray(aiResult.part3);
    const interaction = {
      _id: interactionId,
      questionText: question.questionText,
      studentAnswer,
      hintStream: aiResult.hintStream || "",
      part1,
      part2,
      part3,
      advancedChallenge: {
        congratulations: aiResult.advancedChallenge?.congratulations || "",
        question: aiResult.advancedChallenge?.question || "",
      },
      correct: isCorrect,
      timestamp: interactionAt,
    };

    const newUsedHints = usedHints + 1;
    let nextActive = true;
    let nextInactiveReason = null;
    if (isCorrect) {
      nextActive = false;
      nextInactiveReason = "correct";
    } else if (maxAiHints > 0 && newUsedHints >= maxAiHints) {
      nextActive = false;
      nextInactiveReason = "hint-limit";
    }

    const pushOps = { interactions: interaction };
    if (part3.length > 0) {
      pushOps.trainingHistory = {
        interactionId,
        part3,
        timestamp: interactionAt,
      };
    }

    const setOps = {
      studentName: studentName || "Unknown",
      lastAnswer: studentAnswer,
      lastHintStream: aiResult.hintStream || "",
      active: nextActive,
      inactiveReason: nextInactiveReason,
    };
    if (typeof aiResult.standardPromptHash === "string") {
      setOps.standardPromptHash = aiResult.standardPromptHash;
    }

    await AssignmentAiReport.findOneAndUpdate(
      { subAssignmentId, questionId, studentId },
      {
        $setOnInsert: {
          assignmentId: parent._id,
          subAssignmentId,
          questionId,
          studentId,
          originalQuestion: question.questionText,
        },
        $set: setOps,
        $push: pushOps,
      },
      { upsert: true, new: true }
    );

    const remainingHints =
      maxAiHints > 0 ? Math.max(0, maxAiHints - newUsedHints) : null;

    return res.status(200).json({
      active: nextActive,
      inactiveReason: nextInactiveReason,
      remainingHints,
      // Only reveal the ideal answer once the question is inactive — mirrors
      // classwork's behavior of showing the reference after correct/hint-cap.
      correctAnswer:
        !nextActive ? question.correctAnswer || [] : undefined,
      correct: isCorrect,
      feedback: projectAiForStudent(aiResult),
    });
  } catch (err) {
    console.error("[AssignmentAi] getAssignmentAiHint failed:", err);
    return res
      .status(500)
      .json({ message: "Error running AI hint", error: err.message });
  }
};

function serializeReportRow(r) {
  return {
    questionId: r.questionId,
    subAssignmentId: r.subAssignmentId,
    originalQuestion: r.originalQuestion,
    interactions: r.interactions || [],
    trainingHistory: r.trainingHistory || [],
    active: r.active !== false,
    inactiveReason: r.inactiveReason || null,
    lastAnswer: r.lastAnswer ?? null,
    lastHintStream: r.lastHintStream || "",
    standardPromptHash: r.standardPromptHash || "",
    studentName: r.studentName || "",
    updatedAt: r.updatedAt,
  };
}

// GET /api/assignment/ai-report/:subAssignmentId/:studentId
// Returns { report: [<per-question row>] } for the student answering flow.
export const getAssignmentAiReport = async (req, res) => {
  try {
    const { subAssignmentId, studentId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(subAssignmentId) ||
      !mongoose.Types.ObjectId.isValid(studentId)
    ) {
      return res.status(400).json({ message: "Invalid ObjectId in request." });
    }

    const rows = await AssignmentAiReport.find({
      subAssignmentId,
      studentId,
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ report: rows.map(serializeReportRow) });
  } catch (err) {
    console.error("[AssignmentAi] getAssignmentAiReport failed:", err);
    return res
      .status(500)
      .json({ message: "Error loading AI report", error: err.message });
  }
};

// GET /api/assignment/ai-report-by-parent/:assignmentId/:studentId
// Same shape as getAssignmentAiReport but keyed by the parent Assignment._id.
// Used by the post-submission report page (SingleAssignmentReport.jsx) which
// only has the parent id in scope.
export const getAssignmentAiReportByParent = async (req, res) => {
  try {
    const { assignmentId, studentId } = req.params;
    if (
      !mongoose.Types.ObjectId.isValid(assignmentId) ||
      !mongoose.Types.ObjectId.isValid(studentId)
    ) {
      return res.status(400).json({ message: "Invalid ObjectId in request." });
    }

    const rows = await AssignmentAiReport.find({
      assignmentId,
      studentId,
    })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({ report: rows.map(serializeReportRow) });
  } catch (err) {
    console.error(
      "[AssignmentAi] getAssignmentAiReportByParent failed:",
      err
    );
    return res
      .status(500)
      .json({ message: "Error loading AI report", error: err.message });
  }
};
