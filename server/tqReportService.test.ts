import assert from "assert";
import {
  buildTqReport,
  computeMetrics,
  toDetailRow,
  buildTldr,
  buildWatchItems,
  periodLabel,
  reportToCsv,
  csvEscape,
  type TqRow,
} from "./tqReportService.js";

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

let nextId = 1;
function row(over: Partial<TqRow> = {}): TqRow {
  return {
    id: nextId++,
    projectName: "Test Project",
    estimateNumber: "26-0001",
    region: "LAX - TM",
    primaryMarket: "Healthcare",
    nbsEstimator: "HK",
    gcEstimateLead: "Acme GC",
    estimateStatus: "Submitted",
    dueDate: "2026-06-15",
    proposalTotal: "100000",
    swinertonProject: "N",
    tqReceivedDate: null,
    tqReceivedBy: null,
    ...over,
  };
}

// ── Derivation ────────────────────────────────────────────────────────────────

test("derives received / lead / bucket from the stored dates", () => {
  const r = toDetailRow(row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }));
  assert.strictEqual(r.received, true);
  assert.strictEqual(r.leadBusinessDays, 10);
  assert.strictEqual(r.bucket, "comfortable");
});

test("a null received date means not received", () => {
  const r = toDetailRow(row({ tqReceivedDate: null }));
  assert.strictEqual(r.received, false);
  assert.strictEqual(r.leadBusinessDays, null);
  assert.strictEqual(r.bucket, "not_received");
});

test("a whitespace-only received date is treated as not received", () => {
  assert.strictEqual(toDetailRow(row({ tqReceivedDate: "   " })).received, false);
});

// ── Metrics ───────────────────────────────────────────────────────────────────

test("coverage counts received over total", () => {
  const m = computeMetrics(
    [
      row({ tqReceivedDate: "2026-06-01" }),
      row({ tqReceivedDate: "2026-06-08" }),
      row({ tqReceivedDate: null }),
      row({ tqReceivedDate: null }),
    ].map(toDetailRow),
  );
  assert.strictEqual(m.bidCount, 4);
  assert.strictEqual(m.receivedCount, 2);
  assert.strictEqual(m.coveragePct, 50);
  assert.strictEqual(m.notReceivedCount, 2);
});

test("median of an odd-length set is the middle value", () => {
  // Leads: 10, 5, 0 business days → sorted 0, 5, 10 → median 5
  const m = computeMetrics(
    [
      row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), // 10
      row({ tqReceivedDate: "2026-06-08", dueDate: "2026-06-15" }), // 5
      row({ tqReceivedDate: "2026-06-15", dueDate: "2026-06-15" }), // 0
    ].map(toDetailRow),
  );
  assert.strictEqual(m.medianLeadBd, 5);
  assert.strictEqual(m.avgLeadBd, 5);
  assert.strictEqual(m.minLeadBd, 0);
});

test("median of an even-length set averages the middle pair", () => {
  // Leads: 0, 5, 10, 15 → median (5+10)/2 = 7.5
  const m = computeMetrics(
    [
      row({ tqReceivedDate: "2026-06-15", dueDate: "2026-06-15" }), // 0
      row({ tqReceivedDate: "2026-06-08", dueDate: "2026-06-15" }), // 5
      row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), // 10
      row({ tqReceivedDate: "2026-05-25", dueDate: "2026-06-15" }), // 15
    ].map(toDetailRow),
  );
  assert.strictEqual(m.medianLeadBd, 7.5);
  assert.strictEqual(m.avgLeadBd, 7.5);
});

test("a received bid with no due date counts toward coverage but not the median", () => {
  const m = computeMetrics(
    [
      row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), // 10
      row({ tqReceivedDate: "2026-06-01", dueDate: null }), // unmeasurable
    ].map(toDetailRow),
  );
  assert.strictEqual(m.bidCount, 2);
  assert.strictEqual(m.receivedCount, 2);
  assert.strictEqual(m.coveragePct, 100);
  assert.strictEqual(m.measurableCount, 1);
  assert.strictEqual(m.medianLeadBd, 10);
  assert.strictEqual(toDetailRow(row({ tqReceivedDate: "2026-06-01", dueDate: null })).bucket, "unmeasurable");
});

test("crunch and late are counted separately", () => {
  const m = computeMetrics(
    [
      row({ tqReceivedDate: "2026-06-12", dueDate: "2026-06-15" }), // 1 BD → crunch
      row({ tqReceivedDate: "2026-06-15", dueDate: "2026-06-15" }), // 0 BD → crunch (bid day)
      row({ tqReceivedDate: "2026-06-17", dueDate: "2026-06-15" }), // -2 BD → late
      row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), // 10 BD → neither
    ].map(toDetailRow),
  );
  assert.strictEqual(m.crunchCount, 2);
  assert.strictEqual(m.lateCount, 1);
});

test("p90 lands on a real observation", () => {
  const leads = ["2026-06-15", "2026-06-12", "2026-06-08", "2026-06-01", "2026-05-25"];
  const m = computeMetrics(leads.map((rd) => toDetailRow(row({ tqReceivedDate: rd, dueDate: "2026-06-15" }))));
  // Sorted leads: 0, 1, 5, 10, 15 → nearest-rank p90 of 5 items = index 4 = 15
  assert.strictEqual(m.p90LeadBd, 15);
});

test("an empty set yields zeroes and nulls, not NaN", () => {
  const m = computeMetrics([]);
  assert.strictEqual(m.bidCount, 0);
  assert.strictEqual(m.coveragePct, 0);
  assert.strictEqual(m.medianLeadBd, null);
  assert.strictEqual(m.avgLeadBd, null);
  assert.strictEqual(m.p90LeadBd, null);
});

// ── Grouping ──────────────────────────────────────────────────────────────────

test("groups by region, worst coverage first", () => {
  const rows = [
    row({ region: "LAX - TM", tqReceivedDate: "2026-06-01" }),
    row({ region: "LAX - TM", tqReceivedDate: "2026-06-01" }),
    row({ region: "SAN", tqReceivedDate: null }),
    row({ region: "SAN", tqReceivedDate: null }),
    row({ region: "SAN", tqReceivedDate: "2026-06-01" }),
  ];
  const report = buildTqReport(rows, { type: "by-region" });
  assert.strictEqual(report.groups.length, 2);
  assert.strictEqual(report.groups[0].label, "SAN");
  assert.strictEqual(report.groups[0].coveragePct, 33);
  assert.strictEqual(report.groups[1].label, "LAX - TM");
  assert.strictEqual(report.groups[1].coveragePct, 100);
});

test("blank grouping keys get an explicit placeholder label", () => {
  const report = buildTqReport([row({ region: null }), row({ region: "" })], { type: "by-region" });
  assert.strictEqual(report.groups.length, 1);
  assert.strictEqual(report.groups[0].label, "(no region)");
  assert.strictEqual(report.groups[0].bidCount, 2);
});

test("monthly trend groups by due month and sorts chronologically", () => {
  const rows = [
    row({ dueDate: "2026-07-10", tqReceivedDate: "2026-07-01" }),
    row({ dueDate: "2026-05-10", tqReceivedDate: "2026-05-01" }),
    row({ dueDate: "2026-06-10", tqReceivedDate: "2026-06-01" }),
  ];
  const report = buildTqReport(rows, { type: "by-month" });
  assert.deepStrictEqual(
    report.groups.map((g) => g.label),
    ["May 2026", "Jun 2026", "Jul 2026"],
  );
});

test("summary and grouped types carry no row payload; detail does", () => {
  const rows = [row({ tqReceivedDate: "2026-06-01" }), row({ tqReceivedDate: null })];
  assert.strictEqual(buildTqReport(rows, { type: "summary" }).rows.length, 0);
  assert.strictEqual(buildTqReport(rows, { type: "by-region" }).rows.length, 0);
  assert.strictEqual(buildTqReport(rows, { type: "detail" }).rows.length, 2);
});

test("exceptions keeps only problems and leaves the headline metrics on the full set", () => {
  const rows = [
    row({ tqReceivedDate: "2026-05-25", dueDate: "2026-06-15" }), // 15 BD — healthy
    row({ tqReceivedDate: "2026-06-12", dueDate: "2026-06-15" }), // 1 BD — crunch
    row({ tqReceivedDate: "2026-06-17", dueDate: "2026-06-15" }), // late
    row({ tqReceivedDate: null }), // never received
  ];
  const report = buildTqReport(rows, { type: "exceptions" });
  assert.strictEqual(report.rows.length, 3, "the healthy bid should be excluded");
  assert.strictEqual(report.overall.bidCount, 4, "metrics still describe the whole population");
  // Worst runway first: never-received, then late, then crunch.
  assert.deepStrictEqual(
    report.rows.map((r) => r.bucket),
    ["not_received", "late", "crunch"],
  );
});

// ── TL;DR narrative ───────────────────────────────────────────────────────────

test("renders the TL;DR exactly for a known fixture", () => {
  const rows = [
    row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), // 10 BD
    row({ tqReceivedDate: "2026-06-08", dueDate: "2026-06-15" }), // 5 BD
    row({ tqReceivedDate: "2026-06-12", dueDate: "2026-06-15" }), // 1 BD → crunch
    row({ tqReceivedDate: "2026-06-17", dueDate: "2026-06-15" }), // late
    row({ tqReceivedDate: null }), // never
  ];
  const m = computeMetrics(rows.map(toDetailRow));
  const text = buildTldr(m, periodLabel("2026-05-01", "2026-07-31"));
  assert.strictEqual(
    text,
    "Across 5 bids due May 1, 2026 – Jul 31, 2026, types & quantities were in hand on 4 (80%). " +
      "The typical bid got them 3 business days before bid day. " +
      "1 bid (20%) received T&Q inside 3 business days of the due date, and 1 arrived after bid day. " +
      "1 bid has no T&Q recorded at all (20%).",
  );
});

test("TL;DR handles the empty case", () => {
  assert.strictEqual(buildTldr(computeMetrics([]), "all recorded bids"), "No bids match these filters.");
  assert.strictEqual(buildTqReport([], { type: "summary" }).tldr, "No bids match these filters.");
});

test("TL;DR pluralizes a single bid and omits absent clauses", () => {
  const m = computeMetrics([toDetailRow(row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }))]);
  const text = buildTldr(m, periodLabel(null, null));
  assert.strictEqual(
    text,
    "Across all 1 recorded bid, types & quantities were in hand on 1 (100%). " +
      "The typical bid got them 10 business days before bid day.",
  );
});

test("TL;DR rephrases the scope when no date filter is applied", () => {
  // "Across N bids due all recorded bids" is not English — the unfiltered case
  // has to drop the "due" clause entirely.
  const rows = [row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), row({ tqReceivedDate: null })];
  const text = buildTqReport(rows, { type: "summary" }).tldr;
  assert.ok(text.startsWith("Across all 2 recorded bids, "), `unexpected opening: ${text}`);
  assert.ok(!text.includes("due all recorded bids"));
});

test("TL;DR reports lateness even when nothing was in the crunch window", () => {
  const m = computeMetrics([toDetailRow(row({ tqReceivedDate: "2026-06-17", dueDate: "2026-06-15" }))]);
  assert.ok(buildTldr(m, periodLabel(null, null)).includes("1 bid received T&Q after bid day."));
});

test("periodLabel covers both-ends, one-end, and no-filter cases", () => {
  assert.strictEqual(periodLabel("2026-05-01", "2026-07-31"), "May 1, 2026 – Jul 31, 2026");
  assert.strictEqual(periodLabel("2026-05-01", null), "May 1, 2026 onward");
  assert.strictEqual(periodLabel(null, "2026-07-31"), "through Jul 31, 2026");
  assert.strictEqual(periodLabel(null, null), "all recorded bids");
});

// ── Watch items ───────────────────────────────────────────────────────────────

test("flags live bids due soon with no T&Q — the actionable item", () => {
  const now = new Date(2026, 5, 1); // Mon Jun 1, 2026
  const rows = [
    row({ dueDate: "2026-06-08", tqReceivedDate: null }), // 5 BD out, nothing received
    row({ dueDate: "2026-06-09", tqReceivedDate: null }), // 6 BD out, nothing received
    row({ dueDate: "2026-09-01", tqReceivedDate: null }), // far out — not urgent
    row({ dueDate: "2026-06-08", tqReceivedDate: "2026-06-01" }), // already received
  ].map(toDetailRow);
  const items = buildWatchItems(rows, computeMetrics(rows), now);
  const due = items.find((i) => i.kind === "due_soon_no_tq");
  assert.ok(due, "expected a due_soon_no_tq item");
  assert.strictEqual(due!.text, "2 bids are due within 10 business days with no types & quantities recorded yet.");
});

test("names the weakest region once it has enough volume", () => {
  const now = new Date(2026, 5, 1);
  const rows = [
    ...Array.from({ length: 5 }, () => row({ region: "SAN", tqReceivedDate: null, dueDate: "2026-09-01" })),
    ...Array.from({ length: 5 }, () =>
      row({ region: "LAX - TM", tqReceivedDate: "2026-08-03", dueDate: "2026-09-01" }),
    ),
  ].map(toDetailRow);
  const items = buildWatchItems(rows, computeMetrics(rows), now);
  const worst = items.find((i) => i.kind === "worst_region");
  assert.ok(worst, "expected a worst_region item");
  assert.strictEqual(worst!.text, "SAN has the weakest coverage: T&Q recorded on 0 of 5 bids (0%).");
  assert.deepStrictEqual(worst!.filter, { region: "SAN" });
});

test("ignores low-volume regions so one bad bid can't headline the report", () => {
  const now = new Date(2026, 5, 1);
  const rows = [
    row({ region: "GEG", tqReceivedDate: null, dueDate: "2026-09-01" }), // only 1 bid
    ...Array.from({ length: 6 }, () =>
      row({ region: "LAX - TM", tqReceivedDate: "2026-08-03", dueDate: "2026-09-01" }),
    ),
  ].map(toDetailRow);
  const items = buildWatchItems(rows, computeMetrics(rows), now);
  assert.strictEqual(items.find((i) => i.kind === "worst_region"), undefined);
});

test("reports the coverage trend against the prior period", () => {
  const now = new Date(2026, 5, 1);
  const current = [
    row({ tqReceivedDate: "2026-08-03", dueDate: "2026-09-01" }),
    row({ tqReceivedDate: "2026-08-03", dueDate: "2026-09-01" }),
    row({ tqReceivedDate: "2026-08-03", dueDate: "2026-09-01" }),
    row({ tqReceivedDate: null, dueDate: "2026-09-01" }),
  ].map(toDetailRow);
  const prior = [
    row({ tqReceivedDate: "2026-05-01", dueDate: "2026-06-01" }),
    row({ tqReceivedDate: null, dueDate: "2026-06-01" }),
    row({ tqReceivedDate: null, dueDate: "2026-06-01" }),
    row({ tqReceivedDate: null, dueDate: "2026-06-01" }),
  ];
  const items = buildWatchItems(current, computeMetrics(current), now, prior);
  const trend = items.find((i) => i.kind === "trend");
  assert.ok(trend, "expected a trend item");
  assert.strictEqual(trend!.text, "Coverage improved 50 points versus the previous period (25% → 75%).");
});

test("watch items only ride along with the summary report", () => {
  const rows = [row({ dueDate: "2026-06-08", tqReceivedDate: null })];
  const now = new Date(2026, 5, 1);
  assert.ok(buildTqReport(rows, { type: "summary", now }).watchItems.length > 0);
  assert.strictEqual(buildTqReport(rows, { type: "detail", now }).watchItems.length, 0);
});

// ── Buckets ───────────────────────────────────────────────────────────────────

test("bucket distribution omits empty buckets and totals 100%", () => {
  const rows = [
    row({ tqReceivedDate: "2026-05-25", dueDate: "2026-06-15" }), // ample
    row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" }), // comfortable
    row({ tqReceivedDate: null }), // not received
    row({ tqReceivedDate: null }), // not received
  ];
  const report = buildTqReport(rows, { type: "summary" });
  assert.deepStrictEqual(
    report.buckets.map((b) => [b.bucket, b.count, b.pct]),
    [
      ["ample", 1, 25],
      ["comfortable", 1, 25],
      ["not_received", 2, 50],
    ],
  );
});

// ── CSV ───────────────────────────────────────────────────────────────────────

test("escapes commas, quotes, and newlines", () => {
  assert.strictEqual(csvEscape("plain"), "plain");
  assert.strictEqual(csvEscape("Smith, Jones & Co"), '"Smith, Jones & Co"');
  assert.strictEqual(csvEscape('The "Big" Build'), '"The ""Big"" Build"');
  assert.strictEqual(csvEscape("line1\nline2"), '"line1\nline2"');
  assert.strictEqual(csvEscape(null), "");
  assert.strictEqual(csvEscape(undefined), "");
  assert.strictEqual(csvEscape(0), "0");
});

test("detail CSV carries a header and one line per bid", () => {
  const report = buildTqReport(
    [row({ projectName: "Mercy, Phase 2", tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" })],
    { type: "detail" },
  );
  const lines = reportToCsv(report).split("\r\n");
  assert.ok(lines[0].startsWith("Project Name,Estimate #,Region"));
  assert.ok(lines[1].startsWith('"Mercy, Phase 2"'), "project name with a comma must be quoted");
  assert.ok(lines[1].includes("2026-06-01"));
  assert.strictEqual(lines.length, 2);
});

test("grouped CSV leads with the group label column", () => {
  const report = buildTqReport([row({ region: "SAN", tqReceivedDate: null })], { type: "by-region" });
  const lines = reportToCsv(report).split("\r\n");
  assert.ok(lines[0].startsWith("By Region,Bids,T&Q Received,Coverage %"));
  assert.ok(lines[1].startsWith("SAN,1,0,0"));
});

test("summary CSV includes the TL;DR and the headline metrics", () => {
  const report = buildTqReport([row({ tqReceivedDate: "2026-06-01", dueDate: "2026-06-15" })], {
    type: "summary",
    from: "2026-05-01",
    to: "2026-07-31",
  });
  const csv = reportToCsv(report);
  assert.ok(csv.includes("T&Q Lead Time — Executive Summary"));
  assert.ok(csv.includes("May 1, 2026 – Jul 31, 2026"));
  assert.ok(csv.includes("Coverage %,100"));
  assert.ok(csv.includes("Median lead (BD),10"));
});

console.log(`tqReportService: ${passed} assertions passed`);
