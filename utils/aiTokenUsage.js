import AiTokenUsage from "../models/AiTokenUsageModel.js";

function currentMonthKey(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

// Sums Gemini's per-call usageMetadata into the current month's row. Uses an
// upsert + $inc so concurrent classwork submissions don't clobber each other.
// Reads both camelCase (SDK field) and snake_case (raw REST field) for the
// thoughts count so we survive a future SDK rename.
export async function recordAiTokenUsage(usageMetadata, { tag = "AI" } = {}) {
  if (!usageMetadata) return;
  const promptTokenCount = Number(usageMetadata.promptTokenCount) || 0;
  const candidatesTokenCount = Number(usageMetadata.candidatesTokenCount) || 0;
  const cachedContentTokenCount =
    Number(usageMetadata.cachedContentTokenCount) || 0;
  const totalThoughtTokens =
    Number(
      usageMetadata.thoughtsTokenCount ??
        usageMetadata.total_thought_tokens ??
        usageMetadata.totalThoughtTokens ??
        0,
    ) || 0;

  if (
    promptTokenCount === 0 &&
    candidatesTokenCount === 0 &&
    cachedContentTokenCount === 0 &&
    totalThoughtTokens === 0
  ) {
    return;
  }

  const monthKey = currentMonthKey();
  try {
    await AiTokenUsage.updateOne(
      { monthKey },
      {
        $inc: {
          promptTokenCount,
          candidatesTokenCount,
          cachedContentTokenCount,
          totalThoughtTokens,
        },
        $setOnInsert: { monthKey },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error(
      `[${tag}] Failed to persist AI token usage for ${monthKey}:`,
      err,
    );
  }
}
