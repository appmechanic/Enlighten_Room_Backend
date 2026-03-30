import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Convert URL → base64
 */
async function urlToBase64(url) {
  const response = await fetch(url);
  const buffer = await response.arrayBuffer();

  return {
    base64: Buffer.from(buffer).toString("base64"),
    mimeType: "image/jpeg",
  };
}

/**
 * Get AI-based score, feedback, and correctness for a student's answer using Gemini.
 */
export async function getGeminiScoreAndFeedback(
  question,
  answer,
  image // ✅ added image param
) {
  try {
    const systemInstruction = `
You are an expert teacher and grader.

Your job:
- Decide if the student's answer is correct
- Give score (0 to 10)
- Give short constructive feedback

Rules:
- Be flexible with wording
- Use image if provided as part of answer
- If unsure, return isCorrect: false
- ONLY return JSON

Format:
{"aiScore": number, "feedback": string, "isCorrect": boolean}
`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
    });

    const prompt = `Question: ${question}\nStudent Answer: ${answer}`;

    let parts = [];

    // ✅ Add image if exists
    if (image) {
      const { base64, mimeType } = await urlToBase64(image);

      parts.push({
        inlineData: {
          data: base64,
          mimeType,
        },
      });
    }

    // ✅ Always add text
    parts.push({
      text: prompt,
    });

    // ✅ Correct Gemini call (important)
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts,
        },
      ],
    });

    const response = result.response.text();

    console.log("[Gemini AI Response]", response);

    // ✅ Extract JSON safely
    const match = response.match(/\{[\s\S]*\}/);

    if (match) {
      const json = JSON.parse(match[0]);

      let score = Number(json.aiScore) || 0;

      // Normalize score
      if (score > 10) score = Math.round((score / 100) * 10);
      if (score < 0) score = 0;
      if (score > 10) score = 10;

      return {
        aiScore: score,
        feedback: json.feedback || "",
        isCorrect:
          typeof json.isCorrect === "boolean"
            ? json.isCorrect
            : String(json.isCorrect).toLowerCase() === "true",
      };
    }

    return {
      aiScore: 0,
      feedback: "No feedback generated.",
      isCorrect: false,
    };
  } catch (err) {
    console.error("Gemini AI scoring error:", err);

    return {
      aiScore: 0,
      feedback: "Gemini AI scoring failed.",
      isCorrect: false,
    };
  }
}