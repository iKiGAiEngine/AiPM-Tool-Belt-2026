// Shared types for the AiPM QA Audit system.
//
// A "check" is a single, independent probe of the site or platform (an HTTP
// smoke test, a database probe, a config assertion, etc.). Each check returns a
// CheckResult. The runner aggregates every result into a single QaAuditReport
// with an at-a-glance GREEN / YELLOW / RED verdict.
//
// This file has NO runtime imports on purpose: it is safe to import from the
// server, the standalone CLI, and CI without pulling in the database or the
// rest of the app.

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export type OverallStatus = "GREEN" | "YELLOW" | "RED";

export interface CheckResult {
  /** Stable machine id, e.g. "http_health". */
  id: string;
  /** Human-readable name shown in the report. */
  name: string;
  /** Grouping bucket, e.g. "Availability", "Database", "Security". */
  category: string;
  status: CheckStatus;
  /** One-line result, always safe to show. */
  summary: string;
  /** Optional extra context (error text, counts, remediation hint). */
  detail?: string;
  /** How long the probe took, in milliseconds. */
  durationMs: number;
  /**
   * When true, a `fail` on this check forces the overall verdict to RED.
   * When false, a `fail` only pushes the overall verdict to YELLOW.
   * A `warn` is never critical on its own.
   */
  critical: boolean;
  /** Structured evidence for the record (counts, thresholds, ids). */
  evidence?: Record<string, unknown>;
}

/** One cost driver (AI model, email, infra) in the Cost & Usage report. */
export interface CostLine {
  driver: string;
  /** true = derived from measured data (the AI ledger / real row counts); false = estimated proxy. */
  measured: boolean;
  /** Human usage descriptor, e.g. "1.2M in / 0.4M out tokens · 320 calls". */
  usage: string;
  last24hUsd: number;
  last30dUsd: number;
  /** How the number was computed (assumptions, rates). */
  basis: string;
}

export interface CostSummary {
  currency: string;
  /** Whether the AI line is backed by real ledger data (vs. a pre-instrumentation estimate). */
  hasMeasuredAi: boolean;
  lines: CostLine[];
  total24hUsd: number;
  total30dUsd: number;
  /** Projected monthly run-rate: variable (24h×30) + fixed monthly infra. */
  projectedMonthlyUsd: number;
  note: string;
}

export interface QaAuditReport {
  status: OverallStatus;
  /** One-sentence headline, e.g. "All systems green — 22/22 checks passed." */
  headline: string;
  startedAt: string; // ISO 8601
  finishedAt: string; // ISO 8601
  durationMs: number;
  /** What was audited: a base URL and/or "in-process". */
  target: string;
  environment: string;
  version?: string;
  counts: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
    skip: number;
  };
  /** Every check that ran, in execution order. This is the "what was checked". */
  checks: CheckResult[];
  /** Estimated cost of running the site, based on usage. Present when local checks run. */
  cost?: CostSummary;
}

/** Context handed to each check group so it knows what it is allowed to touch. */
export interface AuditContext {
  /** Base URL for HTTP smoke tests, e.g. "http://127.0.0.1:5000". */
  baseUrl?: string;
  /**
   * Whether in-process checks (database, filesystem, config/env) may run.
   * True when the audit runs co-located with the app (DATABASE_URL present);
   * false for HTTP-only monitoring from CI.
   */
  includeLocalChecks: boolean;
  /** Environment label for the report. */
  environment: string;
  /** Per-request timeout for HTTP checks, ms. */
  httpTimeoutMs: number;
}

/** Helper used by every check to time itself and normalise thrown errors. */
export async function runProbe(
  meta: Pick<CheckResult, "id" | "name" | "category" | "critical">,
  fn: () => Promise<Omit<CheckResult, "id" | "name" | "category" | "critical" | "durationMs">>,
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const partial = await fn();
    return { ...meta, ...partial, durationMs: Date.now() - start };
  } catch (err: any) {
    return {
      ...meta,
      status: "fail",
      summary: "Check threw an unexpected error.",
      detail: err?.message ? String(err.message) : String(err),
      durationMs: Date.now() - start,
    };
  }
}
