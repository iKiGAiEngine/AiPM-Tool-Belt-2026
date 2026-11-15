/**
 * Render PDF pages to PNG buffers using pdfjs-dist + node-canvas.
 *
 * This replaces the old OCR pipeline for scanned quotes: instead of
 * tesseract (which needed the missing `pdftoppm` binary in production),
 * rendered pages are sent directly to the vision model.
 */
import { createCanvas } from "canvas";

let _pdfjsLib: any = null;

async function getPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return _pdfjsLib;
}

export interface RenderedPage {
  pageNumber: number;
  png: Buffer;
}

const MAX_PAGES = 8;
// Scale 2 ≈ 144 DPI — plenty for the vision model while keeping payloads small.
const RENDER_SCALE = 2;

export async function renderPdfToImages(buffer: Buffer, maxPages = MAX_PAGES): Promise<RenderedPage[]> {
  const pdfjsLib = await getPdfjs();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  const limit = Math.min(doc.numPages, maxPages);
  const pages: RenderedPage[] = [];

  try {
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx as any, canvas: canvas as any, viewport }).promise;
      pages.push({ pageNumber: i, png: canvas.toBuffer("image/png") });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }

  return pages;
}
