import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  bidDocsRuns,
  bidDocsFiles,
  type BidDocsRun,
  type BidDocsFile,
  type BidDocsRunStatus,
  type ScopeMaterialDetails,
} from "@shared/schema";
import { planParserStorage } from "../planparser/storage";
import { processJob, reprocessJobWithSpecBoost } from "../planparser/pdfProcessor";
import type { SpecBoostData } from "../planparser/classificationConfig";
import { storage } from "../storage";
import { runExtraction, extractPages, extractSectionPdf, type SectionRange } from "../specExtractorEngine";
import { updateProject } from "../scopeDictionaryStorage";
import { runCalloutPass } from "./calloutHarvester";
import { applyHighlights } from "./highlighter";
import { extractScopeMaterialDetails, type SpecSectionInput } from "./detailExtractor";
import { buildScopeShortOrderWorkbook } from "./reportBuilder";

export const BID_DOCS_DIR = path.join(process.cwd(), "data", "bid-docs");
const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // source files kept a week

// ---------------------------------------------------------------------------
// Run / file store (thin drizzle wrappers)
// ---------------------------------------------------------------------------

export async function createRun(data: {
  proposalLogEntryId?: number | null;
  projectDbId?: number | null;
  createdBy?: string;
}): Promise<BidDocsRun> {
  const id = randomUUID();
  const [run] = await db.insert(bidDocsRuns).values({
    id,
    proposalLogEntryId: data.proposalLogEntryId ?? null,
    projectDbId: data.projectDbId ?? null,
    status: "intake",
    message: "Run created — drop the BuildingConnected file set to begin.",
    createdBy: data.createdBy,
  }).returning();
  fs.mkdirSync(path.join(BID_DOCS_DIR, id, "source"), { recursive: true });
  return run;
}

export async function getRun(id: string): Promise<BidDocsRun | undefined> {
  const [run] = await db.select().from(bidDocsRuns).where(eq(bidDocsRuns.id, id));
  return run;
}

export async function updateRun(id: string, data: Partial<BidDocsRun>): Promise<BidDocsRun | undefined> {
  const [run] = await db.update(bidDocsRuns)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(bidDocsRuns.id, id))
    .returning();
  return run;
}

export async function getRunFiles(runId: string): Promise<BidDocsFile[]> {
  return db.select().from(bidDocsFiles).where(eq(bidDocsFiles.runId, runId));
}

export function getRunSourceDir(runId: string): string {
  return path.join(BID_DOCS_DIR, runId, "source");
}

export function effectiveClass(file: BidDocsFile): string {
  return file.userClassification || file.classification;
}

async function setStatus(runId: string, status: BidDocsRunStatus, message: string): Promise<void> {
  await updateRun(runId, { status, message });
  console.log(`[BidDocs] Run ${runId}: ${status} — ${message}`);
}

// ---------------------------------------------------------------------------
// Processing pipeline
// ---------------------------------------------------------------------------

const activeRuns = new Set<string>();

/**
 * Background pipeline: selected plans → Plan Parser baseline; selected specs
 * → Spec Extractor; AI details from spec sections → spec-boost re-score;
 * schedule callout expansion; then park in "review" for the human pass.
 */
export async function startProcessing(runId: string): Promise<void> {
  if (activeRuns.has(runId)) {
    throw new Error("Run is already processing");
  }
  activeRuns.add(runId);
  try {
    await processRun(runId);
  } finally {
    activeRuns.delete(runId);
  }
}

async function processRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const files = await getRunFiles(runId);
  const sourceDir = getRunSourceDir(runId);
  const planFiles = files.filter(f => f.selected && effectiveClass(f) === "plan");
  const specFiles = files.filter(f => f.selected && effectiveClass(f) === "spec");

  if (planFiles.length === 0) {
    await updateRun(runId, { status: "error", error: "No plan files selected", message: "Select at least one plan file to process." });
    return;
  }

  try {
    // --- 1. Plan Parser baseline --------------------------------------
    await setStatus(runId, "processing_plans", `Parsing ${planFiles.length} plan file(s)...`);

    const planJob = await planParserStorage.createJob({
      status: "pending",
      totalPages: 0,
      processedPages: 0,
      flaggedPages: 0,
      filenames: planFiles.map(f => f.filename),
      message: "Queued by Bid Docs Intake",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + RUN_TTL_MS).toISOString(),
      scopeCounts: {},
    });
    await updateRun(runId, { planparserJobId: planJob.id });

    if (run.projectDbId) {
      try {
        await updateProject(run.projectDbId, { planparserJobId: planJob.id, status: "planparser_baseline_running" });
      } catch (err) {
        console.warn(`[BidDocs] Could not link plan job to project ${run.projectDbId}:`, err);
      }
    }

    // Keep the source PDFs in the job dir too so the existing Plan Parser
    // export endpoint keeps working for this job.
    const jobDir = await planParserStorage.ensureJobDirectory(planJob.id);
    const jobPdfsDir = path.join(jobDir, "pdfs");
    fs.mkdirSync(jobPdfsDir, { recursive: true });

    const planBuffers: { filename: string; buffer: Buffer }[] = [];
    for (const f of planFiles) {
      const p = path.join(sourceDir, f.relativePath || f.filename);
      if (!fs.existsSync(p)) {
        console.warn(`[BidDocs] Missing source file: ${p}`);
        continue;
      }
      const buffer = fs.readFileSync(p);
      fs.writeFileSync(path.join(jobPdfsDir, f.filename), buffer);
      planBuffers.push({ filename: f.filename, buffer });
    }
    if (planBuffers.length === 0) throw new Error("Selected plan files are missing from the run's source directory");

    await processJob(planJob.id, planBuffers);

    const completedJob = await planParserStorage.getJob(planJob.id);
    if (!completedJob || completedJob.status !== "complete") {
      throw new Error(`Plan Parser baseline failed: ${completedJob?.message || "unknown error"}`);
    }
    if (run.projectDbId) {
      try {
        await updateProject(run.projectDbId, {
          status: "planparser_baseline_complete",
          baselineScopeCounts: completedJob.scopeCounts || {},
          baselineFlaggedPages: completedJob.flaggedPages,
        });
      } catch { /* linkage is best-effort */ }
    }

    // --- 2. Spec Extractor --------------------------------------------
    const specSections: Array<SectionRange & { sourceFile: string }> = [];

    if (specFiles.length > 0) {
      await setStatus(runId, "processing_specs", `Extracting spec sections from ${specFiles.length} file(s)...`);

      let firstSessionId: string | undefined;
      for (const f of specFiles) {
        const p = path.join(sourceDir, f.relativePath || f.filename);
        if (!fs.existsSync(p)) continue;
        const buffer = fs.readFileSync(p);

        try {
          const session = await storage.createSession({
            filename: f.filename,
            projectName: `BidDocs ${runId.slice(0, 8)}`,
            status: "processing",
            progress: 0,
            message: "Started by Bid Docs Intake",
            createdAt: new Date().toISOString(),
          });
          if (!firstSessionId) firstSessionId = session.id;
          await storage.storePdfBuffer(session.id, buffer);

          const result = await runExtraction(buffer, (progress, message) => {
            storage.updateSession(session.id, { progress: Math.min(progress, 90), message }).catch(() => {});
          });

          for (const section of result.sections) {
            specSections.push({ ...section, sourceFile: f.filename });
            await storage.createSection({
              sessionId: session.id,
              sectionNumber: section.section,
              title: section.title,
              startPage: section.start,
              endPage: section.end,
              content: "",
              manufacturers: [],
              modelNumbers: [],
              materials: [],
              conflicts: [],
              notes: [],
              isEdited: false,
            });
          }

          await storage.updateSession(session.id, {
            status: "complete",
            progress: 100,
            message: `Extracted ${result.sections.length} sections via Bid Docs Intake`,
          });
        } catch (err) {
          console.error(`[BidDocs] Spec extraction failed for ${f.filename}:`, err);
        }
      }
      if (firstSessionId) await updateRun(runId, { specsiftSessionId: firstSessionId });
    }

    // --- 3. Spec-informed boost pass ------------------------------------
    if (specSections.length > 0) {
      await setStatus(runId, "spec_pass", "Re-scoring plan pages with spec-found details...");

      const specBoosts: SpecBoostData[] = [];
      for (const section of specSections) {
        specBoosts.push({
          scopeType: section.title,
          manufacturers: [],
          modelNumbers: [],
          materials: [],
          specSectionNumber: section.section,
        });
      }

      try {
        if (run.projectDbId) await updateProject(run.projectDbId, { status: "planparser_specpass_running" });
        await reprocessJobWithSpecBoost(planJob.id, specBoosts);
        if (run.projectDbId) await updateProject(run.projectDbId, { status: "outputs_ready" });
      } catch (err) {
        console.error(`[BidDocs] Spec boost pass failed (continuing):`, err);
      }
    }

    // --- 4. Schedule-driven callout expansion ---------------------------
    await setStatus(runId, "callout_pass", "Hunting schedule callouts across all sheets...");
    let harvested: Record<string, string[]> = {};
    try {
      const freshRun = await getRun(runId);
      harvested = await runCalloutPass(planJob.id, freshRun?.selectedScopes || []);
    } catch (err) {
      console.error(`[BidDocs] Callout pass failed (continuing):`, err);
    }

    await updateRun(runId, {
      harvestedCallouts: harvested,
      status: "review",
      message: "Processing complete — review the flagged pages, then finalize.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Processing failed";
    console.error(`[BidDocs] Run ${runId} failed:`, err);
    await updateRun(runId, { status: "error", error: message, message });
  }
}

// ---------------------------------------------------------------------------
// Finalize: highlighted per-scope PDFs into the project folder + report
// ---------------------------------------------------------------------------

export interface FinalizeResult {
  scopePdfPaths: Record<string, string>;
  reportPath: string | null;
  specExtractPaths: string[];
  folderPath: string | null;
}

export async function finalizeRun(
  runId: string,
  options: {
    includeHighlights?: boolean;
    projectFolderPath?: string | null;
    projectName?: string;
    projectMeta?: Record<string, string | null | undefined>;
  } = {},
): Promise<FinalizeResult> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (!run.planparserJobId) throw new Error("Run has no Plan Parser job");

  const includeHighlights = options.includeHighlights !== false;
  await setStatus(runId, "generating_report", "Building per-scope plan files and the Scope Short Order report...");

  try {
    const pages = await planParserStorage.getPagesByJob(run.planparserJobId);
    const relevantPages = pages.filter(p => p.isRelevant);
    const jobDir = planParserStorage.getJobDirectory(run.planparserJobId);
    const pdfsDir = path.join(jobDir, "pdfs");

    const selectedScopes = run.selectedScopes && run.selectedScopes.length > 0
      ? run.selectedScopes
      : Array.from(new Set(relevantPages.flatMap(p => p.tags)));

    // Outputs always land in the run dir (that's what the zip download
    // serves); when a project folder is linked they're copied there too.
    const outDirBase = path.join(BID_DOCS_DIR, runId, "output", "Plans");
    fs.mkdirSync(outDirBase, { recursive: true });
    const projectPlansDir = options.projectFolderPath && fs.existsSync(options.projectFolderPath)
      ? path.join(options.projectFolderPath, "Estimate Folder", "Bid Documents", "Plans")
      : null;
    if (projectPlansDir) fs.mkdirSync(projectPlansDir, { recursive: true });

    // --- Per-scope combined (highlighted) PDFs -------------------------
    const pdfCache: Record<string, PDFDocument> = {};
    const loadPdf = async (filename: string): Promise<PDFDocument | null> => {
      if (pdfCache[filename]) return pdfCache[filename];
      const p = path.join(pdfsDir, filename);
      if (!fs.existsSync(p)) return null;
      const doc = await PDFDocument.load(fs.readFileSync(p));
      pdfCache[filename] = doc;
      return doc;
    };

    const scopePdfPaths: Record<string, string> = {};
    const scopeSheetRefs: Record<string, string[]> = {};

    for (const scope of selectedScopes) {
      const scopePages = relevantPages
        .filter(p => p.tags.includes(scope as any))
        .sort((a, b) => a.originalFilename.localeCompare(b.originalFilename) || a.pageNumber - b.pageNumber);
      if (scopePages.length === 0) continue;

      const newPdf = await PDFDocument.create();
      const refs: string[] = [];

      for (const page of scopePages) {
        const sourcePdf = await loadPdf(page.originalFilename);
        if (!sourcePdf) continue;
        try {
          const [copied] = await newPdf.copyPages(sourcePdf, [page.pageNumber - 1]);
          const added = newPdf.addPage(copied);
          if (includeHighlights && page.matchBoxes && page.matchBoxes.length > 0) {
            applyHighlights(added, page.matchBoxes);
          }
          refs.push(`${page.originalFilename} p.${page.pageNumber}`);
        } catch (err) {
          console.error(`[BidDocs] Failed to copy ${page.originalFilename} p${page.pageNumber}:`, err);
        }
      }

      if (newPdf.getPageCount() > 0) {
        const safeScope = scope.replace(/[\/\\?%*:|"<>]/g, "-");
        const outName = `${safeScope} - Plan Pages.pdf`;
        const outPath = path.join(outDirBase, outName);
        const bytes = await newPdf.save();
        fs.writeFileSync(outPath, bytes);
        if (projectPlansDir) fs.writeFileSync(path.join(projectPlansDir, outName), bytes);
        scopePdfPaths[scope] = outPath;
        scopeSheetRefs[scope] = refs;
      }
    }

    // --- Spec pass: one extraction per spec file feeds BOTH the section
    //     PDFs written to the project folder AND the AI detail inputs -----
    const specExtractPaths: string[] = [];
    const specInputs: SpecSectionInput[] = [];
    {
      const files = await getRunFiles(runId);
      const specFiles = files.filter(f => f.selected && effectiveClass(f) === "spec");
      const sourceDir = getRunSourceDir(runId);
      const extractsDir = options.projectFolderPath && fs.existsSync(options.projectFolderPath)
        ? path.join(options.projectFolderPath, "Estimate Folder", "Vendors", "Specs Extracts")
        : null;

      for (const f of specFiles) {
        const srcPath = path.join(sourceDir, f.relativePath || f.filename);
        if (!fs.existsSync(srcPath)) continue;
        try {
          const buffer = fs.readFileSync(srcPath);
          const result = await runExtraction(buffer);
          const pages = await extractPages(buffer);

          for (const section of result.sections) {
            specInputs.push({
              sectionNumber: section.section,
              title: section.title,
              text: pages
                .slice(Math.max(0, section.start), Math.min(pages.length, section.end + 1))
                .join("\n")
                .slice(0, 24000),
              sourceFile: f.filename,
            });

            if (!extractsDir) continue;
            try {
              const sectionPdf = await extractSectionPdf(srcPath, section.start, section.end);
              if (!sectionPdf || sectionPdf.length === 0) continue;
              const folder = path.join(extractsDir, section.folderName.replace(/[\/\\?%*:|"<>]/g, "-").slice(0, 50));
              fs.mkdirSync(folder, { recursive: true });
              const outPath = path.join(folder, `${section.section} - ${section.title.slice(0, 40)}.pdf`.replace(/[\/\\?%*:|"<>]/g, "-"));
              fs.writeFileSync(outPath, sectionPdf);
              specExtractPaths.push(outPath);
            } catch (err) {
              console.warn(`[BidDocs] Section PDF failed (${section.section}):`, err instanceof Error ? err.message : err);
            }
          }
        } catch (err) {
          console.warn(`[BidDocs] Spec extract failed for ${f.filename}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    // --- AI material-details pass + report -----------------------------
    let scopeDetails: ScopeMaterialDetails[] = [];
    try {
      scopeDetails = await extractScopeMaterialDetails(
        selectedScopes,
        relevantPages,
        specInputs,
        scopeSheetRefs,
      );
      await updateRun(runId, { scopeDetails });
    } catch (err) {
      console.error("[BidDocs] Material detail extraction failed (report will use raw findings):", err);
    }

    let reportPath: string | null = null;
    try {
      const job = await planParserStorage.getJob(run.planparserJobId);
      const reportDirBase = path.join(BID_DOCS_DIR, runId, "output");
      fs.mkdirSync(reportDirBase, { recursive: true });

      const now = new Date();
      const stamp = `${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}.${String(now.getFullYear()).slice(2)}`;
      const projectName = options.projectName || "Project";
      const safeProject = projectName.replace(/[\/\\?%*:|"<>]/g, "-").slice(0, 60);
      const reportName = `${safeProject} - Scope Short Order - ${stamp}.xlsx`;
      reportPath = path.join(reportDirBase, reportName);

      await buildScopeShortOrderWorkbook(reportPath, {
        projectName,
        projectMeta: options.projectMeta || {},
        selectedScopes,
        scopeDetails,
        relevantPages,
        scopeSheetRefs,
        scopeCounts: job?.scopeCounts || {},
        harvestedCallouts: (run.harvestedCallouts as Record<string, string[]>) || {},
        filesProcessed: (await getRunFiles(runId)).filter(f => f.selected).map(f => f.filename),
        generatedBy: run.createdBy || "unknown",
      });

      if (options.projectFolderPath && fs.existsSync(options.projectFolderPath)) {
        const projectEstimateDir = path.join(options.projectFolderPath, "Estimate Folder", "Estimate");
        fs.mkdirSync(projectEstimateDir, { recursive: true });
        fs.copyFileSync(reportPath, path.join(projectEstimateDir, reportName));
      }
    } catch (err) {
      console.error("[BidDocs] Report generation failed:", err);
      reportPath = null;
    }

    await updateRun(runId, {
      status: "complete",
      message: `Done: ${Object.keys(scopePdfPaths).length} scope plan file(s)${reportPath ? " + Scope Short Order report" : ""}.`,
    });

    return {
      scopePdfPaths,
      reportPath,
      specExtractPaths,
      folderPath: options.projectFolderPath || null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Finalize failed";
    await updateRun(runId, { status: "error", error: message, message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// TTL cleanup of run source dirs
// ---------------------------------------------------------------------------

export async function cleanupExpiredRuns(): Promise<void> {
  try {
    if (!fs.existsSync(BID_DOCS_DIR)) return;
    const cutoff = Date.now() - RUN_TTL_MS;
    for (const entry of fs.readdirSync(BID_DOCS_DIR)) {
      const dir = path.join(BID_DOCS_DIR, entry);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[BidDocs] Cleaned up expired run dir: ${entry}`);
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    console.error("[BidDocs] Cleanup failed:", err);
  }
}

setInterval(() => { cleanupExpiredRuns().catch(console.error); }, 6 * 60 * 60 * 1000);
