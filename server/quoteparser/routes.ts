import { Router } from "express";
import multer from "multer";
import { extractTextFromFile } from "./quoteParser";
import {
  parseQuoteFromText,
  parseQuoteFromImage,
  checkSpecCompliance,
  formatCurrency,
  getSystemPrompt,
  saveSystemPrompt,
  getVendorMemory,
} from "./openaiQuoteParser";
import { requireAuth } from "../authRoutes";
import { db } from "../db";
import { quoteParserFeedback } from "@shared/schema";
import { eq } from "drizzle-orm";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

interface OutputRow {
  planCallout: string;
  description: string;
  modelNumber: string;
  qty: string;
  material: string;
  freight: string;
  confidence?: number;
  confidenceNote?: string;
  lineType?: string;
  defaultChecked?: boolean;
}

const quoteParserRouter = Router();

// ── Parse quote ───────────────────────────────────────────────────────────────

quoteParserRouter.post(
  "/parse",
  requireAuth,
  upload.fields([{ name: "quoteFile", maxCount: 1 }, { name: "specFile", maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ rows: [], errors: [{ type: "CONFIG_ERROR", message: "OpenAI API key not configured." }], warnings: [] });
      }

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      const quoteFile = files?.quoteFile?.[0];
      const specFile = files?.specFile?.[0];
      const quoteText: string = req.body.quoteText || "";
      const specText: string = req.body.specText || "";

      const warnings: string[] = [];
      let result;

      // Parse the quote
      if (quoteFile) {
        const isImage = quoteFile.mimetype.startsWith("image/");
        if (isImage) {
          result = await parseQuoteFromImage(quoteFile.buffer, quoteFile.mimetype);
        } else {
          // PDF or text — extract text first, then send to AI
          const extracted = await extractTextFromFile(quoteFile.buffer, quoteFile.mimetype);
          warnings.push(...extracted.warnings);
          if (!extracted.text.trim()) {
            return res.status(400).json({ rows: [], errors: [{ type: "HARD_FAIL", message: "Could not extract text from file." }], warnings });
          }
          result = await parseQuoteFromText(extracted.text);
        }
      } else if (quoteText.trim()) {
        result = await parseQuoteFromText(quoteText);
      } else {
        return res.status(400).json({ rows: [], errors: [{ type: "HARD_FAIL", message: "No quote content provided." }], warnings });
      }

      warnings.push(...result.warnings);
      if (result.detectedVendorName) {
        warnings.unshift(`Vendor recognized: ${result.detectedVendorName}`);
      }

      // Build output rows — line items first, summary row last
      const rows: OutputRow[] = [];

      for (const item of result.lineItems) {
        if (item.lineType === "freight") continue; // freight goes in summary row only
        rows.push({
          planCallout: "",
          description: item.description,
          modelNumber: item.modelNumber,
          qty: item.qty,
          material: "$0.00",
          freight: "$-",
          confidence: item.confidence,
          confidenceNote: item.confidenceNote,
          lineType: item.lineType,
          defaultChecked: item.defaultChecked,
        });
      }

      // Summary row
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

      // Spec compliance check (optional)
      let specCheck = null;
      if (specText.trim() || specFile) {
        let finalSpecText = specText;
        if (specFile) {
          const extracted = await extractTextFromFile(specFile.buffer, specFile.mimetype);
          finalSpecText = extracted.text || specText;
        }
        if (finalSpecText.trim()) {
          specCheck = await checkSpecCompliance(result, finalSpecText);
        }
      }

      res.json({ rows, errors: [], warnings, specCheck, vendorName: result.detectedVendorName, quoteNumber: result.quoteNumber });
    } catch (error: any) {
      console.error("Quote parse error:", error);
      res.status(500).json({ rows: [], errors: [{ type: "SERVER_ERROR", message: error.message || "Failed to parse quote" }], warnings: [] });
    }
  }
);

// ── Feedback ──────────────────────────────────────────────────────────────────

quoteParserRouter.post("/feedback", requireAuth, async (req, res) => {
  const { vendorName, quoteNumber, issueDescription, rawTextSnippet } = req.body;
  if (!issueDescription?.trim()) return res.status(400).json({ error: "Issue description required" });
  const row = await db.insert(quoteParserFeedback).values({ vendorName, quoteNumber, issueDescription, rawTextSnippet }).returning();
  res.json(row[0]);
});

quoteParserRouter.get("/feedback", requireAuth, async (req, res) => {
  const rows = await db.select().from(quoteParserFeedback).orderBy(quoteParserFeedback.createdAt);
  res.json(rows);
});

quoteParserRouter.patch("/feedback/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, appliedNote } = req.body;
  const updated = await db
    .update(quoteParserFeedback)
    .set({ status, appliedNote, reviewedAt: new Date() })
    .where(eq(quoteParserFeedback.id, id))
    .returning();
  res.json(updated[0]);
});

// ── System Prompt (handbook) ──────────────────────────────────────────────────

quoteParserRouter.get("/system-prompt", requireAuth, async (req, res) => {
  const prompt = await getSystemPrompt();
  res.json({ prompt });
});

quoteParserRouter.put("/system-prompt", requireAuth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: "Prompt required" });
  await saveSystemPrompt(prompt);
  res.json({ success: true });
});

// ── Vendor Memory ─────────────────────────────────────────────────────────────

quoteParserRouter.get("/vendor-memory", requireAuth, async (req, res) => {
  const memory = await getVendorMemory();
  res.json(memory);
});

export function registerQuoteParserRoutes(app: Router) {
  app.use("/api/quoteparser", quoteParserRouter);
}
