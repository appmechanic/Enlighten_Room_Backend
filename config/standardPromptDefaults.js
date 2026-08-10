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
// Position must match the React AI_HINT_PROMPT_SECTIONS array. Most sections
// are admin-authored from scratch (empty default); only slot 7
// (masteryHintStream) ships with canonical text.

const MASTERY_HINT_STREAM_DEFAULT = `When "correct" is true, hintStream MUST be a 4-block breakdown that mirrors the diagnostic-mode structure, positively framed. Use the SAME emoji tokens the diagnostic mode uses, one block per line, in this exact order:
🛑 <one short line naming the specific mistake the student *avoided* on this attempt — e.g. "You didn't confuse dividing by 3 with subtracting 3">.
💡 <one short line explaining *why* the operation they applied is the right inverse for this equation/problem shape — the underlying principle, not the numbers>.
🛠️ <one short line giving a repeatable procedure they can reuse on the next similar problem — a "next time, do X then Y" recipe>.
🔍 <one short line connecting this to the broader concept (balance / inverse operations / isolating the variable / units / definitions, whichever fits) so the student can generalise beyond this specific question>.

Style rules for the correct-answer hintStream:
- Start with "Hi <studentName>! " on the same line as the first sentence; do NOT put the greeting on its own line.
- One sentence per block. No numbered prefixes, no markdown headings, no "Great job!" filler.
- Warm second-person tone, same voice as the diagnostic mode.
- Keep the whole hintStream under 90 words so it stays scannable on a phone.
- Do NOT restate the part1 message — that array already carries "you correctly did X". hintStream is the deeper unpack.
- If the answer is correct after earlier wrong attempts on the same question, weave ONE line into 🛠️ or 🔍 acknowledging the correction (e.g. "you switched from adding to subtracting — good catch") without labelling it separately.`;

export const AI_HINT_PROMPT_SECTION_DEFAULTS = [
  "", // 0. responseFormat
  "", // 1. diagnosticIntro
  "", // 2. diagnosticHintStream
  "", // 3. part1
  "", // 4. part2
  "", // 5. part3
  "", // 6. masteryIntro
  MASTERY_HINT_STREAM_DEFAULT, // 7. masteryHintStream
  "", // 8. advancedChallenge
  "", // 9. styleGuidance
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
    defaultMaxOutputTokens: 800,
    thinkingBudgetRatio: 0.2,
    maxThinkingBudget: 2048,
    imageStudyFormats: ["handwriting"],
    // Floor for cached-solution calls so the model can execute the
    // normalization/equivalence check (e.g. -(5sin(5x)) vs -5\sin(5x)).
    // Pure prompt rules at thinking=0 collapse to surface string matching.
    equivalenceCheckBudget: 384,
    // Floor for uncached calls: model must derive the answer AND run
    // equivalence. At the previous 160-token share (ratio 0.2 × 800) it
    // collapsed to string matching for cases like -5sin5x vs -5sin(5x)
    // and the model rationalised correct=false to satisfy the ASK-mode
    // hint it had already committed to writing.
    uncachedMinThinkingBudget: 512,
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
  "hintStream: This is the ONLY text the student watches stream live, so it must stand alone as a genuinely useful hint. Write 2-4 complete sentences in the language of the original question that (1) greet the student by first name, (2) briefly acknowledge what they did right, and (3) give the single most important next-step nudge toward the correct method — WITHOUT revealing the final answer. Do NOT put only a greeting here, and do NOT just repeat part1.";

// Canonical equivalence rules — the superset that covers math, science, and
// final-answer extraction. Backend used to ship a math-only subset; this
// unified version is now the single default.
const CLASSWORK_MATH_EQUIVALENCE_DEFAULT = `MATHEMATICAL EQUIVALENCE — CRITICAL:
When deciding if the student's answer matches the reference answer, judge by MATHEMATICAL VALUE, not string form. Two expressions that simplify to the same thing are the SAME answer, regardless of notation. Do NOT mark an answer wrong for a notation/format difference alone.
Treat ALL of the following as equivalent:
- Implicit parentheses around single-term function arguments: sin4x = sin(4x) = \\sin(4x) = \\sin 4x; cos2x = cos(2x); tan(x/2) = tan x/2; log5x = log(5x); ln2x = ln(2x); sqrt2x = sqrt(2x) = \\sqrt{2x}.
- Implicit multiplication: 2x = 2*x = 2·x = 2 \\cdot x; 3cos(x) = 3*cos(x) = 3 cos(x); (2)(3) = 2·3 = 6.
- LaTeX vs plain text: \\sin, \\cos, \\tan, \\log, \\ln, \\sqrt, \\pi, \\theta, \\alpha, \\infty are the same as sin, cos, tan, log, ln, sqrt, pi, theta, alpha, infinity/∞.
- Fractions: \\frac{a}{b} = a/b = (a)/(b) = a÷b; \\dfrac and \\tfrac behave the same as \\frac.
- Exponents & roots: x^-3 = x^{-3} = 1/x^3 = 1/(x^3) = \\frac{1}{x^3}; x^(1/2) = x^{1/2} = sqrt(x) = \\sqrt{x}; x^2 = x*x = x·x.
- Negative / reciprocal forms: -2x^-3 = -2/x^3 = -\\frac{2}{x^3}.
- Coefficient placement: (3/2)cos(x) = 3/2 · cos(x) = 1.5cos(x) = \\frac{3}{2}\\cos(x) = \\frac{3\\cos(x)}{2}.
- Order of commutative terms: a+b = b+a; a·b = b·a; sums/products can be reordered.
- Equivalent constants: 0.5 = 1/2 = \\frac{1}{2}; π ≈ 3.14159 (any exact symbolic form counts).
- Whitespace, capitalization of function names (SIN vs sin), and stray surrounding parentheses do not change the answer.
- Trigonometric / algebraic identities that produce the SAME simplified form (e.g. 2sin(x)cos(x) = sin(2x)).
ONLY mark the answer incorrect when the expressions evaluate to different mathematical values. If you are unsure whether two forms are equivalent, mentally substitute a sample value (e.g. x=1, x=2) into both — if they agree for every value in the domain, they are equivalent.

SCIENCE EQUIVALENCE (chemistry / physics / biology) — CRITICAL:
For science questions, judge by the SUBSTANTIVE scientific content, not by presentation metadata. Treat ALL of the following as equivalent to the reference:
- Chemical formulas: H2O = H₂O = H_2O = \\text{H}_2\\text{O}; NaCl = \\text{NaCl}; CO2 = CO₂ = CO_2; H2SO4 = H₂SO₄. Subscripts/superscripts may be written inline or formatted — both are correct.
- Ion notation: Na+ = Na^+ = \\text{Na}^+; Cl- = Cl^- = \\text{Cl}^-; SO4^2- = SO₄²⁻.
- Reaction arrows: →, ->, ⟶, =>, \\rightarrow, \\longrightarrow, and → are all equivalent for a forward reaction; ⇌, <=>, \\rightleftharpoons for equilibrium.
- State symbols (aq), (l), (s), (g) are OPTIONAL. A balanced equation without state symbols is still correct UNLESS the question explicitly asks for state symbols or physical states. Example: \`HCl + NaOH → NaCl + H2O\` is a CORRECT balanced neutralization equation even though it omits (aq)/(l). Missing state symbols may be mentioned as an improvement in the hint, but MUST NOT flip \`correct\` to false on their own.
- Balanced equations: judge by (a) same reactants and products, (b) same coefficients (or scalar multiples that still balance both sides). Do NOT require the reference's exact formatting.
- Ionic vs molecular vs net-ionic equations: accept whichever form matches what the question asks. If the question does not specify, accept any correct form that captures the reactants/products.
- Physical units: m/s = m·s⁻¹ = ms⁻¹ = meters per second; N·m = J (for work/energy); kg·m/s² = N; standard SI prefixes are interchangeable with their expansions (kJ = 1000 J, mL = cm³, μm = 10⁻⁶ m).
- Significant figures / decimal precision: accept the student's numerical answer if it rounds to the reference within the precision implied by the input data. Do NOT mark wrong for a trailing zero or one extra decimal place unless the question explicitly requires N significant figures.
- Vector / physics notation: \\vec{F} = **F** = F⃗ = F (with arrow overhead) = boldface F; |F| denotes magnitude; angle brackets ⟨a,b⟩ and column form are the same vector.
- Biology / naming: accept genus abbreviation once the full name has been given (Escherichia coli = E. coli); accept common names when the question uses common names, scientific names when it uses scientific names.

FINAL-ANSWER EXTRACTION — CRITICAL:
When the student's submission is a multi-line derivation, shows working, or contains scratchwork, judge correctness by the FINAL result the student arrives at — not by intermediate steps. If the last line / boxed answer / concluding expression matches the reference (under the equivalence rules above), set \`correct\` = true even if earlier lines contain crossed-out attempts, dimensional slips, or notation the student later fixed. Only mark incorrect when the final result itself is wrong or is missing entirely.

FINAL CORRECTNESS CHECK (MANDATORY):
Before deciding whether \`correct\` is true or false, ALWAYS normalize and simplify BOTH the reference answer and the student's answer.

Normalization MUST include:
- Remove unnecessary whitespace and parentheses.
- Treat implicit and explicit multiplication as identical.
- Reorder multiplication factors (commutative property).
- Move numerical coefficients to any position.
- Distribute or factor out unary negatives.
- Simplify algebraically before comparison.

The following expressions MUST be considered mathematically identical:

-5sin(5x)
-5*sin(5x)
-(5sin(5x))
-(5*sin(5x))
(-5)sin(5x)
(-5)*sin(5x)
-sin(5x)*5
(-sin(5x))*5
-(sin(5x))*5
5(-sin(5x))
5*(-sin(5x))
-1*5*sin(5x)
-(5*(sin(5x)))
-(sin(5x)*5)

Do NOT mark an answer incorrect solely because:
- the coefficient appears before or after the function,
- multiplication is implicit or explicit,
- extra parentheses are present,
- the negative sign is written in a different but equivalent location,
- factors appear in a different order.

If the student's expression simplifies to exactly the same mathematical expression as the reference answer, you MUST return:

{ "correct": true }

Only return \`"correct": false\` if the simplified mathematical expressions are genuinely different.`;

const CLASSWORK_ASK_MODE_DEFAULT = `PEDAGOGY MODE = ASK (odd-numbered attempt).
PRECONDITION — READ BEFORE ANYTHING ELSE: Apply this mode ONLY after you have judged the student's answer INCORRECT using the MATHEMATICAL EQUIVALENCE rules. If the student's answer is mathematically equivalent to the reference (even with different notation, spacing, parentheses, or LaTeX/plain-text form), SKIP this mode entirely — set correct=true, congratulate, and fill advancedChallenge as usual.
When the answer is genuinely incorrect, guide the student to recall the method themselves rather than stating it:
- hintStream: acknowledge what they did right, then ask 1-2 leading questions that point at the method (e.g. "Which operation undoes multiplication?", "What could you do to BOTH sides to isolate the variable?"). Encourage them to try again.
- part2: keep the 🛑/✅/🔨 structure, but phrase ✅ and 🔨 as QUESTIONS or nudges that make the student think — do not name the formula outright.
Stay warm and encouraging so they feel safe trying again.`;

const CLASSWORK_TELL_MODE_DEFAULT = `PEDAGOGY MODE = TELL (even-numbered attempt).
PRECONDITION — READ BEFORE ANYTHING ELSE: Apply this mode ONLY after you have judged the student's answer INCORRECT using the MATHEMATICAL EQUIVALENCE rules. If the student's answer is mathematically equivalent to the reference (even with different notation, spacing, parentheses, or LaTeX/plain-text form), SKIP this mode entirely — set correct=true, congratulate, and fill advancedChallenge as usual.
When the answer is genuinely incorrect, the student already had a turn to think, so now teach directly:
- part2: in ✅ state the correct formula/operation/rule plainly, and in 🔨 show step-by-step HOW to apply it to this problem. Be clear and instructive.
- hintStream: give the key explanation in plain language so it reads well live.
You may fully explain the method; still let the student carry out the final calculation themselves rather than only printing the final number.`;

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
