import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Get AI-based score, feedback, and correctness for a student's answer using Gemini.
 * @param {string} question - The question text.
 * @param {any} answer - The student's answer.
 * @param {any} correctAnswer - The correct answer for the question.
 * @returns {Promise<{ aiScore: number, feedback: string, isCorrect: boolean }>}
 */
export async function getGeminiScoreAndFeedback(question, answer, correctAnswer) {
  try {
    const systemInstruction = `
      You are an expert teacher and grader. Given the following question, the correct answer, and a student's answer, provide:\n- a score from 0 to 10 (as aiScore)\n- a short, constructive feedback (as feedback)\n- and whether the answer is correct (as isCorrect: true/false).\n\nRespond in JSON format: {\"aiScore\": <score>, \"feedback\": \"<feedback>\", \"isCorrect\": <true/false>}`;

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction,
    });

    const prompt = `Question: ${question}\nCorrect Answer: ${correctAnswer}\nStudent Answer: ${answer}`;
    const result = await model.generateContent([prompt]);
    const response = (result.response && result.response.text && result.response.text()) || '';
    const match = response.match(/\{[\s\S]*\}/);
    if (match) {
      const json = JSON.parse(match[0]);
      // If Gemini returns a score out of 100, scale it to 10
      let score = Number(json.aiScore) || 0;
      if (score > 10) score = Math.round((score / 100) * 10);
      if (score < 0) score = 0;
      if (score > 10) score = 10;
      return {
        aiScore: score,
        feedback: json.feedback || '',
        isCorrect: typeof json.isCorrect === 'boolean' ? json.isCorrect : String(json.isCorrect).toLowerCase() === 'true',
      };
    }
    return { aiScore: 0, feedback: 'No feedback generated.', isCorrect: false };
  } catch (err) {
    console.error('Gemini AI scoring error:', err);
    return { aiScore: 0, feedback: 'Gemini AI scoring failed.', isCorrect: false };
  }
}
