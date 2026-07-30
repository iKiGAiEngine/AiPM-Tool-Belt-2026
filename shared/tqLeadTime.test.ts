import assert from "assert";
import {
  parseIsoDate,
  toIsoDate,
  businessDaysBetween,
  tqLeadBusinessDays,
  leadBucket,
  isCrunch,
  todayInBusinessTz,
} from "./tqLeadTime.js";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// ── parseIsoDate ──────────────────────────────────────────────────────────────

test("parses a well-formed date into local midnight", () => {
  const d = parseIsoDate("2026-07-01")!;
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 6);
  assert.strictEqual(d.getDate(), 1);
  assert.strictEqual(d.getHours(), 0);
});

test("no timezone drift — the calendar day survives parsing regardless of host TZ", () => {
  // The whole reason we don't use `new Date('2026-07-01')`: that parses as UTC
  // and lands on Jun 30 for anyone west of Greenwich, shifting every lead time.
  const d = parseIsoDate("2026-07-01")!;
  assert.strictEqual(toIsoDate(d), "2026-07-01");
  assert.strictEqual(toIsoDate(parseIsoDate("2026-01-01")!), "2026-01-01");
  assert.strictEqual(toIsoDate(parseIsoDate("2026-12-31")!), "2026-12-31");
});

test("returns null for empty, malformed, and impossible dates", () => {
  for (const bad of [null, undefined, "", "   ", "not-a-date", "2026-7-1", "07/01/2026", "2026-13-01", "2026-02-30"]) {
    assert.strictEqual(parseIsoDate(bad as any), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("tolerates surrounding whitespace", () => {
  assert.strictEqual(toIsoDate(parseIsoDate("  2026-07-01  ")!), "2026-07-01");
});

// ── businessDaysBetween ───────────────────────────────────────────────────────

const d = (s: string) => parseIsoDate(s)!;

test("counts weekdays within a single week", () => {
  // Mon 2026-06-01 → Fri 2026-06-05
  assert.strictEqual(businessDaysBetween(d("2026-06-01"), d("2026-06-05")), 4);
});

test("same day is zero", () => {
  assert.strictEqual(businessDaysBetween(d("2026-06-03"), d("2026-06-03")), 0);
});

test("excludes the weekend when spanning one", () => {
  // Fri 2026-06-05 → Mon 2026-06-08 is 1 business day, not 3.
  assert.strictEqual(businessDaysBetween(d("2026-06-05"), d("2026-06-08")), 1);
  // Mon → Mon across a full week = 5 business days, not 7.
  assert.strictEqual(businessDaysBetween(d("2026-06-01"), d("2026-06-08")), 5);
});

test("weekend-to-weekend spans collapse correctly", () => {
  // Sat 2026-06-06 → Sun 2026-06-07: no weekdays in between.
  assert.strictEqual(businessDaysBetween(d("2026-06-06"), d("2026-06-07")), 0);
});

test("is signed — a backwards span is negative and symmetric", () => {
  assert.strictEqual(businessDaysBetween(d("2026-06-05"), d("2026-06-01")), -4);
  assert.strictEqual(
    businessDaysBetween(d("2026-06-05"), d("2026-06-01")),
    -businessDaysBetween(d("2026-06-01"), d("2026-06-05")),
  );
});

test("spans a month and a year boundary", () => {
  // Mon 2025-12-29 → Mon 2026-01-05: 5 business days (Jan 1 counted, no holidays modeled).
  assert.strictEqual(businessDaysBetween(d("2025-12-29"), d("2026-01-05")), 5);
});

test("agrees with the Proposal Log dashboard's bizDaysUntil()", () => {
  // Verbatim copy of bizDaysUntil() from public/tools/proposal-log.html:3290,
  // reparameterized on "today". If the report and the dashboard ever disagree,
  // this test is what catches it.
  function bizDaysUntil(todayStr: string, dateStr: string) {
    const today = new Date(todayStr + "T00:00:00");
    const target = new Date(dateStr + "T00:00:00");
    const start = new Date(today);
    if (target < start) {
      let count = 0;
      const cur = new Date(target);
      while (cur < start) {
        cur.setDate(cur.getDate() + 1);
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) count++;
      }
      return -count;
    }
    let count = 0;
    const cur = new Date(start);
    while (cur < target) {
      cur.setDate(cur.getDate() + 1);
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return count;
  }

  const fixtures: Array<[string, string]> = [
    ["2026-06-01", "2026-06-05"],
    ["2026-06-05", "2026-06-08"],
    ["2026-06-03", "2026-06-03"],
    ["2026-06-08", "2026-06-01"],
    ["2025-12-29", "2026-01-05"],
    ["2026-02-27", "2026-03-16"],
    ["2026-07-04", "2026-07-20"],
  ];
  for (const [from, to] of fixtures) {
    assert.strictEqual(
      businessDaysBetween(d(from), d(to)),
      bizDaysUntil(from, to),
      `mismatch for ${from} → ${to}`,
    );
  }
});

// ── tqLeadBusinessDays ────────────────────────────────────────────────────────

test("computes lead time from received date to due date", () => {
  assert.strictEqual(tqLeadBusinessDays("2026-06-01", "2026-06-15"), 10);
});

test("received on bid day is zero", () => {
  assert.strictEqual(tqLeadBusinessDays("2026-06-15", "2026-06-15"), 0);
});

test("received after bid day is negative", () => {
  assert.strictEqual(tqLeadBusinessDays("2026-06-17", "2026-06-15"), -2);
});

test("returns null — never NaN — when either date is missing or bad", () => {
  assert.strictEqual(tqLeadBusinessDays(null, "2026-06-15"), null);
  assert.strictEqual(tqLeadBusinessDays("2026-06-15", null), null);
  assert.strictEqual(tqLeadBusinessDays("", ""), null);
  assert.strictEqual(tqLeadBusinessDays("garbage", "2026-06-15"), null);
});

// ── leadBucket ────────────────────────────────────────────────────────────────

test("classifies every bucket boundary", () => {
  const cases: Array<[number, string]> = [
    [20, "ample"],
    [15, "ample"],
    [14, "comfortable"],
    [8, "comfortable"],
    [7, "tight"],
    [4, "tight"],
    [3, "crunch"],
    [1, "crunch"],
    [0, "bid_day"],
    [-1, "late"],
    [-30, "late"],
  ];
  for (const [days, expected] of cases) {
    assert.strictEqual(leadBucket(days, true), expected, `${days} BD should be ${expected}`);
  }
});

test("an unticked box is not_received regardless of any day count", () => {
  assert.strictEqual(leadBucket(null, false), "not_received");
  assert.strictEqual(leadBucket(12, false), "not_received");
});

test("received with no due date is unmeasurable, not zero", () => {
  assert.strictEqual(leadBucket(null, true), "unmeasurable");
});

test("isCrunch covers 0–3 business days only", () => {
  assert.strictEqual(isCrunch(0), true);
  assert.strictEqual(isCrunch(3), true);
  assert.strictEqual(isCrunch(4), false);
  assert.strictEqual(isCrunch(-1), false);
  assert.strictEqual(isCrunch(null), false);
});

// ── todayInBusinessTz ─────────────────────────────────────────────────────────

test("stamps today in the business timezone in storage format", () => {
  // 2026-07-01 03:00 UTC is still Jun 30 in Los Angeles — the point of the helper.
  assert.strictEqual(todayInBusinessTz(new Date("2026-07-01T03:00:00Z")), "2026-06-30");
  assert.strictEqual(todayInBusinessTz(new Date("2026-07-01T18:00:00Z")), "2026-07-01");
  assert.match(todayInBusinessTz(), /^\d{4}-\d{2}-\d{2}$/);
});

console.log(`tqLeadTime: ${passed} assertions passed`);
