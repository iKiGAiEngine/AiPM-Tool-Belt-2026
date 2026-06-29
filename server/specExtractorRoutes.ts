import type { Express, Request, Response } from "express";
import multer from "multer";
import { db } from "./db";
import { specExtractorSessions, specExtractorSections } from "@shared/schema";
import { eq } from "drizzle-orm";
import { runExtraction, extractSectionPdf, extractPages, isSignageSection, findAccessorySections, parseTocHints, ACCESSORY_SCOPES, type AccessoryScope, type TOCHint } from "./specExtractorEngine";
import { getActiveConfiguration } from "./configService";
import JSZip from "jszip";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import OpenAI from "openai";
import { UPLOAD_CHUNK_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@shared/uploadLimits";

const DATA_DIR = path.join(process.cwd(), "data", "spec-extractor");
const UPLOAD_TMP_DIR = path.join(DATA_DIR, "uploads");

const pageCache = new Map<string, { pages: string[]; timestamp: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getCachedPages(sessionId: string): Promise<string[]> {
  const cached = pageCache.get(sessionId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.pages;
  }
  const pdfPath = path.join(DATA_DIR, `${sessionId}.pdf`);
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await fs.promises.readFile(pdfPath);
  } catch {
    throw new Error("Source PDF not found");
  }
  const pages = await extractPages(pdfBuffer);
  pageCache.set(sessionId, { pages, timestamp: Date.now() });
  if (pageCache.size > 20) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    pageCache.forEach((val, key) => {
      if (val.timestamp < oldestTime) {
        oldestTime = val.timestamp;
        oldestKey = key;
      }
    });
    if (oldestKey) pageCache.delete(oldestKey);
  }
  return pages;
}

const upload = multer({
  storage: multer.memoryStorage(),
  // Single-shot path is only used for small files (the client routes anything
  // larger than UPLOAD_CHUNK_BYTES through the chunked endpoints below). Cap at
  // 2x the chunk size so a stray large single-shot request is rejected cleanly
  // rather than buffering hundreds of MB in memory.
  limits: { fileSize: UPLOAD_CHUNK_BYTES * 2 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

// Multer for individual chunks in the chunked-upload flow. Each chunk is held in
// memory only briefly before being flushed to disk; the 2x margin covers
// multipart overhead.
const uploadChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_CHUNK_BYTES * 2 },
});

interface PendingUpload {
  filename: string;
  projectName: string;
  selectedAccessories: string[];
  tocHints: string;
  totalChunks: number;
  totalSize: number;
  dir: string;
  createdAt: number;
}

const pendingUploads = new Map<string, PendingUpload>();
const UPLOAD_TTL_MS = 30 * 60 * 1000;

async function cleanupStaleUploads(): Promise<void> {
  const now = Date.now();
  for (const [sessionId, info] of Array.from(pendingUploads.entries())) {
    if (now - info.createdAt > UPLOAD_TTL_MS) {
      pendingUploads.delete(sessionId);
      try {
        await fs.promises.rm(info.dir, { recursive: true, force: true });
      } catch (err) {
        console.error(`[SpecExtractor] Failed to clean up stale upload ${sessionId}:`, err);
      }
    }
  }
}

function generateId(): string {
  return `se_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").replace(/[^a-zA-Z0-9 \-_().]/g, "").trim() || "Untitled";
}

const MAX_TITLE_LENGTH = 40;
const MAX_PROJECT_NAME_LENGTH = 30;
const MAX_FOLDER_NAME_LENGTH = 50;

function truncateAtWord(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace).replace(/[\s\-]+$/, "");
  }
  return truncated.replace(/[\s\-]+$/, "");
}

function buildPdfFilename(sectionNumber: string, title: string, projectName: string): string {
  const safeTitle = truncateAtWord(sanitizeFilename(title), MAX_TITLE_LENGTH);
  const safeProject = truncateAtWord(sanitizeFilename(projectName), MAX_PROJECT_NAME_LENGTH);
  return `${sectionNumber} - ${safeTitle} - ${safeProject}.pdf`;
}

function buildFolderName(sectionNumber: string, title: string): string {
  const prefix = `${sectionNumber} - `;
  const maxTitleLen = MAX_FOLDER_NAME_LENGTH - prefix.length;
  const safeTitle = truncateAtWord(sanitizeFilename(title), maxTitleLen);
  return `${prefix}${safeTitle}`;
}

export function registerSpecExtractorRoutes(app: Express) {
  app.post("/api/spec-extractor/upload", (req, res, next) => {
    upload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          // This path only handles small single-shot uploads; larger files use
          // the chunked endpoints. If a big file lands here, tell the client to
          // retry via the chunked flow rather than implying a hard size cap.
          return res.status(413).json({ message: "This file is too large for a direct upload. Please retry — large PDFs are uploaded in chunks automatically." });
        }
        return res.status(400).json({ message: err.message || "File upload error" });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const sessionId = generateId();
      const projectName = (req.body.projectName as string)?.trim() || "";
      let selectedAccessories: string[] = [];
      try {
        const raw = req.body.selectedAccessories;
        if (raw) {
          selectedAccessories = JSON.parse(raw);
        }
      } catch {}
      let tocHintsRaw = (req.body.tocHints as string)?.trim() || "";
      const now = new Date().toISOString();

      await fs.promises.mkdir(DATA_DIR, { recursive: true });

      const pdfPath = path.join(DATA_DIR, `${sessionId}.pdf`);
      await fs.promises.writeFile(pdfPath, req.file.buffer);

      await db.insert(specExtractorSessions).values({
        id: sessionId,
        filename: req.file.originalname,
        projectName,
        selectedAccessories,
        status: "processing",
        progress: 0,
        message: "Starting extraction...",
        totalPages: 0,
        createdAt: now,
      });

      res.json({
        id: sessionId,
        filename: req.file.originalname,
        projectName,
        selectedAccessories,
        status: "processing",
        progress: 0,
        message: "Starting extraction...",
        createdAt: now,
      });

      processInBackground(sessionId, req.file.buffer, tocHintsRaw).catch(err => {
        console.error(`[SpecExtractor] Background processing failed for ${sessionId}:`, err);
      });

    } catch (error: any) {
      console.error("[SpecExtractor] Upload error:", error);
      res.status(500).json({ message: error.message || "Upload failed" });
    }
  });

  // ── Chunked upload (for files larger than the Autoscale ~32 MiB proxy cap) ──
  // The client splits the PDF into <= UPLOAD_CHUNK_BYTES pieces and drives:
  //   init  -> create session + temp dir, get a sessionId
  //   chunk -> upload each piece (kept well under the proxy limit)
  //   complete -> reassemble on disk and kick off the same background extraction.

  app.post("/api/spec-extractor/upload/init", async (req: Request, res: Response) => {
    try {
      await cleanupStaleUploads();

      const filename = (req.body.filename as string)?.trim() || "upload.pdf";
      if (!filename.toLowerCase().endsWith(".pdf")) {
        return res.status(400).json({ message: "Only PDF files are allowed" });
      }

      const totalChunks = parseInt(String(req.body.totalChunks), 10);
      const totalSize = parseInt(String(req.body.totalSize), 10);
      if (!Number.isFinite(totalChunks) || totalChunks < 1) {
        return res.status(400).json({ message: "Invalid totalChunks" });
      }
      if (Number.isFinite(totalSize) && totalSize > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ message: `File is too large. Maximum size is ${MAX_UPLOAD_LABEL}.` });
      }

      const projectName = (req.body.projectName as string)?.trim() || "";
      let selectedAccessories: string[] = [];
      try {
        if (req.body.selectedAccessories) selectedAccessories = JSON.parse(req.body.selectedAccessories);
      } catch {}
      const tocHints = (req.body.tocHints as string)?.trim() || "";

      const sessionId = generateId();
      const dir = path.join(UPLOAD_TMP_DIR, sessionId);
      await fs.promises.mkdir(dir, { recursive: true });

      pendingUploads.set(sessionId, {
        filename,
        projectName,
        selectedAccessories,
        tocHints,
        totalChunks,
        totalSize: Number.isFinite(totalSize) ? totalSize : 0,
        dir,
        createdAt: Date.now(),
      });

      res.json({ sessionId, chunkSize: UPLOAD_CHUNK_BYTES });
    } catch (error: any) {
      console.error("[SpecExtractor] Chunked upload init error:", error);
      res.status(500).json({ message: error.message || "Upload init failed" });
    }
  });

  app.post("/api/spec-extractor/upload/chunk", (req, res, next) => {
    uploadChunk.single("chunk")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "Chunk is too large." });
        }
        return res.status(400).json({ message: err.message || "Chunk upload error" });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      const sessionId = (req.body.sessionId as string)?.trim();
      const chunkIndex = parseInt(String(req.body.chunkIndex), 10);
      const info = sessionId ? pendingUploads.get(sessionId) : undefined;

      if (!info) {
        return res.status(404).json({ message: "Upload session not found or expired. Please start the upload again." });
      }
      if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || chunkIndex >= info.totalChunks) {
        return res.status(400).json({ message: "Invalid chunkIndex" });
      }
      if (!req.file) {
        return res.status(400).json({ message: "No chunk data received" });
      }

      await fs.promises.writeFile(path.join(info.dir, `${chunkIndex}.part`), req.file.buffer);
      res.json({ received: chunkIndex });
    } catch (error: any) {
      console.error("[SpecExtractor] Chunk upload error:", error);
      res.status(500).json({ message: error.message || "Chunk upload failed" });
    }
  });

  app.post("/api/spec-extractor/upload/complete", async (req: Request, res: Response) => {
    try {
      const sessionId = (req.body.sessionId as string)?.trim();
      const info = sessionId ? pendingUploads.get(sessionId) : undefined;
      if (!info) {
        return res.status(404).json({ message: "Upload session not found or expired. Please start the upload again." });
      }

      // Verify every chunk arrived before assembling.
      const missing: number[] = [];
      for (let i = 0; i < info.totalChunks; i++) {
        if (!fs.existsSync(path.join(info.dir, `${i}.part`))) missing.push(i);
      }
      if (missing.length > 0) {
        return res.status(400).json({ message: `Upload incomplete — missing chunk(s): ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}` });
      }

      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      const pdfPath = path.join(DATA_DIR, `${sessionId}.pdf`);

      // Stream-concatenate the parts in order so we never hold the whole file in RAM.
      const out = fs.createWriteStream(pdfPath);
      try {
        for (let i = 0; i < info.totalChunks; i++) {
          await pipeline(fs.createReadStream(path.join(info.dir, `${i}.part`)), out, { end: false });
        }
        out.end();
        await new Promise<void>((resolve, reject) => {
          out.on("finish", resolve);
          out.on("error", reject);
        });
      } catch (err) {
        out.destroy();
        throw err;
      }

      // Done with the temp parts.
      pendingUploads.delete(sessionId);
      await fs.promises.rm(info.dir, { recursive: true, force: true }).catch(() => {});

      const now = new Date().toISOString();
      await db.insert(specExtractorSessions).values({
        id: sessionId,
        filename: info.filename,
        projectName: info.projectName,
        selectedAccessories: info.selectedAccessories,
        status: "processing",
        progress: 0,
        message: "Starting extraction...",
        totalPages: 0,
        createdAt: now,
      });

      res.json({
        id: sessionId,
        filename: info.filename,
        projectName: info.projectName,
        selectedAccessories: info.selectedAccessories,
        status: "processing",
        progress: 0,
        message: "Starting extraction...",
        createdAt: now,
      });

      const pdfBuffer = await fs.promises.readFile(pdfPath);
      processInBackground(sessionId, pdfBuffer, info.tocHints).catch(err => {
        console.error(`[SpecExtractor] Background processing failed for ${sessionId}:`, err);
      });
    } catch (error: any) {
      console.error("[SpecExtractor] Chunked upload complete error:", error);
      res.status(500).json({ message: error.message || "Upload completion failed" });
    }
  });

  app.get("/api/spec-extractor/sessions/:id", async (req: Request, res: Response) => {
    try {
      const [session] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, req.params.id));
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }
      res.json(session);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/spec-extractor/sessions/:id/status", async (req: Request, res: Response) => {
    try {
      const [session] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, req.params.id));
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }
      res.json({
        status: session.status,
        progress: session.progress,
        message: session.message,
      });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/spec-extractor/sessions/:id/sections", async (req: Request, res: Response) => {
    try {
      const sections = await db.select().from(specExtractorSections).where(eq(specExtractorSections.sessionId, req.params.id));
      res.json(sections);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/spec-extractor/sessions/:id/export", async (req: Request, res: Response) => {
    try {
      const [session] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, req.params.id));
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      const selectedIds: string[] | undefined = req.body?.sectionIds;

      let sections;
      if (selectedIds && Array.isArray(selectedIds) && selectedIds.length > 0) {
        sections = await db.select().from(specExtractorSections)
          .where(eq(specExtractorSections.sessionId, req.params.id));
        sections = sections.filter(s => selectedIds.includes(s.id));
      } else {
        sections = await db.select().from(specExtractorSections).where(eq(specExtractorSections.sessionId, req.params.id));
      }

      if (sections.length === 0) {
        return res.status(400).json({ message: "No sections to export" });
      }

      const pdfPath = path.join(DATA_DIR, `${req.params.id}.pdf`);
      if (!fs.existsSync(pdfPath)) {
        return res.status(404).json({ message: "Source PDF not found" });
      }

      const zip = new JSZip();
      const projectName = sanitizeFilename(session.projectName || session.suggestedProjectName || "Project");
      const errors: string[] = [];

      for (const section of sections) {
        try {
          console.log(`[SpecExtractor Export] ${section.sectionNumber} - "${section.title}" pages ${section.startPage}-${section.endPage}`);
          const sectionPdf = await extractSectionPdf(pdfPath, section.startPage, section.endPage);
          if (!sectionPdf || sectionPdf.length === 0) {
            console.warn(`[SpecExtractor Export] Empty PDF for ${section.sectionNumber} (pages ${section.startPage}-${section.endPage})`);
            errors.push(`${section.sectionNumber}: Generated PDF was empty`);
            continue;
          }
          const safeFolderName = truncateAtWord(sanitizeFilename(section.folderName), MAX_FOLDER_NAME_LENGTH);
          const pdfFileName = buildPdfFilename(section.sectionNumber, section.title, projectName);

          const folder = zip.folder(safeFolderName);
          if (folder) {
            folder.file(pdfFileName, sectionPdf);
          } else {
            zip.file(`${safeFolderName}/${pdfFileName}`, sectionPdf);
          }
        } catch (err: any) {
          console.error(`[SpecExtractor Export] Failed to extract ${section.sectionNumber}: ${err.message}`);
          errors.push(`${section.sectionNumber}: ${err.message}`);
        }
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${projectName} - Spec Extract.zip"`);
      if (errors.length > 0) {
        res.setHeader("X-Export-Warnings", JSON.stringify(errors));
      }
      res.send(zipBuffer);
    } catch (error: any) {
      console.error("[SpecExtractor] Export error:", error);
      res.status(500).json({ message: error.message });
    }
  });


  app.get("/api/spec-extractor/sessions/:id/preview/:sectionId", async (req: Request, res: Response) => {
    try {
      const [section] = await db.select().from(specExtractorSections)
        .where(eq(specExtractorSections.id, req.params.sectionId));
      if (!section || section.sessionId !== req.params.id) {
        return res.status(404).json({ message: "Section not found" });
      }

      const pages = await getCachedPages(req.params.id);

      const startPage = Math.max(0, Math.min(section.startPage, pages.length - 1));
      const endPage = Math.max(startPage, Math.min(section.endPage, pages.length - 1));

      const previewPages: { pageNumber: number; text: string }[] = [];
      const maxPreviewPages = Math.min(3, endPage - startPage + 1);

      for (let i = startPage; i < startPage + maxPreviewPages; i++) {
        const rawText = pages[i] || "";
        const trimmed = rawText.slice(0, 1500);
        previewPages.push({
          pageNumber: i + 1,
          text: trimmed + (rawText.length > 1500 ? "\n... (truncated)" : ""),
        });
      }

      res.json({
        sectionNumber: section.sectionNumber,
        title: section.title,
        startPage: section.startPage + 1,
        endPage: section.endPage + 1,
        pageCount: section.pageCount,
        previewPages,
      });
    } catch (error: any) {
      console.error("[SpecExtractor] Preview error:", error);
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/spec-extractor/sessions/:id/ai-review", async (req: Request, res: Response) => {
    try {
      const [session] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, req.params.id));
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return res.status(400).json({ message: "OpenAI API key not configured" });
      }

      const sections = await db.select().from(specExtractorSections).where(eq(specExtractorSections.sessionId, req.params.id));
      if (sections.length === 0) {
        return res.status(400).json({ message: "No sections to review" });
      }

      await runAiReview(req.params.id, session.projectName);

      const updatedSections = await db.select().from(specExtractorSections).where(eq(specExtractorSections.sessionId, req.params.id));
      const reviews = updatedSections.map(s => ({
        id: s.id,
        status: s.aiReviewStatus || "correct",
        suggestedTitle: s.title,
        notes: s.aiReviewNotes || "",
      }));

      res.json({ reviews });
    } catch (error: any) {
      console.error("[SpecExtractor] AI Review error:", error);
      res.status(500).json({ message: error.message || "AI review failed" });
    }
  });

  app.patch("/api/spec-extractor/sections/:sectionId", async (req: Request, res: Response) => {
    try {
      const { title, folderName } = req.body;
      if ((!title || typeof title !== "string") && (!folderName || typeof folderName !== "string")) {
        return res.status(400).json({ message: "Title or folderName is required" });
      }

      const [section] = await db.select().from(specExtractorSections)
        .where(eq(specExtractorSections.id, req.params.sectionId));
      if (!section) {
        return res.status(404).json({ message: "Section not found" });
      }

      const updates: Record<string, any> = {};
      if (title && typeof title === "string") {
        updates.title = title.trim();
      }
      if (folderName && typeof folderName === "string") {
        updates.folderName = folderName.trim();
      }

      await db.update(specExtractorSections)
        .set(updates)
        .where(eq(specExtractorSections.id, req.params.sectionId));

      res.json({ success: true, ...updates });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/spec-extractor/sessions/:id/project-name", async (req: Request, res: Response) => {
    try {
      const { projectName } = req.body;
      if (!projectName || typeof projectName !== "string") {
        return res.status(400).json({ message: "Project name is required" });
      }

      const [session] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, req.params.id));
      if (!session) {
        return res.status(404).json({ message: "Session not found" });
      }

      await db.update(specExtractorSessions)
        .set({ projectName: projectName.trim() })
        .where(eq(specExtractorSessions.id, req.params.id));

      res.json({ success: true, projectName: projectName.trim() });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.get("/api/spec-extractor/accessory-scopes", async (_req: Request, res: Response) => {
    try {
      const config = await getActiveConfiguration();
      const scopes = config.accessoryScopes && config.accessoryScopes.length > 0
        ? config.accessoryScopes
        : ACCESSORY_SCOPES;
      res.json(scopes.map((a: any) => ({
        name: a.name,
        keywords: a.keywords,
        sectionHint: a.sectionHint,
      })));
    } catch (error) {
      res.json(ACCESSORY_SCOPES.map(a => ({
        name: a.name,
        keywords: a.keywords,
        sectionHint: a.sectionHint,
      })));
    }
  });

  app.delete("/api/spec-extractor/sessions/:id", async (req: Request, res: Response) => {
    try {
      await db.delete(specExtractorSections).where(eq(specExtractorSections.sessionId, req.params.id));
      await db.delete(specExtractorSessions).where(eq(specExtractorSessions.id, req.params.id));

      const pdfPath = path.join(DATA_DIR, `${req.params.id}.pdf`);
      if (fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });
}

async function runAiReview(sessionId: string, projectName: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[SpecExtractor] Skipping AI review: no API key configured");
    return;
  }

  const sections = await db.select().from(specExtractorSections).where(eq(specExtractorSections.sessionId, sessionId));
  if (sections.length === 0) return;

  const pages = await getCachedPages(sessionId);

  const sectionSummaries = sections.map(s => {
    const startPage = Math.max(0, Math.min(s.startPage, pages.length - 1));
    const endPage = Math.max(0, Math.min(s.endPage, pages.length - 1));
    const firstPageText = (pages[startPage] || "").slice(0, 1000);
    const lastPageText = startPage !== endPage ? (pages[endPage] || "").slice(0, 500) : "";
    return {
      id: s.id,
      sectionNumber: s.sectionNumber,
      currentTitle: s.title,
      folderName: s.folderName,
      pages: `${s.startPage + 1}-${s.endPage + 1}`,
      firstPageSnippet: firstPageText,
      lastPageSnippet: lastPageText,
    };
  });

  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a construction specification reviewer with expertise in Division 10 (Specialties). You will review extracted specification sections to determine:

1. **Content-to-section match**: This is the MOST IMPORTANT check. Does the actual page content belong to the section number shown? For example, if a section is labeled "10 21 13 - Toilet Compartments" but the page content discusses toilet ACCESSORIES, washroom accessories, soap dispensers, paper towel dispensers, etc., that is a MISMATCH — the content belongs to a different section number (likely 10 28 00). Similarly, if labeled "10 28 00 - Toilet Accessories" but the content discusses toilet partitions/compartments, that's also a mismatch. Look at the actual specification text, the PART headers, product descriptions, and manufacturer information to determine what the content is really about.

2. **Legitimacy check**: Is this actually a Division 10 specification section? A legitimate section should contain specification language (PART 1 - GENERAL, manufacturers, materials, installation requirements). Pages that merely reference a Division 10 number but are actually drawings, schedules, or general conditions are NOT legitimate.

3. **Title accuracy**: Does the title accurately describe the section content?

Respond with a JSON array of objects. Each object must have:
- "id": the section id (string)
- "status": one of "correct" | "suggested_change" | "warning" | "not_div10"
  - Use "correct" if the content matches the section number AND it's a legitimate Division 10 spec section
  - Use "warning" if the content appears to belong to a DIFFERENT section number than what's labeled (content mismatch) — this is critical to flag
  - Use "suggested_change" if it's legitimate but the title should be improved
  - Use "not_div10" if this is NOT actually a Division 10 specification section
- "suggestedTitle": the suggested title based on what the content ACTUALLY covers (not what it's labeled as)
- "notes": brief explanation. If there's a content mismatch, clearly state what section number the content actually belongs to (e.g., "Content is actually section 10 28 00 Toilet Accessories, not 10 21 13 Toilet Compartments")

CRITICAL: Pay close attention to whether the page content matches the assigned section number. A page labeled as "10 21 13 Toilet Compartments" that contains content about soap dispensers, paper towel holders, and restroom accessories is WRONG — that content belongs to "10 28 00 Toilet Accessories". Flag these mismatches prominently.`,
      },
      {
        role: "user",
        content: `Project: "${projectName}"\n\nReview these extracted sections and verify each is a legitimate Division 10 specification section:\n\n${JSON.stringify(sectionSummaries, null, 2)}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  });

  const content = response.choices[0]?.message?.content || "[]";
  let reviews: { id: string; status: string; suggestedTitle: string; notes: string }[];
  try {
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Expected array");
    reviews = parsed
      .filter((r: any) => r && typeof r === "object" && r.id && r.status)
      .map((r: any) => ({
        id: String(r.id),
        status: ["correct", "suggested_change", "warning", "not_div10"].includes(r.status) ? r.status : "correct",
        suggestedTitle: String(r.suggestedTitle || r.currentTitle || ""),
        notes: String(r.notes || ""),
      }));
  } catch (parseErr) {
    console.error("[SpecExtractor] Failed to parse AI response:", content);
    reviews = sections.map(s => ({
      id: s.id,
      status: "correct",
      suggestedTitle: s.title,
      notes: "AI review could not parse response - manual review recommended",
    }));
  }

  return applyAiReviews(reviews);
}

async function applyAiReviews(reviews: { id: string; status: string; suggestedTitle: string; notes: string }[]): Promise<void> {
  for (const review of reviews) {
    const [section] = await db.select().from(specExtractorSections).where(eq(specExtractorSections.id, review.id));
    if (!section) continue;

    const updates: Record<string, any> = {
      aiReviewStatus: review.status,
      aiReviewNotes: review.notes,
      originalTitle: section.originalTitle || section.title,
    };

    if (review.status === "suggested_change" && review.suggestedTitle && review.suggestedTitle !== section.title) {
      updates.title = review.suggestedTitle.trim();
      updates.folderName = buildFolderName(section.sectionNumber, review.suggestedTitle.trim());
    }

    await db.update(specExtractorSections)
      .set(updates)
      .where(eq(specExtractorSections.id, review.id));
  }
}

async function runAiPageValidation(sessionId: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[SpecExtractor] Skipping AI page validation: no API key configured");
    return;
  }

  const sections = await db.select().from(specExtractorSections).where(eq(specExtractorSections.sessionId, sessionId));
  if (sections.length === 0) return;

  const pages = await getCachedPages(sessionId);

  const validationData = sections.map(s => {
    const startPage = Math.max(0, Math.min(s.startPage, pages.length - 1));
    const firstPageText = (pages[startPage] || "").slice(0, 1200);
    const topLines = (pages[startPage] || "").split(/[\n\r]+/).slice(0, 15).join("\n");
    return {
      id: s.id,
      sectionNumber: s.sectionNumber,
      title: s.title,
      startPage: s.startPage + 1,
      endPage: s.endPage + 1,
      topLines,
      firstPageText,
    };
  });

  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a construction specification page validator. For each extracted section, check if the page content ACTUALLY belongs to that section number.

Your job: Look at the first page content and determine if it matches the assigned section number. Section numbers follow CSI MasterFormat (e.g., 10 21 13 = Toilet Compartments, 10 28 00 = Toilet Accessories).

CRITICAL RULE: If the page contains an explicit "SECTION XX XX XX" header (with or without decimal subsections like "10 21 13.17"), that is AUTHORITATIVE. The section header on the page is always correct. Do NOT override it based on your interpretation of the content topic. For example, if the page says "SECTION 10 21 13.17 PHENOLIC TOILET COMPARTMENTS", then the section IS 10 21 13 — do NOT change it to something else like 10 28 00.

For each section, determine:
1. Does the page contain an explicit "SECTION XX XX XX" header? If yes, that header is authoritative — mark as match=true.
2. If no explicit header, does the content topic match the section number's expected topic?
3. If mismatched (and no explicit header), what section number does the content ACTUALLY belong to?

Respond with a JSON array. Each object:
- "id": section id
- "match": true if content matches the section number, false if mismatched
- "actualSection": if mismatched, the section number that the content actually belongs to (e.g., "10 28 00"). If matched, same as the assigned section.
- "actualTitle": if mismatched, the correct title for the content. If matched, same as assigned title.
- "confidence": "high" or "medium" - how confident you are in the assessment
- "reason": brief explanation

Only flag mismatches when you are confident AND the page does NOT contain an explicit SECTION header matching the assigned number. If uncertain, mark as match=true.`,
      },
      {
        role: "user",
        content: `Validate these extracted specification sections. Check if each section's page content matches its assigned section number:\n\n${JSON.stringify(validationData, null, 2)}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 3000,
  });

  const content = response.choices[0]?.message?.content || "[]";
  let validations: { id: string; match: boolean; actualSection: string; actualTitle: string; confidence: string; reason: string }[];
  try {
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error("Expected array");
    validations = parsed.filter((v: any) => v && typeof v === "object" && v.id);
  } catch (parseErr) {
    console.error("[SpecExtractor] Failed to parse AI page validation response:", content);
    return;
  }

  let correctionCount = 0;
  for (const v of validations) {
    if (v.match === false && v.confidence === "high" && v.actualSection) {
      const [section] = await db.select().from(specExtractorSections).where(eq(specExtractorSections.id, v.id));
      if (!section) continue;

      const startPage = Math.max(0, Math.min(section.startPage, pages.length - 1));
      const pageText = (pages[startPage] || "").slice(0, 1500);
      const sectionDigits = section.sectionNumber.replace(/\s/g, "");
      const pairs = sectionDigits.match(/.{2}/g) || [];
      const explicitHeaderPattern = new RegExp(
        `SECTION\\s+${pairs.join("[\\s\\._-]*")}`,
        "i"
      );
      if (explicitHeaderPattern.test(pageText)) {
        console.log(`[SpecExtractor] AI wanted to change ${section.sectionNumber} -> ${v.actualSection}, but page has explicit SECTION header — keeping original`);
        continue;
      }

      console.log(`[SpecExtractor] AI correction: ${section.sectionNumber} -> ${v.actualSection} (${v.reason})`);

      const newTitle = v.actualTitle || section.title;
      const compactSection = v.actualSection.replace(/\s+/g, "");
      const newFolderName = `${compactSection} - ${newTitle}`;

      const isNowNonDiv10 = !v.actualSection.startsWith("10 ");
      await db.update(specExtractorSections)
        .set({
          sectionNumber: v.actualSection,
          title: newTitle,
          folderName: newFolderName,
          originalTitle: section.title,
          aiReviewNotes: `Auto-corrected from ${section.sectionNumber} to ${v.actualSection}: ${v.reason}`,
          ...(isNowNonDiv10 ? { aiReviewStatus: "not_div10" } : {}),
        })
        .where(eq(specExtractorSections.id, v.id));
      correctionCount++;
    }
  }

  if (correctionCount > 0) {
    console.log(`[SpecExtractor] AI page validation corrected ${correctionCount} section(s) for session ${sessionId}`);
  }
}

async function suggestProjectName(sessionId: string): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log("[SpecExtractor] Skipping project name suggestion: no API key configured");
    return;
  }

  const pages = await getCachedPages(sessionId);
  const sampleText = pages.slice(0, Math.min(5, pages.length)).map((p, i) => `--- Page ${i + 1} ---\n${p.slice(0, 1200)}`).join("\n\n");

  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are an expert at reading construction specification documents. Your task is to identify the project name from the spec document text. Look for:
1. The project title on the cover page or title page
2. Project name in headers/footers
3. Building or facility name references

Respond with ONLY a JSON object: {"projectName": "The Project Name"}
If you cannot determine a project name, respond: {"projectName": null}
Be concise - just the project name without extra descriptions like "for" or "at".`,
      },
      {
        role: "user",
        content: `Extract the project name from this construction specification document:\n\n${sampleText}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 200,
  });

  const content = response.choices[0]?.message?.content || "{}";
  try {
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.projectName && typeof parsed.projectName === "string") {
      await db.update(specExtractorSessions)
        .set({ suggestedProjectName: parsed.projectName.trim() })
        .where(eq(specExtractorSessions.id, sessionId));
      console.log(`[SpecExtractor] Suggested project name for ${sessionId}: "${parsed.projectName.trim()}"`);
    }
  } catch (parseErr) {
    console.error("[SpecExtractor] Failed to parse project name response:", content);
  }
}

async function processInBackground(sessionId: string, pdfBuffer: Buffer, tocHintsRaw?: string) {
  try {
    let tocHints: TOCHint[] | undefined;
    if (tocHintsRaw) {
      tocHints = parseTocHints(tocHintsRaw);
      if (tocHints.length > 0) {
        console.log(`[SpecExtractor] Parsed ${tocHints.length} TOC hints: ${tocHints.map(h => h.section).join(", ")}`);
      }
    }

    const result = await runExtraction(pdfBuffer, async (progress, message) => {
      await db.update(specExtractorSessions)
        .set({ progress, message })
        .where(eq(specExtractorSessions.id, sessionId));
    }, tocHints);

    const [session] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, sessionId));
    const projectName = session?.projectName || "Project";
    const selectedAccessories = (session?.selectedAccessories as string[]) || [];

    for (const section of result.sections) {
      const signage = isSignageSection(section.section);
      await db.insert(specExtractorSections).values({
        id: generateId(),
        sessionId,
        sectionNumber: section.section,
        title: section.title,
        startPage: section.start,
        endPage: section.end,
        pageCount: section.end - section.start + 1,
        folderName: section.folderName,
        sectionType: "div10",
        isSignage: signage,
      });
    }

    if (selectedAccessories.length > 0) {
      await db.update(specExtractorSessions)
        .set({ progress: 80, message: "Scanning for accessory sections..." })
        .where(eq(specExtractorSessions.id, sessionId));

      const pages = await extractPages(pdfBuffer);
      let configScopes: AccessoryScope[] | undefined;
      try {
        const config = await getActiveConfiguration();
        if (config.accessoryScopes && config.accessoryScopes.length > 0) {
          configScopes = config.accessoryScopes.map((s: any) => ({
            name: s.name,
            keywords: Array.isArray(s.keywords) ? s.keywords : [],
            sectionHint: s.sectionHint || "",
            divisionScope: Array.isArray(s.divisionScope) ? s.divisionScope : [],
          }));
        }
      } catch (e) {
        console.log("[SpecExtractor] Could not load config scopes, using defaults");
      }
      const accessoryMatches = findAccessorySections(pages, selectedAccessories, result.tocBounds, result.sections, configScopes);

      for (const match of accessoryMatches) {
        await db.insert(specExtractorSections).values({
          id: generateId(),
          sessionId,
          sectionNumber: match.sectionNumber,
          title: match.title,
          startPage: match.start,
          endPage: match.end,
          pageCount: match.end - match.start + 1,
          folderName: match.folderName,
          sectionType: "accessory",
          isSignage: false,
          matchedKeywords: match.matchedKeywords,
        });
      }

      console.log(`[SpecExtractor] Found ${accessoryMatches.length} accessory matches for session ${sessionId}`);
    }

    await db.update(specExtractorSessions)
      .set({
        status: "reviewing",
        progress: 90,
        message: `Found ${result.sections.length} sections — validating page content...`,
        totalPages: result.totalPages,
        tocStart: result.tocBounds.start >= 0 ? result.tocBounds.start : null,
        tocEnd: result.tocBounds.end >= 0 ? result.tocBounds.end : null,
      })
      .where(eq(specExtractorSessions.id, sessionId));

    try {
      await runAiPageValidation(sessionId);
      console.log(`[SpecExtractor] AI page validation completed for session ${sessionId}`);
    } catch (valErr: any) {
      console.error(`[SpecExtractor] AI page validation failed for ${sessionId}:`, valErr.message);
    }

    await db.update(specExtractorSessions)
      .set({
        progress: 95,
        message: `Running AI review...`,
      })
      .where(eq(specExtractorSessions.id, sessionId));

    try {
      await runAiReview(sessionId, projectName);
      console.log(`[SpecExtractor] AI review completed for session ${sessionId}`);
    } catch (aiErr: any) {
      console.error(`[SpecExtractor] AI review failed for ${sessionId}:`, aiErr.message);
    }

    try {
      await suggestProjectName(sessionId);
    } catch (nameErr: any) {
      console.error(`[SpecExtractor] Project name suggestion failed for ${sessionId}:`, nameErr.message);
    }

    const [updatedSession] = await db.select().from(specExtractorSessions).where(eq(specExtractorSessions.id, sessionId));
    const suggestedName = updatedSession?.suggestedProjectName;
    if (suggestedName && !updatedSession?.projectName) {
      await db.update(specExtractorSessions)
        .set({ projectName: suggestedName })
        .where(eq(specExtractorSessions.id, sessionId));
    }

    await db.update(specExtractorSessions)
      .set({
        status: "complete",
        progress: 100,
        message: `Found ${result.sections.length} Division 10 sections`,
      })
      .where(eq(specExtractorSessions.id, sessionId));

    console.log(`[SpecExtractor] Completed session ${sessionId}: ${result.sections.length} sections`);
  } catch (error: any) {
    console.error(`[SpecExtractor] Processing error for ${sessionId}:`, error);
    await db.update(specExtractorSessions)
      .set({
        status: "error",
        progress: 0,
        message: error.message || "Processing failed",
      })
      .where(eq(specExtractorSessions.id, sessionId));
  }
}
