import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function normalizeAnswerText(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => `Blank ${index + 1}: ${String(entry ?? "")}`)
      .join("\n");
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string" && value.text.trim()) {
      return value.text.trim();
    }

    if (typeof value.value === "string" && value.value.trim()) {
      return value.value.trim();
    }

    if (value.type === "image") {
      return "Student submitted the answer as an image/handwriting sample.";
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  if (typeof value === "string") {
    return /^data:image\//i.test(value)
      ? "Student submitted the answer as an image/handwriting sample."
      : value;
  }

  return value == null ? "" : String(value);
}

function getAnswerImageSource(answer) {
  if (!answer) {
    return null;
  }

  if (typeof answer === "string") {
    return /^data:image\//i.test(answer) ? answer : null;
  }

  if (typeof answer === "object") {
    console.log("[Gemini AI] Inspecting answer object for image source.", answer);    
    if (typeof answer.imageUrl === "string" && answer.imageUrl.trim()) {
      return answer.imageUrl;
    }
  }

  return null;
}

async function sourceToInlineData(source) {
  if (!source || typeof source !== "string") {
    return null;
  }

  const dataUrlMatch = source.match(/^data:(.+?);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      mimeType: dataUrlMatch[1],
      base64: dataUrlMatch[2],
    };
  }

  return urlToBase64(source);
}

/**
 * Convert URL → base64
 */
async function urlToBase64(url) {
  console.log("[Gemini AI] Fetching remote image for evaluation:", url);
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
  image,
  correctAnswer,
  format
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
- Use any attached images as part of the question or student's answer
- Use the reference answer when provided
- If unsure, return isCorrect: false
- ONLY return JSON

Format:
{"aiScore": number, "feedback": string, "isCorrect": boolean}
`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction,
    });

    const normalizedAnswerText = normalizeAnswerText(answer);
    const answerImageSource = getAnswerImageSource(answer);
    const referenceAnswer = normalizeAnswerText(correctAnswer);
    const gradingMode = answerImageSource ? "image" : "text";

    console.log("[Gemini AI] Starting grading", {
      format,
      gradingMode,
      hasQuestionImage: Boolean(image),
      hasStudentAnswerImage: Boolean(answerImageSource),
      hasReferenceAnswer: Boolean(referenceAnswer),
      answerPreview: normalizedAnswerText?.slice(0, 160) || "",
    });

    const prompt = [
      `Question: ${question}`,
      format ? `Answer Format: ${format}` : null,
      referenceAnswer ? `Reference Answer: ${referenceAnswer}` : null,
      `Student Answer: ${normalizedAnswerText || "[No text provided]"}`,
      image ? "A question image is attached." : null,
      answerImageSource ? "A student answer image is attached. Inspect the handwriting/image carefully." : null,
    ]
      .filter(Boolean)
      .join("\n");

    let parts = [];

    if (image) {
      console.log("[Gemini AI] Attaching question image for grading.");
      const imageData = await sourceToInlineData(image);

      if (imageData) {
        parts.push({ text: "Question image:" });
        parts.push({
          inlineData: {
            data: imageData.base64,
            mimeType: imageData.mimeType,
          },
        });
      }
    }

    if (answerImageSource) {
      console.log("[Gemini AI] Grading against student answer image.", {
        sourceType: answerImageSource.startsWith("data:image/") ? "base64" : "url",
      });

      const answerImageData = await sourceToInlineData(answerImageSource);

      if (answerImageData) {
        parts.push({ text: "Student answer image:" });
        parts.push({
          inlineData: {
            data: answerImageData.base64,
            mimeType: answerImageData.mimeType,
          },
        });
      }
    } else {
      console.log("[Gemini AI] Grading against student answer text only.");
    }

    parts.push({
      text: prompt,
    });

    console.log("[Gemini AI] Prompt prepared.", {
      partsCount: parts.length,
      prompt,
    });

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

    const match = response.match(/\{[\s\S]*\}/);

    if (match) {
      const json = JSON.parse(match[0]);

      let score = Number(json.aiScore) || 0;

      // Normalize score
      if (score > 10) score = Math.round((score / 100) * 10);
      if (score < 0) score = 0;
      if (score > 10) score = 10;

      console.log("[Gemini AI] Parsed grading result.", {
        aiScore: score,
        isCorrect:
          typeof json.isCorrect === "boolean"
            ? json.isCorrect
            : String(json.isCorrect).toLowerCase() === "true",
        hasFeedback: Boolean(json.feedback),
      });

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
    console.error("[Gemini AI] Scoring error:", err);

    return {
      aiScore: 0,
      feedback: "Gemini AI scoring failed.",
      isCorrect: false,
    };
  }
}