import { GoogleGenAI, Type } from "@google/genai";
import RegisteredSchool from "../models/RegisteredSchool.js";
import { withGeminiRetry, parseFirstJsonObject } from "./geminiCommon.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const MODEL = "gemini-2.5-flash";

const emailDomain = (email) => {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  return at === -1 ? "" : raw.slice(at + 1);
};

// AI fuzzy-match the submitted org against the RegisteredSchool candidate list.
// The DB match keeps the decision anchored to schools an admin has approved;
// Gemini only picks which candidate (if any) the free-text name refers to.
export async function verifySchool({ email, organization }) {
  const org = String(organization || "").trim();
  const domain = emailDomain(email);

  if (!org) {
    return {
      verified: false,
      matchedSchoolId: null,
      reason: "organization missing",
    };
  }

  const activeSchools = await RegisteredSchool.find({ status: "active" })
    .select("_id name aliases allowedEmailDomains")
    .lean();

  if (!activeSchools.length) {
    return {
      verified: false,
      matchedSchoolId: null,
      reason: "no registered schools configured",
    };
  }

  const candidates = activeSchools.map((s, idx) => ({
    idx,
    id: String(s._id),
    name: s.name,
    aliases: s.aliases || [],
    domains: s.allowedEmailDomains || [],
  }));

  const prompt = [
    "You are matching a user-submitted school name against an approved registry.",
    "Return the index of the best match, or -1 if none is a plausible match.",
    "Also decide if the user's email domain plausibly belongs to that school.",
    `Submitted organization: ${JSON.stringify(org)}`,
    `Submitted email domain: ${JSON.stringify(domain)}`,
    "Registry (index — canonical name — aliases — allowed email domains):",
    ...candidates.map(
      (c) =>
        `${c.idx} — ${c.name} — [${c.aliases.join(", ")}] — [${c.domains.join(", ")}]`
    ),
  ].join("\n");

  let parsed = null;
  try {
    const response = await withGeminiRetry(
      () =>
        ai.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                matchIndex: {
                  type: Type.INTEGER,
                  description:
                    "Index of the matched candidate in the registry list, or -1 if none.",
                },
                domainMatches: {
                  type: Type.BOOLEAN,
                  description:
                    "Whether the submitted email domain belongs to the matched school.",
                },
                reason: { type: Type.STRING },
              },
              required: ["matchIndex", "domainMatches", "reason"],
            },
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 4000,
        tag: "schoolVerifier",
      }
    );
    parsed = parseFirstJsonObject(response?.text, { tag: "schoolVerifier" });
  } catch (err) {
    console.error("[schoolVerifier] Gemini call failed:", err?.message);
    return {
      verified: false,
      matchedSchoolId: null,
      reason: "verification service unavailable",
    };
  }

  if (!parsed || typeof parsed.matchIndex !== "number") {
    return {
      verified: false,
      matchedSchoolId: null,
      reason: "no parseable verification response",
    };
  }

  const matchIdx = parsed.matchIndex;
  if (matchIdx < 0 || matchIdx >= candidates.length) {
    return {
      verified: false,
      matchedSchoolId: null,
      reason: parsed.reason || "no registry match",
    };
  }

  const chosen = candidates[matchIdx];
  const domainOk =
    !chosen.domains.length ||
    (domain && chosen.domains.includes(domain)) ||
    parsed.domainMatches === true;

  if (!domainOk) {
    return {
      verified: false,
      matchedSchoolId: null,
      reason: `email domain ${domain || "(none)"} does not match registered school`,
    };
  }

  return {
    verified: true,
    matchedSchoolId: chosen.id,
    reason: parsed.reason || `matched ${chosen.name}`,
  };
}
