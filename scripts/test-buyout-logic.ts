// Unit checks for the Buyout Bot derived logic (shared by UI + export).
// Run: npx tsx scripts/test-buyout-logic.ts

import {
  type BuyoutScope, type BuyoutBoard,
  combinedAwardedTotal, awardedVariance, coverageReport, computeReleaseBy,
  clockUrgency, isQuoteStale, canAward, boardTotals, isBoardComplete,
} from "../shared/buyout/types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

const isoInDays = (d: number) => {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + d);
  return t.toISOString().slice(0, 10);
};

function scope(partial: Partial<BuyoutScope>): BuyoutScope {
  return {
    id: "s1", name: "Toilet Accessories", status: "not_started",
    budget: { material: 0, freight: 0, labor: 0, total: 1000, grand: 1300 },
    items: [{ id: "a", specNo: "", callout: "", description: "", model: "", qty: 1, material: 0, freight: 0, labor: 0, total: 0, isAllowance: false },
            { id: "b", specNo: "", callout: "", description: "", model: "", qty: 1, material: 0, freight: 0, labor: 0, total: 0, isAllowance: false },
            { id: "c", specNo: "", callout: "", description: "", model: "", qty: 1, material: 0, freight: 0, labor: 0, total: 0, isAllowance: false }],
    quotes: [], awardedVendorIds: [], rosDate: null, submittalWeeks: 3, ...partial,
  };
}
const mkQuote = (vendorId: string, amount: number, covered: string[] | null, extra: any = {}) => ({
  id: "q" + vendorId, vendorId, vendorName: "V" + vendorId, quoteAmount: amount, note: "",
  coveredLineIds: covered, leadTimeWeeks: 0, quoteDate: null, validityDays: 45, attachments: [],
  aiSuggested: false, verified: true, ...extra,
});

console.log("\n=== Coverage (split award) ===");
const split = scope({
  quotes: [mkQuote("1", 600, ["a", "b"]), mkQuote("2", 300, ["c"])],
  awardedVendorIds: ["1", "2"],
});
check("combined awarded total", combinedAwardedTotal(split), 900);
check("variance (900-1000)", awardedVariance(split), -100);
check("all covered, none double", coverageReport(split), { uncovered: [], doubleCovered: [], allCovered: true });

console.log("\n=== Coverage (gap + overlap) ===");
const gap = scope({ quotes: [mkQuote("1", 500, ["a", "b"]), mkQuote("2", 400, ["a"])], awardedVendorIds: ["1", "2"] });
check("c uncovered, a double", coverageReport(gap), { uncovered: ["c"], doubleCovered: ["a"], allCovered: false });

console.log("\n=== Full-scope award (null coveredLineIds) ===");
const full = scope({ quotes: [mkQuote("1", 950, null)], awardedVendorIds: ["1"] });
check("all covered via null", coverageReport(full).allCovered, true);

console.log("\n=== Clock urgency ===");
const red = scope({ rosDate: isoInDays(30), submittalWeeks: 3, quotes: [mkQuote("1", 1, null, { leadTimeWeeks: 1 })], awardedVendorIds: ["1"] });
check("red (release ~+2d)", clockUrgency(red), "red");
const amber = scope({ rosDate: isoInDays(60), submittalWeeks: 3, quotes: [mkQuote("1", 1, null, { leadTimeWeeks: 2 })], awardedVendorIds: ["1"] });
check("amber (release ~+25d)", clockUrgency(amber), "amber");
const normal = scope({ rosDate: isoInDays(120), submittalWeeks: 3, quotes: [mkQuote("1", 1, null, { leadTimeWeeks: 2 })], awardedVendorIds: ["1"] });
check("normal (release ~+85d)", clockUrgency(normal), "normal");
check("no ROS -> null", clockUrgency(scope({})), null);
check("release uses max lead among awarded", computeReleaseBy(red)?.leadWeeks, 1);

console.log("\n=== Stale quote ===");
check("60d old, 45 validity -> stale", isQuoteStale(mkQuote("1", 100, null, { quoteDate: isoInDays(-60) }) as any), true);
check("today, 45 validity -> fresh", isQuoteStale(mkQuote("1", 100, null, { quoteDate: isoInDays(0) }) as any), false);
check("no date -> not stale", isQuoteStale(mkQuote("1", 100, null) as any), false);

console.log("\n=== Verify gating ===");
check("verified -> awardable", canAward(mkQuote("1", 100, null, { verified: true }) as any), true);
check("AI unverified -> NOT awardable", canAward(mkQuote("1", 100, null, { verified: false, aiSuggested: true }) as any), false);

console.log("\n=== Board totals + completion ===");
const board: BuyoutBoard = {
  version: 1,
  scopes: [
    scope({ id: "s1", budget: { material: 0, freight: 0, labor: 0, total: 1000, grand: 0 }, quotes: [mkQuote("1", 900, null)], awardedVendorIds: ["1"], status: "po" }),
    scope({ id: "s2", budget: { material: 0, freight: 0, labor: 0, total: 500, grand: 0 }, quotes: [], awardedVendorIds: [], status: "not_started" }),
  ],
};
const t = boardTotals(board);
check("budgetTotal (all scopes)", t.budgetTotal, 1500);
check("awardedTotal", t.awardedTotal, 900);
check("awardedBudget (awarded scopes only)", t.awardedBudget, 1000);
check("variance (900-1000)", t.variance, -100);
check("savings (1000-900)", t.savings, 100);
check("boughtOut", t.boughtOut, 1);
check("not complete (s2 pending)", isBoardComplete(board), false);
board.scopes[1].status = "po";
board.scopes[1].awardedVendorIds = ["9"];
board.scopes[1].quotes = [mkQuote("9", 450, null)];
check("complete when all PO", isBoardComplete(board), true);

console.log(`\n${failures === 0 ? "✅ ALL LOGIC CHECKS PASSED" : `❌ ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
