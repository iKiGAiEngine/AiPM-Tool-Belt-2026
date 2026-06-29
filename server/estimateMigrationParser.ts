import ExcelJS from "exceljs";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MigratedProjectInfo {
  projectName: string;
  projectId: string;
  regionCode: string;
  dueDate: string;
  projectAddress: string | null;
  gcContact: string | null;
  estimator: string | null;
  anticipatedStart: string | null;
  anticipatedFinish: string | null;
  // Carried over to new template
  taxRate: number | null;
  defaultOh: number | null;
  defaultEsc: number | null;
  // Reference only — NOT written to new template
  oldFee: number | null;
  oldBondRate: number | null;
}

export interface MigratedCatOverride {
  scopeKey: string;
  ohOverride: number | null;
  escOverride: number | null;
}

export interface MigratedLineItem {
  callout: string;
  description: string;
  model: string;
  manufacturer: string;
  qty: number;
  unitCost: number;
  extendedCost: number;
  note: string;
  sourceRow: number;
}

export interface MigratedScope {
  sheetName: string;
  csiCode: string;
  specTitle: string;
  lineItems: MigratedLineItem[];
  preMarkupSubtotal: number;
  inclusions: string[];
  exclusions: string[];
  qualifications: string[];
  rawQualText: string | null;
}

export interface MigratedScopeMapping {
  oldSheetName: string;
  newSheetName: string | null;
  csiCode: string;
  matchBasis: "exact" | "csi" | "fuzzy" | "unmapped";
  warning: string | null;
}

export interface ParsedOldEstimate {
  projectInfo: MigratedProjectInfo;
  scopes: MigratedScope[];
  catOverrides: MigratedCatOverride[];
  scopeMappings: MigratedScopeMapping[];
  warnings: string[];
  parseErrors: string[];
  parsedAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SKIP_SHEETS = new Set([
  "summary", "summary sheet", "cover", "cover page", "toc", "table of contents",
  "index", "notes", "instructions", "lookup", "data", "lists", "template",
  "overview", "ref", "reference", "versions", "version history", "markups",
  "breakout", "assumptions", "quotes", "vendor quotes", "spec sections",
  "division 10", "div 10",
]);

const CSI_RE = /^10[\s\-]?\d{2}[\s\-]?\d{0,2}/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function norm(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellText(cell: ExcelJS.Cell): string {
  if (!cell || cell.value == null) return "";
  const v = cell.value;
  if (typeof v === "object" && v !== null) {
    // RichText
    if ("richText" in v) return (v as any).richText.map((r: any) => r.text ?? "").join("").trim();
    // Formula with cached result
    if ("result" in v) return String((v as any).result ?? "").trim();
    // SharedFormula
    if ("formula" in v) return String((v as any).result ?? "").trim();
    // Date
    if (v instanceof Date) return v.toLocaleDateString();
  }
  return String(v).trim();
}

function cellNum(cell: ExcelJS.Cell): number | null {
  const t = cellText(cell);
  if (!t) return null;
  const cleaned = t.replace(/[$%,\s]/g, "");
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  // Normalise rates: if > 1 and the original string contained %, treat as percent
  if (t.includes("%") && n > 1) return n / 100;
  if (!t.includes("%") && n > 1 && n <= 100) return n / 100; // bare number like "10" = 10%
  return n;
}

function isBold(cell: ExcelJS.Cell): boolean {
  return !!(cell?.font?.bold);
}

// ── Summary Sheet Parsing ─────────────────────────────────────────────────────

const LABEL_PATTERNS: Array<[RegExp, keyof MigratedProjectInfo]> = [
  [/project\s*name/i,              "projectName"],
  [/project\s*(?:id|number|#)/i,   "projectId"],
  [/region|airport\s*code/i,       "regionCode"],
  [/due\s*date|bid\s*date/i,       "dueDate"],
  [/address|project\s*address|site\s*address/i, "projectAddress"],
  [/gc[\s\/]?(owner)?|general\s*contractor|client/i, "gcContact"],
  [/estimator|prepared\s*by/i,     "estimator"],
  [/anticipated\s*start|start\s*date|construction\s*start/i, "anticipatedStart"],
  [/anticipated\s*finish|completion|end\s*date/i, "anticipatedFinish"],
  [/tax\s*rate|sales\s*tax/i,      "taxRate"],
  [/overhead|oh\s*%|o\s*&\s*p/i,   "defaultOh"],
  [/escalat|esc\s*%/i,             "defaultEsc"],
  [/fee\s*%|profit|margin/i,       "oldFee"],
  [/bond\s*rate|bond\s*%/i,        "oldBondRate"],
];

function parseSummarySheet(
  ws: ExcelJS.Worksheet,
  stampMappings: Array<{ cellRef: string; fieldName: string }>,
  info: MigratedProjectInfo,
) {
  // Pass 1 — stamp-mapped cells (e.g. AB1–AB4)
  for (const mapping of stampMappings) {
    const parts = mapping.cellRef.includes("!")
      ? mapping.cellRef.split("!")
      : [ws.name, mapping.cellRef];
    const sheetName = parts[0].replace(/^'|'$/g, "");
    if (sheetName.toLowerCase() !== ws.name.toLowerCase()) continue;
    const cellAddr = parts[1];
    const val = cellText(ws.getCell(cellAddr));
    if (val && mapping.fieldName in info) {
      (info as any)[mapping.fieldName] = val;
    }
  }

  // Pass 2 — label scan rows 1–40
  ws.eachRow((row, rowNum) => {
    if (rowNum > 40) return;
    // Check col A or B for a label, then read adjacent cell
    for (const labelCol of [1, 2]) {
      const labelCell = row.getCell(labelCol);
      const labelText = cellText(labelCell);
      if (!labelText) continue;

      for (const [pattern, field] of LABEL_PATTERNS) {
        if (!pattern.test(labelText)) continue;
        // Read value from next column
        const valueCell = row.getCell(labelCol + 1);
        const val = cellText(valueCell);
        if (!val) {
          // Try two columns over
          const val2 = cellText(row.getCell(labelCol + 2));
          if (val2 && !(info as any)[field]) {
            if (["taxRate", "defaultOh", "defaultEsc", "oldFee", "oldBondRate"].includes(field)) {
              (info as any)[field] = cellNum(row.getCell(labelCol + 2));
            } else {
              (info as any)[field] = val2;
            }
          }
          break;
        }
        if (!(info as any)[field]) {
          if (["taxRate", "defaultOh", "defaultEsc", "oldFee", "oldBondRate"].includes(field)) {
            (info as any)[field] = cellNum(valueCell);
          } else {
            (info as any)[field] = val;
          }
        }
        break;
      }
    }
  });
}

// ── Scope Sheet Column Detection ──────────────────────────────────────────────

interface ColMap {
  callout?: number;
  desc?: number;
  model?: number;
  qty?: number;
  unitCost?: number;
  manufacturer?: number;
  note?: number;
}

function detectHeaderRow(ws: ExcelJS.Worksheet): { rowNum: number; colMap: ColMap } | null {
  let result: { rowNum: number; colMap: ColMap } | null = null;
  ws.eachRow((row, rowNum) => {
    if (result || rowNum > 20) return;
    const colMap: ColMap = {};
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const h = norm(cellText(cell));
      if (!h) return;

      if (colMap.callout === undefined && (h === "callout" || h === "tag" || h === "item" || h === "id" || h === "no" || h === "num" || h === "itm"))
        colMap.callout = colNum;
      else if (colMap.desc === undefined && (h.startsWith("desc") || h === "product" || h === "scope" || h === "name" || h === "specification"))
        colMap.desc = colNum;
      else if (colMap.model === undefined && (h.startsWith("model") || h.startsWith("part") || h.startsWith("catalog") || h === "spec"))
        colMap.model = colNum;
      else if (colMap.qty === undefined && (h === "qty" || h.startsWith("quantity") || h === "count" || h === "ea" || h === "units"))
        colMap.qty = colNum;
      else if (colMap.unitCost === undefined && (h === "unitcost" || h === "unitprice" || h === "priceper" || h === "costper" || h === "eachprice" || h === "price" || h === "cost" || h === "unitmat" || h === "uprice" || h === "each"))
        colMap.unitCost = colNum;
      else if (colMap.manufacturer === undefined && (h === "manufacturer" || h === "mfr" || h === "make" || h === "brand"))
        colMap.manufacturer = colNum;
      else if (colMap.note === undefined && (h === "note" || h === "notes" || h === "comment" || h === "remark" || h === "remarks" || h === "source"))
        colMap.note = colNum;
    });

    if (colMap.desc !== undefined) {
      result = { rowNum, colMap };
    }
  });
  return result;
}

function extractCsiAndTitle(ws: ExcelJS.Worksheet, headerRow: number): { csi: string; specTitle: string } {
  let csi = "";
  let specTitle = "";
  ws.eachRow((row, rowNum) => {
    if (rowNum >= headerRow) return;
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      if (colNum > 6) return;
      const val = cellText(cell);
      if (!val) return;
      if (!csi && CSI_RE.test(val)) {
        csi = val;
      } else if (!specTitle && val.length > 8 && !/^\d/.test(val) && val !== csi) {
        specTitle = val;
      }
    });
  });
  return { csi, specTitle };
}

// ── Quals/Exclusions Extraction ───────────────────────────────────────────────

const QUAL_PATTERNS: Array<[RegExp, "inclusions" | "exclusions" | "qualifications"]> = [
  [/^inclusions?|^includes?/i,              "inclusions"],
  [/^exclusions?|^excludes?|^not\s+included/i, "exclusions"],
  [/^qualifications?|^quals?|^assumptions?/i, "qualifications"],
  [/^notes?$/i,                              "qualifications"],
];

function extractQuals(ws: ExcelJS.Worksheet, tableEndRow: number, scope: MigratedScope) {
  let currentBucket: "inclusions" | "exclusions" | "qualifications" | null = null;
  const rawLines: string[] = [];
  let foundKeyword = false;

  ws.eachRow((row, rowNum) => {
    if (rowNum <= tableEndRow) return;
    const texts: string[] = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      const t = cellText(cell);
      if (t) texts.push(t);
    });
    if (texts.length === 0) return;
    const firstText = texts[0];

    // Check if this row is a keyword header
    let matched: "inclusions" | "exclusions" | "qualifications" | null = null;
    for (const [pat, bucket] of QUAL_PATTERNS) {
      if (pat.test(firstText.trim())) {
        matched = bucket;
        break;
      }
    }

    if (matched) {
      currentBucket = matched;
      foundKeyword = true;
      return;
    }

    if (currentBucket) {
      scope[currentBucket].push(...texts.filter(Boolean));
    } else {
      rawLines.push(...texts.filter(Boolean));
    }
  });

  if (!foundKeyword && rawLines.length > 2) {
    scope.rawQualText = rawLines.join("\n");
  }
}

// ── Per-scope override detection ──────────────────────────────────────────────

function detectScopeOverrides(ws: ExcelJS.Worksheet, headerRow: number): MigratedCatOverride | null {
  let oh: number | null = null;
  let esc: number | null = null;

  ws.eachRow((row, rowNum) => {
    if (rowNum >= headerRow) return;
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const t = cellText(cell);
      if (!t) return;
      if (/^overhead|^oh\s*%/i.test(t)) {
        const valCell = row.getCell(colNum + 1);
        const n = cellNum(valCell);
        if (n !== null) oh = n;
      }
      if (/^escalat|^esc\s*%/i.test(t)) {
        const valCell = row.getCell(colNum + 1);
        const n = cellNum(valCell);
        if (n !== null) esc = n;
      }
    });
  });

  if (oh !== null || esc !== null) {
    return { scopeKey: ws.name, ohOverride: oh, escOverride: esc };
  }
  return null;
}

// ── Scope Sheet Parsing ───────────────────────────────────────────────────────

function parseScopeSheet(ws: ExcelJS.Worksheet): MigratedScope | null {
  const headerResult = detectHeaderRow(ws);
  if (!headerResult) return null;

  const { rowNum: headerRow, colMap } = headerResult;
  const { csi, specTitle } = extractCsiAndTitle(ws, headerRow);

  const lineItems: MigratedLineItem[] = [];
  let consecutiveEmpty = 0;
  let tableEndRow = headerRow;

  ws.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return;

    const desc = colMap.desc !== undefined ? cellText(row.getCell(colMap.desc)) : "";
    if (!desc) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) tableEndRow = Math.min(tableEndRow, rowNum - 3);
      return;
    }
    consecutiveEmpty = 0;
    if (tableEndRow === headerRow) tableEndRow = rowNum; // update lazily

    const callout = colMap.callout !== undefined ? cellText(row.getCell(colMap.callout)) : "";
    const model = colMap.model !== undefined ? cellText(row.getCell(colMap.model)) : "";
    const manufacturer = colMap.manufacturer !== undefined ? cellText(row.getCell(colMap.manufacturer)) : "";
    const note = colMap.note !== undefined ? cellText(row.getCell(colMap.note)) : "";

    let qty = 0;
    if (colMap.qty !== undefined) {
      qty = parseFloat(cellText(row.getCell(colMap.qty)).replace(/[^0-9.\-]/g, "")) || 0;
    }

    let unitCost = 0;
    if (colMap.unitCost !== undefined) {
      unitCost = parseFloat(cellText(row.getCell(colMap.unitCost)).replace(/[^0-9.\-]/g, "")) || 0;
    }

    lineItems.push({
      callout,
      description: desc,
      model,
      manufacturer,
      qty,
      unitCost,
      extendedCost: qty * unitCost,
      note,
      sourceRow: rowNum,
    });
  });

  if (lineItems.length === 0) return null;

  const preMarkupSubtotal = lineItems.reduce((s, i) => s + i.extendedCost, 0);

  const scope: MigratedScope = {
    sheetName: ws.name,
    csiCode: csi,
    specTitle: specTitle || ws.name,
    lineItems,
    preMarkupSubtotal,
    inclusions: [],
    exclusions: [],
    qualifications: [],
    rawQualText: null,
  };

  extractQuals(ws, tableEndRow, scope);
  return scope;
}

// ── Main Export ───────────────────────────────────────────────────────────────

export async function parseOldEstimate(
  fileBuffer: Buffer,
  stampMappings: Array<{ cellRef: string; fieldName: string }> = [],
): Promise<ParsedOldEstimate> {
  const warnings: string[] = [];
  const parseErrors: string[] = [];

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(fileBuffer);
  } catch (err) {
    parseErrors.push(`Failed to load workbook: ${(err as Error).message}`);
    return {
      projectInfo: {
        projectName: "", projectId: "", regionCode: "", dueDate: "",
        projectAddress: null, gcContact: null, estimator: null,
        anticipatedStart: null, anticipatedFinish: null,
        taxRate: null, defaultOh: null, defaultEsc: null,
        oldFee: null, oldBondRate: null,
      },
      scopes: [],
      catOverrides: [],
      scopeMappings: [],
      warnings,
      parseErrors,
      parsedAt: new Date().toISOString(),
    };
  }

  const info: MigratedProjectInfo = {
    projectName: "", projectId: "", regionCode: "", dueDate: "",
    projectAddress: null, gcContact: null, estimator: null,
    anticipatedStart: null, anticipatedFinish: null,
    taxRate: null, defaultOh: null, defaultEsc: null,
    oldFee: null, oldBondRate: null,
  };

  // Find and parse summary sheet
  const summaryWs =
    wb.getWorksheet("Summary Sheet") ||
    wb.getWorksheet("Summary") ||
    wb.getWorksheet("Cover") ||
    wb.worksheets[0];

  if (summaryWs) {
    parseSummarySheet(summaryWs, stampMappings, info);
  } else {
    warnings.push("No Summary Sheet found — project metadata may be incomplete");
  }

  // Also try B1 as fallback for project name
  if (!info.projectName && summaryWs) {
    const b1 = cellText(summaryWs.getCell("B1"));
    if (b1) info.projectName = b1;
  }

  const scopes: MigratedScope[] = [];
  const catOverrides: MigratedCatOverride[] = [];

  wb.eachSheet((ws) => {
    const sheetNorm = ws.name.toLowerCase().trim();
    if (SKIP_SHEETS.has(sheetNorm)) return;

    const scope = parseScopeSheet(ws);
    if (!scope) {
      warnings.push(`Sheet "${ws.name}" skipped — no valid line item table detected`);
      return;
    }

    scopes.push(scope);

    // Check for per-scope overrides above header row
    const headerResult = detectHeaderRow(ws);
    if (headerResult) {
      const override = detectScopeOverrides(ws, headerResult.rowNum);
      if (override) catOverrides.push(override);
    }
  });

  if (scopes.length === 0) {
    parseErrors.push("No scope sheets with line items were found in this file");
  }

  return {
    projectInfo: info,
    scopes,
    catOverrides,
    scopeMappings: [], // populated during template population
    warnings,
    parseErrors,
    parsedAt: new Date().toISOString(),
  };
}
