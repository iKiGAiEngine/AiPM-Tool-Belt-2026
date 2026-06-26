import type { Express, Request, Response } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import type { StampMapping } from "@shared/schema";
import {
  getActiveEstimateTemplate,
  getEstimateTemplateFileBuffer,
} from "./templateStorage";
import {
  parseOldEstimate,
  type ParsedOldEstimate,
  type MigratedScopeMapping,
} from "./estimateMigrationParser";

const migrateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm)$/i.test(file.originalname);
    cb(ok ? null : new Error("Only .xlsx or .xlsm files are accepted"), ok);
  },
});

// ── Template population helpers ───────────────────────────────────────────────

const CSI_RE = /^10[\s\-]?\d{2}[\s\-]?\d{0,2}/;

function normSheet(name: string): string {
  return name.toLowerCase().trim();
}

function extractCsiFromName(name: string): string {
  const m = name.match(CSI_RE);
  return m ? m[0].replace(/[\s\-]/g, "") : "";
}

function matchScopeToTemplate(
  oldSheetName: string,
  oldCsi: string,
  oldTitle: string,
  templateSheetNames: string[],
): { sheetName: string | null; matchBasis: MigratedScopeMapping["matchBasis"] } {
  const normOld = normSheet(oldSheetName);
  const oldCsiNorm = oldCsi.replace(/[\s\-]/g, "");

  // 1. Exact name
  for (const tName of templateSheetNames) {
    if (normSheet(tName) === normOld) return { sheetName: tName, matchBasis: "exact" };
  }

  // 2. CSI code match
  if (oldCsiNorm) {
    for (const tName of templateSheetNames) {
      const tCsi = extractCsiFromName(tName);
      if (tCsi && tCsi === oldCsiNorm) return { sheetName: tName, matchBasis: "csi" };
    }
  }

  // 3. Fuzzy — sheet name or title contains first meaningful word
  const titleWords = oldTitle.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 3);
  if (titleWords.length > 0) {
    for (const tName of templateSheetNames) {
      const normT = normSheet(tName);
      if (titleWords.some(w => normT.includes(w))) return { sheetName: tName, matchBasis: "fuzzy" };
    }
  }
  // Also try old sheet name words
  const oldWords = normOld.replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 3);
  for (const tName of templateSheetNames) {
    const normT = normSheet(tName);
    if (oldWords.some(w => normT.includes(w))) return { sheetName: tName, matchBasis: "fuzzy" };
  }

  return { sheetName: null, matchBasis: "unmapped" };
}

function cellTextWb(cell: ExcelJS.Cell): string {
  if (!cell || cell.value == null) return "";
  const v = cell.value;
  if (typeof v === "object" && v !== null) {
    if ("richText" in v) return (v as any).richText.map((r: any) => r.text ?? "").join("").trim();
    if ("result" in v) return String((v as any).result ?? "").trim();
    if ("formula" in v) return String((v as any).result ?? "").trim();
    if (v instanceof Date) return v.toLocaleDateString();
  }
  return String(v).trim();
}

function normHeader(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface ColMap { callout?: number; desc?: number; model?: number; qty?: number; unitCost?: number; manufacturer?: number; note?: number; }

function detectCols(ws: ExcelJS.Worksheet): { rowNum: number; colMap: ColMap } | null {
  let result: { rowNum: number; colMap: ColMap } | null = null;
  ws.eachRow((row, rowNum) => {
    if (result || rowNum > 25) return;
    const colMap: ColMap = {};
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const h = normHeader(cellTextWb(cell));
      if (!h) return;
      if (colMap.callout === undefined && (h === "callout" || h === "tag" || h === "item" || h === "id" || h === "no" || h === "num" || h === "itm")) colMap.callout = colNum;
      else if (colMap.desc === undefined && (h.startsWith("desc") || h === "product" || h === "scope" || h === "name" || h === "specification")) colMap.desc = colNum;
      else if (colMap.model === undefined && (h.startsWith("model") || h.startsWith("part") || h.startsWith("catalog") || h === "spec")) colMap.model = colNum;
      else if (colMap.qty === undefined && (h === "qty" || h.startsWith("quantity") || h === "count" || h === "ea" || h === "units")) colMap.qty = colNum;
      else if (colMap.unitCost === undefined && (h === "unitcost" || h === "unitprice" || h === "priceper" || h === "costper" || h === "eachprice" || h === "price" || h === "cost" || h === "unitmat" || h === "uprice" || h === "each")) colMap.unitCost = colNum;
      else if (colMap.manufacturer === undefined && (h === "manufacturer" || h === "mfr" || h === "make" || h === "brand")) colMap.manufacturer = colNum;
      else if (colMap.note === undefined && (h === "note" || h === "notes" || h === "comment" || h === "remark" || h === "remarks" || h === "source")) colMap.note = colNum;
    });
    if (colMap.desc !== undefined) result = { rowNum, colMap };
  });
  return result;
}

const RATE_LABEL_PATTERNS: Array<[RegExp, "oh" | "esc" | "tax"]> = [
  [/overhead|oh\s*%|o\s*&\s*p/i, "oh"],
  [/escalat|esc\s*%/i,           "esc"],
  [/tax\s*rate|sales\s*tax/i,    "tax"],
];

function writeRatesToSheet(
  ws: ExcelJS.Worksheet,
  oh: number | null,
  esc: number | null,
  tax: number | null,
) {
  ws.eachRow((row, rowNum) => {
    if (rowNum > 60) return;
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const t = cellTextWb(cell);
      for (const [pat, field] of RATE_LABEL_PATTERNS) {
        if (!pat.test(t)) continue;
        const target = row.getCell(colNum + 1);
        const target2 = row.getCell(colNum + 2);
        // Prefer writing to the cell that has a numeric value already or is empty
        const writeCell = cellTextWb(target2) === "" ? target : target;
        if (field === "oh" && oh !== null) writeCell.value = oh;
        else if (field === "esc" && esc !== null) writeCell.value = esc;
        else if (field === "tax" && tax !== null) writeCell.value = tax;
        break;
      }
    });
  });
}

async function populateTemplate(
  templateBuffer: Buffer,
  parsed: ParsedOldEstimate,
  stampMappings: StampMapping[],
  templateSheetNames: string[],
): Promise<{ buffer: Buffer; mappings: MigratedScopeMapping[]; warnings: string[] }> {
  const warnings: string[] = [...parsed.warnings];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuffer);

  // Step 2 — Apply stamp mappings (projectName, projectId, regionCode, dueDate)
  const stampFieldMap: Record<string, string> = {
    projectName: parsed.projectInfo.projectName,
    projectId: parsed.projectInfo.projectId,
    regionCode: parsed.projectInfo.regionCode,
    dueDate: parsed.projectInfo.dueDate,
    projectAddress: parsed.projectInfo.projectAddress ?? "",
    gcContact: parsed.projectInfo.gcContact ?? "",
    estimator: parsed.projectInfo.estimator ?? "",
    anticipatedStart: parsed.projectInfo.anticipatedStart ?? "",
    anticipatedFinish: parsed.projectInfo.anticipatedFinish ?? "",
  };

  for (const mapping of stampMappings) {
    const val = stampFieldMap[mapping.fieldName];
    if (val === undefined) continue;
    const parts = mapping.cellRef.includes("!") ? mapping.cellRef.split("!") : [null, mapping.cellRef];
    const sheetName = parts[0]?.replace(/^'|'$/g, "") ?? null;
    const cellAddr = parts[1];
    const targetWs = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
    if (!targetWs) continue;
    if (val) targetWs.getCell(cellAddr).value = val;
  }

  // Step 2b — Write carried-over rates to Summary Sheet
  const summaryWs =
    wb.getWorksheet("Summary Sheet") ||
    wb.getWorksheet("Summary") ||
    wb.worksheets[0];

  if (summaryWs) {
    writeRatesToSheet(
      summaryWs,
      parsed.projectInfo.defaultOh,
      parsed.projectInfo.defaultEsc,
      parsed.projectInfo.taxRate,
    );
  }

  // Step 3 — Scope matching
  const scopeMappings: MigratedScopeMapping[] = [];

  for (const scope of parsed.scopes) {
    const { sheetName: newSheet, matchBasis } = matchScopeToTemplate(
      scope.sheetName,
      scope.csiCode,
      scope.specTitle,
      templateSheetNames,
    );

    scopeMappings.push({
      oldSheetName: scope.sheetName,
      newSheetName: newSheet,
      csiCode: scope.csiCode,
      matchBasis,
      warning: matchBasis === "unmapped"
        ? `No matching sheet found for "${scope.sheetName}" — items moved to "Migrated Data" sheet`
        : matchBasis === "fuzzy"
        ? `Fuzzy match: "${scope.sheetName}" → "${newSheet}"`
        : null,
    });
  }

  // Step 4 — Write line items per matched scope sheet
  for (const scope of parsed.scopes) {
    const mapping = scopeMappings.find(m => m.oldSheetName === scope.sheetName);
    if (!mapping || !mapping.newSheetName) continue;

    const ws = wb.getWorksheet(mapping.newSheetName);
    if (!ws) continue;

    const headerResult = detectCols(ws);
    if (!headerResult) {
      warnings.push(`Could not detect header row in template sheet "${mapping.newSheetName}" — items skipped`);
      continue;
    }

    const { rowNum: headerRow, colMap } = headerResult;

    // Find first empty row after header
    let insertRow = headerRow + 1;
    ws.eachRow((row, rowNum) => {
      if (rowNum <= headerRow) return;
      if (colMap.desc !== undefined && cellTextWb(row.getCell(colMap.desc))) {
        insertRow = rowNum + 1;
      }
    });

    // Insert rows to avoid overwriting formula rows
    if (scope.lineItems.length > 0) {
      ws.spliceRows(insertRow, 0, ...Array(scope.lineItems.length).fill([]));
    }

    for (let i = 0; i < scope.lineItems.length; i++) {
      const item = scope.lineItems[i];
      const dataRow = ws.getRow(insertRow + i);

      if (colMap.callout !== undefined && item.callout) dataRow.getCell(colMap.callout).value = item.callout;
      if (colMap.desc !== undefined) dataRow.getCell(colMap.desc).value = item.description;
      if (colMap.model !== undefined && item.model) dataRow.getCell(colMap.model).value = item.model;
      if (colMap.qty !== undefined) dataRow.getCell(colMap.qty).value = item.qty || null;
      if (colMap.unitCost !== undefined && item.unitCost) dataRow.getCell(colMap.unitCost).value = item.unitCost;
      if (colMap.manufacturer !== undefined && item.manufacturer) dataRow.getCell(colMap.manufacturer).value = item.manufacturer;
      if (colMap.note !== undefined && item.note) dataRow.getCell(colMap.note).value = item.note;
      dataRow.commit();
    }

    // Write per-scope OH/Esc overrides if found
    const catOverride = parsed.catOverrides.find(co => co.scopeKey === scope.sheetName);
    if (catOverride) {
      writeRatesToSheet(ws, catOverride.ohOverride, catOverride.escOverride, null);
    }
  }

  // Step 5 — Unmapped scopes → "Migrated Data" sheet
  const unmapped = parsed.scopes.filter(s =>
    scopeMappings.find(m => m.oldSheetName === s.sheetName)?.matchBasis === "unmapped"
  );

  if (unmapped.length > 0) {
    let migratedWs = wb.getWorksheet("Migrated Data");
    if (!migratedWs) migratedWs = wb.addWorksheet("Migrated Data");

    const headers = ["Scope", "CSI Code", "Callout", "Description", "Model", "Manufacturer", "Qty", "Unit Cost", "Extended", "Note"];
    const headerRow = migratedWs.addRow(headers);
    headerRow.font = { bold: true };

    for (const scope of unmapped) {
      // Scope group header
      const scopeHeader = migratedWs.addRow([scope.specTitle || scope.sheetName]);
      scopeHeader.font = { bold: true, italic: true };

      for (const item of scope.lineItems) {
        migratedWs.addRow([
          scope.sheetName,
          scope.csiCode,
          item.callout,
          item.description,
          item.model,
          item.manufacturer,
          item.qty || "",
          item.unitCost || "",
          item.extendedCost || "",
          item.note,
        ]);
      }

      // Subtotal row
      const subtotalRow = migratedWs.addRow(["", "", "", "", "", "Subtotal", "", "", scope.preMarkupSubtotal, ""]);
      subtotalRow.font = { bold: true };
      migratedWs.addRow([]);
    }

    migratedWs.columns = [
      { width: 22 }, { width: 10 }, { width: 10 }, { width: 35 }, { width: 18 },
      { width: 18 }, { width: 7 }, { width: 12 }, { width: 12 }, { width: 25 },
    ];
  }

  parsed.scopeMappings = scopeMappings;
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, mappings: scopeMappings, warnings };
}

// ── Route Registration ────────────────────────────────────────────────────────

export function registerEstimateMigrationRoutes(app: Express) {
  // Parse only — returns JSON preview, no template lookup
  app.post(
    "/api/estimates/migrate/parse",
    migrateUpload.single("oldEstimate"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const parsed = await parseOldEstimate(req.file.buffer, []);

        if (parsed.parseErrors.length > 0 && parsed.scopes.length === 0) {
          return res.status(422).json({ message: parsed.parseErrors[0], parseErrors: parsed.parseErrors });
        }

        return res.json(parsed);
      } catch (err) {
        console.error("[EstimateMigration] Parse error:", err);
        return res.status(500).json({ message: "Failed to parse estimate file" });
      }
    },
  );

  // Full migration — parse + populate active template, return xlsx download
  app.post(
    "/api/estimates/migrate",
    migrateUpload.single("oldEstimate"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        // Load active template
        const template = await getActiveEstimateTemplate();
        if (!template) {
          return res.status(404).json({ message: "No active estimate template found. Please activate one in Admin → Templates." });
        }

        const templateBuffer = await getEstimateTemplateFileBuffer(template);
        if (!templateBuffer) {
          return res.status(503).json({ message: "Active estimate template file could not be loaded. Please re-upload it." });
        }

        // Parse old estimate using the template's stamp mappings for known cell locations
        const parsed = await parseOldEstimate(req.file.buffer, template.stampMappings ?? []);

        if (parsed.parseErrors.length > 0 && parsed.scopes.length === 0) {
          return res.status(422).json({ message: parsed.parseErrors[0], parseErrors: parsed.parseErrors });
        }

        // Populate template
        const { buffer, mappings, warnings } = await populateTemplate(
          templateBuffer,
          parsed,
          template.stampMappings ?? [],
          template.sheetNames ?? [],
        );

        const safeName = (parsed.projectInfo.projectName || "Estimate")
          .replace(/[^a-zA-Z0-9\s\-_]/g, "")
          .trim()
          .slice(0, 60);
        const dateStr = new Date().toISOString().slice(0, 10);
        const filename = `Migrated_Estimate_${safeName}_${dateStr}.xlsx`;

        // Truncate warnings header to 2KB to stay safe
        const warningsJson = JSON.stringify(warnings).slice(0, 2000);
        const mappingsJson = JSON.stringify(mappings).slice(0, 4000);

        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("X-Migration-Warnings", warningsJson);
        res.setHeader("X-Migration-Mappings", mappingsJson);
        res.setHeader("Access-Control-Expose-Headers", "X-Migration-Warnings, X-Migration-Mappings");

        return res.send(buffer);
      } catch (err) {
        console.error("[EstimateMigration] Migration error:", err);
        return res.status(500).json({ message: "Failed to migrate estimate" });
      }
    },
  );
}
