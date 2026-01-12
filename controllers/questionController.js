import Question from "../models/QuestionModel.js";
import { generateAIQuestions } from "./Ai-tasks/generateQuestions.js";

// CREATE
export const createQuestion = async (req, res) => {
  try {
    const question = new Question(req.body);
    await question.save();
    res.status(201).json(question);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// READ ALL
export const getAllQuestions = async (req, res) => {
  try {
    const questions = await Question.find();
    res.status(200).json(questions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// READ ONE
export const getQuestionById = async (req, res) => {
  try {
    const question = await Question.findById(req.params.id);
    if (!question) return res.status(404).json({ error: "Question not found" });
    res.status(200).json(question);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// UPDATE
export const updateQuestion = async (req, res) => {
  try {
    const updated = await Question.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!updated) return res.status(404).json({ error: "Question not found" });
    res.status(200).json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// DELETE
export const deleteQuestion = async (req, res) => {
  try {
    const deleted = await Question.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Question not found" });
    res.status(200).json({ message: "Question deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Search controller for nested metadata
export const searchQuestions = async (req, res) => {
  try {
    const { tags, difficulty, topic, language } = req.query;
    console.log(
      "tags, difficulty, topic, language",
      tags,
      difficulty,
      topic,
      language
    );
    const query = {};

    if (topic) query.topic = topic;
    if (language) query.language = language;
    if (difficulty) query["metadata.difficulty"] = difficulty;

    if (tags) {
      const tagArray = Array.isArray(tags)
        ? tags
        : tags.split(",").map((tag) => tag.trim());
      query["metadata.tags"] = { $in: tagArray };
    }

    const results = await Question.find(query);
    res
      .status(200)
      .json(results.length !== 0 ? results : { message: "No questions found" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
};

// GET /admin/questions?status=pending
export const getFilterAllQuestions = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) {
      filter.status = req.query.status;
    }

    const questions = await Question.find(filter);
    res.status(200).json({ success: true, questions });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch questions", error });
  }
};

// PUT /admin/questions/:questionId { status: 'approved' or 'rejected' }
export const updateQuestionStatus = async (req, res) => {
  const { questionId } = req.params;
  const { status } = req.body;

  if (!["approved", "rejected"].includes(status)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid status value" });
  }

  try {
    const question = await Question.findByIdAndUpdate(
      questionId,
      { status },
      { new: true }
    );

    if (!question) {
      return res
        .status(404)
        .json({ success: false, message: "Question not found" });
    }

    res
      .status(200)
      .json({ success: true, message: `Question ${status}`, question });
  } catch (error) {
    res.status(500).json({ success: false, message: "Update failed", error });
  }
};

export const generateQuestionsFromAI = async (req, res) => {
  const {
    classroomId,
    sessionId,
    teacherId,
    studentId,
    course,
    topic,
    numberOfQuestions,
    type,
    mcqOptions,
    difficulty,
    fineTuningInstructions,
    language,
    maxMarks,
  } = req.body;

  try {
    const generatedQuestions = await generateAIQuestions({
      numberOfQuestions,
      type,
      mcqOptions,
      difficulty,
      course,
      topic,
      fineTuningInstructions,
      language,
      maxMarks,
    });

    const finalQuestions = generatedQuestions.map((q) => ({
      ...q,
      classroomId,
      sessionId,
      teacherId,
      studentId,
      course,
      topic,
      maxMarks,
      // status: "approved",
      fineTuningInstructions,
      language,
    }));

    const saved = await Question.insertMany(finalQuestions);

    res.status(201).json({
      message: "Questions generated and saved successfully.",
      questions: saved,
    });
  } catch (error) {
    console.error("AI generation failed:", error);
    res.status(500).json({ error: error.message });
  }
};

export const getQuestionsBySession = async (req, res) => {
  const { sessionId } = req.params;

  try {
    const questions = await Question.find({ sessionId })
      .populate("teacherId", "lastName firstName email")
      .populate("studentId", "lastName firstName email");

    res.status(200).json({
      message: `Questions for session ${sessionId}`,
      count: questions.length,
      questions,
    });
  } catch (error) {
    console.error("Error fetching questions by sessionId:", error);
    res.status(500).json({ error: error.message });
  }
};
