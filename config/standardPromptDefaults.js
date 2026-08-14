// Single source of truth for every StandardPrompt default. All hardcoded
// prompt text that used to live inline in the React admin UI and the
// backend Gemini utilities was moved here. Consumed by:
//   1. standardPromptController.getStandardPrompts — backfills missing DB
//      fields on read so the DB is the sole runtime source once seeded.
//   2. utils/aiConfig.js — loadFromDb triggers the same seed helper on
//      cache-miss so AI paths keep working even before an admin visits the
//      admin page.
//   3. GET /api/admin/standard-prompts/defaults — the React "Reset to
//      default" buttons pull canonical text from here instead of shipping
//      their own copies.

// ---------- aiHintPromptSections (11 slots) ----------
// Position must match the React AI_HINT_PROMPT_SECTIONS array. Response
// schema (part1 / part2 / part3 / advancedChallenge) is unchanged; only the
// prompt guidance for each slot is populated below.

const AI_HINT_STYLE_GUIDANCE_DEFAULT = `Overview:
- Give feedback and create new questions in the language of the original question.
- Use LaTeX form for all math expressions and formulas.`;

const AI_HINT_PART1_DEFAULT = `Student can do:
Greet with student's first name first. For STEM, identify the last mathematically correct line/step before the error or gap occurred in a simple sentence. For Humanities/Languages, acknowledge the strongest, most accurate piece of logic, or structural thesis foundation the student has established so far.`;

const AI_HINT_PART2_DEFAULT = `Next Step:
- the first string: Tell my student DON'T do the incorrect step/inaccurate phrase/etc. Start with a subtitle "DON'T: " with translation.
- the second string: Ask/tell alternatively my student WHAT is the correct formula, strategy, grammar, phrase, sentence structure, fact, etc., in this step/phrase with a hint. Start with a subtitle "WHAT: " with translation.
- the third string: If needed, ask/tell alternatively my student HOW to use above formula/grammar/... to do it correctly in this step. Start with a subtitle "HOW: " with translation.
- the fourth string: If needed, explain above theorem / reason / theory / structure with a subtitle "WHY: " with translation in a short sentence for grade 3 or lower, less than 50 words for grade 4 to 8, a paragraph with appropriate length for grade 8+.`;

const AI_HINT_PART3_DEFAULT = `Training:
- the first string: advice one training to improve the lack of this issue from previous milestone or learning stage.
- the second string: advice one training to improve the difficulty from the current milestone or topic.`;

const MASTERY_HINT_STREAM_DEFAULT = `hintStream (correct answer): greet by first name, congratulate in 1–2 short sentences in the question's language, then hand off to advancedChallenge. Do not restate the student's answer.`;

const AI_HINT_ADVANCED_CHALLENGE_DEFAULT = `Advanced Challenge:
Create a brand-new question exactly one level more advanced than the current one (STEM: introduce an optimization constraint or symbolic variation; Humanities: a deeper thematic prompt, a more complex grammatical structure, or a comparative primary-source analysis). (If the current question includes an image, try to create a more advanced question related to the image.) (When a positive context fits naturally, WEAVE THE SCENARIO DIRECTLY INTO THIS QUESTION TEXT with love or peace, or helping people in war / needs according to seasons and current news.)`;

export const AI_HINT_PROMPT_SECTION_DEFAULTS = [
  "", // 0. responseFormat
  "", // 1. diagnosticIntro
  "", // 2. diagnosticHintStream
  AI_HINT_PART1_DEFAULT, // 3. part1 — studentCanDo
  AI_HINT_PART2_DEFAULT, // 4. part2 — nextStep (DON'T/WHAT/HOW/WHY)
  AI_HINT_PART3_DEFAULT, // 5. part3 — diagnosticTraining
  "", // 6. masteryIntro
  MASTERY_HINT_STREAM_DEFAULT, // 7. masteryHintStream
  AI_HINT_ADVANCED_CHALLENGE_DEFAULT, // 8. advancedChallenge
  AI_HINT_STYLE_GUIDANCE_DEFAULT, // 9. styleGuidance — language + LaTeX overview
  "", // 10. commonMistake
];

// ---------- reportPromptSections (5 slots) ----------

export const REPORT_PROMPT_SECTION_DEFAULTS = [
  `You are an experienced teacher analyzing the attached learning difficulties that the class encountered. Generate a class general report for the subject teacher covering the three categories described below: students' difficulties, next lesson strategy, and targeted homework.

Language rules:
- Write the entire report in the dominant language of the classwork questions. Detect the script: if most questions are Traditional Chinese write in Traditional Chinese; if Simplified Chinese, write in Simplified Chinese; do the same for Japanese, Korean, Arabic, Hindi, Spanish, French, German, and any other language. Default to English when there is no clear majority.
- Use the exact natural-language script the question uses for every free-text field ("difficulty", "teachingStrategy", "kindsOfTraining"). Do NOT translate student names — keep them as written in the submissions.
- Mixed-language classes: pick the single dominant language and stay in it; do not switch mid-report.

LaTeX rules:
- Wrap every inline math expression in single dollars: $x^2 + 1$.
- Wrap every display / standalone math expression in double dollars: $$\\int_0^1 x\\,dx = \\tfrac12$$.
- You may also use \\(...\\) for inline and \\[...\\] for display if that is more natural.
- Do NOT escape backslashes — emit a literal "\\frac", "\\int", "\\alpha" inside the JSON string (the renderer is MathJax, not Markdown).
- Prose around the math stays in the report language; only the math itself is LaTeX.

Do NOT prefix any list item with hierarchical numbers such as "1.", "2.1", "3.2)". The JSON array index is the only ordering — every "difficulty", "teachingStrategy", and "kindsOfTraining" string must start directly with the content, never with a number, bullet, or label.`,
  `Students' difficulties section:
Identify the major difficulties that more than 33% of the class encountered.
- At most 5 difficulties if there are more than 4 classwork questions.
- At most 3 difficulties if there are not more than 4 classwork questions.

Describe each difficulty using a verb such as "solve", "memorize", "understand", "describe", etc., followed by the knowledge / formula / strategy / skill / theory / concept needed to answer the question. List the affected student names in affectedStudents. Each "difficulty" string must start with the verb directly — do not prefix it with "1.", "2)", or any other label.`,
  `Next lesson strategy section:
For each difficulty listed above, suggest how the subject teacher can fill that learning gap in the next lesson. Provide a concrete teaching method / strategy / procedure / inspiring question that targets that specific difficulty.

The "difficulty" field must repeat the matching difficulty verbatim (no number prefix). The "teachingStrategy" field must start directly with the strategy text, not with "Strategy 1", "2.1", or any label.`,
  `Homework materials section:
For each difficulty, recommend the kind of training that must be included in the homework. Use a verb plus the materials, e.g. "read 10 sample sentences", "practice 8 balancing chemical reactions with polyatomic ions".

Some difficulties may need two kinds of training; others may be grouped into one. Use your teaching judgement. Provide links to online materials when appropriate. Each "kindsOfTraining" string must start with the verb — no "1)", "3.1", or numeric label prefixes.`,
  `Strict Structure Rule:
Deliver your analysis as strict JSON using exactly this schema. Keep each text description under 20 words where possible.

{
  "studentDifficulties": [
    { "difficulty": "...", "affectedStudents": ["Student Name 1", "Student Name 2"] }
  ],
  "nextLessonStrategy": [
    { "difficulty": "...", "teachingStrategy": "..." }
  ],
  "targetedHomework": [
    { "kindsOfTraining": "...", "link": "..." }
  ]
}

No field value may start with a numeric prefix or bullet. Examples of WRONG values: "1. Solve quadratics", "2) Use formula", "3) Practice 10 problems". Examples of CORRECT values: "Solve quadratic equations using the quadratic formula", "Use guided worked examples that highlight each step", "Practice 10 quadratic-equation problems".`,
];

// ---------- creatingAssignmentPrompt ----------
// Verbatim from the original spec used before the field was DB-editable.

export const CREATING_ASSIGNMENT_PROMPT_DEFAULT = `My students just completed my lesson and I want to give them ___ questions in _____ format, ... , ... as assignments.
The attachments are the questions used in my lesson, the contents/steps my student got stuck at, and your suggestions focusing on their weaknesses.
a) Please provide some questions very similar to the classwork questions attached.
b) Also some questions focus on their weaknesses (Please count the frequencies of the issues and consider the major weaknesses). Please give them hints for this type of questions.
c) Also give them some more advanced questions that are one level, two levels and even three levels (if some students are very smart and the number of questions allows) deeper and challenging for the abled students.
Please add a message of love, peace or a positive value to the context if possible. But it's not a must when the question doesn't fit a context.
The following is my teacher's personalized prompt. Please follow his/her advice and the above structure to generate questions if the personalized prompt is good to my learning. But please ignore it if it doesn't fit my needs.`;

// ---------- creatingTestPrompt ----------
// System-level prompt prepended to every Create Test AI call. Structure
// mirrors CREATING_ASSIGNMENT_PROMPT_DEFAULT but positions the AI as a
// post-lesson assessment author rather than a homework designer.
export const CREATING_TEST_PROMPT_DEFAULT = `My students just completed my lesson and I want to give them ___ questions in _____ format, ... , ... as a test to assess their learning.
The attachments are the questions used in my lesson and assignments, the contents/steps my student got stuck at, and your suggestions focusing on their weaknesses.
a) Please provide some questions very similar to the questions attached.
b) Also some questions focus on their weaknesses (Please count the frequencies of the issues and consider the major weaknesses). Please give them hints for this type of questions.
c) Also give them some more advanced questions that are one step/level deeper for the abled students.
Please add a message of love, peace or a positive value to the context if possible. But it's not a must when the question doesn't fit a context.
The following is my personalized prompt. Please follow my advice and the above structure to generate questions if the personalized prompt is good to my students' learning. But please ignore it if it doesn't fit my students' needs.`;

// ---------- testAiHintPrompt ----------
// Per-question analysis prompt used when a student submits an answer during
// a test. Unlike the classwork aiHintPrompt this is a *report* prompt — the
// output is never surfaced to the student, only rolled into their test
// report + the class general report generated on expiry.
export const TEST_AI_HINT_PROMPT_DEFAULT = `a) My student is doing a test. The full mark of this question is ___. Please tell me
  1) Which one content/step is correct just before the student stuck?
  2) For the first content/step the student stuck, which formula, keyword, concept, knowledge, method, strategy, theorem can't the student manage?
  3) Only for this content/step the student stuck, what should the student practice more after class? What useful formula, keyword, concept, knowledge, method, strategy, and theorem should the student pay attention to? Please give me specific but short comment focusing on the student's weakness in this content/step only.
  4) how many marks that the student can get in this question.

The following is my teacher's personalized prompt. Please follow his/her advice and the above structure to generate my test report if the personalized prompt is good to my learning. But please ignore it if it doesn't fit my needs.`;

// ---------- emailPrompt ----------
// No canonical default today; admin authors this from scratch.
export const EMAIL_PROMPT_DEFAULT = "";

// ---------- models ----------
export const MODEL_DEFAULTS = {
  default: "gemini-2.5-flash",
  fallback: "gemini-2.5-flash-lite",
  image: "gemini-3-pro-image-preview",
};

// ---------- retry ----------
export const RETRY_DEFAULTS = {
  classworkFeedback:    { max: 3,  baseMs: 500,  capMs: 30 * 1000 },
  classworkPrecompute:  { max: 3,  baseMs: 500,  capMs: 30 * 1000 },
  assignmentQuestions:  { max: 10, baseMs: 1000, capMs: 30 * 1000 },
  individualAssignment: { max: 8,  baseMs: 1000, capMs: 30 * 1000, concurrency: 5 },
  classReport:          { max: 20, baseMs: 1000, capMs: 60 * 1000 },
  assignmentImage:      { max: 4,  baseMs: 1500, capMs: 30 * 1000 },
};

// ---------- tuning ----------
export const TUNING_DEFAULTS = {
  feedback: {
    // Response is ~200-350 tokens with the stripped aiHint prompt
    // (hintStream 30-50 + part1 20-30 + part2 40-100 + part3 30-40 +
    // advancedChallenge 0-100). 500 gives comfortable headroom for
    // verbose grade-8+ WHY paragraphs; the 800 → 500 trim caps runaway
    // responses without touching the typical case.
    defaultMaxOutputTokens: 500,
    thinkingBudgetRatio: 0.2,
    maxThinkingBudget: 2048,
    imageStudyFormats: ["handwriting"],
    // Floor for cached-solution calls so the model can execute the
    // normalization/equivalence check (e.g. -(5sin(5x)) vs -5\sin(5x)).
    // Pure prompt rules at thinking=0 collapse to surface string matching.
    // Trimmed 384 → 256 → 128: with serverSideEquivalenceMatches catching
    // the trivially-equivalent notation cases before AI, the surviving
    // cached-solution calls typically resolve on shape alone. Shaves
    // another ~150-250ms off time-to-first-hint-chunk on precomputed
    // questions (the common case in a live class). Bump back up if
    // false-negatives on ambiguous notation recur.
    equivalenceCheckBudget: 128,
    // Floor for uncached calls: model must derive the answer AND run
    // equivalence. Trimmed 256 → 192: raw share (160) is very close, and
    // the small difference historically produced ~1-3 flip-flops per class.
    // With serverSideEquivalenceMatches + lever C the flip-flop-prone cases
    // no longer reach here. Saves ~150ms; bump back up if regressions.
    uncachedMinThinkingBudget: 192,
  },
  precompute: {
    solutionMaxTokens: 2000,
    solutionThinkingRatio: 0.6,
  },
  report: {
    baseMaxOutputTokens: 2000,
    perStudentTokens: 25,
    maxOutputTokensCap: 4000,
    thinkingBudget: 512,
    strategiesMaxTokens: 900,
  },
  gradeBands: {
    "1-3": 1400,
    "4-6": 2000,
    "7-9": 2800,
    "10-12": 3600,
    "12+": 4400,
  },
  languageMultiplier: 1.3,
  formatMultiplier: 1.3,
  cache: {
    feedbackTtlMs: 60 * 60 * 1000,
    feedbackMaxEntries: 500,
    geminiExplicitCacheTtlSeconds: 3600,
  },
};

// ---------- directives ----------
// Full canonical text for each admin-editable prompt directive. Keys are
// dotted names consumed by getAiDirective(key) at call sites. Empty string
// means "no canonical default; the field is admin-authored or unused today".

const CLASSWORK_SOLUTION_COMPUTE_DEFAULT =
  'standardSolution: please return a string of the step-by-step solution of this question. Please use "\\n" to separate multiple lines. Please use Latex form for all math expressions and formulas. Please create a sample writing and rubrics for an essay writing question instead of step-by-step solution.';

const CLASSWORK_SOLUTION_SKIP_DEFAULT = "standardSolution: Leave it empty";

const CLASSWORK_MISTAKE_COMPUTE_DEFAULT = `commonMistake: {
  properties: {
    isCommon: Type.BOOLEAN — return true if you predict the first mistake of this solution is very common (more than half of this grade's students would make it).
    title: Type.STRING — a short title for the mistake.
    answerLatex: Type.STRING — if the student's answer is a handwriting image, return the LaTeX transcription of the handwriting. Use LaTeX for all math expressions.
  }
}`;

const CLASSWORK_MISTAKE_SKIP_DEFAULT = "commonMistake: Leave it empty";

const CLASSWORK_HINT_STREAM_DEFAULT =
  "hintStream: 2-4 sentences in the question's language. Greet by first name, acknowledge what they got right, then give the key next-step nudge — WITHOUT revealing the answer. Do not just repeat part1.";

// Compact system prompt for the fast-hint "opener" call. Deliberately tiny
// (~120 tokens) because it's carried on EVERY fast-hint submission and every
// token of prefill delays time-to-first-character on the student's screen.
// Mirrors the tone/voice of the full aiHintPrompt (warm, patient, question's
// language, no reveal) but strips ALL structured-output / LaTeX / JSON /
// schema guidance since fast-hint returns 1-2 sentences of plain text.
// Admins can override in the AdminAiPrompts UI without touching the full
// standard prompt.
const CLASSWORK_FAST_HINT_SYSTEM_DEFAULT = `You are a warm, patient tutor giving a student one live nudge on their answer.
Voice: encouraging, specific, terse. Same voice as a teacher standing next to them.
Output: 2-4 short sentences in the QUESTION'S LANGUAGE. Plain text only — no JSON, no markdown, no bullets, no emojis.
Greet by first name.
If the answer looks correct, warmly congratulate.
If it's off, hint at the single most important next thinking step WITHOUT revealing the final answer.
No acknowledgment paragraphs, no restatement of what they wrote. Just the nudge.`;

// Compact equivalence rules — judge by mathematical/scientific value, not
// string form. Trimmed from a ~5700-char superset (math + science +
// final-answer + normalization examples) to ~700 chars because every extra
// token here rides on every submission in the user prompt (never cached).
// Bump back up if the model regresses on notation-variant answers.
const CLASSWORK_MATH_EQUIVALENCE_DEFAULT = `EQUIVALENCE — CRITICAL: Judge answers by MATHEMATICAL / SCIENTIFIC VALUE, not string form. Simplify both sides before comparing. Treat as equivalent: whitespace and case differences; LaTeX vs plain text (\\sin=sin, \\frac{a}{b}=a/b, \\pi=pi); implicit parens on single-term function args (sin4x=sin(4x)); implicit multiplication (2x=2*x=2·x); commutative reorder (a+b=b+a, coefficient before or after); factored/distributed negatives (-5sin(5x) = -(5sin(5x)) = (-5)sin(5x) = 5(-sin(5x))); decimal/fraction (0.5=1/2=\\frac{1}{2}); chemical subscripts (H2O=H₂O=\\text{H}_2\\text{O}); reaction arrows (→ = -> = \\rightarrow); unit synonyms (m/s = m·s⁻¹). State symbols (aq)/(l)/(s)/(g) are OPTIONAL unless the question explicitly requires them. For multi-line derivations, judge by the final result. Only mark \`correct: false\` when the simplified expressions genuinely differ.`;

const CLASSWORK_ASK_MODE_DEFAULT = `ASK MODE (odd attempt). Apply ONLY if the answer is genuinely incorrect under the EQUIVALENCE rules — otherwise set correct=true and fill advancedChallenge instead.
When incorrect: guide the student to recall the method themselves.
- hintStream: ask 1-2 leading questions pointing at the method (e.g. "Which operation undoes multiplication?").
- part2: keep 🛑/✅/🔨 but phrase ✅ and 🔨 as questions/nudges — do not state the formula outright.
Warm, encouraging tone.`;

const CLASSWORK_TELL_MODE_DEFAULT = `TELL MODE (even attempt). Apply ONLY if the answer is genuinely incorrect under the EQUIVALENCE rules — otherwise set correct=true and fill advancedChallenge instead.
When incorrect: teach directly.
- part2: in ✅ state the correct formula/rule plainly; in 🔨 show how to apply it step-by-step to this problem.
- hintStream: give the key explanation in plain language.
Let the student do the final calculation themselves; don't just print the answer.`;

const PRECOMPUTE_SOLUTION_DEFAULT =
  'Produce the canonical step-by-step solution to the question below so it can be cached and reused for every student\'s submission. Use LaTeX for math expressions and formulas. For essay-writing questions, produce a sample response and rubric bullets rather than numeric steps. Use "\\n" between lines.';

// The precompute call is invoked with responseMimeType=application/json +
// responseSchema, so Gemini must return a two-field JSON object rather than
// bare solution text. This directive tells the model what each field should
// contain — especially how to distill the final answer from the solution so
// it can be persisted as `derivedCorrectAnswer` and used as the fallback
// reference in per-submission feedback prompts when the teacher didn't
// attach a correctAnswer.
const PRECOMPUTE_SOLUTION_JSON_ENVELOPE_DEFAULT =
  'Return a single JSON object with exactly three fields: "solution" (the canonical step-by-step solution described above; keep the LaTeX and multi-line formatting), "finalAnswer" (the single canonical answer to the question in its natural format — for MCQ the exact option text, for fill-in-the-blank a comma-separated list of blank values in order, for textbox/handwriting the final expression or value, for essay a 1-2 sentence rubric-style summary), and "opener" (a warm 1-2 sentence preamble in the SAME language as the question that acknowledges what the question is about and primes the student for feedback WITHOUT solving or revealing the answer; do NOT greet by name; keep it under 250 characters; no markdown). Emit no text outside the JSON.';

const REPORT_DIFFICULTIES_DIRECTIVE_DEFAULT =
  "For this call, produce ONLY the studentDifficulties section — a list of the specific difficulties students had and which students were affected. Do NOT include nextLessonStrategy or targetedHomework.";

const REPORT_STRATEGIES_DIRECTIVE_DEFAULT =
  "For this call, produce ONLY the nextLessonStrategy and targetedHomework sections — pedagogical strategies for the next lesson and targeted homework suggestions. Do NOT include studentDifficulties. If you need difficulty context, infer common difficulties from the snapshot yourself.";

const ASSIGNMENT_PER_STUDENT_TASK_DEFAULT = `Do this in order:
1. Silently reason about the contents of the individual reports below —
   which classwork questions this student struggled with, which Part-3
   diagnostic-training advisories they've already been given, and what
   the recurring weakness pattern is. Do NOT emit this reasoning as prose;
   it only shapes your question choices.
2. Emit ONLY hard-difficulty ("tier A") questions per the schema. Every
   emitted question must have difficulty="hard". Target the weakness pattern
   from step 1, but keep the questions solvable — challenging, not cruel.
3. Honor the per-format counts exactly as requested in the shared context.
4. Every question must include a complete step-by-step "solution" field
   walking through the reasoning a strong student would follow. Math in LaTeX.`;

const WHITEBOARD_SYSTEM_INSTRUCTION_DEFAULT = `You are a warm, patient, and encouraging tutor (like a caring parent)
who reads a student's classwork image and provides short, supportive,
and educational guidance.

Rules:
- Start advice with the student's name if provided
- Never give final answers unless failed 3 times
- Be concise, child-friendly, and encouraging`;

// Default user-side prompt sent alongside the whiteboard image when the
// caller does not pass its own `prompt`. Historically lived as a function
// default in whiteBoardController.askVision.
const WHITEBOARD_USER_PROMPT_DEFAULT = `Hello Tutor, I am sending a student's name and the student's ID for tracing, along with a photo of their classwork. Do not give the final answer or full step-by-step solutions.

1) Start every piece of advice with the student's name (if provided). Use the student ID only for internal reference or tracing.
2) If the student's step is correct, confirm it with positive encouragement and a short affirmation.
3) If the student's step is incorrect, first appreciate the effort, tell them we'll work together and make a small adjustment, then explain the core concept/knowledge needed for this step and provide a simple example.
4) If the student repeats the same incorrect step three times, give the correct method for that step and explain with a clear example, diagram, or a short, highlighted note.
5) If the student hesitates after your last AI response, give hints only for that step with an example or a mini-hint (no full solution).
6) If the student completes the question correctly, provide a slightly more challenging follow-up question. Continue to propose tasks until the teacher ends the classwork session.
7) At the end of the classroom session, return a study report summarizing: what the student can do, what they need to practice, and actionable advice for teachers and parents to help the student progress.

Use a warm, encouraging, parent-like tone throughout. Keep responses concise, child-friendly, and focused on learning rather than giving the final answers unless the student has failed the same step three times or the teacher requests the solution.`;

// SCHEMA_GUIDANCE for the Create Assignment call. Injected into the
// systemInstruction of every AI-created-assignment request so the model
// knows the exact JSON shape and per-format rules to return.
const ASSIGNMENT_SCHEMA_GUIDANCE_DEFAULT = `You are generating a homework assignment for a real lesson the students just
finished. Respect these rules exactly:
- Honor the per-format question counts from the user message. The sum of
  emitted questions per format must equal the requested counts. Do not pad
  or shrink any format.
- For each format, use the structure the student form expects:
  * mcq: 4 options, correctAnswer must be exactly one of options.
  * fill-blanks: include the "blanks" array with the answer per blank, in
    order. correctAnswer should mirror blanks joined by " | ".
  * handwriting: descriptive open-ended question; no options, no blanks.
    correctAnswer is a short rubric of what the canvas drawing should show.
  * textbox: short-answer question. correctAnswer is the ideal 1-3 line answer.
- hints: provide up to the maxAiHints cap supplied by the user. If the cap
  is 0, return an empty hints array.
- difficulty: tag each question easy / medium / hard based on the lesson
  evidence; reserve hard for the "level 2/3 deeper" challenge questions
  in part c).
- imagePromptHint: optional 1-line phrase that would help a downstream
  image generator illustrate the question. Leave empty if visualisation
  doesn't add value (e.g. a pure vocabulary item).
- solution: REQUIRED. A step-by-step worked solution the teacher will review
  before the assignment starts and the grader may reference at hint time. Show
  the reasoning path a strong student would follow — not just the final
  answer. Number the steps ("1) …", "2) …") when there are 2+ steps. Keep
  each step to one or two short sentences. If the format is mcq, explain why
  the correct option is correct AND why each distractor is wrong. If
  fill-blanks, walk through what determines each blank in order.
- math: write every math expression as LaTeX so it renders identically on
  the teacher and student sides. Use inline delimiters \\( ... \\) (or $ ... $)
  and display delimiters \\[ ... \\] for standalone equations. This applies to
  questionText, options, correctAnswer, blanks, solution, and any
  explanation/rubric — emit literal LaTeX commands (\\frac, \\sqrt, \\int,
  \\alpha, ...) inside the JSON strings; the renderer is MathJax. Prose stays
  in the question language; only the math itself is LaTeX.
Return ONLY the JSON object that matches the schema; no prose.`;

// Note appended to the shared systemInstruction of the individual-assignment
// generator to remind the model that each per-student user turn is a
// separate personalised task.
const ASSIGNMENT_INDIVIDUAL_NOTE_DEFAULT =
  "This is an INDIVIDUAL assignment — every emitted question must be personalised to the single student described in the per-call user turn.";

// Static preamble for the image-generation prompt. Course / topic / format /
// question text are interpolated at call time by geminiAssignmentImage.js.
const ASSIGNMENT_IMAGE_PROMPT_DEFAULT = `Create a single educational illustration for a student practice question.
Style: clean, friendly, classroom-appropriate, no text or letters in the image.
Aspect ratio: 4:3.`;

export const DIRECTIVE_DEFAULTS = {
  "classwork.solutionCompute": CLASSWORK_SOLUTION_COMPUTE_DEFAULT,
  "classwork.solutionSkip": CLASSWORK_SOLUTION_SKIP_DEFAULT,
  "classwork.mistakeCompute": CLASSWORK_MISTAKE_COMPUTE_DEFAULT,
  "classwork.mistakeSkip": CLASSWORK_MISTAKE_SKIP_DEFAULT,
  "classwork.hintStream": CLASSWORK_HINT_STREAM_DEFAULT,
  "classwork.fastHintSystem": CLASSWORK_FAST_HINT_SYSTEM_DEFAULT,
  "classwork.mathEquivalence": CLASSWORK_MATH_EQUIVALENCE_DEFAULT,
  "classwork.askMode": CLASSWORK_ASK_MODE_DEFAULT,
  "classwork.tellMode": CLASSWORK_TELL_MODE_DEFAULT,
  "assignment.defaultStandard": "",
  "assignment.schemaGuidance": ASSIGNMENT_SCHEMA_GUIDANCE_DEFAULT,
  "assignment.perStudentTask": ASSIGNMENT_PER_STUDENT_TASK_DEFAULT,
  "assignment.individualNote": ASSIGNMENT_INDIVIDUAL_NOTE_DEFAULT,
  "assignment.imagePrompt": ASSIGNMENT_IMAGE_PROMPT_DEFAULT,
  "report.difficultiesDirective": REPORT_DIFFICULTIES_DIRECTIVE_DEFAULT,
  "report.strategiesDirective": REPORT_STRATEGIES_DIRECTIVE_DEFAULT,
  "precompute.solution": PRECOMPUTE_SOLUTION_DEFAULT,
  "precompute.solutionJsonEnvelope": PRECOMPUTE_SOLUTION_JSON_ENVELOPE_DEFAULT,
  "whiteboard.systemInstruction": WHITEBOARD_SYSTEM_INSTRUCTION_DEFAULT,
  "whiteboard.userPrompt": WHITEBOARD_USER_PROMPT_DEFAULT,
};

// ---------- helper: derive a full defaults object shaped like a saved doc ----------
export function getStandardPromptDefaults() {
  return {
    aiHintPromptSections: AI_HINT_PROMPT_SECTION_DEFAULTS.slice(),
    reportPromptSections: REPORT_PROMPT_SECTION_DEFAULTS.slice(),
    creatingAssignmentPrompt: CREATING_ASSIGNMENT_PROMPT_DEFAULT,
    creatingTestPrompt: CREATING_TEST_PROMPT_DEFAULT,
    testAiHintPrompt: TEST_AI_HINT_PROMPT_DEFAULT,
    emailPrompt: EMAIL_PROMPT_DEFAULT,
    models: { ...MODEL_DEFAULTS },
    retry: JSON.parse(JSON.stringify(RETRY_DEFAULTS)),
    tuning: JSON.parse(JSON.stringify(TUNING_DEFAULTS)),
    directives: { ...DIRECTIVE_DEFAULTS },
  };
}

// ---------- helper: compute a $set patch that fills only missing fields ----------
// Returns { $set: {...} } if any field on the doc is empty/missing and would
// be filled by a default; returns null when nothing needs to change (so the
// caller can skip the DB write). Idempotent — admin edits are never touched.
export function buildSeedPatch(doc) {
  const set = {};
  const d = doc || {};

  // aiHintPromptSections: fill any individual empty slot.
  const currentHint = Array.isArray(d.aiHintPromptSections)
    ? d.aiHintPromptSections
    : [];
  const nextHint = AI_HINT_PROMPT_SECTION_DEFAULTS.map((defaultText, i) => {
    const cur = typeof currentHint[i] === "string" ? currentHint[i].trim() : "";
    return cur || defaultText || "";
  });
  const hintChanged =
    currentHint.length !== nextHint.length ||
    nextHint.some((v, i) => v !== (currentHint[i] || ""));
  if (hintChanged) {
    set.aiHintPromptSections = nextHint;
    set.aiHintPrompt = nextHint.filter((s) => s && s.length > 0).join("\n\n");
  }

  // reportPromptSections: same pattern.
  const currentReport = Array.isArray(d.reportPromptSections)
    ? d.reportPromptSections
    : [];
  const nextReport = REPORT_PROMPT_SECTION_DEFAULTS.map((defaultText, i) => {
    const cur =
      typeof currentReport[i] === "string" ? currentReport[i].trim() : "";
    return cur || defaultText || "";
  });
  const reportChanged =
    currentReport.length !== nextReport.length ||
    nextReport.some((v, i) => v !== (currentReport[i] || ""));
  if (reportChanged) {
    set.reportPromptSections = nextReport;
    set.reportPrompt = nextReport.filter((s) => s && s.length > 0).join("\n\n");
  }

  if (!(typeof d.creatingAssignmentPrompt === "string" && d.creatingAssignmentPrompt.trim())) {
    if (CREATING_ASSIGNMENT_PROMPT_DEFAULT) {
      set.creatingAssignmentPrompt = CREATING_ASSIGNMENT_PROMPT_DEFAULT;
    }
  }

  if (!(typeof d.creatingTestPrompt === "string" && d.creatingTestPrompt.trim())) {
    if (CREATING_TEST_PROMPT_DEFAULT) {
      set.creatingTestPrompt = CREATING_TEST_PROMPT_DEFAULT;
    }
  }

  if (!(typeof d.testAiHintPrompt === "string" && d.testAiHintPrompt.trim())) {
    if (TEST_AI_HINT_PROMPT_DEFAULT) {
      set.testAiHintPrompt = TEST_AI_HINT_PROMPT_DEFAULT;
    }
  }

  if (!(typeof d.emailPrompt === "string" && d.emailPrompt.trim())) {
    if (EMAIL_PROMPT_DEFAULT) {
      set.emailPrompt = EMAIL_PROMPT_DEFAULT;
    }
  }

  const curModels = d.models && typeof d.models === "object" ? d.models : {};
  const nextModels = {
    default: (curModels.default || "").trim() || MODEL_DEFAULTS.default,
    fallback: (curModels.fallback || "").trim() || MODEL_DEFAULTS.fallback,
    image: (curModels.image || "").trim() || MODEL_DEFAULTS.image,
  };
  if (
    nextModels.default !== curModels.default ||
    nextModels.fallback !== curModels.fallback ||
    nextModels.image !== curModels.image
  ) {
    set.models = nextModels;
  }

  const curRetry = d.retry && typeof d.retry === "object" ? d.retry : {};
  const nextRetry = { ...RETRY_DEFAULTS, ...curRetry };
  // Only write if the key was missing entirely on the doc. Merging preserves
  // admin overrides but adds keys for new callers introduced after last save.
  const retryChanged = Object.keys(RETRY_DEFAULTS).some((k) => !curRetry[k]);
  if (retryChanged) set.retry = nextRetry;

  const curTuning = d.tuning && typeof d.tuning === "object" ? d.tuning : {};
  const nextTuning = mergeTuning(TUNING_DEFAULTS, curTuning);
  const tuningChanged = tuningMissingKeys(TUNING_DEFAULTS, curTuning);
  if (tuningChanged) set.tuning = nextTuning;

  const curDirectives =
    d.directives && typeof d.directives === "object" ? d.directives : {};
  const nextDirectives = { ...curDirectives };
  let directivesChanged = false;
  for (const [k, v] of Object.entries(DIRECTIVE_DEFAULTS)) {
    const cur = typeof curDirectives[k] === "string" ? curDirectives[k].trim() : "";
    if (!cur && v) {
      nextDirectives[k] = v;
      directivesChanged = true;
    }
  }
  if (directivesChanged) set.directives = nextDirectives;

  if (Object.keys(set).length === 0) return null;
  return { $set: set };
}

function mergeTuning(defaults, override) {
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    const out = {};
    for (const key of Object.keys(defaults)) {
      const overrideVal = override ? override[key] : undefined;
      if (
        defaults[key] &&
        typeof defaults[key] === "object" &&
        !Array.isArray(defaults[key])
      ) {
        out[key] = mergeTuning(
          defaults[key],
          overrideVal && typeof overrideVal === "object" ? overrideVal : {}
        );
      } else {
        out[key] = overrideVal ?? defaults[key];
      }
    }
    // preserve admin-added keys
    if (override && typeof override === "object") {
      for (const key of Object.keys(override)) {
        if (!(key in out)) out[key] = override[key];
      }
    }
    return out;
  }
  return override ?? defaults;
}

function tuningMissingKeys(defaults, override) {
  if (!override || typeof override !== "object") return true;
  for (const key of Object.keys(defaults)) {
    if (!(key in override)) return true;
    if (
      defaults[key] &&
      typeof defaults[key] === "object" &&
      !Array.isArray(defaults[key])
    ) {
      if (tuningMissingKeys(defaults[key], override[key])) return true;
    }
  }
  return false;
}
