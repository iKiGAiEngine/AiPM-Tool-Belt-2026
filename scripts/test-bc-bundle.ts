// Tests for the "same project, different scope" bundling rules.
// Run:  DATABASE_URL=postgres://unused npx tsx scripts/test-bc-bundle.ts
// (the rules never touch the database; the URL only satisfies an import)
import assert from "node:assert/strict";
import { groupSameProject, planBundle, validateBundle, checkDuplicateOf, parseJsonArray, type EntryLike } from "../server/autodesk/bcBundle";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };

const e = (id: number, scope: string, o: Partial<EntryLike> = {}): EntryLike => ({
  id, projectName: "Pico & Beverwil Redevelopment", projectAddress: "9600 West Pico Boulevard, Los Angeles, CA 90035",
  scopeList: JSON.stringify([scope]), bcOpportunityIds: JSON.stringify([`opp${id}`]), isDraft: true, deletedAt: null,
  pendingDeletion: false, isTest: false, dueDate: "2026-11-25", region: "", ...o,
});

const pico = [e(2022, "Loading Dock Equipment"), e(2023, "Specialties", { region: "LAX - SPD" })];

t("same project name + different scope is grouped as 'same'", () => {
  const g = groupSameProject(pico);
  assert.equal(g.length, 1);
  assert.equal(g[0].strength, "same");
  assert.deepEqual(g[0].draftIds, [2022, 2023]);
  assert.deepEqual(g[0].repeatDraftIds, []); // different scopes are NOT repeats
});

t("primary prefers the draft that already has a region", () => {
  assert.equal(groupSameProject(pico)[0].suggestedPrimaryId, 2023);
});

t("an already-approved live entry is always the primary", () => {
  const g = groupSameProject([e(10, "Lockers", { isDraft: false, estimateNumber: "26-0100" }), e(11, "Specialties")]);
  assert.equal(g[0].suggestedPrimaryId, 10);
});

t("different projects are not grouped", () => {
  assert.equal(groupSameProject([e(1, "A"), e(2, "B", { projectName: "Completely Different Hospital" })]).length, 0);
});

t("same name but a DIFFERENT address is only 'related'", () => {
  const g = groupSameProject([e(1, "A"), e(2, "B", { projectAddress: "1 Other Street, Tulsa, OK" })]);
  assert.equal(g[0].strength, "related");
});

t("a blank address does not block a 'same' match", () => {
  assert.equal(groupSameProject([e(1, "A"), e(2, "B", { projectAddress: "" })])[0].strength, "same");
});

t("deleted, pending-deletion and test entries are ignored", () => {
  assert.equal(groupSameProject([e(1, "A"), e(2, "B", { deletedAt: new Date() })]).length, 0);
  assert.equal(groupSameProject([e(1, "A"), e(2, "B", { pendingDeletion: true })]).length, 0);
  assert.equal(groupSameProject([e(1, "A"), e(2, "B", { isTest: true })]).length, 0);
});

t("two approved entries are never grouped", () => {
  assert.equal(groupSameProject([e(1, "A", { isDraft: false }), e(2, "B", { isDraft: false })]).length, 0);
});

t("a draft whose scope is already covered is flagged as a repeat", () => {
  const g = groupSameProject([e(1, "Specialties"), e(2, "specialties ")]);
  assert.deepEqual(g[0].repeatDraftIds.sort(), [1, 2]);
});

t("plan keeps every scope and every BC ID, no duplicates", () => {
  const p = planBundle(pico[1], [pico[0]]);
  assert.deepEqual(p.scopes, ["Specialties", "Loading Dock Equipment"]);
  assert.deepEqual(p.bcOpportunityIds, ["opp2023", "opp2022"]);
  assert.deepEqual(p.addedScopes, ["Loading Dock Equipment"]);
  const again = planBundle(pico[1], [e(9, " specialties")]);
  assert.deepEqual(again.scopes, ["Specialties"]);
});

t("plan keeps the earliest due date and says so", () => {
  const p = planBundle(e(1, "A", { dueDate: "2026-12-01" }), [e(2, "B", { dueDate: "2026-11-25" })]);
  assert.equal(p.dueDate, "2026-11-25");
  assert.ok(p.notes.some((x) => x.includes("earliest")));
});

t("plan fills blanks but never overwrites filled fields", () => {
  const p = planBundle(e(1, "A", { region: "" }), [e(2, "B", { region: "LAX - SPD" })]);
  assert.equal(p.fillFields.region, "LAX - SPD");
  const q = planBundle(e(1, "A", { region: "SD" }), [e(2, "B", { region: "LAX - SPD" })]);
  assert.equal(q.fillFields.region, undefined);
  assert.ok(q.notes.some((x) => x.includes("Regions differed")));
});

t("validate: rejects self, empty, deleted, approved sources, unrelated, oversize", () => {
  const all = [...pico, e(5, "X", { projectName: "Other Project Name Entirely" }), e(6, "Y", { deletedAt: new Date() }),
               e(7, "Z", { isDraft: false })];
  assert.equal(validateBundle(2023, [2022], all).ok, true);
  assert.equal(validateBundle(2023, [2023], all).ok, false);
  assert.equal(validateBundle(2023, [], all).ok, false);
  assert.equal(validateBundle(2023, [5], all).ok, false);   // unrelated project
  assert.equal(validateBundle(2023, [6], all).ok, false);   // deleted
  assert.equal(validateBundle(2023, [7], all).ok, false);   // approved can't be absorbed
  assert.equal(validateBundle(2023, [999], all).ok, false); // missing
  assert.equal(validateBundle(999, [2022], all).ok, false);
  assert.equal(validateBundle(2023, [2022, 2022], all).ok, false);
  assert.equal(validateBundle(2023, Array.from({ length: 11 }, (_, i) => i + 100), all).ok, false);
});

t("validate: a pending draft can be combined INTO an approved entry, not the reverse", () => {
  const all = [e(10, "Lockers", { isDraft: false }), e(11, "Specialties")];
  assert.equal(validateBundle(10, [11], all).ok, true);
  assert.equal(validateBundle(11, [10], all).ok, false);
});

t("duplicate removal is refused when it would lose a scope (the Pico incident)", () => {
  const r = checkDuplicateOf(pico[0], pico[1]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.message.includes("Loading Dock Equipment"));
});

t("duplicate removal is allowed only for a covered scope on a live, related survivor", () => {
  assert.equal(checkDuplicateOf(e(1, "Specialties"), e(2, "Specialties")).ok, true);
  assert.equal(checkDuplicateOf(e(1, "Specialties"), undefined).ok, false);
  assert.equal(checkDuplicateOf(e(1, "Specialties"), e(1, "Specialties")).ok, false);
  assert.equal(checkDuplicateOf(e(1, "Specialties"), e(2, "Specialties", { deletedAt: new Date() })).ok, false);
  assert.equal(checkDuplicateOf(e(1, "Specialties"), e(2, "Specialties", { projectName: "Unrelated Thing Here" })).ok, false);
});

t("bad JSON in scope/ID columns does not crash", () => {
  assert.deepEqual(parseJsonArray("not json"), []);
  assert.deepEqual(parseJsonArray(null), []);
});

console.log(`\n${n} tests passed`);
