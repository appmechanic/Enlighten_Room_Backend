// Shared source of truth for the 10 admin-editable AI hint prompt sections.
// Admins edit each section as a standalone textarea in the AdminAiPrompts UI;
// at request time we assemble them into the rules block that used to live
// hard-coded in geminiClassworkFeedback.js. The defaults here mirror that
// original text so a fresh install behaves identically.

export const AI_HINT_SECTIONS = [
  {
    id: "responseFormat",
    title: "Response Format",
    defaultText:
`You MUST respond with a single JSON object only (no prose, no markdown fences).

Set "correct" to true ONLY if every step and the final answer are complete and correct.
Choose ONE of two modes based on "correct":`,
  },
  {
    id: "diagnosticIntro",
    title: "Diagnostic Mode Overview",
    defaultText:
`DIAGNOSTIC mode (correct = false):
  Populate "studentCanDo", "nextStep", "diagnosticTraining".
  Leave "advancedChallenge.congratulations" = "" and "advancedChallenge.question" = "".`,
  },
  {
    id: "diagnosticHintStream",
    title: "Diagnostic: hintStream",
    defaultText:
`  - "hintStream": the live, student-facing hint, built as a single flowing
    string: first the DON'T line, then WHAT to do next (never reveal the
    exact expression or sentence), then HOW to do it. Append a short concept
    explanation tuned to the grade band when useful.`,
  },
  {
    id: "studentCanDo",
    title: "Diagnostic: studentCanDo",
    defaultText:
`  - "studentCanDo.subjectTrack": "STEM" or "HUMANITIES_LANGUAGES".
  - "studentCanDo.message": ONE sentence starting with "Hi [first name], you ...".
    For STEM, name the last mathematically correct line/step. For Humanities/
    Languages, name the strongest correct logic, translation fragment, factual
    premise, or thesis foundation so far.`,
  },
  {
    id: "nextStep",
    title: "Diagnostic: nextStep",
    defaultText:
`  - "nextStep.dont": what NOT to do (the incorrect step), in clear plain language.
  - "nextStep.what": the correct formula / strategy / grammar / phrase / sentence
    structure / fact to apply next, WITHOUT revealing the exact expression or
    sentence.
  - "nextStep.how": how to perform it next step, if useful. "" if not needed.
  - "nextStep.explanation.gradeBand": one of "G3_OR_LOWER", "G4_TO_G8", "G9_PLUS".
  - "nextStep.explanation.text": explain the underlying theorem / reason /
    theory / structure. G3 or lower = one short sentence. G4–G8 = under 50
    words. G9+ = a paragraph of appropriate length. "" only if no
    explanation is needed.`,
  },
  {
    id: "diagnosticTraining",
    title: "Diagnostic: diagnosticTraining",
    defaultText:
`  - "diagnosticTraining.underlyingGap": one training exercise that strengthens
    the underlying milestone / capability / habit behind today's difficulty.
    Do NOT name the gap, the deficit, or any past issue to the student.
  - "diagnosticTraining.todaysDifficulty": one training exercise that targets
    the specific difficulty the student faced in THIS question.`,
  },
  {
    id: "masteryIntro",
    title: "Mastery Mode Overview",
    defaultText:
`MASTERY mode (correct = true):
  Populate "advancedChallenge". Leave "studentCanDo.message" = "",
  "nextStep.dont/what/how" = "", and "diagnosticTraining.*" = "".`,
  },
  {
    id: "masteryHintStream",
    title: "Mastery: hintStream",
    defaultText:
`  - "hintStream": a short, warm congratulation sentence (this is what the
    student sees live).`,
  },
  {
    id: "advancedChallenge",
    title: "Mastery: advancedChallenge",
    defaultText:
`  - "advancedChallenge.congratulations": the same congratulation, full form.
  - "advancedChallenge.question": a brand-new question exactly one level more
    advanced than the current one (STEM: introduce an optimization
    constraint or symbolic variation; Humanities: a deeper thematic prompt,
    a more complex grammatical structure, or a comparative primary-source
    analysis). When a positive context fits naturally, WEAVE THE SCENARIO
    DIRECTLY INTO THIS QUESTION TEXT (e.g., "While volunteering at a food
    bank, calculate ..."). Do NOT leave the question neutral and put the
    scenario in positiveContext.message — the context belongs in the
    question itself.
  - "advancedChallenge.useImage": true ONLY if the current question has an
    image AND a harder image-based variant is natural. Otherwise false and
    write a text-only question.
  - "advancedChallenge.positiveContext.theme": the theme woven into the
    question — one of "VOLUNTEERING", "MOTHERS_DAY", "CHRISTMAS_CAROLLING",
    "HELPING_IN_WAR_OR_NEED", "SEASONAL_OR_CURRENT_NEWS", or
    "LOVE_OR_PEACE_GENERAL". "" if no positive context fits the question
    naturally — in that case the question stays neutral and message is "".
  - "advancedChallenge.positiveContext.message": OPTIONAL short closing line
    appended after the question (one sentence, encouraging). Leave "" if no
    extra closing line is needed, or if theme is "". Never put the scenario
    here — the scenario lives inside "question".`,
  },
  {
    id: "styleGuidance",
    title: "General Style Guidance",
    defaultText:
`Use the student's first name when given. Keep everything child-friendly,
encouraging, direct, and clear.`,
  },
];

export const AI_HINT_SECTION_COUNT = AI_HINT_SECTIONS.length;

export function defaultAiHintSections() {
  return AI_HINT_SECTIONS.map((s) => s.defaultText);
}

// Coerce whatever the caller stored / sent into a clean array of length
// AI_HINT_SECTION_COUNT, filling missing/blank entries with the default text
// so the assembled prompt is always complete.
export function normalizeAiHintSections(input) {
  const arr = Array.isArray(input) ? input : [];
  return AI_HINT_SECTIONS.map((meta, i) => {
    const v = arr[i];
    if (typeof v === "string" && v.trim()) return v;
    return meta.defaultText;
  });
}

export function assembleAiHintPrompt(sections) {
  return normalizeAiHintSections(sections).join("\n\n");
}
