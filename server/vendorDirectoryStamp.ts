// ─────────────────────────────────────────────────────────────────────────────
// Write the Vendor Directory tab of an estimate workbook.
//
// WHY THIS IS THE ONLY SHEET WE TOUCH
// Every scope tab already pulls its own RFQ list out of this one table with a
// dynamic-array formula of the form
//
//   FILTER(tblVendorDirectory[Contact Name],
//          (TRIM(tblVendorDirectory[Scope]) = "Toilet Accessories")
//          * ((tblVendorDirectory[Contact Name]<>"") + ... > 0))
//
// so writing the table is enough — the 23 scope tabs, the RFQ LOG and RFQ LINES
// all follow automatically. Writing vendor names onto a scope tab instead would
// overwrite those formulas and permanently sever the link.
//
// HARD RULES, each learned from the template rather than assumed:
//  * Column A (Scope) is PRE-FILLED and must never be written. The FILTER above
//    compares it to a literal scope string, so a changed or blanked value makes
//    that scope tab's RFQ list silently come back empty.
//  * Columns F/G/H must never be written. G2:G25 is the source of the workbook's
//    `UOM_Options` defined name
//    (OFFSET('Vendor Directory'!$G$2,0,0,COUNTA('Vendor Directory'!$G$2:$G$25),1)),
//    which feeds every UOM dropdown in the workbook.
//  * Alternate 1/2/3 blocks are reserved for the estimator's manual entry.
//  * Block sizes are DISCOVERED by reading column A, never hardcoded, so this
//    keeps working when the blocks are resized in the template.
//  * A row is cleared by deleting its cells, not by writing "" — the FILTER's
//    <>"" test is what decides whether a row appears at all.
// ─────────────────────────────────────────────────────────────────────────────

import { MANUAL_ONLY_SCOPE_BLOCKS, VENDOR_DIRECTORY_SCOPES, type VendorDirectoryScope } from "@shared/vendorDirectoryScopes";
import type { SheetPatch, StampCell } from "./estimateTemplateStamp";
import type { VendorDirectoryRowsByScope } from "./vendorDirectoryRows";

export const VENDOR_DIRECTORY_SHEET_NAME = "Vendor Directory";

/** Column A holds the scope; B-E are the four data columns we write. */
const COL_CONTACT = "B";
const COL_EMAIL = "C";
const COL_VENDOR = "D";
const COL_MANUFACTURER = "E";

/** Row 1 is the table header; data begins at row 2. */
const FIRST_DATA_ROW = 2;

/** A contiguous run of rows in column A carrying the same scope label. */
export interface ScopeBlock {
  scope: string;
  firstRow: number;
  lastRow: number;
  size: number;
}

/**
 * Find each scope's block by walking column A. Returns blocks in sheet order.
 *
 * Contiguity matters: the template's blocks are contiguous runs, and a row's
 * membership is decided purely by its own column-A value, so we group on that
 * and never assume a block order or size. A scope appearing in two separate runs
 * (someone inserted rows) yields two blocks, both of which get used in order.
 */
export function findScopeBlocks(colA: Map<number, string>): ScopeBlock[] {
  // forEach rather than spreading colA.keys(): this project's tsconfig sets no
  // `target`, so iterating a Map iterator directly needs --downlevelIteration.
  const rows: number[] = [];
  colA.forEach((_v, r) => { if (r >= FIRST_DATA_ROW) rows.push(r); });
  rows.sort((a, b) => a - b);
  const blocks: ScopeBlock[] = [];
  for (const r of rows) {
    const scope = (colA.get(r) ?? "").trim();
    if (!scope) continue;
    const last = blocks[blocks.length - 1];
    if (last && last.scope === scope && last.lastRow === r - 1) {
      last.lastRow = r;
      last.size = last.lastRow - last.firstRow + 1;
    } else {
      blocks.push({ scope, firstRow: r, lastRow: r, size: 1 });
    }
  }
  return blocks;
}

export interface VendorDirectoryPlan {
  cells: StampCell[];
  clearRefs: string[];
  /** Per-scope outcome, for logging and for the overflow warning. */
  written: Array<{ scope: string; rows: number; capacity: number; dropped: number }>;
  /** Scope blocks present in the template that we have no rows for. */
  emptied: string[];
  /** Scopes we have rows for but found no block for in the template. */
  unplaceable: string[];
}

/**
 * Turn the rows from the database into a concrete set of cell writes and clears
 * against the blocks actually present in this workbook.
 *
 * Every non-Alternate block is cleared across B:E first, so a generated workbook
 * can never mix fresh database rows with the template's hand-entered leftovers.
 */
export function planVendorDirectory(
  colA: Map<number, string>,
  rowsByScope: VendorDirectoryRowsByScope,
): VendorDirectoryPlan {
  const blocks = findScopeBlocks(colA);
  const manual = new Set<string>(MANUAL_ONLY_SCOPE_BLOCKS);

  const cells: StampCell[] = [];
  const clearRefs: string[] = [];
  const written: VendorDirectoryPlan["written"] = [];
  const emptied: string[] = [];
  const placedScopes = new Set<string>();

  for (const block of blocks) {
    // Never touch the estimator's manual Alternate blocks.
    if (manual.has(block.scope)) continue;

    // Clear the whole block's data columns. Stale hand-entered rows in a scope
    // we have no data for must disappear too, otherwise the generated workbook
    // silently keeps them.
    for (let r = block.firstRow; r <= block.lastRow; r++) {
      clearRefs.push(`${COL_CONTACT}${r}`, `${COL_EMAIL}${r}`, `${COL_VENDOR}${r}`, `${COL_MANUFACTURER}${r}`);
    }

    const rows = rowsByScope.get(block.scope as VendorDirectoryScope) ?? [];
    if (rows.length === 0) {
      if (!placedScopes.has(block.scope)) emptied.push(block.scope);
      placedScopes.add(block.scope);
      written.push({ scope: block.scope, rows: 0, capacity: block.size, dropped: 0 });
      continue;
    }

    // A scope split across two runs: the first block takes the first N rows,
    // a later block continues. Track how many of this scope's rows are spoken for.
    const alreadyPlaced = written
      .filter((w) => w.scope === block.scope)
      .reduce((n, w) => n + w.rows, 0);
    const remaining = rows.slice(alreadyPlaced);
    const take = Math.min(remaining.length, block.size);

    for (let i = 0; i < take; i++) {
      const row = remaining[i];
      const r = block.firstRow + i;
      // Empty strings are skipped by the writer, which is what we want: the
      // cell was just cleared, so skipping leaves it genuinely absent.
      cells.push({ ref: `${COL_CONTACT}${r}`, value: row.contactName, type: "string" });
      cells.push({ ref: `${COL_EMAIL}${r}`, value: row.email, type: "string" });
      cells.push({ ref: `${COL_VENDOR}${r}`, value: row.vendor, type: "string" });
      cells.push({ ref: `${COL_MANUFACTURER}${r}`, value: row.manufacturer, type: "string" });
    }

    written.push({
      scope: block.scope,
      rows: take,
      capacity: block.size,
      dropped: Math.max(0, remaining.length - take),
    });
    placedScopes.add(block.scope);
  }

  // Scopes we have vendors for but which have no block in this template at all.
  const blockScopes = new Set(blocks.map((b) => b.scope));
  const unplaceable = VENDOR_DIRECTORY_SCOPES.filter(
    (s) => (rowsByScope.get(s)?.length ?? 0) > 0 && !blockScopes.has(s),
  );

  return { cells, clearRefs, written, emptied, unplaceable };
}

/**
 * Build the SheetPatch for the Vendor Directory. The plan is computed inside
 * `resolve` so block discovery reads the workbook's own column A during the
 * single zip pass that stampWorkbookSheets already makes.
 *
 * Returns null when the workbook has no Vendor Directory tab — older templates
 * don't, and a missing tab must degrade to "header fields only", never throw.
 */
export function buildVendorDirectoryPatch(
  rowsByScope: VendorDirectoryRowsByScope,
  onPlan?: (plan: VendorDirectoryPlan) => void,
): SheetPatch {
  return {
    sheetName: VENDOR_DIRECTORY_SHEET_NAME,
    optional: true,
    resolve: ({ readColumn }) => {
      const plan = planVendorDirectory(readColumn("A"), rowsByScope);
      onPlan?.(plan);
      return { cells: plan.cells, clearRefs: plan.clearRefs };
    },
  };
}

/** Does this workbook have a Vendor Directory tab? Cheap check against the
 *  sheet-name list the template record already caches. */
export function hasVendorDirectorySheet(sheetNames: string[] | null | undefined): boolean {
  return (sheetNames ?? []).some((n) => n.trim().toLowerCase() === VENDOR_DIRECTORY_SHEET_NAME.toLowerCase());
}

/** One-line summary for the server log. */
export function summarizeVendorDirectoryPlan(plan: VendorDirectoryPlan): string {
  const total = plan.written.reduce((n, w) => n + w.rows, 0);
  const dropped = plan.written.reduce((n, w) => n + w.dropped, 0);
  const over = plan.written.filter((w) => w.dropped > 0).map((w) => `${w.scope} +${w.dropped}`);
  const parts = [`${total} rows across ${plan.written.filter((w) => w.rows > 0).length} scopes`];
  if (dropped > 0) parts.push(`${dropped} rows did NOT fit (${over.join(", ")})`);
  if (plan.emptied.length) parts.push(`no vendors for: ${plan.emptied.join(", ")}`);
  if (plan.unplaceable.length) parts.push(`no block in template for: ${plan.unplaceable.join(", ")}`);
  return parts.join("; ");
}
