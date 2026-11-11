// Types & Quantities lead-time report API.
//
// Thin route layer: fetch the filtered rows, hand them to the pure
// buildTqReport() in tqReportService.ts, serialize as JSON or CSV.

import type { Express, Request, Response, NextFunction } from "express";
import { db } from "./db";
import { proposalLogEntries, users, FEATURES } from "@shared/schema";
import { eq, and, isNull, gte, lte, sql, type SQL } from "drizzle-orm";
import { storage } from "./storage";
import { parseIsoDate, businessDaysBetween, toIsoDate } from "@shared/tqLeadTime";
import {
  buildTqReport,
  reportToCsv,
  TQ_REPORT_TYPES,
  TQ_REPORT_LABELS,
  type TqReportType,
  type TqRow,
} from "./tqReportService";

/**
 * Admins always pass; everyone else needs the `tq-report` feature granted on the
 * Admin → Feature Access page. Mirrors requireAdmin in estimateAnalyticsRoutes.ts,
 * widened by one feature check so leadership can be given access without being
 * made an admin.
 */
function requireAdminOrTqReport(req: Request, res: Response, next: NextFunction) {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ message: "Not authenticated" });

  (async () => {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (u?.role === "admin") return next();
    const features = await storage.getUserFeatureAccess(userId);
    if (Array.isArray(features) && features.includes(FEATURES.TQ_REPORT)) return next();
    return res.status(403).json({ message: "T&Q report access required" });
  })().catch((err) => {
    console.error("[TqReport] Access check failed:", err);
    res.status(500).json({ message: "Access check failed" });
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function fetchRows(filters: {
  from?: string;
  to?: string;
  region?: string;
  market?: string;
  estimator?: string;
  status?: string;
  swinerton?: string;
  includeTest: boolean;
}): Promise<TqRow[]> {
  const conds: SQL[] = [isNull(proposalLogEntries.deletedAt)];

  // Drafts are BC invites still awaiting review — they aren't real bids yet.
  conds.push(sql`COALESCE(${proposalLogEntries.isDraft}, false) = false`);
  if (!filters.includeTest) {
    conds.push(sql`COALESCE(${proposalLogEntries.isTest}, false) = false`);
  }
  if (filters.from) conds.push(gte(proposalLogEntries.dueDate, filters.from));
  if (filters.to) conds.push(lte(proposalLogEntries.dueDate, filters.to));
  if (filters.region) conds.push(eq(proposalLogEntries.region, filters.region));
  if (filters.market) conds.push(eq(proposalLogEntries.primaryMarket, filters.market));
  if (filters.status) conds.push(eq(proposalLogEntries.estimateStatus, filters.status));
  if (filters.swinerton) conds.push(eq(proposalLogEntries.swinertonProject, filters.swinerton));
  // Estimator initials are stored slash-joined ("HK/GG"), so match as a substring.
  if (filters.estimator) {
    conds.push(sql`${proposalLogEntries.nbsEstimator} ILIKE ${"%" + filters.estimator + "%"}`);
  }

  const rows = await db
    .select({
      id: proposalLogEntries.id,
      projectName: proposalLogEntries.projectName,
      estimateNumber: proposalLogEntries.estimateNumber,
      region: proposalLogEntries.region,
      primaryMarket: proposalLogEntries.primaryMarket,
      nbsEstimator: proposalLogEntries.nbsEstimator,
      gcEstimateLead: proposalLogEntries.gcEstimateLead,
      estimateStatus: proposalLogEntries.estimateStatus,
      dueDate: proposalLogEntries.dueDate,
      proposalTotal: proposalLogEntries.proposalTotal,
      swinertonProject: proposalLogEntries.swinertonProject,
      tqReceivedDate: proposalLogEntries.tqReceivedDate,
      tqReceivedBy: proposalLogEntries.tqReceivedBy,
    })
    .from(proposalLogEntries)
    .where(and(...conds));

  return rows;
}

/**
 * The equal-length window immediately preceding [from, to], used for the
 * "coverage improved/declined N points" watch item. Returns null unless both
 * ends of the current window are known.
 */
function priorWindow(from: string, to: string): { from: string; to: string } | null {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b || b < a) return null;
  const spanDays = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  const priorTo = new Date(a);
  priorTo.setDate(priorTo.getDate() - 1);
  const priorFrom = new Date(priorTo);
  priorFrom.setDate(priorFrom.getDate() - spanDays);
  return { from: toIsoDate(priorFrom), to: toIsoDate(priorTo) };
}

export function registerTqReportRoutes(app: Express) {
  // Report metadata — lets the UI build its dropdowns without hardcoding.
  app.get("/api/reports/types-quantities/meta", requireAdminOrTqReport, (_req, res) => {
    res.json({
      types: TQ_REPORT_TYPES.map((t) => ({ value: t, label: TQ_REPORT_LABELS[t] })),
    });
  });

  app.get("/api/reports/types-quantities", requireAdminOrTqReport, async (req: Request, res: Response) => {
    try {
      const rawType = str(req.query.type) || "summary";
      if (!TQ_REPORT_TYPES.includes(rawType as TqReportType)) {
        return res.status(400).json({ message: `Unknown report type: ${rawType}` });
      }
      const type = rawType as TqReportType;

      const from = str(req.query.from);
      const to = str(req.query.to);
      if (from && !parseIsoDate(from)) return res.status(400).json({ message: "from must be YYYY-MM-DD" });
      if (to && !parseIsoDate(to)) return res.status(400).json({ message: "to must be YYYY-MM-DD" });

      const filters = {
        from: from || undefined,
        to: to || undefined,
        region: str(req.query.region) || undefined,
        market: str(req.query.market) || undefined,
        estimator: str(req.query.estimator) || undefined,
        status: str(req.query.status) || undefined,
        swinerton: str(req.query.swinerton) || undefined,
        includeTest: str(req.query.includeTest) === "true",
      };

      const rows = await fetchRows(filters);

      let priorRows: TqRow[] | undefined;
      if (type === "summary" && from && to) {
        const prior = priorWindow(from, to);
        if (prior) priorRows = await fetchRows({ ...filters, from: prior.from, to: prior.to });
      }

      const report = buildTqReport(rows, { type, from, to, priorRows });

      if (str(req.query.format) === "csv") {
        const stamp = toIsoDate(new Date());
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="NBS_TQ_${type}_${stamp}.csv"`);
        return res.send(reportToCsv(report));
      }

      res.json(report);
    } catch (error: any) {
      console.error("[TqReport] Failed to build report:", error);
      res.status(500).json({ message: error?.message || "Failed to build report" });
    }
  });

  // Filter dropdown options, scoped to what actually exists in the log.
  app.get("/api/reports/types-quantities/filters", requireAdminOrTqReport, async (_req, res) => {
    try {
      const rows = await db
        .select({
          region: proposalLogEntries.region,
          market: proposalLogEntries.primaryMarket,
          estimator: proposalLogEntries.nbsEstimator,
          status: proposalLogEntries.estimateStatus,
        })
        .from(proposalLogEntries)
        .where(isNull(proposalLogEntries.deletedAt));

      const uniq = (vals: Array<string | null>) =>
        Array.from(new Set(vals.map((v) => (v || "").trim()).filter(Boolean))).sort();

      res.json({
        regions: uniq(rows.map((r) => r.region)),
        markets: uniq(rows.map((r) => r.market)),
        // Split the slash-joined initials so each estimator is its own option.
        estimators: uniq(rows.flatMap((r) => (r.estimator || "").split(/[/,;|]+/))),
        statuses: uniq(rows.map((r) => r.status)),
      });
    } catch (error: any) {
      console.error("[TqReport] Failed to load filter options:", error);
      res.status(500).json({ message: "Failed to load filter options" });
    }
  });
}

// Re-exported for tests that want the window math without booting Express.
export const __test = { priorWindow, businessDaysBetween };
