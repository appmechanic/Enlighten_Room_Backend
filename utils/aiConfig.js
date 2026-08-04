import StandardPrompt from "../models/standardPromptModel.js";
import {
  MODEL_DEFAULTS,
  RETRY_DEFAULTS,
  TUNING_DEFAULTS,
  DIRECTIVE_DEFAULTS,
  buildSeedPatch,
} from "../config/standardPromptDefaults.js";

// Single source of truth for every dynamic AI knob (models, retry policy,
// tuning constants, prompt directives). One Mongo read per 60s populates the
// whole cache so a hot AI request path never blocks on DB.
//
// Every value has a canonical default in config/standardPromptDefaults.js so
// an outage of Mongo or an unseeded DB never brings AI features down. On a
// cache-miss, loadFromDb also runs buildSeedPatch to backfill any missing
// StandardPrompt field — so even the first AI call after a fresh install
// works AND writes the canonical text into the DB for future edits.

const CACHE_TTL_MS = 60 * 1000;

let cache = null;
let cacheExpiresAt = 0;
let inflight = null;

function deepMergeStrings(fallback, override) {
  if (typeof fallback === "string") {
    return typeof override === "string" && override.trim()
      ? override.trim()
      : fallback;
  }
  if (typeof fallback === "number") {
    return Number.isFinite(Number(override)) ? Number(override) : fallback;
  }
  if (Array.isArray(fallback)) {
    return Array.isArray(override) && override.length ? override : fallback;
  }
  if (fallback && typeof fallback === "object") {
    const out = {};
    for (const key of Object.keys(fallback)) {
      out[key] = deepMergeStrings(fallback[key], override?.[key]);
    }
    return out;
  }
  return override ?? fallback;
}

async function loadFromDb() {
  let doc = await StandardPrompt.findOne({ key: "global" })
    .select("models retry tuning directives aiHintPromptSections reportPromptSections creatingAssignmentPrompt emailPrompt")
    .lean();

  // Auto-seed on cache-miss when the DB is missing any canonical default.
  // Never overwrites admin edits (buildSeedPatch only fills empty fields).
  const patch = buildSeedPatch(doc);
  if (patch) {
    try {
      doc = await StandardPrompt.findOneAndUpdate(
        { key: "global" },
        patch,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      )
        .select("models retry tuning directives aiHintPromptSections reportPromptSections creatingAssignmentPrompt emailPrompt")
        .lean();
    } catch (err) {
      console.error("[aiConfig] Failed to auto-seed StandardPrompt:", err);
    }
  }

  return {
    models: {
      default: (doc?.models?.default || "").trim() || MODEL_DEFAULTS.default,
      fallback:
        (doc?.models?.fallback || "").trim() || MODEL_DEFAULTS.fallback,
      image: (doc?.models?.image || "").trim() || MODEL_DEFAULTS.image,
    },
    retry: deepMergeStrings(RETRY_DEFAULTS, doc?.retry || {}),
    tuning: deepMergeStrings(TUNING_DEFAULTS, doc?.tuning || {}),
    directives: {
      ...DIRECTIVE_DEFAULTS,
      ...Object.fromEntries(
        Object.entries(doc?.directives || {})
          .filter(([, v]) => typeof v === "string" && v.trim())
          .map(([k, v]) => [k, v.trim()])
      ),
    },
  };
}

async function refresh() {
  try {
    cache = await loadFromDb();
  } catch (err) {
    console.error("[aiConfig] Failed to load StandardPrompt config:", err);
    if (!cache) {
      cache = {
        models: { ...MODEL_DEFAULTS },
        retry: RETRY_DEFAULTS,
        tuning: TUNING_DEFAULTS,
        directives: { ...DIRECTIVE_DEFAULTS },
      };
    }
  }
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cache;
}

async function getConfig() {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  if (!inflight) {
    inflight = refresh().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

// ---------- PUBLIC GETTERS ----------
export async function getAiModel(slot = "default") {
  const cfg = await getConfig();
  return cfg.models[slot] || MODEL_DEFAULTS[slot] || MODEL_DEFAULTS.default;
}

export async function getAiRetry(caller) {
  const cfg = await getConfig();
  return cfg.retry[caller] || RETRY_DEFAULTS[caller] || RETRY_DEFAULTS.classworkFeedback;
}

export async function getAiTuning(section) {
  const cfg = await getConfig();
  if (!section) return cfg.tuning;
  return cfg.tuning[section] || TUNING_DEFAULTS[section];
}

// Sync accessor for hot-path modules (e.g. in-process caches) that can't
// await. Returns the last-cached value if the cache is warm, else the
// canonical default. Never triggers a DB read. Values stay accurate to within
// one 60s TTL window.
export function getAiTuningSync(section) {
  const source = cache ? cache.tuning : TUNING_DEFAULTS;
  if (!section) return source;
  return source[section] || TUNING_DEFAULTS[section];
}

// Directive lookup. The DB entry is authoritative once seeded; if a caller
// arrives before the seed has run (rare — loadFromDb seeds on cache-miss),
// falls back to the canonical default from DIRECTIVE_DEFAULTS.
export async function getAiDirective(key) {
  const cfg = await getConfig();
  const dbValue = cfg.directives?.[key];
  if (typeof dbValue === "string" && dbValue.trim()) return dbValue;
  return DIRECTIVE_DEFAULTS[key] || "";
}

// Force-invalidate the cache (call from admin save handler so edits take
// effect within one request instead of waiting up to 60s).
export function invalidateAiConfigCache() {
  cache = null;
  cacheExpiresAt = 0;
}
