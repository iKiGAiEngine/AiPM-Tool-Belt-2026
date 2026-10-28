import ExcelJS from "exceljs";
import { createHash } from "crypto";

// Reads an NBS estimate workbook (the Excel file estimators work in) and
// returns a read-only snapshot for display in AiPM. Nothing is ever written
// back to the workbook — the sheet stays the source of truth.

export interface SnapshotLineItem {
  specNo: string;
  planCallout: string;
  description: string;
  model: string;
  qty: number;
  unitMaterial: number;
  unitFreight: number;
  unitSub: number;
  totalMaterial: number;
  totalFreight: number;
  totalSub: number;
  total: number;
  remarks: string;
}

export interface SnapshotScope {
  sheetName: string;
  label: string;
  material: number;
  freight: number;
  sub: number;
  total: number;
  lineItems: SnapshotLineItem[];
}

export interface SnapshotSummaryRow {
  scope: string;
  escalation: number;
  overhead: number;
  fee: number;
  material: number;
  freight: number;
  tax: number;
  total: number;
}

export interface SnapshotProject {
  projectName: string;
  estimateNumber: string;
  bidDueDate: string | null;
  planVersion: string;
  gcEstimator: string;
  nbsEstimator: string;
  taxRate: number | null;
  escalationRate: number | null;
  overheadRate: number | null;
  insuranceRate: number | null;
}

export interface EstimateWorkbookSnapshot {
  fileHash: string;
  project: SnapshotProject;
  summaryRows: SnapshotSummaryRow[];
  proposalTotal: number;
  scopes: SnapshotScope[];
  warnings: string[];
}

// Tabs that hold calculations, price books or print layouts rather than a scope.
const NON_SCOPE_SHEETS = new Set([
  "po review", "change log", "print preview", "proposal", "summary sheet", "buyout",
]);
const isReferenceSheet = (name: string) =>
  NON_SCOPE_SHEETS.has(name.toLowerCase().trim()) || /pricing|labor factors/i.test(name);

function raw(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return (v as { result: unknown }).result;
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    if ("text" in v) return (v as { text: unknown }).text;
  }
  return v;
}

function text(cell: ExcelJS.Cell): string {
  const v = raw(cell);
  if (v == null || typeof v === "object" && !(v instanceof Date)) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

// Formula errors (#DIV/0!, #REF!) and blanks both read as 0 so one broken cell
// can't poison a total.
function num(cell: ExcelJS.Cell): number {
  const v = raw(cell);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,%\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function numOrNull(cell: ExcelJS.Cell): number | null {
  const v = raw(cell);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  for (let r = 1; r <= 15; r++) {
    const cells = ws.getRow(r).values as unknown[];
    const joined = cells.map((c) => (typeof c === "string" ? c.toUpperCase() : "")).join("|");
    if (joined.includes("SPEC NO") && joined.includes("DESCRIPTION")) return r;
  }
  return null;
}

function parseScope(ws: ExcelJS.Worksheet): SnapshotScope | null {
  const headerRow = findHeaderRow(ws);
  if (!headerRow) return null;

  // Map columns by header text so small layout differences between template
  // versions (e.g. Toilet Accessories has more columns) don't break the read.
  const cols: Record<string, number> = {};
  const hdr = ws.getRow(headerRow);
  const seenMaterial: number[] = [];
  const seenFreight: number[] = [];
  const seenSub: number[] = [];
  hdr.eachCell((cell, c) => {
    const t = text(cell).toUpperCase();
    if (t === "SPEC NO." || t === "SPEC NO") cols.spec = c;
    else if (t === "PLAN CALLOUT") cols.callout = c;
    else if (t === "DESCRIPTION") cols.desc = c;
    else if (t === "MODEL NUMBER") cols.model = c;
    else if (t === "ITEM QUANTITY" || t === "QTY") cols.qty = c;
    else if (t === "MATERIAL") seenMaterial.push(c);
    else if (t === "FREIGHT") seenFreight.push(c);
    else if (t === "SUB") seenSub.push(c);
    else if (t === "TOTAL" && !cols.total) cols.total = c;
    else if (t === "REMARKS") cols.remarks = c;
  });
  // First MATERIAL/FREIGHT/SUB header = unit cost block, second = total cost block.
  if (seenMaterial.length < 2 || seenFreight.length < 2) return null;

  const items: SnapshotLineItem[] = [];
  const totals = { material: 0, freight: 0, sub: 0, total: 0 };
  const cell = (row: ExcelJS.Row, c?: number) => (c ? row.getCell(c) : undefined);

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const description = cell(row, cols.desc) ? text(row.getCell(cols.desc)) : "";
    const specNo = cell(row, cols.spec) ? text(row.getCell(cols.spec)) : "";
    // The table ends at a SUBTOTAL/TOTAL row; anything below it (contact lists,
    // notes) is not line items. The label sits in column A or the description column.
    const labels = [text(row.getCell(1)), description, specNo];
    if (labels.some((l) => /^(sub\s*)?total\b/i.test(l))) break;
    // Unused template rows only carry the row number and zeroed formulas.
    if (!description) continue;

    const item: SnapshotLineItem = {
      specNo,
      planCallout: cols.callout ? text(row.getCell(cols.callout)) : "",
      description,
      model: cols.model ? text(row.getCell(cols.model)) : "",
      qty: cols.qty ? num(row.getCell(cols.qty)) : 0,
      unitMaterial: num(row.getCell(seenMaterial[0])),
      unitFreight: num(row.getCell(seenFreight[0])),
      unitSub: seenSub[0] ? num(row.getCell(seenSub[0])) : 0,
      totalMaterial: num(row.getCell(seenMaterial[1])),
      totalFreight: num(row.getCell(seenFreight[1])),
      totalSub: seenSub[1] ? num(row.getCell(seenSub[1])) : 0,
      total: cols.total ? num(row.getCell(cols.total)) : 0,
      remarks: cols.remarks ? text(row.getCell(cols.remarks)) : "",
    };
    if (!item.total) item.total = item.totalMaterial + item.totalFreight + item.totalSub;
    items.push(item);
    totals.material += item.totalMaterial;
    totals.freight += item.totalFreight;
    totals.sub += item.totalSub;
    totals.total += item.total;
  }

  const scopeCell = text(ws.getCell("A3"));
  return {
    sheetName: ws.name,
    label: scopeCell.replace(/^SCOPE:\s*/i, "") || ws.name,
    material: round2(totals.material),
    freight: round2(totals.freight),
    sub: round2(totals.sub),
    total: round2(totals.total),
    lineItems: items,
  };
}

function parseSummary(ws: ExcelJS.Worksheet): {
  project: SnapshotProject;
  rows: SnapshotSummaryRow[];
  proposalTotal: number;
} {
  // Left block is labelled key/value pairs (A = label, B = value).
  const kv: Record<string, ExcelJS.Cell> = {};
  for (let r = 1; r <= 14; r++) {
    const label = text(ws.getCell(r, 1)).toUpperCase().replace(/[:\s]+$/, "");
    if (label) kv[label] = ws.getCell(r, 2);
  }
  const get = (k: string) => (kv[k] ? text(kv[k]) : "");
  const pct = (k: string) => (kv[k] ? numOrNull(kv[k]) : null);

  // Right block is the per-scope totals table starting at E2, ending at PROPOSAL TOTAL.
  const rows: SnapshotSummaryRow[] = [];
  let proposalTotal = 0;
  for (let r = 2; r <= 60; r++) {
    const name = text(ws.getCell(r, 5));
    if (!name) continue;
    const entry: SnapshotSummaryRow = {
      scope: name,
      total: num(ws.getCell(r, 6)),
      escalation: num(ws.getCell(r, 7)),
      overhead: num(ws.getCell(r, 8)),
      fee: num(ws.getCell(r, 9)),
      material: num(ws.getCell(r, 10)),
      freight: num(ws.getCell(r, 11)),
      tax: num(ws.getCell(r, 12)),
    };
    if (/^PROPOSAL TOTAL/i.test(name)) {
      proposalTotal = entry.total;
      break;
    }
    rows.push(entry);
  }

  const due = raw(ws.getCell("B2"));
  return {
    project: {
      projectName: get("PROJECT"),
      estimateNumber: get("ESTIMATE #"),
      bidDueDate: due instanceof Date ? due.toISOString().slice(0, 10) : due ? String(due) : null,
      planVersion: get("PLAN VERSION"),
      gcEstimator: get("GC ESTIMATOR"),
      nbsEstimator: get("NBS ESTIMATOR"),
      taxRate: pct("TAX RATE (%)"),
      escalationRate: pct("ESCALATION (%)"),
      overheadRate: pct("OVERHEAD (%)"),
      insuranceRate: pct("INSURANCE (%)"),
    },
    rows: rows.map((r) => ({ ...r, total: round2(r.total) })),
    proposalTotal: round2(proposalTotal),
  };
}

export async function parseEstimateWorkbook(buffer: Buffer): Promise<EstimateWorkbookSnapshot> {
  const warnings: string[] = [];
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const summaryWs = wb.getWorksheet("Summary Sheet");
  if (!summaryWs) warnings.push("No 'Summary Sheet' tab found — project details are blank.");
  const summary = summaryWs
    ? parseSummary(summaryWs)
    : {
        project: {
          projectName: "", estimateNumber: "", bidDueDate: null, planVersion: "",
          gcEstimator: "", nbsEstimator: "", taxRate: null, escalationRate: null,
          overheadRate: null, insuranceRate: null,
        },
        rows: [],
        proposalTotal: 0,
      };

  const scopes: SnapshotScope[] = [];
  wb.eachSheet((ws) => {
    if (isReferenceSheet(ws.name)) return;
    const scope = parseScope(ws);
    if (!scope) {
      warnings.push(`Tab "${ws.name}" skipped — no line item table found.`);
      return;
    }
    // Hide scopes nobody has priced so the page only shows live work.
    if (scope.lineItems.length > 0) scopes.push(scope);
  });

  if (summary.rows.every((r) => r.total === 0) && scopes.some((s) => s.total > 0)) {
    warnings.push("Summary Sheet totals are all zero — the workbook may not have recalculated before saving.");
  }

  return { fileHash, project: summary.project, summaryRows: summary.rows, proposalTotal: summary.proposalTotal, scopes, warnings };
}
