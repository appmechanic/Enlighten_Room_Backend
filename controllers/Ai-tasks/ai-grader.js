import { OpenAI } from "openai";
import TeacherAIConfig from "../../models/teacherAiConfigModel.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function gradeDynamic(
  questionsWithAnswers = [],
  { includeRemarks = true, teacherId = null } = {}
) {
  // console.log("Grading with AI for questions:", questionsWithAnswers);
  const formattedInput = questionsWithAnswers
    .map(
      (item, index) => `
      ${index + 1}.
      Question: ${item.question}
      Question Type: ${
        item.type || "MCQ"
      }  // optional, agar tum type bhej rahe ho
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

  // console.log("Formatted Input for AI:", formattedInput);
  const baseRules = `
You are an expert educator AI. Grade each student answer out of the specified Max Marks.
You must return a JSON array ONLY (no text or formatting around it). Each item must include:

- "question": the question text exactly as given
- "answer": the student answer text exactly as given
- "score": the numeric score
- "maxMarks": the max possible marks
- "feedback": brief feedback on the answer
VERY IMPORTANT ABOUT CORRECTNESS:

- For each question in the input, you will see:
  - "Correct Answer(s): ..."  → this is the ground truth from the system
  - "Student Answer: ..."     → this is what the student wrote

- You MUST treat the provided "Correct Answer(s)" as the ONLY source of truth.
  - Do NOT use your own knowledge to decide what is correct.
  - If the student's answer matches one of the "Correct Answer(s)" (case-insensitive, ignoring extra spaces),
    then it is correct.
  - If it does NOT match any of the provided "Correct Answer(s)", then it is incorrect.

Grading rules:

- If question type is MCQ:
  - Give FULL marks ONLY if the student's answer matches (after trimming spaces and ignoring case)
    ANY of the provided "Correct Answer(s)".
  - Otherwise, give 0 marks.
  - Do NOT mark an answer as wrong if it clearly matches the provided correct answer string.

- If question type is INPUT:
  - If a "Correct Answer(s)" field is present, still treat it as the ground truth reference.
  - Analyze the correctness and depth of the student's answer.
  - Give partial marks if the answer is partially correct.
  - Use your judgment to assign score between 0 and maxMarks.
  - You may use a scale like 0, 0.5, 0.7, 1 of maxMarks if needed for fairness.

Always follow the provided "Correct Answer(s)" strictly. Never override them with your own knowledge.
`.trim();

  // 2) Teacher AI config (prompt + style + features)
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
      // fail silently, just use base rules
    }
  }

  // Only add the "final remarks object" instruction if includeRemarks is true
  const remarksAppendix = includeRemarks
    ? `
  After all individual question entries, ADD ONE FINAL OBJECT to the array like:
  {
    "overall_remarks": "General summary remarks about the student's overall performance based on all answers within 3-5 lines."
  }
  `.trim()
    : ``;

  const systemPrompt = `${baseRules}

${teacherConfigSection}

${remarksAppendix}

ONLY return pure JSON array as output. Do not include any comments or markdown.`;

  const userPrompt = `
  Below are the student's answers to a task. You Must return JSON array like :

  [
    {
      "question": "...",
      "answer": "...",
      "score": 0 to Max Marks ,
      "maxMarks": ...,
      "feedback": "..."
    }
  ]

  Grade the following:
${formattedInput}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  try {
    const content = response.choices[0].message.content;

    // Find the first "[" to locate the JSON array
    const jsonStart = content.indexOf("[");
    const jsonText = content.slice(jsonStart);

    // Parse the JSON text
    const parsed = JSON.parse(jsonText);

    // If remarks were requested, try to peel off the last object
    let overall_remarks = "";
    let graded = parsed;

    if (includeRemarks && Array.isArray(parsed) && parsed.length) {
      const lastItem = parsed[parsed.length - 1];
      if (
        lastItem &&
        typeof lastItem === "object" &&
        "overall_remarks" in lastItem
      ) {
        overall_remarks = lastItem.overall_remarks || "";
        graded = parsed.slice(0, -1);
      }
    }

    return { graded, overall_remarks };
  } catch (err) {
    console.error("AI Parse Error:", err);
    return { graded: [], overall_remarks: "" };
  }
}
