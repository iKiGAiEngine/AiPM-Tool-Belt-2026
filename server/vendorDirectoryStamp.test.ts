// Run: DATABASE_URL=dummy tsx server/vendorDirectoryStamp.test.ts
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildVendorDirectoryRows, stampVendorDirectory } from "./vendorDirectoryStamp";

console.log("Running vendorDirectoryStamp tests...\n");

// ── Row building ──
const rows = buildVendorDirectoryRows(
  [
    { id: 1, name: "Pacific Building Specialties", scopes: ["Toilet Accessories", "Lockers"], manufacturerIds: [10] },
    { id: 2, name: "Renco Sales", scopes: ["Toilet Accessories"], manufacturerIds: null },
    { id: 3, name: "Empty Vendor", scopes: null, manufacturerIds: null },
  ],
  [
    { vendorId: 1, name: "Mike Clark", email: "mike@pbspecialties.com", isPrimary: true },
    { vendorId: 2, name: "Mark Catacutan", email: "markc@rencosales.com; cathyk@rencosales.com", isPrimary: false },
    { vendorId: 2, name: "", email: "", isPrimary: false }, // blank contact is skipped
  ],
  [{ id: 10, name: "Bobrick" }, { id: 11, name: "ASI / Global" }, { id: 12, name: "Bradley" }],
  [{ vendorId: 1, manufacturerId: 11 }, { vendorId: 2, manufacturerId: 12 }],
);
// Vendor 1: 2 scopes x 2 mfrs = 4; vendor 2: 1; vendor 3: 1 (all-blank)
assert.equal(rows.length, 6);
assert.equal(rows[rows.length - 1].vendor, "Empty Vendor"); // blank scope sorts last
assert.deepEqual(
  rows.filter((r) => r.vendor === "Renco Sales"),
  [{ scope: "Toilet Accessories", contactName: "Mark Catacutan", email: "markc@rencosales.com; cathyk@rencosales.com", vendor: "Renco Sales", manufacturer: "Bradley" }],
);
assert.deepEqual(
  rows.filter((r) => r.vendor === "Pacific Building Specialties" && r.scope === "Toilet Accessories").map((r) => r.manufacturer),
  ["ASI / Global", "Bobrick"], // union of tag array + link table, sorted
);
console.log("  ✓ buildVendorDirectoryRows");

// ── Stamping a workbook that has a Vendor Directory table ──
async function makeTemplate(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Summary Sheet");
  const ws = wb.addWorksheet("Vendor Directory");
  ws.addTable({
    name: "VendorDir", ref: "A1", headerRow: true, totalsRow: false,
    columns: ["Scope", "Contact Name", "Email Contact", "Vendor", "Manufacturer"].map((name) => ({ name, filterButton: true })),
    rows: [["Old Scope", "Old Person", "old@x.com", "Old Vendor", "Old Mfr"], ["Old2", "", "", "", ""]],
  });
  ws.getCell("C2").font = { color: { argb: "FF0563C1" }, underline: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

(async () => {
  const out = await stampVendorDirectory(await makeTemplate(), rows);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out);
  const ws = wb.getWorksheet("Vendor Directory")!;
  assert.deepEqual((ws.getRow(1).values as any[]).slice(1), ["Scope", "Contact Name", "Email Contact", "Vendor", "Manufacturer"]);
  assert.equal(ws.getCell("A2").value, rows[0].scope);
  assert.equal(ws.getCell("D2").value, rows[0].vendor);
  assert.equal(ws.getCell(`D${rows.length + 1}`).value, "Empty Vendor");
  assert.equal(ws.getCell(`A${rows.length + 2}`).value, null); // nothing past the last row
  assert.equal(ws.getCell("C2").font?.underline, true);        // template's email styling reused
  const t = (ws as any).tables?.VendorDir ?? Object.values((ws as any).tables || {})[0];
  assert.equal((t as any).table.tableRef, `A1:E${rows.length + 1}`);   // table stretched
  assert.ok(!JSON.stringify(ws.getRow(2).values).includes("Old")); // old sample rows replaced
  console.log("  ✓ stampVendorDirectory fills rows, keeps styling, stretches table");

  // Template with no Vendor Directory tab, or no rows: returned untouched.
  const plain = new ExcelJS.Workbook(); plain.addWorksheet("Summary Sheet");
  const plainBuf = Buffer.from(await plain.xlsx.writeBuffer());
  assert.equal(await stampVendorDirectory(plainBuf, rows), plainBuf);
  const tpl = await makeTemplate();
  assert.equal(await stampVendorDirectory(tpl, []), tpl);
  console.log("  ✓ no-op when tab missing or no vendors");

  console.log("\nAll vendorDirectoryStamp tests passed!");
})().catch((e) => { console.error(e); process.exit(1); });
