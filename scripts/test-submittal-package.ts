// Smoke test for submittal package PDF generation.
// Run: npx tsx scripts/test-submittal-package.ts
//
// Verifies the generated package is a real, readable PDF whose page count
// matches what the cover page claims — the cover's page references are only
// worth anything if the document actually has those pages.

import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildScopePackage, readPageCount, packageFileName, type AttachmentBytes } from "../server/submittal/packageBuilder";
import { computePagination } from "../shared/submittal/pagination";
import type { Scope, SubmittalProject, ScheduleLine } from "../shared/submittal/types";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}
function ok(label: string, condition: boolean, detail = "") {
  if (!condition) failures++;
  console.log(`${condition ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A stand-in vendor product data sheet with a known page count. */
async function fakeProductData(pages: number, label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${label} — sheet ${i + 1} of ${pages}`, { x: 60, y: 700, size: 14, font });
  }
  return Buffer.from(await doc.save());
}

function line(partial: Partial<ScheduleLine>): ScheduleLine {
  return { id: "l", callout: "TA-1", desc: "Paper Towel Dispenser", model: "B-262", qty: 24, lineStatus: "missing", sortOrder: 0, attachments: [], ...partial };
}

(async () => {
  const towel = await fakeProductData(4, "Bobrick B-262");
  const grabBar = await fakeProductData(1, "Bobrick B-6806");

  console.log("=== Page counts are read from the real PDF ===");
  check("a 4-page vendor sheet reports 4 pages", await readPageCount(towel), 4);
  check("a 1-page vendor sheet reports 1 page", await readPageCount(grabBar), 1);
  check("an unreadable file falls back to 1 rather than throwing", await readPageCount(Buffer.from("not a pdf")), 1);

  const scope: Scope = {
    id: "s1", tabName: "Toilet Accessories", csi: "10 28 00", specTitle: "Toilet Accessories",
    sortOrder: 0, scopeStatus: "in_progress",
    coverLines: [
      { id: "c1", type: "Schedule", comment: "Page 2" },
      { id: "c2", type: "Product Data", comment: "Pages 3-7" },
    ],
    lines: [
      line({ id: "a", callout: "TA-1", attachments: [{ id: "att-1", fileName: "b-262.pdf", pageCount: 4, calloutStamp: "TA-1", matchStatus: "exact", sortOrder: 0 }] }),
      line({ id: "b", callout: "TA-2", desc: "Grab Bar 36in Peened", model: "B-6806x36", qty: 40, attachments: [{ id: "att-2", fileName: "b-6806.pdf", pageCount: 1, calloutStamp: "TA-2", matchStatus: "exact", sortOrder: 0 }] }),
      line({ id: "c", callout: "TA-3", desc: "Mirror 18x36 Channel Frame", model: "B-165 1836", qty: 18, lineStatus: "by_others" }),
    ],
  };

  const project: SubmittalProject = {
    id: "1", proposalLogId: "22", projectName: "Riverside Medical Center — Phase 2",
    gc: "Swinerton Builders", attention: "Dana Reyes", assignedPm: "HK",
    coverDate: "July 30, 2026", submittalStatus: "ready_for_export", completionPercent: 100,
    createdAt: 0, updatedAt: 0, lastActiveScopeId: "s1", lastActiveTab: "preview", scopes: [scope],
  };

  const attachments: AttachmentBytes[] = [
    { attachmentId: "att-1", fileName: "b-262.pdf", data: towel },
    { attachmentId: "att-2", fileName: "b-6806.pdf", data: grabBar },
  ];

  console.log("\n=== The generated package is a real PDF ===");
  const built = await buildScopePackage(project, scope, attachments);
  ok("output starts with the PDF magic number", built.bytes.subarray(0, 5).toString("latin1") === "%PDF-");
  ok("output is a non-trivial file", built.bytes.length > 3000, `${built.bytes.length} bytes`);
  check("no attachments failed to merge", built.problems, []);

  const expected = computePagination(scope);
  check("cover + schedule + 4-page + 1-page attachment = 7 pages", expected.total, 7);
  check("the built document has exactly the pages the cover claims", built.pageCount, expected.total);
  check("the built PDF re-opens and reports the same page count", await readPageCount(built.bytes), expected.total);

  console.log("\n=== A missing attachment degrades instead of failing ===");
  const degraded = await buildScopePackage(project, scope, [attachments[0]]);
  check("the missing file is reported", degraded.problems.map((p) => p.fileName), ["b-6806.pdf"]);
  ok("a placeholder page keeps the numbering intact", degraded.pageCount === expected.total,
    `${degraded.pageCount} pages vs ${expected.total} expected`);

  console.log("\n=== A corrupt attachment degrades instead of failing ===");
  const corrupt = await buildScopePackage(project, scope, [
    attachments[0],
    { attachmentId: "att-2", fileName: "b-6806.pdf", data: Buffer.from("%PDF-1.4 truncated garbage") },
  ]);
  check("the unreadable file is reported", corrupt.problems.map((p) => p.fileName), ["b-6806.pdf"]);
  ok("the package is still produced", corrupt.bytes.subarray(0, 5).toString("latin1") === "%PDF-");

  console.log("\n=== Download file name ===");
  check("file name is safe and readable", packageFileName(project, scope),
    "Riverside_Medical_Center_Phase_2_Toilet_Accessories_Submittal.pdf");

  console.log(`\n${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} checks FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
