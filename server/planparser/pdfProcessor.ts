import { createWorker, Worker } from "tesseract.js";
// The bare "pdfjs-dist" specifier resolves to the browser build, which
// assumes Web APIs like DOMMatrix exist globally — they don't in Node, and
// the crash only surfaces on PDFs whose content streams actually exercise
// that code path (pattern fills, gradients, complex vector transforms —
// common in dense CAD-exported architectural sheets), so small test PDFs
// can silently appear to work while real plan sets fail every time. The
// legacy build ships its own Node-compatible fallbacks. Matches the import
// specExtractorEngine.ts already uses correctly.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "canvas";
import fs from "fs";
import path from "path";
import { planParserStorage } from "./storage";
import { classifyPage } from "./classifier";
import { getClassificationConfigFromDB } from "./classificationConfig";
import type { PlanParserJob, ParsedPage, PlanParserScope } from "@shared/schema";
import { PLAN_PARSER_SCOPES } from "@shared/schema";
import {
  wordsFromPdfjsTextContent,
  wordsFromTesseract,
  findMatchBoxes,
  savePositionedWords,
  loadPositionedWords,
  type PositionedWord,
} from "../biddocs/highlighter";

// Deliberately NOT setting GlobalWorkerOptions.workerSrc: the legacy build
// auto-detects a Node environment and uses its own synchronous fake-worker
// fallback. Setting workerSrc to an empty string (as this used to) disables
// that detection and makes every getDocument() call throw "Setting up fake
// worker failed: No GlobalWorkerOptions.workerSrc specified."

const STANDARD_FONT_DATA_URL = path.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/");

interface ProcessingOptions {
  onProgress?: (processed: number, total: number, message: string) => void;
}

let tesseractWorker: Worker | null = null;

async function getOcrWorker(): Promise<Worker> {
  if (!tesseractWorker) {
    tesseractWorker = await createWorker("eng");
  }
  return tesseractWorker;
}

async function renderPageToImage(
  page: pdfjs.PDFPageProxy,
  scale: number = 2.0
): Promise<Buffer> {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext("2d");
  
  const renderContext = {
    canvasContext: context as any,
    viewport,
    canvas: canvas as any,
  };
  
  await page.render(renderContext).promise;
  
  return canvas.toBuffer("image/png");
}

async function extractTextFromPdf(page: pdfjs.PDFPageProxy): Promise<string> {
  try {
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: any) => item.str)
      .join(" ");
    return text;
  } catch (error) {
    return "";
  }
}

async function extractTextAndWordsFromPdf(
  page: pdfjs.PDFPageProxy,
): Promise<{ text: string; words: PositionedWord[] }> {
  try {
    const textContent = await page.getTextContent();
    // CAD/Revit-exported PDFs often emit each word (or word fragment) as a
    // separate positioned text-showing operation; joining every item with a
    // forced single space produces doubled/irregular spacing. Collapsing
    // whitespace runs doesn't fix items that are missing a space entirely
    // (classifier.ts's fuzzy fallback handles that), but it keeps the
    // common case clean.
    const text = textContent.items.map((item: any) => item.str).join(" ").replace(/\s+/g, " ");
    return { text, words: wordsFromPdfjsTextContent(textContent) };
  } catch (error) {
    return { text: "", words: [] };
  }
}

async function performOcr(imageBuffer: Buffer): Promise<string> {
  const worker = await getOcrWorker();
  const result = await worker.recognize(imageBuffer);
  return result.data.text;
}

async function performOcrWithWords(
  imageBuffer: Buffer,
  renderScale: number,
  pageHeightPts: number,
): Promise<{ text: string; words: PositionedWord[] }> {
  const worker = await getOcrWorker();
  // blocks:true is required on tesseract.js v5+ to get word bounding boxes
  const result = await worker.recognize(imageBuffer, {}, { text: true, blocks: true } as any);
  return {
    text: result.data.text,
    words: wordsFromTesseract(result.data, renderScale, pageHeightPts),
  };
}

/**
 * Best-effort thumbnail. Rendering uses the `canvas` native module, which
 * depends on system libraries (cairo/pango/etc.) that may not be present in
 * every deployment environment. A failure here must NEVER cost a page its
 * classification — only the thumbnail is lost, logged once per job.
 */
async function tryRenderThumbnail(
  page: pdfjs.PDFPageProxy,
  thumbnailDir: string,
  filename: string,
  pageNum: number,
): Promise<string | undefined> {
  try {
    const thumbnailBuffer = await renderPageToImage(page, 0.5);
    const thumbFilename = `${filename.replace(/\.pdf$/i, "")}_page_${pageNum}.png`;
    const thumbnailPath = path.join(thumbnailDir, thumbFilename);
    fs.writeFileSync(thumbnailPath, thumbnailBuffer);
    return thumbnailPath;
  } catch (err) {
    console.error(`[PlanParser] Thumbnail render failed for ${filename} p${pageNum} (page will still be classified):`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

export async function processJob(
  jobId: string,
  pdfBuffers: { filename: string; buffer: Buffer }[],
  options: ProcessingOptions = {}
): Promise<void> {
  const job = await planParserStorage.getJob(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  
  try {
    await planParserStorage.updateJob(jobId, {
      status: "processing",
      message: "Counting pages..."
    });
    
    let totalPages = 0;
    const pdfDocs: { filename: string; doc: pdfjs.PDFDocumentProxy }[] = [];
    
    for (const { filename, buffer } of pdfBuffers) {
      try {
        const uint8Array = new Uint8Array(buffer);
        const doc = await pdfjs.getDocument({ data: uint8Array, standardFontDataUrl: STANDARD_FONT_DATA_URL, useSystemFonts: true }).promise;
        totalPages += doc.numPages;
        pdfDocs.push({ filename, doc });
      } catch (error) {
        console.error(`Failed to load PDF: ${filename}`, error);
      }
    }
    
    await planParserStorage.updateJob(jobId, {
      totalPages,
      filenames: pdfBuffers.map(p => p.filename),
      message: `Processing ${totalPages} pages...`
    });
    
    const jobDir = await planParserStorage.ensureJobDirectory(jobId);
    const thumbnailDir = path.join(jobDir, "thumbnails");
    if (!fs.existsSync(thumbnailDir)) {
      fs.mkdirSync(thumbnailDir, { recursive: true });
    }
    
    let processedCount = 0;
    let flaggedCount = 0;
    const scopeCounts: Record<string, number> = {};
    PLAN_PARSER_SCOPES.forEach(scope => {
      scopeCounts[scope] = 0;
    });

    const classificationConfig = await getClassificationConfigFromDB();
    
    for (const { filename, doc } of pdfDocs) {
      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        // Text/OCR extraction, thumbnail rendering, and highlight-box
        // computation are independent concerns — a failure in one (most
        // commonly canvas rendering, which depends on system libraries that
        // may be missing in a given deployment) must never silently drop
        // the page's classification. Each stage below is isolated so the
        // worst case is a missing thumbnail or missing highlights, never a
        // vanished page.
        let page: pdfjs.PDFPageProxy | undefined;
        try {
          page = await doc.getPage(pageNum);
        } catch (err) {
          console.error(`[PlanParser] Could not load page ${pageNum} of ${filename} — skipping:`, err instanceof Error ? err.message : err);
          processedCount++;
          continue;
        }

        let ocrText = "";
        let words: PositionedWord[] = [];
        try {
          const extracted = await extractTextAndWordsFromPdf(page);
          ocrText = extracted.text;
          words = extracted.words;
        } catch (err) {
          console.error(`[PlanParser] Text-layer extraction failed for ${filename} p${pageNum}:`, err instanceof Error ? err.message : err);
        }

        if (!ocrText || ocrText.trim().length < 50) {
          try {
            const renderScale = 2.0;
            const imageBuffer = await renderPageToImage(page, renderScale);
            const pageHeightPts = page.getViewport({ scale: 1.0 }).height;
            const ocrResult = await performOcrWithWords(imageBuffer, renderScale, pageHeightPts);
            ocrText = ocrResult.text;
            words = ocrResult.words;
          } catch (err) {
            console.error(`[PlanParser] OCR failed for ${filename} p${pageNum} — page will be created with whatever text was found (possibly none):`, err instanceof Error ? err.message : err);
          }
        }

        const thumbnailPath = await tryRenderThumbnail(page, thumbnailDir, filename, pageNum);

        // Word positions are kept as a sidecar so later passes (callout
        // expansion, highlight export) can compute boxes without re-OCR.
        savePositionedWords(jobDir, filename, pageNum, words);

        const classification = classifyPage(ocrText, classificationConfig);

        let matchBoxes: ReturnType<typeof findMatchBoxes> = [];
        if (classification.isRelevant) {
          try {
            matchBoxes = findMatchBoxes(
              words,
              classification.keywordHits.map(h => ({ term: h.keyword, scope: h.scope })),
            );
          } catch (err) {
            console.error(`[PlanParser] Highlight box computation failed for ${filename} p${pageNum} (page stays flagged, just unhighlighted):`, err instanceof Error ? err.message : err);
          }
        }

        const ocrSnippet = ocrText.substring(0, 500).trim();

        try {
          await planParserStorage.createPage({
            jobId,
            originalFilename: filename,
            pageNumber: pageNum,
            isRelevant: classification.isRelevant,
            tags: classification.tags,
            confidence: classification.confidence,
            whyFlagged: classification.whyFlagged,
            signageOverrideApplied: classification.signageOverrideApplied,
            ocrSnippet,
            ocrText,
            thumbnailPath,
            userModified: false,
            matchBoxes,
            matchType: classification.isRelevant ? "keyword" : "none"
          });

          if (classification.isRelevant) {
            flaggedCount++;
            for (const tag of classification.tags) {
              scopeCounts[tag] = (scopeCounts[tag] || 0) + 1;
            }
          }
        } catch (err) {
          console.error(`[PlanParser] Failed to save page ${filename} p${pageNum}:`, err instanceof Error ? err.message : err);
        }

        processedCount++;

        const progressPercent = Math.round((processedCount / totalPages) * 100);
        await planParserStorage.updateJob(jobId, {
          processedPages: processedCount,
          flaggedPages: flaggedCount,
          scopeCounts,
          message: `Analyzing page ${processedCount} of ${totalPages}...`
        });

        options.onProgress?.(processedCount, totalPages, `${progressPercent}%`);
      }
    }
    
    await planParserStorage.updateJob(jobId, {
      status: "complete",
      processedPages: processedCount,
      flaggedPages: flaggedCount,
      scopeCounts,
      message: `Complete! Found ${flaggedCount} relevant pages.`
    });
    
    for (const { doc } of pdfDocs) {
      doc.destroy();
    }
    
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    await planParserStorage.updateJob(jobId, {
      status: "error",
      message: error instanceof Error ? error.message : "Processing failed"
    });
  }
}

export async function reprocessJobWithSpecBoost(
  jobId: string,
  specBoosts: import("./classificationConfig").SpecBoostData[]
): Promise<void> {
  const { mergeSpecBoostIntoConfig } = await import("./classificationConfig");

  const job = await planParserStorage.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const pages = await planParserStorage.getPagesByJob(jobId);
  if (pages.length === 0) throw new Error("No pages found for reprocessing");

  const baseConfig = await getClassificationConfigFromDB();
  const boostedConfig = mergeSpecBoostIntoConfig(baseConfig, specBoosts);

  console.log(`[SpecPass] Reprocessing ${pages.length} pages with ${specBoosts.length} spec boosts`);
  for (const boost of specBoosts) {
    console.log(`  - ${boost.scopeType}: ${boost.manufacturers.length} mfrs, ${boost.modelNumbers.length} models, ${boost.materials.length} materials`);
  }

  await planParserStorage.updateJob(jobId, {
    status: "processing",
    processedPages: 0,
    flaggedPages: 0,
    scopeCounts: {},
    message: "Running spec-informed second pass..."
  });

  let processedCount = 0;
  let flaggedCount = 0;
  const scopeCounts: Record<string, number> = {};
  PLAN_PARSER_SCOPES.forEach(scope => { scopeCounts[scope] = 0; });

  const jobDir = planParserStorage.getJobDirectory(jobId);

  for (const page of pages) {
    const ocrText = page.ocrText || page.ocrSnippet || "";

    if (ocrText.trim().length < 20) {
      processedCount++;
      continue;
    }

    const classification = classifyPage(ocrText, boostedConfig);

    let matchBoxes = page.matchBoxes || [];
    if (classification.isRelevant) {
      const words = loadPositionedWords(jobDir, page.originalFilename, page.pageNumber);
      if (words.length > 0) {
        matchBoxes = findMatchBoxes(
          words,
          classification.keywordHits.map(h => ({ term: h.keyword, scope: h.scope })),
        );
      }
    }

    await planParserStorage.updatePage(page.id, {
      isRelevant: classification.isRelevant,
      tags: classification.tags,
      confidence: classification.confidence,
      whyFlagged: classification.whyFlagged,
      signageOverrideApplied: classification.signageOverrideApplied,
      matchBoxes,
      matchType: classification.isRelevant ? "keyword" : "none",
    });

    if (classification.isRelevant) {
      flaggedCount++;
      for (const tag of classification.tags) {
        scopeCounts[tag] = (scopeCounts[tag] || 0) + 1;
      }
    }

    processedCount++;
    const progressPercent = Math.round((processedCount / pages.length) * 100);
    await planParserStorage.updateJob(jobId, {
      processedPages: processedCount,
      flaggedPages: flaggedCount,
      scopeCounts,
      message: `Spec-pass: analyzing page ${processedCount} of ${pages.length}...`
    });
  }

  await planParserStorage.updateJob(jobId, {
    status: "complete",
    processedPages: processedCount,
    flaggedPages: flaggedCount,
    scopeCounts,
    message: `Spec-informed pass complete! Found ${flaggedCount} relevant pages.`
  });
}

export async function cleanupOcrWorker(): Promise<void> {
  if (tesseractWorker) {
    await tesseractWorker.terminate();
    tesseractWorker = null;
  }
}
