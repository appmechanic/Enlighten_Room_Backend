import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * POST /api/gemini-hint
 * Body: { prompt: string, image: string (base64), studentName?: string }
 * Returns: { hint: string }
 */
const getGeminiHint = async (req, res) => {
  try {

    const { prompt, image, studentName } = req.body;
    if (!prompt && !image) {
      return res.status(400).json({ error: 'Either prompt or image is required.' });
    }

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
    return res.json({ hint });
  } catch (error) {
    console.error('Gemini hint error:', error);
    return res.status(500).json({ error: 'Failed to generate hint.' });
  }
};

export default getGeminiHint;