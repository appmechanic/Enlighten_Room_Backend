import { GoogleGenAI, Type } from "@google/genai";
import { withGeminiRetry, parseFirstJsonObject } from "../../utils/geminiCommon.js";
import TeacherAIConfig from "../../models/teacherAiConfigModel.js";

// Assignment grader. Previously used gpt-4o via OpenAI, but the deployed
// environment ships a Gemini key (Google AIza…) in OPENAI_API_KEY, so every
// call 401'd and every submission fell through to the rule-based fallback.
// Migrating to Gemini keeps this on the single API key the rest of the
// project already uses (classwork feedback, assignment questions, hints).
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = "gemini-2.5-flash";

export async function gradeDynamic(
  questionsWithAnswers = [],
  { includeRemarks = true, teacherId = null } = {}
) {
  if (!Array.isArray(questionsWithAnswers) || questionsWithAnswers.length === 0) {
    return { graded: [], overall_remarks: "" };
  }

  // Include a stable per-question `id` so the caller matches results back
  // to the original without relying on exact question-text equality.
  const formattedInput = questionsWithAnswers
    .map(
      (item, index) => `
      ${index + 1}.
      Question ID: ${item.questionId || item.id || index}
      Question: ${item.question}
      Question Type: ${item.type || "MCQ"}
      Correct Answer(s): ${
        Array.isArray(item.correctAnswer)
          ? item.correctAnswer.join(" | ")
          : item.correctAnswer || ""
      }
      Student Answer: ${item.answer}
      Max Marks: ${item.maxMarks ? item.maxMarks : 1}
      `
    )
    .join("\n");

  const baseRules = `
You are an expert educator AI. Grade each student answer out of the specified Max Marks.

For each question in the input, you will see:
  - "Question ID: ..."         → an opaque identifier — echo it back verbatim as "id"
  - "Correct Answer(s): ..."   → the ground truth from the system
  - "Student Answer: ..."      → what the student wrote

You MUST treat the provided "Correct Answer(s)" as the ONLY source of truth.
Do NOT use your own knowledge to decide what is correct.

Grading rules:
- If question type is MCQ:
  - Full marks ONLY if the student's answer matches (case-insensitive, trim spaces)
    ANY of the provided "Correct Answer(s)".
  - Otherwise 0 marks.
- If question type is INPUT / textbox / fill-blanks:
  - Treat "Correct Answer(s)" as reference.
  - Give partial marks if the answer is partially correct; use 0, 0.5, 0.7, 1 × maxMarks.

Feedback rules:
- "feedback" must never be blank. Even when the student is wrong, briefly explain what was expected.
- Keep feedback to 1–2 short sentences.
`.trim();

  let teacherConfigSection = "";
  if (teacherId) {
    try {
      const config = await TeacherAIConfig.findOne({ user: teacherId }).lean();
      if (config) {
        const { prompt, style, features } = config;
        teacherConfigSection = `
----------------------------
Teacher/Tutor custom grading preferences:

Teacher prompt (what to focus on):
${prompt || ""}

Preferred style (tone, length, format):
${style || ""}

Requested AI features / behaviour:
${features || ""}
`.trim();
      }
    } catch (err) {
      console.error("Error loading TeacherAIConfig:", err);
    }
  }

  const remarksInstruction = includeRemarks
    ? 'Also fill "overall_remarks" with a 3-5 line summary of the student\'s overall performance.'
    : 'Leave "overall_remarks" as an empty string.';

  const systemPrompt = `${baseRules}

${teacherConfigSection}

${remarksInstruction}
`.trim();

  const userPrompt = `${systemPrompt}

Grade the following:
${formattedInput}
`;

  // Response schema: an object with a graded[] array + optional remarks so
  // we don't have to peel a trailing object off a naked array like the old
  // OpenAI path did.
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      graded: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            id: { type: Type.STRING, description: "Echo of the input Question ID." },
            question: { type: Type.STRING },
            answer: { type: Type.STRING },
            score: { type: Type.NUMBER },
            maxMarks: { type: Type.NUMBER },
            feedback: { type: Type.STRING, description: "1-2 sentences. Never blank." },
          },
          required: ["id", "score", "maxMarks", "feedback"],
        },
      },
      overall_remarks: { type: Type.STRING },
    },
    required: ["graded"],
  };

  let response;
  try {
    response = await withGeminiRetry(
      () =>
        ai.models.generateContent({
          model: MODEL,
          contents: userPrompt,
          config: {
            responseMimeType: "application/json",
            responseSchema,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 4000,
        tag: "ai-grader",
      }
    );
  } catch (err) {
    console.error(
      `ai-grader: Gemini call failed (status=${err?.status ?? "n/a"}, model=${MODEL}):`,
      err?.message || err,
    );
    return { graded: [], overall_remarks: "" };
  }

  const parsed = parseFirstJsonObject(response?.text, { tag: "ai-grader" });
  if (!parsed || !Array.isArray(parsed.graded)) {
    console.error("ai-grader: no parseable graded array in response");
    return { graded: [], overall_remarks: "" };
  }
  return {
    graded: parsed.graded,
    overall_remarks: parsed.overall_remarks || "",
  };
}
