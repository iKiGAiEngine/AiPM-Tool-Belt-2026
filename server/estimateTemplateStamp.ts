// ─────────────────────────────────────────────────────────────────────────────
// Estimate template stamping helpers.
//
// The NBS estimate template is a macro-enabled workbook (.xlsm). ExcelJS strips
// VBA macros when it writes a workbook back out, so we cannot round-trip an
// .xlsm through ExcelJS without corrupting it. Instead we patch the target cells
// directly in the worksheet XML inside the zip, leaving vbaProject.bin and every
// other part untouched — macros and formulas survive intact.
//
// The "Summary Sheet" tab holds the project header. B1 (project name) and B2
// (bid due date) auto-derive from the filename via CELL("filename",…) formulas,
// so we never overwrite those. The remaining header fields are stamped here.
// ─────────────────────────────────────────────────────────────────────────────

import JSZip from "jszip";
import { db } from "./db";
import { taxRates } from "@shared/schema";
import { eq } from "drizzle-orm";
import { normalizeZip } from "./taxRates/parser";

export const SUMMARY_SHEET_NAME = "Summary Sheet";

// Cell locations on the Summary Sheet (column A holds the label, column B the value).
export const SUMMARY_CELLS = {
  projectName: "B1", // stamped as literal text (overrides the filename formula)
  bidDueDate: "B2",  // stamped as M/D/YY text (e.g. "8/4/26")
  estimateNumber: "B3", // AiPM estimate/project number
  shipTo: "B4",      // project address
  spEstimator: "B6", // NBS self-perform (SP) estimator
  taxRate: "B8",     // stored as a fraction (0.0925 == 9.25%)
  projectStartDate: "B12",
  projectEndDate: "B13",
} as const;

export interface StampCell {
  ref: string; // e.g. "B4"
  value: string | number;
  type: "string" | "number";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escXml(s: string | number): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colToNum(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function splitRef(ref: string): { col: string; row: number } {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid cell ref: ${ref}`);
  return { col: m[1], row: parseInt(m[2], 10) };
}

function buildCell(ref: string, value: string | number, type: "string" | "number", styleAttr?: string): string {
  const s = styleAttr ? ` s="${styleAttr}"` : "";
  if (type === "number") return `<c r="${ref}"${s}><v>${value}</v></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(value)}</t></is></c>`;
}

// Insert or replace a single cell in worksheet XML, preserving column/row order
// and the style (`s`) attribute of any existing cell.
function patchCell(xml: string, ref: string, value: string | number, type: "string" | "number"): string {
  const { col, row } = splitRef(ref);
  const colN = colToNum(col);

  // 1) Existing cell → replace, keeping its style.
  const cellRe = new RegExp(`<c r="${escapeRegExp(ref)}"(?:[^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const existing = xml.match(cellRe);
  if (existing) {
    const styleAttr = existing[0].match(/\bs="([^"]+)"/)?.[1];
    return xml.replace(cellRe, buildCell(ref, value, type, styleAttr));
  }

  // 2) Row exists but cell doesn't → insert in column order.
  const rowRe = new RegExp(`(<row[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const rowMatch = xml.match(rowRe);
  if (rowMatch) {
    const body = rowMatch[2];
    const newCell = buildCell(ref, value, type);
    const cellTagRe = /<c r="([A-Z]+)\d+"/g;
    let insertAt = -1;
    let m: RegExpExecArray | null;
    while ((m = cellTagRe.exec(body)) !== null) {
      if (colToNum(m[1]) > colN) { insertAt = m.index; break; }
    }
    const newBody = insertAt === -1 ? body + newCell : body.slice(0, insertAt) + newCell + body.slice(insertAt);
    return xml.replace(rowRe, `$1${newBody}$3`);
  }

  // 3) Row missing → insert a new row in order inside <sheetData>.
  const newRow = `<row r="${row}">${buildCell(ref, value, type)}</row>`;
  const sdRe = /(<sheetData[^>]*>)([\s\S]*?)(<\/sheetData>)/;
  const sd = xml.match(sdRe);
  if (!sd) return xml; // no sheetData — give up gracefully
  const body = sd[2];
  const rowTagRe = /<row[^>]*\br="(\d+)"/g;
  let insertAt = -1;
  let rm: RegExpExecArray | null;
  while ((rm = rowTagRe.exec(body)) !== null) {
    if (parseInt(rm[1], 10) > row) { insertAt = rm.index; break; }
  }
  const newBody = insertAt === -1 ? body + newRow : body.slice(0, insertAt) + newRow + body.slice(insertAt);
  return xml.replace(sdRe, `$1${newBody}$3`);
}

// Delete a single cell from worksheet XML, leaving the row and every other cell
// intact. Used to blank a cell rather than write an empty string into it: the
// Vendor Directory's consumers test cells with <>"" to decide whether a row
// exists, and a truly absent cell is the only unambiguous "empty".
function removeCell(xml: string, ref: string): string {
  const cellRe = new RegExp(`<c r="${escapeRegExp(ref)}"(?:[^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  return xml.replace(cellRe, "");
}

// Read every populated cell of one column as row -> text. Only handles the cell
// shapes this codebase writes plus the shared-string and inline-string forms
// Excel itself produces, which is all the Vendor Directory's column A ever is.
function readColumn(xml: string, sharedStrings: string[], col: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = new RegExp(`<c r="${escapeRegExp(col)}(\\d+)"([^>]*)(?:/>|>([\\s\\S]*?)</c>)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const row = parseInt(m[1], 10);
    const attrs = m[2] || "";
    const body = m[3] || "";
    const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? "n";
    let value = "";
    if (type === "s") {
      const idx = parseInt(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "", 10);
      value = Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : "";
    } else if (type === "inlineStr") {
      value = body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
    } else {
      value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
    }
    out.set(row, unescXml(value));
  }
  return out;
}

// Parse xl/sharedStrings.xml into an index-addressable array. Excel stores most
// text this way, so column A of the Vendor Directory can only be read through it.
function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    // An <si> may be split across several <t> runs (rich text); concatenate them.
    const parts = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(unescXml(parts.map((p) => p.replace(/<[^>]*>/g, "")).join("")));
  }
  return out;
}

function unescXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// One sheet's worth of edits. `cells` are written; `clearRefs` are deleted.
// `resolve` lets a caller compute its edits from the sheet's current contents
// (the Vendor Directory discovers its scope blocks by reading column A) without
// opening the workbook zip a second time.
export interface SheetPatch {
  sheetName: string;
  cells?: StampCell[];
  clearRefs?: string[];
  resolve?: (ctx: {
    sheetXml: string;
    readColumn: (col: string) => Map<number, string>;
  }) => { cells?: StampCell[]; clearRefs?: string[] };
  /** Skip silently when the workbook has no such sheet, instead of throwing.
   *  Set for the Vendor Directory: older templates predate that tab, and a
   *  template without it must still get its Summary Sheet header stamped. */
  optional?: boolean;
}

// Resolve a sheet name to its XML part path inside the zip. Returns null for an
// absent sheet so an `optional` patch can be skipped.
function resolveSheetPath(workbookXml: string, relsXml: string, sheetName: string, optional = false): string | null {
  const sheetTag = workbookXml.match(new RegExp(`<sheet[^>]*name="${escapeRegExp(sheetName)}"[^>]*/?>`, "i"))?.[0];
  if (!sheetTag) {
    if (optional) return null;
    throw new Error(`Sheet "${sheetName}" not found in workbook`);
  }
  const rId = sheetTag.match(/r:id="([^"]+)"/)?.[1];
  if (!rId) throw new Error(`Sheet "${sheetName}" is missing its r:id`);
  const relTag = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*/?>`, "i"))?.[0];
  const target = relTag?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new Error(`Could not resolve target for sheet "${sheetName}"`);
  return target.startsWith("/") ? target.slice(1) : "xl/" + target;
}

// Stamp cells into a workbook's worksheet XML without disturbing macros or
// formulas. Returns the repackaged workbook buffer. Safe for .xlsm and .xlsx.
export async function stampWorkbookCells(buffer: Buffer, sheetName: string, cells: StampCell[]): Promise<Buffer> {
  return stampWorkbookSheets(buffer, [{ sheetName, cells }]);
}

// Multi-sheet form of stampWorkbookCells: applies every patch in ONE zip
// open/close. Opening a 2 MB macro workbook once per sheet would both waste work
// and risk the calcChain/fullCalcOnLoad cleanup below running inconsistently
// across passes.
export async function stampWorkbookSheets(buffer: Buffer, patches: SheetPatch[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("Invalid workbook: missing xl/workbook.xml");

  const sharedStrings = parseSharedStrings(await zip.file("xl/sharedStrings.xml")?.async("string"));

  for (const patch of patches) {
    const sheetPath = resolveSheetPath(workbookXml, relsXml, patch.sheetName, patch.optional);
    if (!sheetPath) continue; // optional patch, sheet not in this template
    let sheetXml = await zip.file(sheetPath)?.async("string");
    if (!sheetXml) {
      if (patch.optional) continue;
      throw new Error(`Worksheet XML not found at ${sheetPath}`);
    }

    let cells = patch.cells ?? [];
    let clearRefs = patch.clearRefs ?? [];
    if (patch.resolve) {
      const resolved = patch.resolve({
        sheetXml,
        readColumn: (col) => readColumn(sheetXml!, sharedStrings, col),
      });
      cells = [...cells, ...(resolved.cells ?? [])];
      clearRefs = [...clearRefs, ...(resolved.clearRefs ?? [])];
    }

    // Clear first, then write: a ref appearing in both is a rewrite, and the
    // write must win.
    for (const ref of clearRefs) sheetXml = removeCell(sheetXml, ref);
    for (const c of cells) {
      if (c.value === null || c.value === undefined || c.value === "") continue;
      sheetXml = patchCell(sheetXml, c.ref, c.value, c.type);
    }

    zip.file(sheetPath, sheetXml);
  }

  // calcChain.xml caches the formula calculation order. Replacing formula cells
  // (e.g. the name/date cells) with literals leaves that cache inconsistent, so
  // Excel shows a "repaired/removed records" prompt on open. Drop the cache and
  // every reference to it — it is optional and Excel rebuilds it automatically.
  if (zip.file("xl/calcChain.xml")) {
    zip.remove("xl/calcChain.xml");

    // Remove the part declaration from [Content_Types].xml.
    const ctXml = await zip.file("[Content_Types].xml")?.async("string");
    if (ctXml) {
      const cleaned = ctXml.replace(/<Override[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/g, "");
      if (cleaned !== ctXml) zip.file("[Content_Types].xml", cleaned);
    }

    // Remove the workbook relationship pointing at calcChain.xml.
    const cleanedRels = relsXml.replace(/<Relationship[^>]*calcChain\.xml"[^>]*\/>/g, "");
    if (cleanedRels !== relsXml) zip.file("xl/_rels/workbook.xml.rels", cleanedRels);
  }

  // Force a full recalculation on open so every remaining formula refreshes now
  // that the cached calculation chain is gone.
  const workbookXmlOut = /<calcPr[^>]*\bfullCalcOnLoad=/.test(workbookXml)
    ? workbookXml
    : workbookXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  if (workbookXmlOut !== workbookXml) zip.file("xl/workbook.xml", workbookXmlOut);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Convert an ISO date string (yyyy-mm-dd) to an Excel date serial number — the
// number of days since 1899-12-30. Written into a date-formatted cell it renders
// as a real date. Returns null for anything that isn't a valid yyyy-mm-dd date.
export function excelDateSerial(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const date = new Date(utc);
  // Reject values that rolled over (e.g. month 13, day 32).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
}

// Format an ISO date (yyyy-mm-dd) as M/D/YY with no leading zeros and a 2-digit
// year — the header date format the estimate Summary Sheet uses (e.g.
// "2026-08-04" -> "8/4/26"). Returns null for anything that isn't a valid
// yyyy-mm-dd date, so the caller can fall back to the raw value (e.g. a
// month-only "2026-09").
export function formatDateMDYY(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const date = new Date(utc);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${mo}/${d}/${String(y).slice(2)}`;
}

// A date cell's stamp value: M/D/YY when it's a full ISO date, otherwise the raw
// trimmed value (preserves odd inputs like a month-only "2026-09") or null.
function dateCellValue(raw: string | null | undefined): string | null {
  const formatted = formatDateMDYY(raw);
  if (formatted) return formatted;
  const trimmed = (raw ?? "").trim();
  return trimmed || null;
}

// Drop a trailing country name so the stamped address ends at the ZIP
// (BC/geocoded addresses often append ", United States of America"). Applied at
// stamp time so even entries whose stored address still carries the suffix get a
// clean value on the estimate.
function stripCountrySuffix(address: string | null | undefined): string | null {
  const trimmed = (address ?? "").trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/\s*,?\s*(United States of America|United States|USA|US)\s*$/i, "")
    .replace(/,\s*$/, "")
    .trim();
  return cleaned || null;
}

// Pull the postal ZIP out of a free-form US address. We deliberately only accept
// a ZIP in a position where it is really the postal code — after a state token
// (e.g. "CA 94105") or at the very end of the string — so a 5-digit street number
// like "12345 Sunset Blvd" is never mistaken for a ZIP. Returns null when no
// confident ZIP is present rather than guessing.
export function extractZipFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const text = address.trim();

  // 1) "<STATE> <ZIP>" — the canonical US form. Take the last occurrence so a
  //    number earlier in the string can't win over the real trailing ZIP.
  const stateZipRe = /\b[A-Za-z]{2}\.?\s+(\d{5})(?:-\d{4})?\b/g;
  let lastStateZip: string | null = null;
  let sz: RegExpExecArray | null;
  while ((sz = stateZipRe.exec(text)) !== null) lastStateZip = sz[1];
  if (lastStateZip) return normalizeZip(lastStateZip);

  // 2) A ZIP at the very end of the string (address with no state token).
  const trailing = text.match(/(\d{5})(?:-\d{4})?\s*$/);
  if (trailing) return normalizeZip(trailing[1]);

  // 3) No ZIP in a trustworthy position — don't guess from a mid-string number.
  return null;
}

// Pick the highest usable tax rate from a set of raw jurisdiction values and
// return it as a fraction (e.g. 9.25 → 0.0925). Values are percentage points,
// so we divide by 100. Highest wins when a ZIP spans multiple jurisdictions —
// the conservative choice for a bid.
//
// IMPORTANT: a real 0% rate (e.g. Oregon, which has no sales tax) must come back
// as 0, NOT null. Returning null here would skip stamping cell B8 and leave the
// template's baked-in default rate (9.25%) on the estimate — exactly the bug this
// replaces, where a Portland OR (97239) address showed 9.25% instead of 0%.
// Null means only "no usable rate at all" (empty input or non-numeric values),
// so the caller can leave the template as-is when a ZIP genuinely isn't known.
export function highestTaxFraction(rawValues: (string | number | null | undefined)[]): number | null {
  const points = rawValues
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  if (points.length === 0) return null;
  return Math.max(...points) / 100;
}

// Look up the sales/use tax rate for an address's ZIP and return it as a fraction
// (e.g. 0.0925 for 9.25%, or 0 for a no-sales-tax state). Returns null only when
// the ZIP isn't in the table (or has no usable rate) so the caller can leave the
// template default untouched; a found 0% rate is returned as 0 and stamped.
export async function lookupTaxRateFraction(address: string | null | undefined): Promise<number | null> {
  const zip = extractZipFromAddress(address);
  if (!zip) return null;
  const rows = await db.select({ tax: taxRates.totalUseTax }).from(taxRates).where(eq(taxRates.zipCode, zip));
  if (rows.length === 0) return null;
  return highestTaxFraction(rows.map((r) => r.tax));
}

export interface SummaryStampInfo {
  projectName?: string | null;
  dueDate?: string | null;           // yyyy-mm-dd
  estimateNumber?: string | null;    // AiPM estimate/project number → B3
  projectAddress?: string | null;
  spEstimator?: string | null;       // NBS self-perform estimator → B6
  anticipatedStart?: string | null;
  anticipatedFinish?: string | null;
}

// Build the Summary Sheet stamp cells for a project's header from a single info
// object, including the address-ZIP tax-rate lookup. Shared by every code path
// that stamps an estimate (project create, folder recreate, estimate download)
// so the cell mapping lives in exactly one place. Only fields with a value
// produce a cell. Tax-rate lookup failures are swallowed (best-effort).
export async function buildSummaryStampCells(info: SummaryStampInfo): Promise<StampCell[]> {
  const cells: StampCell[] = [];

  if (info.projectName) cells.push({ ref: SUMMARY_CELLS.projectName, value: info.projectName, type: "string" });

  // Dates are stamped as M/D/YY text ("8/4/26") for a consistent header format.
  const dueDate = dateCellValue(info.dueDate);
  if (dueDate) cells.push({ ref: SUMMARY_CELLS.bidDueDate, value: dueDate, type: "string" });

  if (info.estimateNumber) cells.push({ ref: SUMMARY_CELLS.estimateNumber, value: info.estimateNumber, type: "string" });

  const shipTo = stripCountrySuffix(info.projectAddress);
  if (shipTo) cells.push({ ref: SUMMARY_CELLS.shipTo, value: shipTo, type: "string" });
  if (info.spEstimator) cells.push({ ref: SUMMARY_CELLS.spEstimator, value: info.spEstimator, type: "string" });

  let taxRateFraction: number | null = null;
  try {
    // The raw address is fine for the ZIP-based lookup — extractZipFromAddress
    // handles a trailing country name.
    taxRateFraction = await lookupTaxRateFraction(info.projectAddress);
  } catch (err) {
    console.warn("[estimateStamp] Tax rate lookup failed:", err);
  }
  if (taxRateFraction != null) cells.push({ ref: SUMMARY_CELLS.taxRate, value: taxRateFraction, type: "number" });

  const startDate = dateCellValue(info.anticipatedStart);
  if (startDate) cells.push({ ref: SUMMARY_CELLS.projectStartDate, value: startDate, type: "string" });
  const endDate = dateCellValue(info.anticipatedFinish);
  if (endDate) cells.push({ ref: SUMMARY_CELLS.projectEndDate, value: endDate, type: "string" });

  return cells;
}
