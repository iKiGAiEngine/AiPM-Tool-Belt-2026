import type { Express, Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PDFDocument, PDFDict, PDFString, PDFArray, PDFName, PDFNull, PDFNumber } from "pdf-lib";
import { insertScopeDictionarySchema, insertRegionSchema, PLAN_PARSER_SCOPES } from "@shared/schema";
import { requireAdmin } from "./authRoutes";
import {
  getAllScopeDictionaries,
  getActiveScopeDictionaries,
  getScopeDictionaryById,
  createScopeDictionary,
  updateScopeDictionary,
  deleteScopeDictionary,
  seedDefaultScopeDictionaries,
  getAllRegions,
  getActiveRegions,
  createRegion,
  updateRegion,
  deleteRegion,
  generateProjectId,
  getAllProjects,
  getTestProjects,
  getProjectById,
  getProjectByProjectId,
  createProject,
  updateProject,
  getProjectScopes,
  createProjectScope,
  updateProjectScopeSelection,
  deleteProject,
} from "./scopeDictionaryStorage";
import { storage } from "./storage";
import { runExtraction, extractPages, findAccessorySections, isSignageSection } from "./specExtractorEngine";
import type { AccessoryScope } from "./specExtractorEngine";
import { getActiveConfiguration } from "./configService";
import { callSpecExtractor } from "./specExtractorClient";
import { reprocessJobWithSpecBoost } from "./planparser/pdfProcessor";
import type { SpecBoostData } from "./planparser/classificationConfig";
import { processJob } from "./planparser/pdfProcessor";
import { planParserStorage } from "./planparser/storage";
import { getActiveFolderTemplate, getActiveEstimateTemplate, getFolderTemplateFileBuffer, getEstimateTemplateFileBuffer } from "./templateStorage";
import ExcelJS from "exceljs";
import { extractProjectDetailsFromScreenshot } from "./screenshotExtractor";
import { matchRegionWithFallback } from "./regionMatcher";
import { isSwinerton, matchSwinertonOffice, matchExtRegion } from "./swinertonOffices";
import { guessMarket, createProposalLogEntry, bulkCreateProposalLogEntries, getUnsyncedEntries, markEntriesSynced, getActiveProposalLogEntries, getAllProposalLogEntries, updateProposalLogEntryById, deleteProposalLogEntry, deleteProposalLogEntries, getAcknowledgedEntryIds, acknowledgeEntry, unacknowledgeEntry, clearAcknowledgementsForEntry, requestDeleteEntry, cancelDeleteRequest, approveDeleteEntry, rejectDeleteEntry } from "./proposalLogService";
import { getSheetUrl, syncProposalLogToSheet, pullRepairAndPush, isGoogleSheetConfigured } from "./googleSheetSync";
import { findFuzzyDuplicates } from "./fuzzyDuplicates";
import { users, proposalLogEntries, regions, proposalChangeLog, estimateTemplates, projects } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { resolveChangedByName, recordFieldChanges, recordEntryCreation, recordEntryDeletion, recordDeletionRequested, recordDeletionRejected, recordDeleteCancelled } from "./changeLogger";
import { db } from "./db";
import { sendBidAssignmentEmail, getBidAssignmentTemplate, saveBidAssignmentTemplate, sendProjectWonEmail, getProjectWonTemplate, saveProjectWonTemplate } from "./emailService";
import { createNotification, createNotificationForAdmins } from "./notificationRoutes";
import { userCanAccessProject } from "./projectAccessControl";
import { TERMINAL_ESTIMATE_STATUSES } from "./constants";

const SCREENSHOTS_DIR = path.join(process.cwd(), "project_screenshots");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and image files are allowed"));
    }
  },
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

function handleImageUploadError(req: Request, res: Response, next: Function) {
  imageUpload.single("screenshot")(req, res, (err: any) => {
    if (err) {
      console.error("[ScreenshotExtractor] Upload error:", err.message);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Image file too large (max 20MB)" });
      }
      return res.status(400).json({ message: err.message || "Invalid file upload" });
    }
    next();
  });
}

const PROJECTS_DIR = path.join(process.cwd(), "projects");

function sanitizeForWindows(name: string): string {
  return name.replace(/[\/\\?%*:|"<>]/g, "-").replace(/\s+/g, " ").trim();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function registerProjectRoutes(app: Express) {

  app.post("/api/extract-project-details", handleImageUploadError, async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No image uploaded" });
      }

      console.log(`[ScreenshotExtractor] Processing ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB)`);
      const result = await extractProjectDetailsFromScreenshot(req.file.buffer);
      console.log(`[ScreenshotExtractor] Extracted: name="${result.projectName}", date="${result.dueDate}", location="${result.location}", client="${result.clientName}", clientLoc="${result.clientLocation}", invite="${result.inviteDate}", start="${result.expectedStart}", finish="${result.expectedFinish}", gcContact="${result.gcContactName}", gcEmail="${result.gcContactEmail}"`);

      const clientLoc = (result.clientLocation || "").trim();
      const projectName = result.projectName || "";
      const clientName = result.clientName || "";

      const activeRegions = await getActiveRegions();
      let regionMatch: { code: string; displayLabel: string; confident: boolean } = { code: "", displayLabel: "", confident: false };

      if (isSwinerton(clientName)) {
        // Swinerton: match using the full assembled string first for maximum context,
        // then fall back to clientLoc alone, then individual dash-segments.
        const fullClientStr = [clientName, clientLoc].filter(Boolean).join(" - ");
        const candidateStrings = [...new Set([fullClientStr, clientLoc].filter(Boolean))];

        for (const str of candidateStrings) {
          const r = matchSwinertonOffice(str, activeRegions);
          if (r.confident) { regionMatch = r; break; }
        }

        // If no full-string match, try individual dash-segments of clientLoc
        if (!regionMatch.confident && clientLoc) {
          const segments = clientLoc.split(/[-–—]/).map((s: string) => s.trim()).filter(Boolean);
          for (const seg of segments) {
            const segMatch = matchSwinertonOffice(seg, activeRegions);
            if (segMatch.confident) { regionMatch = segMatch; break; }
          }
        }
      } else {
        // Non-Swinerton GC: look up EXT region by company name
        regionMatch = matchExtRegion(clientName, activeRegions);
      }

      // confident=true + empty code = intentionally blank (estimator decides)
      const matchedRegionCode = (regionMatch.confident && regionMatch.code) ? regionMatch.code : null;
      // Also return the full display label so the frontend can pre-select the exact sub-region
      const matchedRegionLabel = matchedRegionCode ? (regionMatch.displayLabel || null) : null;
      console.log(`[ScreenshotExtractor] Region match for "${projectName}": client="${clientName}" clientLoc="${clientLoc}" → region="${regionMatch.code}" (${regionMatch.displayLabel}) confident=${regionMatch.confident}`);

      const primaryMarket = guessMarket(result.projectName || "", result.rawText);

      res.json({
        projectName: result.projectName,
        dueDate: result.dueDate,
        location: result.location,
        tradeName: result.tradeName,
        matchedRegionCode,
        matchedRegionLabel,
        inviteDate: result.inviteDate,
        expectedStart: result.expectedStart,
        expectedFinish: result.expectedFinish,
        clientName: result.clientName,
        clientLocation: result.clientLocation,
        gcContactName: result.gcContactName,
        gcContactEmail: result.gcContactEmail,
        primaryMarket,
        bcLink: result.bcLink,
        rawText: result.rawText,
        extractionFailed: result.extractionFailed || false,
      });
    } catch (error) {
      console.error("[ScreenshotExtractor] Error:", error);
      res.status(500).json({ message: "Failed to extract project details from screenshot" });
    }
  });

  app.get("/api/scope-dictionaries", async (req: Request, res: Response) => {
    try {
      const activeOnly = req.query.active === "true";
      const dictionaries = activeOnly ? await getActiveScopeDictionaries() : await getAllScopeDictionaries();
      res.json(dictionaries);
    } catch (error) {
      console.error("Error fetching scope dictionaries:", error);
      res.status(500).json({ message: "Failed to fetch scope dictionaries" });
    }
  });

  app.get("/api/scope-dictionaries/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const dict = await getScopeDictionaryById(id);
      if (!dict) return res.status(404).json({ message: "Not found" });
      res.json(dict);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch scope dictionary" });
    }
  });

  app.post("/api/scope-dictionaries", async (req: Request, res: Response) => {
    try {
      const parsed = insertScopeDictionarySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid data", errors: parsed.error.issues });
      }
      const dict = await createScopeDictionary(parsed.data);
      res.status(201).json(dict);
    } catch (error) {
      console.error("Error creating scope dictionary:", error);
      res.status(500).json({ message: "Failed to create scope dictionary" });
    }
  });

  app.put("/api/scope-dictionaries/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const parsed = insertScopeDictionarySchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid data", errors: parsed.error.issues });
      }
      const dict = await updateScopeDictionary(id, parsed.data);
      if (!dict) return res.status(404).json({ message: "Not found" });
      res.json(dict);
    } catch (error) {
      res.status(500).json({ message: "Failed to update scope dictionary" });
    }
  });

  app.delete("/api/scope-dictionaries/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const deleted = await deleteScopeDictionary(id);
      if (!deleted) return res.status(404).json({ message: "Not found" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete scope dictionary" });
    }
  });

  app.post("/api/scope-dictionaries/seed", async (req: Request, res: Response) => {
    try {
      await seedDefaultScopeDictionaries();
      const dictionaries = await getAllScopeDictionaries();
      res.json(dictionaries);
    } catch (error) {
      console.error("Error seeding scope dictionaries:", error);
      res.status(500).json({ message: "Failed to seed scope dictionaries" });
    }
  });

  app.get("/api/regions", async (req: Request, res: Response) => {
    try {
      const activeOnly = req.query.active === "true";
      const allRegions = activeOnly ? await getActiveRegions() : await getAllRegions();
      res.json(allRegions);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch regions" });
    }
  });

  app.post("/api/regions", requireAdmin, async (req: Request, res: Response) => {
    try {
      const parsed = insertRegionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid data", errors: parsed.error.issues });
      }
      const region = await createRegion(parsed.data);
      res.status(201).json(region);
    } catch (error) {
      res.status(500).json({ message: "Failed to create region" });
    }
  });

  app.put("/api/regions/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const updateData = { ...req.body };
      if (updateData.selfPerformEstimators !== undefined) {
        const incoming: string[] = Array.isArray(updateData.selfPerformEstimators) ? updateData.selfPerformEstimators : [];
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const sp of incoming) {
          const trimmed = (sp || "").trim();
          const key = trimmed.toLowerCase();
          if (trimmed && !seen.has(key)) {
            seen.add(key);
            cleaned.push(trimmed);
          }
        }
        updateData.selfPerformEstimators = cleaned.length ? cleaned : null;
      }
      const region = await updateRegion(id, updateData);
      if (!region) return res.status(404).json({ message: "Not found" });
      res.json(region);
    } catch (error) {
      res.status(500).json({ message: "Failed to update region" });
    }
  });

  app.delete("/api/regions/:id", requireAdmin, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const deleted = await deleteRegion(id);
      if (!deleted) return res.status(404).json({ message: "Not found" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete region" });
    }
  });

  app.get("/api/projects", async (req: Request, res: Response) => {
    try {
      const includeTest = req.query.includeTest === "true";
      const allProjects = await getAllProjects(includeTest);
      res.json(allProjects);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch projects" });
    }
  });

  app.get("/api/config/spec-extractor", (_req: Request, res: Response) => {
    const url = process.env.SPEC_EXTRACTOR_URL || null;
    res.json({ url, configured: !!url });
  });

  app.get("/api/projects/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const project = await getProjectById(id);
      if (!project) return res.status(404).json({ message: "Not found" });
      res.json(project);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch project" });
    }
  });

  app.get("/api/projects/:id/progress", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const project = await getProjectById(id);
      if (!project) return res.status(404).json({ message: "Not found" });

      let specsiftProgress: { status: string; progress: number; message: string } | null = null;
      if (project.specsiftSessionId) {
        const session = await storage.getSession(project.specsiftSessionId);
        if (session) {
          specsiftProgress = {
            status: session.status || "pending",
            progress: session.progress ?? 0,
            message: session.message || "",
          };
        }
      }

      let planparserProgress: { status: string; totalPages: number; processedPages: number; message: string } | null = null;
      if (project.planparserJobId) {
        const job = await planParserStorage.getJob(project.planparserJobId);
        if (job) {
          planparserProgress = {
            status: job.status || "pending",
            totalPages: job.totalPages ?? 0,
            processedPages: job.processedPages ?? 0,
            message: job.message || "",
          };
        }
      }

      res.json({
        projectId: project.id,
        projectStatus: project.status,
        specsift: specsiftProgress,
        planparser: planparserProgress,
        hasSpecs: !!project.specsiftSessionId,
        hasPlans: !!project.planparserJobId,
        specExtractorUrl: process.env.SPEC_EXTRACTOR_URL || null,
      });
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch project progress" });
    }
  });

  app.get("/api/projects/:id/scopes", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const scopes = await getProjectScopes(id);
      res.json(scopes);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch project scopes" });
    }
  });

  app.post(
    "/api/projects",
    upload.fields([
      { name: "plans", maxCount: 1 },
      { name: "specs", maxCount: 1 },
      { name: "screenshot", maxCount: 1 },
    ]),
    async (req: Request, res: Response) => {
      try {
        const { projectName, regionCode, dueDate, isTest, screenshotLocation } = req.body;

        if (!projectName || !regionCode || !dueDate) {
          return res.status(400).json({ message: "Project name, region code, and due date are required" });
        }

        const activeRegionsForValidation = await getActiveRegions();
        const validRegionEntry = activeRegionsForValidation.find(r => r.code.toUpperCase() === regionCode.toUpperCase());
        if (!validRegionEntry) {
          return res.status(400).json({ message: `Region "${regionCode}" is not a recognized active region. Please select a valid region from Settings.` });
        }

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const plansFile = files?.plans?.[0] || null;
        const specsFile = files?.specs?.[0] || null;
        const screenshotFile = files?.screenshot?.[0] || null;
        const hasPlans = !!plansFile;
        const hasSpecs = !!specsFile;

        const projectIdStr = await generateProjectId();
        const safeName = sanitizeForWindows(projectName);
        const folderName = `${regionCode.toUpperCase()} - ${safeName}`;
        const projectDir = path.join(PROJECTS_DIR, folderName);

        ensureDir(projectDir);

        const activeFolderTemplate = await getActiveFolderTemplate();
        const folderZipBuffer = activeFolderTemplate ? await getFolderTemplateFileBuffer(activeFolderTemplate) : null;
        if (activeFolderTemplate && folderZipBuffer) {
          console.log(`[ProjectCreate] Extracting folder template v${activeFolderTemplate.version} (${folderZipBuffer.length} bytes from ${activeFolderTemplate.fileData ? 'database' : 'disk'})`);
          const zipBuffer = folderZipBuffer;
          const zip = await JSZip.loadAsync(zipBuffer);
          let extractedCount = 0;
          for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            const parts = relativePath.split("/");
            if (parts[0] === "0000_Standard Folders" || parts[0] === "0000_Standard Folder") {
              parts.shift();
            }
            const outputPath = parts.join("/");
            if (!outputPath) continue;
            if (zipEntry.dir) {
              ensureDir(path.join(projectDir, outputPath));
            } else {
              const fileDir = path.dirname(path.join(projectDir, outputPath));
              ensureDir(fileDir);
              const content = await zipEntry.async("nodebuffer");
              fs.writeFileSync(path.join(projectDir, outputPath), content);
              extractedCount++;
            }
          }
          console.log(`[ProjectCreate] Extracted ${extractedCount} files and ${Object.keys(zip.files).length - extractedCount} directories from folder template (contents placed directly in project folder)`);
        } else {
          console.warn(`[ProjectCreate] No active folder template found or file missing (template: ${activeFolderTemplate?.id || 'none'}, path: ${activeFolderTemplate?.filePath || 'none'})`);
        }

        const requiredSubfolders = [
          "Estimate Folder/Bid Documents/Plans",
          "Estimate Folder/Bid Documents/Specs",
          "Estimate Folder/Vendors",
          "Estimate Folder/Estimate",
        ];
        for (const sub of requiredSubfolders) {
          ensureDir(path.join(projectDir, sub));
        }

        const activeEstimateTemplate = await getActiveEstimateTemplate();
        const estimateBuffer = activeEstimateTemplate ? await getEstimateTemplateFileBuffer(activeEstimateTemplate) : null;
        if (activeEstimateTemplate && estimateBuffer) {
          try {
            console.log(`[ProjectCreate] Stamping estimate template v${activeEstimateTemplate.version} (${estimateBuffer.length} bytes from ${activeEstimateTemplate.fileData ? 'database' : 'disk'})`);
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(estimateBuffer);

            let stampedCount = 0;
            const summarySheet = workbook.getWorksheet("Summary") || workbook.worksheets[0];
            
            if (summarySheet) {
              // B1: Project Name
              if (safeName) {
                summarySheet.getCell("B1").value = safeName;
                stampedCount++;
              }
              
              // B2: BID DUE DATE
              if (dueDate) {
                summarySheet.getCell("B2").value = dueDate;
                stampedCount++;
              }
              
              // B4: SHIP TO (Project Address)
              if (screenshotLocation) {
                summarySheet.getCell("B4").value = screenshotLocation;
                stampedCount++;
              }
              
              console.log(`[ProjectCreate] Stamped ${stampedCount} cells in Summary sheet`);
            } else {
              console.warn(`[ProjectCreate] Could not find Summary sheet in estimate template`);
            }

            const dueParts = dueDate.split("-");
            const formattedDueDate = `${dueParts[1]}.${dueParts[2]}.${dueParts[0].slice(2)}`;
            const ext = path.extname(activeEstimateTemplate.originalFilename || activeEstimateTemplate.filePath) || ".xlsx";
            const estimateFilename = `${safeName} - NBS Estimate - ${formattedDueDate}${ext}`;

            const estimatePath = path.join(projectDir, "Estimate Folder", "Estimate", estimateFilename);

            if (ext === ".xlsm") {
              fs.writeFileSync(estimatePath, estimateBuffer);
              console.log(`[ProjectCreate] Estimate file copied as .xlsm (macros preserved): ${estimateFilename} (stamping skipped for macro-enabled format)`);
            } else {
              await workbook.xlsx.writeFile(estimatePath);
              console.log(`[ProjectCreate] Estimate file saved: ${estimateFilename} in Estimate Folder/Estimate/ (${stampedCount} fields stamped)`);
            }
          } catch (err) {
            console.error("[ProjectCreate] Failed to stamp estimate template:", err);
          }
        } else {
          console.warn(`[ProjectCreate] No active estimate template found or file missing (template: ${activeEstimateTemplate?.id || 'none'}, path: ${activeEstimateTemplate?.filePath || 'none'})`);
        }

        if (plansFile) {
          fs.writeFileSync(path.join(projectDir, "Estimate Folder/Bid Documents/Plans", plansFile.originalname), plansFile.buffer);
        }
        if (specsFile) {
          fs.writeFileSync(path.join(projectDir, "Estimate Folder/Bid Documents/Specs", specsFile.originalname), specsFile.buffer);
        }

        let specsiftSessionId: string | undefined;
        let planParserJobId: string | undefined;

        if (specsFile) {
          const specsiftSession = await storage.createSession({
            filename: specsFile.originalname,
            projectName: safeName,
            status: "processing",
            progress: 0,
            message: "Starting Spec Extractor...",
            createdAt: new Date().toISOString(),
          });
          await storage.storePdfBuffer(specsiftSession.id, specsFile.buffer);
          specsiftSessionId = specsiftSession.id;
        }

        if (plansFile) {
          const planParserJob = await planParserStorage.createJob({
            status: "pending",
            totalPages: 0,
            processedPages: 0,
            flaggedPages: 0,
            filenames: [plansFile.originalname],
            message: "Queued for processing",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            scopeCounts: {},
          });
          planParserJobId = planParserJob.id;
        }

        const initialStatus = (!hasPlans && !hasSpecs) ? "folder_only" : "created";

        const project = await createProject({
          projectId: projectIdStr,
          projectName: safeName,
          regionCode: regionCode.toUpperCase(),
          dueDate,
          projectAddress: screenshotLocation,
          status: initialStatus,
          specsiftSessionId: specsiftSessionId,
          planparserJobId: planParserJobId,
          folderPath: projectDir,
          plansFilename: plansFile?.originalname,
          specsFilename: specsFile?.originalname,
          isTest: isTest === "true",
        });

        if (hasSpecs || hasPlans) {
          (async () => {
            if (hasSpecs && specsFile && specsiftSessionId) {
              try {
                await updateProject(project.id, { status: "specsift_running" });
                await storage.updateSession(specsiftSessionId, {
                  progress: 10,
                  message: "Sending specs to Spec Extractor...",
                });

                const useExternal = !!process.env.SPEC_EXTRACTOR_URL;

                if (useExternal) {
                  const result = await callSpecExtractor(
                    specsFile.buffer,
                    specsFile.originalname,
                    safeName,
                    specsiftSessionId,
                  );

                  await storage.updateSession(specsiftSessionId, {
                    progress: 70,
                    message: `Received ${result.sections.length} sections, saving...`,
                  });

                  for (const section of result.sections) {
                    await storage.createSection(section);
                  }

                  await storage.updateSession(specsiftSessionId, {
                    status: "complete",
                    progress: 100,
                    message: `Extracted ${result.sections.length} sections via Spec Extractor`,
                  });

                  for (const item of result.rawItems) {
                    await createProjectScope({
                      projectId: project.id,
                      scopeType: item.scope || item.title || "Unknown",
                      specSectionNumber: item.section,
                      specSectionTitle: item.title,
                      manufacturers: [],
                      modelNumbers: [],
                      materials: [],
                      keywords: [],
                      confidenceScore: 90,
                      isSelected: true,
                    });
                  }
                } else {
                  const result = await runExtraction(specsFile.buffer, (progress, message) => {
                    storage.updateSession(specsiftSessionId!, { progress: Math.min(progress, 70), message });
                  });

                  for (const section of result.sections) {
                    await storage.createSection({
                      sessionId: specsiftSessionId!,
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

                  await storage.updateSession(specsiftSessionId!, {
                    progress: 75,
                    message: "Scanning for accessory sections...",
                  });

                  let configScopes: AccessoryScope[] | undefined;
                  try {
                    const config = await getActiveConfiguration();
                    if (config.accessoryScopes && (config.accessoryScopes as any[]).length > 0) {
                      configScopes = (config.accessoryScopes as any[]).map((s: any) => ({
                        name: s.name,
                        keywords: Array.isArray(s.keywords) ? s.keywords : [],
                        sectionHint: s.sectionHint || "",
                        divisionScope: Array.isArray(s.divisionScope) ? s.divisionScope : [],
                      }));
                    }
                  } catch (e) {
                    console.log("[ProjectCreate] Could not load config scopes, using defaults");
                  }

                  const allAccessoryNames = (configScopes || []).map(s => s.name);
                  if (allAccessoryNames.length > 0) {
                    const pages = await extractPages(specsFile.buffer);
                    const accessoryMatches = findAccessorySections(
                      pages, allAccessoryNames, result.tocBounds, result.sections, configScopes
                    );

                    for (const match of accessoryMatches) {
                      await storage.createAccessoryMatch({
                        sessionId: specsiftSessionId!,
                        scopeName: match.accessoryName,
                        matchedKeyword: match.matchedKeywords.join(", "),
                        context: `${match.sectionNumber} - ${match.title} (pages ${match.start + 1}-${match.end + 1})`,
                        pageNumber: match.start,
                        sectionHint: match.sectionNumber,
                      });
                    }

                    console.log(`[ProjectCreate] Found ${accessoryMatches.length} accessory matches`);
                  }

                  await storage.updateSession(specsiftSessionId!, {
                    status: "complete",
                    progress: 100,
                    message: `Extracted ${result.sections.length} sections via Spec Extractor`,
                  });

                  for (const section of result.sections) {
                    const signage = isSignageSection(section.section);
                    await createProjectScope({
                      projectId: project.id,
                      scopeType: section.title || "Unknown",
                      specSectionNumber: section.section,
                      specSectionTitle: section.title,
                      manufacturers: [],
                      modelNumbers: [],
                      materials: [],
                      keywords: [],
                      confidenceScore: 90,
                      isSelected: !signage,
                    });
                  }
                }

                await updateProject(project.id, { status: "specsift_complete" });
              } catch (err) {
                console.error("Spec Extractor processing error:", err);
                await storage.updateSession(specsiftSessionId!, {
                  status: "error",
                  message: err instanceof Error ? err.message : "Processing failed",
                });
                await updateProject(project.id, { status: "specsift_error" });
              }
            }

            if (hasPlans && plansFile && planParserJobId) {
              try {
                await updateProject(project.id, { status: "planparser_baseline_running" });
                await processJob(planParserJobId, [
                  { filename: plansFile.originalname, buffer: plansFile.buffer }
                ]);
                const completedJob = await planParserStorage.getJob(planParserJobId);
                if (completedJob) {
                  await updateProject(project.id, {
                    status: "planparser_baseline_complete",
                    baselineScopeCounts: completedJob.scopeCounts || {},
                    baselineFlaggedPages: completedJob.flaggedPages,
                  });
                } else {
                  await updateProject(project.id, { status: "planparser_baseline_complete" });
                }
              } catch (err) {
                console.error("Plan Parser processing error:", err);
                await updateProject(project.id, { status: "planparser_baseline_error" });
              }
            }

            if (!hasPlans && hasSpecs) {
              const currentProject = await getProjectById(project.id);
              if (currentProject && !currentProject.status?.includes("error")) {
                await updateProject(project.id, { status: "planparser_baseline_complete" });
              }
            }
          })();
        }

        // Screenshot is stored as bytea in proposal_log_entries.screenshot_data
        // (matches the feedbackScreenshots pattern for production resilience —
        // local filesystem is ephemeral on redeploy).
        // screenshotPath keeps a "db:<projectId>" marker so existing UI gates
        // that check entry.screenshotPath truthiness continue to work.
        const screenshotSavePath = screenshotFile ? `db:${projectIdStr}` : "";
        if (screenshotFile) {
          console.log(`[ProjectCreate] Screenshot stored in DB (${Math.round(screenshotFile.buffer.length / 1024)} KB, ${screenshotFile.mimetype})`);
        }

        try {
          const userId = (req.session as any)?.userId;
          let ownerName = "";
          let ownerInitials = "";
          if (userId) {
            const [user] = await db.select().from(users).where(eq(users.id, userId));
            ownerName = user?.displayName || user?.username || user?.email || "";
            ownerInitials = user?.initials || "";
          }

          const activeRegions = await getActiveRegions();
          // Prefer the exact label returned by the screenshot extractor (e.g. "LAX - TM")
          // to avoid mis-picking the first DB region with a matching code (e.g. SPD instead of TM)
          const screenshotRegionLabel = req.body.screenshotRegionLabel || "";
          let regionLabel = screenshotRegionLabel;
          if (!regionLabel) {
            const matchedRegion = activeRegions.find(r => r.code === regionCode.toUpperCase());
            regionLabel = matchedRegion
              ? (matchedRegion.name ? `${matchedRegion.code} - ${matchedRegion.name}` : matchedRegion.code)
              : regionCode.toUpperCase();
          }

          const rawScreenshotText = req.body.screenshotRawText || "";
          const frontendMarket = req.body.primaryMarket || "";
          const bestMarket = frontendMarket || guessMarket(safeName, rawScreenshotText);

          const frontendInviteDate = req.body.inviteDate || "";
          const frontendEstimateStatus = req.body.estimateStatus || "";
          const frontendAnticipatedStart = req.body.anticipatedStart || "";
          const frontendAnticipatedFinish = req.body.anticipatedFinish || "";
          const frontendBcLink = req.body.bcLink || "";

          const mergeIntoProposalLogId = req.body.mergeIntoProposalLogId
            ? parseInt(req.body.mergeIntoProposalLogId)
            : null;
          const duplicateOverrideNote = req.body.duplicateOverrideNote || null;

          if (mergeIntoProposalLogId && !isNaN(mergeIntoProposalLogId)) {
            // Add as new bid round to an existing proposal log entry
            const userId = (req.session as any)?.userId;
            const addedBy = await resolveChangedByName(userId);
            const [existingEntry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, mergeIntoProposalLogId));
            if (existingEntry) {
              const currentRounds: any[] = Array.isArray(existingEntry.bidRounds) ? existingEntry.bidRounds : [];
              const newRound = {
                roundNumber: currentRounds.length + 1,
                addedAt: new Date().toISOString(),
                addedBy,
                nbsEstimator: null,
                proposalTotal: null,
                estimateStatus: frontendEstimateStatus || null,
                dueDate: dueDate || null,
                notes: null,
              };
              await db.update(proposalLogEntries).set({ bidRounds: [...currentRounds, newRound] }).where(eq(proposalLogEntries.id, mergeIntoProposalLogId));
              console.log(`[ProjectCreate] Added bid round to existing proposal log entry #${mergeIntoProposalLogId} for ${safeName}`);
            }
          } else {
            await createProposalLogEntry({
              projectName: safeName,
              estimateNumber: projectIdStr,
              region: regionLabel,
              primaryMarket: bestMarket,
              dueDate,
              owner: ownerName,
              filePath: projectDir,
              screenshotPath: screenshotSavePath,
              screenshotData: screenshotFile?.buffer || null,
              screenshotMimeType: screenshotFile?.mimetype || null,
              projectDbId: project.id,
              isTest: isTest === "true",
              inviteDate: frontendInviteDate || undefined,
              estimateStatus: frontendEstimateStatus || undefined,
              anticipatedStart: frontendAnticipatedStart || undefined,
              anticipatedFinish: frontendAnticipatedFinish || undefined,
              nbsEstimator: undefined,
              bcLink: frontendBcLink || undefined,
              duplicateOverrideNote: duplicateOverrideNote || undefined,
            });
            console.log(`[ProjectCreate] Proposal log entry created for ${safeName}`);
          }
        } catch (err) {
          console.error("[ProjectCreate] Failed to create proposal log entry:", err);
        }

        res.status(201).json({ ...project, hasPlans, hasSpecs });
      } catch (error) {
        console.error("Project creation error:", error);
        res.status(500).json({ message: "Failed to create project" });
      }
    }
  );

  app.patch("/api/projects/:id/scopes/:scopeId/select", async (req: Request, res: Response) => {
    try {
      const scopeId = parseInt(req.params.scopeId);
      if (isNaN(scopeId)) return res.status(400).json({ message: "Invalid scope ID" });
      const { isSelected } = req.body;
      const scope = await updateProjectScopeSelection(scopeId, isSelected);
      if (!scope) return res.status(404).json({ message: "Scope not found" });
      res.json(scope);
    } catch (error) {
      res.status(500).json({ message: "Failed to update scope selection" });
    }
  });

  app.delete("/api/projects/:id", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      if (project.specsiftSessionId) {
        try {
          await storage.deleteSectionsBySession(project.specsiftSessionId);
          await storage.deleteAccessoryMatchesBySession(project.specsiftSessionId);
          await storage.deletePdfBuffer(project.specsiftSessionId);
          await storage.deleteSession(project.specsiftSessionId);
        } catch {}
      }

      if (project.planparserJobId) {
        try {
          await planParserStorage.deleteJob(project.planparserJobId);
        } catch {}
      }

      if (project.folderPath) {
        try {
          fs.rmSync(project.folderPath, { recursive: true, force: true });
        } catch {}
      }

      await deleteProject(projectId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting project:", error);
      res.status(500).json({ message: "Failed to delete project" });
    }
  });

  app.post("/api/projects/clear-test-data", async (req: Request, res: Response) => {
    try {
      const testProjects = await getTestProjects();
      let deleted = 0;

      for (const project of testProjects) {
        if (project.specsiftSessionId) {
          try {
            await storage.deleteSectionsBySession(project.specsiftSessionId);
            await storage.deleteAccessoryMatchesBySession(project.specsiftSessionId);
            await storage.deletePdfBuffer(project.specsiftSessionId);
            await storage.deleteSession(project.specsiftSessionId);
          } catch {}
        }

        if (project.planparserJobId) {
          try {
            await planParserStorage.deleteJob(project.planparserJobId);
          } catch {}
        }

        if (project.folderPath) {
          try {
            fs.rmSync(project.folderPath, { recursive: true, force: true });
          } catch {}
        }

        await deleteProject(project.id);
        deleted++;
      }

      res.json({ success: true, deleted });
    } catch (error) {
      console.error("Error clearing test data:", error);
      res.status(500).json({ message: "Failed to clear test data" });
    }
  });

  app.post("/api/projects/bulk-delete", async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "ids must be a non-empty array" });
      }

      let deleted = 0;
      for (const id of ids) {
        const projectId = parseInt(id);
        if (isNaN(projectId)) continue;

        const project = await getProjectById(projectId);
        if (!project) continue;

        if (project.specsiftSessionId) {
          try {
            await storage.deleteSectionsBySession(project.specsiftSessionId);
            await storage.deleteAccessoryMatchesBySession(project.specsiftSessionId);
            await storage.deletePdfBuffer(project.specsiftSessionId);
            await storage.deleteSession(project.specsiftSessionId);
          } catch {}
        }

        if (project.planparserJobId) {
          try {
            await planParserStorage.deleteJob(project.planparserJobId);
          } catch {}
        }

        if (project.folderPath) {
          try {
            fs.rmSync(project.folderPath, { recursive: true, force: true });
          } catch {}
        }

        await deleteProject(projectId);
        deleted++;
      }

      res.json({ success: true, deleted });
    } catch (error) {
      console.error("Error bulk deleting projects:", error);
      res.status(500).json({ message: "Failed to bulk delete projects" });
    }
  });

  app.post("/api/projects/:id/spec-pass", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      if (!project.planparserJobId) {
        return res.status(400).json({ message: "No Plan Parser job associated with this project" });
      }

      const allowedStatuses = ["planparser_baseline_complete", "planparser_specpass_complete", "planparser_specpass_error", "specsift_complete"];
      if (!project.status || !allowedStatuses.includes(project.status)) {
        return res.status(409).json({ message: "Cannot run spec-pass yet. Baseline processing must complete first." });
      }

      const planJob = await planParserStorage.getJob(project.planparserJobId);
      if (!planJob || planJob.status !== "complete") {
        return res.status(409).json({ message: "Plan Parser baseline must finish before running the spec-informed pass." });
      }

      const scopes = await getProjectScopes(projectId);
      const selectedScopes = scopes.filter(s => s.isSelected);

      if (selectedScopes.length === 0) {
        return res.status(400).json({ message: "No scopes selected. Please toggle at least one scope before running the second pass." });
      }

      await updateProject(projectId, { status: "scopes_selected" });

      const specBoosts: SpecBoostData[] = selectedScopes.map(scope => ({
        scopeType: scope.scopeType,
        manufacturers: (scope.manufacturers as string[]) || [],
        modelNumbers: (scope.modelNumbers as string[]) || [],
        materials: (scope.materials as string[]) || [],
        specSectionNumber: scope.specSectionNumber,
      }));

      res.json({ message: "Spec-informed second pass started", selectedScopes: selectedScopes.length });

      (async () => {
        try {
          await updateProject(projectId, { status: "planparser_specpass_running" });
          await reprocessJobWithSpecBoost(project.planparserJobId!, specBoosts);
          await updateProject(projectId, { status: "outputs_ready" });
        } catch (err) {
          console.error("Spec-pass reprocessing error:", err);
          await updateProject(projectId, { status: "planparser_specpass_error" });
        }
      })();
    } catch (error) {
      console.error("Spec-pass error:", error);
      res.status(500).json({ message: "Failed to start spec-informed pass" });
    }
  });

  app.post("/api/projects/:id/retry", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const errorStatuses = ["specsift_error", "planparser_baseline_error", "planparser_specpass_error"];
      if (!project.status || !errorStatuses.includes(project.status)) {
        return res.status(409).json({ message: "Project is not in an error state" });
      }

      const folderPath = project.folderPath;
      if (!folderPath) {
        return res.status(400).json({ message: "No folder path found for this project" });
      }

      res.json({ message: "Retry started", status: project.status });

      if (project.status === "specsift_error") {
        (async () => {
          try {
            const specsPath = path.join(folderPath, "Estimate Folder/Bid Documents/Specs", project.specsFilename || "");
            if (!fs.existsSync(specsPath)) {
              await updateProject(projectId, { status: "specsift_error" });
              return;
            }
            const specsBuffer = fs.readFileSync(specsPath);
            const sessionId = project.specsiftSessionId;

            await updateProject(projectId, { status: "specsift_running" });
            if (sessionId) {
              await storage.updateSession(sessionId, { status: "processing", progress: 0, message: "Retrying Spec Extractor..." });
            }

            const result = await runExtraction(specsBuffer, (progress, message) => {
              if (sessionId) storage.updateSession(sessionId, { progress: Math.min(progress, 70), message });
            });

            for (const section of result.sections) {
              await storage.createSection({
                sessionId: sessionId || "",
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

            if (sessionId) {
              await storage.updateSession(sessionId, {
                progress: 75,
                message: "Scanning for accessory sections...",
              });
            }

            let configScopes: AccessoryScope[] | undefined;
            try {
              const config = await getActiveConfiguration();
              if (config.accessoryScopes && (config.accessoryScopes as any[]).length > 0) {
                configScopes = (config.accessoryScopes as any[]).map((s: any) => ({
                  name: s.name,
                  keywords: Array.isArray(s.keywords) ? s.keywords : [],
                  sectionHint: s.sectionHint || "",
                  divisionScope: Array.isArray(s.divisionScope) ? s.divisionScope : [],
                }));
              }
            } catch (e) {
              console.log("[ProjectRetry] Could not load config scopes, using defaults");
            }

            const allAccessoryNames = (configScopes || []).map(s => s.name);
            if (allAccessoryNames.length > 0) {
              const pages = await extractPages(specsBuffer);
              const accessoryMatches = findAccessorySections(
                pages, allAccessoryNames, result.tocBounds, result.sections, configScopes
              );
              for (const match of accessoryMatches) {
                await storage.createAccessoryMatch({
                  sessionId: sessionId || "",
                  scopeName: match.accessoryName,
                  matchedKeyword: match.matchedKeywords.join(", "),
                  context: `${match.sectionNumber} - ${match.title} (pages ${match.start + 1}-${match.end + 1})`,
                  pageNumber: match.start,
                  sectionHint: match.sectionNumber,
                });
              }
              console.log(`[ProjectRetry] Found ${accessoryMatches.length} accessory matches`);
            }

            if (sessionId) {
              await storage.updateSession(sessionId, {
                status: "complete", progress: 100,
                message: `Extracted ${result.sections.length} sections via Spec Extractor`,
              });
            }

            const existingScopes = await getProjectScopes(projectId);
            if (existingScopes.length === 0) {
              for (const section of result.sections) {
                const signage = isSignageSection(section.section);
                await createProjectScope({
                  projectId: projectId,
                  scopeType: section.title || "Unknown",
                  specSectionNumber: section.section,
                  specSectionTitle: section.title,
                  manufacturers: [],
                  modelNumbers: [],
                  materials: [],
                  keywords: [],
                  confidenceScore: 90,
                  isSelected: !signage,
                });
              }
            }

            await updateProject(projectId, { status: "specsift_complete" });

            const plansPath = path.join(folderPath, "Estimate Folder/Bid Documents/Plans", project.plansFilename || "");
            if (fs.existsSync(plansPath) && project.planparserJobId) {
              try {
                await updateProject(projectId, { status: "planparser_baseline_running" });
                const plansBuffer = fs.readFileSync(plansPath);
                await processJob(project.planparserJobId, [
                  { filename: project.plansFilename || "plans.pdf", buffer: plansBuffer }
                ]);
                const completedJob = await planParserStorage.getJob(project.planparserJobId);
                if (completedJob) {
                  await updateProject(projectId, {
                    status: "planparser_baseline_complete",
                    baselineScopeCounts: completedJob.scopeCounts || {},
                    baselineFlaggedPages: completedJob.flaggedPages,
                  });
                } else {
                  await updateProject(projectId, { status: "planparser_baseline_complete" });
                }
              } catch (err) {
                console.error("Plan Parser retry error:", err);
                await updateProject(projectId, { status: "planparser_baseline_error" });
              }
            }
          } catch (err) {
            console.error("Spec Extractor retry error:", err);
            await updateProject(projectId, { status: "specsift_error" });
          }
        })();
      } else if (project.status === "planparser_baseline_error") {
        (async () => {
          try {
            const plansPath = path.join(folderPath, "Estimate Folder/Bid Documents/Plans", project.plansFilename || "");
            if (!fs.existsSync(plansPath) || !project.planparserJobId) {
              return;
            }
            await updateProject(projectId, { status: "planparser_baseline_running" });
            const plansBuffer = fs.readFileSync(plansPath);
            await processJob(project.planparserJobId, [
              { filename: project.plansFilename || "plans.pdf", buffer: plansBuffer }
            ]);
            const completedJob = await planParserStorage.getJob(project.planparserJobId);
            if (completedJob) {
              await updateProject(projectId, {
                status: "planparser_baseline_complete",
                baselineScopeCounts: completedJob.scopeCounts || {},
                baselineFlaggedPages: completedJob.flaggedPages,
              });
            } else {
              await updateProject(projectId, { status: "planparser_baseline_complete" });
            }
          } catch (err) {
            console.error("Plan Parser retry error:", err);
            await updateProject(projectId, { status: "planparser_baseline_error" });
          }
        })();
      } else if (project.status === "planparser_specpass_error") {
        (async () => {
          try {
            if (!project.planparserJobId) return;
            const scopes = await getProjectScopes(projectId);
            const selectedScopes = scopes.filter(s => s.isSelected);
            if (selectedScopes.length === 0) return;

            const specBoosts: SpecBoostData[] = selectedScopes.map(scope => ({
              scopeType: scope.scopeType,
              manufacturers: (scope.manufacturers as string[]) || [],
              modelNumbers: (scope.modelNumbers as string[]) || [],
              materials: (scope.materials as string[]) || [],
              specSectionNumber: scope.specSectionNumber,
            }));

            await updateProject(projectId, { status: "planparser_specpass_running" });
            await reprocessJobWithSpecBoost(project.planparserJobId, specBoosts);
            await updateProject(projectId, { status: "outputs_ready" });
          } catch (err) {
            console.error("Spec-pass retry error:", err);
            await updateProject(projectId, { status: "planparser_specpass_error" });
          }
        })();
      }
    } catch (error) {
      console.error("Retry error:", error);
      res.status(500).json({ message: "Failed to retry processing" });
    }
  });

  app.get("/api/projects/:id/bookmarked-pdf", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.planparserJobId) return res.status(400).json({ message: "No Plan Parser job for this project" });

      const job = await planParserStorage.getJob(project.planparserJobId);
      if (!job || job.status !== "complete") return res.status(400).json({ message: "Plan Parser job not complete" });

      const pages = await planParserStorage.getPagesByJob(project.planparserJobId);
      const relevantPages = pages.filter(p => p.isRelevant);
      if (relevantPages.length === 0) return res.status(400).json({ message: "No relevant pages to export" });

      const jobDir = planParserStorage.getJobDirectory(project.planparserJobId);
      const pdfsDir = path.join(jobDir, "pdfs");
      if (!fs.existsSync(pdfsDir)) return res.status(400).json({ message: "Original PDFs not available" });

      const pagesByScope: Record<string, { filename: string; pageNumber: number }[]> = {};
      for (const page of relevantPages) {
        for (const tag of page.tags) {
          if (!pagesByScope[tag]) pagesByScope[tag] = [];
          pagesByScope[tag].push({ filename: page.originalFilename, pageNumber: page.pageNumber });
        }
      }

      const pdfCache: Record<string, PDFDocument> = {};
      const loadPdf = async (filename: string): Promise<PDFDocument | null> => {
        if (pdfCache[filename]) return pdfCache[filename];
        const pdfPath = path.join(pdfsDir, filename);
        if (!fs.existsSync(pdfPath)) return null;
        try {
          const pdfBytes = fs.readFileSync(pdfPath);
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          pdfCache[filename] = doc;
          return doc;
        } catch { return null; }
      };

      const masterPdf = await PDFDocument.create();
      const outlineItems: { title: string; pageIndex: number }[] = [];
      let currentPageIndex = 0;

      const sortedScopes = Object.keys(pagesByScope).sort();
      for (const scope of sortedScopes) {
        const scopePages = pagesByScope[scope].sort((a, b) => a.pageNumber - b.pageNumber);
        outlineItems.push({ title: scope, pageIndex: currentPageIndex });

        for (const sp of scopePages) {
          const srcDoc = await loadPdf(sp.filename);
          if (!srcDoc) continue;
          const pageIdx = sp.pageNumber - 1;
          if (pageIdx < 0 || pageIdx >= srcDoc.getPageCount()) continue;
          try {
            const [copied] = await masterPdf.copyPages(srcDoc, [pageIdx]);
            masterPdf.addPage(copied);
            currentPageIndex++;
          } catch (err) {
            console.error(`Failed to copy page ${sp.pageNumber} from ${sp.filename}:`, err);
          }
        }
      }

      if (masterPdf.getPageCount() === 0) {
        return res.status(400).json({ message: "No pages could be assembled" });
      }

      if (outlineItems.length > 0) {
        const context = masterPdf.context;
        const outlinesDictRef = context.nextRef();
        const itemRefs = outlineItems.map(() => context.nextRef());

        for (let i = 0; i < outlineItems.length; i++) {
          const item = outlineItems[i];
          const pageRef = masterPdf.getPage(item.pageIndex).ref;

          const destArray = context.obj([pageRef, PDFName.of("Fit")]);

          const itemDict = context.obj({});
          itemDict.set(PDFName.of("Title"), PDFString.of(item.title));
          itemDict.set(PDFName.of("Parent"), outlinesDictRef);
          itemDict.set(PDFName.of("Dest"), destArray);

          if (i > 0) itemDict.set(PDFName.of("Prev"), itemRefs[i - 1]);
          if (i < outlineItems.length - 1) itemDict.set(PDFName.of("Next"), itemRefs[i + 1]);

          context.assign(itemRefs[i], itemDict);
        }

        const outlinesDict = context.obj({});
        outlinesDict.set(PDFName.of("Type"), PDFName.of("Outlines"));
        outlinesDict.set(PDFName.of("First"), itemRefs[0]);
        outlinesDict.set(PDFName.of("Last"), itemRefs[outlineItems.length - 1]);
        outlinesDict.set(PDFName.of("Count"), PDFNumber.of(outlineItems.length));
        context.assign(outlinesDictRef, outlinesDict);
        masterPdf.catalog.set(PDFName.of("Outlines"), outlinesDictRef);
      }

      const pdfBytes = await masterPdf.save();
      const sanitizedName = sanitizeForWindows(`${project.regionCode}_${project.projectName}`).replace(/\s+/g, "_");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizedName}_Plans_Bookmarked.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (error) {
      console.error("Bookmarked PDF export error:", error);
      res.status(500).json({ message: "Failed to generate bookmarked PDF" });
    }
  });

  app.get("/api/projects/:id/scope-pdf/:scopeName", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const scopeName = decodeURIComponent(req.params.scopeName);

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.planparserJobId) return res.status(400).json({ message: "No Plan Parser job for this project" });

      const job = await planParserStorage.getJob(project.planparserJobId);
      if (!job || job.status !== "complete") return res.status(400).json({ message: "Plan Parser job not complete" });

      const pages = await planParserStorage.getPagesByJob(project.planparserJobId);
      const scopePages = pages
        .filter(p => p.isRelevant && p.tags.includes(scopeName))
        .sort((a, b) => a.pageNumber - b.pageNumber);

      if (scopePages.length === 0) return res.status(404).json({ message: `No pages found for scope: ${scopeName}` });

      const jobDir = planParserStorage.getJobDirectory(project.planparserJobId);
      const pdfsDir = path.join(jobDir, "pdfs");
      if (!fs.existsSync(pdfsDir)) return res.status(400).json({ message: "Original PDFs not available" });

      const pdfCache: Record<string, PDFDocument> = {};
      const loadPdf = async (filename: string): Promise<PDFDocument | null> => {
        if (pdfCache[filename]) return pdfCache[filename];
        const pdfPath = path.join(pdfsDir, filename);
        if (!fs.existsSync(pdfPath)) return null;
        try {
          const pdfBytes = fs.readFileSync(pdfPath);
          const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          pdfCache[filename] = doc;
          return doc;
        } catch { return null; }
      };

      const scopePdf = await PDFDocument.create();
      for (const sp of scopePages) {
        const srcDoc = await loadPdf(sp.originalFilename);
        if (!srcDoc) continue;
        const pageIdx = sp.pageNumber - 1;
        if (pageIdx < 0 || pageIdx >= srcDoc.getPageCount()) continue;
        try {
          const [copied] = await scopePdf.copyPages(srcDoc, [pageIdx]);
          scopePdf.addPage(copied);
        } catch (err) {
          console.error(`Failed to copy page ${sp.pageNumber}:`, err);
        }
      }

      if (scopePdf.getPageCount() === 0) return res.status(400).json({ message: "No pages could be assembled" });

      const pdfBytes = await scopePdf.save();
      const safeScope = sanitizeForWindows(scopeName).replace(/\s+/g, "_");
      const sanitizedProject = sanitizeForWindows(`${project.regionCode}_${project.projectName}`).replace(/\s+/g, "_");

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizedProject}_${safeScope}.pdf"`);
      res.send(Buffer.from(pdfBytes));
    } catch (error) {
      console.error("Scope PDF export error:", error);
      res.status(500).json({ message: "Failed to generate scope PDF" });
    }
  });

  app.get("/api/projects/:id/plan-pages", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });
      if (!project.planparserJobId) return res.status(400).json({ message: "No Plan Parser job for this project" });

      const pages = await planParserStorage.getPagesByJob(project.planparserJobId);
      const pagesWithoutFullText = pages.map(({ ocrText, ...rest }) => ({
        ...rest,
        hasOcrText: ocrText.length > 0,
      }));

      res.json(pagesWithoutFullText);
    } catch (error) {
      console.error("Plan pages fetch error:", error);
      res.status(500).json({ message: "Failed to fetch plan pages" });
    }
  });

  app.get("/api/projects/:id/export", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const zip = new JSZip();
      const projectName = sanitizeForWindows(project.projectName || "Project");
      const rootFolder = `${project.regionCode} - ${projectName}`;

      const scopes = await getProjectScopes(projectId);
      const selectedScopes = scopes.filter(s => s.isSelected);

      if (project.specsiftSessionId) {
        const sections = await storage.getSectionsBySession(project.specsiftSessionId);
        const pdfBuffer = await storage.getPdfBuffer(project.specsiftSessionId);

        if (sections.length > 0 && pdfBuffer) {
          let sourcePdf: PDFDocument;
          try {
            sourcePdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
          } catch {
            sourcePdf = await PDFDocument.load(pdfBuffer);
          }

          for (const section of sections) {
            const sStart = section.startPage ?? section.pageNumber;
            if (sStart !== undefined) {
              try {
                const packet = await PDFDocument.create();
                const totalPages = sourcePdf.getPageCount();
                const start = Math.max(0, sStart - 1);
                const end = Math.min(totalPages - 1, (section.endPage ?? sStart) - 1);

                const pageIndices: number[] = [];
                for (let i = start; i <= end; i++) {
                  pageIndices.push(i);
                }

                if (pageIndices.length > 0) {
                  const copiedPages = await packet.copyPages(sourcePdf, pageIndices);
                  copiedPages.forEach(p => packet.addPage(p));
                  const pdfBytes = await packet.save();
                  const safeTitle = sanitizeForWindows(section.title);
                  zip.file(
                    `${rootFolder}/Estimate Folder/Vendors/Specs Extracts/${section.sectionNumber} - ${safeTitle}.pdf`,
                    pdfBytes
                  );
                }
              } catch (err) {
                console.error(`Failed to extract section ${section.sectionNumber}:`, err);
              }
            }
          }
        }

        if (sections.length > 0) {
          const summaryLines = sections.map(s => {
            const mfrs = (s.manufacturers || []).join(", ");
            const models = (s.modelNumbers || []).join(", ");
            const mats = (s.materials || []).join(", ");
            let line = `${s.sectionNumber} - ${s.title}`;
            if (s.startPage) line += ` (Pages ${s.startPage}-${s.endPage || s.startPage})`;
            if (mfrs) line += `\n  Manufacturers: ${mfrs}`;
            if (models) line += `\n  Models: ${models}`;
            if (mats) line += `\n  Materials: ${mats}`;
            return line;
          });
          zip.file(
            `${rootFolder}/Estimate Folder/Vendors/Specs Extracts/_Spec_Summary.txt`,
            `Spec Extractor Summary\nProject: ${project.projectName}\nProject ID: ${project.projectId}\nRegion: ${project.regionCode}\n\n${summaryLines.join("\n\n")}\n`
          );
        }
      }

      if (project.planparserJobId) {
        const job = await planParserStorage.getJob(project.planparserJobId);
        if (job && job.status === "complete") {
          const pages = await planParserStorage.getPagesByJob(project.planparserJobId);
          const relevantPages = pages.filter(p => p.isRelevant);

          if (relevantPages.length > 0) {
            const jobDir = planParserStorage.getJobDirectory(project.planparserJobId);
            const pdfsDir = path.join(jobDir, "pdfs");

            if (fs.existsSync(pdfsDir)) {
              const pagesByScope: Record<string, { filename: string; pageNumber: number }[]> = {};

              for (const page of relevantPages) {
                for (const tag of page.tags) {
                  if (!pagesByScope[tag]) pagesByScope[tag] = [];
                  pagesByScope[tag].push({
                    filename: page.originalFilename,
                    pageNumber: page.pageNumber,
                  });
                }
              }

              const pdfCache: Record<string, PDFDocument> = {};
              const loadPdf = async (filename: string): Promise<PDFDocument | null> => {
                if (pdfCache[filename]) return pdfCache[filename];
                const pdfPath = path.join(pdfsDir, filename);
                if (!fs.existsSync(pdfPath)) return null;
                try {
                  const pdfBytes = fs.readFileSync(pdfPath);
                  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                  pdfCache[filename] = doc;
                  return doc;
                } catch {
                  return null;
                }
              };

              for (const [scope, scopePages] of Object.entries(pagesByScope)) {
                if (scopePages.length === 0) continue;
                try {
                  const scopePdf = await PDFDocument.create();
                  const sorted = scopePages.sort((a, b) => a.pageNumber - b.pageNumber);

                  for (const sp of sorted) {
                    const srcDoc = await loadPdf(sp.filename);
                    if (!srcDoc) continue;
                    const pageIdx = sp.pageNumber - 1;
                    if (pageIdx < 0 || pageIdx >= srcDoc.getPageCount()) continue;
                    const [copied] = await scopePdf.copyPages(srcDoc, [pageIdx]);
                    scopePdf.addPage(copied);
                  }

                  if (scopePdf.getPageCount() > 0) {
                    const pdfBytes = await scopePdf.save();
                    const safeScope = sanitizeForWindows(scope);
                    zip.file(
                      `${rootFolder}/Estimate Folder/Vendors/Plan Pages by Scope/${safeScope}.pdf`,
                      pdfBytes
                    );
                  }
                } catch (err) {
                  console.error(`Failed to build scope PDF for ${scope}:`, err);
                }
              }
            }

            const planSummaryLines = [`Plan Parser Results`, `Total Pages: ${job.totalPages}`, `Relevant Pages: ${relevantPages.length}`, ``];
            const scopeCounts = job.scopeCounts || {};
            for (const [scope, count] of Object.entries(scopeCounts)) {
              if (count > 0) planSummaryLines.push(`  ${scope}: ${count} page${count !== 1 ? "s" : ""}`);
            }
            zip.file(
              `${rootFolder}/Estimate Folder/Vendors/Plan Pages by Scope/_Plan_Summary.txt`,
              planSummaryLines.join("\n") + "\n"
            );
          }
        }
      }

      const projectSummary = [
        `Project Export Summary`,
        `Project: ${project.projectName}`,
        `Project ID: ${project.projectId}`,
        `Region: ${project.regionCode}`,
        `Due Date: ${project.dueDate}`,
        `Status: ${project.status}`,
        `Created: ${project.createdAt}`,
        ``,
        `Scopes (${selectedScopes.length} selected):`,
        ...selectedScopes.map(s => `  - ${s.specSectionNumber || ""} ${s.scopeType}`),
      ];
      zip.file(`${rootFolder}/_Project_Summary.txt`, projectSummary.join("\n") + "\n");

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      const sanitizedName = sanitizeForWindows(`${project.regionCode}_${project.projectName}`).replace(/\s+/g, "_");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizedName}_Export.zip"`);
      res.send(zipBuffer);
    } catch (error) {
      console.error("Project export error:", error);
      res.status(500).json({ message: "Failed to export project" });
    }
  });

  app.get("/api/projects/:id/download-folder", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      const projectDir = project.folderPath;
      if (!projectDir || !fs.existsSync(projectDir)) {
        return res.status(404).json({ message: "Project folder not found on disk" });
      }

      const zip = new JSZip();

      const addDirToZip = (dirPath: string, zipFolder: JSZip) => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            const subFolder = zipFolder.folder(entry.name)!;
            addDirToZip(fullPath, subFolder);
          } else {
            zipFolder.file(entry.name, fs.readFileSync(fullPath));
          }
        }
      };

      const safeName = sanitizeForWindows(project.projectName || "Project");
      const folderName = `${project.regionCode} - ${safeName}`;
      const rootFolder = zip.folder(folderName)!;
      addDirToZip(projectDir, rootFolder);

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });

      const sanitizedZipName = sanitizeForWindows(`${project.regionCode}_${safeName}`).replace(/\s+/g, "_");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizedZipName}_Folder.zip"`);
      res.send(zipBuffer);
    } catch (error) {
      console.error("Project folder download error:", error);
      res.status(500).json({ message: "Failed to download project folder" });
    }
  });

  app.get("/api/projects/:id/download-estimate", async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) return res.status(400).json({ message: "Invalid project ID" });

      const project = await getProjectById(projectId);
      if (!project) return res.status(404).json({ message: "Project not found" });

      // Get active estimate template
      const templateResult = await db
        .select()
        .from(estimateTemplates)
        .where(eq(estimateTemplates.isActive, true))
        .limit(1);

      if (templateResult.length === 0) {
        return res.status(404).json({ message: "No active estimate template found" });
      }

      const template = templateResult[0];
      const templateBuffer = template.fileData 
        ? Buffer.from(template.fileData, "base64")
        : (template.filePath && fs.existsSync(template.filePath) ? fs.readFileSync(template.filePath) : null);

      if (!templateBuffer) {
        return res.status(404).json({ message: "Template file not found" });
      }

      // Load template with ExcelJS
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(templateBuffer);

      // Get proposal log entry to retrieve additional fields
      const proposalEntry = project.id 
        ? (await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.projectDbId, project.id)).limit(1))[0]
        : null;

      // Prepare the 6 fields to populate
      const summarySheet = workbook.getWorksheet("Summary Sheet");
      if (summarySheet) {
        // B1: Project Name
        if (project.projectName) summarySheet.getCell("B1").value = project.projectName;
        
        // B2: BID DUE DATE
        if (project.dueDate) summarySheet.getCell("B2").value = project.dueDate;
        
        // B4: SHIP TO (Project Address)
        if (project.projectAddress) summarySheet.getCell("B4").value = project.projectAddress;
        
        // B6: GC ESTIMATOR (Self Perform Estimator Name)
        if (proposalEntry?.selfPerformEstimator) summarySheet.getCell("B6").value = proposalEntry.selfPerformEstimator;
        
        // B12: PROJECT START DATE
        if (proposalEntry?.anticipatedStart) summarySheet.getCell("B12").value = proposalEntry.anticipatedStart;
        
        // B13: PROJECT END DATE
        if (proposalEntry?.anticipatedFinish) summarySheet.getCell("B13").value = proposalEntry.anticipatedFinish;
      }

      // Generate Excel file
      const excelBuffer = await workbook.xlsx.writeBuffer();

      const safeName = sanitizeForWindows(project.projectName || "Project");
      const filename = `${project.regionCode}_${project.projectId}_${safeName}_Estimate.xlsx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(excelBuffer);
    } catch (error) {
      console.error("Project estimate download error:", error);
      res.status(500).json({ message: "Failed to download estimate" });
    }
  });

  app.get("/api/bc-sync-table/all-entries", async (req: Request, res: Response) => {
    try {
      const entries = await getAllProposalLogEntries();
      res.json(entries);
    } catch (error) {
      console.error("Failed to get all proposal log entries:", error);
      res.status(500).json({ message: "Failed to get entries" });
    }
  });

  app.get("/api/bc-sync-table/entries", async (req: Request, res: Response) => {
    try {
      const entries = await getActiveProposalLogEntries();
      res.json(entries);
    } catch (error) {
      console.error("Failed to get proposal log entries:", error);
      res.status(500).json({ message: "Failed to get proposal log entries" });
    }
  });

  // POST /api/bc-sync-table/check-duplicate — fuzzy match a project name against existing entries
  app.post("/api/bc-sync-table/check-duplicate", async (req: Request, res: Response) => {
    try {
      const { projectName } = req.body;
      if (!projectName || typeof projectName !== "string") {
        return res.status(400).json({ message: "projectName required" });
      }
      const matches = await findFuzzyDuplicates(projectName);
      res.json({ matches });
    } catch (err) {
      console.error("Duplicate check error:", err);
      res.status(500).json({ message: "Duplicate check failed" });
    }
  });

  // POST /api/bc-sync-table/entries/:id/add-bid-round — append a bid round to an existing entry
  app.post("/api/bc-sync-table/entries/:id/add-bid-round", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const userId = (req.session as any)?.userId;
      const addedBy = await resolveChangedByName(userId);
      const { nbsEstimator, proposalTotal, estimateStatus, dueDate, notes } = req.body;

      const [existing] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!existing) return res.status(404).json({ message: "Entry not found" });

      const currentRounds: any[] = Array.isArray(existing.bidRounds) ? existing.bidRounds : [];
      const newRound = {
        roundNumber: currentRounds.length + 1,
        addedAt: new Date().toISOString(),
        addedBy,
        nbsEstimator: nbsEstimator || null,
        proposalTotal: proposalTotal || null,
        estimateStatus: estimateStatus || null,
        dueDate: dueDate || null,
        notes: notes || null,
      };

      const updatedRounds = [...currentRounds, newRound];
      const topLevelUpdates: Record<string, any> = { bidRounds: updatedRounds };
      if (proposalTotal !== undefined && proposalTotal !== null) topLevelUpdates.proposalTotal = proposalTotal;
      if (estimateStatus) topLevelUpdates.estimateStatus = estimateStatus;
      if (nbsEstimator) topLevelUpdates.nbsEstimator = nbsEstimator;
      if (dueDate) topLevelUpdates.dueDate = dueDate;

      const [updated] = await db.update(proposalLogEntries).set(topLevelUpdates).where(eq(proposalLogEntries.id, id)).returning();
      res.json(updated);
    } catch (err) {
      console.error("Add bid round error:", err);
      res.status(500).json({ message: "Failed to add bid round" });
    }
  });

  app.post("/api/bc-sync-table/entries/bulk", async (req: Request, res: Response) => {
    try {
      const { entries, checkDuplicates } = req.body;
      if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ message: "entries array required" });
      }

      if (checkDuplicates) {
        // Run fuzzy check on each row — separate clean vs flagged
        const cleanEntries: any[] = [];
        const flaggedEntries: Array<{ row: any; matches: any[] }> = [];
        for (const entry of entries) {
          const matches = await findFuzzyDuplicates(entry.projectName || "");
          if (matches.length > 0) {
            flaggedEntries.push({ row: entry, matches });
          } else {
            cleanEntries.push(entry);
          }
        }
        // Insert clean rows immediately
        const created = cleanEntries.length > 0 ? await bulkCreateProposalLogEntries(cleanEntries) : [];
        const userId = (req.session as any)?.userId;
        const changedBy = await resolveChangedByName(userId);
        for (const entry of created) {
          await recordEntryCreation(entry.id, entry.projectName || "", entry.estimateNumber, changedBy).catch(() => {});
        }
        return res.json({ created, flagged: flaggedEntries });
      }

      const created = await bulkCreateProposalLogEntries(entries);
      const userId = (req.session as any)?.userId;
      const changedBy = await resolveChangedByName(userId);
      for (const entry of created) {
        await recordEntryCreation(entry.id, entry.projectName || "", entry.estimateNumber, changedBy).catch(() => {});
      }
      res.json(created);
    } catch (error) {
      console.error("Failed to bulk create proposal log entries:", error);
      res.status(500).json({ message: "Failed to bulk create entries" });
    }
  });

  app.get("/api/bc-sync-table/unsynced", async (req: Request, res: Response) => {
    try {
      const entries = await getUnsyncedEntries();
      res.json(entries);
    } catch (error) {
      console.error("Failed to get unsynced entries:", error);
      res.status(500).json({ message: "Failed to get unsynced entries" });
    }
  });

  app.post("/api/bc-sync-table/mark-synced", async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) return res.status(400).json({ message: "ids array required" });
      await markEntriesSynced(ids);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to mark entries synced:", error);
      res.status(500).json({ message: "Failed to mark entries synced" });
    }
  });

  app.get("/api/bc-sync-table/estimating-projects", async (_req: Request, res: Response) => {
    try {
      const entries = await getActiveProposalLogEntries();
      const estimating = entries
        .filter((e: any) => e.estimateStatus === "Estimating" || e.estimateStatus === "Revising")
        .map((e: any) => ({
          id: e.id,
          projectName: e.projectName || "",
          estimateNumber: e.estimateNumber || "",
        }))
        .filter((e: any) => e.projectName.trim() !== "");
      res.json(estimating);
    } catch (error) {
      console.error("Failed to get estimating projects:", error);
      res.status(500).json({ message: "Failed to get estimating projects" });
    }
  });

  app.patch("/api/bc-sync-table/entry/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });

      const allowedFields = [
        "projectName",
        "owner",
        "nbsEstimator",
        "estimateStatus",
        "proposalTotal",
        "gcEstimateLead",
        "selfPerformEstimator",
        "anticipatedStart",
        "anticipatedFinish",
        "dueDate",
        "inviteDate",
        "notes",
        "bcLink",
        "nbsSelectedScopes",
        "scopeList",
        "finalReviewer",
        "swinertonProject",
        "region",
        "primaryMarket",
        "filePath",
        "screenshotPath",
        "projectDbId",
        "bcProjectId",
        "sourceType",
        "sourceEmail",
        "sourceEmailSubject",
        "sourceAttachmentUrl",
      ];
      const updates: Record<string, string> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      const userId = (req.session as any)?.userId;

      if (Object.keys(updates).length === 0 && req.body.estimateNumber === undefined) {
        return res.status(400).json({ message: "No valid fields to update" });
      }

      const [existingEntry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!existingEntry) {
        return res.status(404).json({ message: "Entry not found" });
      }

      // estimateNumber is admin-only — only enforce if the value is actually changing
      if (req.body.estimateNumber !== undefined) {
        const incomingEstNum = String(req.body.estimateNumber || "").trim();
        const currentEstNum = String(existingEntry.estimateNumber || "").trim();
        if (incomingEstNum !== currentEstNum) {
          if (!userId) {
            return res.status(401).json({ message: "Not authenticated" });
          }
          const [u] = await db.select().from(users).where(eq(users.id, userId));
          if (!u || u.role !== "admin") {
            return res.status(403).json({ message: "Only admins can change estimate numbers" });
          }
          updates.estimateNumber = req.body.estimateNumber;
        }
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ message: "No valid fields to update" });
      }

      // Proposal log entries are a shared team resource — any authenticated user may edit.
      // Admin-only operations (estimateNumber changes, deletions) are gated separately.
      if (!userId) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      let oldEstimator: string | null = null;
      if (updates.nbsEstimator !== undefined) {
        oldEstimator = existingEntry.nbsEstimator;
        const oldEst = (oldEstimator || "").trim();
        const newEst = (updates.nbsEstimator || "").trim();
        if (newEst !== oldEst) {
          await clearAcknowledgementsForEntry(id);
        }
      }

      if (updates.region !== undefined && updates.selfPerformEstimator === undefined) {
        try {
          const oldRegion = (existingEntry.region || "").trim();
          const newRegion = (updates.region || "").trim();
          if (newRegion !== oldRegion) {
            const rm = newRegion.match(/^([A-Z]{2,5})\s*-\s*(.+)$/);
            let regionCode = "";
            let regionName = "";
            if (rm) {
              regionCode = rm[1];
              regionName = rm[2];
            } else if (/^[A-Z]{2,5}$/.test(newRegion)) {
              regionCode = newRegion;
            }
            if (regionCode) {
              const matchingRegions = await db.select().from(regions)
                .where(eq(regions.code, regionCode));
              const target = regionName
                ? (matchingRegions.find(r => r.name === regionName) || matchingRegions[0])
                : matchingRegions[0];
              if (target && target.selfPerformEstimators && target.selfPerformEstimators.length > 0) {
                updates.selfPerformEstimator = target.selfPerformEstimators[0];
              }
            }
          }
        } catch (err) {
          console.error("[SP Estimator] Failed to auto-populate from region:", err);
        }
      }

      if (updates.proposalTotal !== undefined && updates.estimateStatus === undefined) {
        const currentStatus = existingEntry.estimateStatus || "";
        if (!TERMINAL_ESTIMATE_STATUSES.includes(currentStatus)) {
          const hasTotal = updates.proposalTotal.replace(/[^0-9.]/g, '');
          if (hasTotal && Number(hasTotal) > 0) {
            updates.estimateStatus = "Submitted";
          } else {
            updates.estimateStatus = "Estimating";
          }
        }
      }

      const changedByName = await resolveChangedByName(userId);

      const updated = await updateProposalLogEntryById(id, updates);
      if (!updated) {
        return res.status(404).json({ message: "Entry not found" });
      }

      await recordFieldChanges(id, existingEntry as Record<string, unknown>, updates, changedByName);

      if (updates.estimateStatus === "Won" && existingEntry.estimateStatus !== "Won") {
        (async () => {
          try {
            const adminUsers = await db.select().from(users).where(eq(users.role, "admin"));

            const recipientEmails = new Set<string>();
            const recipientUserIds = new Set<number>();

            for (const admin of adminUsers) {
              if (admin.email) recipientEmails.add(admin.email.toLowerCase());
              if (admin.id) recipientUserIds.add(admin.id);
            }

            const rawEstimator = (updated.nbsEstimator || "").trim();
            if (rawEstimator) {
              const estimatorTokens = rawEstimator
                .split(/[,;/|]+/)
                .map((t) => t.trim().toUpperCase())
                .filter(Boolean);

              for (const initials of estimatorTokens) {
                const [estimatorUser] = await db.select().from(users).where(eq(users.initials, initials));
                if (estimatorUser?.email) {
                  recipientEmails.add(estimatorUser.email.toLowerCase());
                  if (estimatorUser.id) recipientUserIds.add(estimatorUser.id);
                }
              }
            }

            const wonDetails = {
              projectName: updated.projectName || "",
              estimateNumber: updated.estimateNumber || "",
              proposalTotal: updated.proposalTotal || "",
              gcLead: updated.gcEstimateLead || "",
              dueDate: updated.dueDate || "",
            };

            await sendProjectWonEmail(Array.from(recipientEmails), wonDetails);

            const notifTitle = "Project Won";
            const notifMessage = `${updated.projectName || "A project"} has been marked as Won.${updated.estimateNumber ? ` Estimate #${updated.estimateNumber}.` : ""}${updated.proposalTotal ? ` Total: ${updated.proposalTotal}.` : ""}`;

            for (const uid of recipientUserIds) {
              await createNotification({
                userId: uid,
                type: "project_won",
                title: notifTitle,
                message: notifMessage,
                metadata: {
                  projectId: id,
                  projectName: updated.projectName,
                  estimateNumber: updated.estimateNumber,
                  proposalTotal: updated.proposalTotal,
                  gcLead: updated.gcEstimateLead,
                },
              });
            }
          } catch (err) {
            console.error("[ProjectWon] Failed to send won notifications:", err);
          }
        })();
      }

      if (
        updates.selfPerformEstimator !== undefined &&
        updates.selfPerformEstimator &&
        updated.region &&
        req.body._addSpToRegion === true
      ) {
        try {
          const newSp = (updates.selfPerformEstimator as string).trim();
          if (newSp) {
            const regionStr = (updated.region || "").trim();
            const rm = regionStr.match(/^([A-Z]{2,5})\s*-\s*(.+)$/);
            let regionCode = "";
            let regionName = "";
            if (rm) {
              regionCode = rm[1];
              regionName = rm[2];
            } else if (/^[A-Z]{2,5}$/.test(regionStr)) {
              regionCode = regionStr;
            }
            if (regionCode) {
              const matchingRegions = await db.select().from(regions)
                .where(eq(regions.code, regionCode));
              const target = regionName
                ? (matchingRegions.find(r => r.name === regionName) || matchingRegions[0])
                : matchingRegions[0];
              if (target) {
                const existing = target.selfPerformEstimators || [];
                const alreadyExists = existing.some(
                  (e: string) => e.toLowerCase() === newSp.toLowerCase()
                );
                if (!alreadyExists) {
                  await db.update(regions)
                    .set({ selfPerformEstimators: [newSp, ...existing] })
                    .where(eq(regions.id, target.id));
                }
              }
            }
          }
        } catch (err) {
          console.error("[SP Estimator] Failed to append to region:", err);
        }
      }

      if (updates.nbsEstimator !== undefined) {
        const newEstimator = updates.nbsEstimator?.trim() || null;
        const oldEst = oldEstimator?.trim() || null;

        if (newEstimator && newEstimator !== oldEst) {
          (async () => {
            try {
              const initials = newEstimator.toUpperCase();
              let email: string | null = null;
              let displayName: string = initials;

              const [estimatorUser] = await db.select().from(users).where(eq(users.initials, initials));
              if (estimatorUser?.email) {
                email = estimatorUser.email;
                displayName = estimatorUser.displayName || initials;
              }

              if (email) {
                await sendBidAssignmentEmail(email, displayName, {
                  estimatorInitials: initials,
                  projectName: updated.projectName,
                  estimateNumber: updated.estimateNumber || "",
                  dueDate: updated.dueDate || "",
                  gcLead: updated.gcEstimateLead || "",
                });
              } else {
                console.log(`[Email] No user found for estimator initials: ${initials}`);
              }
            } catch (err) {
              console.error("[Email] Failed to send bid assignment email:", err);
            }
          })();
        }
      }

      console.log(`[ProposalLog] Updated entry id=${id}:`, updates);
      res.json({ success: true, entry: updated });
    } catch (error) {
      console.error("Failed to update proposal log entry:", error);
      res.status(500).json({ message: "Failed to update entry" });
    }
  });

  app.delete("/api/bc-sync-table/entry/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });

      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      // Only admins may delete
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") {
        return res.status(403).json({ message: "Admin access required to delete proposals" });
      }

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!entry) return res.status(404).json({ message: "Entry not found" });

      const deleted = await deleteProposalLogEntry(id);
      if (!deleted) return res.status(404).json({ message: "Entry not found" });

      const changedBy = u.initials || u.displayName || u.email;
      await recordEntryDeletion(id, deleted.projectName || "", deleted.estimateNumber, changedBy).catch(() => {});

      console.log(`[ProposalLog] Deleted entry id=${id} by ${changedBy}, project: ${deleted.projectName}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to delete proposal log entry:", error);
      res.status(500).json({ message: "Failed to delete entry" });
    }
  });

  app.post("/api/bc-sync-table/delete-bulk", async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ message: "ids array required" });
      }
      const numericIds = ids.map((id: any) => parseInt(id)).filter((id: number) => !isNaN(id));

      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      // Only admins may bulk delete
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") {
        return res.status(403).json({ message: "Admin access required to delete proposals" });
      }

      // Snapshot entries before deletion so we can log them
      const entries = await db.select().from(proposalLogEntries).where(sql`id = ANY(${numericIds})`);

      const count = await deleteProposalLogEntries(numericIds);

      const changedBy = u.initials || u.displayName || u.email;
      for (const entry of entries) {
        await recordEntryDeletion(entry.id, entry.projectName || "", entry.estimateNumber, changedBy).catch(() => {});
      }

      console.log(`[ProposalLog] Bulk deleted ${count} entries by ${changedBy}`);
      res.json({ success: true, deleted: count });
    } catch (error) {
      console.error("Failed to bulk delete proposal log entries:", error);
      res.status(500).json({ message: "Failed to bulk delete entries" });
    }
  });

  // Request deletion (any authenticated user)
  app.post("/api/bc-sync-table/entry/:id/request-delete", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });

      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u) return res.status(401).json({ message: "User not found" });

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!entry) return res.status(404).json({ message: "Entry not found" });
      if (entry.pendingDeletion) return res.status(409).json({ message: "Deletion already requested for this entry" });

      const requestedBy = u.initials || u.displayName || u.email;
      const updated = await requestDeleteEntry(id, requestedBy);
      if (!updated) return res.status(404).json({ message: "Entry not found" });

      await recordDeletionRequested(id, entry.projectName || "", entry.estimateNumber, requestedBy).catch(() => {});

      await createNotificationForAdmins({
        type: "deletion_request",
        title: "Deletion Request",
        message: `${requestedBy} requested deletion of "${entry.projectName || entry.estimateNumber || `Entry #${id}`}"`,
        metadata: { entryId: id, projectName: entry.projectName, estimateNumber: entry.estimateNumber, requestedBy },
      }).catch(() => {});

      console.log(`[ProposalLog] Deletion requested for entry id=${id} by ${requestedBy}`);
      res.json({ success: true, pendingDeletion: true, pendingDeletionBy: requestedBy });
    } catch (error) {
      console.error("Failed to request deletion:", error);
      res.status(500).json({ message: "Failed to request deletion" });
    }
  });

  // Cancel deletion request (requester or admin)
  app.post("/api/bc-sync-table/entry/:id/cancel-delete", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });

      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u) return res.status(401).json({ message: "User not found" });

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!entry) return res.status(404).json({ message: "Entry not found" });

      const cancelledBy = u.initials || u.displayName || u.email;
      // Admins can cancel any request; users can only cancel their own
      if (u.role !== "admin" && entry.pendingDeletionBy !== cancelledBy) {
        return res.status(403).json({ message: "You can only cancel your own deletion requests" });
      }

      const updated = await cancelDeleteRequest(id);
      if (!updated) return res.status(404).json({ message: "Entry not found" });

      await recordDeleteCancelled(id, entry.projectName || "", entry.estimateNumber, cancelledBy).catch(() => {});

      console.log(`[ProposalLog] Deletion request cancelled for entry id=${id} by ${cancelledBy}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to cancel deletion request:", error);
      res.status(500).json({ message: "Failed to cancel deletion request" });
    }
  });

  // Approve deletion (admin only)
  app.post("/api/bc-sync-table/entry/:id/approve-delete", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });

      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") return res.status(403).json({ message: "Admin access required" });

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!entry) return res.status(404).json({ message: "Entry not found" });

      const deleted = await approveDeleteEntry(id);
      if (!deleted) return res.status(404).json({ message: "Entry not found" });

      const approvedBy = u.initials || u.displayName || u.email;
      await recordEntryDeletion(id, deleted.projectName || "", deleted.estimateNumber, approvedBy).catch(() => {});

      console.log(`[ProposalLog] Deletion approved for entry id=${id} by ${approvedBy}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to approve deletion:", error);
      res.status(500).json({ message: "Failed to approve deletion" });
    }
  });

  // Reject deletion (admin only)
  app.post("/api/bc-sync-table/entry/:id/reject-delete", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });

      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Authentication required" });

      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") return res.status(403).json({ message: "Admin access required" });

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!entry) return res.status(404).json({ message: "Entry not found" });

      const updated = await rejectDeleteEntry(id);
      if (!updated) return res.status(404).json({ message: "Entry not found" });

      const rejectedBy = u.initials || u.displayName || u.email;
      await recordDeletionRejected(id, entry.projectName || "", entry.estimateNumber, rejectedBy).catch(() => {});

      console.log(`[ProposalLog] Deletion rejected for entry id=${id} by ${rejectedBy}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to reject deletion:", error);
      res.status(500).json({ message: "Failed to reject deletion" });
    }
  });

  app.get("/api/bc-sync-table/screenshot/:projectId", async (req: Request, res: Response) => {
    try {
      const projectId = req.params.projectId;

      // 1. Exact match on estimate_number (fixes legacy startsWith prefix-collision bug, e.g. 26-002 vs 26-0020)
      const [entry] = await db.select({
          data: proposalLogEntries.screenshotData,
          mime: proposalLogEntries.screenshotMimeType,
          legacyPath: proposalLogEntries.screenshotPath,
        })
        .from(proposalLogEntries)
        .where(eq(proposalLogEntries.estimateNumber, projectId))
        .limit(1);

      if (!entry) return res.status(404).json({ message: "Screenshot not found" });

      // 2. Primary path: serve from DB (resilient across redeploys)
      if (entry.data) {
        res.setHeader("Content-Type", entry.mime || "image/png");
        res.setHeader("Cache-Control", "private, max-age=300");
        return res.send(entry.data);
      }

      return res.status(404).json({ message: "Screenshot not available" });
    } catch (error) {
      console.error("Failed to serve screenshot:", error);
      res.status(500).json({ message: "Failed to serve screenshot" });
    }
  });

  app.get("/api/bc-sync-table/sheet-url", async (req: Request, res: Response) => {
    try {
      const url = getSheetUrl();
      const configured = isGoogleSheetConfigured();
      res.json({ url, configured });
    } catch (error) {
      console.error("Failed to get sheet URL:", error);
      res.status(500).json({ message: "Failed to get sheet URL" });
    }
  });

  app.post("/api/bc-sync-table/force-sync", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (userId) {
        const [u] = await db.select().from(users).where(eq(users.id, userId));
        if (!u || u.role !== "admin") {
          return res.status(403).json({ message: "Admin access required" });
        }
      }

      if (!isGoogleSheetConfigured()) {
        return res.status(400).json({ message: "Google Sheets integration not configured" });
      }
      const result = await syncProposalLogToSheet();
      res.json(result);
    } catch (error: any) {
      console.error("Failed to force sync:", error);
      res.status(500).json({ message: "Failed to sync", error: error.message });
    }
  });

  app.post("/api/bc-sync-table/google-sheet/import", async (req: Request, res: Response) => {
    try {
      if (!isGoogleSheetConfigured()) {
        return res.status(400).json({ message: "Google Sheets integration not configured" });
      }
      const result = await pullRepairAndPush();
      res.json(result);
    } catch (error: any) {
      console.error("Failed to import from sheet:", error);
      res.status(500).json({ message: "Failed to import from sheet", error: error.message });
    }
  });

  app.get("/api/bc-sync-table/acknowledgements", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const entryIds = await getAcknowledgedEntryIds(userId);
      res.json({ entryIds });
    } catch (error) {
      console.error("Failed to get acknowledgements:", error);
      res.status(500).json({ message: "Failed to get acknowledgements" });
    }
  });

  app.post("/api/bc-sync-table/acknowledge/:entryId", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const entryId = parseInt(req.params.entryId);
      if (isNaN(entryId)) return res.status(400).json({ message: "Valid entry ID required" });
      await acknowledgeEntry(userId, entryId);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to acknowledge entry:", error);
      res.status(500).json({ message: "Failed to acknowledge" });
    }
  });

  app.delete("/api/bc-sync-table/acknowledge/:entryId", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const entryId = parseInt(req.params.entryId);
      if (isNaN(entryId)) return res.status(400).json({ message: "Valid entry ID required" });
      await unacknowledgeEntry(userId, entryId);
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to unacknowledge entry:", error);
      res.status(500).json({ message: "Failed to unacknowledge" });
    }
  });

  app.get("/api/settings/email-template/bid-assignment", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") {
        return res.status(403).json({ message: "Admin access required" });
      }

      const template = await getBidAssignmentTemplate();
      res.json(template);
    } catch (error) {
      console.error("Failed to get email template:", error);
      res.status(500).json({ message: "Failed to get email template" });
    }
  });

  app.get("/api/bc-sync-table/change-history", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") return res.status(403).json({ message: "Admin access required" });

      const { entryId, fieldName, changedBy, fromDate, toDate, projectName, limit: limitStr, offset: offsetStr } = req.query;

      const parsedEntryId = entryId ? parseInt(entryId as string) : null;
      if (entryId && (isNaN(parsedEntryId!) || parsedEntryId! < 1)) {
        return res.status(400).json({ message: "Invalid entryId" });
      }

      let lim = parseInt(limitStr as string) || 200;
      if (lim < 1) lim = 1;
      if (lim > 500) lim = 500;
      let off = parseInt(offsetStr as string) || 0;
      if (off < 0) off = 0;

      const { and, ilike } = await import("drizzle-orm");

      let query = db.select({
        id: proposalChangeLog.id,
        entryId: proposalChangeLog.entryId,
        fieldName: proposalChangeLog.fieldName,
        oldValue: proposalChangeLog.oldValue,
        newValue: proposalChangeLog.newValue,
        changedBy: proposalChangeLog.changedBy,
        changedAt: proposalChangeLog.changedAt,
        projectName: proposalLogEntries.projectName,
        estimateNumber: proposalLogEntries.estimateNumber,
      })
        .from(proposalChangeLog)
        .innerJoin(proposalLogEntries, eq(proposalChangeLog.entryId, proposalLogEntries.id))
        .orderBy(sql`${proposalChangeLog.changedAt} DESC`)
        .$dynamic();

      const conditions: ReturnType<typeof eq>[] = [];
      if (parsedEntryId) conditions.push(eq(proposalChangeLog.entryId, parsedEntryId));
      if (fieldName) conditions.push(eq(proposalChangeLog.fieldName, fieldName as string));
      if (changedBy) conditions.push(eq(proposalChangeLog.changedBy, changedBy as string));
      if (fromDate) conditions.push(sql`${proposalChangeLog.changedAt} >= ${fromDate}::timestamp` as ReturnType<typeof eq>);
      if (toDate) conditions.push(sql`${proposalChangeLog.changedAt} <= ${toDate}::timestamp` as ReturnType<typeof eq>);
      if (projectName) conditions.push(ilike(proposalLogEntries.projectName, `%${projectName}%`) as ReturnType<typeof eq>);

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      query = query.limit(lim).offset(off);

      const rows = await query;
      res.json(rows);
    } catch (error) {
      console.error("Failed to fetch change history:", error);
      res.status(500).json({ message: "Failed to fetch change history" });
    }
  });

  app.put("/api/settings/email-template/bid-assignment", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") {
        return res.status(403).json({ message: "Admin access required" });
      }

      const { subject, greeting, bodyMessage, signOff } = req.body;
      if (!subject || !greeting || !bodyMessage || !signOff) {
        return res.status(400).json({ message: "All template fields are required" });
      }

      await saveBidAssignmentTemplate({ subject, greeting, bodyMessage, signOff });
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to save email template:", error);
      res.status(500).json({ message: "Failed to save email template" });
    }
  });

  app.get("/api/settings/email-template/project-won", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") {
        return res.status(403).json({ message: "Admin access required" });
      }

      const template = await getProjectWonTemplate();
      res.json(template);
    } catch (error) {
      console.error("Failed to get project won email template:", error);
      res.status(500).json({ message: "Failed to get email template" });
    }
  });

  app.put("/api/settings/email-template/project-won", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u || u.role !== "admin") {
        return res.status(403).json({ message: "Admin access required" });
      }

      const { subject, bodyMessage, signOff } = req.body;
      if (!subject || !bodyMessage || !signOff) {
        return res.status(400).json({ message: "All template fields are required" });
      }

      await saveProjectWonTemplate({ subject, bodyMessage, signOff });
      res.json({ success: true });
    } catch (error) {
      console.error("Failed to save project won email template:", error);
      res.status(500).json({ message: "Failed to save email template" });
    }
  });

  // Re-create project bid folder for an existing proposal log entry.
  // Builds the standard folder structure + stamped estimate template in memory
  // and streams the result back as a downloadable .zip file.
  app.post("/api/bc-sync-table/:id/recreate-folder", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid proposal log id" });

      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id)).limit(1);
      if (!entry) return res.status(404).json({ message: "Proposal log entry not found" });

      const projectName = (entry.projectName || "").trim();
      const region = (entry.region || "").trim();
      if (!projectName || !region) {
        return res.status(400).json({ message: "Proposal log entry must have a project name and region" });
      }

      const safeName = sanitizeForWindows(projectName);
      const regionCode = region.toUpperCase();
      const folderName = `${regionCode} - ${safeName}`;

      const outZip = new JSZip();
      const rootFolder = outZip.folder(folderName);
      if (!rootFolder) {
        return res.status(500).json({ message: "Failed to create zip root folder" });
      }

      // Copy folder template contents under the project root (stripping the
      // "0000_Standard Folders" wrapper present in some template versions).
      const activeFolderTemplate = await getActiveFolderTemplate();
      const folderZipBuffer = activeFolderTemplate ? await getFolderTemplateFileBuffer(activeFolderTemplate) : null;
      if (activeFolderTemplate && folderZipBuffer) {
        const tmpl = await JSZip.loadAsync(folderZipBuffer);
        for (const [relativePath, zipEntry] of Object.entries(tmpl.files)) {
          const parts = relativePath.split("/");
          if (parts[0] === "0000_Standard Folders" || parts[0] === "0000_Standard Folder") {
            parts.shift();
          }
          const outputPath = parts.join("/");
          if (!outputPath) continue;
          if (zipEntry.dir) {
            rootFolder.folder(outputPath);
          } else {
            const content = await zipEntry.async("nodebuffer");
            rootFolder.file(outputPath, content);
          }
        }
      }

      // Always ensure the canonical bid subfolders exist, even if the template
      // didn't include them.
      const requiredSubfolders = [
        "Estimate Folder/Bid Documents/Plans",
        "Estimate Folder/Bid Documents/Specs",
        "Estimate Folder/Vendors",
        "Estimate Folder/Estimate",
      ];
      for (const sub of requiredSubfolders) {
        rootFolder.folder(sub);
      }

      // Stamp the estimate template with project info and place it in
      // Estimate Folder/Estimate/.
      let estimateStamped = false;
      const activeEstimateTemplate = await getActiveEstimateTemplate();
      const estimateBuffer = activeEstimateTemplate ? await getEstimateTemplateFileBuffer(activeEstimateTemplate) : null;
      if (activeEstimateTemplate && estimateBuffer) {
        try {
          const ext = path.extname(activeEstimateTemplate.originalFilename || activeEstimateTemplate.filePath) || ".xlsx";
          const dueParts = (entry.dueDate || "").split("-");
          const formattedDueDate = dueParts.length >= 3 ? `${dueParts[1]}.${dueParts[2]}.${dueParts[0].slice(2)}` : "TBD";
          const estimateFilename = `${safeName} - NBS Estimate - ${formattedDueDate}${ext}`;

          let outputBuffer: Buffer;
          if (ext === ".xlsm") {
            // ExcelJS strips macros; preserve the .xlsm template as-is.
            outputBuffer = estimateBuffer;
          } else {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.load(estimateBuffer);
            const summarySheet = workbook.getWorksheet("Summary") || workbook.worksheets[0];
            if (summarySheet) {
              if (safeName) summarySheet.getCell("B1").value = safeName;
              if (entry.dueDate) summarySheet.getCell("B2").value = entry.dueDate;
              if (entry.projectAddress) summarySheet.getCell("B4").value = entry.projectAddress;
              if (entry.gcEstimateLead) summarySheet.getCell("B6").value = entry.gcEstimateLead;
              if (entry.anticipatedStart) summarySheet.getCell("B12").value = entry.anticipatedStart;
              if (entry.anticipatedFinish) summarySheet.getCell("B13").value = entry.anticipatedFinish;
            }
            const arrBuf = await workbook.xlsx.writeBuffer();
            outputBuffer = Buffer.from(arrBuf);
          }

          rootFolder.file(`Estimate Folder/Estimate/${estimateFilename}`, outputBuffer);
          estimateStamped = true;
        } catch (err) {
          console.error("[RecreateFolder] Failed to stamp estimate template:", err);
        }
      }

      const zipBuffer = await outZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

      console.log(`[RecreateFolder] Streamed bid folder zip for proposal log #${id} → ${folderName}.zip (estimate=${estimateStamped}, bytes=${zipBuffer.length})`);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${folderName}.zip"`);
      res.setHeader("Content-Length", String(zipBuffer.length));
      res.end(zipBuffer);
    } catch (error) {
      console.error("Failed to recreate project folder:", error);
      res.status(500).json({ message: "Failed to recreate project folder" });
    }
  });
}
