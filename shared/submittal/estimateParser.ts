// =====================================================
// SUBMITTAL BUILDER — NBS Estimate Workbook Parser
// =====================================================
//
// Reads an estimate workbook (.xlsx/.xlsm) into scope tabs + schedule line items
// for a submittal package. Only the columns a submittal needs are extracted:
// callout, description, model number and quantity.
//
// This is deliberately more permissive than shared/buyout/estimateParser.ts.
// That parser is tuned to the priced NBS template (it requires spec + description
// columns and a positive grand total, because a buyout without money is
// meaningless). A submittal can legitimately be built from an unpriced schedule,
// a GC-supplied takeoff, or a tab that never got costed — so this parser locates
// columns by scoring header labels and never requires pricing.
//
// Sheet skipping and scope-name/CSI resolution come from shared/buyout/
// canonicalScopes so there is ONE place that knows which tabs are real scopes.
//
// Every sheet that does not become a scope is reported in `skipped` with a
// reason. Silently dropping a scope tab destroys the PM's starting data, so the
// UI shows this list and lets them re-import.

import * as XLSX from "xlsx";
import { resolveScope, isNonScopeSheet, CANONICAL_SCOPE_DEFS } from "../buyout/canonicalScopes";

export interface ParsedSubmittalLine {
  callout: string;
  desc: string;
  model: string;
  qty: number;
}

export interface ParsedSubmittalScope {
  /** Original worksheet name — the PM recognizes their own tab names. */
  tab: string;
  /** Canonical scope name when the tab resolved to one, else the tab name. */
  scopeName: string;
  /** Formatted CSI section, e.g. "10 28 00". Empty when nothing resolved. */
  csi: string;
  /** Spec section title printed on the schedule. Never the letterhead. */
  specTitle: string;
  lines: ParsedSubmittalLine[];
}

export interface SkippedSheet {
  tab: string;
  reason: string;
}

export interface ParsedSubmittalWorkbook {
  /** Project name read off the summary sheet, when present. */
  projectName: string;
  scopes: ParsedSubmittalScope[];
  skipped: SkippedSheet[];
}

// ---------------------------------------------------------------------------
// Column role detection
// ---------------------------------------------------------------------------

type Role = "callout" | "desc" | "model" | "qty";

/**
 * Header patterns per role, scored by specificity. Matched against a header
 * cell normalized to lowercase single-spaced text (punctuation kept so that
 * "model no." and "manufacturer / model" stay distinguishable).
 *
 * Scores matter because real headers overlap: a sheet with "Item" AND "Item
 * Description" must map "Item" to callout and "Item Description" to
 * description, not fight over both.
 */
const ROLE_PATTERNS: Record<Role, Array<{ re: RegExp; score: number }>> = {
  desc: [
    { re: /^description$/, score: 10 },
    { re: /description/, score: 9 }, // item description, product description, description of work
    { re: /^desc\.?$/, score: 8 },
    { re: /^(product|item|scope|work|fixture)s?$/, score: 4 },
  ],
  callout: [
    { re: /^call[\s-]?out/, score: 10 },
    { re: /^(tag|mark|symbol|callout)s?\.?$/, score: 9 },
    { re: /^item\s*(no|number|#)\.?$/, score: 8 },
    { re: /^(item|mark|tag)$/, score: 7 },
    { re: /^(no|num|nbr|#|id|ref)\.?$/, score: 5 },
    { re: /^type$/, score: 3 },
  ],
  model: [
    { re: /^model\s*(no|number|#)?\.?$/, score: 10 },
    { re: /model/, score: 9 }, // manufacturer / model, mfr model
    { re: /^(catalog|cat)\s*(no|number|#)?\.?$/, score: 9 },
    { re: /^part\s*(no|number|#)?\.?$/, score: 8 },
    { re: /(product|item)\s*(no|number|#)\.?$/, score: 5 },
    { re: /^(mfr|manufacturer)\.?$/, score: 4 },
  ],
  qty: [
    // NOTE: a bare "total" is a PRICE column on every NBS sheet — never qty.
    { re: /^qty\.?$/, score: 10 },
    { re: /^quantity$/, score: 10 },
    { re: /^total\s*(qty|quantity)$/, score: 9 },
    { re: /\bqty\b/, score: 8 },
    { re: /\bquantity\b/, score: 8 },
    { re: /^count$/, score: 6 },
    { re: /^ea\.?$/, score: 4 },
  ],
};

const ROLES: Role[] = ["desc", "callout", "model", "qty"];

/** How far down a sheet to look for the header row. */
const HEADER_SCAN_ROWS = 25;

/** Stop reading line items after this many consecutive rows with no description. */
const BLANK_RUN_LIMIT = 8;

/**
 * Whole-cell descriptions that are estimate arithmetic, not products. Matched
 * against the entire trimmed description cell so a real product description
 * containing the word "total" is never dropped.
 */
const FOOTER_DESC_RE =
  /^(sub\s*-?\s*total|subtotal|total|grand\s*total|material(\s*(sub)?\s*total)?|freight(\s*(sub)?\s*total)?|labor(\s*(sub)?\s*total)?|sales\s*tax|tax|markup|mark\s*up|overhead|profit|bond|contingency|escalation|shipping|handling|installation|misc\.?|miscellaneous|notes?|total\s*(material|freight|labor|cost|price|sell))\s*:?$/i;

/**
 * Sheet names that are never a submittal scope but are not in the shared
 * NON_SCOPE_SHEET_NAMES list (which holds the known NBS template tabs).
 * Pattern-based so template variants ("Vendor Pricing 2026", "Freight Calc")
 * are caught too.
 */
const NON_SCOPE_PATTERNS: RegExp[] = [
  /summary/i,
  /^cover/i,
  /\b(toc|index)\b/i,
  /table of contents/i,
  /^notes?$/i,
  /instruction/i,
  /lookup/i,
  /^lists?$/i,
  /^data$/i,
  /template/i,
  /overview/i,
  /^ref(erence)?$/i,
  /pricing/i,
  /price\s*list/i,
  /labor\s*(factor|rate)/i,
  /^freight/i,
  /tax\s*(rate|table)/i,
  /^proposal/i,
  /^buyout/i,
  /po\s*review/i,
  /change\s*(log|order)/i,
  /print\s*preview/i,
  /takeoff\s*log/i,
  /^division\s*10$/i,
  /^div\.?\s*10$/i,
  /^bid\b/i,
  /^recap$/i,
];

function normHeader(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

function bestRoleScore(header: string, role: Role): number {
  let best = 0;
  for (const { re, score } of ROLE_PATTERNS[role]) {
    if (score > best && re.test(header)) best = score;
  }
  return best;
}

interface ColMap {
  callout: number;
  desc: number;
  model: number;
  qty: number;
}

const EMPTY_COLMAP: ColMap = { callout: -1, desc: -1, model: -1, qty: -1 };

/**
 * Assign columns to roles for one candidate header row. Greedy highest-score
 * first, so each column and each role is used at most once.
 */
function mapRow(row: unknown[]): { colMap: ColMap; score: number; roleCount: number } {
  const candidates: Array<{ col: number; role: Role; score: number }> = [];
  for (let col = 0; col < row.length; col++) {
    const h = normHeader(row[col]);
    if (!h) continue;
    for (const role of ROLES) {
      const score = bestRoleScore(h, role);
      if (score > 0) candidates.push({ col, role, score });
    }
  }
  // Highest score wins; ties resolve to the leftmost column, then role order,
  // so mapping is deterministic for a given sheet.
  candidates.sort((a, b) => b.score - a.score || a.col - b.col || ROLES.indexOf(a.role) - ROLES.indexOf(b.role));

  const colMap: ColMap = { ...EMPTY_COLMAP };
  const usedCols = new Set<number>();
  let score = 0;
  let roleCount = 0;
  for (const c of candidates) {
    if (colMap[c.role] !== -1 || usedCols.has(c.col)) continue;
    colMap[c.role] = c.col;
    usedCols.add(c.col);
    score += c.score;
    roleCount++;
  }
  return { colMap, score, roleCount };
}

/**
 * Find the header row by scoring every candidate row and taking the best,
 * rather than accepting the first row that happens to contain "description".
 * A description column plus at least one other identifiable column is required
 * so a title row mentioning "description" is not mistaken for the header.
 */
function findHeaderRow(rows: unknown[][]): { row: number; colMap: ColMap } | null {
  let best: { row: number; colMap: ColMap; score: number } | null = null;
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const { colMap, score, roleCount } = mapRow(rows[r] || []);
    if (colMap.desc === -1 || roleCount < 2) continue;
    if (!best || score > best.score) best = { row: r, colMap, score };
  }
  return best ? { row: best.row, colMap: best.colMap } : null;
}

// ---------------------------------------------------------------------------
// CSI + spec title
// ---------------------------------------------------------------------------

/** "102800" -> "10 28 00"; "1028" -> "10 28 00". */
function formatCsi(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (d.length < 4) return "";
  const padded = d.length >= 6 ? d.slice(0, 6) : d.slice(0, 4) + "00";
  return `${padded.slice(0, 2)} ${padded.slice(2, 4)} ${padded.slice(4, 6)}`;
}

/** Preferred CSI for a canonical scope: the broad "xx xx 00" code when it has one. */
function canonicalCsi(scopeName: string): string {
  const def = CANONICAL_SCOPE_DEFS.find((d) => d.name === scopeName);
  if (!def || def.csi.length === 0) return "";
  const broad = def.csi.find((c) => c.replace(/\D/g, "").length === 6 && c.endsWith("00"));
  return formatCsi(broad || def.csi[0]);
}

/**
 * A CSI section number appearing on its own in a cell, e.g. "10 28 00",
 * "10-28-00", "102800", "08 71 00". Division is restricted to 01–49 so prices
 * and dimensions are not mistaken for section numbers.
 */
const CSI_CELL_RE = /^(0[1-9]|[1-4]\d)[\s\-.]?(\d{2})[\s\-.]?(\d{2})?\b/;

/**
 * Read the CSI code out of the rows above the header. Only whole-cell matches
 * count, and the value must not be a plain number (a qty or price cell).
 */
function findCsiCell(rows: unknown[][], headerRow: number): string {
  for (let r = 0; r < headerRow; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < Math.min(row.length, 8); c++) {
      const val = cellText(row[c]);
      if (!val || val.length > 40) continue;
      if (typeof row[c] === "number") continue;
      const m = CSI_CELL_RE.exec(val);
      if (m) return formatCsi(m[1] + m[2] + (m[3] || "00"));
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Sheet parsing
// ---------------------------------------------------------------------------

function skipReason(tab: string): string | null {
  if (isNonScopeSheet(tab)) return "not a scope tab";
  for (const re of NON_SCOPE_PATTERNS) {
    if (re.test(tab.trim())) return "not a scope tab";
  }
  return null;
}

function parseSheet(tab: string, rows: unknown[][]): { scope: ParsedSubmittalScope } | { skip: string } {
  const header = findHeaderRow(rows);
  if (!header) return { skip: "no schedule columns found (need a description column plus callout, model or qty)" };

  const { row: headerRow, colMap } = header;
  const lines: ParsedSubmittalLine[] = [];
  let blankRun = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const desc = colMap.desc === -1 ? "" : cellText(row[colMap.desc]);

    if (!desc) {
      // A long gap means the table ended; short gaps are just spacer rows.
      if (++blankRun >= BLANK_RUN_LIMIT) break;
      continue;
    }
    blankRun = 0;

    // Estimate arithmetic (SUBTOTAL / FREIGHT / SALES TAX / GRAND TOTAL rows).
    if (FOOTER_DESC_RE.test(desc)) continue;

    const callout = colMap.callout === -1 ? "" : cellText(row[colMap.callout]);
    const model = colMap.model === -1 ? "" : cellText(row[colMap.model]);
    const qtyRaw = colMap.qty === -1 ? "" : cellText(row[colMap.qty]);
    const qtyNum = qtyRaw ? parseFloat(qtyRaw.replace(/[$,\s]/g, "")) : 0;
    const qty = Number.isFinite(qtyNum) ? qtyNum : 0;

    // A row with a description but no callout, no model and no quantity carries
    // nothing a submittal can use — it is a total, a note or a spacer label.
    if (!callout && !model && qty === 0) continue;

    lines.push({ callout, desc, model, qty });
  }

  if (lines.length === 0) return { skip: "no line items below the header row" };

  const canonical = resolveScope(tab);
  const csi = findCsiCell(rows, headerRow) || (canonical ? canonicalCsi(canonical) : "");
  const specTitle = canonical || tab;

  return { scope: { tab, scopeName: canonical || tab, csi, specTitle, lines } };
}

// ---------------------------------------------------------------------------
// Workbook entry point
// ---------------------------------------------------------------------------

/** Labels that mark the cell to their right as the project name. */
const PROJECT_LABEL_RE = /^(project|project name|job|job name)\s*:?$/i;

function readProjectName(wb: XLSX.WorkBook): string {
  for (const name of wb.SheetNames) {
    if (!/summary|cover|proposal/i.test(name)) continue;
    const rows = sheetRows(wb.Sheets[name]);
    for (let r = 0; r < Math.min(rows.length, 12); r++) {
      const row = rows[r] || [];
      for (let c = 0; c < Math.min(row.length, 4); c++) {
        if (PROJECT_LABEL_RE.test(cellText(row[c]))) {
          const val = cellText(row[c + 1]);
          if (val) return val;
        }
      }
    }
  }
  return "";
}

function sheetRows(sheet: XLSX.WorkSheet | undefined): unknown[][] {
  if (!sheet || !sheet["!ref"]) return [];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, defval: "", raw: true });
}

/** Parse a workbook from raw bytes. Works in the browser and on the server. */
export function parseEstimateBuffer(data: ArrayBuffer | Uint8Array): ParsedSubmittalWorkbook {
  const wb = XLSX.read(data instanceof Uint8Array ? data : new Uint8Array(data), {
    type: "array",
    cellFormula: false,
    cellHTML: false,
  });

  const scopes: ParsedSubmittalScope[] = [];
  const skipped: SkippedSheet[] = [];

  for (const tab of wb.SheetNames) {
    const byName = skipReason(tab);
    if (byName) {
      skipped.push({ tab, reason: byName });
      continue;
    }
    const rows = sheetRows(wb.Sheets[tab]);
    if (rows.length === 0) {
      skipped.push({ tab, reason: "sheet is empty" });
      continue;
    }
    const result = parseSheet(tab, rows);
    if ("skip" in result) {
      skipped.push({ tab, reason: result.skip });
      continue;
    }
    scopes.push(result.scope);
  }

  return { projectName: readProjectName(wb), scopes, skipped };
}

/** Parse a workbook the user picked or dropped in the browser. */
export async function parseEstimateWorkbook(file: File): Promise<ParsedSubmittalWorkbook> {
  if (typeof file?.arrayBuffer !== "function") {
    throw new Error("That is not a readable file — pick an .xlsx or .xlsm estimate workbook.");
  }
  if (!/\.(xlsx|xlsm|xls)$/i.test(file.name || "")) {
    throw new Error(`"${file.name}" is not an Excel workbook. Pick an .xlsx or .xlsm estimate file.`);
  }
  const buffer = await file.arrayBuffer();
  return parseEstimateBuffer(buffer);
}
