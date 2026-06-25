// =====================================================
// BUYOUT BOT — Board data model (client + server shared)
// =====================================================
//
// The Buyout Bot board is persisted as a single JSONB document on the
// buyoutProjects row (see schema.ts). These interfaces are that document's
// shape. IDs inside the document are client-generated strings (uuid-ish) so
// the whole board round-trips through one PATCH without normalization.

import type { CanonicalScope } from "./canonicalScopes";

export type BuyoutScopeStatus =
  | "not_started"
  | "rfq_sent"
  | "quotes_in"
  | "awarded"
  | "po";

export interface LineItem {
  id: string;
  specNo: string;
  callout: string;
  description: string;
  model: string;
  qty: number;
  material: number;
  freight: number;
  labor: number;
  total: number;
  isAllowance: boolean;
}

export interface QuoteAttachment {
  name: string;
  date: string; // ISO
}

export interface QuoteResponse {
  id: string;
  vendorId: string; // mfrVendors.id as string
  vendorName: string;
  quoteAmount: number;
  note: string;
  /** null = covers the full scope; otherwise the specific LineItem ids covered. */
  coveredLineIds: string[] | null;
  leadTimeWeeks: number;
  /** Stamped when the amount is first entered. */
  quoteDate: string | null; // ISO date
  validityDays: number; // default 45
  attachments: QuoteAttachment[];
  /** AI-extracted (unverified) until a human confirms. */
  aiSuggested: boolean;
  verified: boolean;
}

export interface BuyoutScope {
  id: string;
  name: CanonicalScope; // canonical scope name
  /** Original estimate tab name, kept for traceability. */
  sheetName?: string;
  status: BuyoutScopeStatus;
  budget: {
    material: number;
    freight: number;
    labor: number;
    total: number; // raw cost (pre-markup)
    grand: number; // marked-up, display only
  };
  items: LineItem[];
  quotes: QuoteResponse[];
  /** MULTIPLE vendors per scope (line-level split awards). */
  awardedVendorIds: string[];
  rosDate: string | null; // required-on-site (YYYY-MM-DD)
  submittalWeeks: number; // default 3
}

export interface BuyoutBoard {
  scopes: BuyoutScope[];
  /** Schema version for forward-compat migrations of the JSONB blob. */
  version: number;
}

export const BUYOUT_BOARD_VERSION = 1;
export const DEFAULT_SUBMITTAL_WEEKS = 3;
export const DEFAULT_VALIDITY_DAYS = 45;

// ---- Derived logic (shared so UI + export + tests agree) -------------------

/** Combined awarded total = sum of quoteAmount across awarded vendors. */
export function combinedAwardedTotal(scope: BuyoutScope): number {
  return scope.awardedVendorIds.reduce((sum, vid) => {
    const q = scope.quotes.find((qq) => qq.vendorId === vid);
    return sum + (q ? q.quoteAmount : 0);
  }, 0);
}

/** Variance = combined awarded − budget.total (negative = under budget). */
export function awardedVariance(scope: BuyoutScope): number {
  return combinedAwardedTotal(scope) - scope.budget.total;
}

export interface CoverageReport {
  /** LineItem ids covered by no awarded vendor. */
  uncovered: string[];
  /** LineItem ids covered by more than one awarded vendor (possible double-count). */
  doubleCovered: string[];
  allCovered: boolean;
}

/** Across awarded vendors, compute line coverage counts. */
export function coverageReport(scope: BuyoutScope): CoverageReport {
  const counts = new Map<string, number>();
  for (const it of scope.items) counts.set(it.id, 0);

  for (const vid of scope.awardedVendorIds) {
    const q = scope.quotes.find((qq) => qq.vendorId === vid);
    if (!q) continue;
    // null coveredLineIds = covers the whole scope.
    const covered = q.coveredLineIds == null ? scope.items.map((i) => i.id) : q.coveredLineIds;
    for (const lid of covered) counts.set(lid, (counts.get(lid) || 0) + 1);
  }

  const uncovered: string[] = [];
  const doubleCovered: string[] = [];
  for (const it of scope.items) {
    const c = counts.get(it.id) || 0;
    if (c === 0) uncovered.push(it.id);
    else if (c > 1) doubleCovered.push(it.id);
  }
  return { uncovered, doubleCovered, allCovered: uncovered.length === 0 };
}

/**
 * Buyout clock. releaseBy = rosDate − (max leadTimeWeeks among awarded, or among
 * quoted if none awarded) − submittalWeeks. Returns null when ROS is unset.
 */
export function computeReleaseBy(scope: BuyoutScope): { releaseBy: string; daysUntil: number; leadWeeks: number } | null {
  if (!scope.rosDate) return null;
  const awardedQuotes = scope.quotes.filter((q) => scope.awardedVendorIds.includes(q.vendorId));
  const pool = awardedQuotes.length > 0 ? awardedQuotes : scope.quotes;
  const leadWeeks = pool.reduce((m, q) => Math.max(m, q.leadTimeWeeks || 0), 0);

  const ros = new Date(scope.rosDate + "T00:00:00");
  const release = new Date(ros);
  release.setDate(release.getDate() - (leadWeeks + scope.submittalWeeks) * 7);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysUntil = Math.round((release.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  const yyyy = release.getFullYear();
  const mm = String(release.getMonth() + 1).padStart(2, "0");
  const dd = String(release.getDate()).padStart(2, "0");
  return { releaseBy: `${yyyy}-${mm}-${dd}`, daysUntil, leadWeeks };
}

export type ClockUrgency = "red" | "amber" | "normal" | null;

export function clockUrgency(scope: BuyoutScope): ClockUrgency {
  const c = computeReleaseBy(scope);
  if (!c) return null;
  if (c.daysUntil <= 14) return "red";
  if (c.daysUntil <= 30) return "amber";
  return "normal";
}

/** A quote is stale when now > quoteDate + validityDays. */
export function isQuoteStale(q: QuoteResponse, now: Date = new Date()): boolean {
  if (!q.quoteDate) return false;
  const expiry = new Date(q.quoteDate + "T00:00:00");
  expiry.setDate(expiry.getDate() + (q.validityDays || DEFAULT_VALIDITY_DAYS));
  return now.getTime() > expiry.getTime();
}

/** Whether a quote may be awarded — unverified AI quotes are gated out. */
export function canAward(q: QuoteResponse): boolean {
  return q.verified === true;
}

/** Project completion = every scope at `po`. */
export function isBoardComplete(board: BuyoutBoard): boolean {
  return board.scopes.length > 0 && board.scopes.every((s) => s.status === "po");
}

/** Count of scopes that are bought out (status === po). */
export function boughtOutCount(board: BuyoutBoard): number {
  return board.scopes.filter((s) => s.status === "po").length;
}

export interface BoardTotals {
  budgetTotal: number;
  awardedTotal: number;
  variance: number;
  boughtOut: number;
  scopeCount: number;
  complete: boolean;
}

export function boardTotals(board: BuyoutBoard): BoardTotals {
  let budgetTotal = 0;
  let awardedTotal = 0;
  for (const s of board.scopes) {
    budgetTotal += s.budget.total;
    awardedTotal += combinedAwardedTotal(s);
  }
  return {
    budgetTotal,
    awardedTotal,
    variance: awardedTotal - budgetTotal,
    boughtOut: boughtOutCount(board),
    scopeCount: board.scopes.length,
    complete: isBoardComplete(board),
  };
}
