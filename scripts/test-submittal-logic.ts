// Behavior spec for the Submittal Builder estimate parser, pagination and validation.
// Run: npx tsx scripts/test-submittal-logic.ts
//
// These checks encode the behavior the module MUST have for a PM to trust it.
// Checks that fail today are real defects — see docs/SUBMITTAL_BUILDER_AUDIT.md.

import * as XLSX from "xlsx";
import { parseEstimateWorkbook } from "../client/src/submittal-builder/estimateParser";
import { computePagination, LINES_PER_SCHEDULE_PAGE } from "../client/src/submittal-builder/pagination";
import { validateProject } from "../client/src/submittal-builder/validation";
import type { SubmittalProject, Scope, ScheduleLine } from "../client/src/submittal-builder/types";

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

function ok(label: string, condition: boolean, detail = "") {
  checks++;
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function workbookFile(sheets: Array<{ name: string; rows: unknown[][] }>, fileName = "estimate.xlsx"): File {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows as any[][]), s.name);
  }
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new File([buf], fileName, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function line(partial: Partial<ScheduleLine> = {}): ScheduleLine {
  return { id: "l" + Math.random(), callout: "TA-1", desc: "Paper Towel Dispenser", model: "B-262", qty: 4, lineStatus: "missing", sortOrder: 0, attachments: [], ...partial };
}

function scope(partial: Partial<Scope> = {}): Scope {
  return { id: "s1", tabName: "Toilet Accessories", csi: "10 28 00", specTitle: "Toilet Accessories", sortOrder: 0, scopeStatus: "in_progress", lines: [line()], coverLines: [{ id: "c1", spec: "10 28 00", desc: "Toilet Accessories", type: "Schedule", comment: "Page 2" }], ...partial };
}

function project(partial: Partial<SubmittalProject> = {}): SubmittalProject {
  return {
    id: "p1", proposalLogId: "1", projectName: "Riverside Medical Center", gc: "Swinerton Builders",
    attention: "", assignedPm: "HK", submittalStatus: "in_progress", completionPercent: 0,
    createdAt: 0, updatedAt: 0, lastOpenedAt: 0, lastActiveScopeId: null, lastActiveTab: "schedule",
    coverDate: "July 30, 2026", scopes: [scope()], ...partial,
  };
}

(async () => {
  // ---------------------------------------------------------------------------
  console.log("\n=== Header-row detection: real-world column spellings ===");
  // A scope tab that fails detection is dropped SILENTLY — the PM loses the scope
  // with no error, which is the most damaging possible failure mode.
  const HEADERS: Array<{ hdr: string[]; label: string }> = [
    { hdr: ["Item", "Description", "Model", "Qty"], label: "Description / Model / Qty" },
    { hdr: ["Item", "Item Description", "Model No.", "Qty"], label: "Item Description / Model No." },
    { hdr: ["Callout", "Product Description", "Model Number", "Quantity"], label: "Product Description / Model Number" },
    { hdr: ["Tag", "Desc", "Model", "Qty"], label: "Desc (abbreviated)" },
    { hdr: ["Mark", "Description of Work", "Catalog No.", "Qty"], label: "Description of Work / Catalog No." },
    { hdr: ["No.", "Item Description", "Manufacturer / Model", "Total Qty"], label: "Manufacturer / Model / Total Qty" },
    { hdr: ["Callout", "Description", "Model", "Qty", "Unit Price", "Total"], label: "with trailing price columns" },
  ];

  for (const { hdr, label } of HEADERS) {
    const f = workbookFile([{
      name: "Toilet Accessories",
      rows: [
        ["10 28 00", "Toilet Accessories"],
        [],
        hdr,
        ["TA-1", "Paper Towel Dispenser", "B-262", 24, 88.5, 2124],
        ["TA-2", "Grab Bar 36in", "B-6806x36", 40, 62.25, 2490],
      ],
    }]);
    const parsed = await parseEstimateWorkbook(f);
    ok(`header "${label}" is detected`, parsed.scopes.length === 1 && parsed.scopes[0].lines.length === 2,
      parsed.scopes.length === 0 ? "SCOPE SILENTLY DROPPED" : `${parsed.scopes[0].lines.length} lines`);
  }

  // ---------------------------------------------------------------------------
  console.log("\n=== Column mapping accuracy ===");
  const mapped = await parseEstimateWorkbook(workbookFile([{
    name: "Toilet Accessories",
    rows: [
      ["10 28 00", "Toilet Accessories"],
      [],
      ["Mark", "Item Description", "Model No.", "Qty", "Unit Cost", "Total"],
      ["TA-1", "Paper Towel Dispenser", "B-262", 24, 88.5, 2124],
    ],
  }]));
  const m0 = mapped.scopes[0]?.lines[0];
  check("callout read from a 'Mark' column", m0?.callout, "TA-1");
  check("description read from 'Item Description'", m0?.desc, "Paper Towel Dispenser");
  check("model read from 'Model No.'", m0?.model, "B-262");
  check("qty read from 'Qty', not the 'Total' price column", m0?.qty, 24);

  // ---------------------------------------------------------------------------
  console.log("\n=== Non-scope sheets must not become scopes ===");
  const mixed = await parseEstimateWorkbook(workbookFile([
    { name: "Summary Sheet", rows: [["PROJECT:", "Riverside Medical Center"], [], ["Scope", "Description", "Total"], ["Toilet Accessories", "Div 10 accessories", 51200]] },
    { name: "Toilet Accessories", rows: [["10 28 00", "Toilet Accessories"], [], ["Callout", "Description", "Model", "Qty"], ["TA-1", "Paper Towel Dispenser", "B-262", 24]] },
    { name: "Buyout", rows: [["Buyout log"], ["Vendor", "Description", "PO"], ["Bobrick", "Accessories package", "12345"]] },
    { name: "Bobrick Material Pricing 2025", rows: [["Model", "Description", "List"], ["B-262", "Towel Dispenser", 120]] },
    { name: "Proposal", rows: [["Description", "Amount"], ["Division 10 Scope", 156200]] },
    { name: "PO Review", rows: [["Description", "Status"], ["Lockers PO", "Open"]] },
  ]));
  check("only real scope tabs are imported", mixed.scopes.map((s) => s.tab), ["Toilet Accessories"]);

  // ---------------------------------------------------------------------------
  console.log("\n=== Subtotal / footer rows must not become line items ===");
  const withFooters = await parseEstimateWorkbook(workbookFile([{
    name: "Toilet Accessories",
    rows: [
      ["10 28 00", "Toilet Accessories"],
      [],
      ["Callout", "Description", "Model", "Qty"],
      ["TA-1", "Paper Towel Dispenser", "B-262", 24],
      ["TA-2", "Grab Bar 36in", "B-6806x36", 40],
      [],
      ["", "MATERIAL SUBTOTAL", "", ""],
      ["", "FREIGHT", "", ""],
      ["", "SALES TAX", "", ""],
      ["", "GRAND TOTAL", "", ""],
    ],
  }]));
  check("footer rows excluded", withFooters.scopes[0]?.lines.map((l) => l.callout), ["TA-1", "TA-2"]);

  // ---------------------------------------------------------------------------
  console.log("\n=== CSI + spec title resolution ===");
  const csiCase = await parseEstimateWorkbook(workbookFile([{
    name: "Lockers",
    rows: [["Callout", "Description", "Model", "Qty"], ["L-1", "Single Tier Metal Locker", "PENCO-VAN", 6]],
  }]));
  ok("CSI is resolved from the tab name when the sheet has no CSI cell",
    csiCase.scopes[0]?.csi !== "", `csi=${JSON.stringify(csiCase.scopes[0]?.csi)}`);
  ok("spec title is resolved rather than left blank",
    !!csiCase.scopes[0]?.specTitle, `specTitle=${JSON.stringify(csiCase.scopes[0]?.specTitle)}`);

  // ---------------------------------------------------------------------------
  console.log("\n=== Parser reports what it skipped ===");
  const empty = await parseEstimateWorkbook(workbookFile([
    { name: "Notes", rows: [["Some notes"], ["nothing tabular here"]] },
  ]));
  check("a workbook with no scopes yields zero scopes", empty.scopes.length, 0);
  ok("parser reports skipped sheets so the PM knows why nothing imported",
    Array.isArray((empty as any).skipped), `skipped=${JSON.stringify((empty as any).skipped)}`);

  // ---------------------------------------------------------------------------
  console.log("\n=== Pagination uses real attachment page counts ===");
  const pgScope = scope({
    lines: [
      line({ id: "a", callout: "TA-1", attachments: [{ id: "att1", fileName: "b-262.pdf", pageCount: 5, calloutStamp: "TA-1", matchStatus: "exact", sortOrder: 0 }] }),
      line({ id: "b", callout: "TA-2", attachments: [{ id: "att2", fileName: "b-6806.pdf", pageCount: 1, calloutStamp: "TA-2", matchStatus: "exact", sortOrder: 0 }] }),
    ],
  });
  const pi = computePagination(pgScope);
  check("cover is page 1", pi.cover, 1);
  check("schedule occupies page 2 for a 2-line scope", [pi.scheduleStart, pi.scheduleEnd], [2, 2]);
  check("first attachment starts at page 3 and spans its real 5 pages", [pi.attachments[0].startPage, pi.attachments[0].endPage], [3, 7]);
  check("second attachment follows at page 8", [pi.attachments[1].startPage, pi.attachments[1].endPage], [8, 8]);
  check("total pages = cover + schedule + attachment pages", pi.total, 8);

  const bigScope = scope({ lines: Array.from({ length: LINES_PER_SCHEDULE_PAGE + 1 }, (_, i) => line({ id: "x" + i, callout: "TA-" + i })) });
  check(`${LINES_PER_SCHEDULE_PAGE + 1} lines spill onto a second schedule page`, computePagination(bigScope).schedulePages, 2);

  // ---------------------------------------------------------------------------
  console.log("\n=== Validation: legitimately-resolved lines are not 'missing' ===");
  const resolved = project({
    scopes: [scope({
      lines: [
        line({ id: "a", callout: "TA-1", lineStatus: "attached", attachments: [{ id: "att1", fileName: "b-262.pdf", pageCount: 2, calloutStamp: "TA-1", matchStatus: "exact", sortOrder: 0 }] }),
        line({ id: "b", callout: "TA-2", lineStatus: "by_others" }),
        line({ id: "c", callout: "TA-3", lineStatus: "not_required" }),
      ],
    })],
  });
  const rv = validateProject(resolved);
  check("no lines reported missing when every line is resolved", rv.summary.missing, 0);
  ok("no 'Missing product data' warnings on a resolved package",
    !rv.warnings.some((w) => w.msg.includes("Missing product data")),
    `${rv.warnings.filter((w) => w.msg.includes("Missing product data")).length} such warnings`);

  console.log("\n=== Validation: noise control on a large package ===");
  const big = project({
    scopes: [scope({ lines: Array.from({ length: 60 }, (_, i) => line({ id: "n" + i, callout: "TA-" + i, model: "", qty: 0 })) })],
  });
  const bv = validateProject(big);
  ok("a 60-line unattached scope does not emit 60+ separate warnings",
    bv.warnings.length <= 12, `${bv.warnings.length} warnings emitted`);
  ok("blank callout is not treated as a hard error (common in real estimates)",
    bv.errors.every((e) => !e.msg.includes("Blank callout")), `${bv.errors.length} errors`);

  console.log("\n=== Validation: resilience against legacy / partial data ===");
  let crashed = "";
  try {
    validateProject({ ...project(), scopes: [{ ...scope(), lines: undefined as any }] });
  } catch (e) {
    crashed = (e as Error).message;
  }
  ok("a scope with no lines array does not crash validation", crashed === "", crashed);

  console.log("\n=== Validation: page projection matches per-scope pagination ===");
  const twoScopes = project({
    scopes: [
      scope({ id: "s1", tabName: "Toilet Accessories", lines: [line({ id: "a", attachments: [{ id: "att1", fileName: "a.pdf", pageCount: 3, calloutStamp: "TA-1", matchStatus: "exact", sortOrder: 0 }] })] }),
      scope({ id: "s2", tabName: "Lockers", lines: [line({ id: "b", attachments: [{ id: "att2", fileName: "b.pdf", pageCount: 2, calloutStamp: "L-1", matchStatus: "exact", sortOrder: 0 }] })] }),
    ],
  });
  const perScopeTotal = twoScopes.scopes.reduce((a, s) => a + computePagination(s).total, 0);
  check("projected pages agrees with the sum of per-scope pagination", validateProject(twoScopes).summary.projectedPages, perScopeTotal);

  // ---------------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} of ${checks} checks FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
