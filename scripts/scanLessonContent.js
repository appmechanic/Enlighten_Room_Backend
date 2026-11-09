// scripts/scanLessonContent.js
//
// One-shot diagnostic: scans Classwork rows for the two features we want to
// verify in the Task 2 tokenized viewer:
//   1. LaTeX-bearing questions  (any $...$, \frac, \int, \sqrt, etc.)
//   2. Submissions with a handwriting image (answer.image or answerImage)
//
// Prints the (lessonName, roomId, questionText) triples so you can look up
// the matching lesson in the Session Report UI, select it, and send the
// tokenized report for live verification of LaTeX/handwriting rendering.
//
// Usage: node scripts/scanLessonContent.js

import "dotenv/config";
import mongoose from "mongoose";
import Classwork from "../models/ClassworkModel.js";

const LATEX_HINTS = /\$|\\frac|\\int|\\sqrt|\\sum|\\prod|\\lim|\\alpha|\\beta|\\theta|\\pi|\\infty|\^|_\{/;

function hasHandwritingSubmission(sub) {
  if (!sub) return false;
  if (sub.answerImage) return true;
  if (sub.answer && typeof sub.answer === "object" && sub.answer.image) return true;
  if (typeof sub.answer === "string" && /^https?:\/\//.test(sub.answer) && /\.(png|jpe?g|webp)(\?|$)/i.test(sub.answer)) return true;
  return false;
}

async function main() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    console.error("DB_URL missing from environment. Aborting.");
    process.exit(1);
  }
  await mongoose.connect(dbUrl);

  const rows = await Classwork.find({})
    .select("roomId lessonName question format submitted")
    .lean();

  const latexHits = [];
  const handwritingHits = [];

  for (const r of rows) {
    const q = String(r.question || "");
    if (LATEX_HINTS.test(q)) {
      latexHits.push({
        roomId: r.roomId,
        lessonName: r.lessonName || "(unassigned)",
        format: r.format,
        preview: q.slice(0, 120),
      });
    }
    const subsWithImage = (r.submitted || []).filter(hasHandwritingSubmission);
    if (subsWithImage.length > 0) {
      handwritingHits.push({
        roomId: r.roomId,
        lessonName: r.lessonName || "(unassigned)",
        format: r.format,
        preview: q.slice(0, 80),
        submissions: subsWithImage.length,
      });
    }
  }

  console.log(`\nScanned ${rows.length} classwork rows.\n`);

  console.log(`=== LaTeX in question text: ${latexHits.length} match(es) ===`);
  latexHits.slice(0, 20).forEach((h, i) => {
    console.log(
      `  ${i + 1}. room=${h.roomId}  lesson="${h.lessonName}"  fmt=${h.format}`
    );
    console.log(`      "${h.preview}${h.preview.length === 120 ? "..." : ""}"`);
  });
  if (latexHits.length > 20) console.log(`  ... and ${latexHits.length - 20} more`);

  console.log(`\n=== Handwriting / image submissions: ${handwritingHits.length} match(es) ===`);
  handwritingHits.slice(0, 20).forEach((h, i) => {
    console.log(
      `  ${i + 1}. room=${h.roomId}  lesson="${h.lessonName}"  fmt=${h.format}  submissions=${h.submissions}`
    );
    console.log(`      "${h.preview}${h.preview.length === 80 ? "..." : ""}"`);
  });
  if (handwritingHits.length > 20) console.log(`  ... and ${handwritingHits.length - 20} more`);

  if (latexHits.length === 0 && handwritingHits.length === 0) {
    console.log(
      "\nNo matching content found — fall back to creating a quick test classwork with a LaTeX question and a handwriting question."
    );
  } else {
    console.log(
      "\nPick one of the (room, lesson) pairs above, open Session Report for that classroom, select the lesson in the dropdown, and Send Report to verify rendering."
    );
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Error:", err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
