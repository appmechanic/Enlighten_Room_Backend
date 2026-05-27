import { GoogleGenAI } from "@google/genai";
import fetch from "node-fetch";
import TeacherAIConfig from "../models/teacherAiConfigModel.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
  if (!answer) return null;
  if (typeof answer === "string") {
    return /^data:image\//i.test(answer) ? answer : null;
  }
  if (typeof answer === "object" && typeof answer.imageUrl === "string" && answer.imageUrl.trim()) {
    return answer.imageUrl;
  }
  return null;
}

async function sourceToInlineData(source) {
  if (!source || typeof source !== "string") return null;

  const dataUrlMatch = source.match(/^data:(.+?);base64,(.+)$/);
  if (dataUrlMatch) {
    return { mimeType: dataUrlMatch[1], base64: dataUrlMatch[2] };
  }

  const response = await fetch(source);
  const buffer = await response.arrayBuffer();
  return { base64: Buffer.from(buffer).toString("base64"), mimeType: "image/jpeg" };
}

const STANDARD_STUDENT_PROMPT = `
I am having a lesson, and my teacher provided me with this app to ask for hints from you. If not all my contents/steps and answers are correct, please tell me:

1) Which one content/step is correct just before I stuck?
2) For the first content/step I stuck, please guide me how to correct it by giving me useful formulas, keywords, concepts, knowledge, methods, strategies, theorems.
3) Only for this content/step I stuck, what should I practice more after class? What useful formula, keyword, concept, knowledge, method, strategy, and theorem should I pay attention to? Please give me specific but short comment focusing on my weakness in this content/step only.

If all my answers of all the parts of this entire question are completed and correct, please give me a follow-up question that matches the difficulty and skill level of the original question. The follow-up MUST:
- Use the SAME operation(s) and concept(s) as the original (e.g., if the original is single-digit addition, stay on single-digit addition; do not jump to multi-step, division, remainders, or word problems unless the original already had those).
- Use numbers within the same range as the original (e.g., if the original uses numbers up to 10, stay within 10–20 at most).
- Be a SINGLE-STEP problem with ONE numeric answer, unless the original itself was multi-step.
- Use short, simple language appropriate for a child who just solved the original question. Avoid long word problems if the original wasn't a word problem.
- Include a brief, gentle message of peace, love, or positive values, kept to one short sentence.
`.trim();

const TEACHER_PROMPT_INTRO = `
The following is my teacher's personalized prompt. Please follow his/her advice and the above structure to give me feedback if the personalized prompt is good to my learning. But please ignore it if it doesn't fit my needs.
`.trim();

const JSON_RESPONSE_RULES = `
You MUST respond with a single JSON object only (no prose, no markdown fences). Schema:
{
  "correct": boolean,           // true only if every content/step and answer is complete and correct
  "part1": string,              // (incorrect case) which step is correct just before the student got stuck; "" if correct
  "part2": string,              // (incorrect case) guidance for the first stuck step; (correct case) a brief confirmation that the student's answer is correct
  "part3": string,              // (incorrect case) practice recommendations for after class; "" if correct
  "newQuestion": string         // (correct case) the more advanced similar question with a positive message; "" if incorrect
}
Use the student's name when given. Keep each field child-friendly and concise.
`.trim();

async function buildTeacherSection(teacherId) {
  if (!teacherId) return "";
  try {
    const config = await TeacherAIConfig.findOne({ user: teacherId }).lean();
    if (!config) return "";
    const { prompt, style, features } = config;
    const parts = [];
    if (prompt) parts.push(`Teacher prompt: ${prompt}`);
    if (style) parts.push(`Preferred style: ${style}`);
    if (features) parts.push(`Requested features: ${features}`);
    if (!parts.length) return "";
    return `${TEACHER_PROMPT_INTRO}\n\n${parts.join("\n")}`;
  } catch (err) {
    console.error("[ClassworkFeedback] Failed to load TeacherAIConfig:", err);
    return "";
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateContentWithRetry(request) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.error?.code;
      if (!RETRYABLE_STATUSES.has(status) || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
      console.warn(
        `[ClassworkFeedback] Gemini ${status} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${backoff + jitter}ms`
      );
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

function parseJsonResponse(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    console.error("[ClassworkFeedback] JSON parse failed:", err, text);
    return null;
  }
}

export async function getClassworkAiFeedback({
  questionText,
  answer,
  correctAnswer,
  questionImage,
  format,
  studentName,
  teacherId,
}) {
  const teacherSection = await buildTeacherSection(teacherId);

  const systemInstruction = [
    STANDARD_STUDENT_PROMPT,
    teacherSection,
    JSON_RESPONSE_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");

  const normalizedAnswerText = normalizeAnswerText(answer);
  const referenceAnswer = normalizeAnswerText(correctAnswer);
  const answerImageSource = getAnswerImageSource(answer);

  const promptLines = [
    studentName ? `Student name: ${studentName}` : null,
    `Question: ${questionText}`,
    format ? `Answer Format: ${format}` : null,
    referenceAnswer ? `Reference / Correct Answer: ${referenceAnswer}` : null,
    `Student Answer: ${normalizedAnswerText || "[No text provided]"}`,
    questionImage ? "A question image is attached." : null,
    answerImageSource ? "A student answer image is attached. Inspect the handwriting/image carefully." : null,
  ].filter(Boolean);

  const parts = [];

  if (questionImage) {
    const imageData = await sourceToInlineData(questionImage).catch(() => null);
    if (imageData) {
      parts.push({ text: "Question image:" });
      parts.push({ inlineData: { data: imageData.base64, mimeType: imageData.mimeType } });
    }
  }

  if (answerImageSource) {
    const answerImageData = await sourceToInlineData(answerImageSource).catch(() => null);
    if (answerImageData) {
      parts.push({ text: "Student answer image:" });
      parts.push({ inlineData: { data: answerImageData.base64, mimeType: answerImageData.mimeType } });
    }
  }

  parts.push({ text: promptLines.join("\n") });

  const result = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
    config: { systemInstruction, responseMimeType: "application/json" },
  });

  const responseText = result.text || "";
  const parsed = parseJsonResponse(responseText);

  if (!parsed) {
    return {
      correct: false,
      part1: "",
      part2: "Sorry, I couldn't generate feedback this time. Please try again.",
      part3: "",
      newQuestion: "",
      raw: responseText,
    };
  }

  return {
    correct: Boolean(parsed.correct),
    part1: typeof parsed.part1 === "string" ? parsed.part1 : "",
    part2: typeof parsed.part2 === "string" ? parsed.part2 : "",
    part3: typeof parsed.part3 === "string" ? parsed.part3 : "",
    newQuestion: typeof parsed.newQuestion === "string" ? parsed.newQuestion : "",
    raw: responseText,
  };
}
