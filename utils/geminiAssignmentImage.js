import { GoogleGenAI } from "@google/genai";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./s3.js";

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
// "Nano Banana Pro" public id. The preview suffix is what the API requires
// today; if Google promotes it to GA the model id will change.
const IMAGE_MODEL = "gemini-3-pro-image-preview";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;

const bucketName = process.env.DO_SPACE_BUCKET;
const spaceEndpoint = process.env.DO_SPACE_ENDPOINT;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function generateImageWithRetry(request) {
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
      const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 500);
      console.warn(
        `[AssignmentImage] Gemini ${status} on attempt ${attempt}/${MAX_ATTEMPTS}; retrying in ${exp + jitter}ms`,
      );
      await sleep(exp + jitter);
    }
  }
  throw lastErr;
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
    const result = await generateImageWithRetry({
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

export const ASSIGNMENT_IMAGE_MODEL = IMAGE_MODEL;
