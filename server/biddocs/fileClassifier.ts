// See the comment in server/planparser/pdfProcessor.ts — the bare
// "pdfjs-dist" specifier resolves to the browser build (requires DOMMatrix,
// not defined in Node). Must use the legacy build here too.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "path";
import type { BidDocsFileClass } from "@shared/schema";

const STANDARD_FONT_DATA_URL = path.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/");

export interface FileClassification {
  classification: BidDocsFileClass;
  confidence: number; // 0-100
  reason: string;
  pageCount: number;
  sheetNumbersSample: string[];
}

// --- Filename signals -------------------------------------------------------

const PLAN_NAME_PATTERNS: Array<{ re: RegExp; label: string; score: number }> = [
  { re: /\bA[-.]?\d{1,3}(\.\d{1,2})?\b/i, label: "architectural sheet number", score: 30 },
  { re: /\b(arch|architectural)\b/i, label: "'architectural'", score: 30 },
  { re: /\bfloor\s*plans?\b/i, label: "'floor plan'", score: 30 },
  { re: /\b(drawings?|dwgs?)\b/i, label: "'drawings'", score: 25 },
  { re: /\bplans?\b/i, label: "'plans'", score: 20 },
  { re: /\b(plan\s*set|full\s*set|drawing\s*set|bid\s*set|permit\s*set)\b/i, label: "'set'", score: 25 },
  { re: /\bissued?\s*for\b/i, label: "'issued for'", score: 15 },
  { re: /\bIFC\b/, label: "'IFC'", score: 15 },
];

const SPEC_NAME_PATTERNS: Array<{ re: RegExp; label: string; score: number }> = [
  { re: /\bspec(ification)?s?\b/i, label: "'specifications'", score: 35 },
  { re: /\bproject\s*manual\b/i, label: "'project manual'", score: 40 },
  { re: /\b(10|09|11|12)\s?\d{2}\s?\d{2}\b/, label: "CSI section number", score: 30 },
  { re: /\bdiv(ision)?\s*\d{1,2}\b/i, label: "'division'", score: 25 },
  { re: /\bmasterformat\b/i, label: "'masterformat'", score: 20 },
];

const OTHER_NAME_PATTERNS: Array<{ re: RegExp; label: string; score: number }> = [
  { re: /\bgeotech(nical)?\b/i, label: "'geotechnical'", score: 40 },
  { re: /\b(bid\s*form|proposal\s*form|instructions\s*to\s*bidders)\b/i, label: "bid form", score: 35 },
  { re: /\b(report|survey|soils)\b/i, label: "report/survey", score: 20 },
  { re: /\baddend(um|a)\b/i, label: "'addendum'", score: 15 },
];

// --- Content signals --------------------------------------------------------

const PLAN_CONTENT_PATTERNS: Array<{ re: RegExp; label: string; score: number }> = [
  { re: /\b(sheet|drawing)\s*index\b/i, label: "sheet index", score: 35 },
  { re: /\bscale\s*[:=]?\s*\d+\/\d+"?\s*=\s*\d+'/i, label: "drawing scale notation", score: 30 },
  { re: /\bgeneral\s*notes\b/i, label: "general notes", score: 15 },
  { re: /\b(floor|roof|site|ceiling)\s*plan\b/i, label: "plan title", score: 25 },
  { re: /\bA[-.]?\d{3}\b/, label: "A-series sheet refs", score: 20 },
];

const SPEC_CONTENT_PATTERNS: Array<{ re: RegExp; label: string; score: number }> = [
  { re: /\bSECTION\s+\d{2}\s?\d{2}\s?\d{2}\b/i, label: "SECTION header", score: 40 },
  { re: /\bPART\s+1\s*[-–—]?\s*GENERAL\b/i, label: "PART 1 - GENERAL", score: 40 },
  { re: /\btable\s+of\s+contents\b/i, label: "table of contents", score: 15 },
  { re: /\bsubmittals?\b/i, label: "'submittals'", score: 10 },
  { re: /\bdivision\s+\d{1,2}\b/i, label: "division listing", score: 15 },
];

const SHEET_NUMBER_RE = /\b([A-Z]{1,2}[-.]?\d{1,3}(?:\.\d{1,2})?)\b/g;

function scorePatterns(
  text: string,
  patterns: Array<{ re: RegExp; label: string; score: number }>,
): { score: number; labels: string[] } {
  let score = 0;
  const labels: string[] = [];
  for (const p of patterns) {
    if (p.re.test(text)) {
      score += p.score;
      labels.push(p.label);
    }
  }
  return { score, labels };
}

/**
 * Classify a PDF from the BC file set as plan / spec / other using filename
 * signals + a text sniff of the first few pages + page geometry. Fast — no
 * OCR, no full parse.
 */
export async function classifyBidDocFile(
  filename: string,
  buffer: Buffer,
): Promise<FileClassification> {
  if (!/\.pdf$/i.test(filename)) {
    return {
      classification: "other",
      confidence: 90,
      reason: "Not a PDF",
      pageCount: 0,
      sheetNumbersSample: [],
    };
  }

  const nameOnly = path.basename(filename);
  const planName = scorePatterns(nameOnly, PLAN_NAME_PATTERNS);
  const specName = scorePatterns(nameOnly, SPEC_NAME_PATTERNS);
  const otherName = scorePatterns(nameOnly, OTHER_NAME_PATTERNS);

  let pageCount = 0;
  let planContent = { score: 0, labels: [] as string[] };
  let specContent = { score: 0, labels: [] as string[] };
  let isLandscapeLarge = false;
  let isPortraitLetter = false;
  const sheetNumbers = new Set<string>();

  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: true,
    }).promise;
    pageCount = doc.numPages;

    const sniffPages = Math.min(3, doc.numPages);
    let sniffText = "";
    for (let i = 1; i <= sniffPages; i++) {
      try {
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1.0 });
        // Large-format landscape (≥ ARCH C, 18x24in = 1296pt wide) → drawing set
        if (viewport.width > viewport.height && viewport.width >= 1200) isLandscapeLarge = true;
        // Letter/A4 portrait → spec book / report
        if (viewport.height > viewport.width && viewport.width <= 650) isPortraitLetter = true;

        const textContent = await page.getTextContent();
        sniffText += " " + textContent.items.map((it: any) => it.str).join(" ");
      } catch {
        // image-only page — geometry still counted
      }
    }

    planContent = scorePatterns(sniffText, PLAN_CONTENT_PATTERNS);
    specContent = scorePatterns(sniffText, SPEC_CONTENT_PATTERNS);

    let m: RegExpExecArray | null;
    const re = new RegExp(SHEET_NUMBER_RE.source, "g");
    while ((m = re.exec(sniffText)) !== null && sheetNumbers.size < 12) {
      sheetNumbers.add(m[1]);
    }

    doc.destroy();
  } catch (err) {
    console.warn(`[BidDocs] Could not sniff PDF content for ${filename}:`, err instanceof Error ? err.message : err);
  }

  let planScore = planName.score + planContent.score + (isLandscapeLarge ? 30 : 0);
  let specScore = specName.score + specContent.score + (isPortraitLetter ? 15 : 0);
  const otherScore = otherName.score;

  // Portrait letter-size strongly argues against a drawing set
  if (isPortraitLetter && !isLandscapeLarge) planScore = Math.max(0, planScore - 20);
  if (isLandscapeLarge) specScore = Math.max(0, specScore - 20);

  const reasons: string[] = [];
  const nameLabels = [...planName.labels, ...specName.labels, ...otherName.labels];
  if (nameLabels.length > 0) reasons.push(`filename: ${nameLabels.join(", ")}`);
  const contentLabels = [...planContent.labels, ...specContent.labels];
  if (contentLabels.length > 0) reasons.push(`content: ${contentLabels.join(", ")}`);
  if (isLandscapeLarge) reasons.push("large-format landscape pages");
  if (isPortraitLetter) reasons.push("letter-size portrait pages");

  let classification: BidDocsFileClass;
  let winning: number;
  if (otherScore > planScore && otherScore > specScore) {
    classification = "other";
    winning = otherScore;
  } else if (specScore > planScore) {
    classification = "spec";
    winning = specScore;
  } else if (planScore > 0) {
    classification = "plan";
    winning = planScore;
  } else {
    classification = "other";
    winning = 10;
    reasons.push("no plan/spec signals found");
  }

  const runnerUp = Math.max(
    classification === "plan" ? Math.max(specScore, otherScore) : planScore,
    classification === "spec" ? otherScore : 0,
  );
  const confidence = Math.min(95, Math.max(20, Math.round(winning - runnerUp / 2 + 25)));

  return {
    classification,
    confidence,
    reason: reasons.join(" · ") || "no signals",
    pageCount,
    sheetNumbersSample: Array.from(sheetNumbers),
  };
}
