// ─────────────────────────────────────────────────────────────────────────────
// One entry point for producing a populated estimate workbook.
//
// Four separate paths generate an estimate (project create, download-estimate,
// recreate-folder, BuildingConnected draft approval). Each used to build the
// Summary Sheet cells and call the stamper itself, which meant any new sheet had
// to be wired into four places — and a miss would leave the Vendor Directory
// populated on some routes and blank on others. They all call this instead.
//
// Both sheets are written in a single pass over the workbook zip.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildSummaryStampCells,
  stampWorkbookSheets,
  SUMMARY_SHEET_NAME,
  type SheetPatch,
  type SummaryStampInfo,
} from "./estimateTemplateStamp";
import { buildVendorDirectoryRows, countVendorDirectoryRows } from "./vendorDirectoryRows";
import {
  buildVendorDirectoryPatch,
  summarizeVendorDirectoryPlan,
  type VendorDirectoryPlan,
} from "./vendorDirectoryStamp";

export interface StampEstimateOptions {
  /** Label for log lines, e.g. "ProjectCreate". */
  context?: string;
  /** Skip the Vendor Directory (header fields only). Defaults to false. */
  skipVendorDirectory?: boolean;
}

export interface StampEstimateResult {
  buffer: Buffer;
  summaryCellCount: number;
  vendorDirectory: VendorDirectoryPlan | null;
}

/**
 * Stamp the Summary Sheet header and the Vendor Directory into an estimate
 * template, returning the repackaged workbook.
 *
 * Failure policy matches the existing header-stamping behaviour: the vendor
 * database is best-effort. If reading it fails, the workbook is still produced
 * with its header stamped and the Vendor Directory left exactly as the template
 * had it — a bid folder with a stale vendor tab beats no bid folder at all. A
 * template with no Vendor Directory tab is likewise not an error (the patch is
 * marked optional), so older templates keep working untouched.
 */
export async function stampEstimateWorkbook(
  templateBuffer: Buffer,
  info: SummaryStampInfo,
  opts: StampEstimateOptions = {},
): Promise<StampEstimateResult> {
  const tag = `[stampEstimate${opts.context ? ":" + opts.context : ""}]`;

  const summaryCells = await buildSummaryStampCells(info);
  const patches: SheetPatch[] = [{ sheetName: SUMMARY_SHEET_NAME, cells: summaryCells }];

  // Held in an object rather than a bare `let`: the plan is produced inside a
  // callback that stampWorkbookSheets invokes, which TypeScript's control-flow
  // analysis cannot see, so a bare variable would stay narrowed to `null`.
  const captured: { plan: VendorDirectoryPlan | null } = { plan: null };
  if (!opts.skipVendorDirectory) {
    try {
      const rowsByScope = await buildVendorDirectoryRows();
      const total = countVendorDirectoryRows(rowsByScope);
      if (total > 0) {
        patches.push(buildVendorDirectoryPatch(rowsByScope, (p) => { captured.plan = p; }));
      } else {
        console.warn(`${tag} vendor database returned no rows — leaving Vendor Directory as-is`);
      }
    } catch (err) {
      console.error(`${tag} Failed to read vendor database; Vendor Directory left as-is:`, err);
    }
  }

  const buffer = await stampWorkbookSheets(templateBuffer, patches);

  const plan = captured.plan;
  if (plan) {
    console.log(`${tag} Vendor Directory: ${summarizeVendorDirectoryPlan(plan)}`);
    // Overflow is worth its own line: those vendors exist in AiPM but cannot be
    // shown, because a scope block (and the matching RFQ rows on the scope tab)
    // is only so tall. The fix is to grow the block in the template.
    for (const w of plan.written) {
      if (w.dropped > 0) {
        console.warn(
          `${tag} "${w.scope}" has ${w.rows + w.dropped} vendor rows in AiPM but the template block holds ${w.capacity}` +
            ` — ${w.dropped} not written. Grow the block to show them.`,
        );
      }
    }
  }

  console.log(`${tag} Stamped ${summaryCells.length} header fields${plan ? "" : " (no Vendor Directory)"}; macros preserved`);
  return { buffer, summaryCellCount: summaryCells.length, vendorDirectory: plan };
}
