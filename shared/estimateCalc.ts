// ══════════════════════════════════════════════════════════════════════════
// AiPM ESTIMATING — TOTALS MATH (single source of truth)
// ══════════════════════════════════════════════════════════════════════════
//
// An estimate's dollar value is NOT stored in the database. It is derived
// every time from the line items, the vendor quotes, and the markup rates.
// This module is that derivation.
//
// It lives in shared/ because three different places need the exact same
// number and they must never disagree:
//   1. EstimatingModulePage.tsx — what the estimator sees on screen
//   2. the Excel workbook export
//   3. the SharePoint / Power Automate integration API
//
// Two rules in here are easy to get wrong if you re-implement the math
// somewhere else, which is precisely why nobody should:
//
//   • FEE IS GROSSED UP, NOT MARKED UP.
//     fee = subtotal / (1 - feeRate) - subtotal
//     A 15% fee on a $100 subtotal is $17.65, not $15.00 — because the fee is
//     a percentage OF THE SELLING PRICE, so the selling price has to absorb
//     it. Overhead, by contrast, is a plain markup on the subtotal.
//
//   • A LUMP-SUM QUOTE TOPS UP ITS SCOPE, IT DOES NOT REPLACE IT.
//     If a vendor quotes one lump sum that is higher than the sum of the line
//     items tied to that quote, the difference is added as `lumpAdj` so the
//     scope totals to the quoted number. If the line items already exceed the
//     lump sum, nothing is subtracted (Math.max(0, ...)).

/** Parse a numeric-ish DB value ("1234.50", 1234.5, null) into a number. */
export const num = (v: string | number | null | undefined): number =>
  parseFloat(String(v ?? "0")) || 0;

export interface CalcLineItem {
  category: string;
  qty: number;
  unitCost: string | number | null;
  escOverride?: string | number | null;
  quoteId?: number | null;
  hasBackup?: boolean | null;
}

export interface CalcQuote {
  id: number;
  category: string;
  pricingMode?: string | null;
  lumpSumTotal?: string | number | null;
  freight?: string | number | null;
}

export interface CategoryOverride {
  oh?: number | null;
  fee?: number | null;
  esc?: number | null;
}

export interface EstimateCalcInput<Q extends CalcQuote = CalcQuote> {
  lineItems: CalcLineItem[];
  quotes: Q[];
  /** Which scope ids to compute. Callers pass ALL_SCOPES ids (+ uncategorized). */
  scopeIds: string[];
  catOverrides?: Record<string, CategoryOverride> | null;
  catComplete?: Record<string, boolean> | null;
  defaultOh: number;
  defaultFee: number;
  defaultEsc: number;
  taxRate: number;
  bondRate: number;
}

/** Per-scope breakdown. One of these per scope id in the result. */
export interface ScopeCalc<Q extends CalcQuote = CalcQuote> {
  /** Number of line items in this scope. */
  items: number;
  /** Material cost, including any lump-sum top-up. */
  material: number;
  escalation: number;
  escRate: number;
  isEscOvr: boolean;
  escImpact: number;
  totalFreight: number;
  catQuotes: Q[];
  subtotal: number;
  ohRate: number;
  isOhOvr: boolean;
  oh: number;
  ohImpact: number;
  feeRate: number;
  isFeeOvr: boolean;
  fee: number;
  feeImpact: number;
  tax: number;
  bond: number;
  /** Sell price for this scope. */
  total: number;
  missingBackup: number;
  isComplete: boolean;
}

/** Estimate-wide rollup. */
export interface EstimateTotals {
  allMat: number;
  allEsc: number;
  allFrt: number;
  allSub: number;
  allOh: number;
  allFee: number;
  allTax: number;
  allBond: number;
  grandTotal: number;
}

/**
 * The shape the estimating page consumes: every scope id is a key holding a
 * ScopeCalc, plus the estimate-wide `all*` / `grandTotal` keys alongside them.
 */
export type EstimateCalcData<Q extends CalcQuote = CalcQuote> =
  EstimateTotals & Record<string, any>;

export function computeEstimateCalc<Q extends CalcQuote>(
  input: EstimateCalcInput<Q>
): EstimateCalcData<Q> {
  const {
    lineItems, quotes, scopeIds,
    defaultOh, defaultFee, defaultEsc, taxRate, bondRate,
  } = input;
  const catOverrides = input.catOverrides ?? {};
  const catComplete = input.catComplete ?? {};

  const data: Record<string, any> = {};

  for (const scopeId of scopeIds) {
    const items = lineItems.filter(i => i.category === scopeId);
    const catQ = quotes.filter(q => q.category === scopeId);

    const material = items.reduce((s, i) => s + num(i.unitCost) * i.qty, 0);

    // Lump-sum top-up: bring the scope up to the quoted number, never down.
    const lumpAdj = catQ.reduce((s, q) => {
      if (q.pricingMode === "lump_sum" && num(q.lumpSumTotal) > 0) {
        const qTotal = items
          .filter(i => i.quoteId === q.id)
          .reduce((ss, i) => ss + num(i.unitCost) * i.qty, 0);
        return s + Math.max(0, num(q.lumpSumTotal) - qTotal);
      }
      return s;
    }, 0);
    const effMat = material + lumpAdj;

    const escRate = catOverrides[scopeId]?.esc ?? defaultEsc;
    const isEscOvr = catOverrides[scopeId]?.esc != null;
    const escalation = items.reduce((s, i) => {
      const r = i.escOverride != null ? num(i.escOverride) : escRate;
      return s + num(i.unitCost) * i.qty * (r / 100);
    }, 0) + lumpAdj * (escRate / 100);

    const totalFreight = catQ.reduce((s, q) => s + num(q.freight), 0);
    const subtotal = effMat + escalation + totalFreight;

    const ohRate = catOverrides[scopeId]?.oh ?? defaultOh;
    const isOhOvr = catOverrides[scopeId]?.oh != null;
    const oh = subtotal * (ohRate / 100);
    const ohImpact = oh - subtotal * (defaultOh / 100);

    const feeRate = catOverrides[scopeId]?.fee ?? defaultFee;
    const isFeeOvr = catOverrides[scopeId]?.fee != null;
    const feePct = feeRate / 100;
    // Grossed up, not marked up — see the header note.
    const fee = feePct <= 0 || feePct >= 1 ? 0 : (subtotal / (1 - feePct)) - subtotal;
    const defaultFeePct = defaultFee / 100;
    const defaultFeeAmt = defaultFeePct <= 0 || defaultFeePct >= 1 ? 0 : (subtotal / (1 - defaultFeePct)) - subtotal;
    const feeImpact = fee - defaultFeeAmt;

    const escImpact = escalation - effMat * (defaultEsc / 100);
    const tax = effMat * (taxRate / 100);
    const bond = subtotal * (bondRate / 100);
    const total = subtotal + oh + fee + tax + bond;

    const missingBackup = items.filter(i => !i.hasBackup).length;
    const isComplete = catComplete[scopeId] || false;

    data[scopeId] = {
      items: items.length, material: effMat, escalation, escRate, isEscOvr, escImpact,
      totalFreight, catQuotes: catQ, subtotal, ohRate, isOhOvr, oh, ohImpact,
      feeRate, isFeeOvr, fee, feeImpact, tax, bond, total, missingBackup, isComplete,
    };
  }

  const g = (fn: (d: any) => number) => Object.values(data).reduce((s, d) => s + fn(d), 0);
  const allMat = g(d => d.material), allEsc = g(d => d.escalation), allFrt = g(d => d.totalFreight);
  const allSub = g(d => d.subtotal), allOh = g(d => d.oh), allFee = g(d => d.fee);
  const allTax = g(d => d.tax), allBond = g(d => d.bond);
  const grandTotal = allSub + allOh + allFee + allTax + allBond;

  return { ...data, allMat, allEsc, allFrt, allSub, allOh, allFee, allTax, allBond, grandTotal } as EstimateCalcData<Q>;
}

/** Typed read of one scope's breakdown out of a calc result. */
export function scopeCalc<Q extends CalcQuote>(
  calc: EstimateCalcData<Q>,
  scopeId: string
): ScopeCalc<Q> | undefined {
  const v = calc[scopeId];
  return v && typeof v === "object" ? (v as ScopeCalc<Q>) : undefined;
}

/** Pull just the estimate-wide rollup out of a calc result. */
export function totalsOf(calc: EstimateCalcData<any>): EstimateTotals {
  return {
    allMat: calc.allMat, allEsc: calc.allEsc, allFrt: calc.allFrt,
    allSub: calc.allSub, allOh: calc.allOh, allFee: calc.allFee,
    allTax: calc.allTax, allBond: calc.allBond, grandTotal: calc.grandTotal,
  };
}

/** Round to cents — for money crossing an API boundary. */
export const money = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════
// BREAKOUTS
// ══════════════════════════════════════════════════════════════════════════
//
// A breakout group is an alternate slice of the same estimate — "Building A",
// "Alternate 3", "Phase 2" — built by allocating quantities of existing line
// items to the group. Breakouts carry their own OH / fee / escalation
// overrides, and freight is either entered manually or prorated by the
// group's share of total material.

export interface CalcBreakoutGroup {
  id: number;
  ohOverride?: string | number | null;
  feeOverride?: string | number | null;
  escOverride?: string | number | null;
  freightMethod?: string | null;
  manualFreight?: string | number | null;
}

export interface CalcAllocation {
  lineItemId: number;
  breakoutGroupId: number;
  qty: number;
}

export interface BreakoutCalc {
  material: number;
  escalation: number;
  freight: number;
  subtotal: number;
  oh: number;
  fee: number;
  tax: number;
  bond: number;
  total: number;
  itemCount: number;
  ohRate: number;
  feeRate: number;
  escRate: number;
}

/** lineItemId → breakoutGroupId → allocated qty. */
export function buildAllocationMap(allocations: CalcAllocation[]): Record<number, Record<number, number>> {
  const m: Record<number, Record<number, number>> = {};
  for (const a of allocations) {
    if (!m[a.lineItemId]) m[a.lineItemId] = {};
    m[a.lineItemId][a.breakoutGroupId] = a.qty;
  }
  return m;
}

export function computeBreakoutCalc(input: {
  breakoutGroups: CalcBreakoutGroup[];
  lineItems: (CalcLineItem & { id: number })[];
  allocMap: Record<number, Record<number, number>>;
  /** Estimate-wide rollup — breakout freight is prorated against it. */
  totals: Pick<EstimateTotals, "allMat" | "allFrt">;
  defaultOh: number;
  defaultFee: number;
  defaultEsc: number;
  taxRate: number;
  bondRate: number;
}): Record<number, BreakoutCalc> {
  const { breakoutGroups, lineItems, allocMap, totals, defaultOh, defaultFee, defaultEsc, taxRate, bondRate } = input;
  if (breakoutGroups.length === 0) return {};

  const data: Record<number, BreakoutCalc> = {};
  for (const group of breakoutGroups) {
    let material = 0;
    let itemCount = 0;
    for (const item of lineItems) {
      const allocQty = allocMap[item.id]?.[group.id] || 0;
      if (allocQty > 0) { material += num(item.unitCost) * allocQty; itemCount++; }
    }
    const ohRate = num(group.ohOverride) || defaultOh;
    const feeRate = num(group.feeOverride) || defaultFee;
    const escRate = num(group.escOverride) || defaultEsc;
    const escalation = material * (escRate / 100);
    const totalMat = totals.allMat || 1;
    const freight = group.freightMethod === "manual" && group.manualFreight != null
      ? num(group.manualFreight)
      : totalMat > 0 ? (material / totalMat) * totals.allFrt : 0;
    const subtotal = material + escalation + freight;
    const oh = subtotal * (ohRate / 100);
    const breakoutFeePct = feeRate / 100;
    const fee = breakoutFeePct <= 0 || breakoutFeePct >= 1 ? 0 : (subtotal / (1 - breakoutFeePct)) - subtotal;
    const tax = material * (taxRate / 100);
    const bond = subtotal * (bondRate / 100);
    const total = subtotal + oh + fee + tax + bond;
    data[group.id] = { material, escalation, freight, subtotal, oh, fee, tax, bond, total, itemCount, ohRate, feeRate, escRate };
  }
  return data;
}
