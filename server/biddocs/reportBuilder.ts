import ExcelJS from "exceljs";
import type { ParsedPage, ScopeMaterialDetails } from "@shared/schema";
import { guessSheetNumber } from "./calloutHarvester";

export interface ShortOrderReportInput {
  projectName: string;
  projectMeta: Record<string, string | null | undefined>;
  selectedScopes: string[];
  scopeDetails: ScopeMaterialDetails[];
  relevantPages: ParsedPage[];
  scopeSheetRefs: Record<string, string[]>;
  scopeCounts: Record<string, number>;
  harvestedCallouts: Record<string, string[]>;
  filesProcessed: string[];
  generatedBy: string;
}

const GOLD = "FFC9A227";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
const SUB_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: "middle" };
  row.height = 20;
}

function sheetSafeName(name: string): string {
  return name.replace(/[\[\]*?/\\:]/g, "-").slice(0, 31);
}

/**
 * Scope Short Order workbook: a Summary tab plus one tab per scope carrying
 * the material-details table an estimator completes and sends out for
 * quotes. Every extracted detail cites its source sheet/spec section.
 */
export async function buildScopeShortOrderWorkbook(
  outPath: string,
  input: ShortOrderReportInput,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AiPM Tool Belt — Bid Docs Intake";
  wb.created = new Date();

  // ---------------- Summary tab ----------------
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { width: 28 },
    { width: 50 },
    { width: 16 },
    { width: 40 },
  ];

  summary.addRow([`${input.projectName} — Scope Short Order`]).font = { bold: true, size: 16 };
  summary.addRow([`Generated ${new Date().toLocaleString()} by ${input.generatedBy}`]).font = { italic: true, size: 10 };
  summary.addRow([]);

  for (const [label, value] of Object.entries(input.projectMeta)) {
    if (value) {
      const row = summary.addRow([label, String(value)]);
      row.getCell(1).font = { bold: true };
    }
  }
  summary.addRow([]);

  const filesRow = summary.addRow(["Files Processed", input.filesProcessed.join(", ")]);
  filesRow.getCell(1).font = { bold: true };
  summary.addRow([]);

  const tableHeader = summary.addRow(["Scope", "Spec Section", "Pages Found", "Schedule Callouts"]);
  styleHeaderRow(tableHeader);

  for (const scope of input.selectedScopes) {
    const details = input.scopeDetails.find(d => d.scope === scope);
    const count = input.scopeCounts[scope] || (input.scopeSheetRefs[scope]?.length ?? 0);
    if (count === 0 && !details) continue;
    summary.addRow([
      scope,
      details?.specSectionNumber ? `${details.specSectionNumber} ${details.specSectionTitle || ""}`.trim() : "—",
      count,
      (input.harvestedCallouts[scope] || []).join(", ") || "—",
    ]);
  }

  // ---------------- Per-scope tabs ----------------
  for (const scope of input.selectedScopes) {
    const details = input.scopeDetails.find(d => d.scope === scope);
    const pages = input.relevantPages.filter(p => p.tags.includes(scope as any));
    if (!details && pages.length === 0) continue;

    const ws = wb.addWorksheet(sheetSafeName(scope));
    ws.columns = [
      { width: 12 }, // Type Mark
      { width: 42 }, // Description
      { width: 18 }, // Material
      { width: 20 }, // Dimensions
      { width: 16 }, // Model #
      { width: 20 }, // Manufacturer
      { width: 8 },  // Qty
      { width: 24 }, // Source
      { width: 32 }, // Notes
    ];

    // Header block
    ws.addRow([`${scope} — Short Order Form`]).font = { bold: true, size: 14, color: { argb: GOLD } };
    ws.addRow([`Project: ${input.projectName}`]);
    if (details?.specSectionNumber) {
      ws.addRow([`Spec Section: ${details.specSectionNumber} ${details.specSectionTitle || ""}`.trim()]);
    }
    if (details && details.requiredManufacturers.length > 0) {
      const row = ws.addRow([`Required/Approved Manufacturers: ${details.requiredManufacturers.join(", ")}`]);
      row.font = { bold: true };
    }
    const callouts = input.harvestedCallouts[scope] || [];
    if (callouts.length > 0) {
      ws.addRow([`Schedule Callouts Found: ${callouts.join(", ")}`]);
    }
    ws.addRow([]);

    // Material-details table
    const header = ws.addRow([
      "Type Mark", "Description", "Material", "Dimensions", "Model #",
      "Manufacturer", "Qty", "Source", "Notes",
    ]);
    styleHeaderRow(header);

    const items = details?.items || [];
    for (const item of items) {
      ws.addRow([
        item.typeMark || "",
        item.description || "",
        item.material || "",
        item.dimensions || "",
        item.modelNumber || "",
        item.manufacturer || "",
        item.quantity || "",
        item.source || "",
        item.notes || "",
      ]);
    }
    // Blank rows for hand-entry
    for (let i = 0; i < Math.max(5, 12 - items.length); i++) {
      ws.addRow(["", "", "", "", "", "", "", "", ""]);
    }

    ws.addRow([]);

    // Findings detail: where and why pages were flagged
    const findingsHeader = ws.addRow(["Flagged Plan Pages (attach the combined scope PDF when requesting quotes)"]);
    findingsHeader.font = { bold: true };
    const findingsCols = ws.addRow(["Sheet", "File", "Page", "Match Type", "Why Flagged"]);
    findingsCols.font = { bold: true };
    findingsCols.fill = SUB_FILL;

    for (const page of pages.sort((a, b) => a.originalFilename.localeCompare(b.originalFilename) || a.pageNumber - b.pageNumber)) {
      ws.addRow([
        guessSheetNumber(page.ocrText) || "—",
        page.originalFilename,
        page.pageNumber,
        page.matchType,
        page.whyFlagged.slice(0, 300),
      ]);
    }
  }

  await wb.xlsx.writeFile(outPath);
  console.log(`[BidDocs] Scope Short Order report written: ${outPath}`);
}
