// Pure, DB-free parsing + normalization for the Avalara tax-rate workbook.
// Kept separate from the route handler so it can be unit-tested with tsx.
import ExcelJS from "exceljs";

// ─────────────────────────────────────────────────────────────────────────────
// ZIP normalization — the single source of truth shared by upload AND lookup.
//
//   92507        → 92507
//   92507-1234   → 92507   (ZIP+4 with dash)
//   925071234    → 92507   (ZIP+4 without dash)
//   06801        → 06801   (leading zero preserved)
//   501 / 6801   → 00501 / 06801  (numeric with dropped leading zeros, padded)
//   "" / footer / "ABC12" / "Export Date…" → null
// Returns exactly five digits, or null for anything that isn't a real ZIP.
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeZip(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // ExcelJS may hand back a formula cell object { formula, result }.
  if (typeof raw === "object" && raw !== null && "result" in (raw as any)) {
    raw = (raw as any).result;
  }
  let s = String(raw).trim();
  if (!s) return null;

  // Take the base ZIP before any ZIP+4 dash suffix.
  s = s.split("-")[0].trim();
  // Drop internal spaces ("92507 1234" style).
  s = s.replace(/\s+/g, "");

  // After stripping, it must be all digits — this rejects footer text,
  // alphanumeric junk, and any non-numeric cell.
  if (!/^\d+$/.test(s)) return null;

  // ZIP+4 packed as 9 digits → keep the first five.
  if (s.length === 9) s = s.slice(0, 5);

  if (s.length === 5) return s;
  // Numeric import can drop leading zeros (501 → should be 00501). Pad short ones.
  if (s.length >= 1 && s.length <= 4) return s.padStart(5, "0");

  // 6, 7, 8, or >9 digits is not a valid US ZIP.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tax-rate parsing. Avalara stores percentage POINTS: 6.00000 means 6%, not 600%.
// We keep the value in percentage points at 4-decimal precision (schema is
// numeric(10,4)) so downstream consumers can apply `rate / 100`.
// ─────────────────────────────────────────────────────────────────────────────
export type TaxParseStatus = "ok" | "zero" | "missing" | "invalid";
export interface TaxParseResult {
  value: string | null;
  status: TaxParseStatus;
}

export function parseTaxRate(raw: unknown): TaxParseResult {
  let v: unknown = raw;
  // Cached formula result from ExcelJS.
  if (v !== null && typeof v === "object" && "result" in (v as any)) {
    v = (v as any).result;
  }
  if (v === null || v === undefined || String(v).trim() === "") {
    return { value: null, status: "missing" };
  }
  const num = parseFloat(String(v).trim());
  if (!Number.isFinite(num)) return { value: null, status: "invalid" };
  if (num < 0) return { value: null, status: "invalid" };
  // A use-tax rate over 100 percentage points is not real data (guards against a
  // stray value that was already multiplied by 100, e.g. 600).
  if (num > 100) return { value: null, status: "invalid" };

  const rounded = Math.round(num * 10000) / 10000; // 4-decimal precision
  return { value: String(rounded), status: rounded === 0 ? "zero" : "ok" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Header detection — locate columns by normalized name so the import survives
// reordered/extra columns, falling back to nothing (we require the two we need).
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_ALIASES: Record<string, string[]> = {
  zip: ["zip code", "zip", "zipcode", "postal code"],
  state: ["state"],
  county: ["county"],
  city: ["city"],
  inOutCityLocal: ["in/out city/local", "in/out city", "inside/outside city", "in out city local"],
  totalUseTax: ["total use tax (%)", "total use tax", "total use tax %", "total use tax(%)"],
};

function normHeader(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export type ColumnMap = Partial<Record<keyof typeof HEADER_ALIASES, number>>;

export function findColumns(headerRow: ExcelJS.Row): ColumnMap {
  const map: ColumnMap = {};
  headerRow.eachCell((cell, colNumber) => {
    const h = normHeader(cell.value);
    for (const key of Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]) {
      if (map[key] !== undefined) continue;
      if (HEADER_ALIASES[key].includes(h)) map[key] = colNumber;
    }
  });
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full workbook parse.
// ─────────────────────────────────────────────────────────────────────────────
export interface ParsedRow {
  zip: string;
  state: string | null;
  county: string | null;
  city: string | null;
  inOutCityLocal: string | null;
  totalUseTax: string | null;
}

export interface ParseStats {
  validRows: number;
  uniqueZips: number;
  duplicateJurisdictionRows: number; // rows sharing a ZIP that already appeared
  skippedRows: number;               // blank / footer / non-ZIP rows
  invalidTaxRows: number;            // valid ZIP but tax value rejected
  zeroTaxRows: number;
}

export type ParseResult =
  | { ok: true; rows: ParsedRow[]; stats: ParseStats }
  | { ok: false; error: string };

function cellString(row: ExcelJS.Row, col: number | undefined): string | null {
  if (!col) return null;
  let v: unknown = row.getCell(col).value;
  if (v !== null && typeof v === "object" && "result" in (v as any)) v = (v as any).result;
  const s = String(v ?? "").trim();
  return s || null;
}

export async function parseAvalaraWorkbook(buffer: Buffer): Promise<ParseResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    return { ok: false, error: "Could not read the file. Please upload a valid .xlsx Excel workbook." };
  }

  // Prefer the Avalara export sheet; fall back to the first worksheet.
  const sheet = workbook.getWorksheet("TTR_Export") ?? workbook.worksheets[0];
  if (!sheet) return { ok: false, error: "The workbook has no worksheets." };

  const cols = findColumns(sheet.getRow(1));
  if (cols.zip === undefined || cols.totalUseTax === undefined) {
    const missing = [
      cols.zip === undefined ? '"Zip Code"' : null,
      cols.totalUseTax === undefined ? '"Total Use Tax (%)"' : null,
    ].filter(Boolean).join(" and ");
    return { ok: false, error: `Required column ${missing} not found in the spreadsheet header row.` };
  }

  const rows: ParsedRow[] = [];
  const seenZips = new Set<string>();
  const stats: ParseStats = {
    validRows: 0, uniqueZips: 0, duplicateJurisdictionRows: 0,
    skippedRows: 0, invalidTaxRows: 0, zeroTaxRows: 0,
  };

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const zip = normalizeZip(row.getCell(cols.zip!).value);
    if (!zip) { stats.skippedRows++; return; } // blank, footer, malformed ZIP

    const tax = parseTaxRate(row.getCell(cols.totalUseTax!).value);
    if (tax.status === "invalid") stats.invalidTaxRows++;
    if (tax.status === "zero") stats.zeroTaxRows++;

    if (seenZips.has(zip)) stats.duplicateJurisdictionRows++;
    else seenZips.add(zip);

    rows.push({
      zip,
      state: cellString(row, cols.state),
      county: cellString(row, cols.county),
      city: cellString(row, cols.city),
      inOutCityLocal: cellString(row, cols.inOutCityLocal),
      totalUseTax: tax.value,
    });
  });

  if (rows.length === 0) {
    return { ok: false, error: "No valid tax-rate rows found in the spreadsheet." };
  }

  stats.validRows = rows.length;
  stats.uniqueZips = seenZips.size;
  return { ok: true, rows, stats };
}
