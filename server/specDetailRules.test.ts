// Run: tsx server/specDetailRules.test.ts
// Pure, DB-free and API-free tests for the Detailed Spec Review's rule engine —
// the flags an estimator must never miss regardless of what the model says.
import assert from "assert";
import { deterministicFlags, completenessScore, buildSectionText, type DetailReviewTarget } from "./specDetailRules";
import { EMPTY_ORDER_FORM_ITEM, type SpecOpenItem, type SpecOrderFormItem } from "@shared/specDetailReview";

function item(overrides: Partial<SpecOrderFormItem>): SpecOrderFormItem {
  return { ...EMPTY_ORDER_FORM_ITEM, ...overrides };
}

function target(sectionNumber: string, title: string): DetailReviewTarget {
  return { id: "x", sectionNumber, title, startPage: 0, endPage: 2 };
}

function codes(flags: { code: string }[]): string[] {
  return flags.map(f => f.code);
}

// A well-specified single item with no risky language should raise nothing.
const cleanItem = item({
  itemName: "Toilet Paper Dispenser",
  materialType: "Washroom accessory",
  basisOfDesign: "Bobrick B-2888",
  manufacturers: ["Bobrick"],
  modelNumbers: ["B-2888"],
  material: "Type 304 stainless steel, 22 gauge",
  quantityBasis: "Per drawings",
});

{
  const flags = deterministicFlags(target("10 28 00", "Toilet Accessories"), [cleanItem], [], "yes", "PART 1 GENERAL. Provide dispensers as scheduled.");
  assert.deepStrictEqual(codes(flags), [], `expected no flags, got ${codes(flags).join(", ")}`);
}

// Two versions of the same material in one section — the headline case.
{
  const items = [
    item({ itemName: "Wall Protection Panel - Type A", manufacturers: ["C/S"], modelNumbers: ["Acrovyn 4000"], quantityBasis: "Per drawings" }),
    item({ itemName: "Wall Protection Panel - Type B", manufacturers: ["C/S"], modelNumbers: ["Acrovyn 3000"], quantityBasis: "Per drawings" }),
  ];
  const flags = deterministicFlags(target("10 26 00", "Wall and Door Protection"), items, [], "yes", "Rigid sheet wall protection.");
  assert.ok(codes(flags).includes("multiple_variants"), "two panel types must raise multiple_variants");
  const flag = flags.find(f => f.code === "multiple_variants")!;
  assert.ok(flag.detail.includes("Type A") && flag.detail.includes("Type B"), "flag should name both types");
  assert.strictEqual(flag.severity, "high");
}

// Fire-rated fire extinguisher cabinets.
{
  const items = [item({ itemName: "FEC - Fire Rated", manufacturers: ["JL Industries"], modelNumbers: ["Ambassador"], fireRating: "2 hour", quantityBasis: "Per drawings" })];
  const flags = deterministicFlags(target("10 44 00", "Fire Extinguisher Cabinets"), items, [], "yes", "Provide fire rated cabinets at rated wall assemblies.");
  assert.ok(codes(flags).includes("fire_rated_fec"), "rated FEC must be flagged");
  assert.ok(!codes(flags).includes("fire_rating_required"), "FEC sections use the FEC-specific flag, not the generic one");
}

// A non-FEC section with fire-rating language gets the generic rating flag.
{
  const flags = deterministicFlags(target("10 21 13", "Toilet Compartments"), [cleanItem], [], "yes", "Panels shall be fire-rated Class A.");
  assert.ok(codes(flags).includes("fire_rating_required"));
  assert.ok(!codes(flags).includes("fire_rated_fec"));
}

// Sole-source language, found either in the model's answer or the raw text.
{
  const byText = deterministicFlags(target("10 28 00", "Toilet Accessories"), [cleanItem], [], "unclear", "No substitutions will be permitted.");
  assert.ok(codes(byText).includes("no_substitutions"));
  const byAnswer = deterministicFlags(target("10 28 00", "Toilet Accessories"), [cleanItem], [], "no", "Standard text.");
  assert.ok(codes(byAnswer).includes("no_substitutions"));
}

// Gaps in the order form itself.
{
  const bare = item({ itemName: "Visual Display Board" });
  const flags = deterministicFlags(target("10 11 00", "Visual Display Units"), [bare], [], "unclear", "Provide boards as scheduled.");
  assert.ok(codes(flags).includes("missing_manufacturer"), "no manufacturer and no BOD must flag");
  assert.ok(codes(flags).includes("quantity_not_specified"));
}

{
  const noModel = item({ itemName: "Marker Board", manufacturers: ["Claridge"], quantityBasis: "Per drawings" });
  const flags = deterministicFlags(target("10 11 00", "Visual Display Units"), [noModel], [], "unclear", "Provide boards.");
  assert.ok(codes(flags).includes("missing_model"));
  assert.ok(!codes(flags).includes("missing_manufacturer"), "a named manufacturer should not also flag as missing");
}

// Stainless with no grade or gauge is a real money risk; with a grade it is not.
{
  const vague = item({ itemName: "Grab Bar", material: "Stainless steel", manufacturers: ["Bobrick"], modelNumbers: ["B-6806"], quantityBasis: "Per drawings" });
  assert.ok(codes(deterministicFlags(target("10 28 00", "Toilet Accessories"), [vague], [], "yes", "Grab bars.")).includes("stainless_grade_unclear"));

  const resolved = item({ ...vague, material: "Type 304 stainless steel, 18 gauge" });
  assert.ok(!codes(deterministicFlags(target("10 28 00", "Toilet Accessories"), [resolved], [], "yes", "Grab bars.")).includes("stainless_grade_unclear"));
}

// Architect-selected finishes.
{
  const custom = item({ ...cleanItem, colorFinish: "Custom color as selected by Architect" });
  assert.ok(codes(deterministicFlags(target("10 26 00", "Wall Protection"), [custom], [], "yes", "Colors as scheduled.")).includes("custom_color_finish"));
}

// Section-text rules.
{
  const text = "Provide a mock-up for review. Recycled content shall support LEED credits. Comply with ADA. Warranty: 10 year. Refer to Section 06 10 00 for blocking. Installation by others.";
  const flags = codes(deterministicFlags(target("10 26 00", "Wall Protection"), [cleanItem], [], "yes", text));
  for (const code of ["mockup_required", "sustainability_requirement", "ada_requirement", "extended_warranty", "cross_section_reference", "installation_by_others"]) {
    assert.ok(flags.includes(code), `expected ${code} in ${flags.join(", ")}`);
  }
}

// A one-year warranty is the industry standard and should not be flagged.
{
  const flags = codes(deterministicFlags(target("10 26 00", "Wall Protection"), [cleanItem], [], "yes", "Warranty: 1 year from Substantial Completion."));
  assert.ok(!flags.includes("extended_warranty"));
}

// Open RFIs roll up into their own flag.
{
  const openItems: SpecOpenItem[] = [
    { field: "Color", classification: "rfi", question: "Which color?", assumption: "Standard", impact: "high" },
    { field: "Quantity", classification: "assumed", question: "", assumption: "Per takeoff", impact: "low" },
  ];
  const flags = deterministicFlags(target("10 26 00", "Wall Protection"), [cleanItem], openItems, "yes", "Standard text.");
  const rfiFlag = flags.find(f => f.code === "open_rfi");
  assert.ok(rfiFlag, "one RFI open item must raise open_rfi");
  assert.ok(rfiFlag!.detail.includes("1 item"), `expected singular phrasing, got "${rfiFlag!.detail}"`);
}

// Flags come back high severity first.
{
  const items = [
    item({ itemName: "Panel A", manufacturers: ["C/S"], modelNumbers: ["4000"], quantityBasis: "Per drawings" }),
    item({ itemName: "Panel B", manufacturers: ["C/S"], modelNumbers: ["3000"], quantityBasis: "Per drawings" }),
  ];
  const flags = deterministicFlags(target("10 26 00", "Wall Protection"), items, [], "yes", "Comply with ADA. Provide a mock-up.");
  const order = { high: 0, medium: 1, low: 2 } as const;
  for (let i = 1; i < flags.length; i++) {
    assert.ok(order[flags[i - 1].severity] <= order[flags[i].severity], "flags must be sorted by severity");
  }
}

// Completeness scoring.
{
  assert.strictEqual(completenessScore([], []), 0, "no items means nothing was answered");
  const full = item({
    materialType: "x", basisOfDesign: "x", manufacturers: ["x"], modelNumbers: ["x"],
    material: "x", sizeThickness: "x", colorFinish: "x", mounting: "x",
  });
  assert.strictEqual(completenessScore([full], []), 100);
  const withRfis = completenessScore([full], [
    { field: "a", classification: "rfi", question: "?", assumption: "", impact: "high" },
    { field: "b", classification: "rfi", question: "?", assumption: "", impact: "high" },
  ]);
  assert.strictEqual(withRfis, 92, "each open RFI costs 4 points");
  assert.strictEqual(completenessScore([item({ itemName: "bare" })], []), 0);
}

// Section text assembly stays inside the requested page range.
{
  const pages = ["page zero", "page one", "page two", "page three"];
  const text = buildSectionText(pages, 1, 2);
  assert.ok(text.includes("page one") && text.includes("page two"));
  assert.ok(!text.includes("page zero") && !text.includes("page three"));
  assert.ok(text.includes("--- Page 2 ---"), "pages are labelled 1-based for the model");

  // Out-of-range requests clamp rather than throw.
  assert.ok(buildSectionText(pages, -5, 99).includes("page three"));
}

console.log("specDetailRules: all tests passed");
