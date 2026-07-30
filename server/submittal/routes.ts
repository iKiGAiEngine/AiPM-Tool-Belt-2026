// =====================================================
// SUBMITTAL BUILDER — server routes
// =====================================================
// Same "db directly in the route file" pattern as the Buyout Bot. The package
// document lives in a single JSONB column; list-view fields are cached on each
// write from the shared packageTotals() helper so the dashboard never has to
// deserialize every package.
//
// Attachment bytes are stored separately (bytea) because product data PDFs are
// megabytes each. The package document only carries their metadata.
//
// Authentication and read-only (viewer) enforcement are applied globally to
// /api in server/routes.ts; these routes add the feature gate.

import type { Express, Request, Response } from "express";
import multer from "multer";
import JSZip from "jszip";
import { db } from "../db";
import { submittalProjects, submittalAttachments, FEATURES } from "@shared/schema";
import { and, eq, desc } from "drizzle-orm";
import {
  normalizePackage, packageTotals, derivePackageStatus,
  type SubmittalPackage, type SubmittalProject, type SubmittalStatus, type Scope,
} from "@shared/submittal/types";
import { validateProject } from "@shared/submittal/validation";
import { requireAdminOrFeature } from "../authRoutes";
import { buildScopePackage, readPageCount, packageFileName, type AttachmentBytes } from "./packageBuilder";

const MAX_ATTACHMENT_BYTES = 60 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES },
});

type ProjectRow = typeof submittalProjects.$inferSelect;

/** List columns — never includes packageData. */
const listColumns = {
  id: submittalProjects.id,
  proposalLogId: submittalProjects.proposalLogId,
  projectName: submittalProjects.projectName,
  gc: submittalProjects.gc,
  attention: submittalProjects.attention,
  assignedPm: submittalProjects.assignedPm,
  coverDate: submittalProjects.coverDate,
  estimateNumber: submittalProjects.estimateNumber,
  region: submittalProjects.region,
  sourceFilename: submittalProjects.sourceFilename,
  status: submittalProjects.status,
  scopeCount: submittalProjects.scopeCount,
  lineCount: submittalProjects.lineCount,
  resolvedCount: submittalProjects.resolvedCount,
  completionPercent: submittalProjects.completionPercent,
  createdBy: submittalProjects.createdBy,
  createdAt: submittalProjects.createdAt,
  updatedAt: submittalProjects.updatedAt,
};

/** Shape a row (+ package) into the client's SubmittalProject. */
function toClient(row: ProjectRow | Omit<ProjectRow, "packageData">, pkg?: SubmittalPackage): SubmittalProject {
  const data = pkg ?? ((row as ProjectRow).packageData as SubmittalPackage | undefined);
  return {
    id: String(row.id),
    proposalLogId: row.proposalLogId == null ? "" : String(row.proposalLogId),
    projectName: row.projectName,
    gc: row.gc ?? "",
    attention: row.attention ?? "",
    assignedPm: row.assignedPm ?? "",
    coverDate: row.coverDate ?? "",
    estimateNumber: row.estimateNumber,
    region: row.region,
    sourceFilename: row.sourceFilename,
    submittalStatus: (row.status ?? "not_started") as SubmittalStatus,
    completionPercent: row.completionPercent ?? 0,
    createdAt: row.createdAt ? new Date(row.createdAt).getTime() : 0,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
    lastActiveScopeId: data?.lastActiveScopeId ?? null,
    lastActiveTab: data?.lastActiveTab ?? "schedule",
    scopes: data?.scopes ?? [],
  };
}

/** Cached columns + derived status for a write. */
function cacheFields(pkg: SubmittalPackage, current?: SubmittalStatus) {
  const totals = packageTotals(pkg.scopes);
  // Blockers come from the same validation the PM sees, so the dashboard badge
  // and the validation panel can never disagree.
  const { blockers } = validateProject({ scopes: pkg.scopes } as SubmittalProject);
  return {
    ...totals,
    status: derivePackageStatus(pkg.scopes, { current, hasBlockers: blockers > 0 }),
  };
}

function actor(req: Request): string | null {
  const userId = (req.session as any)?.userId;
  return userId ? String(userId) : null;
}

function intParam(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function registerSubmittalRoutes(app: Express) {
  const gate = requireAdminOrFeature(FEATURES.SUBMITTAL_BUILDER);

  // ---- List (dashboard) ----------------------------------------------------
  app.get("/api/submittal/projects", gate, async (_req: Request, res: Response) => {
    try {
      const rows = await db.select(listColumns).from(submittalProjects).orderBy(desc(submittalProjects.updatedAt));
      res.json(rows.map((r) => toClient(r)));
    } catch (err: any) {
      console.error("[Submittal] list error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Create --------------------------------------------------------------
  app.post("/api/submittal/projects", gate, async (req: Request, res: Response) => {
    try {
      const b = req.body || {};
      const projectName = String(b.projectName || "").trim();
      if (!projectName) return res.status(400).json({ error: "Project name required" });

      const pkg = normalizePackage(b.package);
      const [row] = await db
        .insert(submittalProjects)
        .values({
          proposalLogId: Number.isFinite(Number(b.proposalLogId)) ? Number(b.proposalLogId) : null,
          projectName,
          gc: String(b.gc || ""),
          attention: String(b.attention || ""),
          assignedPm: String(b.assignedPm || ""),
          coverDate: String(b.coverDate || ""),
          estimateNumber: b.estimateNumber ? String(b.estimateNumber) : null,
          region: b.region ? String(b.region) : null,
          sourceFilename: b.sourceFilename ? String(b.sourceFilename) : null,
          packageData: pkg,
          createdBy: actor(req),
          ...cacheFields(pkg),
        })
        .returning();
      res.json(toClient(row, pkg));
    } catch (err: any) {
      console.error("[Submittal] create error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Get one (resume) ----------------------------------------------------
  app.get("/api/submittal/projects/:id", gate, async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });
      const [row] = await db.select().from(submittalProjects).where(eq(submittalProjects.id, id));
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(toClient(row));
    } catch (err: any) {
      console.error("[Submittal] get error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Auto-save -----------------------------------------------------------
  app.patch("/api/submittal/projects/:id", gate, async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });

      const [existing] = await db.select().from(submittalProjects).where(eq(submittalProjects.id, id));
      if (!existing) return res.status(404).json({ error: "Not found" });

      const b = req.body || {};
      const updates: Record<string, any> = { updatedAt: new Date() };

      for (const field of ["projectName", "gc", "attention", "assignedPm", "coverDate"] as const) {
        if (b[field] !== undefined) updates[field] = String(b[field] ?? "");
      }
      for (const field of ["estimateNumber", "region", "sourceFilename"] as const) {
        if (b[field] !== undefined) updates[field] = b[field] ? String(b[field]) : null;
      }
      if (updates.projectName !== undefined && !String(updates.projectName).trim()) {
        return res.status(400).json({ error: "Project name cannot be empty" });
      }

      if (b.package !== undefined) {
        const pkg = normalizePackage(b.package);
        updates.packageData = pkg;
        // `markExported` is the one status the client may assert; everything
        // else is derived so the header, list and validation always agree.
        const current: SubmittalStatus | undefined = b.markExported
          ? "exported"
          : (existing.status as SubmittalStatus);
        Object.assign(updates, cacheFields(pkg, current));
      }

      const [row] = await db.update(submittalProjects).set(updates).where(eq(submittalProjects.id, id)).returning();
      res.json(toClient(row));
    } catch (err: any) {
      console.error("[Submittal] save error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Delete (package + its attachment bytes) -----------------------------
  app.delete("/api/submittal/projects/:id", gate, async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });
      await db.delete(submittalAttachments).where(eq(submittalAttachments.projectId, id));
      await db.delete(submittalProjects).where(eq(submittalProjects.id, id));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Submittal] delete error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Upload one product data PDF ----------------------------------------
  app.post("/api/submittal/projects/:id/attachments", gate, upload.single("file"), async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      const attachmentId = String((req.body || {}).attachmentId || "").trim();
      if (!attachmentId) return res.status(400).json({ error: "attachmentId required" });

      const fileName = req.file.originalname || "product-data.pdf";
      const isPdf =
        req.file.mimetype === "application/pdf" ||
        /\.pdf$/i.test(fileName) ||
        req.file.buffer.subarray(0, 5).toString("latin1") === "%PDF-";
      if (!isPdf) {
        return res.status(400).json({ error: `"${fileName}" is not a PDF. Product data must be a PDF.` });
      }

      const [project] = await db
        .select({ id: submittalProjects.id })
        .from(submittalProjects)
        .where(eq(submittalProjects.id, id));
      if (!project) return res.status(404).json({ error: "Not found" });

      const pageCount = await readPageCount(req.file.buffer);

      // Re-uploading over the same attachment id replaces the bytes.
      await db
        .delete(submittalAttachments)
        .where(and(eq(submittalAttachments.projectId, id), eq(submittalAttachments.attachmentId, attachmentId)));

      const [row] = await db
        .insert(submittalAttachments)
        .values({
          projectId: id,
          attachmentId,
          fileName,
          mimeType: req.file.mimetype || "application/pdf",
          pageCount,
          byteSize: req.file.size ?? req.file.buffer.length,
          fileData: req.file.buffer,
        })
        .returning({
          attachmentId: submittalAttachments.attachmentId,
          fileName: submittalAttachments.fileName,
          mimeType: submittalAttachments.mimeType,
          pageCount: submittalAttachments.pageCount,
          byteSize: submittalAttachments.byteSize,
        });

      res.json(row);
    } catch (err: any) {
      console.error("[Submittal] attachment upload error:", err);
      if (err?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "That PDF is larger than 60 MB." });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Download / preview one attachment -----------------------------------
  app.get("/api/submittal/projects/:id/attachments/:attachmentId", gate, async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });
      const [row] = await db
        .select()
        .from(submittalAttachments)
        .where(and(eq(submittalAttachments.projectId, id), eq(submittalAttachments.attachmentId, req.params.attachmentId)));
      if (!row) return res.status(404).json({ error: "Not found" });

      res.setHeader("Content-Type", row.mimeType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(row.fileName)}"`);
      res.send(Buffer.from(row.fileData));
    } catch (err: any) {
      console.error("[Submittal] attachment fetch error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Remove one attachment ----------------------------------------------
  app.delete("/api/submittal/projects/:id/attachments/:attachmentId", gate, async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });
      await db
        .delete(submittalAttachments)
        .where(and(eq(submittalAttachments.projectId, id), eq(submittalAttachments.attachmentId, req.params.attachmentId)));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Submittal] attachment delete error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Generate the package PDF -------------------------------------------
  // One PDF per scope. With no scopeId, every scope is returned in a zip.
  app.post("/api/submittal/projects/:id/export", gate, async (req: Request, res: Response) => {
    try {
      const id = intParam(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid id" });

      const [row] = await db.select().from(submittalProjects).where(eq(submittalProjects.id, id));
      if (!row) return res.status(404).json({ error: "Not found" });

      const project = toClient(row);
      const scopeId = (req.body || {}).scopeId ? String((req.body || {}).scopeId) : null;
      const scopes: Scope[] = scopeId
        ? project.scopes.filter((s) => s.id === scopeId)
        : project.scopes;

      if (scopes.length === 0) {
        return res.status(400).json({ error: scopeId ? "Scope not found" : "This package has no scopes yet." });
      }

      const files = await db
        .select({
          attachmentId: submittalAttachments.attachmentId,
          fileName: submittalAttachments.fileName,
          fileData: submittalAttachments.fileData,
        })
        .from(submittalAttachments)
        .where(eq(submittalAttachments.projectId, id));
      const bytes: AttachmentBytes[] = files.map((f) => ({
        attachmentId: f.attachmentId,
        fileName: f.fileName,
        data: Buffer.from(f.fileData),
      }));

      const built = await Promise.all(
        scopes.map(async (scope) => ({ scope, result: await buildScopePackage(project, scope, bytes) }))
      );

      // Record that the package went out — the one status the app is told
      // rather than deriving.
      const pkg = normalizePackage(row.packageData);
      await db
        .update(submittalProjects)
        .set({ updatedAt: new Date(), ...cacheFields(pkg, "exported") })
        .where(eq(submittalProjects.id, id));

      const problems = built.flatMap((b) => b.result.problems);
      res.setHeader("X-Submittal-Problems", encodeURIComponent(JSON.stringify(problems)));

      if (built.length === 1) {
        const { scope, result } = built[0];
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${packageFileName(project, scope)}"`);
        return res.send(result.bytes);
      }

      const zip = new JSZip();
      for (const { scope, result } of built) {
        zip.file(packageFileName(project, scope), result.bytes);
      }
      const zipped = await zip.generateAsync({ type: "nodebuffer" });
      const safeName = project.projectName.replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "_") || "Submittal";
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}_Submittals.zip"`);
      res.send(zipped);
    } catch (err: any) {
      console.error("[Submittal] export error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
