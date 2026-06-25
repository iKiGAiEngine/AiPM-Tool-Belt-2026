// =====================================================
// BUYOUT BOT — NBS Estimate Workbook Parser
// =====================================================
//
// Reads an NBS estimate workbook (.xlsx/.xlsm) into priced scopes + line items.
// Columns are located BY HEADER LABEL, not fixed position, because template
// versions shift columns around. Validated against the real BSW BUMC OB Triage
// file (4 scopes / 18 line items).
//
// Keep ALL workbook-shape knowledge in this one module so a future template
// change is a single-file edit (per spec Section 4).

import * as XLSX from "xlsx";
import { resolveScope, isNonScopeSheet, type CanonicalScope } from "./canonicalScopes";

export interface ParsedLineItem {
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

export interface ParsedScope {
  /** Original sheet/tab name. */
  sheetName: string;
  /** Canonical scope name (resolved) — falls back to the sheet name if unknown. */
  name: string;
  /** True when the sheet name resolved to a known canonical scope. */
  resolved: boolean;
  budget: {
    material: number;
    freight: number;
    labor: number;
    /** Raw cost (pre-markup) = material + freight + labor. */
    total: number;
    /** Marked-up grand total (display only). */
    grand: number;
  };
  items: ParsedLineItem[];
}

export interface ParsedEstimate {
  scopes: ParsedScope[];
  /** Sheets that were skipped, with the reason — useful for an ingest summary. */
  skipped: { sheetName: string; reason: string }[];
}

const ALLOWANCE_RE = /allowance/i;

/** Parse a currency-ish cell ("$1,234.50", "(123)", 123, "") into a number. */
function parseNum(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, "");
  if (s === "" || s === "-") return 0;
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return neg ? -n : n;
}

function cellText(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function normHeader(v: unknown): string {
  return cellText(v).toLowerCase().replace(/\s+/g, " ");
}

/** Find the last column index left of `limit` whose header contains `needle`. */
function lastColContaining(header: unknown[], needle: string, limit: number): number {
  let found = -1;
  for (let c = 0; c < header.length && c < limit; c++) {
    if (normHeader(header[c]).includes(needle)) found = c;
  }
  return found;
}

function firstColContaining(header: unknown[], needle: string): number {
  for (let c = 0; c < header.length; c++) {
    if (normHeader(header[c]).includes(needle)) return c;
  }
  return -1;
}

/** Parse one worksheet into a ParsedScope, or return a skip reason. */
function parseSheet(
  sheetName: string,
  rows: unknown[][]
): { scope: ParsedScope } | { skip: string } {
  // --- Header row: first row in the top ~20 with both "spec" and "description".
  let headerRowIdx = -1;
  const scanLimit = Math.min(rows.length, 20);
  for (let r = 0; r < scanLimit; r++) {
    const row = rows[r] || [];
    const joined = row.map(normHeader).join(" | ");
    if (joined.includes("spec") && joined.includes("description")) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx === -1) return { skip: "no header row (spec + description)" };

  const header = rows[headerRowIdx] || [];

  // --- Total column: exact "total" header = the line total column.
  let totalCol = -1;
  for (let c = 0; c < header.length; c++) {
    if (normHeader(header[c]) === "total") {
      totalCol = c;
      break;
    }
  }
  // Fallback: a header that ends with "total" but is not "grand total".
  if (totalCol === -1) {
    for (let c = 0; c < header.length; c++) {
      const h = normHeader(header[c]);
      if (h.endsWith("total") && !h.includes("grand")) {
        totalCol = c;
        break;
      }
    }
  }
  const totalLimit = totalCol === -1 ? header.length : totalCol;

  // --- Spec No: header containing "spec" but not "title".
  let specCol = -1;
  for (let c = 0; c < header.length; c++) {
    const h = normHeader(header[c]);
    if (h.includes("spec") && !h.includes("title")) {
      specCol = c;
      break;
    }
  }

  // --- Description: first EXACT "description" (ignore "copy description" helper).
  let descCol = -1;
  for (let c = 0; c < header.length; c++) {
    if (normHeader(header[c]) === "description") {
      descCol = c;
      break;
    }
  }
  if (descCol === -1) descCol = firstColContaining(header, "description");

  const modelCol = firstColContaining(header, "model");
  let qtyCol = firstColContaining(header, "quantity");
  if (qtyCol === -1) qtyCol = firstColContaining(header, "qty");
  const calloutCol = firstColContaining(header, "callout");

  // Material / Freight / Labor = the LAST header of each name left of Total
  // (the extended $ columns). Labor may be absent.
  const materialCol = lastColContaining(header, "material", totalLimit);
  const freightCol = lastColContaining(header, "freight", totalLimit);
  const laborCol = lastColContaining(header, "labor", totalLimit);

  if (specCol === -1 || descCol === -1) return { skip: "missing spec/description columns" };

  // --- Grand Total row: first row at/after header containing "grand total".
  let grandRowIdx = -1;
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const joined = row.map(normHeader).join(" ");
    if (joined.includes("grand total")) {
      grandRowIdx = r;
      break;
    }
  }
  const grand = grandRowIdx !== -1 && totalCol !== -1 ? parseNum(rows[grandRowIdx][totalCol]) : 0;

  // ≤ 0 grand total → empty placeholder tab, skip.
  if (grand <= 0) return { skip: "grand total ≤ 0 (empty placeholder)" };

  // --- SUBTOTAL row (col A === "subtotal") → raw material/freight/labor budget.
  let subRowIdx = -1;
  const lineEnd = grandRowIdx !== -1 ? grandRowIdx : rows.length;
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    if (cellText((rows[r] || [])[0]).toLowerCase() === "subtotal") {
      subRowIdx = r;
      break;
    }
  }

  let budgetMaterial = 0;
  let budgetFreight = 0;
  let budgetLabor = 0;
  if (subRowIdx !== -1) {
    const sub = rows[subRowIdx];
    budgetMaterial = materialCol !== -1 ? parseNum(sub[materialCol]) : 0;
    budgetFreight = freightCol !== -1 ? parseNum(sub[freightCol]) : 0;
    budgetLabor = laborCol !== -1 ? parseNum(sub[laborCol]) : 0;
  }

  // --- Line items: header+1 .. grandTotal-1, keep rows with BOTH spec + desc.
  const items: ParsedLineItem[] = [];
  for (let r = headerRowIdx + 1; r < lineEnd; r++) {
    const row = rows[r] || [];
    if (subRowIdx !== -1 && r === subRowIdx) continue;
    const specNo = cellText(row[specCol]);
    const description = cellText(row[descCol]);
    if (!specNo || !description) continue; // skips padding/markup/lump-sum rows

    const model = modelCol !== -1 ? cellText(row[modelCol]) : "";
    const callout = calloutCol !== -1 ? cellText(row[calloutCol]) : "";
    const isAllowance =
      ALLOWANCE_RE.test(description) || ALLOWANCE_RE.test(model) || ALLOWANCE_RE.test(sheetName);

    items.push({
      specNo,
      callout,
      description,
      model,
      qty: qtyCol !== -1 ? parseNum(row[qtyCol]) : 0,
      material: materialCol !== -1 ? parseNum(row[materialCol]) : 0,
      freight: freightCol !== -1 ? parseNum(row[freightCol]) : 0,
      labor: laborCol !== -1 ? parseNum(row[laborCol]) : 0,
      total: totalCol !== -1 ? parseNum(row[totalCol]) : 0,
      isAllowance,
    });
  }

  // --- Budget total = material+freight+labor from SUBTOTAL; fall back to the
  // sum of line totals when the subtotal is 0. ALWAYS trust the SUBTOTAL for
  // lump-sum scopes where line totals are 0 but the subtotal carries the money.
  let budgetTotal = budgetMaterial + budgetFreight + budgetLabor;
  if (budgetTotal === 0) {
    budgetTotal = items.reduce((s, it) => s + it.total, 0);
  }

  const canonical = resolveScope(sheetName);

  return {
    scope: {
      sheetName,
      name: canonical || sheetName.trim(),
      resolved: canonical != null,
      budget: {
        material: budgetMaterial,
        freight: budgetFreight,
        labor: budgetLabor,
        total: budgetTotal,
        grand,
      },
      items,
    },
  };
}

/** Parse an already-loaded SheetJS workbook into a ParsedEstimate. */
export function parseEstimateWorkbook(workbook: XLSX.WorkBook): ParsedEstimate {
  const scopes: ParsedScope[] = [];
  const skipped: { sheetName: string; reason: string }[] = [];

  for (const sheetName of workbook.SheetNames) {
    if (isNonScopeSheet(sheetName)) {
      skipped.push({ sheetName, reason: "housekeeping sheet" });
      continue;
    }
    const ws = workbook.Sheets[sheetName];
    if (!ws) {
      skipped.push({ sheetName, reason: "empty sheet" });
      continue;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    const result = parseSheet(sheetName, rows);
    if ("skip" in result) {
      skipped.push({ sheetName, reason: result.skip });
    } else {
      scopes.push(result.scope);
    }
  }

  return { scopes, skipped };
}

/** Parse a workbook from raw bytes (Node Buffer / browser ArrayBuffer). */
export function parseEstimateBuffer(data: ArrayBuffer | Uint8Array | Buffer): ParsedEstimate {
  const workbook = XLSX.read(data, { type: "array" });
  return parseEstimateWorkbook(workbook);
}

export type { CanonicalScope };
