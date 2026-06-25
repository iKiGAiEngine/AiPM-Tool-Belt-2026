// Standalone acceptance test for the Buyout Bot estimate parser.
// Run: npx tsx scripts/test-buyout-parser.ts
//
// The real "BSW BUMC OB Triage" workbook isn't in the repo, so this builds an
// in-memory workbook that mirrors its structure — alias tab names, separate
// unit-$ vs extended-$ columns, a lump-sum scope whose line totals are 0, plus
// housekeeping + empty-placeholder tabs that must be skipped — and asserts the
// Section 7 targets: 4 scopes / 18 line items with the stated budgets.

import * as XLSX from "xlsx";
import { parseEstimateWorkbook } from "../shared/buyout/estimateParser";
import { resolveScope } from "../shared/buyout/canonicalScopes";

// Header layout: extended $ columns sit to the RIGHT of unit $ columns, both
// labelled "Material"/"Freight"/"Labor". The parser must pick the LAST one
// left of Total (the extended column), not the unit column.
const HEADER = [
  "Spec No", "Plan Callout", "Description", "Model", "Quantity",
  "Material Unit", "Material", "Freight Unit", "Freight", "Labor Unit", "Labor", "Total",
];

type Line = { spec: string; callout: string; desc: string; model: string; qty: number; mat: number; frt: number; lab: number; total: number };

function buildSheet(lines: Line[], sub: { mat: number; frt: number; lab: number }, grand: number) {
  const aoa: unknown[][] = [];
  aoa.push(["Project: Test", null]);          // padding row above header
  aoa.push(HEADER);
  for (const l of lines) {
    aoa.push([l.spec, l.callout, l.desc, l.model, l.qty, l.mat, l.mat * l.qty, l.frt, l.frt, l.lab, l.lab, l.total]);
  }
  aoa.push(["MARKUP", null, null, null, null, null, null, null, null, null, null, 999]); // markup row (no spec+desc → skipped)
  aoa.push(["SUBTOTAL", null, null, null, null, null, sub.mat, null, sub.frt, null, sub.lab, sub.mat + sub.frt + sub.lab]);
  aoa.push(["GRAND TOTAL", null, null, null, null, null, null, null, null, null, null, grand]);
  return XLSX.utils.aoa_to_sheet(aoa);
}

const wb = XLSX.utils.book_new();

// 1. Toilet Accessories — alias tab name "Washroom Accessories", 6 items.
XLSX.utils.book_append_sheet(wb, buildSheet(
  [
    { spec: "10 28 00", callout: "TA-1", desc: "Grab Bar 36in", model: "B-6806", qty: 4, mat: 100, frt: 50, lab: 0, total: 400 },
    { spec: "10 28 00", callout: "TA-2", desc: "Soap Dispenser", model: "B-2111", qty: 6, mat: 40, frt: 50, lab: 0, total: 240 },
    { spec: "10 28 00", callout: "TA-3", desc: "Paper Towel Dispenser", model: "B-262", qty: 6, mat: 120, frt: 50, lab: 0, total: 720 },
    { spec: "10 28 00", callout: "TA-4", desc: "Mirror 18x36", model: "B-165", qty: 6, mat: 80, frt: 50, lab: 0, total: 480 },
    { spec: "10 28 00", callout: "TA-5", desc: "Toilet Paper Holder", model: "B-2840", qty: 8, mat: 30, frt: 50, lab: 0, total: 240 },
    { spec: "10 28 00", callout: "TA-6", desc: "Hand Dryer (Dyson)", model: "AB14", qty: 2, mat: 1100, frt: 50, lab: 0, total: 458 },
  ],
  { mat: 2538, frt: 300, lab: 0 }, 3993,
), "Washroom Accessories");

// 2. Fire Extinguisher Cabinets — alias tab "Fire Extinguishers and Cabinets", 2 items.
XLSX.utils.book_append_sheet(wb, buildSheet(
  [
    { spec: "10 44 13", callout: "FEC-1", desc: "Fire Extinguisher Cabinet, Semi-Recessed", model: "1017F10", qty: 4, mat: 100, frt: 100, lab: 0, total: 400 },
    { spec: "10 44 16", callout: "FE-1", desc: "ABC Extinguisher 10lb", model: "Cosmic 10E", qty: 4, mat: 25, frt: 100, lab: 0, total: 100 },
  ],
  { mat: 500, frt: 200, lab: 0 }, 980,
), "Fire Extinguishers and Cabinets");

// 3. Wall Protection — LUMP SUM: line totals are 0, but the SUBTOTAL carries the money. 9 items.
const wpLines: Line[] = [];
for (let i = 1; i <= 9; i++) {
  wpLines.push({ spec: "10 26 00", callout: `WP-${i}`, desc: `Corner Guard Type ${i}`, model: `CO-8${i}`, qty: 10, mat: 0, frt: 0, lab: 0, total: 0 });
}
XLSX.utils.book_append_sheet(wb, buildSheet(wpLines, { mat: 10917, frt: 1009, lab: 4862 }, 16788), "Wall Protection");

// 4. Cubicle Curtains — 1 item.
XLSX.utils.book_append_sheet(wb, buildSheet(
  [{ spec: "10 21 23", callout: "CC-1", desc: "Cubicle Curtain w/ Track (ALLOWANCE)", model: "TRACK", qty: 12, mat: 264, frt: 250, lab: 0, total: 514 }],
  { mat: 264, frt: 250, lab: 0 }, 716,
), "Cubicle Curtains");

// 5. Empty placeholder tab (grand total 0) — must be skipped.
XLSX.utils.book_append_sheet(wb, buildSheet(
  [{ spec: "10 14 00", callout: "S-1", desc: "Room Sign", model: "X", qty: 0, mat: 0, frt: 0, lab: 0, total: 0 }],
  { mat: 0, frt: 0, lab: 0 }, 0,
), "Signage");

// 6. Housekeeping tabs — must be skipped.
for (const name of ["Summary Sheet", "Buyout", "PO Review", "Change Log", "BOBRICK Material Pricing 2025", "Proposal"]) {
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["junk", "data"], [1, 2]]), name);
}

// ---------------------------------------------------------------------------
const parsed = parseEstimateWorkbook(wb);

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: got ${actual}${ok ? "" : `  expected ${expected}`}`);
}

console.log("\n=== Buyout Parser Acceptance ===\n");
check("scope count", parsed.scopes.length, 4);
const totalItems = parsed.scopes.reduce((s, sc) => s + sc.items.length, 0);
check("total line items", totalItems, 18);

const byName = (n: string) => parsed.scopes.find((s) => s.name === n);

const ta = byName("Toilet Accessories");
console.log("\n-- Toilet Accessories (from alias 'Washroom Accessories') --");
check("  resolved canonical name", ta?.name, "Toilet Accessories");
check("  items", ta?.items.length, 6);
check("  material", ta?.budget.material, 2538);
check("  freight", ta?.budget.freight, 300);
check("  grand", ta?.budget.grand, 3993);

const fec = byName("Fire Extinguisher Cabinets");
console.log("\n-- Fire Extinguisher Cabinets (from alias) --");
check("  items", fec?.items.length, 2);
check("  material", fec?.budget.material, 500);
check("  freight", fec?.budget.freight, 200);
check("  grand", fec?.budget.grand, 980);

const wp = byName("Wall Protection");
console.log("\n-- Wall Protection (lump-sum: line totals 0) --");
check("  items", wp?.items.length, 9);
check("  material (from SUBTOTAL not line sum)", wp?.budget.material, 10917);
check("  freight", wp?.budget.freight, 1009);
check("  grand", wp?.budget.grand, 16788);
check("  line total sum is 0", wp?.items.reduce((s, it) => s + it.total, 0), 0);
check("  budget.total trusts subtotal (>0)", (wp?.budget.total ?? 0) > 0, true);

const cc = byName("Cubicle Curtains");
console.log("\n-- Cubicle Curtains --");
check("  items", cc?.items.length, 1);
check("  material", cc?.budget.material, 264);
check("  freight", cc?.budget.freight, 250);
check("  grand", cc?.budget.grand, 716);
check("  allowance flagged", cc?.items[0].isAllowance, true);

console.log("\n-- Skips --");
check("  Signage (grand total 0) skipped", byName("Signage") == null, true);
check("  housekeeping sheets skipped", parsed.skipped.length >= 6, true);

console.log("\n-- Alias resolver spot-checks --");
check("  'Washroom Accessories'", resolveScope("Washroom Accessories"), "Toilet Accessories");
check("  'FEC'", resolveScope("FEC"), "Fire Extinguisher Cabinets");
check("  '10 26 00 - Corner Guards'", resolveScope("10 26 00 - Corner Guards"), "Wall Protection");
check("  'Toilet Compartments'", resolveScope("Toilet Compartments"), "Toilet Partitions");
check("  unknown returns null", resolveScope("Plumbing Fixtures"), null);

console.log(`\n${failures === 0 ? "✅ ALL CHECKS PASSED" : `❌ ${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
