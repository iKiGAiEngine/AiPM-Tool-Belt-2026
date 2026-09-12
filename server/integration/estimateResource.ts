// ══════════════════════════════════════════════════════════════════════════
// INTEGRATION API — ESTIMATE RESOURCE
// ══════════════════════════════════════════════════════════════════════════
//
// Turns AiPM's internal tables into the flat, predictable JSON document the
// SharePoint / Power Automate side consumes.
//
// Three things about AiPM's data model shape this file, and they are the
// reason the integration cannot just be a thin dump of the estimates table:
//
//   1. An estimate's identity is split across two tables. `estimates` holds
//      the pricing; the PROJECT facts — Self Perform Estimator, GC lead,
//      region, market, due date, owner, address — live on the proposal log
//      entry the estimate hangs off. Anything SharePoint wants to show in a
//      list view comes from that join, so the join happens here, once.
//
//   2. The total value is not a column. It is derived by
//      shared/estimateCalc.ts from the line items, the vendor quotes and the
//      markup rates. Every dollar figure in this resource comes from there.
//
//   3. Vendors belong to QUOTES, not to line items. A line item points at a
//      quote (`quoteId`), and the quote carries the vendor name, the freight
//      and the lump-sum price. The resource denormalizes the vendor name onto
//      each line item so a SharePoint list can show it without a second call.

import { db } from "../db";
import { eq, and, inArray, gte, desc, sql, type SQL } from "drizzle-orm";
import {
  estimates, estimateLineItems, estimateQuotes, estimateBreakoutGroups,
  estimateBreakoutAllocations, estimateVersions, estimateSpecSections,
  proposalLogEntries,
} from "@shared/schema";
import {
  computeEstimateCalc, computeBreakoutCalc, buildAllocationMap,
  num, money, type EstimateCalcData, type BreakoutCalc,
} from "@shared/estimateCalc";
import { ALL_SCOPES, ALL_SCOPE_IDS, getScope } from "@shared/estimateScopes";

// ── Wire shapes ────────────────────────────────────────────────────────────

export interface ApiLineItem {
  lineItemId: number;
  scopeId: string;
  scopeLabel: string;
  csiCode: string;
  planCallout: string | null;
  name: string;
  model: string | null;
  manufacturer: string | null;
  qty: number;
  uom: string;
  unitCost: number;
  extendedCost: number;
  escalationOverridePct: number | null;
  quoteId: number | null;
  vendor: string | null;
  source: string;
  note: string | null;
  hasBackup: boolean;
  sortOrder: number;
}

export interface ApiQuote {
  quoteId: number;
  scopeId: string;
  scopeLabel: string;
  vendor: string;
  pricingMode: string;
  freight: number;
  lumpSumTotal: number;
  taxIncluded: boolean;
  hasBackup: boolean;
  note: string | null;
  itemCount: number;
  quoteTotal: number;
  status: string | null;
}

export interface ApiScopeTotal {
  scopeId: string;
  scopeLabel: string;
  csiCode: string;
  itemCount: number;
  material: number;
  escalation: number;
  freight: number;
  subtotal: number;
  overhead: number;
  fee: number;
  tax: number;
  bond: number;
  total: number;
  overheadPct: number;
  feePct: number;
  escalationPct: number;
  hasRateOverride: boolean;
  isComplete: boolean;
  missingBackupCount: number;
}

export interface ApiEstimateSummary {
  estimateId: number;
  proposalLogId: number;
  estimateNumber: string;
  projectName: string;
  selfPerformEstimator: string | null;
  nbsEstimator: string | null;
  gcEstimateLead: string | null;
  region: string | null;
  primaryMarket: string | null;
  owner: string | null;
  dueDate: string | null;
  projectAddress: string | null;
  squareFeet: string | null;
  proposalStatus: string | null;
  reviewStatus: string;
  isTest: boolean;
  activeScopes: string[];
  activeScopeLabels: string[];
  lineItemCount: number;
  totalValue: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiEstimate extends ApiEstimateSummary {
  rates: {
    overheadPct: number;
    feePct: number;
    escalationPct: number;
    taxPct: number;
    bondPct: number;
  };
  totals: {
    material: number;
    escalation: number;
    freight: number;
    subtotal: number;
    overhead: number;
    fee: number;
    tax: number;
    bond: number;
    totalValue: number;
  };
  scopeTotals: ApiScopeTotal[];
  lineItems: ApiLineItem[];
  quotes: ApiQuote[];
  breakouts: Array<{
    breakoutId: number;
    code: string;
    label: string;
    type: string;
    itemCount: number;
    material: number;
    freight: number;
    subtotal: number;
    total: number;
  }>;
  assumptions: string[];
  risks: string[];
  qualificationsByScope: Record<string, { inclusions?: string; exclusions?: string; qualifications?: string }>;
  latestVersion: { version: number; savedBy: string | null; savedAt: string; grandTotal: number; notes: string | null } | null;
}

// ── Loading ────────────────────────────────────────────────────────────────

export interface LoadedEstimate {
  estimate: typeof estimates.$inferSelect;
  proposal: typeof proposalLogEntries.$inferSelect | null;
  lineItems: Array<typeof estimateLineItems.$inferSelect>;
  quotes: Array<typeof estimateQuotes.$inferSelect>;
  breakoutGroups: Array<typeof estimateBreakoutGroups.$inferSelect>;
  allocations: Array<typeof estimateBreakoutAllocations.$inferSelect>;
  specSections: Array<typeof estimateSpecSections.$inferSelect>;
  versions: Array<typeof estimateVersions.$inferSelect>;
  calc: EstimateCalcData<any>;
  breakoutCalc: Record<number, BreakoutCalc>;
}

/**
 * The scope ids to run the calculation over: every catalog scope, plus any
 * id that actually appears on this estimate's rows. The second half matters —
 * an estimate can hold line items in "uncategorized", or in a scope retired
 * from the catalog, and those dollars must still reach the total.
 */
function scopeIdsFor(
  est: typeof estimates.$inferSelect,
  lineItems: Array<{ category: string }>,
  quotes: Array<{ category: string }>
): string[] {
  const ids = new Set<string>(ALL_SCOPE_IDS);
  for (const s of est.activeScopes ?? []) ids.add(s);
  for (const i of lineItems) ids.add(i.category);
  for (const q of quotes) ids.add(q.category);
  return Array.from(ids);
}

/** Load one estimate and everything needed to price it. */
export async function loadEstimate(estimateId: number): Promise<LoadedEstimate | null> {
  const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
  if (!est) return null;

  const [lineItems, quotes, breakoutGroups, allocations, specSections, versions] = await Promise.all([
    db.select().from(estimateLineItems).where(eq(estimateLineItems.estimateId, estimateId))
      .orderBy(estimateLineItems.sortOrder, estimateLineItems.createdAt),
    db.select().from(estimateQuotes).where(eq(estimateQuotes.estimateId, estimateId))
      .orderBy(estimateQuotes.createdAt),
    db.select().from(estimateBreakoutGroups).where(eq(estimateBreakoutGroups.estimateId, estimateId))
      .orderBy(estimateBreakoutGroups.sortOrder),
    db.select().from(estimateBreakoutAllocations).where(eq(estimateBreakoutAllocations.estimateId, estimateId)),
    db.select().from(estimateSpecSections).where(eq(estimateSpecSections.estimateId, estimateId)),
    db.select().from(estimateVersions).where(eq(estimateVersions.estimateId, estimateId))
      .orderBy(desc(estimateVersions.version)),
  ]);

  const [proposal] = est.proposalLogId
    ? await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, est.proposalLogId))
    : [];

  const calc = computeEstimateCalc({
    lineItems: lineItems as any,
    quotes: quotes as any,
    scopeIds: scopeIdsFor(est, lineItems, quotes),
    catOverrides: est.catOverrides as any,
    catComplete: est.catComplete as any,
    defaultOh: num(est.defaultOh),
    defaultFee: num(est.defaultFee),
    defaultEsc: num(est.defaultEsc),
    taxRate: num(est.taxRate),
    bondRate: num(est.bondRate),
  });

  const breakoutCalc = computeBreakoutCalc({
    breakoutGroups: breakoutGroups as any,
    lineItems: lineItems as any,
    allocMap: buildAllocationMap(allocations),
    totals: { allMat: calc.allMat, allFrt: calc.allFrt },
    defaultOh: num(est.defaultOh),
    defaultFee: num(est.defaultFee),
    defaultEsc: num(est.defaultEsc),
    taxRate: num(est.taxRate),
    bondRate: num(est.bondRate),
  });

  return { estimate: est, proposal: proposal ?? null, lineItems, quotes, breakoutGroups, allocations, specSections, versions, calc, breakoutCalc };
}

// ── Projection ─────────────────────────────────────────────────────────────

const iso = (d: Date | string | null | undefined): string =>
  d instanceof Date ? d.toISOString() : (d ? new Date(d).toISOString() : new Date(0).toISOString());

export function toSummary(loaded: LoadedEstimate): ApiEstimateSummary {
  const { estimate: e, proposal: p, lineItems, calc } = loaded;
  const activeScopes = e.activeScopes ?? [];
  return {
    estimateId: e.id,
    proposalLogId: e.proposalLogId,
    estimateNumber: e.estimateNumber,
    projectName: e.projectName,
    selfPerformEstimator: p?.selfPerformEstimator ?? null,
    nbsEstimator: p?.nbsEstimator ?? null,
    gcEstimateLead: p?.gcEstimateLead ?? null,
    region: p?.region ?? null,
    primaryMarket: p?.primaryMarket ?? null,
    owner: p?.owner ?? null,
    dueDate: p?.dueDate ?? null,
    projectAddress: p?.projectAddress ?? null,
    squareFeet: p?.squareFeet ?? null,
    proposalStatus: p?.estimateStatus ?? null,
    reviewStatus: e.reviewStatus ?? "drafting",
    isTest: e.isTest ?? false,
    activeScopes,
    activeScopeLabels: activeScopes.map(id => getScope(id).label),
    lineItemCount: lineItems.length,
    totalValue: money(calc.grandTotal),
    createdBy: e.createdBy ?? null,
    createdAt: iso(e.createdAt),
    updatedAt: iso(e.updatedAt),
  };
}

export function toEstimate(loaded: LoadedEstimate): ApiEstimate {
  const { estimate: e, lineItems, quotes, breakoutGroups, versions, calc, breakoutCalc } = loaded;

  const quoteById = new Map(quotes.map(q => [q.id, q]));
  const catOverrides = (e.catOverrides ?? {}) as Record<string, { oh?: number; fee?: number; esc?: number }>;

  // Only report scopes that actually carry something, so a SharePoint list
  // does not fill with 19 zero rows per estimate.
  const scopeIdsWithContent = Array.from(new Set([
    ...lineItems.map(i => i.category),
    ...quotes.map(q => q.category),
  ]));
  // Keep the catalog's order, then append anything off-catalog.
  const orderedScopeIds = [
    ...ALL_SCOPES.map(s => s.id).filter(id => scopeIdsWithContent.includes(id)),
    ...scopeIdsWithContent.filter(id => !ALL_SCOPES.some(s => s.id === id)),
  ];

  const scopeTotals: ApiScopeTotal[] = orderedScopeIds.map(id => {
    const d = calc[id] ?? {};
    const scope = getScope(id);
    const ov = catOverrides[id];
    return {
      scopeId: id,
      scopeLabel: scope.label,
      csiCode: scope.csi,
      itemCount: d.items ?? 0,
      material: money(d.material ?? 0),
      escalation: money(d.escalation ?? 0),
      freight: money(d.totalFreight ?? 0),
      subtotal: money(d.subtotal ?? 0),
      overhead: money(d.oh ?? 0),
      fee: money(d.fee ?? 0),
      tax: money(d.tax ?? 0),
      bond: money(d.bond ?? 0),
      total: money(d.total ?? 0),
      overheadPct: d.ohRate ?? num(e.defaultOh),
      feePct: d.feeRate ?? num(e.defaultFee),
      escalationPct: d.escRate ?? num(e.defaultEsc),
      hasRateOverride: !!ov && (ov.oh != null || ov.fee != null || ov.esc != null),
      isComplete: d.isComplete ?? false,
      missingBackupCount: d.missingBackup ?? 0,
    };
  });

  const apiLineItems: ApiLineItem[] = lineItems.map(i => {
    const scope = getScope(i.category);
    const q = i.quoteId != null ? quoteById.get(i.quoteId) : undefined;
    return {
      lineItemId: i.id,
      scopeId: i.category,
      scopeLabel: scope.label,
      csiCode: scope.csi,
      planCallout: i.planCallout ?? null,
      name: i.name,
      model: i.model ?? null,
      manufacturer: i.mfr ?? null,
      qty: i.qty,
      uom: i.uom ?? "EA",
      unitCost: money(num(i.unitCost)),
      extendedCost: money(num(i.unitCost) * i.qty),
      escalationOverridePct: i.escOverride != null ? num(i.escOverride) : null,
      quoteId: i.quoteId ?? null,
      vendor: q?.vendor ?? null,
      source: i.source ?? "manual",
      note: i.note ?? null,
      hasBackup: i.hasBackup ?? false,
      sortOrder: i.sortOrder ?? 0,
    };
  });

  const apiQuotes: ApiQuote[] = quotes.map(q => {
    const qItems = lineItems.filter(i => i.quoteId === q.id);
    const quoteTotal = q.pricingMode === "lump_sum"
      ? num(q.lumpSumTotal)
      : qItems.reduce((s, i) => s + num(i.unitCost) * i.qty, 0);
    return {
      quoteId: q.id,
      scopeId: q.category,
      scopeLabel: getScope(q.category).label,
      vendor: q.vendor,
      pricingMode: q.pricingMode ?? "per_item",
      freight: money(num(q.freight)),
      lumpSumTotal: money(num(q.lumpSumTotal)),
      taxIncluded: q.taxIncluded ?? false,
      hasBackup: q.hasBackup ?? false,
      note: q.note ?? null,
      itemCount: qItems.length,
      quoteTotal: money(quoteTotal),
      status: q.status ?? null,
    };
  });

  const latest = versions[0];

  return {
    ...toSummary(loaded),
    rates: {
      overheadPct: num(e.defaultOh),
      feePct: num(e.defaultFee),
      escalationPct: num(e.defaultEsc),
      taxPct: num(e.taxRate),
      bondPct: num(e.bondRate),
    },
    totals: {
      material: money(calc.allMat),
      escalation: money(calc.allEsc),
      freight: money(calc.allFrt),
      subtotal: money(calc.allSub),
      overhead: money(calc.allOh),
      fee: money(calc.allFee),
      tax: money(calc.allTax),
      bond: money(calc.allBond),
      totalValue: money(calc.grandTotal),
    },
    scopeTotals,
    lineItems: apiLineItems,
    quotes: apiQuotes,
    breakouts: breakoutGroups.map(g => {
      const d = breakoutCalc[g.id];
      return {
        breakoutId: g.id,
        code: g.code,
        label: g.label,
        type: g.type ?? "building",
        itemCount: d?.itemCount ?? 0,
        material: money(d?.material ?? 0),
        freight: money(d?.freight ?? 0),
        subtotal: money(d?.subtotal ?? 0),
        total: money(d?.total ?? 0),
      };
    }),
    assumptions: (e.assumptions ?? []) as string[],
    risks: (e.risks ?? []) as string[],
    qualificationsByScope: (e.catQuals ?? {}) as Record<string, any>,
    latestVersion: latest
      ? {
          version: latest.version,
          savedBy: latest.savedBy ?? null,
          savedAt: iso(latest.savedAt),
          grandTotal: money(num(latest.grandTotal)),
          notes: latest.notes ?? null,
        }
      : null,
  };
}

// ── Listing ────────────────────────────────────────────────────────────────

export interface ListFilters {
  updatedSince?: Date;
  reviewStatus?: string;
  estimateNumber?: string;
  proposalLogId?: number;
  includeTest: boolean;
  limit: number;
  offset: number;
}

/**
 * List estimates newest-updated first.
 *
 * `updatedSince` is what makes a Power Automate recurrence behave like a
 * trigger: store the timestamp of the last successful run, pass it back, and
 * only estimates touched since then come out.
 */
export async function listEstimates(f: ListFilters): Promise<{ rows: ApiEstimateSummary[]; total: number }> {
  const conditions: SQL[] = [];
  if (f.updatedSince) conditions.push(gte(estimates.updatedAt, f.updatedSince));
  if (f.reviewStatus) conditions.push(eq(estimates.reviewStatus, f.reviewStatus));
  if (f.estimateNumber) conditions.push(eq(estimates.estimateNumber, f.estimateNumber));
  if (f.proposalLogId != null) conditions.push(eq(estimates.proposalLogId, f.proposalLogId));
  if (!f.includeTest) conditions.push(eq(estimates.isTest, false));
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(estimates)
    .where(where);

  const page = await db
    .select()
    .from(estimates)
    .where(where)
    .orderBy(desc(estimates.updatedAt), desc(estimates.id))
    .limit(f.limit)
    .offset(f.offset);

  if (page.length === 0) return { rows: [], total: count };

  // Batch the children in three queries instead of six per estimate — a
  // Power Automate poll asking for 100 estimates should not fan out into
  // hundreds of round trips.
  const estimateIds = page.map(e => e.id);
  const proposalIds = Array.from(new Set(page.map(e => e.proposalLogId).filter((v): v is number => v != null)));

  const [allItems, allQuotes, allProposals] = await Promise.all([
    db.select().from(estimateLineItems).where(inArray(estimateLineItems.estimateId, estimateIds)),
    db.select().from(estimateQuotes).where(inArray(estimateQuotes.estimateId, estimateIds)),
    proposalIds.length
      ? db.select().from(proposalLogEntries).where(inArray(proposalLogEntries.id, proposalIds))
      : Promise.resolve([] as Array<typeof proposalLogEntries.$inferSelect>),
  ]);

  const itemsBy = groupBy(allItems, i => i.estimateId);
  const quotesBy = groupBy(allQuotes, q => q.estimateId);
  const proposalBy = new Map(allProposals.map(p => [p.id, p]));

  const rows = page.map(e => {
    const lineItems = itemsBy.get(e.id) ?? [];
    const quotes = quotesBy.get(e.id) ?? [];
    const calc = computeEstimateCalc({
      lineItems: lineItems as any,
      quotes: quotes as any,
      scopeIds: scopeIdsFor(e, lineItems, quotes),
      catOverrides: e.catOverrides as any,
      catComplete: e.catComplete as any,
      defaultOh: num(e.defaultOh),
      defaultFee: num(e.defaultFee),
      defaultEsc: num(e.defaultEsc),
      taxRate: num(e.taxRate),
      bondRate: num(e.bondRate),
    });
    return toSummary({
      estimate: e,
      proposal: proposalBy.get(e.proposalLogId) ?? null,
      lineItems, quotes,
      breakoutGroups: [], allocations: [], specSections: [], versions: [],
      calc, breakoutCalc: {},
    });
  });

  return { rows, total: count };
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = m.get(k);
    if (bucket) bucket.push(row); else m.set(k, [row]);
  }
  return m;
}
