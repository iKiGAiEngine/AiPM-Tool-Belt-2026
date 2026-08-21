// Run: DATABASE_URL=dummy tsx server/estimateTemplateStamp.test.ts
import assert from "assert";
import { highestTaxFraction, excelDateSerial, extractZipFromAddress } from "./estimateTemplateStamp";

console.log("Running estimateTemplateStamp tests...\n");

// ── highestTaxFraction — the tax-rate audit ──
// Regression: a real 0% rate (Oregon / Portland OR 97239 has no sales tax) must
// come back as 0, NOT null. Returning null skipped stamping cell B8 and left the
// template's baked-in 9.25% default on the estimate.
assert.strictEqual(highestTaxFraction([0]), 0, "0% is a real rate → 0, not null");
assert.strictEqual(highestTaxFraction(["0.0000"]), 0, "numeric-string 0 → 0");
assert.strictEqual(highestTaxFraction([null, "0"]), 0, "0 among nulls → 0");
console.log("PASS: 0% tax rate returns 0 (stamped), not null (skipped)");

assert.strictEqual(highestTaxFraction([9.25]), 0.0925, "9.25 points → 0.0925 fraction");
assert.strictEqual(highestTaxFraction(["9.2500", "8.0000"]), 0.0925, "highest of multiple jurisdictions wins");
assert.strictEqual(highestTaxFraction([7.5, 9.5, 8.25]), 0.095, "max across three rates");
console.log("PASS: highest rate wins for multi-jurisdiction ZIPs");

assert.strictEqual(highestTaxFraction([]), null, "no rows → null (leave template default)");
assert.strictEqual(highestTaxFraction([null, undefined, ""]), null, "only empties → null");
assert.strictEqual(highestTaxFraction(["abc", null]), null, "non-numeric only → null");
console.log("PASS: null only when there is genuinely no usable rate");

// ── excelDateSerial (unchanged behavior guard) ──
assert.strictEqual(excelDateSerial("2026-08-12"), 46246, "known date serial");
assert.strictEqual(excelDateSerial("2026-13-40"), null, "invalid date → null");
assert.strictEqual(excelDateSerial(""), null, "empty → null");
console.log("PASS: excelDateSerial still correct");

// ── extractZipFromAddress on the reported address (with country suffix) ──
assert.strictEqual(
  extractZipFromAddress("6892 SW Terwilliger Ave, Portland, OR 97239, United States of America"),
  "97239",
  "ZIP pulled after the state token even with a trailing country name",
);
console.log("PASS: extractZipFromAddress finds 97239 in the Portland address");

console.log("\nAll estimateTemplateStamp tests passed!");
