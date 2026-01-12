import { readFile } from "fs/promises";
import mammoth from "mammoth";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

async function extractText(filePath) {
  const ext = filePath.split(".").pop().toLowerCase();

  if (ext === "pdf") {
    const buffer = new Uint8Array(await readFile(filePath));
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items.map((item) => item.str);
      fullText += strings.join(" ") + "\n";
    }

    return fullText;
  }

  if (ext === "docx") {
    const { value } = await mammoth.extractRawText({ path: filePath });
    return value;
  }

  throw new Error("Unsupported file type: " + ext);
}

function parseQA(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const qaPairs = [];

  let currentQ = null;
  for (let line of lines) {
    if (/^Q\d+:/.test(line)) {
      currentQ = line.replace(/^Q\d+:\s*/, "");
    } else if (/^A\d+:/.test(line) && currentQ) {
      const answer = line.replace(/^A\d+:\s*/, "");
      qaPairs.push({ question: currentQ, answer });
      currentQ = null;
    }
  }

  return qaPairs;
}

export { extractText, parseQA };
