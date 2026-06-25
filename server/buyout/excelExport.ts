// Multi-sheet Excel export for the Buyout Bot (exceljs, server-side so we can
// do branded fills, bold, and color-coded variance the browser engine can't).
//
// Sheets: Executive Summary, Buyout Detail, Line Items.

import ExcelJS from "exceljs";
import type { BuyoutBoard, BuyoutScope } from "@shared/buyout/types";
import {
  combinedAwardedTotal,
  awardedVariance,
  coverageReport,
  computeReleaseBy,
  isQuoteStale,
  boardTotals,
} from "@shared/buyout/types";

const GOLD = "FFA8892E";
const GOLD_DARK = "FF7A5F1A";
const WIN = "FF2E8B57"; // under budget
const LOSS = "FFC0392B"; // over budget
const HEADER_TEXT = "FFFFFFFF";
const ZEBRA = "FFF5F5F7";

function moneyFmt(cell: ExcelJS.Cell) {
  cell.numFmt = '$#,##0.00;[Red]($#,##0.00)';
}

function headerRow(ws: ExcelJS.Worksheet, row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: GOLD_DARK } } };
  });
}

function scopeStatusLabel(s: BuyoutScope): string {
  return (
    {
      not_started: "Not Started",
      rfq_sent: "RFQ Sent",
      quotes_in: "Quotes In",
      awarded: "Awarded",
      po: "PO Executed",
    } as Record<string, string>
  )[s.status] || s.status;
}

function awardedVendorNames(s: BuyoutScope): string {
  return s.awardedVendorIds
    .map((vid) => s.quotes.find((q) => q.vendorId === vid)?.vendorName || vid)
    .join(", ");
}

export async function buildBuyoutWorkbook(projectName: string, board: BuyoutBoard): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AiPM Buyout Bot";
  wb.created = new Date();

  const totals = boardTotals(board);

  // ---- Sheet 1: Executive Summary -----------------------------------------
  const exec = wb.addWorksheet("Executive Summary", { views: [{ state: "frozen", ySplit: 6 }] });
  exec.mergeCells("A1:F1");
  const title = exec.getCell("A1");
  title.value = `Buyout Summary — ${projectName}`;
  title.font = { bold: true, size: 16, color: { argb: GOLD_DARK } };
  exec.getRow(1).height = 24;

  exec.getCell("A2").value = "Generated";
  exec.getCell("B2").value = new Date().toLocaleString();
  exec.getCell("A3").value = "Scopes";
  exec.getCell("B3").value = `${totals.boughtOut} of ${totals.scopeCount} bought out`;
  exec.getCell("A4").value = "Total Budget";
  moneyFmt(exec.getCell("B4"));
  exec.getCell("B4").value = totals.budgetTotal;
  exec.getCell("D4").value = "Total Awarded";
  moneyFmt(exec.getCell("E4"));
  exec.getCell("E4").value = totals.awardedTotal;
  exec.getCell("A5").value = "Variance";
  const vCell = exec.getCell("B5");
  moneyFmt(vCell);
  vCell.value = totals.variance;
  vCell.font = { bold: true, color: { argb: totals.variance <= 0 ? WIN : LOSS } };
  exec.getCell("D5").value = totals.complete ? "✓ BUYOUT COMPLETE" : "In Progress";
  exec.getCell("D5").font = { bold: true, color: { argb: totals.complete ? WIN : GOLD_DARK } };

  const hdr = exec.getRow(6);
  hdr.values = ["Scope", "Budget", "Awarded", "Variance", "Status", "Awarded To"];
  headerRow(exec, hdr);

  let allowanceCount = 0;
  board.scopes.forEach((s, i) => {
    const awarded = combinedAwardedTotal(s);
    const variance = awardedVariance(s);
    const hasAward = s.awardedVendorIds.length > 0;
    const scopeAllowances = s.items.filter((it) => it.isAllowance).length;
    allowanceCount += scopeAllowances;
    const row = exec.addRow([
      s.name,
      s.budget.total,
      hasAward ? awarded : null,
      hasAward ? variance : null,
      scopeStatusLabel(s),
      awardedVendorNames(s),
    ]);
    moneyFmt(row.getCell(2));
    moneyFmt(row.getCell(3));
    moneyFmt(row.getCell(4));
    // Variance / over-under-pending color.
    const statusCell = row.getCell(5);
    if (!hasAward) {
      statusCell.font = { color: { argb: GOLD_DARK } };
    } else if (variance <= 0) {
      row.getCell(4).font = { color: { argb: WIN }, bold: true };
    } else {
      row.getCell(4).font = { color: { argb: LOSS }, bold: true };
    }
    if (s.status === "po") row.getCell(5).font = { color: { argb: WIN }, bold: true };
    if (i % 2 === 1) {
      row.eachCell((c) => {
        if (!c.fill || (c.fill as any).pattern !== "solid") {
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA } };
        }
      });
    }
  });

  if (allowanceCount > 0) {
    const note = exec.addRow([`Note: ${allowanceCount} allowance line item(s) included — verify before final buyout.`]);
    note.getCell(1).font = { italic: true, color: { argb: GOLD_DARK } };
  }

  exec.columns.forEach((c, i) => (c.width = i === 0 ? 30 : i === 5 ? 34 : 16));

  // ---- Sheet 2: Buyout Detail ---------------------------------------------
  const detail = wb.addWorksheet("Buyout Detail");
  let r = 1;
  for (const s of board.scopes) {
    detail.mergeCells(r, 1, r, 8);
    const sc = detail.getCell(r, 1);
    sc.value = `${s.name}  —  ${scopeStatusLabel(s)}`;
    sc.font = { bold: true, size: 13, color: { argb: HEADER_TEXT } };
    sc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
    detail.getRow(r).height = 20;
    r++;

    const clock = computeReleaseBy(s);
    detail.getCell(r, 1).value = "Budget (raw)";
    moneyFmt(detail.getCell(r, 2));
    detail.getCell(r, 2).value = s.budget.total;
    detail.getCell(r, 3).value = `Mat ${s.budget.material} / Frt ${s.budget.freight} / Lab ${s.budget.labor}`;
    detail.getCell(r, 5).value = "ROS";
    detail.getCell(r, 6).value = s.rosDate || "—";
    detail.getCell(r, 7).value = "Release By";
    detail.getCell(r, 8).value = clock ? `${clock.releaseBy} (${clock.daysUntil}d)` : "—";
    r++;

    const vh = detail.getRow(r);
    vh.values = ["Vendor", "Quote", "vs Budget", "Awarded", "Verified", "Coverage", "Lead (wk)", "Quote Date"];
    headerRow(detail, vh);
    r++;

    const cov = coverageReport(s);
    const sorted = [...s.quotes].sort((a, b) => {
      const aa = s.awardedVendorIds.includes(a.vendorId) ? 0 : 1;
      const bb = s.awardedVendorIds.includes(b.vendorId) ? 0 : 1;
      return aa - bb;
    });
    for (const q of sorted) {
      const isAwarded = s.awardedVendorIds.includes(q.vendorId);
      const vsBudget = q.quoteAmount - s.budget.total;
      const stale = isQuoteStale(q);
      const row = detail.getRow(r);
      row.values = [
        (isAwarded ? "★ " : "") + q.vendorName,
        q.quoteAmount,
        vsBudget,
        isAwarded ? "AWARDED" : "",
        q.verified ? "Yes" : q.aiSuggested ? "AI — unverified" : "No",
        q.coveredLineIds == null ? "Full scope" : `${q.coveredLineIds.length} line(s)`,
        q.leadTimeWeeks || "",
        (q.quoteDate || "") + (stale ? " (STALE)" : ""),
      ];
      moneyFmt(row.getCell(2));
      moneyFmt(row.getCell(3));
      row.getCell(3).font = { color: { argb: vsBudget <= 0 ? WIN : LOSS } };
      if (isAwarded) row.getCell(4).font = { bold: true, color: { argb: WIN } };
      if (!q.verified) row.getCell(5).font = { color: { argb: LOSS } };
      if (stale) row.getCell(8).font = { color: { argb: LOSS } };
      r++;
    }
    // Coverage callout.
    if (s.awardedVendorIds.length > 0) {
      const cc = detail.getRow(r);
      const msg =
        cov.allCovered && cov.doubleCovered.length === 0
          ? "✓ All line items covered"
          : `${cov.uncovered.length} uncovered, ${cov.doubleCovered.length} double-covered`;
      cc.getCell(1).value = `Coverage: ${msg}`;
      cc.getCell(1).font = { italic: true, color: { argb: cov.allCovered && cov.doubleCovered.length === 0 ? WIN : LOSS } };
      r++;
    }
    r++; // blank spacer
  }
  detail.columns.forEach((c, i) => (c.width = i === 0 ? 28 : 16));

  // ---- Sheet 3: Line Items -------------------------------------------------
  const li = wb.addWorksheet("Line Items", { views: [{ state: "frozen", ySplit: 1 }] });
  const liHdr = li.getRow(1);
  liHdr.values = ["Scope", "Spec No", "Callout", "Description", "Model", "Qty", "Material", "Freight", "Labor", "Total", "Type"];
  headerRow(li, liHdr);
  let liRow = 2;
  for (const s of board.scopes) {
    for (const it of s.items) {
      const row = li.getRow(liRow);
      row.values = [s.name, it.specNo, it.callout, it.description, it.model, it.qty, it.material, it.freight, it.labor, it.total, it.isAllowance ? "Allowance" : "Standard"];
      [7, 8, 9, 10].forEach((c) => moneyFmt(row.getCell(c)));
      if (it.isAllowance) row.getCell(11).font = { color: { argb: GOLD_DARK }, bold: true };
      liRow++;
    }
  }
  li.columns.forEach((c, i) => (c.width = i === 3 ? 40 : i === 0 ? 24 : 13));

  return wb;
}
