import assert from "assert";
import {
  buildPendingDrafts, buildWorkload, countUnpulledInvites,
  daysBetween, parseEstimatorCodes, todayInZone, type EntryLike,
} from "./workload.js";

const NOW = new Date("2026-11-05T20:00:00Z"); // 12:00 noon in Los Angeles
const TODAY = "2026-11-05";

function entry(over: Partial<EntryLike>): EntryLike {
  return {
    id: 1, projectName: "P", owner: "Swinerton", region: "SD", primaryMarket: "Healthcare",
    dueDate: "2026-11-20", inviteDate: null, nbsEstimator: null, estimateStatus: "Estimating",
    isDraft: false, isTest: false, deletedAt: null, createdAt: new Date("2026-10-01T00:00:00Z"),
    draftApprovedAt: null, ndaRequired: false, regionNeedsReview: false, bcLink: null, sourceType: "bc",
    ...over,
  };
}

// --- small helpers
assert.deepStrictEqual(parseEstimatorCodes("ab, cd / ef"), ["AB", "CD", "EF"]);
assert.deepStrictEqual(parseEstimatorCodes(null), []);
assert.strictEqual(todayInZone(new Date("2026-11-06T02:00:00Z"), "America/Los_Angeles"), "2026-11-05"); // 6pm PT
assert.strictEqual(daysBetween(TODAY, "2026-11-08"), 3);
assert.strictEqual(daysBetween(TODAY, "2026-11-03"), -2);
assert.strictEqual(daysBetween(TODAY, ""), null);

// --- pending drafts: only real, undeleted, non-test drafts count
{
  const entries = [
    entry({ id: 1, isDraft: true, dueDate: "2026-11-12", createdAt: new Date("2026-11-04T20:00:00Z") }),
    entry({ id: 2, isDraft: true, dueDate: "2026-11-07", createdAt: new Date("2026-11-03T20:00:00Z") }),
    entry({ id: 3, isDraft: true, dueDate: null }),
    entry({ id: 4, isDraft: true, deletedAt: new Date() }),   // rejected
    entry({ id: 5, isDraft: true, isTest: true }),             // test data
    entry({ id: 6, isDraft: false }),                          // already approved
  ];
  const r = buildPendingDrafts(entries, TODAY, NOW, 8);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(r.items.map((i) => i.id), [2, 1, 3], "soonest due first, undated last");
  assert.strictEqual(r.items[0].waitingHours, 48);
  assert.strictEqual(r.oldestWaitingHours! >= 48, true);
  assert.strictEqual(buildPendingDrafts([], TODAY, NOW, 8).oldestWaitingHours, null);
  assert.strictEqual(buildPendingDrafts(entries, TODAY, NOW, 1).items.length, 1);
}

// --- workload
{
  const entries = [
    // AB: 3 active, one overdue, one due in 2 days
    entry({ id: 10, nbsEstimator: "AB", dueDate: "2026-11-01", region: "SD", primaryMarket: "Healthcare" }),
    entry({ id: 11, nbsEstimator: "AB", dueDate: "2026-11-07", region: "SD", primaryMarket: "Healthcare" }),
    entry({ id: 12, nbsEstimator: "AB", dueDate: "2026-12-15", region: "LA", primaryMarket: "Education", estimateStatus: "Revising" }),
    // CD: 1 active, new this week, shared bid with AB
    entry({ id: 13, nbsEstimator: "cd, AB", dueDate: "2026-11-30", draftApprovedAt: new Date("2026-11-04T00:00:00Z") }),
    // Not counted as active: won / closed, deleted, draft, test
    entry({ id: 14, nbsEstimator: "CD", estimateStatus: "Won" }),
    entry({ id: 15, nbsEstimator: "CD", deletedAt: new Date() }),
    entry({ id: 16, nbsEstimator: "CD", isDraft: true }),
    entry({ id: 17, nbsEstimator: "CD", isTest: true }),
    // Old closed bid: outside roster window, not active -> ignored
    entry({ id: 18, nbsEstimator: "ZZ", estimateStatus: "Lost", createdAt: new Date("2025-01-01T00:00:00Z") }),
    // Active bid with no estimator is not anyone's workload
    entry({ id: 19, nbsEstimator: "" }),
  ];
  const users = [
    { displayName: "Alice B", email: "a@x.com", initials: "AB", isActive: true },
    { displayName: "Carl D", email: "c@x.com", initials: "CD", isActive: true },
    { displayName: "Eve F", email: "e@x.com", initials: "EF", isActive: true },    // no bids -> lightest
    { displayName: "Gone G", email: "g@x.com", initials: "GG", isActive: false },  // inactive -> hidden
  ];
  const rows = buildWorkload(entries, users, TODAY, NOW);
  const by = Object.fromEntries(rows.map((r) => [r.code, r]));

  assert.strictEqual(by.AB.active, 4);
  assert.strictEqual(by.AB.overdue, 1);
  assert.strictEqual(by.AB.dueWithin3Days, 1);
  assert.strictEqual(by.AB.dueWithin7Days, 1);
  assert.strictEqual(by.AB.nextDueDate, "2026-11-07");
  assert.strictEqual(by.AB.name, "Alice B");
  assert.strictEqual(by.AB.loadScore, 4 + 2 * 1 + 2 * 1);
  assert.deepStrictEqual(by.AB.topRegions[0], "SD");
  assert.deepStrictEqual(by.AB.topMarkets[0], "Healthcare");

  assert.strictEqual(by.CD.active, 1, "won / deleted / draft / test bids are not workload");
  assert.strictEqual(by.CD.newLast7Days >= 1, true);

  assert.strictEqual(by.EF.active, 0, "a user with no bids still appears");
  assert.strictEqual(rows[0].code, "EF", "lightest load sorts first");
  assert.strictEqual(rows[0].lightest, true);
  assert.strictEqual(rows.filter((r) => r.lightest).length, 1);

  assert.strictEqual(by.GG, undefined, "inactive users hidden");
  assert.strictEqual(by.ZZ, undefined, "old closed bids don't create roster entries");
}

// --- waiting in BC
{
  const logged = new Set(["a", "b"]);
  assert.strictEqual(countUnpulledInvites([{ id: "a" }, { id: "c" }, { id: "c" }, { id: "d" }], logged), 2);
  assert.strictEqual(countUnpulledInvites([], logged), 0);
}

console.log("workload.test.ts: all assertions passed");
