/**
 * One-off migration: shrink the StandardPrompt(key="global") aiHintPrompt
 * sections that ship to Gemini as part of `systemInstruction` on every
 * classwork feedback call.
 *
 * What this changes (four slots):
 *   [0] responseFormat  — CLEAR. Duplicates the JSON shape that the
 *       structured-output `responseSchema` config already enforces.
 *   [8] advancedChallenge — trimmed 312 → ~220 chars
 *   [9] styleGuidance     — trimmed 255 → ~180 chars
 *   [10] commonMistake    — trimmed 217 → ~165 chars
 *
 * Safety:
 *   - Only overwrites a slot whose current DB text matches the specific
 *     baseline string this script knows about. If the admin has since
 *     edited a slot, that slot is left alone with a warning.
 *   - Writes both `aiHintPromptSections[i]` AND rewrites the joined
 *     `aiHintPrompt` (which is what utils/aiConfig.js reads at runtime).
 *   - Backs up the pre-change sections + joined prompt to
 *     scripts/trimAiHintPromptSections.backup-<timestamp>.json.
 *
 * Cache: aiConfig has a 60s in-memory TTL per Node process. Live traffic
 * will still see the old prompt for up to one TTL after apply.
 *
 * Usage:
 *   node scripts/trimAiHintPromptSections.js --dry-run
 *   node scripts/trimAiHintPromptSections.js --yes
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import StandardPrompt from "../models/standardPromptModel.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirmed = args.has("--yes");

// ---------- Baselines: exact strings currently in the DB (per dump 2026-09-15) ----------

const BASELINE = {
  0: `{"correct":Boolean,"hintStream":string,"part1":[string],"part2":[string],"part3":[string],"advancedChallenge":{"congratulations":string,"question":string},"standardSolution":string,"commonMistake":{"isCommon":Boolean,"title":string,"answerLatex":string}}`,

  8: `advancedChallenge: congratulate in the question's language, then a new question one level harder (STEM: optimization or symbolic variation; Humanities: deeper theme, harder grammar, or comparative primary-source analysis). Extend the current image if present. Weave in a positive scenario when it fits naturally.`,

  9: `Tone: positive/supportive. Apply teacher tone/terminology overrides unless they break educational rules. Mark correct on math/science equivalence regardless of notation, spacing, coefficient placement, or LaTeX vs plain — never correct equivalent answers.`,

  10: `commonMistake: FIRST mistake.
- isCommon: true if >50% of grade would make it.
- title: 2–6 word label.
- answerLatex: LaTeX of handwriting image; empty otherwise.
Obey "commonMistake: {...}" fill vs "Leave it empty".`,
};

// ---------- Trimmed replacements ----------
// Slot 0 → empty (structured responseSchema already enforces the JSON shape).

const REPLACEMENT = {
  0: "",

  8: `advancedChallenge: congratulate briefly, then a new question one level harder (STEM: optimization or symbolic variation; Humanities: deeper theme, harder grammar, comparative source analysis). Reuse the current image if present. Add a positive scenario when it fits.`,

  9: `Tone: positive/supportive. Follow teacher tone/term overrides unless they break educational rules. On math/science, treat equivalent forms (notation, spacing, coefficient placement, LaTeX vs plain) as correct.`,

  10: `commonMistake: FIRST mistake. isCommon = >50% of grade would make it. title: 2–6 words. answerLatex: LaTeX of handwriting image, else empty. Fill only when instructed.`,
};

const SLOT_LABEL = {
  0: "responseFormat (schema literal)",
  8: "advancedChallenge",
  9: "styleGuidance",
  10: "commonMistake",
};

const TARGET_INDEXES = [0, 8, 9, 10];

async function main() {
  if (!process.env.DB_URL) {
    console.error("DB_URL is not set. Aborting.");
    process.exit(1);
  }
  if (!dryRun && !confirmed) {
    console.error(
      "Refusing to run without --yes. Use --dry-run to preview, or --yes to apply.",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.DB_URL);
  console.log("Connected to MongoDB.");
  console.log(`Target DB: ${maskDbUrl(process.env.DB_URL)}\n`);

  const doc = await StandardPrompt.findOne({ key: "global" }).lean();
  if (!doc) {
    console.log('No StandardPrompt(key="global") — nothing to do.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const sections = Array.isArray(doc.aiHintPromptSections)
    ? [...doc.aiHintPromptSections]
    : [];
  const currentJoined = typeof doc.aiHintPrompt === "string" ? doc.aiHintPrompt : "";

  console.log(`Current aiHintPromptSections length: ${sections.length}`);
  console.log(`Current aiHintPrompt joined length: ${currentJoined.length} chars`);

  const willUpdate = {};
  const skipped = [];

  for (const i of TARGET_INDEXES) {
    const current = sections[i] ?? "";
    const baseline = BASELINE[i];
    const replacement = REPLACEMENT[i];
    const label = `[${i}] ${SLOT_LABEL[i]}`;

    if (current === baseline) {
      willUpdate[i] = replacement;
      const before = current.length;
      const after = replacement.length;
      console.log(
        `  ${label}: matches baseline → ${
          replacement === "" ? "CLEARING" : `trimming ${before} → ${after} chars (saved ${before - after})`
        }`,
      );
    } else if (current === replacement) {
      console.log(`  ${label}: already trimmed — skipping`);
    } else if (!current.trim() && replacement !== "") {
      // Empty slot but we have a smaller default to install.
      willUpdate[i] = replacement;
      console.log(
        `  ${label}: empty in DB → setting trimmed (${replacement.length} chars)`,
      );
    } else if (!current.trim() && replacement === "") {
      console.log(`  ${label}: empty in DB and target is empty — skipping`);
    } else {
      skipped.push({ index: i, label, currentLen: current.length });
      console.log(
        `  ${label}: DIVERGED from baseline (${current.length} chars) — NOT touching. Port by hand if you want savings.`,
      );
    }
  }

  if (Object.keys(willUpdate).length === 0) {
    console.log("\nNothing to update.");
    if (skipped.length) {
      console.log(
        `${skipped.length} slot(s) diverged from baseline — port those by hand via the admin UI.`,
      );
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  // Build the post-update sections array + joined view.
  const nextSections = [...sections];
  while (nextSections.length < 11) nextSections.push("");
  for (const [i, val] of Object.entries(willUpdate)) {
    nextSections[Number(i)] = val;
  }
  const nextJoined = nextSections
    .filter((s) => typeof s === "string" && s.length > 0)
    .join("\n\n");

  const totalCharsBefore = currentJoined.length;
  const totalCharsAfter = nextJoined.length;
  const savedChars = totalCharsBefore - totalCharsAfter;

  console.log(
    `\nJoined aiHintPrompt: ${totalCharsBefore} → ${totalCharsAfter} chars (saved ${savedChars}, ~${Math.round(
      savedChars / 4,
    )} tokens per request).`,
  );

  if (dryRun) {
    console.log(
      `\n[dry-run] Would update ${Object.keys(willUpdate).length} section(s) and rewrite aiHintPrompt.`,
    );
    if (skipped.length) {
      console.log(
        `Warning: ${skipped.length} diverged slot(s) would be left as-is.`,
      );
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    `trimAiHintPromptSections.backup-${ts}.json`,
  );
  const backupPayload = {
    key: doc.key,
    savedAt: new Date().toISOString(),
    aiHintPromptSections: sections,
    aiHintPrompt: currentJoined,
  };
  fs.writeFileSync(backupPath, JSON.stringify(backupPayload, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  const result = await StandardPrompt.updateOne(
    { key: "global" },
    { $set: { aiHintPromptSections: nextSections, aiHintPrompt: nextJoined } },
  );
  console.log(
    `\n$set applied — matched=${result.matchedCount} modified=${result.modifiedCount}.`,
  );

  const after = await StandardPrompt.findOne({ key: "global" }).lean();
  console.log(
    `Post-update aiHintPrompt length: ${after.aiHintPrompt.length} chars.`,
  );
  console.log(
    "\nReminder: aiConfig caches for up to 60s per Node process. Wait one TTL or restart the backend for live traffic to pick this up.",
  );

  if (skipped.length) {
    console.log(
      `\n${skipped.length} diverged slot(s) were left as-is — port the trim by hand via the admin UI if you want the full savings:`,
    );
    skipped.forEach((s) => console.log(`  - ${s.label} (${s.currentLen} chars)`));
  }

  await mongoose.disconnect();
  console.log("\nDone.");
  process.exit(0);
}

function maskDbUrl(url) {
  return url.replace(/\/\/[^@]+@/, "//<credentials>@");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
