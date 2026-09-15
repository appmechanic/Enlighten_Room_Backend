/**
 * Read-only: print the 11 aiHintPromptSections from StandardPrompt(key="global")
 * so we can see exactly what admin-edited text is live in the DB.
 *
 * Usage:
 *   node scripts/dumpAiHintPromptSections.js
 */

import "dotenv/config";
import mongoose from "mongoose";
import StandardPrompt from "../models/standardPromptModel.js";

const LABELS = [
  "0. responseFormat",
  "1. diagnosticIntro",
  "2. diagnosticHintStream",
  "3. part1 (studentCanDo)",
  "4. part2 (DON'T/WHAT/HOW/WHY)",
  "5. part3 (training)",
  "6. masteryIntro",
  "7. masteryHintStream",
  "8. advancedChallenge",
  "9. styleGuidance",
  "10. commonMistake",
];

async function main() {
  if (!process.env.DB_URL) {
    console.error("DB_URL is not set. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DB_URL);
  const doc = await StandardPrompt.findOne({ key: "global" }).lean();
  if (!doc) {
    console.log('No StandardPrompt(key="global") found.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const sections = Array.isArray(doc.aiHintPromptSections)
    ? doc.aiHintPromptSections
    : [];
  const joined = typeof doc.aiHintPrompt === "string" ? doc.aiHintPrompt : "";

  console.log(`aiHintPrompt joined: ${joined.length} chars (~${Math.round(joined.length / 4)} tokens)`);
  console.log(`aiHintPromptSections length: ${sections.length}\n`);

  for (let i = 0; i < 11; i++) {
    const text = sections[i] ?? "";
    console.log(`===== [${LABELS[i]}] (${text.length} chars) =====`);
    console.log(text || "(empty)");
    console.log("");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Dump failed:", err);
  process.exit(1);
});
