// Run: tsx server/taxRates/parser.test.ts
// Pure, DB-free tests for the Avalara tax-rate parser.
import assert from "assert";
import fs from "fs";
import ExcelJS from "exceljs";
import { normalizeZip, parseTaxRate, parseAvalaraWorkbook } from "./parser";

// Build an in-memory .xlsx buffer mirroring the Avalara TTR_Export layout.
async function buildWorkbook(opts: { sheetName?: string; headers?: string[]; rows: any[][] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.sheetName ?? "TTR_Export");
  ws.addRow(opts.headers ?? [
    "Zip Code", "State", "County", "City", "In/Out City/Local",
    "State Sales Tax (%)", "County Sales Tax (%)", "City Sales Tax (%)",
    "Local/Regional Sales Tax (%)", "Total Sales Tax (%)", "State Use Tax (%)",
    "County Use Tax (%)", "City Use Tax (%)", "Local/Regional Use Tax (%)",
    "Total Use Tax (%)", "Effective Date",
  ]);
  for (const r of opts.rows) ws.addRow(r);
  return (await wb.xlsx.writeBuffer()) as Buffer;
}

async function run() {
  // ── normalizeZip ──────────────────────────────────────────────────────────
  assert.strictEqual(normalizeZip("92507"), "92507", "5-digit");
  assert.strictEqual(normalizeZip("92507-1234"), "92507", "ZIP+4 dash");
  assert.strictEqual(normalizeZip("925071234"), "92507", "9-digit ZIP+4");
  assert.strictEqual(normalizeZip("06801"), "06801", "leading zero preserved");
  assert.strictEqual(normalizeZip(6801), "06801", "numeric leading-zero padded");
  assert.strictEqual(normalizeZip("501"), "00501", "3-digit padded");
  assert.strictEqual(normalizeZip(92507), "92507", "numeric 5-digit");
  assert.strictEqual(normalizeZip("  92507  "), "92507", "trimmed");
  assert.strictEqual(normalizeZip(""), null, "blank");
  assert.strictEqual(normalizeZip(null), null, "null");
  assert.strictEqual(normalizeZip(undefined), null, "undefined");
  assert.strictEqual(normalizeZip("Avalara Tax Research - Export Date: March 30, 2026"), null, "footer");
  assert.strictEqual(normalizeZip("ABC12"), null, "alphanumeric junk");
  assert.strictEqual(normalizeZip("123456"), null, "6-digit invalid");
  assert.strictEqual(normalizeZip({ formula: "A1", result: "92507-9999" } as any), "92507", "formula cell");

  // ── parseTaxRate (percentage points; 6.00000 = 6%, not 600%) ──────────────
  assert.deepStrictEqual(parseTaxRate("6.00000"), { value: "6", status: "ok" }, "6% stays 6");
  assert.deepStrictEqual(parseTaxRate("0.00000"), { value: "0", status: "zero" }, "zero distinct");
  assert.deepStrictEqual(parseTaxRate(""), { value: null, status: "missing" }, "missing");
  assert.deepStrictEqual(parseTaxRate(null), { value: null, status: "missing" }, "null missing");
  assert.deepStrictEqual(parseTaxRate("abc"), { value: null, status: "invalid" }, "nonnumeric");
  assert.deepStrictEqual(parseTaxRate("-1"), { value: null, status: "invalid" }, "negative");
  assert.deepStrictEqual(parseTaxRate("600"), { value: null, status: "invalid" }, "implausible >100");
  assert.deepStrictEqual(parseTaxRate("Infinity"), { value: null, status: "invalid" }, "infinite");
  assert.strictEqual(parseTaxRate("8.253700").value, "8.2537", "4-decimal precision");
  assert.deepStrictEqual(parseTaxRate({ formula: "X", result: 7.25 } as any), { value: "7.25", status: "ok" }, "formula result");

  // ── parseAvalaraWorkbook: happy path + footer/blank/dup/leading-zero ──────
  const buf = await buildWorkbook({
    rows: [
      ["92507", "CA", "RIVERSIDE", "RIVERSIDE", "I", 0, 0, 0, 0, 0, 0, 0, 0, 0, "6.00000", "2026-01-01"],
      ["92507", "CA", "RIVERSIDE", "RIVERSIDE", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "7.75000", "2026-01-01"], // dup ZIP, diff jurisdiction
      ["06801", "CT", "FAIRFIELD", "BETHEL", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "0.00000", "2026-01-01"],   // leading zero, zero tax
      ["92507-1234", "CA", "RIVERSIDE", "RIVERSIDE", "", 0, 0, 0, 0, 0, 0, 0, 0, 0, "6.00000", "2026-01-01"], // ZIP+4 → 92507 dup
      ["10001", "NY", "NEW YORK", "NEW YORK", "I", 0, 0, 0, 0, 0, 0, 0, 0, 0, "-5", "2026-01-01"],      // invalid (negative) tax, still valid zip
      [null, "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],                                // blank row
      ["Avalara Tax Research - Export Date: March 30, 2026", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""], // footer
    ],
  });
  const res = await parseAvalaraWorkbook(buf);
  assert.ok(res.ok, "workbook parsed ok");
  if (res.ok) {
    assert.strictEqual(res.stats.validRows, 5, "5 valid rows (blank + footer skipped)");
    assert.strictEqual(res.stats.skippedRows, 2, "blank + footer skipped");
    assert.strictEqual(res.stats.uniqueZips, 3, "92507, 06801, 10001");
    assert.strictEqual(res.stats.duplicateJurisdictionRows, 2, "two extra 92507 rows");
    assert.strictEqual(res.stats.zeroTaxRows, 1, "one zero-tax row");
    assert.strictEqual(res.stats.invalidTaxRows, 1, "one negative-tax row");
    // ZIP+4 normalized in stored rows
    assert.ok(res.rows.every(r => r.zip.length === 5), "all stored zips are 5 digits");
    // invalid tax stored as null but row preserved
    const nyRow = res.rows.find(r => r.zip === "10001");
    assert.strictEqual(nyRow?.totalUseTax, null, "invalid tax → null, row kept");
    assert.strictEqual(nyRow?.inOutCityLocal, "I", "in/out captured");
  }

  // ── Missing required headers → structured failure, no throw ───────────────
  const noZip = await buildWorkbook({ headers: ["State", "County", "Total Use Tax (%)"], rows: [["CA", "X", "6"]] });
  const r2 = await parseAvalaraWorkbook(noZip);
  assert.ok(!r2.ok && /zip code/i.test(r2.error), "missing Zip Code header rejected");

  const noTax = await buildWorkbook({ headers: ["Zip Code", "State"], rows: [["92507", "CA"]] });
  const r3 = await parseAvalaraWorkbook(noTax);
  assert.ok(!r3.ok && /total use tax/i.test(r3.error), "missing Total Use Tax header rejected");

  // ── Column reordering handled by header detection ─────────────────────────
  const reordered = await buildWorkbook({
    headers: ["Total Use Tax (%)", "City", "Zip Code", "State"],
    rows: [["9.5", "SANTA ANA", "92701", "CA"]],
  });
  const r4 = await parseAvalaraWorkbook(reordered);
  assert.ok(r4.ok, "reordered columns parsed");
  if (r4.ok) {
    assert.strictEqual(r4.rows[0].zip, "92701");
    assert.strictEqual(r4.rows[0].totalUseTax, "9.5");
    assert.strictEqual(r4.rows[0].city, "SANTA ANA");
  }

  // ── Empty-data workbook rejected (guards against wiping data) ─────────────
  const emptyData = await buildWorkbook({ rows: [] });
  const r5 = await parseAvalaraWorkbook(emptyData);
  assert.ok(!r5.ok, "no data rows → failure (route returns before any DELETE)");

  // ── Optional: verify against the REAL Avalara workbook when present ────────
  const realPath = "/root/.claude/uploads/26e8bfb0-b984-5826-b462-89db868f7a2c/960452c8-Avalara_Tax_Rates.xlsx";
  if (fs.existsSync(realPath)) {
    const realBuf = fs.readFileSync(realPath);
    const rr = await parseAvalaraWorkbook(realBuf);
    assert.ok(rr.ok, "real workbook parsed");
    if (rr.ok) {
      assert.strictEqual(rr.stats.validRows, 54245, "real: 54,245 valid rows");
      assert.strictEqual(rr.stats.uniqueZips, 41307, "real: 41,307 unique ZIPs");
      // The footer row is visited and skipped (counts as 1). The fully-empty
      // blank row is dropped by ExcelJS's row iterator before it reaches us, so
      // it is never imported but doesn't increment the skipped counter.
      assert.strictEqual(rr.stats.skippedRows, 1, "real: footer skipped (blank row dropped by reader)");
      const leadingZero = rr.rows.filter(r => r.zip.startsWith("0")).length;
      assert.strictEqual(leadingZero, 3808, "real: 3,808 leading-zero rows");
      assert.ok(rr.rows.every(r => r.zip.length === 5), "real: every zip is 5 digits");
      console.log(`  ✓ real workbook: ${rr.stats.validRows} rows, ${rr.stats.uniqueZips} unique ZIPs, ${rr.stats.duplicateJurisdictionRows} dup-jurisdiction, ${rr.stats.skippedRows} skipped`);
    }
  } else {
    console.log("  (real Avalara workbook not present — skipped live count verification)");
  }

  console.log("All tax-rate parser tests passed!");
}

run().catch((e) => { console.error(e); process.exit(1); });
