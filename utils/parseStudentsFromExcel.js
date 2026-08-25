// utils/parseStudentsFromExcel.js
// Mirrors parseTeachersFromExcel: dynamically finds the header row (must
// contain firstName + email), then maps recognised columns onto a student
// object. Optional columns are passed through when present:
//   - parentEmail / teacherEmail  → resolved to ObjectIds by the controller
//   - date_of_birth (or dob)      → normalised to YYYY-MM-DD; required per
//                                    createStudent's server-side validation
//   - age, city, country, language, phone, gender
import XLSX from "xlsx";

// Excel serial dates are days since 1899-12-30 (Lotus/Excel epoch quirk).
// Handle both string dates and Excel numeric serials so teachers can paste
// dates as text OR let Excel autoformat them.
function normalizeDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const ms = excelEpoch + value * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return "";
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s; // hand back raw string; controller will surface a validation error
}

export function parseStudentsFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  if (!aoa.length) return [];

  const isHeaderRow = (row) => {
    const normalized = row.map((cell) => String(cell).trim().toLowerCase());
    return normalized.includes("firstname") && normalized.includes("email");
  };

  let headerRowIndex = aoa.findIndex(isHeaderRow);
  if (headerRowIndex === -1) {
    headerRowIndex = aoa.findIndex((row) =>
      row.some((cell) => String(cell).trim() !== "")
    );
  }
  if (headerRowIndex === -1) return [];

  const headerRow = aoa[headerRowIndex].map((h) => String(h).trim());
  const dataRows = aoa.slice(headerRowIndex + 1);

  const rows = dataRows
    .map((row) => {
      const obj = {};
      headerRow.forEach((key, idx) => {
        if (!key) return;
        obj[key] = row[idx];
      });
      const hasData = Object.values(obj).some((v) => String(v).trim() !== "");
      return hasData ? obj : null;
    })
    .filter(Boolean);

  // Case-insensitive column lookup so teachers don't have to match exact
  // capitalisation ("First Name" vs "firstName" vs "FIRSTNAME").
  const pick = (row, ...aliases) => {
    for (const alias of aliases) {
      const wanted = alias.toLowerCase();
      for (const key of Object.keys(row)) {
        if (key.toLowerCase().replace(/\s+/g, "") === wanted) return row[key];
      }
    }
    return "";
  };

  return rows
    .map((row) => {
      const firstName = pick(row, "firstName", "firstname");
      const lastName = pick(row, "lastName", "lastname");
      const email = pick(row, "email");
      if (!firstName || !email) return null;

      const dobRaw = pick(row, "date_of_birth", "dateofbirth", "dob");
      return {
        firstName: String(firstName).trim(),
        lastName: lastName ? String(lastName).trim() : "",
        email: String(email).trim(),
        phone: String(pick(row, "phone") || "").trim(),
        gender: String(pick(row, "gender") || "").trim(),
        date_of_birth: normalizeDate(dobRaw),
        age: (() => {
          const raw = pick(row, "age");
          const n = Number(raw);
          return Number.isFinite(n) && n > 0 ? n : undefined;
        })(),
        city: String(pick(row, "city") || "").trim(),
        country: String(pick(row, "country") || "").trim(),
        language: String(pick(row, "language") || "").trim(),
        parentEmail: String(pick(row, "parentEmail", "parentemail") || "")
          .trim()
          .toLowerCase(),
        teacherEmail: String(pick(row, "teacherEmail", "teacheremail") || "")
          .trim()
          .toLowerCase(),
      };
    })
    .filter(Boolean);
}
