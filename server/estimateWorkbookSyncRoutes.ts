import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "crypto";
import multer from "multer";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { estimateWorkbookSnapshots, proposalLogEntries } from "@shared/schema";
import { parseEstimateWorkbook } from "./estimateWorkbookSync";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// The folder watcher has no browser login, so it proves itself with a shared
// secret. Unset secret = ingest is closed, never open.
function hasValidSyncToken(req: Request): boolean {
  const expected = process.env.ESTIMATE_SYNC_TOKEN;
  const given = req.header("x-sync-token");
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function registerEstimateWorkbookSyncRoutes(app: Express) {
  // Called by the folder watcher whenever an estimate workbook is saved.
  // Multipart: file=<workbook>, sourceKey=<path in shared folder>, modifiedAt=<ISO date, optional>
  app.post("/api/estimate-sync/ingest", upload.single("file"), async (req: Request, res: Response) => {
    if (!hasValidSyncToken(req)) return res.status(401).json({ message: "Invalid sync token" });
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const sourceKey = String(req.body.sourceKey || req.file.originalname).slice(0, 1000);
      const snap = await parseEstimateWorkbook(req.file.buffer);

      // Skip identical re-saves so history only records real changes.
      const [latest] = await db.select({ id: estimateWorkbookSnapshots.id, fileHash: estimateWorkbookSnapshots.fileHash })
        .from(estimateWorkbookSnapshots)
        .where(eq(estimateWorkbookSnapshots.sourceKey, sourceKey))
        .orderBy(desc(estimateWorkbookSnapshots.syncedAt))
        .limit(1);
      if (latest?.fileHash === snap.fileHash) return res.json({ status: "unchanged", id: latest.id });

      // Link to the Proposal Log by estimate number, falling back to project name.
      let proposalLogEntryId: number | null = null;
      const logRows = await db.select({ id: proposalLogEntries.id, projectName: proposalLogEntries.projectName, estimateNumber: proposalLogEntries.estimateNumber })
        .from(proposalLogEntries);
      const num = snap.project.estimateNumber;
      const byNumber = num && num.toUpperCase() !== "TBD" ? logRows.find((r) => r.estimateNumber === num) : undefined;
      const byName = logRows.find((r) => normalize(r.projectName) === normalize(snap.project.projectName));
      proposalLogEntryId = (byNumber ?? byName)?.id ?? null;

      const modifiedAt = req.body.modifiedAt ? new Date(req.body.modifiedAt) : null;
      const [row] = await db.insert(estimateWorkbookSnapshots).values({
        sourceKey,
        fileName: req.file.originalname,
        fileHash: snap.fileHash,
        fileModifiedAt: modifiedAt && !isNaN(modifiedAt.getTime()) ? modifiedAt : null,
        proposalLogEntryId,
        projectName: snap.project.projectName || req.file.originalname,
        estimateNumber: snap.project.estimateNumber || null,
        proposalTotal: String(snap.proposalTotal),
        project: snap.project as unknown as Record<string, unknown>,
        summaryRows: snap.summaryRows as unknown as Record<string, unknown>[],
        scopes: snap.scopes as unknown as Record<string, unknown>[],
        warnings: snap.warnings,
      }).returning({ id: estimateWorkbookSnapshots.id });

      res.json({ status: "synced", id: row.id, linkedToProposalLog: proposalLogEntryId !== null, warnings: snap.warnings });
    } catch (err) {
      console.error("[EstimateSync] Ingest error:", err);
      res.status(500).json({ message: "Failed to read estimate workbook" });
    }
  });

  // Latest snapshot of each workbook, for the list view (no line items).
  app.get("/api/estimate-sync/workbooks", async (_req: Request, res: Response) => {
    try {
      const rows = await db.execute(sql`
        SELECT DISTINCT ON (source_key)
          id, source_key AS "sourceKey", file_name AS "fileName", project_name AS "projectName",
          estimate_number AS "estimateNumber", proposal_total AS "proposalTotal",
          proposal_log_entry_id AS "proposalLogEntryId", synced_at AS "syncedAt",
          file_modified_at AS "fileModifiedAt",
          jsonb_array_length(scopes) AS "scopeCount",
          project->>'bidDueDate' AS "bidDueDate", project->>'nbsEstimator' AS "nbsEstimator"
        FROM estimate_workbook_snapshots
        ORDER BY source_key, synced_at DESC
      `);
      res.json(rows.rows);
    } catch (err) {
      console.error("[EstimateSync] List error:", err);
      res.status(500).json({ message: "Failed to load synced estimates" });
    }
  });

  app.get("/api/estimate-sync/workbooks/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid id" });
      const [row] = await db.select().from(estimateWorkbookSnapshots).where(eq(estimateWorkbookSnapshots.id, id));
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    } catch (err) {
      console.error("[EstimateSync] Detail error:", err);
      res.status(500).json({ message: "Failed to load estimate" });
    }
  });
}
