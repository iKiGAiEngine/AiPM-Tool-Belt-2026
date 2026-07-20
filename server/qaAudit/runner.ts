// The audit runner: orchestrates every check group, aggregates results into a
// single verdict, and (best-effort) persists the run for history. It is written
// to degrade gracefully — HTTP-only in CI, or full in-process when co-located
// with the app — and never throws: a broken check becomes a failed check, not a
// crashed audit.

import { runHttpChecks } from "./httpChecks";
import type { AuditContext, CheckResult, CostSummary, OverallStatus, QaAuditReport } from "./types";

export interface RunOptions {
  baseUrl?: string;
  /** Force-enable/disable in-process (DB/fs/config) checks. Defaults to DATABASE_URL presence. */
  includeLocalChecks?: boolean;
  environment?: string;
  httpTimeoutMs?: number;
  /** Persist the run to qa_audit_runs (best-effort). Default true when local checks run. */
  persist?: boolean;
}

function deriveStatus(checks: CheckResult[]): OverallStatus {
  const hasCriticalFail = checks.some((c) => c.status === "fail" && c.critical);
  if (hasCriticalFail) return "RED";
  const hasAnyFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  if (hasAnyFail || hasWarn) return "YELLOW";
  return "GREEN";
}

function buildHeadline(status: OverallStatus, checks: CheckResult[]): string {
  const pass = checks.filter((c) => c.status === "pass").length;
  const total = checks.filter((c) => c.status !== "skip").length;
  if (status === "GREEN") return `All systems green — ${pass}/${total} checks passed.`;
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  if (status === "RED") {
    const crit = fails.filter((c) => c.critical).map((c) => c.name);
    return `RED — critical failure: ${crit.join(", ")}. (${fails.length} failed, ${warns.length} warnings.)`;
  }
  const headline = fails.length > 0 ? `${fails.length} check(s) failing` : `${warns.length} warning(s)`;
  return `YELLOW — ${headline}. Review needed; site is up.`;
}

export async function runAudit(opts: RunOptions = {}): Promise<QaAuditReport> {
  const startedAt = new Date();
  const includeLocalChecks =
    opts.includeLocalChecks ?? !!process.env.DATABASE_URL;
  const ctx: AuditContext = {
    baseUrl: opts.baseUrl,
    includeLocalChecks,
    environment: opts.environment || process.env.NODE_ENV || "development",
    httpTimeoutMs: opts.httpTimeoutMs ?? 15_000,
  };

  const checks: CheckResult[] = [];
  let cost: CostSummary | undefined;

  // HTTP smoke checks (skipped internally if no baseUrl).
  checks.push(...(await runHttpChecks(ctx)));

  // In-process checks (DB + config + filesystem + cost), dynamically imported so
  // the CLI can run HTTP-only in CI without DATABASE_URL and without loading `db`.
  if (includeLocalChecks) {
    try {
      const [{ runDbChecks }, { runPlatformChecks }, { runCostAnalysis }] = await Promise.all([
        import("./dbChecks"),
        import("./platformChecks"),
        import("./costChecks"),
      ]);
      checks.push(...(await runPlatformChecks()));
      checks.push(...(await runDbChecks()));
      try {
        const costResult = await runCostAnalysis();
        cost = costResult.summary;
        checks.push(...costResult.checks);
      } catch (costErr: any) {
        console.error("[QaAudit] Cost analysis failed (non-fatal):", costErr?.message || costErr);
      }
    } catch (err: any) {
      checks.push({
        id: "local_checks_bootstrap",
        name: "In-process checks bootstrap",
        category: "Configuration",
        status: "fail",
        critical: false,
        durationMs: 0,
        summary: "Failed to load in-process checks.",
        detail: err?.message || String(err),
      });
    }
  }

  const finishedAt = new Date();
  const counts = {
    total: checks.length,
    pass: checks.filter((c) => c.status === "pass").length,
    warn: checks.filter((c) => c.status === "warn").length,
    fail: checks.filter((c) => c.status === "fail").length,
    skip: checks.filter((c) => c.status === "skip").length,
  };
  const status = deriveStatus(checks);

  const version = checks.find((c) => c.id === "http_version")?.evidence?.version as string | undefined;

  const report: QaAuditReport = {
    status,
    headline: buildHeadline(status, checks),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    target: opts.baseUrl ? opts.baseUrl + (includeLocalChecks ? " + in-process" : "") : "in-process",
    environment: ctx.environment,
    version,
    counts,
    checks,
    cost,
  };

  const shouldPersist = opts.persist ?? includeLocalChecks;
  if (shouldPersist) {
    await persistRun(report).catch((err) => {
      console.error("[QaAudit] Failed to persist run (non-fatal):", err?.message || err);
    });
  }

  return report;
}

/** Best-effort persistence. Never throws; tolerates a missing table. */
async function persistRun(report: QaAuditReport): Promise<void> {
  try {
    const { db } = await import("../db");
    const { qaAuditRuns } = await import("@shared/schema");
    await db.insert(qaAuditRuns).values({
      status: report.status,
      headline: report.headline,
      environment: report.environment,
      target: report.target,
      durationMs: report.durationMs,
      passCount: report.counts.pass,
      warnCount: report.counts.warn,
      failCount: report.counts.fail,
      skipCount: report.counts.skip,
      report: report as unknown as Record<string, unknown>,
    });
  } catch (err: any) {
    // A missing qa_audit_runs table (migration not yet applied) must not break
    // the audit — history is a convenience, the verdict is the product.
    console.error("[QaAudit] persistRun skipped:", err?.message || err);
  }
}
