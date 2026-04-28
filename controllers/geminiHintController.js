import { GoogleGenerativeAI } from "@google/generative-ai";
import ClassworkModel from '../models/ClassworkModel.js';
import { getExpiryState, getQuestionAiExpirySeconds } from '../utils/classworkExpiry.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * POST /api/gemini-hint
 * Body: { prompt: string, image: string (base64), studentName?: string }
 * Returns: { hint: string }
 */ 
const getGeminiHint = async (req, res) => {
  try {

    const { prompt, image, studentName, questionId, roomId, classworkId } = req.body;
    if (!prompt && !image) {
      return res.status(400).json({ error: 'Either prompt or image is required.' });
    }

    if (!questionId || !roomId) {
      return res.status(400).json({ error: 'questionId and roomId are required.' });
    }

    const lookup = classworkId
      ? { _id: classworkId, id: questionId, roomId }
      : { id: questionId, roomId };
    const question = await ClassworkModel.findOne(lookup).sort({ createdAt: -1 });

    if (!question) {
      return res.status(404).json({ error: 'Question not found for this room.' });
    }

    if (question.aiAllowed === false) {
      return res.status(403).json({ error: 'AI hints are disabled for this question.' });
    }

    const aiExpiryState = getExpiryState(question.createdAt, getQuestionAiExpirySeconds(question));
    // if (aiExpiryState.isExpired) {
    //   return res.status(403).json({ error: 'AI hint time expired for this question.' });
    // }

    const systemInstruction = `
      You are a warm, patient, and encouraging tutor (like a caring parent)
      who reads a student's classwork image and provides short, supportive,
      and educational guidance.

      Rules:
      - Start advice with the student's name if provided
      - Never give final answers unless failed 3 times
      - Be concise, child-friendly, and encouraging
      `;


    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction,
    });

    let inputArr = [];
    if (image) {
      const base64Image = image.split(',')[1] || image;
      inputArr.push({
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg', // or image/png
        },
      });
    }
    if (prompt) {
      inputArr.push(studentName ? `${studentName}: ${prompt}` : prompt);
    }
    const result = await model.generateContent(inputArr);

    const hint = (result.response && result.response.text && result.response.text()) || 'No answer';

    // Save the AI hint to preSubmitAnswers for the student in the submitted array
    if (studentName) {
      // Find the submitted entry for this student
      const submittedIndex = question.submitted.findIndex(
        (s) => s.studentName === studentName
      );
      if (submittedIndex !== -1) {
        // Update preSubmitAnswers for the student
        const updatePath = `submitted.${submittedIndex}.preSubmitAnswers`;
        await ClassworkModel.updateOne(
          { _id: question._id },
          { $push: { [updatePath]: { hint, createdAt: new Date() } } }
        );
      }
    }
    return res.json({ hint });
  } catch (error) {
    console.error('Gemini hint error:', error);
    return res.status(500).json({ error: 'Failed to generate hint.' });
  }
};

export default getGeminiHint;