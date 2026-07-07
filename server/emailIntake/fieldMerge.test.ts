// Run: tsx server/emailIntake/fieldMerge.test.ts
import assert from "assert";
import { mergeWithProvenance } from "./intakeService";
import { cleanSubjectToProjectName, isPlatformSender } from "./fieldExtractor";

function run() {
  // ── cleanSubjectToProjectName ──
  assert.strictEqual(
    cleanSubjectToProjectName("FW: Invitation to Bid: Sunset Ridge Medical Office Building"),
    "Sunset Ridge Medical Office Building"
  );
  assert.strictEqual(
    cleanSubjectToProjectName("RE: FW: Bid Invitation - Cedar Flats Apartments Phase 2"),
    "Cedar Flats Apartments Phase 2"
  );
  assert.strictEqual(
    cleanSubjectToProjectName("Request for Proposal - Mesa Verde Elementary School Modernization"),
    "Mesa Verde Elementary School Modernization"
  );
  assert.strictEqual(cleanSubjectToProjectName("Plain Project Name"), "Plain Project Name");
  assert.strictEqual(cleanSubjectToProjectName(""), "");

  // ── isPlatformSender ──
  assert.strictEqual(isPlatformSender("notifications@buildingconnected.com"), true);
  assert.strictEqual(isPlatformSender("no-reply@procore.com"), true);
  assert.strictEqual(isPlatformSender("donotreply@somegc.com"), true);
  assert.strictEqual(isPlatformSender("rcastellanos@hprconstruction.com"), false);
  assert.strictEqual(isPlatformSender(""), false);

  // ── mergeWithProvenance: email-only ──
  const emailEntry = {
    projectName: "Sunset Ridge Medical Office Building",
    region: "",
    dueDate: "2026-08-14",
    inviteDate: "2026-07-07",
    gcEstimateLead: "Michael Torres",
    owner: "Swinerton Builders",
    projectAddress: "4800 Sunset Ridge Dr, Frisco, TX 75034",
    bcLink: "https://app.buildingconnected.com/opportunities/68b1c2d3e4f5a6b7c8d9e0f1",
    squareFeet: "",
    ndaRequired: false,
    notes: "",
  };
  const emailOnly = mergeWithProvenance(emailEntry, null, {});
  assert.strictEqual(emailOnly.merged.projectName, "Sunset Ridge Medical Office Building");
  assert.strictEqual(emailOnly.provenance.projectName, "email");
  assert.strictEqual(emailOnly.provenance.dueDate, "email");
  assert.strictEqual(emailOnly.provenance.region, undefined, "empty fields get no provenance");
  assert.strictEqual(emailOnly.provenance.squareFeet, undefined);

  // ── mergeWithProvenance: BC overrides non-empty, keeps email where BC empty ──
  const bcEntry = {
    projectName: "Sunset Ridge MOB", // BC's canonical name wins
    region: "DFW",
    primaryMarket: "Healthcare",
    dueDate: "2026-08-15", // BC due date wins over email
    inviteDate: "",
    anticipatedStart: "2026-11-02",
    anticipatedFinish: "",
    gcEstimateLead: "", // BC empty → email contact kept
    owner: "Swinerton Builders",
    bcLink: "https://app.buildingconnected.com/opportunities/68b1c2d3e4f5a6b7c8d9e0f1",
    bcProjectId: "77aa0000000000000000aa77",
    bcOpportunityIds: JSON.stringify(["68b1c2d3e4f5a6b7c8d9e0f1"]),
    scopeList: JSON.stringify(["Division 10 - Specialties"]),
    projectAddress: "4800 Sunset Ridge Drive, Frisco, TX 75034",
    squareFeet: "42000",
    ndaRequired: false,
    bcAccessStatus: null,
    notes: "",
    // keys that must NOT leak into the merge:
    regionNotConfident: true,
    isDraft: true,
    estimateStatus: "Draft",
    sourceType: "bc",
    isTest: false,
  };
  const { merged, provenance } = mergeWithProvenance(emailEntry, bcEntry, {});
  assert.strictEqual(merged.projectName, "Sunset Ridge MOB", "BC name overrides");
  assert.strictEqual(provenance.projectName, "bc");
  assert.strictEqual(merged.dueDate, "2026-08-15", "BC due date overrides");
  assert.strictEqual(provenance.dueDate, "bc");
  assert.strictEqual(merged.inviteDate, "2026-07-07", "email inviteDate kept when BC empty");
  assert.strictEqual(provenance.inviteDate, "email");
  assert.strictEqual(merged.gcEstimateLead, "Michael Torres", "email contact kept when BC empty");
  assert.strictEqual(provenance.gcEstimateLead, "email");
  assert.strictEqual(merged.region, "DFW");
  assert.strictEqual(provenance.region, "bc");
  assert.strictEqual(merged.squareFeet, "42000");
  assert.strictEqual(merged.sourceType, undefined, "sourceType does not leak from BC mapping");
  assert.strictEqual(merged.isDraft, undefined, "isDraft does not leak");
  assert.strictEqual((merged as any).regionNotConfident, undefined, "regionNotConfident does not leak");
  assert.strictEqual(merged.estimateStatus, undefined, "estimateStatus does not leak");

  // ── floor-backfilled provenance survives the merge ──
  const floorProv = mergeWithProvenance(
    { ...emailEntry, gcEstimateLead: "bids@genericgc.com" },
    null,
    { gcEstimateLead: "fallback" }
  );
  assert.strictEqual(floorProv.provenance.gcEstimateLead, "fallback");

  // ── NDA flag from BC is authoritative ──
  const ndaMerge = mergeWithProvenance(
    { ...emailEntry, ndaRequired: false, notes: "" },
    { ...bcEntry, ndaRequired: true, bcAccessStatus: "nda_required", notes: "NDA required. Some project details are hidden until NDA is accepted in BuildingConnected." },
    {}
  );
  assert.strictEqual(ndaMerge.merged.ndaRequired, true);
  assert.ok(ndaMerge.merged.notes.includes("NDA required"));

  console.log("All fieldMerge tests passed!");
}

run();
