// Types & Quantities lead-time reporting.
//
// buildTqReport() is a pure function over plain rows: no database, no Express,
// no clock. That keeps every metric and every sentence of the TL;DR unit-testable
// against fixtures, and keeps the route thin (fetch rows → call this → serialize).

import {
  tqLeadBusinessDays,
  leadBucket,
  parseIsoDate,
  businessDaysBetween,
  type TqBucket,
  TQ_BUCKET_ORDER,
  TQ_BUCKET_LABELS,
} from "@shared/tqLeadTime";

export const TQ_REPORT_TYPES = [
  "summary",
  "by-region",
  "by-market",
  "by-gc",
  "by-estimator",
  "by-month",
  "detail",
  "exceptions",
] as const;

export type TqReportType = (typeof TQ_REPORT_TYPES)[number];

export const TQ_REPORT_LABELS: Record<TqReportType, string> = {
  summary: "Executive Summary",
  "by-region": "By Region",
  "by-market": "By Market",
  "by-gc": "By GC / Client",
  "by-estimator": "By Estimator",
  "by-month": "Monthly Trend",
  detail: "Bid Detail",
  exceptions: "Exceptions",
};

/** One proposal-log entry, reduced to just what the report needs. */
export interface TqRow {
  id: number;
  projectName: string | null;
  estimateNumber: string | null;
  region: string | null;
  primaryMarket: string | null;
  nbsEstimator: string | null;
  gcEstimateLead: string | null;
  estimateStatus: string | null;
  dueDate: string | null;
  proposalTotal: string | null;
  swinertonProject: string | null;
  tqReceivedDate: string | null;
  tqReceivedBy: string | null;
}

/** A row with its derived lead-time facts attached. */
export interface TqDetailRow extends TqRow {
  received: boolean;
  leadBusinessDays: number | null;
  bucket: TqBucket;
  bucketLabel: string;
}

export interface TqMetrics {
  bidCount: number;
  receivedCount: number;
  coveragePct: number;
  notReceivedCount: number;
  measurableCount: number;
  medianLeadBd: number | null;
  avgLeadBd: number | null;
  p90LeadBd: number | null;
  minLeadBd: number | null;
  crunchCount: number;
  lateCount: number;
}

export interface TqGroup extends TqMetrics {
  key: string;
  label: string;
}

export interface TqWatchItem {
  kind: string;
  text: string;
  /** Filter hint the UI can deep-link into the Detail view with. */
  filter?: Record<string, string>;
}

export interface TqReport {
  type: TqReportType;
  generatedAt: string;
  periodLabel: string;
  overall: TqMetrics;
  buckets: Array<{ bucket: TqBucket; label: string; count: number; pct: number }>;
  groups: TqGroup[];
  rows: TqDetailRow[];
  tldr: string;
  watchItems: TqWatchItem[];
}

export interface BuildTqReportOptions {
  type: TqReportType;
  /** Inclusive due-date window, 'YYYY-MM-DD'. Used only for the period label. */
  from?: string | null;
  to?: string | null;
  /** Comparison rows from the immediately preceding, equal-length period. */
  priorRows?: TqRow[];
  /** Injected so tests are deterministic. */
  now?: Date;
}

// ── Derivation ────────────────────────────────────────────────────────────────

export function toDetailRow(row: TqRow): TqDetailRow {
  const received = !!(row.tqReceivedDate && String(row.tqReceivedDate).trim());
  const leadBusinessDays = received ? tqLeadBusinessDays(row.tqReceivedDate, row.dueDate) : null;
  const bucket = leadBucket(leadBusinessDays, received);
  return {
    ...row,
    received,
    leadBusinessDays,
    bucket,
    bucketLabel: TQ_BUCKET_LABELS[bucket],
  };
}

// ── Statistics ────────────────────────────────────────────────────────────────

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
}

/** Nearest-rank p90. With few data points this lands on a real observation. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function computeMetrics(rows: TqDetailRow[]): TqMetrics {
  const bidCount = rows.length;
  const receivedRows = rows.filter((r) => r.received);
  // Median/p90 use only rows where both dates exist — a received bid with no due
  // date still counts toward coverage but cannot contribute a lead time.
  const leads = receivedRows
    .map((r) => r.leadBusinessDays)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);

  const sum = leads.reduce((s, d) => s + d, 0);

  return {
    bidCount,
    receivedCount: receivedRows.length,
    coveragePct: bidCount === 0 ? 0 : Math.round((receivedRows.length / bidCount) * 100),
    notReceivedCount: bidCount - receivedRows.length,
    measurableCount: leads.length,
    medianLeadBd: median(leads),
    avgLeadBd: leads.length === 0 ? null : Math.round((sum / leads.length) * 10) / 10,
    p90LeadBd: percentile(leads, 90),
    minLeadBd: leads.length === 0 ? null : leads[0],
    crunchCount: leads.filter((d) => d >= 0 && d <= 3).length,
    lateCount: leads.filter((d) => d < 0).length,
  };
}

function bucketDistribution(rows: TqDetailRow[]) {
  const counts = new Map<TqBucket, number>();
  for (const r of rows) counts.set(r.bucket, (counts.get(r.bucket) || 0) + 1);
  const total = rows.length || 1;
  return TQ_BUCKET_ORDER.map((bucket) => {
    const count = counts.get(bucket) || 0;
    return {
      bucket,
      label: TQ_BUCKET_LABELS[bucket],
      count,
      pct: Math.round((count / total) * 100),
    };
  }).filter((b) => b.count > 0);
}

// ── Grouping ──────────────────────────────────────────────────────────────────

const GROUPERS: Partial<Record<TqReportType, (r: TqDetailRow) => string>> = {
  "by-region": (r) => (r.region || "").trim() || "(no region)",
  "by-market": (r) => (r.primaryMarket || "").trim() || "(no market)",
  "by-gc": (r) => (r.gcEstimateLead || "").trim() || "(no GC lead)",
  "by-estimator": (r) => (r.nbsEstimator || "").trim() || "(unassigned)",
  "by-month": (r) => {
    const d = parseIsoDate(r.dueDate);
    if (!d) return "(no due date)";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  },
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function groupLabel(type: TqReportType, key: string): string {
  if (type === "by-month" && /^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split("-");
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
  }
  return key;
}

function buildGroups(type: TqReportType, rows: TqDetailRow[]): TqGroup[] {
  const grouper = GROUPERS[type];
  if (!grouper) return [];

  const byKey = new Map<string, TqDetailRow[]>();
  for (const r of rows) {
    const key = grouper(r);
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }

  const groups: TqGroup[] = Array.from(byKey.entries()).map(([key, groupRows]) => ({
    key,
    label: groupLabel(type, key),
    ...computeMetrics(groupRows),
  }));

  // Trend reads chronologically; every other grouping leads with the worst
  // performer so the problems are at the top of the page, not buried.
  if (type === "by-month") {
    groups.sort((a, b) => a.key.localeCompare(b.key));
  } else {
    groups.sort(
      (a, b) => a.coveragePct - b.coveragePct || b.bidCount - a.bidCount || a.label.localeCompare(b.label),
    );
  }
  return groups;
}

// ── Narrative ─────────────────────────────────────────────────────────────────

function fmtDateLong(iso: string | null | undefined): string | null {
  const d = parseIsoDate(iso);
  if (!d) return null;
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Sentinel for "no date filter applied" — the TL;DR rephrases around it. */
export const ALL_BIDS_PERIOD = "all recorded bids";

export function periodLabel(from?: string | null, to?: string | null): string {
  const a = fmtDateLong(from);
  const b = fmtDateLong(to);
  if (a && b) return `${a} – ${b}`;
  if (a) return `${a} onward`;
  if (b) return `through ${b}`;
  return ALL_BIDS_PERIOD;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Deterministic, template-generated TL;DR. No LLM: it renders instantly, reads
 * the same way every time, and can be asserted on character-for-character in a test.
 */
export function buildTldr(m: TqMetrics, period: string): string {
  if (m.bidCount === 0) return "No bids match these filters.";

  const parts: string[] = [];
  // "…due May 1 – Jul 31" reads well; "…due all recorded bids" does not.
  const scope =
    period === ALL_BIDS_PERIOD
      ? `Across all ${m.bidCount} recorded ${plural(m.bidCount, "bid", "bids")}`
      : `Across ${m.bidCount} ${plural(m.bidCount, "bid", "bids")} due ${period}`;
  parts.push(`${scope}, types & quantities were in hand on ${m.receivedCount} (${m.coveragePct}%).`);

  if (m.medianLeadBd !== null) {
    parts.push(
      `The typical bid got them ${m.medianLeadBd} ${plural(m.medianLeadBd, "business day", "business days")} before bid day.`,
    );
  }

  if (m.crunchCount > 0) {
    const pct = Math.round((m.crunchCount / m.bidCount) * 100);
    parts.push(
      `${m.crunchCount} ${plural(m.crunchCount, "bid", "bids")} (${pct}%) received T&Q inside 3 business days of the due date` +
        (m.lateCount > 0
          ? `, and ${m.lateCount} arrived after bid day.`
          : "."),
    );
  } else if (m.lateCount > 0) {
    parts.push(`${m.lateCount} ${plural(m.lateCount, "bid", "bids")} received T&Q after bid day.`);
  }

  if (m.notReceivedCount > 0) {
    const pct = Math.round((m.notReceivedCount / m.bidCount) * 100);
    parts.push(
      `${m.notReceivedCount} ${plural(m.notReceivedCount, "bid has", "bids have")} no T&Q recorded at all (${pct}%).`,
    );
  }

  return parts.join(" ");
}

/**
 * Rule-picked watch items. Each is deterministic and carries a filter the UI can
 * deep-link into the Detail view with.
 */
export function buildWatchItems(
  rows: TqDetailRow[],
  overall: TqMetrics,
  now: Date,
  priorRows?: TqRow[],
): TqWatchItem[] {
  const items: TqWatchItem[] = [];

  // 1. The actionable one: live bids landing soon with nothing received yet.
  const openSoon = rows.filter((r) => {
    if (r.received) return false;
    const due = parseIsoDate(r.dueDate);
    if (!due) return false;
    const bd = businessDaysBetween(now, due);
    return bd >= 0 && bd <= 10;
  });
  if (openSoon.length > 0) {
    items.push({
      kind: "due_soon_no_tq",
      text:
        `${openSoon.length} ${plural(openSoon.length, "bid is", "bids are")} due within 10 business days ` +
        `with no types & quantities recorded yet.`,
      filter: { bucket: "not_received" },
    });
  }

  // 2. Worst region by coverage, with enough volume to mean something.
  const regionGroups = buildGroups("by-region", rows).filter((g) => g.bidCount >= 5);
  const worstRegion = regionGroups[0];
  if (worstRegion && worstRegion.coveragePct < overall.coveragePct) {
    items.push({
      kind: "worst_region",
      text:
        `${worstRegion.label} has the weakest coverage: T&Q recorded on ${worstRegion.receivedCount} ` +
        `of ${worstRegion.bidCount} bids (${worstRegion.coveragePct}%).`,
      filter: { region: worstRegion.key },
    });
  }

  // 3. Slowest GC by median lead time.
  const gcGroups = buildGroups("by-gc", rows)
    .filter((g) => g.bidCount >= 3 && g.medianLeadBd !== null && g.key !== "(no GC lead)")
    .sort((a, b) => (a.medianLeadBd as number) - (b.medianLeadBd as number));
  const slowestGc = gcGroups[0];
  if (slowestGc && overall.medianLeadBd !== null && (slowestGc.medianLeadBd as number) < overall.medianLeadBd) {
    items.push({
      kind: "slowest_gc",
      text:
        `${slowestGc.label} delivers latest: a median of ${slowestGc.medianLeadBd} business days ` +
        `across ${slowestGc.bidCount} bids, versus ${overall.medianLeadBd} overall.`,
      filter: { gc: slowestGc.key },
    });
  }

  // 4. Movement against the previous equal-length period.
  if (priorRows && priorRows.length > 0) {
    const prior = computeMetrics(priorRows.map(toDetailRow));
    const delta = overall.coveragePct - prior.coveragePct;
    if (Math.abs(delta) >= 5) {
      items.push({
        kind: "trend",
        text:
          `Coverage ${delta > 0 ? "improved" : "declined"} ${Math.abs(delta)} points versus the previous ` +
          `period (${prior.coveragePct}% → ${overall.coveragePct}%).`,
      });
    }
  }

  return items;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function buildTqReport(rows: TqRow[], opts: BuildTqReportOptions): TqReport {
  const now = opts.now ?? new Date();
  const detail = rows.map(toDetailRow);
  const overall = computeMetrics(detail);
  const period = periodLabel(opts.from, opts.to);

  // Only the Exceptions view narrows the row set; every other type reports on
  // the full filtered population so the headline numbers stay comparable.
  const visibleRows =
    opts.type === "exceptions"
      ? detail.filter((r) => !r.received || r.bucket === "late" || r.bucket === "crunch" || r.bucket === "bid_day")
      : detail;

  const sortedRows = [...visibleRows].sort((a, b) => {
    // Worst runway first; unreceived bids sort to the very top.
    const av = a.leadBusinessDays === null ? -Infinity : a.leadBusinessDays;
    const bv = b.leadBusinessDays === null ? -Infinity : b.leadBusinessDays;
    if (av !== bv) return av - bv;
    return (a.dueDate || "").localeCompare(b.dueDate || "");
  });

  return {
    type: opts.type,
    generatedAt: now.toISOString(),
    periodLabel: period,
    overall,
    buckets: bucketDistribution(detail),
    groups: buildGroups(opts.type, detail),
    rows: opts.type === "detail" || opts.type === "exceptions" ? sortedRows : [],
    tldr: buildTldr(overall, period),
    watchItems: opts.type === "summary" ? buildWatchItems(detail, overall, now, opts.priorRows) : [],
  };
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLines(rows: Array<Array<unknown>>): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function reportToCsv(report: TqReport): string {
  if (report.type === "detail" || report.type === "exceptions") {
    return csvLines([
      [
        "Project Name",
        "Estimate #",
        "Region",
        "Market",
        "Estimator",
        "GC Lead",
        "Status",
        "Due Date",
        "T&Q Received",
        "Received By",
        "Lead (business days)",
        "Bucket",
      ],
      ...report.rows.map((r) => [
        r.projectName,
        r.estimateNumber,
        r.region,
        r.primaryMarket,
        r.nbsEstimator,
        r.gcEstimateLead,
        r.estimateStatus,
        r.dueDate,
        r.tqReceivedDate,
        r.tqReceivedBy,
        r.leadBusinessDays,
        r.bucketLabel,
      ]),
    ]);
  }

  if (report.groups.length > 0) {
    return csvLines([
      [
        TQ_REPORT_LABELS[report.type],
        "Bids",
        "T&Q Received",
        "Coverage %",
        "Median Lead (BD)",
        "Avg Lead (BD)",
        "P90 Lead (BD)",
        "Crunch (≤3 BD)",
        "Late",
        "Never Received",
      ],
      ...report.groups.map((g) => [
        g.label,
        g.bidCount,
        g.receivedCount,
        g.coveragePct,
        g.medianLeadBd,
        g.avgLeadBd,
        g.p90LeadBd,
        g.crunchCount,
        g.lateCount,
        g.notReceivedCount,
      ]),
    ]);
  }

  // Summary: the TL;DR, the headline metrics, then the bucket spread.
  const m = report.overall;
  return csvLines([
    ["T&Q Lead Time — Executive Summary"],
    ["Period", report.periodLabel],
    ["Generated", report.generatedAt],
    [],
    ["Summary", report.tldr],
    [],
    ["Metric", "Value"],
    ["Bids", m.bidCount],
    ["T&Q received", m.receivedCount],
    ["Coverage %", m.coveragePct],
    ["Median lead (BD)", m.medianLeadBd],
    ["Average lead (BD)", m.avgLeadBd],
    ["P90 lead (BD)", m.p90LeadBd],
    ["Crunch (≤3 BD)", m.crunchCount],
    ["Received after bid day", m.lateCount],
    ["Never received", m.notReceivedCount],
    [],
    ["Bucket", "Bids", "% of bids"],
    ...report.buckets.map((b) => [b.label, b.count, b.pct]),
    [],
    ["Watch items"],
    ...report.watchItems.map((w) => [w.text]),
  ]);
}
