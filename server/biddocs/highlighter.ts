import fs from "fs";
import path from "path";
import { rgb, type PDFPage } from "pdf-lib";
import type { MatchBox } from "@shared/schema";

/**
 * Positioned word on a plan page, in PDF points with origin at the
 * bottom-left corner (pdf-lib's coordinate space). Captured once during
 * page processing and persisted as a sidecar JSON per page so highlight
 * boxes can be computed later (callout pass, finalize) without re-running
 * OCR or re-parsing the PDF text layer.
 */
export interface PositionedWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert pdfjs getTextContent() items into positioned words.
 * pdfjs transforms are already in PDF user space (origin bottom-left),
 * so items map straight through; multi-word items are split with widths
 * apportioned by character count — approximate, but plenty for a
 * highlight rectangle.
 */
export function wordsFromPdfjsTextContent(textContent: { items: any[] }): PositionedWord[] {
  const words: PositionedWord[] = [];
  for (const item of textContent.items) {
    const str: string = item.str ?? "";
    if (!str.trim()) continue;
    const tx = item.transform;
    if (!tx || tx.length < 6) continue;
    const x = tx[4];
    const y = tx[5];
    const width: number = item.width ?? 0;
    const height: number = item.height ?? Math.abs(tx[3]) ?? 10;

    const parts = str.split(/(\s+)/);
    const totalChars = str.length || 1;
    let cursor = 0;
    for (const part of parts) {
      if (part.trim()) {
        words.push({
          text: part,
          x: x + (cursor / totalChars) * width,
          y,
          w: (part.length / totalChars) * width,
          h: height,
        });
      }
      cursor += part.length;
    }
  }
  return words;
}

/**
 * Convert tesseract.js word results (image pixel space, origin top-left)
 * into PDF points. `scale` is the render scale used when rasterizing the
 * page (image px = PDF pt × scale); `pageHeightPts` flips the y axis.
 * Accepts both the v5+ blocks tree and the legacy flat words array.
 */
export function wordsFromTesseract(
  data: any,
  scale: number,
  pageHeightPts: number,
): PositionedWord[] {
  const rawWords: Array<{ text: string; bbox: { x0: number; y0: number; x1: number; y1: number } }> = [];

  if (Array.isArray(data?.words) && data.words.length > 0) {
    rawWords.push(...data.words);
  } else if (Array.isArray(data?.blocks)) {
    for (const block of data.blocks) {
      for (const para of block?.paragraphs ?? []) {
        for (const line of para?.lines ?? []) {
          for (const word of line?.words ?? []) {
            if (word?.text && word?.bbox) rawWords.push(word);
          }
        }
      }
    }
  }

  const words: PositionedWord[] = [];
  for (const w of rawWords) {
    if (!w.text?.trim() || !w.bbox) continue;
    const x = w.bbox.x0 / scale;
    const yTop = w.bbox.y0 / scale;
    const wPts = (w.bbox.x1 - w.bbox.x0) / scale;
    const hPts = (w.bbox.y1 - w.bbox.y0) / scale;
    words.push({
      text: w.text,
      x,
      y: pageHeightPts - yTop - hPts,
      w: wPts,
      h: hPts,
    });
  }
  return words;
}

function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Locate every occurrence of each term in the page's word sequence and
 * return highlight boxes. Multi-word terms match consecutive words;
 * single-word terms also match when embedded in a longer word (e.g. the
 * keyword "locker" inside "LOCKERS"). Callout marks like "WP-1" match a
 * single token ("WP-1") or an adjacent pair ("WP" "1").
 */
export function findMatchBoxes(
  words: PositionedWord[],
  terms: Array<{ term: string; scope: string }>,
): MatchBox[] {
  const boxes: MatchBox[] = [];
  const normWords = words.map(w => normalizeToken(w.text));

  for (const { term, scope } of terms) {
    const termTokens = term
      .split(/[\s-]+/)
      .map(normalizeToken)
      .filter(Boolean);
    if (termTokens.length === 0) continue;

    for (let i = 0; i < words.length; i++) {
      if (!normWords[i]) continue;

      if (termTokens.length === 1) {
        if (normWords[i] === termTokens[0] || (termTokens[0].length >= 4 && normWords[i].includes(termTokens[0]))) {
          boxes.push({ keyword: term, scope, x: words[i].x, y: words[i].y, w: words[i].w, h: words[i].h });
        }
        continue;
      }

      // Multi-token: consecutive word match, or the whole term collapsed
      // into one token (OCR often merges "WP-1" into a single word).
      const joined = termTokens.join("");
      if (normWords[i] === joined) {
        boxes.push({ keyword: term, scope, x: words[i].x, y: words[i].y, w: words[i].w, h: words[i].h });
        continue;
      }
      let matched = true;
      for (let j = 0; j < termTokens.length; j++) {
        if (i + j >= words.length || normWords[i + j] !== termTokens[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const first = words[i];
        const last = words[i + termTokens.length - 1];
        const x0 = Math.min(first.x, last.x);
        const y0 = Math.min(first.y, last.y);
        const x1 = Math.max(first.x + first.w, last.x + last.w);
        const y1 = Math.max(first.y + first.h, last.y + last.h);
        boxes.push({ keyword: term, scope, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
  }

  // Dedupe overlapping boxes for the same term (single-word + embedded hits)
  const seen = new Set<string>();
  return boxes.filter(b => {
    const key = `${b.keyword}|${Math.round(b.x)}|${Math.round(b.y)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Draw semi-transparent highlight rectangles onto a pdf-lib page. */
export function applyHighlights(page: PDFPage, boxes: MatchBox[]): void {
  const PAD = 2;
  for (const box of boxes) {
    if (box.w <= 0 || box.h <= 0) continue;
    page.drawRectangle({
      x: box.x - PAD,
      y: box.y - PAD,
      width: box.w + PAD * 2,
      height: box.h + PAD * 2,
      color: rgb(1, 0.9, 0.1),
      opacity: 0.35,
    });
  }
}

// ---------------------------------------------------------------------------
// Sidecar persistence: positioned words per page, stored in the plan parser
// job directory (data/planparser_jobs/<jobId>/words/) so they share the job's
// lifecycle and cleanup.
// ---------------------------------------------------------------------------

function sidecarPath(jobDir: string, filename: string, pageNumber: number): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(jobDir, "words", `${safe}_page_${pageNumber}.json`);
}

export function savePositionedWords(
  jobDir: string,
  filename: string,
  pageNumber: number,
  words: PositionedWord[],
): void {
  try {
    const dir = path.join(jobDir, "words");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sidecarPath(jobDir, filename, pageNumber), JSON.stringify(words));
  } catch (err) {
    console.error(`[Highlighter] Failed to save word sidecar for ${filename} p${pageNumber}:`, err);
  }
}

export function loadPositionedWords(
  jobDir: string,
  filename: string,
  pageNumber: number,
): PositionedWord[] {
  try {
    const p = sidecarPath(jobDir, filename, pageNumber);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PositionedWord[];
  } catch {
    return [];
  }
}
