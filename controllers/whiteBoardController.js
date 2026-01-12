// controllers/ai.controller.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Reusable helper
async function askVision({
  dataUrl,
  prompt = `Hello Tutor, I am sending a student's name and the student's ID for tracing, along with a photo of their classwork. Do not give the final answer or full step-by-step solutions.

1) Start every piece of advice with the student’s name (if provided). Use the student ID only for internal reference or tracing.
2) If the student’s step is correct, confirm it with positive encouragement and a short affirmation.
3) If the student’s step is incorrect, first appreciate the effort, tell them we’ll work together and make a small adjustment, then explain the core concept/knowledge needed for this step and provide a simple example.
4) If the student repeats the same incorrect step three times, give the correct method for that step and explain with a clear example, diagram, or a short, highlighted note.
5) If the student hesitates after your last AI response, give hints only for that step with an example or a mini-hint (no full solution).
6) If the student completes the question correctly, provide a slightly more challenging follow-up question. Continue to propose tasks until the teacher ends the classwork session.
7) At the end of the classroom session, return a study report summarizing: what the student can do, what they need to practice, and actionable advice for teachers and parents to help the student progress.

Use a warm, encouraging, parent-like tone throughout. Keep responses concise, child-friendly, and focused on learning rather than giving the final answers unless the student has failed the same step three times or the teacher requests the solution.`,
}) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a warm, patient, and encouraging tutor (like a caring parent) who reads a student's classwork image and provides short, supportive, and educational guidance. Keep responses concise (up to ~500 characters) when appropriate. Avoid repeating raw extracted text and do not reveal the final answer unless the student has attempted the same incorrect step three times or the teacher explicitly asks for it. Always start advice with the student's name if provided and use a kind, child-friendly tone.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });
  return resp.choices?.[0]?.message?.content ?? "No answer";
}

/** POST /api/ai/whiteboard (multipart/form-data: image) */
export async function analyzeWhiteboard(req, res) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: "image file required" });
    }
    const b64 = req.file.buffer.toString("base64");
    const dataUrl = `data:${req.file.mimetype || "image/png"};base64,${b64}`;

    const text = await askVision({ dataUrl, prompt: req.body?.prompt });
    res.json({ ok: true, text });
  } catch (err) {
    console.error("analyzeWhiteboard error:", err);
    res.status(500).json({ ok: false, error: "AI error" });
  }
}

/** POST /api/ai/whiteboard/base64 (JSON: { image: dataURL, prompt? }) */
export async function analyzeWhiteboardBase64(req, res) {
  try {
    const { image, prompt } = req.body || {};
    if (
      !image ||
      typeof image !== "string" ||
      !image.startsWith("data:image/")
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "image dataURL required" });
    }

    const text = await askVision({ dataUrl: image, prompt });
    res.json({ ok: true, text });
  } catch (err) {
    console.error("analyzeWhiteboardBase64 error:", err);
    res.status(500).json({ ok: false, error: "AI error" });
  }
}
