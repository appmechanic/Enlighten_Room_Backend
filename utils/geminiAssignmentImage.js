import { GoogleGenAI } from "@google/genai";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./s3.js";
import { withGeminiRetry } from "./geminiCommon.js";
import {
  recordAiTokenUsage,
  logAiUsage,
  recordAiCallLog,
} from "./aiTokenUsage.js";
import { getAiModel, getAiRetry } from "./aiConfig.js";

// Generates a question illustration with Gemini 3 Pro Image (Nano Banana Pro)
// and uploads it to DigitalOcean Spaces, returning the public URL. Used by the
// Create Assignment flow when the teacher toggles "include images" on for a
// given format.
//
// One image per question is generated. The caller is expected to fan out
// concurrently with a small pool — Gemini's image endpoint is the bottleneck
// here (multiple seconds per call), so generating sequentially makes the
// create-assignment request feel slow on larger batches.

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// Image model ("Nano Banana Pro" family, needs a different modality than the
// text-generation models) resolved per call via getAiModel("image") from
// StandardPrompt.models.image with a 60s in-memory cache.

// Retry policy resolved per call via getAiRetry("assignmentImage").

const bucketName = process.env.DO_SPACE_BUCKET;
const spaceEndpoint = process.env.DO_SPACE_ENDPOINT;

function getSpacesPublicUrl(key) {
  if (!bucketName || !spaceEndpoint) {
    throw new Error("DigitalOcean Spaces configuration is missing.");
  }
  const endpoint = new URL(spaceEndpoint);
  return `${endpoint.protocol}//${bucketName}.${endpoint.host}/${key}`;
}

function buildImagePrompt({ questionText, course, topic, format }) {
  // Keep the prompt short and didactic. We deliberately ask for no text in
  // the image so the model doesn't render misspelled labels — students read
  // the question text separately, the image is illustrative only.
  const lines = [
    "Create a single educational illustration for a student practice question.",
    "Style: clean, friendly, classroom-appropriate, no text or letters in the image.",
    "Aspect ratio: 4:3.",
    course ? `Course: ${course}.` : "",
    topic ? `Topic: ${topic}.` : "",
    format ? `Question format: ${format}.` : "",
    "",
    "Question:",
    questionText,
  ];
  return lines.filter(Boolean).join("\n");
}

// Pull the first image part out of a generateContent response. Image models
// return one or more `inlineData` parts; the rest may be text annotations we
// ignore.
function extractFirstImage(result) {
  const candidates = result?.candidates || [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      if (inline?.data) {
        return {
          base64: inline.data,
          mimeType: inline.mimeType || inline.mime_type || "image/png",
        };
      }
    }
  }
  return null;
}

function extensionForMime(mime) {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

export async function generateAssignmentQuestionImage({
  questionText,
  course,
  topic,
  format,
  assignmentId,
  questionId,
}) {
  if (!questionText) return null;

  try {
    const [IMAGE_MODEL, retryCfg] = await Promise.all([
      getAiModel("image"),
      getAiRetry("assignmentImage"),
    ]);
    const result = await withGeminiRetry(
      () =>
        ai.models.generateContent({
          model: IMAGE_MODEL,
          contents: [
            {
              role: "user",
              parts: [{ text: buildImagePrompt({ questionText, course, topic, format }) }],
            },
          ],
          // The image-capable models need IMAGE listed in responseModalities;
          // including TEXT lets the model still attach a short caption if needed,
          // which we ignore.
          config: {
            responseModalities: ["IMAGE", "TEXT"],
          },
        }),
      {
        maxAttempts: retryCfg.max,
        baseDelayMs: retryCfg.baseMs,
        maxDelayMs: retryCfg.capMs,
        tag: "AssignmentImage",
      },
    );

    logAiUsage(null, result?.usageMetadata, "AssignmentImage");
    await recordAiTokenUsage(result?.usageMetadata, {
      sessionId: null,
      tag: "AssignmentImage",
    });
    await recordAiCallLog({
      tag: "AssignmentImage",
      model: IMAGE_MODEL,
      questionText: questionText || "",
      studentAnswer: `Image generation for course=${course || ""} topic=${topic || ""} format=${format || ""} assignment=${assignmentId || ""} question=${questionId || ""}`,
      aiResponseSummary: "(image bytes returned)",
      userPromptText: buildImagePrompt({ questionText, course, topic, format }),
      usageMetadata: result?.usageMetadata,
    });

    const image = extractFirstImage(result);
    if (!image) {
      console.warn("[AssignmentImage] Gemini returned no image part.");
      return null;
    }

    const ext = extensionForMime(image.mimeType);
    const key = `photos/assignment-questions/${assignmentId || "draft"}/${questionId || Date.now()}.${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: Buffer.from(image.base64, "base64"),
        ContentType: image.mimeType,
        ACL: "public-read",
      }),
    );

    return {
      url: getSpacesPublicUrl(key),
      model: IMAGE_MODEL,
    };
  } catch (err) {
    console.error("[AssignmentImage] generation failed:", err?.message || err);
    return null;
  }
}

// Retained as an async helper for callers that only need the model ID for
// audit metadata (e.g. assignmentController's generation.imageModel).
export async function getAssignmentImageModel() {
  return getAiModel("image");
}
