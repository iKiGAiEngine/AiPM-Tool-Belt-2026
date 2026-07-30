// =====================================================
// SUBMITTAL BUILDER — package document + derived state
// =====================================================
//
// The whole submittal package lives in one JSONB column
// (submittal_projects.package_data); header fields used by the list view are
// cached as real columns on write. Same shape as the Buyout Bot board.
//
// Every "how far along is this package" question is answered HERE and only
// here. The workspace header, the dashboard list, the validation panel and the
// server's cached columns all call the same functions, because when they each
// had their own copy they disagreed: a package with lines marked "By Others"
// reported 91% / "Waiting on Product Data" in the header while the validation
// panel correctly said nothing was missing.

export const SUBMITTAL_PACKAGE_VERSION = 1;

/** Where a single schedule line stands. */
export type LineStatus = "missing" | "pending" | "attached" | "not_required" | "by_others";

/** Where the whole package stands. Derived — never set by hand except `exported`. */
export type SubmittalStatus =
  | "not_started"
  | "in_progress"
  | "waiting_product_data"
  | "ready_for_review"
  | "ready_for_export"
  | "exported";

/** How confident we are that an attached PDF belongs to its line. */
export type MatchStatus = "exact" | "partial" | "manual";

export type CoverRowType = "Schedule" | "Product Data" | "Color Chart" | "Shop Drawings";

export interface Attachment {
  id: string;
  fileName: string;
  mimeType?: string;
  /** Real page count read from the PDF on upload. */
  pageCount: number;
  calloutStamp: string;
  matchStatus: MatchStatus;
  sortOrder: number;
  /** Bytes live in submittal_attachments; absent means the upload never landed. */
  stored?: boolean;
}

export interface ScheduleLine {
  id: string;
  callout: string;
  desc: string;
  model: string;
  /** Free text while editing, number once parsed — both are persisted as-is. */
  qty: string | number;
  lineStatus: LineStatus;
  sortOrder: number;
  attachments: Attachment[];
}

export interface CoverLine {
  id: string;
  type: CoverRowType | string;
  comment: string;
  /** Legacy fields — the cover always renders the scope's own csi/tabName. */
  spec?: string;
  desc?: string;
}

export interface Scope {
  id: string;
  /** Original worksheet name, so the PM recognizes their own tab. */
  tabName: string;
  /** Canonical scope name when the tab resolved to one. */
  scopeName?: string;
  csi: string;
  specTitle: string;
  sortOrder: number;
  scopeStatus: string;
  lines: ScheduleLine[];
  coverLines: CoverLine[];
}

/** The JSONB document. */
export interface SubmittalPackage {
  version: number;
  scopes: Scope[];
  /** Where the PM was last working, so reopening lands in the same place. */
  lastActiveScopeId?: string | null;
  lastActiveTab?: string;
  /** Workbook this package was imported from, for the "replace estimate" flow. */
  sourceFilename?: string | null;
}

/** A package plus its header fields — what the client works with. */
export interface SubmittalProject {
  id: string;
  proposalLogId: string;
  projectName: string;
  gc: string;
  attention: string;
  assignedPm: string;
  coverDate: string;
  estimateNumber?: string | null;
  region?: string | null;
  sourceFilename?: string | null;
  submittalStatus: SubmittalStatus;
  completionPercent: number;
  createdAt: number;
  updatedAt: number;
  lastActiveScopeId: string | null;
  lastActiveTab: string;
  scopes: Scope[];
}

export interface ProposalLogEntry {
  id: number;
  projectName: string;
  gcEstimateLead?: string;
  estimateStatus?: string;
  estimateNumber?: string;
  region?: string;
  nbsEstimator?: string;
  proposalTotal?: string;
  anticipatedStart?: string;
}

// ---------------------------------------------------------------------------
// Derived state — the single source of truth
// ---------------------------------------------------------------------------

/**
 * A line the PM has deliberately taken out of the package. These are DONE, not
 * outstanding: a grab bar supplied by the GC needs no product data, and a
 * package full of them must still be able to reach 100%.
 */
export function isLineExcluded(line: ScheduleLine): boolean {
  return line.lineStatus === "not_required" || line.lineStatus === "by_others";
}

/** True when this line needs nothing further from the PM. */
export function isLineResolved(line: ScheduleLine): boolean {
  if (isLineExcluded(line)) return true;
  return (line.attachments?.length ?? 0) > 0;
}

export interface Progress {
  /** Line items in scope (excluded lines included in the count). */
  total: number;
  /** Lines needing nothing further — attached or deliberately excluded. */
  resolved: number;
  /** Lines with at least one attached PDF. */
  attached: number;
  /** Lines marked Not Required / By Others. */
  excluded: number;
  /** Lines still waiting on product data. */
  outstanding: number;
  percent: number;
  complete: boolean;
}

function emptyProgress(): Progress {
  return { total: 0, resolved: 0, attached: 0, excluded: 0, outstanding: 0, percent: 0, complete: false };
}

function tally(lines: ScheduleLine[] | undefined): Progress {
  const p = emptyProgress();
  for (const line of lines ?? []) {
    p.total++;
    if (isLineExcluded(line)) {
      p.excluded++;
      p.resolved++;
    } else if ((line.attachments?.length ?? 0) > 0) {
      p.attached++;
      p.resolved++;
    } else {
      p.outstanding++;
    }
  }
  p.percent = p.total === 0 ? 0 : Math.round((p.resolved / p.total) * 100);
  p.complete = p.total > 0 && p.resolved === p.total;
  return p;
}

export function scopeProgress(scope: Scope | null | undefined): Progress {
  return tally(scope?.lines);
}

export function packageProgress(scopes: Scope[] | null | undefined): Progress {
  const all: ScheduleLine[] = [];
  for (const s of scopes ?? []) {
    for (const l of s.lines ?? []) all.push(l);
  }
  return tally(all);
}

/**
 * Derive the package status.
 *
 * `hasBlockers` comes from validation: a package where every line is resolved
 * but something still needs a human decision is *Ready for Review*, and only a
 * clean one is *Ready for Export*. Without this both statuses were unreachable
 * dead entries in the status list.
 *
 * `current` is respected only for `exported`, which is a real-world fact the
 * app must not invent or erase — previously the auto-derive overwrote it the
 * instant the export finished, so a sent package never looked sent.
 */
export function derivePackageStatus(
  scopes: Scope[] | null | undefined,
  opts: { current?: SubmittalStatus; hasBlockers?: boolean } = {}
): SubmittalStatus {
  const list = scopes ?? [];
  if (list.length === 0) return "not_started";

  const p = packageProgress(list);
  if (p.total === 0) return "in_progress";

  if (p.complete) {
    // A package stays "exported" until it is edited back into an incomplete state.
    if (opts.current === "exported") return "exported";
    return opts.hasBlockers ? "ready_for_review" : "ready_for_export";
  }
  return p.resolved === 0 ? "in_progress" : "waiting_product_data";
}

/** Cached list-view columns, computed on every write. */
export function packageTotals(scopes: Scope[] | null | undefined) {
  const p = packageProgress(scopes);
  return {
    scopeCount: (scopes ?? []).length,
    lineCount: p.total,
    resolvedCount: p.resolved,
    completionPercent: p.percent,
  };
}

export function normalizePackage(input: unknown): SubmittalPackage {
  const raw = (input ?? {}) as Partial<SubmittalPackage>;
  const scopes = Array.isArray(raw.scopes) ? raw.scopes : [];
  return {
    version: SUBMITTAL_PACKAGE_VERSION,
    scopes: scopes.map((s, i) => ({
      ...s,
      sortOrder: typeof s.sortOrder === "number" ? s.sortOrder : i,
      lines: Array.isArray(s.lines) ? s.lines : [],
      coverLines: Array.isArray(s.coverLines) ? s.coverLines : [],
    })),
    lastActiveScopeId: raw.lastActiveScopeId ?? null,
    lastActiveTab: raw.lastActiveTab || "schedule",
    sourceFilename: raw.sourceFilename ?? null,
  };
}
