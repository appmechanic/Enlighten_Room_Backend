import { GoogleGenerativeAI } from "@google/generative-ai";
import ClassworkModel from '../models/ClassworkModel.js';
import { getExpiryState, getQuestionAiExpirySeconds } from '../utils/classworkExpiry.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * POST /api/gemini-hint
 * Body: { 
 *   questionId: string, 
 *   studentAnswer: string | any, 
 *   studentName?: string, 
 *   image?: string (base64),
 *   roomId: string,
 *   classworkId?: string 
 * }
 * Returns: 
 *   - If correct: { correct: true, message: "Answer is correct" }
 *   - If incorrect: { correct: false, hint: string }
 */ 
const getGeminiHint = async (req, res) => {
  try {
    const { studentAnswer, studentName, questionId, roomId, classworkId, image } = req.body;
    
    if (!questionId || !roomId) {
      return res.status(400).json({ error: 'questionId and roomId are required.' });
    }

    if (studentAnswer === undefined && !image) {
      return res.status(400).json({ error: 'Either studentAnswer or image is required.' });
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

    // Check if the student's answer is an image (handwriting) or text
    const isImageAnswer = typeof studentAnswer === 'string' && (studentAnswer.includes('data:image') || studentAnswer.startsWith('/9j') || studentAnswer.startsWith('iVBORw'));
    
    let isCorrect = false;
    let interpretedAnswer = null;


    if (isImageAnswer) {
      // Answer is an image (handwriting) - use AI to interpret and evaluate
      const result = await evaluateHandwritingAnswer(studentAnswer, question, genAI);
      isCorrect = result.isCorrect;
      interpretedAnswer = result.interpretedText;
    } else {
      // Answer is text - do simple string comparison
      isCorrect = checkAnswerCorrectness(studentAnswer, question.correctAnswer, question.format);
    }

    // If answer is correct, auto-submit and generate a new advanced question
    if (isCorrect) {
      // Auto-submit the answer for the student
      if (studentName) {
        // Find or create the student's submission
        let submittedIndex = question.submitted.findIndex(
          (s) => s.studentName === studentName
        );
        if (submittedIndex === -1) {
          // Add new submission if not found
          question.submitted.push({
            studentName,
            answer: interpretedAnswer || studentAnswer,
            isCorrect: true,
            preSubmitAnswers: [{ status: 'correct', interpretedAnswer, createdAt: new Date() }],
            createdAt: new Date(),
          });
          await question.save();
        } else {
          // Update existing submission
          const updatePath = `submitted.${submittedIndex}.preSubmitAnswers`;
          await ClassworkModel.updateOne(
            { _id: question._id },
            {
              $set: {
                [`submitted.${submittedIndex}.answer`]: interpretedAnswer || studentAnswer,
                [`submitted.${submittedIndex}.isCorrect`]: true,
              },
              $push: { [updatePath]: { status: 'correct', interpretedAnswer, createdAt: new Date() } },
            }
          );
        }
      }

      // Check if classwork is expired
      const aiExpiryState = getExpiryState(question.createdAt, getQuestionAiExpirySeconds(question));
      if (aiExpiryState.isExpired) {
        return res.json({ correct: true, message: 'Classwork expired. No more questions.' });
      }

      // Generate a similar but more advanced question using AI
      const systemInstruction = `
        You are an expert teacher. Given the following question and answer, generate a new question that is similar in topic but more advanced in difficulty. The new question should challenge the student further and help them deepen their understanding. Only return the new question text, nothing else.
      `;
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        systemInstruction,
      });
      const prompt = `
        Original question: ${question.question}
        Correct answer: ${question.correctAnswer}
        Please generate a new, more advanced question for the student on the same topic.
      `;
      let newQuestionText = '';
      try {
        const result = await model.generateContent([prompt]);
        newQuestionText = (result.response && result.response.text && result.response.text()) || '';
      } catch (err) {
        console.error('Error generating advanced question:', err);
        newQuestionText = '';
      }

      // Optionally, you could create a new ClassworkModel entry for the new question, or just return it to the student
      return res.json({
        correct: true,
        message: 'Answer is correct! Here is a new, more advanced question.',
        advancedQuestion: newQuestionText,
        expired: false,
      });
    }

    // Answer is incorrect - generate a personalized hint
    const systemInstruction = `
      You are a warm, patient, and encouraging tutor (like a caring parent).
      A student has answered a question incorrectly. Your job is to provide a short, 
      supportive, and personalized hint that addresses their specific mistake.

      Rules:
      - Acknowledge the student's answer and what they tried
      - Give them a hint that guides them toward the correct approach
      - Never give the final answer directly
      - Keep it concise, child-friendly, and encouraging
      - Start with the student's name if provided
      ${studentName ? `- Address the student as "${studentName}"` : ''}
      `;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction,
    });

    // Build the prompt with question and student's incorrect answer
    let hintPrompt = `
Question: ${question.question}

The student ${studentName ? `"${studentName}" ` : ''}answered: ${interpretedAnswer || JSON.stringify(studentAnswer)}

Please provide a personalized hint based on their specific answer.
    `;

    let inputArr = [hintPrompt];

    // Add image if the student's answer is an image (handwriting)
    if (isImageAnswer) {
      const base64Image = typeof studentAnswer === 'string' && studentAnswer.includes(',') 
        ? studentAnswer.split(',')[1] 
        : studentAnswer;
      inputArr.push({
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg',
        },
      });
    }

    // Add additional image if provided
    if (image) {
      const base64Image = image.split(',')[1] || image;
      inputArr.push({
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg',
        },
      });
    }

    const result = await model.generateContent(inputArr);
    const hint = (result.response && result.response.text && result.response.text()) || 'Please try again.';

    // Save the AI hint to preSubmitAnswers for the student
    if (studentName) {
      const submittedIndex = question.submitted.findIndex(
        (s) => s.studentName === studentName
      );
      if (submittedIndex !== -1) {
        const updatePath = `submitted.${submittedIndex}.preSubmitAnswers`;
        await ClassworkModel.updateOne(
          { _id: question._id },
          { $push: { [updatePath]: { hint, studentAnswer: interpretedAnswer || studentAnswer, createdAt: new Date() } } }
        );
      }
    }

    return res.json({ correct: false, hint });
  } catch (error) {
    console.error('Gemini hint error:', error);
    return res.status(500).json({ error: 'Failed to generate hint.' });
  }
};

/**
 * Helper function to check if the student's answer matches the correct answer
 * Accounts for different question formats (multiple choice, text, fill-in-blank, etc.)
 */
const checkAnswerCorrectness = (studentAnswer, correctAnswer, format) => {
  if (!correctAnswer) {
    return false; // No correct answer defined
  }

  // Normalize inputs for comparison
  const normalize = (val) => {
    if (typeof val === 'string') {
      return val.trim().toLowerCase();
    }
    return String(val).toLowerCase();
  };

  const normalizedStudent = normalize(studentAnswer);
  const normalizedCorrect = normalize(correctAnswer);

  // Exact match comparison
  if (normalizedStudent === normalizedCorrect) {
    return true;
  }

  // For arrays or multiple answers
  if (Array.isArray(correctAnswer)) {
    return correctAnswer.some(ca => normalize(ca) === normalizedStudent);
  }

  return false;
};

/**
 * Helper function to evaluate handwriting/image answers using AI
 * Interprets the handwritten answer and compares it against the correct answer
 */
const evaluateHandwritingAnswer = async (imageData, question, genAI) => {
  try {
    const systemInstruction = `
      You are an expert at reading handwritten answers. Your task is to:
      1. Carefully interpret the handwritten answer in the image
      2. Extract the exact answer text
      3. Compare it against the correct answer provided
      4. Respond with JSON format: { "interpretedText": "...", "isCorrect": true/false }
      
      Be lenient with handwriting variations (spelling, spacing) but strict with numerical/factual correctness.
    `;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction,
    });

    const base64Image = imageData.includes(',') ? imageData.split(',')[1] : imageData;
    
    const prompt = `
Correct answer: ${JSON.stringify(question.correctAnswer)}
Question: ${question.question}

Please interpret the handwritten answer in the image and determine if it's correct.
    `;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Image,
          mimeType: 'image/jpeg',
        },
      },
    ]);

    const responseText = result.response.text();
    
    // Parse the JSON response from the AI
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isCorrect: parsed.isCorrect || false,
        interpretedText: parsed.interpretedText || 'Unable to read',
      };
    }

    // Fallback: treat as incorrect if parsing fails
    return {
      isCorrect: false,
      interpretedText: responseText.substring(0, 100),
    };
  } catch (error) {
    console.error('Error evaluating handwriting:', error);
    return {
      isCorrect: false,
      interpretedText: 'Error reading handwriting',
    };
  }
};

export default getGeminiHint;