// Feature strings on Plan.features are the human-readable source of truth
// for what a plan allows. This parser turns them into the numeric
// Plan.limits object so enforcement middleware and admin dashboards read
// the same numbers the admin typed in the Features editor.
//
// Rule structure:
//   { key, label, unitConversion(value, unit) -> Number }
// where `label` regex matches the part before ":" (case-insensitive,
// whitespace-tolerant) and `unitConversion` receives the parsed numeric
// value and the trailing unit word (may be "").
//
// Anything the parser can't recognise is returned in `unmatched` so the
// admin UI can show a warning list — silent skips are worse than loud ones.

const RULES = [
  {
    key: "maxTeachers",
    label: /^teachers$/i,
    convert: (n) => n,
  },
  {
    key: "maxStudents",
    label: /^students$/i,
    convert: (n) => n,
  },
  {
    key: "maxStudentsPerClass",
    label: /^max\s+students\s+per\s+class$/i,
    convert: (n) => n,
  },
  {
    key: "maxClassrooms",
    label: /^classrooms$/i,
    convert: (n) => n,
  },
  {
    key: "maxSessionsPerMonth",
    label: /^sessions\s*(?:\/|per)\s*month$/i,
    convert: (n) => n,
  },
  {
    key: "maxSessionMinutesPerMonth",
    label: /^time\s*limit\s*(?:\/|per)\s*month$/i,
    convert: (n, unit) => {
      const u = (unit || "").toLowerCase();
      if (u.startsWith("hour") || u === "h" || u === "hr" || u === "hrs") {
        return Math.round(n * 60);
      }
      if (u.startsWith("min") || u === "m") return Math.round(n);
      // Bare number defaults to minutes — safest interpretation for a
      // marketing string like "Time Limit / Month: 100" (no unit).
      return Math.round(n);
    },
  },
  {
    key: "maxScreenLockSessionsPerMonth",
    label: /^screen\s*lock\s*sessions$/i,
    convert: (n) => n,
  },
  {
    key: "maxLessonReportsPerMonth",
    // "Lesson Reports Sent" — the trailing "Sent" word is optional so
    // "Lesson Reports" alone still matches.
    label: /^lesson\s+reports(?:\s+sent)?$/i,
    convert: (n) => n,
  },
  {
    key: "maxAiCallsPerMonth",
    // "AI Feedback / Tests / Reports" — matches any combination of those
    // three tokens separated by "/", plus a bare "AI Calls" fallback.
    label: /^(?:ai\s*calls|ai(?:\s*(?:feedback|tests?|reports?))+(?:\s*\/\s*(?:feedback|tests?|reports?))*)$/i,
    convert: (n) => n,
  },
  {
    key: "maxStorageBytes",
    // "Storage (Materials & Reports)" or plain "Storage".
    label: /^storage(?:\s*\(.*\))?$/i,
    convert: (n, unit) => {
      const u = (unit || "").toLowerCase();
      if (u === "gb" || u.startsWith("gigabyte")) {
        return Math.round(n * 1024 * 1024 * 1024);
      }
      if (u === "mb" || u.startsWith("megabyte")) {
        return Math.round(n * 1024 * 1024);
      }
      if (u === "kb" || u.startsWith("kilobyte")) {
        return Math.round(n * 1024);
      }
      // Bare number = bytes (matches the on-disk unit).
      return Math.round(n);
    },
  },
];

// Extracts the leading number (possibly with commas or a decimal point) and
// the trailing unit word from a value string like "3.5 GB" or "9,000 times".
const VALUE_RX = /^\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z][A-Za-z\d]*)?/;

function parseValue(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(VALUE_RX);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return { n, unit: m[2] || "" };
}

// Parses one feature line. Returns { key, value } on success, null if the
// line is unparseable (no colon, unknown label, unparseable number).
export function parseFeatureLine(line) {
  const idx = String(line || "").indexOf(":");
  if (idx < 0) return null;
  const label = line.slice(0, idx).trim();
  const rest = line.slice(idx + 1);
  const val = parseValue(rest);
  if (!val) return null;
  for (const rule of RULES) {
    if (rule.label.test(label)) {
      const converted = rule.convert(val.n, val.unit);
      if (!Number.isFinite(converted)) return null;
      return { key: rule.key, value: converted };
    }
  }
  return null;
}

// Parses an array of feature strings. Returns:
//   { limits: {maxTeachers: 10, ...}, unmatched: ["Priority support", ...] }
// `limits` only contains keys the parser could derive — callers must merge
// with existing Plan.limits themselves if they want to preserve manually-set
// values (this parser assumes features are the source of truth).
export function parsePlanFeatures(features) {
  const limits = {};
  const unmatched = [];
  for (const f of Array.isArray(features) ? features : []) {
    const s = String(f || "").trim();
    if (!s) continue;
    const parsed = parseFeatureLine(s);
    if (parsed) {
      limits[parsed.key] = parsed.value;
    } else {
      unmatched.push(s);
    }
  }
  return { limits, unmatched };
}
