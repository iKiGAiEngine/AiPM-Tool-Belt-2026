import { Router } from "express";
import multer from "multer";
import { extractTextFromFile } from "./quoteParser";
import { renderPdfToImages } from "./pdfToImages";
import {
  parseQuoteSources,
  extractScheduleEntries,
  checkSpecCompliance,
  formatCurrency,
  getSystemPrompt,
  saveSystemPrompt,
  getVendorRules,
  saveVendorRules,
  draftVendorRule,
  detectVendor,
  QuoteSource,
  MODEL,
  VENDOR_RULES_MAX_CHARS,
} from "./openaiQuoteParser";
import { reconcileTotals, consolidateLineItems } from "./reconcile";
import { matchQuoteToSchedule } from "./scheduleMatcher";
import { logParseRun, recordRunFeedback, getRun, getVendorMemory, getParserStats, RunGateSummary } from "./runLog";
import { requireAuth, requireAdmin } from "../authRoutes";
import { db } from "../db";
import { quoteParserFeedback, vendors } from "@shared/schema";
import { eq } from "drizzle-orm";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Guardrails so an oversized paste or extraction can't blow past the model's
// context window. Generous for real quotes; warnings tell the user when hit.
const QUOTE_TEXT_CAP = 60_000;
const SPEC_TEXT_CAP = 40_000;
const SCHEDULE_TEXT_CAP = 40_000;

interface OutputRow {
  planCallout: string;
  description: string;
  modelNumber: string;
  qty: string;
  material: string;
  freight: string;
  unitPrice?: number | null;
  extendedPrice?: number | null;
  confidence?: number;
  confidenceNote?: string;
  lineType?: string;
  defaultChecked?: boolean;
  calloutConfidence?: number;
}

const quoteParserRouter = Router();

/**
 * Turn one input section (optional file, optional pasted images, optional
 * pasted text) into model-ready sources. Files may be PDFs (text layer used
 * when present, pages rendered to images when scanned), images, or plain text.
 */
async function buildSources(opts: {
  label: string;
  file?: Express.Multer.File;
  images?: Express.Multer.File[];
  text?: string;
  textCap: number;
  warnings: string[];
}): Promise<{ sources: QuoteSource[]; extractedText: string; inputTypes: string[] }> {
  const { label, file, images, text, textCap, warnings } = opts;
  const sources: QuoteSource[] = [];
  const inputTypes: string[] = [];
  let extractedText = "";

  if (file) {
    if (file.mimetype.startsWith("image/")) {
      sources.push({ kind: "image", label: `${label} (uploaded image)`, buffer: file.buffer, mimeType: file.mimetype });
      inputTypes.push("image");
    } else {
      const extracted = await extractTextFromFile(file.buffer, file.mimetype);
      warnings.push(...extracted.warnings);
      if (extracted.scanned && file.mimetype === "application/pdf") {
        const pages = await renderPdfToImages(file.buffer);
        if (pages.length === 0) {
          warnings.push(`Could not read any pages from ${file.originalname || "the PDF"}.`);
        }
        for (const page of pages) {
          sources.push({ kind: "image", label: `${label} (page ${page.pageNumber})`, buffer: page.png, mimeType: "image/png" });
        }
        inputTypes.push("pdf-vision");
      } else if (extracted.text.trim()) {
        let fileText = extracted.text;
        if (fileText.length > textCap) {
          warnings.push(`${label} file text was very long and was trimmed for parsing.`);
          fileText = fileText.slice(0, textCap);
        }
        sources.push({ kind: "text", label: `${label} (from ${file.originalname || "file"})`, text: fileText });
        extractedText += fileText + "\n";
        inputTypes.push(file.mimetype === "application/pdf" ? "pdf-text" : "file-text");
      }
    }
  }

  for (const img of images || []) {
    sources.push({ kind: "image", label: `${label} (pasted screenshot)`, buffer: img.buffer, mimeType: img.mimetype });
    inputTypes.push("screenshot");
  }

  if (text && text.trim()) {
    let pasted = text.trim();
    if (pasted.length > textCap) {
      warnings.push(`${label} pasted text was very long and was trimmed for parsing.`);
      pasted = pasted.slice(0, textCap);
    }
    sources.push({ kind: "text", label: `${label} (pasted text)`, text: pasted });
    extractedText += pasted + "\n";
    inputTypes.push("text");
  }

  return { sources, extractedText, inputTypes };
}

// ── Parse quote ───────────────────────────────────────────────────────────────

quoteParserRouter.post(
  "/parse",
  requireAuth,
  upload.fields([
    { name: "quoteFile", maxCount: 1 },
    { name: "quoteImage", maxCount: 4 },
    { name: "specFile", maxCount: 1 },
    { name: "scheduleFile", maxCount: 1 },
  ]),
  async (req, res) => {
    const startedAt = Date.now();
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ rows: [], errors: [{ type: "CONFIG_ERROR", message: "OpenAI API key not configured." }], warnings: [] });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const warnings: string[] = [];

      // ── Gather quote sources (file + screenshots + text all combine) ──
      const quote = await buildSources({
        label: "Quote",
        file: files?.quoteFile?.[0],
        images: files?.quoteImage,
        text: req.body.quoteText,
        textCap: QUOTE_TEXT_CAP,
        warnings,
      });
      if (quote.sources.length === 0) {
        return res.status(400).json({ rows: [], errors: [{ type: "HARD_FAIL", message: "No quote content provided." }], warnings });
      }
      if (quote.inputTypes.length > 1) {
        warnings.push(`Combined ${quote.inputTypes.length} quote sources into one parse (${quote.inputTypes.join(", ")}).`);
      }

      // ── Parse ──
      const result = await parseQuoteSources(quote.sources);
      warnings.push(...result.warnings);
      if (result.detectedVendorName) {
        warnings.unshift(`Vendor recognized: ${result.detectedVendorName}`);
      }

      // ── Gate 1: math reconciliation (mutates per-line confidence on bad math) ──
      const reconciliation = reconcileTotals(result);

      // ── Consolidate tags/decals into their parent products for output ──
      const consolidated = consolidateLineItems(result.lineItems);

      // ── Gate 3: schedule coverage (optional) ──
      let scheduleCheck: {
        scheduledCount: number;
        matchedCount: number;
        missing: Array<{ callout: string; description: string; modelNumber: string; qty: string }>;
        qtyMismatches: Array<{ callout: string; description: string; scheduledQty: string; quotedQty: string }>;
        extras: string[];
      } | null = null;
      const calloutByIndex = new Map<number, { callout: string; confidence: number }>();

      const schedule = await buildSources({
        label: "Schedule",
        file: files?.scheduleFile?.[0],
        text: req.body.scheduleText,
        textCap: SCHEDULE_TEXT_CAP,
        warnings,
      });
      let scheduleIssues: string[] = [];
      let scheduleConfirmations: string[] = [];
      if (schedule.sources.length > 0) {
        const { entries, warnings: schedWarnings } = await extractScheduleEntries(schedule.sources);
        warnings.push(...schedWarnings);
        if (entries.length === 0) {
          warnings.push("No schedule items could be read from the schedule input.");
        } else {
          const coverage = matchQuoteToSchedule(consolidated, entries);
          for (const match of coverage.matches) {
            calloutByIndex.set(match.lineIndex, { callout: match.callout, confidence: match.confidence });
          }
          scheduleCheck = {
            scheduledCount: entries.length,
            matchedCount: coverage.matches.length,
            missing: coverage.missing,
            qtyMismatches: coverage.qtyMismatches,
            extras: coverage.extraLineIndexes.map(
              (i) => consolidated[i].modelNumber || consolidated[i].description.slice(0, 40)
            ),
          };
          scheduleIssues = coverage.issues;
          scheduleConfirmations = coverage.confirmations;
        }
      }

      // ── Gate 2: spec compliance (optional) ──
      let specCheck = null;
      const spec = await buildSources({
        label: "Spec",
        file: files?.specFile?.[0],
        text: req.body.specText,
        textCap: SPEC_TEXT_CAP,
        warnings,
      });
      if (spec.sources.length > 0) {
        specCheck = await checkSpecCompliance(result, spec.sources);
      }

      // ── Verdict: VERIFIED only when every check passed and every line is
      //    high-confidence. Anything less gets an itemized NEEDS REVIEW list. ──
      const reviewItems: string[] = [...reconciliation.issues];
      const confirmations: string[] = [...reconciliation.confirmations, ...scheduleConfirmations];

      for (const item of consolidated) {
        if (item.confidence < 95) {
          reviewItems.push(
            `Low confidence (${item.confidence}%) on "${item.modelNumber || item.description.slice(0, 40)}"${item.confidenceNote ? `: ${item.confidenceNote}` : ""}.`
          );
        }
      }
      if (specCheck) {
        const fails = specCheck.checks.filter((c) => c.status === "fail");
        const specWarns = specCheck.checks.filter((c) => c.status === "warn");
        for (const f of fails) reviewItems.push(`Spec conflict: ${f.message}`);
        for (const w of specWarns) reviewItems.push(`Spec verification needed: ${w.message}`);
        if (fails.length === 0 && specWarns.length === 0 && specCheck.checks.length > 0) {
          confirmations.push(`Spec check: all ${specCheck.checks.length} checks passed.`);
        }
      }
      reviewItems.push(...scheduleIssues);

      const verdict: "verified" | "needs_review" =
        reviewItems.length === 0 && reconciliation.status === "pass" ? "verified" : "needs_review";

      // ── Log the run (background data gathering — never fatal) ──
      const gateResults: RunGateSummary = {
        math: { status: reconciliation.status, issues: reconciliation.issues.length },
        spec: {
          ran: !!specCheck,
          fails: specCheck ? specCheck.checks.filter((c) => c.status === "fail").length : 0,
          warns: specCheck ? specCheck.checks.filter((c) => c.status === "warn").length : 0,
        },
        schedule: {
          ran: !!scheduleCheck,
          missing: scheduleCheck?.missing.length ?? 0,
          qtyMismatches: scheduleCheck?.qtyMismatches.length ?? 0,
          extras: scheduleCheck?.extras.length ?? 0,
        },
      };
      const runId = await logParseRun({
        result,
        inputTypes: quote.inputTypes,
        model: MODEL,
        durationMs: Date.now() - startedAt,
        extractedText: quote.extractedText,
        gateResults,
        verdict,
        reconciliationStatus: reconciliation.status,
      });

      // ── Build output rows — line items first, summary row last.
      //    NOTE: per-line MATERIAL stays "$0.00" on purpose — the estimate
      //    sheet's paste format must not change. Real prices ride along in
      //    unitPrice/extendedPrice for on-screen display and verification. ──
      const rows: OutputRow[] = consolidated.map((item, i) => ({
        planCallout: calloutByIndex.get(i)?.callout || "",
        description: item.description,
        modelNumber: item.modelNumber,
        qty: item.qty,
        material: "$0.00",
        freight: "$-",
        unitPrice: item.unitPrice,
        extendedPrice: item.extendedPrice,
        confidence: item.confidence,
        confidenceNote: item.confidenceNote,
        lineType: item.lineType,
        defaultChecked: item.defaultChecked,
        calloutConfidence: calloutByIndex.get(i)?.confidence,
      }));

      const summaryLabel = [result.manufacturer, result.quoteNumber].filter(Boolean).join(" - ") || "Quote Summary";
      rows.push({
        planCallout: "",
        description: "",
        modelNumber: summaryLabel,
        qty: "1",
        material: formatCurrency(result.materialTotal),
        freight: formatCurrency(result.freightTotal),
        lineType: "summary",
      });

      res.json({
        rows,
        errors: [],
        warnings,
        verdict: { status: verdict, confirmations, reviewItems },
        specCheck,
        scheduleCheck,
        vendorName: result.detectedVendorName,
        quoteNumber: result.quoteNumber,
        taxTotal: result.taxTotal,
        runId,
      });
    } catch (error: any) {
      console.error("Quote parse error:", error);
      res.status(500).json({ rows: [], errors: [{ type: "SERVER_ERROR", message: error.message || "Failed to parse quote" }], warnings: [] });
    }
  }
);

// ── Feedback ──────────────────────────────────────────────────────────────────

quoteParserRouter.post("/feedback", requireAuth, async (req, res) => {
  const { runId, vendorName, quoteNumber, issueDescription } = req.body;
  if (!issueDescription?.trim()) return res.status(400).json({ error: "Issue description required" });

  let resolvedVendor = typeof vendorName === "string" ? vendorName.slice(0, 200) : null;
  let resolvedQuote = typeof quoteNumber === "string" ? quoteNumber.slice(0, 100) : null;
  let rawTextSnippet: string | null = null;
  const numericRunId = Number.isInteger(runId) ? (runId as number) : null;

  // Attach the actual quote text from the logged run so the complaint carries
  // its evidence — this is what makes feedback actionable later.
  if (numericRunId !== null) {
    const run = await getRun(numericRunId);
    if (run) {
      resolvedVendor = resolvedVendor || run.vendorName;
      resolvedQuote = resolvedQuote || run.quoteNumber;
      rawTextSnippet = run.extractedTextSnippet;
      await recordRunFeedback(numericRunId, "down");
    }
  }

  const row = await db
    .insert(quoteParserFeedback)
    .values({
      runId: numericRunId,
      vendorName: resolvedVendor,
      quoteNumber: resolvedQuote,
      issueDescription: String(issueDescription).slice(0, 5000),
      rawTextSnippet,
    })
    .returning();
  res.json(row[0]);
});

quoteParserRouter.post("/runs/:id/thumbs-up", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid run id" });
  await recordRunFeedback(id, "up");
  res.json({ success: true });
});

quoteParserRouter.get("/feedback", requireAuth, async (req, res) => {
  const rows = await db.select().from(quoteParserFeedback).orderBy(quoteParserFeedback.createdAt);
  res.json(rows);
});

quoteParserRouter.patch("/feedback/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid feedback id" });
  const { status, appliedNote } = req.body;
  if (status && !["open", "reviewed", "applied"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const updated = await db
    .update(quoteParserFeedback)
    .set({ status, appliedNote, reviewedAt: new Date() })
    .where(eq(quoteParserFeedback.id, id))
    .returning();
  res.json(updated[0]);
});

// Learning loop: draft a reusable vendor rule from a complaint. Admin reviews
// the suggestion and saves it to the vendor's rules (next route) — nothing is
// applied automatically.
quoteParserRouter.post("/feedback/:id/draft-rule", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid feedback id" });
    const rows = await db.select().from(quoteParserFeedback).where(eq(quoteParserFeedback.id, id));
    const feedback = rows[0];
    if (!feedback) return res.status(404).json({ error: "Feedback not found" });
    if (!feedback.vendorName) return res.status(400).json({ error: "This feedback has no vendor — write the rule manually." });

    const vendor = await detectVendor(feedback.vendorName);
    const suggestion = await draftVendorRule({
      vendorName: feedback.vendorName,
      issueDescription: feedback.issueDescription,
      rawTextSnippet: feedback.rawTextSnippet,
    });
    const existingRules = vendor ? await getVendorRules(vendor.id) : "";
    res.json({
      suggestion,
      vendorId: vendor?.id ?? null,
      vendorName: feedback.vendorName,
      existingRules,
    });
  } catch (error: any) {
    console.error("Draft rule error:", error);
    res.status(500).json({ error: error.message || "Failed to draft rule" });
  }
});

// ── Vendor rules ──────────────────────────────────────────────────────────────

quoteParserRouter.get("/vendor-rules/:vendorId", requireAuth, async (req, res) => {
  const vendorId = parseInt(req.params.vendorId);
  if (isNaN(vendorId)) return res.status(400).json({ error: "Invalid vendor id" });
  const rules = await getVendorRules(vendorId);
  res.json({ vendorId, rules, maxChars: VENDOR_RULES_MAX_CHARS });
});

quoteParserRouter.put("/vendor-rules/:vendorId", requireAdmin, async (req, res) => {
  const vendorId = parseInt(req.params.vendorId);
  if (isNaN(vendorId)) return res.status(400).json({ error: "Invalid vendor id" });
  const vendorRows = await db.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId));
  if (vendorRows.length === 0) return res.status(404).json({ error: "Vendor not found" });
  await saveVendorRules(vendorId, String(req.body.rules ?? ""));
  res.json({ success: true });
});

// ── System Prompt (handbook) ──────────────────────────────────────────────────

quoteParserRouter.get("/system-prompt", requireAuth, async (req, res) => {
  const prompt = await getSystemPrompt();
  res.json({ prompt });
});

quoteParserRouter.put("/system-prompt", requireAdmin, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: "Prompt required" });
  await saveSystemPrompt(prompt);
  res.json({ success: true });
});

// ── Vendor Memory & Stats ─────────────────────────────────────────────────────

quoteParserRouter.get("/vendor-memory", requireAuth, async (req, res) => {
  const memory = await getVendorMemory();
  res.json(memory);
});

quoteParserRouter.get("/stats", requireAuth, async (req, res) => {
  const stats = await getParserStats();
  res.json(stats);
});

export function registerQuoteParserRoutes(app: Router) {
  app.use("/api/quoteparser", quoteParserRouter);
}
