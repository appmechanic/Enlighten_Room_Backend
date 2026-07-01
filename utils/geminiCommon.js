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
//   callFn       — thunk that invokes ai.models.generateContent(...)
//   maxAttempts  — total tries before giving up
//   baseDelayMs  — first-attempt backoff; doubles each retry
//   maxDelayMs   — optional cap on the doubled backoff (omit for uncapped)
//   jitterMs     — max random jitter added to each backoff (default 500)
//   tag          — log prefix used in retry warnings
export async function withGeminiRetry(
  callFn,
  { maxAttempts, baseDelayMs, maxDelayMs, jitterMs = 500, tag }
) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callFn();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.error?.code;
      if (!RETRYABLE_GEMINI_STATUSES.has(status) || attempt === maxAttempts) {
        throw err;
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

// Defensive JSON parse for Gemini responses. `responseMimeType=application/json`
// normally guarantees raw JSON, but the model occasionally still wraps output
// in ```json fences or prepends a stray note — try direct parse first, then
// extract the first {...} block. Returns null on any failure and logs under
// [tag] so callers can decide whether to throw or degrade.
export function parseFirstJsonObject(text, { tag } = {}) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      if (tag) console.error(`[${tag}] No JSON object in response:`, text);
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      if (tag) console.error(`[${tag}] JSON parse failed:`, err, text);
      return null;
    }
  }
}
