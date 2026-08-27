// Shared helpers for the utils/gemini*.js modules. Each caller keeps its own
// GoogleGenAI client and its own retry budget (attempts, base delay, cap) — this
// module centralises the retry loop shape, the retryable-status set, and the
// defensive JSON-fence parser so drift between the four feature utils stops.

export const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a Gemini `ai.models.generateContent(...)` call on retryable HTTP
// statuses using exponential backoff + jitter. Callers pass a thunk plus their
// own budget so the classwork-feedback hot path can fail fast (3 attempts)
// while a background class-report can grind for ~15 minutes (20 attempts, 60s
// cap).
//
//   callFn         — thunk that invokes ai.models.generateContent(...)
//   maxAttempts    — total tries before giving up
//   baseDelayMs    — first-attempt backoff; doubles each retry
//   maxDelayMs     — optional cap on the doubled backoff (omit for uncapped)
//   jitterMs       — max random jitter added to each backoff (default 500)
//   tag            — log prefix used in retry warnings
//   fallbackCallFn — optional thunk against a lighter model; tried ONCE
//                    after the first retryable failure, before the first
//                    backoff sleep. If it succeeds we return immediately;
//                    if it also fails we resume the primary backoff loop.
export async function withGeminiRetry(
  callFn,
  { maxAttempts, baseDelayMs, maxDelayMs, jitterMs = 500, tag, fallbackCallFn }
) {
  let lastErr;
  let fallbackTried = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callFn();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.error?.code;
      if (!RETRYABLE_GEMINI_STATUSES.has(status) || attempt === maxAttempts) {
        throw err;
      }
      // Overload fallback: the primary model is under load, so before
      // burning a backoff sleep try a lighter/faster model once. During
      // Gemini spikes flash-lite typically has spare capacity, giving the
      // student a hint in ~2s instead of waiting out the full retry ladder.
      if (fallbackCallFn && !fallbackTried) {
        fallbackTried = true;
        console.warn(
          `[${tag}] Gemini ${status} on attempt ${attempt}; trying fallback model before backoff`,
        );
        try {
          return await fallbackCallFn();
        } catch (fbErr) {
          const fbStatus = fbErr?.status ?? fbErr?.error?.code;
          console.warn(
            `[${tag}] Fallback model also failed (${fbStatus}); resuming primary backoff`,
          );
        }
      }
      const exp = baseDelayMs * 2 ** (attempt - 1);
      const backoff = maxDelayMs ? Math.min(exp, maxDelayMs) : exp;
      const jitter = Math.floor(Math.random() * jitterMs);
      console.warn(
        `[${tag}] Gemini ${status} on attempt ${attempt}/${maxAttempts}; retrying in ${backoff + jitter}ms`
      );
      await sleep(backoff + jitter);
    }
  }
  throw lastErr;
}

// Collapse pathological runaway character sequences the model sometimes emits
// while trying to "draw" a fill-blanks placeholder — a chain of escaped or
// raw underscores that grows until it burns the entire output-token budget.
// The truncation lands mid-string and JSON.parse dies. Collapsing before
// parse is only a safety net (the real fix is telling the model not to do
// this — see the fill-blanks constraint in geminiTestGeneration.js), but it
// keeps a single misbehaving generation from taking down the whole request.
function sanitizeAiJson(text) {
  if (!text) return text;
  return text
    .replace(/(?:\\_){10,}/g, "___")
    .replace(/_{20,}/g, "___");
}

// Defensive JSON parse for Gemini responses. `responseMimeType=application/json`
// normally guarantees raw JSON, but the model occasionally still wraps output
// in ```json fences or prepends a stray note — try direct parse first, then
// extract the first {...} block. Returns null on any failure and logs under
// [tag] so callers can decide whether to throw or degrade.
export function parseFirstJsonObject(text, { tag } = {}) {
  if (!text) return null;
  const cleaned = sanitizeAiJson(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      if (tag) console.error(`[${tag}] No JSON object in response:`, cleaned);
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      if (tag) console.error(`[${tag}] JSON parse failed:`, err, cleaned);
      return null;
    }
  }
}
