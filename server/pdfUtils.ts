/**
 * Shared PDF text extraction using pdfjs-dist (the real underlying engine).
 *
 * Text items are reassembled into real lines using their page coordinates
 * (grouped by y, sorted by x) so tabular quotes keep their row/column
 * structure instead of collapsing into one run-on string per page.
 */

let _pdfjsLib: any = null;

async function getPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return _pdfjsLib;
}

export interface PdfResult {
  text: string;
  numpages: number;
}

export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
}

/**
 * Group positioned text items into visual lines. Items whose baselines fall
 * within `yTolerance` of each other are treated as one line; within a line,
 * items are ordered left-to-right and a wide horizontal gap becomes a
 * multi-space column separator.
 */
export function groupTextItemsIntoLines(
  items: PositionedTextItem[],
  yTolerance = 2.5,
  columnGap = 8
): string[] {
  if (items.length === 0) return [];

  // Bucket items into lines by y position (PDF y-axis points up).
  const lines: { y: number; items: PositionedTextItem[] }[] = [];
  for (const item of items) {
    if (!item.str) continue;
    const line = lines.find((l) => Math.abs(l.y - item.y) <= yTolerance);
    if (line) {
      line.items.push(item);
      // Drift the line anchor toward the running average so slightly sloped
      // baselines (common in OCR'd or rotated pages) still group together.
      line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  lines.sort((a, b) => b.y - a.y);

  return lines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd: number | null = null;
    for (const item of line.items) {
      if (prevEnd !== null) {
        const gap = item.x - prevEnd;
        text += gap > columnGap ? "   " : gap > 0.5 ? " " : "";
      }
      text += item.str;
      prevEnd = item.x + (item.width || 0);
    }
    return text;
  });
}

export async function extractPdfText(buffer: Buffer, maxPages = 800): Promise<PdfResult> {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  const numpages: number = doc.numPages;
  const limit = Math.min(numpages, maxPages);
  const pageParts: string[] = [];

  for (let i = 1; i <= limit; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const positioned: PositionedTextItem[] = (content.items as any[])
      .filter((item) => item.str)
      .map((item) => ({
        str: item.str as string,
        x: item.transform?.[4] ?? 0,
        y: item.transform?.[5] ?? 0,
        width: item.width ?? 0,
      }));
    pageParts.push(groupTextItemsIntoLines(positioned).join("\n"));
    page.cleanup();
  }

  await doc.destroy();
  return { text: pageParts.join("\n"), numpages };
}
