// Standalone runner that exercises the classwork AI hint path against Gemini
// with the same 10 Grade-11/12 questions the client uses for QA.
//
// Two passes per question so we can see both cold latency and cache dynamics:
//   Pass 1 — cold Gemini call, stores in the in-process answer-hash cache
//            (same cache the live controller uses in classworkController.js).
//   Pass 2 — repeats the same (questionId, normalizedAnswer, ASK/TELL parity);
//            controller pattern says this must be a cache HIT and skip Gemini.
//
// Output tag per row: COLD = Gemini call, CACHE = local cache hit (no network).
//
// Free-tier Gemini caps at 5 requests/minute (and 20/day). SLEEP_MS applies
// only around COLD calls — CACHE hits are ~1ms and don't consume quota, so
// no sleep needed between them. Paid tier: SLEEP_MS=0 to run flat out.
//
// Run:   node --env-file=.env scripts/testClassworkHint.js
//        SLEEP_MS=0 node --env-file=.env scripts/testClassworkHint.js

import connectToDatabase from "../config/db.js";
import mongoose from "mongoose";
import { getClassworkAiFeedback } from "../utils/geminiClassworkFeedback.js";
import {
  fingerprintAnswer,
  buildCacheKey,
  getCachedFeedback,
  setCachedFeedback,
} from "../utils/classworkFeedbackCache.js";

const SLEEP_MS = Number.isFinite(Number(process.env.SLEEP_MS))
  ? Number(process.env.SLEEP_MS)
  : 13_000;

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const print = (...args) => originalLog(...args);
const silenceConsole = () => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
};
const restoreConsole = () => {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
};

const QUESTIONS = [
  {
    id: 1,
    subject: "IB Math AA HL — Calculus",
    question: "Find \\int x \\cdot e^x \\, dx.",
    correct: "e^x(x-1) + C",
    correctVariant: "e^x (x - 1) + C",
    wrong: "(1/2) x^2 e^x + C",
  },
  {
    id: 2,
    subject: "HKDSE M2 — Algebra & Calculus",
    question: "Find the derivative of f(x) = sin(4x) \\cdot ln(x) with respect to x.",
    correct: "4\\cos(4x)\\ln(x) + \\sin(4x)/x",
    correctVariant: "4 cos 4x ln x + sin 4x / x",
    wrong: "cos(4x)\\ln(x) + \\sin(4x)/x",
  },
  {
    id: 3,
    subject: "AP Calculus BC — Series",
    question:
      "State the Taylor series expansion for f(x) = 1/(1-x) centered at x=0 in summation notation, and state its interval of convergence.",
    correct: "\\sum_{n=0}^{\\infty} x^n for -1 < x < 1",
    correctVariant: "sum_{n=0}^infinity x^n, |x|<1",
    wrong: "\\sum_{n=0}^{\\infty} x^n for [-1, 1]",
  },
  {
    id: 4,
    subject: "AP Physics C / IB Physics HL — Mechanics",
    question:
      "A mass m attached to a spring with spring constant k undergoes Simple Harmonic Motion. Write the differential equation describing the displacement x(t) of the mass.",
    correct: "m x''(t) + k x(t) = 0",
    correctVariant: "m \\frac{d^2 x}{dt^2} + k x = 0",
    wrong: "d^2 x / dt^2 - (k/m) x = 0",
  },
  {
    id: 5,
    subject: "IB Chemistry — Thermodynamics",
    question:
      "Calculate the standard enthalpy change of combustion (\\Delta H_c^\\circ) for methane (CH_4), given \\Delta H_f^\\circ (CH_4(g)) = -74.8 kJ/mol, \\Delta H_f^\\circ (CO_2(g)) = -393.5 kJ/mol, \\Delta H_f^\\circ (H_2O(l)) = -285.8 kJ/mol.",
    correct: "-890.3 kJ/mol",
    correctVariant: "-890.3",
    wrong: "-604.5 kJ/mol",
  },
  {
    id: 6,
    subject: "A-Level Accounting — Financial Statements",
    question:
      "A business purchases a machine on January 1 for $50,000 with an estimated useful life of 4 years and a residual value of $5,000. Using the straight-line method, calculate the carrying amount (net book value) at the end of Year 2.",
    correct: "$27,500",
    correctVariant: "27500",
    wrong: "$25,000",
  },
  {
    id: 7,
    subject: "IB Biology HL — Genetics",
    question:
      "In genetics, what ratio of phenotypes is expected in the F_2 generation of a dihybrid cross between two individuals heterozygous for two unlinked, completely dominant traits?",
    correct: "9:3:3:1",
    correctVariant: "9 : 3 : 3 : 1",
    wrong: "3:1",
  },
  {
    id: 8,
    subject: "AP Macroeconomics / A-Level Economics",
    question:
      "If the Marginal Propensity to Consume (MPC) is 0.8, calculate the simple expenditures multiplier and the resulting maximum total change in Real GDP from a $100 million increase in autonomous government spending.",
    correct: "Multiplier = 5, GDP increase = $500 million",
    correctVariant: "k = 5; \\Delta GDP = 500 million",
    wrong: "Multiplier = 1.25, GDP increase = $125 million",
  },
  {
    id: 9,
    subject: "HKDSE / A-Level English Literature",
    question:
      'Identify the literary device used in the sentence: "The relentless waves roared and slapped against the ancient cliffs, refusing to let the island sleep." Briefly explain its impact.',
    correct:
      "Personification. The ocean waves are given human traits like roaring and slapping to create a sense of aggression and menacing presence.",
    correctVariant:
      "This is personification — the waves are described using human actions (roaring, slapping, refusing), which makes the sea feel alive and threatening.",
    wrong:
      "Simile. It uses descriptive adjectives to compare the water to a sleeping person.",
  },
  {
    id: 10,
    subject: "AP Computer Science A / A-Level CS",
    question:
      "What value is returned by the execution of the call mystery(4)?\n\npublic int mystery(int n) {\n  if (n <= 1) return 1;\n  return n * mystery(n - 1);\n}",
    correct: "24",
    correctVariant: "twenty-four",
    wrong: "10",
  },
];

const results = [];

// Mirror the controller pattern in classworkController.js:1899-1945.
// Returns { source: "COLD" | "CACHE", ms, correct, hintOk, error }.
const runOne = async (q, kind, answer, submissionNumber) => {
  const questionId = `test-q-${q.id}`;
  const answerHash = fingerprintAnswer({
    answer,
    format: "textbox",
    normalizedAnswerText: answer,
    isFollowUp: false,
  });
  const cacheKey = answerHash
    ? buildCacheKey({ questionId, answerHash, submissionNumber })
    : null;

  const started = Date.now();
  const cached = cacheKey ? getCachedFeedback(cacheKey) : null;
  if (cached) {
    const ms = Date.now() - started;
    const hintOk = Boolean((cached?.hintStream || "").trim());
    print(`Q${String(q.id).padStart(2)} ${kind.padEnd(7)} CACHE  ${String(ms).padStart(6)}ms  correct=${cached?.correct}  hint=${hintOk ? "ok" : "empty"}`);
    results.push({ q: q.id, kind, source: "CACHE", ms, correct: cached?.correct, hintOk });
    return "CACHE";
  }

  silenceConsole();
  let ms, correct, hintOk, error, result;
  try {
    result = await getClassworkAiFeedback({
      questionText: q.question,
      answer,
      correctAnswer: q.correct,
      format: "textbox",
      studentName: "Aarav",
      submissionNumber,
    });
    ms = Date.now() - started;
    correct = result?.correct;
    hintOk = Boolean((result?.hintStream || "").trim());
    if (cacheKey) setCachedFeedback(cacheKey, result);
  } catch (err) {
    ms = Date.now() - started;
    error = (err?.message || String(err)).slice(0, 120);
  } finally {
    restoreConsole();
  }

  if (error) {
    print(`Q${String(q.id).padStart(2)} ${kind.padEnd(7)} COLD   ${String(ms).padStart(6)}ms  ERROR ${error}`);
  } else {
    print(`Q${String(q.id).padStart(2)} ${kind.padEnd(7)} COLD   ${String(ms).padStart(6)}ms  correct=${correct}  hint=${hintOk ? "ok" : "empty"}`);
  }
  results.push({ q: q.id, kind, source: "COLD", ms, correct, hintOk, error });
  return "COLD";
};

const runPass = async (passLabel) => {
  print(`\n──── ${passLabel} ────`);
  let firstColdOfPass = true;
  for (const q of QUESTIONS) {
    for (const [kind, answer] of [
      ["CORRECT", q.correctVariant],
      ["WRONG", q.wrong],
    ]) {
      // Sleep only BEFORE a cold call, and skip the sleep before the very
      // first cold call so the whole pass doesn't start with a wasted wait.
      const isCached = (() => {
        const hash = fingerprintAnswer({
          answer,
          format: "textbox",
          normalizedAnswerText: answer,
          isFollowUp: false,
        });
        const key = hash ? buildCacheKey({ questionId: `test-q-${q.id}`, answerHash: hash, submissionNumber: 1 }) : null;
        return key && getCachedFeedback(key);
      })();

      if (!isCached && !firstColdOfPass) await sleep(SLEEP_MS);
      const source = await runOne(q, kind, answer, 1);
      if (source === "COLD") firstColdOfPass = false;
    }
  }
};

const run = async () => {
  silenceConsole();
  await connectToDatabase();
  restoreConsole();
  print(`SLEEP_MS=${SLEEP_MS} (applied only before COLD calls).`);

  await runPass("PASS 1 (cold — expect COLD on all rows)");
  await runPass("PASS 2 (warm — expect CACHE on all rows)");

  const cold = results.filter((r) => r.source === "COLD" && !r.error);
  const cache = results.filter((r) => r.source === "CACHE");
  const errored = results.filter((r) => r.error);
  const stats = (arr) => arr.length
    ? {
        avg: Math.round(arr.reduce((s, r) => s + r.ms, 0) / arr.length),
        min: Math.min(...arr.map((r) => r.ms)),
        max: Math.max(...arr.map((r) => r.ms)),
      }
    : { avg: 0, min: 0, max: 0 };
  const cs = stats(cold);
  const hs = stats(cache);
  print(`\nCOLD  n=${cold.length}   avg=${cs.avg}ms  min=${cs.min}ms  max=${cs.max}ms`);
  print(`CACHE n=${cache.length}   avg=${hs.avg}ms  min=${hs.min}ms  max=${hs.max}ms`);
  if (errored.length) print(`ERROR n=${errored.length}   (see rows above)`);
  const hitRate = results.length ? Math.round((cache.length / results.length) * 100) : 0;
  print(`Hit rate: ${cache.length}/${results.length} (${hitRate}%)`);

  silenceConsole();
  await mongoose.disconnect();
  restoreConsole();
};

run().catch((err) => {
  restoreConsole();
  console.error(err);
  process.exit(1);
});
