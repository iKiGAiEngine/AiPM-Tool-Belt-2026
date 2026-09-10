import assert from "assert";
import { resolveSwinertonSoCalSubregion, matchSwinertonOffice } from "./swinertonOffices.js";
import type { Region } from "@shared/schema";

const FAKE_REGIONS: Region[] = [
  { id: 1, code: "LAX", name: "TM", aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 2, code: "LAX", name: "SPD", aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 3, code: "LAX", name: "OCLA", aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 4, code: "LAX", name: "FS", aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 5, code: "SAN", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 6, code: "SEA", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 7, code: "HNL", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 8, code: "GEG", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 9, code: "PDX", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 10, code: "SFO", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 11, code: "LGA", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 12, code: "DFW", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 13, code: "CLT", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 14, code: "AUS", name: null, aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
];

console.log("Running Swinerton SoCal sub-region resolver tests...\n");

// --- Required acceptance tests from spec ---

let r = resolveSwinertonSoCalSubregion(["Swinerton Builders - SoCal - Target Markets"], FAKE_REGIONS);
assert.strictEqual(r.code, "LAX");
assert.strictEqual(r.displayLabel, "LAX - TM");
assert.strictEqual(r.confident, true);
assert.strictEqual(r.socalDetected, true);
console.log("PASS: 'Swinerton Builders - SoCal - Target Markets' → LAX - TM");

r = resolveSwinertonSoCalSubregion(["Swinerton Builders - SoCal - Special Projects"], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - SPD");
console.log("PASS: 'Swinerton Builders - SoCal - Special Projects' → LAX - SPD");

r = resolveSwinertonSoCalSubregion(["Swinerton Builders - SoCal - OCLA"], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - OCLA");
console.log("PASS: 'Swinerton Builders - SoCal - OCLA' → LAX - OCLA");

r = resolveSwinertonSoCalSubregion(["Swinerton Builders - SoCal - Facility Solutions"], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - FS");
console.log("PASS: 'Swinerton Builders - SoCal - Facility Solutions' → LAX - FS");

r = resolveSwinertonSoCalSubregion(["Swinerton Builders - SoCal"], FAKE_REGIONS);
assert.strictEqual(r.confident, false, "SoCal-only should NOT be confident");
assert.strictEqual(r.socalDetected, true, "SoCal-only should be flagged for manual review");
assert.strictEqual(r.code, "");
console.log("PASS: 'Swinerton Builders - SoCal' (no sub-region) → manual review (not guessed)");

// --- Priority order verification ---

r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal - Special Projects",
  "OCLA Office",
], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - SPD", "SPD must beat OCLA when both present");
console.log("PASS: Priority — SPD beats OCLA");

r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal",
  "Target Markets project for tenant improvement",
], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - TM", "TM must beat SPD when both present");
console.log("PASS: Priority — TM beats SPD");

// --- Word-boundary protection ---

r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal",
  "Atmospheric estimating system",
], FAKE_REGIONS);
assert.strictEqual(r.confident, false, "'tm' inside 'atmospheric/estimating' must NOT match TM");
assert.strictEqual(r.code, "");
console.log("PASS: Word boundary — 'tm' inside 'atmospheric/estimating' does not match");

r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal",
  "Offsite project, TFS-001",
], FAKE_REGIONS);
assert.strictEqual(r.confident, false, "'fs' inside 'TFS' must NOT match FS");
console.log("PASS: Word boundary — 'fs' inside 'TFS-001' does not match");

r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal",
  "Title office estimating",
], FAKE_REGIONS);
assert.strictEqual(r.confident, false, "'ti' inside 'Title/estimating' must NOT match TI");
console.log("PASS: Word boundary — 'ti' inside 'Title/estimating' does not match");

// --- Bare 'tm', 'fs', 'ti', 'spd' as standalone tokens DO match ---

r = resolveSwinertonSoCalSubregion(["Swinerton SoCal", "Project notes: TM bid"], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - TM");
console.log("PASS: Bare 'TM' as a word matches Target Markets");

r = resolveSwinertonSoCalSubregion(["Swinerton SoCal", "FS scope only"], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - FS");
console.log("PASS: Bare 'FS' as a word matches Facility Solutions");

// --- Non-Swinerton or non-SoCal must NOT fire (caller falls through) ---

r = resolveSwinertonSoCalSubregion(["Turner Construction - Target Markets"], FAKE_REGIONS);
assert.strictEqual(r.socalDetected, false, "Non-Swinerton must NOT trigger SoCal resolver");
console.log("PASS: Non-Swinerton input → resolver does NOT fire (general resolver owns it)");

r = resolveSwinertonSoCalSubregion(["Swinerton Builders - Seattle"], FAKE_REGIONS);
assert.strictEqual(r.socalDetected, false, "Swinerton SEA must NOT trigger SoCal resolver");
console.log("PASS: Swinerton non-SoCal (Seattle) → resolver does NOT fire");

// --- "Southern California" alias ---

r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - Southern California",
  "Target Markets project",
], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - TM");
console.log("PASS: 'Southern California' alias recognized as SoCal");

// --- 'So Cal' with space ---

r = resolveSwinertonSoCalSubregion(["Swinerton Builders - So Cal - Target Markets"], FAKE_REGIONS);
assert.strictEqual(r.displayLabel, "LAX - TM");
console.log("PASS: 'So Cal' with a space recognized as SoCal");

// --- primaryMarket-style noise must NOT auto-promote to TM ---
// (e.g. project with primaryMarket=Healthcare must stay manual unless label says TM)
r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal",
  "Healthcare facility upgrade",  // 'facility' alone matches FS — see priority test below
], FAKE_REGIONS);
// 'facility' DOES trigger FS by spec — but that's an explicit FS keyword, not a Healthcare one.
// The important check is: NO promotion to TM/SPD/OCLA from a Healthcare-only signal.
r = resolveSwinertonSoCalSubregion([
  "Swinerton Builders - SoCal",
  "Healthcare project plan review",
], FAKE_REGIONS);
assert.notStrictEqual(r.displayLabel, "LAX - TM", "Healthcare alone must NOT become TM");
assert.notStrictEqual(r.displayLabel, "LAX - SPD", "Healthcare alone must NOT become SPD");
assert.notStrictEqual(r.displayLabel, "LAX - OCLA", "Healthcare alone must NOT become OCLA");
console.log("PASS: Healthcare-only signal does NOT auto-classify to TM/SPD/OCLA");

// --- Regression: existing matchSwinertonOffice still works for non-SoCal regions ---

assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Honolulu", FAKE_REGIONS).code, "HNL");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Seattle", FAKE_REGIONS).code, "SEA");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Spokane", FAKE_REGIONS).code, "GEG");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Boise", FAKE_REGIONS).code, "PDX");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Portland", FAKE_REGIONS).code, "PDX");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - San Diego", FAKE_REGIONS).code, "SAN");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - NorCal", FAKE_REGIONS).code, "SFO");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - New York", FAKE_REGIONS).code, "LGA");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Dallas", FAKE_REGIONS).code, "DFW");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Charlotte", FAKE_REGIONS).code, "CLT");
console.log("PASS: Regression — HNL, SEA, GEG, PDX, SAN, SFO, LGA, DFW, CLT still resolve");

// --- Regression: DPS Gateway E-5 (Denver) intake — the BC invite email for
// this project had no "Company - Office" dash format at all, only the GC's
// office street address ("6890 West 52nd Avenue, Arvada, CO 80002"). Region
// resolution must work from the office city name "Arvada" alone, not just
// "Denver"/"Colorado" literally. ---
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Denver", FAKE_REGIONS).code, "DEN");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Colorado", FAKE_REGIONS).code, "DEN");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Arvada", FAKE_REGIONS).code, "DEN");
assert.strictEqual(matchSwinertonOffice("Swinerton Builders - Arvada, CO", FAKE_REGIONS).code, "DEN");
console.log("PASS: 'Swinerton Builders - Arvada' → DEN (office address city, no dash-labeled office name)");

// --- Regression: PDX has two distinct office rows (Portland, Idaho). Passing
// name=undefined into result() previously grabbed whichever PDX row happened to
// come first in the regions array, so "Portland" could silently resolve to the
// "Idaho" region row. Use a regions list shaped like production (both PDX rows
// present, Idaho seeded first) to prove Portland and Boise now resolve to their
// own distinct rows regardless of array order. ---
const PDX_SPLIT_REGIONS: Region[] = [
  ...FAKE_REGIONS.filter(r => r.code !== "PDX"),
  { id: 90, code: "PDX", name: "Idaho", aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
  { id: 91, code: "PDX", name: "Portland", aliases: [], selfPerformEstimators: [], isActive: true, createdAt: new Date() },
];

const portlandResult = matchSwinertonOffice("Swinerton Builders - Portland", PDX_SPLIT_REGIONS);
assert.strictEqual(portlandResult.code, "PDX");
assert.strictEqual(portlandResult.displayLabel, "PDX - Portland");

const idahoResult = matchSwinertonOffice("Swinerton Builders - Boise", PDX_SPLIT_REGIONS);
assert.strictEqual(idahoResult.code, "PDX");
assert.strictEqual(idahoResult.displayLabel, "PDX - Idaho");

assert.notStrictEqual(portlandResult.displayLabel, idahoResult.displayLabel, "Portland and Boise/Idaho must resolve to different PDX sub-regions");
console.log("PASS: 'Swinerton Builders - Portland' → PDX - Portland (not PDX - Idaho)");

console.log("\nAll Swinerton SoCal sub-region tests passed!");
