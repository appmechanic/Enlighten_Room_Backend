// utils/parseTeachersFromExcel.js
import XLSX from "xlsx";

export function parseTeachersFromExcel(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // AOA = Array of Arrays
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1, // row arrays
    defval: "", // empty cells become ""
    blankrows: false,
  });

  if (!aoa.length) return [];

  // ---- 1) Find header row dynamically ----
  const isHeaderRow = (row) => {
    const normalized = row.map((cell) => String(cell).trim().toLowerCase());
    const hasFirstName = normalized.includes("firstname");
    const hasEmail = normalized.includes("email");
    return hasFirstName && hasEmail;
  };

  // Try to find row that looks like header (contains firstName + email)
  let headerRowIndex = aoa.findIndex(isHeaderRow);

  // Fallback: first non-empty row
  if (headerRowIndex === -1) {
    headerRowIndex = aoa.findIndex((row) =>
      row.some((cell) => String(cell).trim() !== "")
    );
  }

  // If still not found → no usable data
  if (headerRowIndex === -1) return [];

  const headerRow = aoa[headerRowIndex].map((h) => String(h).trim());
  const dataRows = aoa.slice(headerRowIndex + 1);

  // ---- 2) Convert to row objects using dynamic headers ----
  const rows = dataRows
    .map((row) => {
      const obj = {};
      headerRow.forEach((key, idx) => {
        if (!key) return;
        obj[key] = row[idx];
      });
      // skip completely empty rows
      const hasData = Object.values(obj).some((v) => String(v).trim() !== "");
      return hasData ? obj : null;
    })
    .filter(Boolean);

  // ---- 3) Map to teacher object (based on your column names) ----
  const teachers = rows
    .map((row) => {
      const firstName = row["firstName"];
      const lastName = row["lastName"];
      const email = row["email"];
      const phone = row["phone"];
      //   const password = row["password"];
      const organization = row["organization"];
      const gender = row["gender"];

      // minimum required
      if (!email || !firstName) return null;

      return {
        firstName: String(firstName).trim(),
        lastName: lastName ? String(lastName).trim() : "",
        email: String(email).trim(),
        phone: phone ? String(phone).trim() : "",
        // password: password ? String(password).trim() : "",
        organization: organization ? String(organization).trim() : "",
        gender: gender ? String(gender).trim() : "",
        userName: `${String(firstName).trim()}.${String(
          lastName
        ).trim()}`.toLowerCase(),
      };
    })
    .filter(Boolean);

  return teachers;
}
