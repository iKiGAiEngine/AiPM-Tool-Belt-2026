// ══════════════════════════════════════════════════════════════════════════
// INTEGRATION API — ESTIMATE WORKBOOK
// ══════════════════════════════════════════════════════════════════════════
//
// Builds the estimate workbook server-side, laid out sheet-for-sheet and
// column-for-column like the one an estimator downloads from the Estimating
// Module (client/src/lib/exportEstimateExcel.ts).
//
// The sheets are defined ONCE, as data, and then rendered two ways:
//
//   renderWorkbook(sheets)  → .xlsx bytes, for Power Automate to drop into a
//                             SharePoint document library as a real file.
//   sheets themselves       → JSON rows, for Power Automate's Excel Online
//                             connector to write row by row into a workbook
//                             that already lives in SharePoint — i.e. filling
//                             the sheet out cell by cell, as if typed in.
//
// Because both come from the same definition, the file and the row feed can
// never drift apart.

import * as XLSX from "xlsx";
import type { LoadedEstimate } from "./estimateResource";
import { num } from "@shared/estimateCalc";
import { ALL_SCOPES, getScope } from "@shared/estimateScopes";

export type CellFormat = "text" | "currency" | "percent";

export interface SheetDef {
  /** Excel sheet name. Max 31 chars — Excel's own limit. */
  name: string;
  /** Header row for table-shaped sheets; null for key/value sheets. */
  columns: string[] | null;
  /** Data rows, excluding the header. */
  rows: unknown[][];
  /** Column widths, in characters. */
  widths: number[];
  /** Zero-based column indexes to format as money. */
  currencyColumns?: number[];
  /** Zero-based column indexes to format as a percentage. */
  percentColumns?: number[];
  /** Row index (within `rows`) where formatting starts. Defaults to 0. */
  formatFromRow?: number;
}

const pct = (v: number) => v / 100; // Excel percent cells want 0-1

// ── Sheet definitions ──────────────────────────────────────────────────────

function summarySheet(loaded: LoadedEstimate): SheetDef {
  const { estimate: e, proposal: p, calc } = loaded;
  const oh = num(e.defaultOh), fee = num(e.defaultFee), esc = num(e.defaultEsc);
  const tax = num(e.taxRate), bond = num(e.bondRate);

  const scopesWithMoney = ALL_SCOPES.filter(s => (calc[s.id]?.items ?? 0) > 0);

  const rows: unknown[][] = [
    ["PROJECT SUMMARY"],
    [""],
    ["Project Name", e.projectName ?? ""],
    ["PV#", e.estimateNumber ?? ""],
    ["GC / Client", p?.gcEstimateLead ?? ""],
    ["Estimator", p?.nbsEstimator ?? ""],
    ["Self Perform Estimator", p?.selfPerformEstimator ?? ""],
    ["Region", p?.region ?? ""],
    ["Market", p?.primaryMarket ?? ""],
    ["Due Date", p?.dueDate ?? ""],
    ["Status", p?.estimateStatus ?? ""],
    [""],
    ["COST BREAKDOWN"],
    [""],
    ["Category", "Amount"],
    ...scopesWithMoney.map(s => [s.label, calc[s.id]?.total ?? 0]),
    [""],
    ["LINE ITEM BREAKDOWN"],
    ["Component", "Amount"],
    ["Material", calc.allMat ?? 0],
    ...(calc.allEsc > 0 ? [["Escalation", calc.allEsc]] : []),
    ["Freight", calc.allFrt ?? 0],
    ["Subtotal", calc.allSub ?? 0],
    [`Overhead (${oh}%)`, calc.allOh ?? 0],
    [`Fee (${fee}%)`, calc.allFee ?? 0],
    [tax > 0 ? `Tax (${tax}% on material)` : "Tax (excluded)", calc.allTax ?? 0],
    ...(bond > 0 ? [[`Bond (${bond}%)`, calc.allBond]] : []),
    ["GRAND TOTAL", calc.grandTotal ?? 0],
    [""],
    ["DEFAULT MARKUP RATES"],
    ["Rate", "Value"],
    ["Overhead %", pct(oh)],
    ["Fee %", pct(fee)],
    ["Escalation %", pct(esc)],
    ["Tax %", pct(tax)],
    ["Bond %", pct(bond)],
  ];

  return {
    name: "Summary",
    columns: null,
    rows,
    widths: [30, 20],
    currencyColumns: [1],
    percentColumns: [1],
    formatFromRow: 13,
  };
}

function lineItemsSheet(loaded: LoadedEstimate): SheetDef {
  const { lineItems, quotes, estimate: e } = loaded;
  const quoteById = new Map(quotes.map(q => [q.id, q]));

  // Catalog order first, then anything off-catalog that still holds items.
  const present = Array.from(new Set(lineItems.map(i => i.category)));
  const ordered = [
    ...ALL_SCOPES.map(s => s.id).filter(id => present.includes(id)),
    ...present.filter(id => !ALL_SCOPES.some(s => s.id === id)),
  ];

  const rows: unknown[][] = [];
  for (const scopeId of ordered) {
    const scope = getScope(scopeId);
    const scopeItems = lineItems
      .filter(i => i.category === scopeId)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (scopeItems.length === 0) continue;

    for (const item of scopeItems) {
      const quote = item.quoteId != null ? quoteById.get(item.quoteId) : undefined;
      rows.push([
        scope.label,
        scope.csi,
        item.name,
        item.model ?? "",
        item.mfr ?? "",
        item.qty,
        num(item.unitCost),
        num(item.unitCost) * item.qty,
        quote?.vendor ?? "",
        item.source ?? "manual",
        item.hasBackup ? "Yes" : "No",
        item.note ?? "",
        item.planCallout ?? "",
      ]);
    }
    const subtotal = scopeItems.reduce((s, i) => s + num(i.unitCost) * i.qty, 0);
    rows.push([`${scope.label} Subtotal`, "", "", "", "", "", "", subtotal, "", "", "", "", ""]);
    rows.push(["", "", "", "", "", "", "", "", "", "", "", "", ""]);
  }

  return {
    name: "Line Items",
    columns: ["Scope Section", "CSI Code", "Item Name", "Model", "Manufacturer", "Qty", "Unit Cost", "Extended", "Quote Vendor", "Source", "Has Backup", "Qualification", "Plan Callout"],
    rows,
    widths: [22, 10, 30, 15, 18, 6, 12, 12, 18, 10, 10, 25, 14],
    currencyColumns: [6, 7],
  };
}

function vendorQuotesSheet(loaded: LoadedEstimate): SheetDef {
  const { quotes, lineItems, breakoutGroups } = loaded;
  const rows: unknown[][] = quotes.map(q => {
    const qItems = lineItems.filter(i => i.quoteId === q.id);
    const quoteTotal = q.pricingMode === "lump_sum"
      ? num(q.lumpSumTotal)
      : qItems.reduce((s, i) => s + num(i.unitCost) * i.qty, 0);
    const bg = q.breakoutGroupId != null ? breakoutGroups.find(g => g.id === q.breakoutGroupId) : null;
    return [
      getScope(q.category).label,
      q.vendor,
      q.pricingMode === "lump_sum" ? "Lump Sum" : "Per Item",
      num(q.freight),
      q.pricingMode === "lump_sum" ? num(q.lumpSumTotal) : "",
      q.taxIncluded ? "Yes" : "No",
      q.hasBackup ? "Yes" : "No",
      qItems.length,
      quoteTotal,
      bg ? `${bg.code} — ${bg.label}` : "",
    ];
  });

  return {
    name: "Vendor Quotes",
    columns: ["Scope Section", "Vendor", "Pricing Mode", "Freight", "Lump Sum Total", "Tax Included", "Has Backup", "Item Count", "Quote Total", "Breakout Group"],
    rows,
    widths: [22, 20, 12, 12, 14, 12, 12, 10, 14, 22],
    currencyColumns: [3, 4, 8],
  };
}

function markupsSheet(loaded: LoadedEstimate): SheetDef {
  const { estimate: e, calc } = loaded;
  const oh = num(e.defaultOh), fee = num(e.defaultFee), esc = num(e.defaultEsc);
  const catOverrides = (e.catOverrides ?? {}) as Record<string, { oh?: number; fee?: number; esc?: number }>;

  const rows: unknown[][] = [[
    "DEFAULTS", "—", calc.allMat ?? 0, pct(esc), calc.allEsc ?? 0, calc.allFrt ?? 0, calc.allSub ?? 0,
    pct(oh), calc.allOh ?? 0, pct(fee), calc.allFee ?? 0, calc.allTax ?? 0, calc.allBond ?? 0,
    calc.grandTotal ?? 0, "—",
  ]];

  for (const s of ALL_SCOPES) {
    const d = calc[s.id];
    if (!d || d.items === 0) continue;
    const ov = catOverrides[s.id];
    const hasOverride = ov != null && (ov.oh != null || ov.fee != null || ov.esc != null);
    rows.push([
      s.label, s.csi,
      d.material, pct(d.escRate), d.escalation, d.totalFreight, d.subtotal,
      pct(d.ohRate), d.oh, pct(d.feeRate), d.fee, d.tax, d.bond,
      d.total, hasOverride ? "Yes" : "No",
    ]);
  }

  rows.push([
    "TOTALS", "",
    calc.allMat ?? 0, "", calc.allEsc ?? 0, calc.allFrt ?? 0, calc.allSub ?? 0,
    "", calc.allOh ?? 0, "", calc.allFee ?? 0, calc.allTax ?? 0, calc.allBond ?? 0,
    calc.grandTotal ?? 0, "",
  ]);

  return {
    name: "Markups by Category",
    columns: ["Scope Section", "CSI Code", "Material", "Escalation Rate", "Escalation $", "Freight", "Subtotal", "OH Rate", "OH $", "Fee Rate", "Fee $", "Tax", "Bond", "Category Total", "Has Override"],
    rows,
    widths: [22, 10, 14, 14, 14, 12, 14, 10, 12, 10, 12, 12, 10, 16, 12],
    currencyColumns: [2, 4, 5, 6, 8, 10, 11, 12, 13],
    percentColumns: [3, 7, 9],
  };
}

function breakoutsSheet(loaded: LoadedEstimate): SheetDef {
  const { breakoutGroups, allocations, lineItems, breakoutCalc } = loaded;

  const allocMap: Record<number, Record<number, number>> = {};
  for (const a of allocations) {
    if (!allocMap[a.lineItemId]) allocMap[a.lineItemId] = {};
    allocMap[a.lineItemId][a.breakoutGroupId] = a.qty;
  }

  const rows: unknown[][] = [];
  for (const g of breakoutGroups) {
    const gItems = lineItems.filter(item => (allocMap[item.id]?.[g.id] ?? 0) > 0);
    if (gItems.length === 0) continue;
    for (const item of gItems) {
      const allocQty = allocMap[item.id]?.[g.id] ?? 0;
      rows.push([
        g.code, g.label, getScope(item.category).label,
        item.name, item.model ?? "", allocQty,
        num(item.unitCost), num(item.unitCost) * allocQty,
      ]);
    }
    rows.push([`${g.code} Subtotal`, g.label, "", "", "", "", "", breakoutCalc[g.id]?.material ?? 0]);
    rows.push(["", "", "", "", "", "", "", ""]);
  }

  const breakoutSum = Object.values(breakoutCalc).reduce((s, d) => s + (d?.total ?? 0), 0);
  rows.push(["RECONCILIATION", "", "", "", "", "", "Breakout Sum", breakoutSum]);

  return {
    name: "Breakouts",
    columns: ["Breakout Code", "Breakout Label", "Scope Section", "Item Name", "Model", "Allocated Qty", "Unit Cost", "Extended"],
    rows,
    widths: [14, 20, 22, 28, 14, 12, 12, 14],
    currencyColumns: [6, 7],
  };
}

function assumptionsSheet(loaded: LoadedEstimate): SheetDef {
  const assumptions = (loaded.estimate.assumptions ?? []) as string[];
  const risks = (loaded.estimate.risks ?? []) as string[];
  return {
    name: "Assumptions & Risks",
    columns: null,
    rows: [
      ["ASSUMPTIONS & RISKS"],
      [""],
      ["ASSUMPTIONS"],
      ["#", "Assumption"],
      ...assumptions.map((a, i) => [i + 1, a]),
      [""],
      ["RISKS"],
      ["#", "Risk"],
      ...risks.map((r, i) => [i + 1, r]),
    ],
    widths: [6, 80],
  };
}

function specSectionsSheet(loaded: LoadedEstimate): SheetDef {
  return {
    name: "Spec Sections",
    columns: ["Scope Section", "CSI Code", "Spec Title", "Manufacturers", "Key Requirements", "Substitution Policy", "Source Pages"],
    rows: loaded.specSections.map(spec => [
      getScope(spec.scopeId).label,
      spec.csiCode ?? "",
      spec.specSectionTitle ?? "",
      (spec.manufacturers ?? []).join(", "),
      (spec.keyRequirements ?? []).join("; "),
      spec.substitutionPolicy ?? "",
      spec.sourcePages ?? "",
    ]),
    widths: [22, 10, 30, 30, 40, 20, 14],
  };
}

function versionHistorySheet(loaded: LoadedEstimate): SheetDef {
  return {
    name: "Version History",
    columns: ["Version", "Saved By", "Saved At", "Grand Total", "Notes"],
    rows: loaded.versions.map(v => [
      v.version,
      v.savedBy ?? "",
      v.savedAt ? new Date(v.savedAt).toISOString() : "",
      num(v.grandTotal),
      v.notes ?? "",
    ]),
    widths: [10, 18, 22, 16, 40],
    currencyColumns: [3],
  };
}

/** Every sheet of the estimate workbook, in tab order. */
export function buildSheets(loaded: LoadedEstimate): SheetDef[] {
  const sheets: SheetDef[] = [
    summarySheet(loaded),
    lineItemsSheet(loaded),
    vendorQuotesSheet(loaded),
    markupsSheet(loaded),
  ];
  if (loaded.breakoutGroups.length > 0) sheets.push(breakoutsSheet(loaded));
  sheets.push(assumptionsSheet(loaded));
  if (loaded.specSections.length > 0) sheets.push(specSectionsSheet(loaded));
  sheets.push(versionHistorySheet(loaded));
  return sheets;
}

// ── Rendering ──────────────────────────────────────────────────────────────

function applyFormat(ws: XLSX.WorkSheet, fromRow: number, cols: number[] | undefined, z: string) {
  if (!cols?.length) return;
  const ref = ws["!ref"];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  for (let r = fromRow; r <= range.e.r; r++) {
    for (const c of cols) {
      const addr = XLSX.utils.encode_cell({ r, c });
      if (ws[addr] && ws[addr].t === "n") ws[addr].z = z;
    }
  }
}

/** Render the sheet definitions to .xlsx bytes. */
export function renderWorkbook(sheets: SheetDef[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const def of sheets) {
    const aoa = def.columns ? [def.columns, ...def.rows] : def.rows;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = def.widths.map(w => ({ wch: w }));
    // Header row occupies row 0 when there is one, so data starts at row 1.
    const dataStart = def.formatFromRow ?? (def.columns ? 1 : 0);
    applyFormat(ws, dataStart, def.currencyColumns, '"$"#,##0.00');
    applyFormat(ws, dataStart, def.percentColumns, "0.0%");
    XLSX.utils.book_append_sheet(wb, ws, def.name.slice(0, 31));
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * The same sheets as JSON, for row-by-row writing through Power Automate's
 * Excel Online connector. Table-shaped sheets also come back as `records` —
 * an array of objects keyed by column header — because "Add a row into a
 * table" wants named columns, not positional arrays.
 */
export function sheetsToJson(sheets: SheetDef[]) {
  return sheets.map(def => ({
    sheetName: def.name,
    columns: def.columns,
    rows: def.rows,
    records: def.columns
      ? def.rows.map(row => {
          const rec: Record<string, unknown> = {};
          def.columns!.forEach((col, i) => { rec[col] = row[i] ?? ""; });
          return rec;
        })
      : null,
  }));
}

/** Safe filename for the workbook, e.g. "PV-2026-0142_Estimate_2026-09-12.xlsx". */
export function workbookFilename(loaded: LoadedEstimate): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const estNum = (loaded.estimate.estimateNumber || "Estimate").replace(/[/\\?%*:|"<>]/g, "-");
  return `${estNum}_Estimate_${dateStr}.xlsx`;
}
