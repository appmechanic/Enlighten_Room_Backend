// The classwork-feedback rules block (what used to live hard-coded at
// geminiClassworkFeedback.js lines 81-148) split into 10 string constants.
// buildJsonResponseRules() maps over them and joins to form the complete
// prompt body sent to Gemini, so editing any one section here changes the
// rules in isolation without touching the assembly logic.

const RESPONSE_FORMAT =
`You MUST respond with a single JSON object only (no prose, no markdown fences).

Set "correct" to true ONLY if every step and the final answer are complete and correct.
Choose ONE of two modes based on "correct":`;

const DIAGNOSTIC_INTRO =
`DIAGNOSTIC mode (correct = false):
  Populate "studentCanDo", "nextStep", "diagnosticTraining".
  Leave "advancedChallenge.congratulations" = "" and "advancedChallenge.question" = "".`;

const DIAGNOSTIC_HINT_STREAM =
`  - "hintStream": the live, student-facing hint, built as a single flowing
    string: first the DON'T line, then WHAT to do next (never reveal the
    exact expression or sentence), then HOW to do it. Append a short concept
    explanation tuned to the grade band when useful.`;

const STUDENT_CAN_DO =
`  - "studentCanDo.subjectTrack": "STEM" or "HUMANITIES_LANGUAGES".
  - "studentCanDo.message": ONE sentence starting with "Hi [first name], you ...".
    For STEM, name the last mathematically correct line/step. For Humanities/
    Languages, name the strongest correct logic, translation fragment, factual
    premise, or thesis foundation so far.`;

const NEXT_STEP =
`  - "nextStep.dont": what NOT to do (the incorrect step), in clear plain language.
  - "nextStep.what": the correct formula / strategy / grammar / phrase / sentence
    structure / fact to apply next, WITHOUT revealing the exact expression or
    sentence.
  - "nextStep.how": how to perform it next step, if useful. "" if not needed.
  - "nextStep.explanation.gradeBand": one of "G3_OR_LOWER", "G4_TO_G8", "G9_PLUS".
  - "nextStep.explanation.text": explain the underlying theorem / reason /
    theory / structure. G3 or lower = one short sentence. G4–G8 = under 50
    words. G9+ = a paragraph of appropriate length. "" only if no
    explanation is needed.`;

const DIAGNOSTIC_TRAINING =
`  - "diagnosticTraining.underlyingGap": one training exercise that strengthens
    the underlying milestone / capability / habit behind today's difficulty.
    Do NOT name the gap, the deficit, or any past issue to the student.
  - "diagnosticTraining.todaysDifficulty": one training exercise that targets
    the specific difficulty the student faced in THIS question.`;

const MASTERY_INTRO =
`MASTERY mode (correct = true):
  Populate "advancedChallenge". Leave "studentCanDo.message" = "",
  "nextStep.dont/what/how" = "", and "diagnosticTraining.*" = "".`;

const MASTERY_HINT_STREAM =
`  - "hintStream": a short, warm congratulation sentence (this is what the
    student sees live).`;

const ADVANCED_CHALLENGE =
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
    here — the scenario lives inside "question".`;

const STYLE_GUIDANCE =
`Use the student's first name when given. Keep everything child-friendly,
encouraging, direct, and clear.`;

export const AI_HINT_SECTIONS = [
  RESPONSE_FORMAT,
  DIAGNOSTIC_INTRO,
  DIAGNOSTIC_HINT_STREAM,
  STUDENT_CAN_DO,
  NEXT_STEP,
  DIAGNOSTIC_TRAINING,
  MASTERY_INTRO,
  MASTERY_HINT_STREAM,
  ADVANCED_CHALLENGE,
  STYLE_GUIDANCE,
];

export function buildJsonResponseRules() {
  return AI_HINT_SECTIONS.map((section) => section.trim()).join("\n\n");
}
