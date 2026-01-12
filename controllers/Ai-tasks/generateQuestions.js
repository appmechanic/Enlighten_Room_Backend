import { OpenAI } from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const generateAIQuestions = async ({
  numberOfQuestions,
  type,
  mcqOptions,
  difficulty,
  course,
  topic,
  maxMarks,
  fineTuningInstructions,
  classroomPrompt,
}) => {
  // console.log("numberOfQuestions", numberOfQuestions);
  // console.log("type", type);
  // console.log("mcqOptions", mcqOptions);
  // console.log("difficulty", difficulty);
  // console.log("course", course);
  // console.log("topic", topic);
  // console.log("maxMarks", maxMarks);
  // console.log("fineTuningInstructions", fineTuningInstructions);
  console.log("classroomPrompt", classroomPrompt);

  // Optional blocks so prompt clean rahe
  const teacherBlock = fineTuningInstructions
    ? `\nTeacher / Admin Instructions (STRICTLY FOLLOW THESE):\n${fineTuningInstructions}\n`
    : "";

  const classroomBlock = classroomPrompt
    ? `\nClassroom Context (adapt tone, level, and examples based on this):\n${classroomPrompt}\n`
    : "";

  let prompt;

  if (type === "mcq") {
    prompt = `
You are an expert academic question generator.

${teacherBlock}${classroomBlock}
Generate ${numberOfQuestions} multiple choice questions ONLY.

Instructions for MCQ:
- Each question must have exactly ${mcqOptions} options.
- Only one option should be correct unless specified otherwise.
- Return correctAnswer as an array with the correct option(s).
- Include helpful hints for each question.

Question Settings:
- Course: ${course}
- Topic: ${topic}
- Difficulty: ${difficulty}
- Language: English
- Max marks per question: ${maxMarks}

Return ONLY a JSON array in this format:
[
  {
    "questionText": "",
    "type": "mcq",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correctAnswer": ["Option 1"],
    "hints": ["Hint 1", "Hint 2"],
    "answer": [],
    "metadata": {
      "difficulty": "${difficulty}",
      "marks": ${maxMarks},
      "tags": ["${topic}"],
      "createdBy": "AI"
    }
  }
]
`;
  } else {
    prompt = `
You are an expert academic question generator.

${teacherBlock}${classroomBlock}
Generate ${numberOfQuestions} input-based questions ONLY.

Instructions for Input Questions:
- Generate descriptive questions that require written answers.
- Provide a comprehensive answer (3–4 lines) for each question in the correctAnswer field.
- Leave the options field empty.
- Include helpful hints for each question.

Question Settings:
- Course: ${course}
- Topic: ${topic}
- Difficulty: ${difficulty}
- Language: English
- Max marks per question: ${maxMarks}

Return ONLY a JSON array in this format:
[
  {
    "questionText": "",
    "type": "input",
    "options": [],
    "correctAnswer": ["Detailed descriptive answer here (3–4 lines)"],
    "hints": ["Hint 1", "Hint 2"],
    "answer": [],
    "metadata": {
      "difficulty": "${difficulty}",
      "marks": ${maxMarks},
      "tags": ["${topic}"],
      "createdBy": "AI"
    }
  }
]
`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content:
          "You are an academic question generator. Always respond with ONLY valid JSON (no markdown, no explanations)",
      },
      { role: "user", content: prompt },
    ],
  });

  const content = response.choices[0].message.content;

  try {
    const cleanedContent = content.replace(/```(?:json)?|```/g, "").trim();
    return JSON.parse(cleanedContent);
  } catch (err) {
    console.error("❌ Failed to parse AI output:", content);
    throw new Error("AI returned an invalid response.");
  }
};
