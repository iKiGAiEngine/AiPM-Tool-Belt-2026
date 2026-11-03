// ─────────────────────────────────────────────────────────────────────────────
// Vendor Directory stamping.
//
// The NBS estimate template has a "Vendor Directory" tab (an Excel table) with
// the columns: Scope | Contact Name | Email Contact | Vendor | Manufacturer.
// When a bid folder is generated we fill that tab with the vendors currently in
// the AiPM Vendor Database, in exactly that format.
//
// Like the Summary Sheet stamping (estimateTemplateStamp.ts) we patch the sheet
// XML inside the zip directly so VBA macros and formulas survive. Existing cell
// styles in the template's first data rows are reused so the look is unchanged,
// and the Excel table's range is stretched to cover the new rows.
// ─────────────────────────────────────────────────────────────────────────────

import JSZip from "jszip";
import { db } from "./db";
import { mfrVendors, mfrContacts, mfrManufacturers, mfrVendorManufacturers } from "@shared/schema";

export const VENDOR_DIRECTORY_SHEET_NAME = "Vendor Directory";

// Header text (case-insensitive) -> key. Columns are located by header text, so
// the tab keeps working if someone reorders its columns.
const HEADERS: Record<string, keyof VendorDirectoryRow> = {
  "scope": "scope",
  "contact name": "contactName",
  "email contact": "email",
  "vendor": "vendor",
  "manufacturer": "manufacturer",
};

export interface VendorDirectoryRow {
  scope: string;
  contactName: string;
  email: string;
  vendor: string;
  manufacturer: string;
}

// ── Building the rows (pure; unit-tested) ────────────────────────────────────

export interface DirVendor { id: number; name: string; scopes: string[] | null; manufacturerIds: number[] | null }
export interface DirContact { vendorId: number; name: string | null; email: string | null; isPrimary: boolean | null }
export interface DirManufacturer { id: number; name: string }
export interface DirLink { vendorId: number; manufacturerId: number }

// One row per vendor × contact × scope × manufacturer (the flat layout the
// directory uses — e.g. the same rep appears once per manufacturer they sell).
// A vendor with no contacts / scopes / manufacturers still gets a row with that
// column blank, so no vendor is ever dropped. Contacts without a name or email
// are skipped when the vendor has a real one.
export function buildVendorDirectoryRows(
  vendors: DirVendor[],
  contacts: DirContact[],
  manufacturers: DirManufacturer[],
  links: DirLink[],
): VendorDirectoryRow[] {
  const mfrName = new Map(manufacturers.map((m) => [m.id, m.name]));
  const contactsByVendor = new Map<number, DirContact[]>();
  for (const c of contacts) {
    if (!contactsByVendor.has(c.vendorId)) contactsByVendor.set(c.vendorId, []);
    contactsByVendor.get(c.vendorId)!.push(c);
  }
  const mfrIdsByVendor = new Map<number, Set<number>>();
  const addMfr = (vid: number, mid: number) => {
    if (!mfrIdsByVendor.has(vid)) mfrIdsByVendor.set(vid, new Set());
    mfrIdsByVendor.get(vid)!.add(mid);
  };
  for (const v of vendors) for (const mid of v.manufacturerIds || []) addMfr(v.id, mid);
  for (const l of links) addMfr(l.vendorId, l.manufacturerId);

  const rows: VendorDirectoryRow[] = [];
  for (const v of vendors) {
    const all = contactsByVendor.get(v.id) || [];
    const useful = all.filter((c) => (c.name || "").trim() || (c.email || "").trim());
    // Primary contact first, then the rest in their stored order.
    const vc = [...useful].sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary));
    const contactList = vc.length ? vc : [{ vendorId: v.id, name: "", email: "", isPrimary: false }];

    const scopes = (v.scopes || []).map((s) => s.trim()).filter(Boolean);
    const scopeList = scopes.length ? scopes : [""];

    const mfrs = [...(mfrIdsByVendor.get(v.id) || [])]
      .map((id) => mfrName.get(id) || "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const mfrList = mfrs.length ? mfrs : [""];

    for (const scope of scopeList) {
      for (const c of contactList) {
        for (const m of mfrList) {
          rows.push({
            scope,
            contactName: (c.name || "").trim(),
            email: (c.email || "").trim(),
            vendor: v.name,
            manufacturer: m,
          });
        }
      }
    }
  }

  // Group by scope (blank scopes last), then vendor, so the tab reads sensibly.
  return rows.sort((a, b) => {
    if (!a.scope !== !b.scope) return a.scope ? -1 : 1;
    return (
      a.scope.localeCompare(b.scope) ||
      a.vendor.localeCompare(b.vendor) ||
      a.manufacturer.localeCompare(b.manufacturer)
    );
  });
}

// Load every vendor currently in the AiPM Vendor Database as directory rows.
export async function loadVendorDirectoryRows(): Promise<VendorDirectoryRow[]> {
  const [vendors, contacts, manufacturers, links] = await Promise.all([
    db.select().from(mfrVendors),
    db.select().from(mfrContacts),
    db.select().from(mfrManufacturers),
    db.select().from(mfrVendorManufacturers),
  ]);
  return buildVendorDirectoryRows(
    vendors.map((v) => ({ id: v.id, name: v.name, scopes: v.scopes, manufacturerIds: v.manufacturerIds })),
    contacts,
    manufacturers,
    links,
  );
}

// ── Writing the rows into the workbook XML ───────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function unescXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function colToNum(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(m[1])) !== null) text += t[1];
    out.push(unescXml(text));
  }
  return out;
}

function cellText(cellXml: string, shared: string[]): string {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1];
  if (type === "s") {
    const idx = cellXml.match(/<v>(\d+)<\/v>/)?.[1];
    return idx !== undefined ? (shared[Number(idx)] ?? "") : "";
  }
  if (type === "inlineStr") {
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(cellXml)) !== null) text += t[1];
    return unescXml(text);
  }
  return unescXml(cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
}

interface RowInfo { num: number; xml: string; start: number; end: number }

function findRows(sheetData: string): RowInfo[] {
  const rows: RowInfo[] = [];
  const re = /<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sheetData)) !== null) {
    rows.push({ num: Number(m[1]), xml: m[0], start: m.index, end: m.index + m[0].length });
  }
  return rows;
}

function cellsOf(rowXml: string): { ref: string; col: string; xml: string }[] {
  const out: { ref: string; col: string; xml: string }[] = [];
  const re = /<c\b[^>]*?\br="([A-Z]+)(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowXml)) !== null) out.push({ ref: m[1] + m[2], col: m[1], xml: m[0] });
  return out;
}

// Fill the "Vendor Directory" tab. Returns the original buffer untouched when
// the tab (or its header row) can't be found, or there are no rows to write.
export async function stampVendorDirectory(buffer: Buffer, rows: VendorDirectoryRow[]): Promise<Buffer> {
  if (rows.length === 0) return buffer;

  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) return buffer;

  const sheetTag = workbookXml.match(new RegExp(`<sheet\\b[^>]*name="${escapeRegExp(VENDOR_DIRECTORY_SHEET_NAME)}"[^>]*/?>`, "i"))?.[0];
  const rId = sheetTag?.match(/r:id="([^"]+)"/)?.[1];
  const target = rId && relsXml.match(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*/?>`, "i"))?.[0]?.match(/Target="([^"]+)"/)?.[1];
  if (!target) return buffer; // template has no Vendor Directory tab — nothing to do
  const sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target;
  let sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) return buffer;

  const shared = parseSharedStrings(await zip.file("xl/sharedStrings.xml")?.async("string"));

  const sdMatch = sheetXml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/);
  if (!sdMatch) return buffer;
  const sheetData = sdMatch[1];
  const existingRows = findRows(sheetData);

  // Locate the header row and which column holds which field.
  let headerRow = -1;
  const colFor: Partial<Record<keyof VendorDirectoryRow, string>> = {};
  for (const r of existingRows) {
    const found: Partial<Record<keyof VendorDirectoryRow, string>> = {};
    for (const c of cellsOf(r.xml)) {
      const key = HEADERS[cellText(c.xml, shared).trim().toLowerCase()];
      if (key) found[key] = c.col;
    }
    if (Object.keys(found).length >= 3) { headerRow = r.num; Object.assign(colFor, found); break; }
  }
  if (headerRow < 0) return buffer;

  // Excel table covering the directory (if any) — we stretch its range below.
  let tablePath: string | null = null;
  let tableXml: string | null = null;
  const sheetRelsPath = sheetPath.replace(/worksheets\/([^/]+)$/, "worksheets/_rels/$1.rels");
  const sheetRels = await zip.file(sheetRelsPath)?.async("string");
  if (sheetRels) {
    for (const rel of sheetRels.match(/<Relationship\b[^>]*>/g) || []) {
      if (!/relationships\/table"/.test(rel)) continue;
      const t = rel.match(/Target="([^"]+)"/)?.[1];
      if (!t) continue;
      const p = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\.\//, "");
      const x = await zip.file(p)?.async("string");
      if (x) { tablePath = p; tableXml = x; break; }
    }
  }
  const tableRef = tableXml?.match(/<table\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/);
  const tableEndRow = tableRef ? Number(tableRef[4]) : 0;

  // Reuse the template's own data-row styles (e.g. the blue link look on email
  // cells). Row 1 and row 2 below the header, so any baked-in banding repeats.
  const styleFor = (rowNum: number): Record<string, string | undefined> => {
    const r = existingRows.find((x) => x.num === rowNum);
    const out: Record<string, string | undefined> = {};
    if (r) for (const c of cellsOf(r.xml)) out[c.col] = c.xml.match(/\bs="([^"]+)"/)?.[1];
    return out;
  };
  const styleA = styleFor(headerRow + 1);
  const styleB = Object.keys(styleFor(headerRow + 2)).length ? styleFor(headerRow + 2) : styleA;

  const lastNewRow = headerRow + rows.length;
  const clearUpTo = Math.max(lastNewRow, tableEndRow, existingRows.length ? existingRows[existingRows.length - 1].num : 0);

  // Build new data rows.
  const keys = (Object.keys(colFor) as (keyof VendorDirectoryRow)[]).sort((a, b) => colToNum(colFor[a]!) - colToNum(colFor[b]!));
  const newRows = rows.map((row, i) => {
    const rowNum = headerRow + 1 + i;
    const styles = i % 2 === 0 ? styleA : styleB;
    const cells = keys.map((k) => {
      const col = colFor[k]!;
      const s = styles[col] ? ` s="${styles[col]}"` : "";
      const val = row[k];
      if (!val) return `<c r="${col}${rowNum}"${s}/>`;
      return `<c r="${col}${rowNum}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(val)}</t></is></c>`;
    });
    return `<row r="${rowNum}">${cells.join("")}</row>`;
  });

  // Splice: keep rows up to the header, drop the old data rows, append new ones,
  // keep anything after (rows below the old table that we aren't overwriting).
  const keep = existingRows.filter((r) => r.num <= headerRow || r.num > clearUpTo);
  const before = keep.filter((r) => r.num <= headerRow).map((r) => r.xml).join("");
  const after = keep.filter((r) => r.num > headerRow).map((r) => r.xml).join("");
  // Rows after the cleared range would be out of order only if clearUpTo < their
  // number, which the filter above guarantees is not the case.
  const newSheetData = before + newRows.join("") + after;
  sheetXml = sheetXml.replace(sdMatch[0], sdMatch[0].replace(sheetData, () => newSheetData));

  // Dimension.
  sheetXml = sheetXml.replace(/<dimension\b[^>]*\/>/, (d) => {
    const m = d.match(/ref="([A-Z]+\d+)(?::([A-Z]+)(\d+))?"/);
    if (!m) return d;
    const endCol = m[2] || m[1].replace(/\d+/, "");
    const endRow = Math.max(lastNewRow, m[3] ? Number(m[3]) : 0);
    return `<dimension ref="${m[1]}:${endCol}${endRow}"/>`;
  });

  // Stretch the Excel table (and its filter) to cover the new rows.
  if (tableXml && tablePath && tableRef) {
    const newEnd = Math.max(lastNewRow, headerRow + 1);
    const newRef = `${tableRef[1]}${tableRef[2]}:${tableRef[3]}${newEnd}`;
    const updated = tableXml
      .replace(/(<table\b[^>]*\bref=")[^"]+(")/, `$1${newRef}$2`)
      .replace(/(<autoFilter\b[^>]*\bref=")[^"]+(")/, `$1${newRef}$2`);
    zip.file(tablePath, updated);
  } else {
    // No table object — stretch a plain autofilter if the sheet has one.
    sheetXml = sheetXml.replace(/(<autoFilter\b[^>]*\bref=")([A-Z]+\d+):([A-Z]+)\d+(")/, `$1$2:$3${lastNewRow}$4`);
  }

  zip.file(sheetPath, sheetXml);

  // Same cache cleanup as the Summary stamp: inline strings replaced shared
  // strings' cells, and cached values for formulas must be recomputed on open.
  const wbOut = /<calcPr[^>]*\bfullCalcOnLoad=/.test(workbookXml)
    ? workbookXml
    : workbookXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  if (wbOut !== workbookXml) zip.file("xl/workbook.xml", wbOut);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Best-effort: a problem with the directory must never block the estimate
// itself, so any failure returns the workbook as it was.
export async function stampVendorDirectoryFromDatabase(buffer: Buffer): Promise<Buffer> {
  try {
    const rows = await loadVendorDirectoryRows();
    return await stampVendorDirectory(buffer, rows);
  } catch (err) {
    console.warn("[estimateStamp] Vendor Directory stamp skipped:", err);
    return buffer;
  }
}
