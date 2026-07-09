import type { Express, Request, Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import { planParserStorage } from "./storage";
import { processJob } from "./pdfProcessor";
import type { PlanParserJob, ParsedPage } from "@shared/schema";
import { PLAN_PARSER_SCOPES } from "@shared/schema";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 10,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

const processingJobs: Map<string, boolean> = new Map();

export function registerPlanParserRoutes(app: Express): void {
  
  app.post("/api/planparser/jobs", async (req: Request, res: Response) => {
    try {
      const ttlHours = 2;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
      
      const job = await planParserStorage.createJob({
        status: "pending",
        totalPages: 0,
        processedPages: 0,
        flaggedPages: 0,
        filenames: [],
        message: "Job created, waiting for files...",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        scopeCounts: {}
      });
      
      res.json(job);
    } catch (error) {
      console.error("Create job error:", error);
      res.status(500).json({ message: "Failed to create job" });
    }
  });
  
  app.post(
    "/api/planparser/jobs/:jobId/upload",
    upload.array("files", 20),
    async (req: Request, res: Response) => {
      try {
        const { jobId } = req.params;
        const job = await planParserStorage.getJob(jobId);
        
        if (!job) {
          return res.status(404).json({ message: "Job not found" });
        }
        
        if (job.status !== "pending") {
          return res.status(400).json({ message: "Job already started" });
        }
        
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) {
          return res.status(400).json({ message: "No files uploaded" });
        }
        
        const jobDir = await planParserStorage.ensureJobDirectory(jobId);
        const pdfsDir = path.join(jobDir, "pdfs");
        if (!fs.existsSync(pdfsDir)) {
          fs.mkdirSync(pdfsDir, { recursive: true });
        }
        
        const pdfBuffers = files.map(f => {
          const pdfPath = path.join(pdfsDir, f.originalname);
          fs.writeFileSync(pdfPath, f.buffer);
          return {
            filename: f.originalname,
            buffer: f.buffer
          };
        });
        
        processingJobs.set(jobId, true);
        
        processJob(jobId, pdfBuffers).finally(() => {
          processingJobs.delete(jobId);
        });
        
        res.json({ message: "Processing started", jobId });
      } catch (error) {
        console.error("Upload error:", error);
        res.status(500).json({ message: "Upload failed" });
      }
    }
  );
  
  app.get("/api/planparser/jobs", async (req: Request, res: Response) => {
    try {
      const jobs = await planParserStorage.getAllJobs();
      res.json(jobs);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch jobs" });
    }
  });
  
  app.get("/api/planparser/jobs/:jobId", async (req: Request, res: Response) => {
    try {
      const job = await planParserStorage.getJob(req.params.jobId);
      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }
      res.json(job);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch job" });
    }
  });
  
  app.get("/api/planparser/jobs/:jobId/pages", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const { relevant, scope, minConfidence } = req.query;
      
      let pages = await planParserStorage.getPagesByJob(jobId);
      
      if (relevant === "true") {
        pages = pages.filter(p => p.isRelevant);
      } else if (relevant === "false") {
        pages = pages.filter(p => !p.isRelevant);
      }
      
      if (scope && typeof scope === "string") {
        pages = pages.filter(p => p.tags.includes(scope));
      }
      
      if (minConfidence && typeof minConfidence === "string") {
        const minConf = parseInt(minConfidence, 10);
        if (!isNaN(minConf)) {
          pages = pages.filter(p => p.confidence >= minConf);
        }
      }
      
      const pagesWithoutFullText = pages.map(({ ocrText, ...rest }) => ({
        ...rest,
        hasOcrText: ocrText.length > 0
      }));
      
      res.json(pagesWithoutFullText);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch pages" });
    }
  });
  
  app.patch("/api/planparser/pages/:pageId", async (req: Request, res: Response) => {
    try {
      const { pageId } = req.params;
      const { isRelevant, tags } = req.body;
      
      const updates: Partial<ParsedPage> = { userModified: true };
      
      if (typeof isRelevant === "boolean") {
        updates.isRelevant = isRelevant;
      }
      
      if (Array.isArray(tags)) {
        updates.tags = tags;
      }
      
      const page = await planParserStorage.updatePage(pageId, updates);
      
      if (!page) {
        return res.status(404).json({ message: "Page not found" });
      }
      
      const allPages = await planParserStorage.getPagesByJob(page.jobId);
      const scopeCounts: Record<string, number> = {};
      let flaggedCount = 0;
      
      for (const p of allPages) {
        if (p.isRelevant) {
          flaggedCount++;
          for (const tag of p.tags) {
            scopeCounts[tag] = (scopeCounts[tag] || 0) + 1;
          }
        }
      }
      
      await planParserStorage.updateJob(page.jobId, {
        flaggedPages: flaggedCount,
        scopeCounts
      });
      
      res.json(page);
    } catch (error) {
      res.status(500).json({ message: "Failed to update page" });
    }
  });
  
  app.delete("/api/planparser/jobs/:jobId", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const deleted = await planParserStorage.deleteJob(jobId);
      
      if (!deleted) {
        return res.status(404).json({ message: "Job not found" });
      }
      
      res.json({ message: "Job deleted" });
    } catch (error) {
      res.status(500).json({ message: "Failed to delete job" });
    }
  });
  
  app.get("/api/planparser/jobs/:jobId/thumbnail/:filename", async (req: Request, res: Response) => {
    try {
      const { jobId, filename } = req.params;
      const jobDir = planParserStorage.getJobDirectory(jobId);
      const thumbnailPath = `${jobDir}/thumbnails/${filename}`;
      
      if (!require("fs").existsSync(thumbnailPath)) {
        return res.status(404).json({ message: "Thumbnail not found" });
      }
      
      res.sendFile(thumbnailPath);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch thumbnail" });
    }
  });

  app.post("/api/planparser/demo", async (req: Request, res: Response) => {
    try {
      const ttlHours = 2;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
      
      const job = await planParserStorage.createJob({
        status: "complete",
        totalPages: 24,
        processedPages: 24,
        flaggedPages: 8,
        filenames: ["Sample_Construction_Plans.pdf"],
        message: "Demo completed",
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        scopeCounts: {
          "Toilet Accessories": 3,
          "Toilet Partitions": 2,
          "Lockers": 1,
          "Fire Extinguisher Cabinets": 1,
          "Wall Protection": 1,
        }
      });

      const demoPages = [
        {
          jobId: job.id,
          pageNumber: 5,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Toilet Accessories"],
          confidence: 92,
          whyFlagged: "Found: grab bar, toilet paper holder, soap dispenser, paper towel dispenser",
          ocrText: "TOILET ACCESSORIES SCHEDULE - GRAB BARS, PAPER DISPENSERS",
          ocrSnippet: "GRAB BAR, TOILET PAPER HOLDER, SOAP DISPENSER",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 6,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Toilet Accessories"],
          confidence: 88,
          whyFlagged: "Found: mirror, sanitary napkin disposal, seat cover dispenser",
          ocrText: "RESTROOM ACCESSORIES SCHEDULE",
          ocrSnippet: "MIRROR, SANITARY NAPKIN DISPOSAL, SEAT COVER DISPENSER",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 7,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Toilet Accessories"],
          confidence: 75,
          whyFlagged: "Found: baby changing station, waste receptacle",
          ocrText: "ACCESSORY SCHEDULE CONTINUED",
          ocrSnippet: "BABY CHANGING STATION, WASTE RECEPTACLE",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 12,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Toilet Partitions"],
          confidence: 95,
          whyFlagged: "Found: toilet partition, urinal screen, pilaster, headrail",
          ocrText: "TOILET PARTITION SCHEDULE - PHENOLIC CORE",
          ocrSnippet: "TOILET PARTITION, URINAL SCREEN, PILASTER, HEADRAIL",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 13,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Toilet Partitions"],
          confidence: 82,
          whyFlagged: "Found: partition door, stainless steel partition",
          ocrText: "PARTITION DETAILS AND ELEVATIONS",
          ocrSnippet: "PARTITION DOOR, STAINLESS STEEL PARTITION",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 15,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Lockers"],
          confidence: 89,
          whyFlagged: "Found: employee locker, locker bench, padlock hasp",
          ocrText: "LOCKER ROOM PLAN AND SCHEDULE",
          ocrSnippet: "EMPLOYEE LOCKER, LOCKER BENCH, PADLOCK HASP",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 18,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Fire Extinguisher Cabinets"],
          confidence: 78,
          whyFlagged: "Found: fire extinguisher cabinet, recessed cabinet",
          ocrText: "FIRE PROTECTION DETAILS",
          ocrSnippet: "FIRE EXTINGUISHER CABINET, RECESSED CABINET",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
        {
          jobId: job.id,
          pageNumber: 21,
          originalFilename: "Sample_Construction_Plans.pdf",
          tags: ["Wall Protection"],
          confidence: 85,
          whyFlagged: "Found: corner guard, wall guard, handrail",
          ocrText: "WALL PROTECTION SCHEDULE",
          ocrSnippet: "CORNER GUARD, WALL GUARD, HANDRAIL",
          signageOverrideApplied: false,
          userModified: false,
          isRelevant: true,
        },
      ];

      for (const page of demoPages) {
        await planParserStorage.createPage({ ...page, matchBoxes: [], matchType: "keyword" });
      }

      res.json(job);
    } catch (error) {
      console.error("Demo job error:", error);
      res.status(500).json({ message: "Failed to create demo job" });
    }
  });

  app.get("/api/planparser/jobs/:jobId/export", async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const job = await planParserStorage.getJob(jobId);
      
      if (!job) {
        return res.status(404).json({ message: "Job not found" });
      }
      
      if (job.status !== "complete") {
        return res.status(400).json({ message: "Job not complete" });
      }
      
      const pages = await planParserStorage.getPagesByJob(jobId);
      const relevantPages = pages.filter(p => p.isRelevant);
      
      if (relevantPages.length === 0) {
        return res.status(400).json({ message: "No relevant pages to export" });
      }
      
      const jobDir = planParserStorage.getJobDirectory(jobId);
      const pdfsDir = path.join(jobDir, "pdfs");
      
      if (!fs.existsSync(pdfsDir)) {
        return res.status(400).json({ message: "Original PDFs not available for export" });
      }
      
      const pagesByScope: Record<string, { filename: string; pageNumber: number }[]> = {};
      for (const scope of PLAN_PARSER_SCOPES) {
        pagesByScope[scope] = [];
      }
      
      for (const page of relevantPages) {
        for (const tag of page.tags) {
          if (pagesByScope[tag]) {
            pagesByScope[tag].push({
              filename: page.originalFilename,
              pageNumber: page.pageNumber
            });
          }
        }
      }
      
      const pdfCache: Record<string, PDFDocument> = {};
      
      const loadPdf = async (filename: string): Promise<PDFDocument | null> => {
        if (pdfCache[filename]) {
          return pdfCache[filename];
        }
        
        const pdfPath = path.join(pdfsDir, filename);
        if (!fs.existsSync(pdfPath)) {
          return null;
        }
        
        const pdfBytes = fs.readFileSync(pdfPath);
        const pdfDoc = await PDFDocument.load(pdfBytes);
        pdfCache[filename] = pdfDoc;
        return pdfDoc;
      };
      
      const zip = new JSZip();
      
      for (const scope of PLAN_PARSER_SCOPES) {
        const scopePages = pagesByScope[scope];
        if (scopePages.length === 0) continue;
        
        const newPdf = await PDFDocument.create();
        
        const pagesByFile: Record<string, number[]> = {};
        for (const { filename, pageNumber } of scopePages) {
          if (!pagesByFile[filename]) {
            pagesByFile[filename] = [];
          }
          if (!pagesByFile[filename].includes(pageNumber)) {
            pagesByFile[filename].push(pageNumber);
          }
        }
        
        for (const [filename, pageNumbers] of Object.entries(pagesByFile)) {
          const sourcePdf = await loadPdf(filename);
          if (!sourcePdf) continue;
          
          const sortedPageNumbers = pageNumbers.sort((a, b) => a - b);
          
          for (const pageNum of sortedPageNumbers) {
            try {
              const [copiedPage] = await newPdf.copyPages(sourcePdf, [pageNum - 1]);
              newPdf.addPage(copiedPage);
            } catch (err) {
              console.error(`Failed to copy page ${pageNum} from ${filename}:`, err);
            }
          }
        }
        
        if (newPdf.getPageCount() > 0) {
          const pdfBytes = await newPdf.save();
          const safeScopeName = scope.replace(/[^a-zA-Z0-9]/g, "_");
          zip.file(`${safeScopeName}.pdf`, pdfBytes);
        }
      }
      
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      
      const projectName = job.filenames[0]?.replace(/\.pdf$/i, "") || "PlanParser";
      const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, "_");
      
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizedName}_Scope_Exports.zip"`);
      res.send(zipBuffer);
      
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ message: "Failed to generate export" });
    }
  });
}
