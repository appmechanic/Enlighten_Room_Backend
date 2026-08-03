import StandardPrompt from "../models/standardPromptModel.js";

// Hardcoded fallbacks used when Mongo is unreachable or the StandardPrompt
// doc is missing the models field. Must never be null so no AI call site
// crashes on a cold cache with a bad DB.
const FALLBACKS = {
  default: "gemini-2.5-flash",
  fallback: "gemini-2.5-flash-lite",
  image: "gemini-3-pro-image-preview",
};

const CACHE_TTL_MS = 60 * 1000;

let cache = null;
let cacheExpiresAt = 0;
let inflight = null;

async function loadFromDb() {
  const doc = await StandardPrompt.findOne({ key: "global" })
    .select("models")
    .lean();
  const models = doc?.models || {};
  return {
    default: (models.default || "").trim() || FALLBACKS.default,
    fallback: (models.fallback || "").trim() || FALLBACKS.fallback,
    image: (models.image || "").trim() || FALLBACKS.image,
  };
}

async function refresh() {
  try {
    cache = await loadFromDb();
  } catch (err) {
    console.error("[aiModels] Failed to load StandardPrompt.models:", err);
    if (!cache) cache = { ...FALLBACKS };
  }
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cache;
}

async function getModels() {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// slot ∈ {"default","fallback","image"}. Defaults to "default" so the common
// text-generation call sites read as `await getAiModel()`.
export async function getAiModel(slot = "default") {
  const models = await getModels();
  return models[slot] || FALLBACKS[slot] || FALLBACKS.default;
}

// Force-invalidate the cache (call from the admin save handler so edits
// take effect within one request instead of waiting up to 60s).
export function invalidateAiModelsCache() {
  cache = null;
  cacheExpiresAt = 0;
}
