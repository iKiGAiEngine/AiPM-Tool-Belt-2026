import type { Express, Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { randomUUID } from "crypto";
import { db } from "../db";
import { eq, desc } from "drizzle-orm";
import {
  bidDocsRuns,
  bidDocsFiles,
  proposalLogEntries,
  bcSyncLog,
  users,
} from "@shared/schema";
import { UPLOAD_CHUNK_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@shared/uploadLimits";
import { requireAdmin } from "../authRoutes";
import { getActiveScopeDictionaries, getProjectById } from "../scopeDictionaryStorage";
import { planParserStorage } from "../planparser/storage";
import { classifyBidDocFile } from "./fileClassifier";
import {
  createRun,
  getRun,
  updateRun,
  getRunFiles,
  getRunSourceDir,
  startProcessing,
  finalizeRun,
  effectiveClass,
  BID_DOCS_DIR,
} from "./orchestrator";
import { recordPageCorrection, getSuggestions, acceptSuggestion, dismissSuggestion } from "./learning";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 25 },
});

const uploadChunk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_CHUNK_BYTES + 1024 * 1024 },
});

interface PendingUpload {
  runId: string;
  filename: string;
  totalChunks: number;
  dir: string;
  createdAt: number;
}
const pendingUploads = new Map<string, PendingUpload>();
const UPLOAD_TMP_DIR = path.join(BID_DOCS_DIR, "_upload_tmp");
const PENDING_TTL_MS = 30 * 60 * 1000;

function cleanupStalePending(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, info] of Array.from(pendingUploads.entries())) {
    if (info.createdAt < cutoff) {
      try { fs.rmSync(info.dir, { recursive: true, force: true }); } catch {}
      pendingUploads.delete(id);
    }
  }
}

async function requireUser(req: Request, res: Response): Promise<{ id: number; name: string } | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ message: "Not authenticated" });
    return null;
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    res.status(401).json({ message: "Not authenticated" });
    return null;
  }
  return { id: user.id, name: user.displayName || user.email };
}

function parseScopeList(scopeList: string | null | undefined): string[] {
  if (!scopeList) return [];
  return scopeList
    .split(/[,;\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Ingest one uploaded file into a run: ZIPs are exploded into their member
 * PDFs, every stored file gets classified (plan/spec/other) and an inventory
 * row. Returns the number of files added.
 */
async function ingestFileIntoRun(runId: string, filename: string, buffer: Buffer): Promise<number> {
  const sourceDir = getRunSourceDir(runId);
  fs.mkdirSync(sourceDir, { recursive: true });

  const entries: Array<{ name: string; relativePath: string; buffer: Buffer }> = [];

  if (/\.zip$/i.test(filename)) {
    const zip = await JSZip.loadAsync(buffer);
    for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;
      const base = path.basename(relativePath);
      if (base.startsWith(".") || base.startsWith("__MACOSX")) continue;
      if (relativePath.includes("__MACOSX")) continue;
      const content = await zipEntry.async("nodebuffer");
      entries.push({ name: base, relativePath, buffer: content });
    }
  } else {
    entries.push({ name: filename, relativePath: filename, buffer });
  }

  let added = 0;
  for (const entry of entries) {
    // Flatten zip paths into safe unique filenames on disk
    const safeRel = entry.relativePath.replace(/[^a-zA-Z0-9._\/-]/g, "_").replace(/\//g, "__");
    const diskPath = path.join(sourceDir, safeRel);
    fs.writeFileSync(diskPath, entry.buffer);

    const result = await classifyBidDocFile(entry.name, entry.buffer);
    await db.insert(bidDocsFiles).values({
      runId,
      filename: entry.name,
      relativePath: safeRel,
      sizeBytes: entry.buffer.length,
      pageCount: result.pageCount,
      classification: result.classification,
      classificationConfidence: result.confidence,
      classificationReason: result.reason,
      selected: result.classification === "plan",
      sheetNumbersSample: result.sheetNumbersSample,
    });
    added++;
  }
  return added;
}

export function registerBidDocsRoutes(app: Express): void {

  // ── Context: everything needed to start a run for an Estimating project ──
  app.get("/api/bid-docs/context/:entryId", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const entryId = parseInt(req.params.entryId);
      if (isNaN(entryId)) return res.status(400).json({ message: "Invalid entry ID" });

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, entryId));
      if (!entry) return res.status(404).json({ message: "Proposal log entry not found" });

      const [bcLink] = await db.select().from(bcSyncLog).where(eq(bcSyncLog.entryId, entryId));

      let project: { id: number; folderPath: string | null; folderExists: boolean } | null = null;
      if (entry.projectDbId) {
        const p = await getProjectById(entry.projectDbId);
        if (p) {
          project = {
            id: p.id,
            folderPath: p.folderPath,
            folderExists: !!p.folderPath && fs.existsSync(p.folderPath),
          };
        }
      }

      const dictionaries = await getActiveScopeDictionaries();
      const neededScopes = parseScopeList(entry.scopeList);

      res.json({
        entry: {
          id: entry.id,
          projectName: entry.projectName,
          estimateNumber: entry.estimateNumber,
          estimateStatus: entry.estimateStatus,
          region: entry.region,
          dueDate: entry.dueDate,
          projectAddress: entry.projectAddress,
          scopeList: neededScopes,
        },
        buildingConnected: bcLink
          ? {
              opportunityId: bcLink.bcOpportunityId,
              filesUrl: `https://app.buildingconnected.com/opportunities/${bcLink.bcOpportunityId}`,
            }
          : null,
        project,
        availableScopes: dictionaries.map(d => ({
          name: d.scopeName,
          preChecked: neededScopes.some(s =>
            s.toLowerCase().includes(d.scopeName.toLowerCase()) ||
            d.scopeName.toLowerCase().includes(s.toLowerCase()),
          ),
        })),
      });
    } catch (err) {
      console.error("[BidDocs] Context error:", err);
      res.status(500).json({ message: "Failed to load project context" });
    }
  });

  // ── Runs ──
  app.post("/api/bid-docs/runs", async (req: Request, res: Response) => {
    try {
      const user = await requireUser(req, res);
      if (!user) return;

      const { proposalLogEntryId } = req.body || {};
      let projectDbId: number | null = null;

      if (proposalLogEntryId) {
        const [entry] = await db.select().from(proposalLogEntries)
          .where(eq(proposalLogEntries.id, parseInt(proposalLogEntryId)));
        if (!entry) return res.status(404).json({ message: "Proposal log entry not found" });
        projectDbId = entry.projectDbId ?? null;
      }

      const run = await createRun({
        proposalLogEntryId: proposalLogEntryId ? parseInt(proposalLogEntryId) : null,
        projectDbId,
        createdBy: user.name,
      });
      res.json(run);
    } catch (err) {
      console.error("[BidDocs] Create run error:", err);
      res.status(500).json({ message: "Failed to create run" });
    }
  });

  app.get("/api/bid-docs/runs", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const runs = await db.select().from(bidDocsRuns).orderBy(desc(bidDocsRuns.createdAt)).limit(50);
      res.json(runs);
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch runs" });
    }
  });

  app.get("/api/bid-docs/runs/:id", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const run = await getRun(req.params.id);
      if (!run) return res.status(404).json({ message: "Run not found" });

      const files = await getRunFiles(run.id);
      let jobSummary = null;
      if (run.planparserJobId) {
        const job = await planParserStorage.getJob(run.planparserJobId);
        if (job) {
          jobSummary = {
            id: job.id,
            status: job.status,
            totalPages: job.totalPages,
            processedPages: job.processedPages,
            flaggedPages: job.flaggedPages,
            scopeCounts: job.scopeCounts,
            message: job.message,
          };
        }
      }
      res.json({ ...run, files, planParserJob: jobSummary });
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch run" });
    }
  });

  // ── Intake: direct upload (small files / loose PDFs) ──
  app.post("/api/bid-docs/runs/:id/upload", (req, res, next) => {
    upload.array("files", 25)(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ message: "File too large for direct upload — large files are sent in chunks automatically. Please retry." });
        }
        return res.status(400).json({ message: err.message || "Upload error" });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const run = await getRun(req.params.id);
      if (!run) return res.status(404).json({ message: "Run not found" });
      if (!["intake", "inventoried", "selecting"].includes(run.status)) {
        return res.status(400).json({ message: "Run has already started processing" });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) return res.status(400).json({ message: "No files uploaded" });

      let added = 0;
      for (const f of files) {
        added += await ingestFileIntoRun(run.id, f.originalname, f.buffer);
      }

      await updateRun(run.id, {
        status: "inventoried",
        message: `${added} file(s) inventoried — confirm which to process.`,
      });
      res.json({ added, files: await getRunFiles(run.id) });
    } catch (err) {
      console.error("[BidDocs] Upload error:", err);
      res.status(500).json({ message: "Upload failed" });
    }
  });

  // ── Intake: chunked upload for BC ZIPs over the ~32 MiB ingress cap ──
  app.post("/api/bid-docs/runs/:id/upload/init", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      cleanupStalePending();

      const run = await getRun(req.params.id);
      if (!run) return res.status(404).json({ message: "Run not found" });

      const filename = (req.body.filename as string)?.trim() || "upload.zip";
      const totalChunks = parseInt(String(req.body.totalChunks), 10);
      const totalSize = parseInt(String(req.body.totalSize), 10);
      if (!Number.isFinite(totalChunks) || totalChunks < 1) {
        return res.status(400).json({ message: "Invalid totalChunks" });
      }
      if (Number.isFinite(totalSize) && totalSize > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ message: `File is too large. Maximum size is ${MAX_UPLOAD_LABEL}.` });
      }

      const uploadId = randomUUID();
      const dir = path.join(UPLOAD_TMP_DIR, uploadId);
      fs.mkdirSync(dir, { recursive: true });
      pendingUploads.set(uploadId, { runId: run.id, filename, totalChunks, dir, createdAt: Date.now() });

      res.json({ uploadId, chunkSize: UPLOAD_CHUNK_BYTES });
    } catch (err: any) {
      console.error("[BidDocs] Chunked init error:", err);
      res.status(500).json({ message: err.message || "Upload init failed" });
    }
  });

  app.post("/api/bid-docs/upload/chunk", (req, res, next) => {
    uploadChunk.single("chunk")(req, res, (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: "Chunk is too large." });
        return res.status(400).json({ message: err.message || "Chunk upload error" });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    try {
      const uploadId = (req.body.uploadId as string)?.trim();
      const chunkIndex = parseInt(String(req.body.chunkIndex), 10);
      const info = uploadId ? pendingUploads.get(uploadId) : undefined;
      if (!info) return res.status(404).json({ message: "Upload session not found or expired. Please start again." });
      if (!req.file) return res.status(400).json({ message: "No chunk received" });
      if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || chunkIndex >= info.totalChunks) {
        return res.status(400).json({ message: "Invalid chunkIndex" });
      }
      fs.writeFileSync(path.join(info.dir, `chunk_${chunkIndex}`), req.file.buffer);
      res.json({ received: chunkIndex });
    } catch (err: any) {
      console.error("[BidDocs] Chunk error:", err);
      res.status(500).json({ message: err.message || "Chunk upload failed" });
    }
  });

  app.post("/api/bid-docs/upload/complete", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const uploadId = (req.body.uploadId as string)?.trim();
      const info = uploadId ? pendingUploads.get(uploadId) : undefined;
      if (!info) return res.status(404).json({ message: "Upload session not found or expired. Please start again." });

      const parts: Buffer[] = [];
      for (let i = 0; i < info.totalChunks; i++) {
        const p = path.join(info.dir, `chunk_${i}`);
        if (!fs.existsSync(p)) {
          return res.status(400).json({ message: `Missing chunk ${i} — please retry the upload.` });
        }
        parts.push(fs.readFileSync(p));
      }
      const buffer = Buffer.concat(parts);
      fs.rmSync(info.dir, { recursive: true, force: true });
      pendingUploads.delete(uploadId!);

      const added = await ingestFileIntoRun(info.runId, info.filename, buffer);
      await updateRun(info.runId, {
        status: "inventoried",
        message: `${added} file(s) inventoried — confirm which to process.`,
      });
      res.json({ added, files: await getRunFiles(info.runId) });
    } catch (err: any) {
      console.error("[BidDocs] Chunked complete error:", err);
      res.status(500).json({ message: err.message || "Upload completion failed" });
    }
  });

  // ── Inventory: re-badge / select files ──
  app.patch("/api/bid-docs/files/:fileId", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const fileId = parseInt(req.params.fileId);
      if (isNaN(fileId)) return res.status(400).json({ message: "Invalid file ID" });

      const { userClassification, selected } = req.body || {};
      const updateData: Record<string, unknown> = {};
      if (userClassification !== undefined) {
        if (userClassification !== null && !["plan", "spec", "other"].includes(userClassification)) {
          return res.status(400).json({ message: "Invalid classification" });
        }
        updateData.userClassification = userClassification;
      }
      if (typeof selected === "boolean") updateData.selected = selected;
      if (Object.keys(updateData).length === 0) return res.status(400).json({ message: "Nothing to update" });

      const [file] = await db.update(bidDocsFiles).set(updateData).where(eq(bidDocsFiles.id, fileId)).returning();
      if (!file) return res.status(404).json({ message: "File not found" });
      res.json(file);
    } catch (err) {
      res.status(500).json({ message: "Failed to update file" });
    }
  });

  // ── Start processing ──
  app.post("/api/bid-docs/runs/:id/start", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const run = await getRun(req.params.id);
      if (!run) return res.status(404).json({ message: "Run not found" });
      if (!["inventoried", "selecting", "error"].includes(run.status)) {
        return res.status(409).json({ message: `Run is ${run.status} — cannot start now` });
      }

      const files = await getRunFiles(run.id);
      const selectedPlans = files.filter(f => f.selected && effectiveClass(f) === "plan");
      if (selectedPlans.length === 0) {
        return res.status(400).json({ message: "Select at least one plan file first" });
      }

      const selectedScopes: string[] = Array.isArray(req.body?.selectedScopes) ? req.body.selectedScopes : [];
      await updateRun(run.id, { selectedScopes, error: null });

      res.json({ message: "Processing started", runId: run.id });

      startProcessing(run.id).catch(err => {
        console.error(`[BidDocs] Background processing crashed for ${run.id}:`, err);
      });
    } catch (err) {
      console.error("[BidDocs] Start error:", err);
      res.status(500).json({ message: "Failed to start processing" });
    }
  });

  // ── Review: page toggles with learning capture ──
  app.patch("/api/bid-docs/pages/:pageId", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const { pageId } = req.params;
      const { isRelevant, tags } = req.body || {};

      const before = await planParserStorage.getPage(pageId);
      if (!before) return res.status(404).json({ message: "Page not found" });

      const updates: Record<string, unknown> = { userModified: true };
      if (typeof isRelevant === "boolean") updates.isRelevant = isRelevant;
      if (Array.isArray(tags)) updates.tags = tags;

      const page = await planParserStorage.updatePage(pageId, updates);
      if (!page) return res.status(404).json({ message: "Page not found" });

      // Learning capture: page pulled in or thrown out by the human pass
      if (typeof isRelevant === "boolean" && isRelevant !== before.isRelevant) {
        const scopes = (Array.isArray(tags) && tags.length > 0 ? tags : before.tags) as string[];
        recordPageCorrection(pageId, isRelevant ? "added" : "removed", scopes).catch(() => {});
      }

      // Keep the job counters fresh (same bookkeeping as the planparser route)
      const allPages = await planParserStorage.getPagesByJob(page.jobId);
      const scopeCounts: Record<string, number> = {};
      let flaggedCount = 0;
      for (const p of allPages) {
        if (p.isRelevant) {
          flaggedCount++;
          for (const tag of p.tags) scopeCounts[tag] = (scopeCounts[tag] || 0) + 1;
        }
      }
      await planParserStorage.updateJob(page.jobId, { flaggedPages: flaggedCount, scopeCounts });

      res.json(page);
    } catch (err) {
      res.status(500).json({ message: "Failed to update page" });
    }
  });

  // ── Finalize: outputs + report ──
  app.post("/api/bid-docs/runs/:id/finalize", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const run = await getRun(req.params.id);
      if (!run) return res.status(404).json({ message: "Run not found" });
      if (!["review", "complete", "error"].includes(run.status)) {
        return res.status(409).json({ message: `Run is ${run.status} — finish processing first` });
      }

      const includeHighlights = req.body?.includeHighlights !== false;

      let projectFolderPath: string | null = null;
      let projectName = "Project";
      const projectMeta: Record<string, string | null | undefined> = {};

      if (run.proposalLogEntryId) {
        const [entry] = await db.select().from(proposalLogEntries)
          .where(eq(proposalLogEntries.id, run.proposalLogEntryId));
        if (entry) {
          projectName = entry.projectName || projectName;
          projectMeta["Estimate #"] = entry.estimateNumber;
          projectMeta["Region"] = entry.region;
          projectMeta["Due Date"] = entry.dueDate;
          projectMeta["Address"] = entry.projectAddress;
          projectMeta["Status"] = entry.estimateStatus;
        }
      }
      if (run.projectDbId) {
        const project = await getProjectById(run.projectDbId);
        if (project?.folderPath && fs.existsSync(project.folderPath)) {
          projectFolderPath = project.folderPath;
        }
      }

      res.json({ message: "Finalizing", runId: run.id });

      finalizeRun(run.id, { includeHighlights, projectFolderPath, projectName, projectMeta })
        .catch(err => console.error(`[BidDocs] Finalize crashed for ${run.id}:`, err));
    } catch (err) {
      console.error("[BidDocs] Finalize error:", err);
      res.status(500).json({ message: "Failed to finalize run" });
    }
  });

  // ── Download the run's outputs as a ZIP ──
  app.get("/api/bid-docs/runs/:id/download", async (req: Request, res: Response) => {
    try {
      if (!(await requireUser(req, res))) return;
      const run = await getRun(req.params.id);
      if (!run) return res.status(404).json({ message: "Run not found" });

      const outputDir = path.join(BID_DOCS_DIR, run.id, "output");
      if (!fs.existsSync(outputDir)) {
        return res.status(400).json({ message: "No outputs yet — finalize the run first" });
      }

      const zip = new JSZip();
      const addDir = (dir: string, zipPath: string) => {
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (fs.statSync(full).isDirectory()) {
            addDir(full, `${zipPath}${entry}/`);
          } else {
            zip.file(`${zipPath}${entry}`, fs.readFileSync(full));
          }
        }
      };
      addDir(outputDir, "");

      const buffer = await zip.generateAsync({ type: "nodebuffer" });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="BidDocs_${run.id.slice(0, 8)}_Outputs.zip"`);
      res.send(buffer);
    } catch (err) {
      console.error("[BidDocs] Download error:", err);
      res.status(500).json({ message: "Failed to build download" });
    }
  });

  // ── Learning suggestions (admin) ──
  app.get("/api/bid-docs/learning/suggestions", requireAdmin, async (req: Request, res: Response) => {
    try {
      res.json(await getSuggestions());
    } catch (err) {
      res.status(500).json({ message: "Failed to fetch suggestions" });
    }
  });

  app.post("/api/bid-docs/learning/:id/accept", requireAdmin, async (req: Request, res: Response) => {
    try {
      const ok = await acceptSuggestion(parseInt(req.params.id));
      if (!ok) return res.status(404).json({ message: "Suggestion not found or already handled" });
      res.json({ accepted: true });
    } catch (err) {
      res.status(500).json({ message: "Failed to accept suggestion" });
    }
  });

  app.post("/api/bid-docs/learning/:id/dismiss", requireAdmin, async (req: Request, res: Response) => {
    try {
      const ok = await dismissSuggestion(parseInt(req.params.id));
      if (!ok) return res.status(404).json({ message: "Suggestion not found or already handled" });
      res.json({ dismissed: true });
    } catch (err) {
      res.status(500).json({ message: "Failed to dismiss suggestion" });
    }
  });
}
