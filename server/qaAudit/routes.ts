// Admin-facing QA audit endpoints:
//   GET  /api/admin/qa-audit/latest    → most recent stored run (JSON)
//   GET  /api/admin/qa-audit/history   → recent runs, newest first (JSON)
//   POST /api/admin/qa-audit/run       → run an audit on demand (JSON report)
//   GET  /api/admin/qa-audit/report.html → latest (or on-demand) run as an HTML page
//
// All are admin-gated. The HTML view is the "what was checked" report a human
// can open in the browser.

import type { Express, Request, Response } from "express";
import { desc } from "drizzle-orm";
import { requireAdmin } from "../authRoutes";
import { runAudit } from "./runner";
import { renderHtmlDocument } from "./report";
import type { QaAuditReport } from "./types";

function selfBaseUrl(): string {
  const port = process.env.PORT || "5000";
  return process.env.QA_AUDIT_SELF_URL || `http://127.0.0.1:${port}`;
}

export function registerQaAuditRoutes(app: Express): void {
  app.get("/api/admin/qa-audit/latest", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { db } = await import("../db");
      const { qaAuditRuns } = await import("@shared/schema");
      const rows = await db.select().from(qaAuditRuns).orderBy(desc(qaAuditRuns.ranAt)).limit(1);
      if (rows.length === 0) return res.status(404).json({ message: "No audit runs recorded yet." });
      res.json(rows[0]);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to load latest audit." });
    }
  });

  app.get("/api/admin/qa-audit/history", requireAdmin, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? "30"), 10) || 30, 200);
      const { db } = await import("../db");
      const { qaAuditRuns } = await import("@shared/schema");
      const rows = await db
        .select({
          id: qaAuditRuns.id,
          ranAt: qaAuditRuns.ranAt,
          status: qaAuditRuns.status,
          headline: qaAuditRuns.headline,
          environment: qaAuditRuns.environment,
          durationMs: qaAuditRuns.durationMs,
          passCount: qaAuditRuns.passCount,
          warnCount: qaAuditRuns.warnCount,
          failCount: qaAuditRuns.failCount,
          skipCount: qaAuditRuns.skipCount,
        })
        .from(qaAuditRuns)
        .orderBy(desc(qaAuditRuns.ranAt))
        .limit(limit);
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to load audit history." });
    }
  });

  app.post("/api/admin/qa-audit/run", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const report = await runAudit({ baseUrl: selfBaseUrl(), includeLocalChecks: true, persist: true });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Audit run failed." });
    }
  });

  app.get("/api/admin/qa-audit/cost", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { runCostAnalysis } = await import("./costChecks");
      const { summary } = await runCostAnalysis();
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ message: err?.message || "Failed to compute cost." });
    }
  });

  app.get("/api/admin/qa-audit/report.html", requireAdmin, async (req: Request, res: Response) => {
    try {
      let report: QaAuditReport | undefined;
      if (req.query.run === "1") {
        report = await runAudit({ baseUrl: selfBaseUrl(), includeLocalChecks: true, persist: true });
      } else {
        const { db } = await import("../db");
        const { qaAuditRuns } = await import("@shared/schema");
        const rows = await db.select().from(qaAuditRuns).orderBy(desc(qaAuditRuns.ranAt)).limit(1);
        report = rows[0]?.report as unknown as QaAuditReport | undefined;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (!report) {
        return res.send(
          `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#0d0d0f;color:#e8e8ea;padding:40px;"><h1>No QA audit recorded yet</h1><p>Add <code>?run=1</code> to run one now.</p></body>`,
        );
      }
      res.send(renderHtmlDocument(report));
    } catch (err: any) {
      res.status(500).send(`Failed to render report: ${err?.message || err}`);
    }
  });
}
