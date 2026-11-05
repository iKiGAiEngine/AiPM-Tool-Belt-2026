/**
 * Disaster Recovery — human-readable Excel copy of every table.
 *
 * This is NOT what the restore uses (that is the exact database copy). It exists so
 * that anyone at Swinerton can open the backup in Excel and read the data, even if
 * AiPM is never brought back online.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";
import ExcelJS from "exceljs";
import type { TableExport } from "./databaseSnapshot";

const EXCEL_MAX_ROWS = 1_048_575; // one row is used by the header
const EXCEL_MAX_CELL = 32_000;

function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sheetNameFor(table: string, used: Set<string>): string {
  let base = table.replace(/[\\/?*[\]:]/g, "_").slice(0, 31);
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = `_${i++}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FF0D0D0F" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC9A84C" } };
  row.alignment = { vertical: "middle" };
}

export async function writeReadableWorkbook(dbDir: string, tables: TableExport[], outFile: string, backupLabel: string): Promise<string[]> {
  const warnings: string[] = [];
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outFile, useStyles: true, useSharedStrings: false });
  wb.creator = "AiPM Disaster Recovery";
  wb.created = new Date();

  const used = new Set<string>(["contents"]);
  const sheetNames = new Map<string, string>();
  for (const t of tables) sheetNames.set(t.table, sheetNameFor(t.table, used));

  // Table of contents first.
  const toc = wb.addWorksheet("Contents");
  toc.columns = [
    { header: "Table (database name)", key: "table", width: 38 },
    { header: "Sheet", key: "sheet", width: 32 },
    { header: "Rows", key: "rows", width: 12 },
    { header: "Notes", key: "notes", width: 90 },
  ];
  styleHeader(toc.getRow(1));
  toc.getRow(1).commit();
  toc.addRow({ table: `AiPM backup ${backupLabel}`, sheet: "", rows: "", notes: "Read-only copy for people. The restore uses the exact database copy in folder 1_Database." }).commit();
  for (const t of tables) {
    let notes = "";
    if (t.dataSkipped) notes = `Rows intentionally not backed up: ${t.skipReason}`;
    else if (t.columns.some((c) => c.type === "bytea")) notes = "Contains stored files (PDF/Excel/images). Files are shown here as a size only; the actual files are in the database copy.";
    if (t.rowCount > EXCEL_MAX_ROWS) notes += ` Only the first ${EXCEL_MAX_ROWS.toLocaleString()} rows fit in Excel; all rows are in the database copy.`;
    toc.addRow({ table: t.table, sheet: sheetNames.get(t.table), rows: t.rowCount, notes }).commit();
  }
  await toc.commit();

  for (const t of tables) {
    const ws = wb.addWorksheet(sheetNames.get(t.table)!);
    const cols = t.dataColumns;
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(45, Math.max(10, c.length + 2)) }));
    styleHeader(ws.getRow(1));
    ws.getRow(1).commit();
    if (t.dataSkipped || !t.file) {
      await ws.commit();
      continue;
    }
    const binaryIdx = new Set(t.columns.filter((c) => c.generated !== "s").map((c, i) => (c.type === "bytea" ? i : -1)).filter((i) => i >= 0));

    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dbDir, t.file)).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let first = true;
    let written = 0;
    for await (const line of rl) {
      if (!line) continue;
      if (first) { first = false; continue; }
      if (written >= EXCEL_MAX_ROWS) continue;
      const values = (JSON.parse(line) as (string | null)[]).map((v, i) => {
        if (v === null) return null;
        if (binaryIdx.has(i)) return `[stored file, ${prettyBytes(Math.max(0, (v.length - 2) / 2))}]`;
        return v.length > EXCEL_MAX_CELL ? v.slice(0, EXCEL_MAX_CELL) + " …[truncated in this readable copy only]" : v;
      });
      ws.addRow(values).commit();
      written++;
    }
    if (t.rowCount > EXCEL_MAX_ROWS) warnings.push(`Readable spreadsheet: table ${t.table} has more rows than Excel allows; the full data is in the database copy.`);
    await ws.commit();
  }

  await wb.commit();
  return warnings;
}
