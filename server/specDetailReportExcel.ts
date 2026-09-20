// Estimator Review Report — the Excel deliverable produced by the Spec
// Extractor's Detailed Spec Review.
//
// One workbook per extraction, covering every section that was extracted:
//   Estimator Summary  — one row per section, with flag and open-item counts
//   Short Order Form   — one row per distinct material, fully filled out
//   Flags              — everything that needs the estimator's attention
//   Open Items & RFIs  — what the spec never said, and what we do about it
//
// Styling follows server/buyout/excelExport.ts so the two reports look like
// they came from the same office.

import ExcelJS from "exceljs";
import {
  ORDER_FORM_FIELDS,
  OPEN_ITEM_LABELS,
  orderFormValue,
  summarizeDetailReviews,
  type SpecSectionDetailReview,
} from "@shared/specDetailReview";

const GOLD = "FFA8892E";
const GOLD_DARK = "FF7A5F1A";
const HEADER_TEXT = "FFFFFFFF";
const ZEBRA = "FFF5F5F7";
const HIGH = "FFC0392B";
const MEDIUM = "FFB9770E";
const LOW = "FF5D6D7E";
const GOOD = "FF2E8B57";
const RFI_FILL = "FFFDE2E1";
const ASSUMED_FILL = "FFFFF4D6";
const QUALIFY_FILL = "FFE6F0FB";

function headerRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: GOLD_DARK } } };
  });
  row.height = 28;
}

function zebra(ws: ExcelJS.Worksheet, rowNumber: number, columnCount: number) {
  if (rowNumber % 2 === 0) return;
  for (let c = 1; c <= columnCount; c++) {
    ws.getRow(rowNumber).getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
  }
}

function severityColor(severity: string): string {
  return severity === "high" ? HIGH : severity === "medium" ? MEDIUM : LOW;
}

function titleBlock(ws: ExcelJS.Worksheet, text: string, subtitle: string, span: string) {
  ws.mergeCells(span);
  const cell = ws.getCell(span.split(":")[0]);
  cell.value = text;
  cell.font = { bold: true, size: 16, color: { argb: GOLD_DARK } };
  ws.getRow(1).height = 24;
  ws.getCell("A2").value = subtitle;
  ws.getCell("A2").font = { size: 10, color: { argb: LOW } };
}

function wrapCells(row: ExcelJS.Row, columns: number[]) {
  for (const c of columns) {
    row.getCell(c).alignment = { vertical: "top", wrapText: true };
  }
}

/** Only what the report reads, so both the Drizzle row and the Zod type fit. */
export interface SpecReportSection {
  id: string;
  sectionNumber: string;
  title: string;
  startPage: number;
  endPage: number;
  sectionType: string;
}

export interface SpecReportInput {
  projectName: string;
  fileName: string;
  sections: SpecReportSection[];
  /** Sections the estimator chose not to review, listed so nothing is silently dropped. */
  reviews: SpecSectionDetailReview[];
}

export async function buildSpecReviewWorkbook(input: SpecReportInput): Promise<ExcelJS.Workbook> {
  const { projectName, fileName, sections, reviews } = input;
  const reviewBySection = new Map(reviews.map((r) => [r.sectionId, r]));
  const totals = summarizeDetailReviews(reviews);
  const generated = new Date().toLocaleString();

  const wb = new ExcelJS.Workbook();
  wb.creator = "AiPM Spec Extractor";
  wb.created = new Date();

  // ── Sheet 1: Estimator Summary ───────────────────────────────────────────
  const sum = wb.addWorksheet("Estimator Summary", { views: [{ state: "frozen", ySplit: 9 }] });
  titleBlock(sum, `Spec Review — ${projectName}`, `Source: ${fileName}  ·  Generated ${generated}`, "A1:K1");

  sum.getCell("A4").value = "Sections extracted";
  sum.getCell("B4").value = sections.length;
  sum.getCell("D4").value = "Sections reviewed in detail";
  sum.getCell("E4").value = totals.sectionsReviewed;
  sum.getCell("G4").value = "Materials identified";
  sum.getCell("H4").value = totals.totalItems;

  sum.getCell("A5").value = "Flags raised";
  sum.getCell("B5").value = totals.totalFlags;
  sum.getCell("D5").value = "High-severity flags";
  sum.getCell("E5").value = totals.highSeverityFlags;
  sum.getCell("E5").font = { bold: true, color: { argb: totals.highSeverityFlags > 0 ? HIGH : GOOD } };

  sum.getCell("A6").value = "RFIs required";
  sum.getCell("B6").value = totals.rfiCount;
  sum.getCell("B6").font = { bold: true, color: { argb: totals.rfiCount > 0 ? HIGH : GOOD } };
  sum.getCell("D6").value = "Assumptions carried";
  sum.getCell("E6").value = totals.assumedCount;
  sum.getCell("G6").value = "Items to qualify";
  sum.getCell("H6").value = totals.qualifyCount;

  for (const ref of ["A4", "D4", "G4", "A5", "D5", "A6", "D6", "G6"]) {
    sum.getCell(ref).font = { bold: true, color: { argb: LOW } };
  }

  const summaryColumns = [
    { header: "Section", width: 14 },
    { header: "Title", width: 40 },
    { header: "Pages", width: 12 },
    { header: "Type", width: 12 },
    { header: "Materials", width: 11 },
    { header: "Flags", width: 9 },
    { header: "High", width: 8 },
    { header: "RFI", width: 8 },
    { header: "Assumed", width: 10 },
    { header: "Qualify", width: 9 },
    { header: "Spec Completeness", width: 18 },
    { header: "Scope Summary", width: 60 },
  ];
  sum.getRow(8).values = summaryColumns.map((c) => c.header);
  summaryColumns.forEach((c, i) => { sum.getColumn(i + 1).width = c.width; });
  headerRow(sum.getRow(8));

  let r = 9;
  const byNumber = [...sections].sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber));
  for (const section of byNumber) {
    const review = reviewBySection.get(section.id);
    const flags = review?.flags || [];
    const openItems = review?.openItems || [];
    const row = sum.getRow(r);
    row.values = [
      section.sectionNumber,
      section.title,
      `${section.startPage + 1}–${section.endPage + 1}`,
      section.sectionType,
      review ? review.items.length : "—",
      review ? flags.length : "—",
      review ? flags.filter((f) => f.severity === "high").length : "—",
      review ? openItems.filter((o) => o.classification === "rfi").length : "—",
      review ? openItems.filter((o) => o.classification === "assumed").length : "—",
      review ? openItems.filter((o) => o.classification === "qualify").length : "—",
      review ? `${review.completeness}%` : "Not reviewed",
      review?.error ? `Review failed: ${review.error}` : review?.scopeSummary || "Not included in the detailed review",
    ];
    row.getCell(1).font = { bold: true };
    if (review && flags.some((f) => f.severity === "high")) {
      row.getCell(7).font = { bold: true, color: { argb: HIGH } };
    }
    if (review && openItems.some((o) => o.classification === "rfi")) {
      row.getCell(8).font = { bold: true, color: { argb: HIGH } };
    }
    if (review) {
      row.getCell(11).font = {
        bold: true,
        color: { argb: review.completeness >= 75 ? GOOD : review.completeness >= 45 ? MEDIUM : HIGH },
      };
    }
    wrapCells(row, [2, 12]);
    zebra(sum, r, summaryColumns.length);
    r++;
  }
  sum.autoFilter = { from: { row: 8, column: 1 }, to: { row: Math.max(8, r - 1), column: summaryColumns.length } };

  // ── Sheet 2: Short Order Form ────────────────────────────────────────────
  const orderSheet = wb.addWorksheet("Short Order Form", { views: [{ state: "frozen", xSplit: 2, ySplit: 4 }] });
  titleBlock(
    orderSheet,
    `Short Order Form — ${projectName}`,
    "One row per distinct material. Blank cells are information the specification never gave — see the Open Items & RFIs tab.",
    "A1:E1",
  );

  const orderHeaders = ["Section", "Section Title", ...ORDER_FORM_FIELDS.map((f) => f.label), "Open Items", "Flags"];
  orderSheet.getRow(3).values = orderHeaders;
  orderSheet.getColumn(1).width = 14;
  orderSheet.getColumn(2).width = 34;
  ORDER_FORM_FIELDS.forEach((f, i) => { orderSheet.getColumn(i + 3).width = f.width; });
  orderSheet.getColumn(orderHeaders.length - 1).width = 12;
  orderSheet.getColumn(orderHeaders.length).width = 12;
  headerRow(orderSheet.getRow(3));

  let orderRow = 4;
  for (const review of reviews) {
    if (review.items.length === 0) {
      const row = orderSheet.getRow(orderRow);
      row.values = [
        review.sectionNumber,
        review.title,
        review.error ? `Review failed: ${review.error}` : "No priceable materials identified in this section",
      ];
      row.getCell(3).font = { italic: true, color: { argb: MEDIUM } };
      zebra(orderSheet, orderRow, orderHeaders.length);
      orderRow++;
      continue;
    }

    for (const item of review.items) {
      const itemOpen = review.openItems.filter((o) => !o.itemName || o.itemName === item.itemName).length;
      const itemFlags = review.flags.filter((f) => !f.itemName || f.itemName === item.itemName).length;
      const row = orderSheet.getRow(orderRow);
      row.values = [
        review.sectionNumber,
        review.title,
        ...ORDER_FORM_FIELDS.map((f) => orderFormValue(item, f.key)),
        itemOpen,
        itemFlags,
      ];
      row.getCell(1).font = { bold: true };
      // Highlight the blanks — those are what the estimator has to chase.
      ORDER_FORM_FIELDS.forEach((f, i) => {
        const cell = row.getCell(i + 3);
        cell.alignment = { vertical: "top", wrapText: true };
        if (!orderFormValue(item, f.key).trim()) {
          cell.value = "—";
          cell.font = { color: { argb: HIGH }, bold: true };
        }
      });
      wrapCells(row, [2]);
      zebra(orderSheet, orderRow, orderHeaders.length);
      orderRow++;
    }
  }
  if (orderRow > 4) {
    orderSheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: orderRow - 1, column: orderHeaders.length } };
  }

  // ── Sheet 3: Flags ───────────────────────────────────────────────────────
  const flagSheet = wb.addWorksheet("Flags", { views: [{ state: "frozen", ySplit: 4 }] });
  titleBlock(
    flagSheet,
    `Estimator Flags — ${projectName}`,
    "Sorted high severity first. Multiple versions of the same material and fire-rated FECs are always flagged.",
    "A1:F1",
  );

  const flagHeaders = ["Severity", "Section", "Section Title", "Item", "Flag", "What Was Found", "Recommended Action"];
  const flagWidths = [12, 14, 32, 28, 34, 60, 52];
  flagSheet.getRow(3).values = flagHeaders;
  flagWidths.forEach((w, i) => { flagSheet.getColumn(i + 1).width = w; });
  headerRow(flagSheet.getRow(3));

  const allFlags = reviews
    .flatMap((review) => review.flags.map((flag) => ({ review, flag })))
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 } as const;
      const bySeverity = order[a.flag.severity] - order[b.flag.severity];
      if (bySeverity !== 0) return bySeverity;
      return a.review.sectionNumber.localeCompare(b.review.sectionNumber);
    });

  let flagRow = 4;
  for (const { review, flag } of allFlags) {
    const row = flagSheet.getRow(flagRow);
    row.values = [
      flag.severity.toUpperCase(),
      review.sectionNumber,
      review.title,
      flag.itemName || "—",
      flag.label,
      flag.detail,
      flag.recommendedAction,
    ];
    row.getCell(1).font = { bold: true, color: { argb: severityColor(flag.severity) } };
    row.getCell(2).font = { bold: true };
    row.getCell(5).font = { bold: true };
    wrapCells(row, [3, 4, 5, 6, 7]);
    zebra(flagSheet, flagRow, flagHeaders.length);
    flagRow++;
  }
  if (flagRow === 4) {
    flagSheet.getCell("A4").value = "No flags raised.";
    flagSheet.getCell("A4").font = { italic: true, color: { argb: GOOD } };
  } else {
    flagSheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: flagRow - 1, column: flagHeaders.length } };
  }

  // ── Sheet 4: Open Items & RFIs ───────────────────────────────────────────
  const openSheet = wb.addWorksheet("Open Items & RFIs", { views: [{ state: "frozen", ySplit: 4 }] });
  titleBlock(
    openSheet,
    `Open Items & RFIs — ${projectName}`,
    "Everything the specification did not answer. RFI = ask before bid · Assumed = carried as noted · Qualify = state it in the proposal.",
    "A1:F1",
  );

  const openHeaders = [
    "Action", "Impact", "Section", "Section Title", "Item", "Missing Information",
    "RFI Question", "Assumption If Unanswered", "Answer / Resolution", "Status",
  ];
  const openWidths = [20, 10, 14, 30, 26, 26, 58, 48, 40, 14];
  openSheet.getRow(3).values = openHeaders;
  openWidths.forEach((w, i) => { openSheet.getColumn(i + 1).width = w; });
  headerRow(openSheet.getRow(3));

  const classOrder = { rfi: 0, qualify: 1, assumed: 2 } as const;
  const impactOrder = { high: 0, medium: 1, low: 2 } as const;
  const allOpen = reviews
    .flatMap((review) => review.openItems.map((item) => ({ review, item })))
    .sort((a, b) => {
      const byClass = classOrder[a.item.classification] - classOrder[b.item.classification];
      if (byClass !== 0) return byClass;
      const byImpact = impactOrder[a.item.impact] - impactOrder[b.item.impact];
      if (byImpact !== 0) return byImpact;
      return a.review.sectionNumber.localeCompare(b.review.sectionNumber);
    });

  let openRow = 4;
  for (const { review, item } of allOpen) {
    const row = openSheet.getRow(openRow);
    row.values = [
      OPEN_ITEM_LABELS[item.classification],
      item.impact.toUpperCase(),
      review.sectionNumber,
      review.title,
      item.itemName || "—",
      item.field,
      item.question,
      item.assumption,
      "",
      item.classification === "rfi" ? "Open" : "Carried",
    ];
    const fill = item.classification === "rfi" ? RFI_FILL : item.classification === "assumed" ? ASSUMED_FILL : QUALIFY_FILL;
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    row.getCell(1).font = { bold: true };
    row.getCell(2).font = { bold: true, color: { argb: severityColor(item.impact) } };
    row.getCell(3).font = { bold: true };
    // Answer column is left blank on purpose — the estimator fills it in.
    row.getCell(9).border = { bottom: { style: "hair", color: { argb: LOW } } };
    wrapCells(row, [4, 5, 6, 7, 8, 9]);
    openRow++;
  }
  if (openRow === 4) {
    openSheet.getCell("A4").value = "No open items — every order-form field was answered by the specification.";
    openSheet.getCell("A4").font = { italic: true, color: { argb: GOOD } };
  } else {
    openSheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: openRow - 1, column: openHeaders.length } };
  }

  return wb;
}

export async function buildSpecReviewBuffer(input: SpecReportInput): Promise<Buffer> {
  const wb = await buildSpecReviewWorkbook(input);
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
