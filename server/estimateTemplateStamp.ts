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
  projectName: "B1", // auto-derives from filename formula — do not stamp
  bidDueDate: "B2",  // auto-derives from filename formula — do not stamp
  shipTo: "B4",      // project address
  gcEstimator: "B6",
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

// Stamp cells into a workbook's worksheet XML without disturbing macros or
// formulas. Returns the repackaged workbook buffer. Safe for .xlsm and .xlsx.
export async function stampWorkbookCells(buffer: Buffer, sheetName: string, cells: StampCell[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("Invalid workbook: missing xl/workbook.xml");

  const sheetTag = workbookXml.match(new RegExp(`<sheet[^>]*name="${escapeRegExp(sheetName)}"[^>]*/?>`, "i"))?.[0];
  if (!sheetTag) throw new Error(`Sheet "${sheetName}" not found in workbook`);
  const rId = sheetTag.match(/r:id="([^"]+)"/)?.[1];
  if (!rId) throw new Error(`Sheet "${sheetName}" is missing its r:id`);
  const relTag = relsXml.match(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*/?>`, "i"))?.[0];
  const target = relTag?.match(/Target="([^"]+)"/)?.[1];
  if (!target) throw new Error(`Could not resolve target for sheet "${sheetName}"`);
  const sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target;

  let sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) throw new Error(`Worksheet XML not found at ${sheetPath}`);

  for (const c of cells) {
    if (c.value === null || c.value === undefined || c.value === "") continue;
    sheetXml = patchCell(sheetXml, c.ref, c.value, c.type);
  }

  zip.file(sheetPath, sheetXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Pull the most likely 5-digit ZIP out of a free-form address string. Prefers the
// last ZIP-shaped token, which in a US address is the trailing postal code.
export function extractZipFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const matches = address.match(/\b\d{5}(?:-\d{4})?\b/g);
  if (!matches || matches.length === 0) return null;
  return normalizeZip(matches[matches.length - 1]);
}

// Look up the sales/use tax rate for an address's ZIP and return it as a fraction
// (e.g. 0.0925 for 9.25%). Tax rates are stored in percentage points, so we divide
// by 100. When a ZIP spans multiple jurisdictions we take the highest rate, which
// is the conservative choice for a bid. Returns null when nothing is found.
export async function lookupTaxRateFraction(address: string | null | undefined): Promise<number | null> {
  const zip = extractZipFromAddress(address);
  if (!zip) return null;
  const rows = await db.select({ tax: taxRates.totalUseTax }).from(taxRates).where(eq(taxRates.zipCode, zip));
  if (rows.length === 0) return null;
  const maxPoints = Math.max(...rows.map((r) => Number(r.tax) || 0));
  if (!maxPoints || !isFinite(maxPoints)) return null;
  return maxPoints / 100;
}
