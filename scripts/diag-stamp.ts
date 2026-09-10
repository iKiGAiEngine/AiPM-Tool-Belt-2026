// Diagnostic: prove the estimate-stamping works against the REAL active
// template and a REAL proposal-log entry, printing every Summary Sheet cell.
//
// Run in the Replit Shell (DATABASE_URL is already set there):
//   npx tsx scripts/diag-stamp.ts                 # newest non-draft entry
//   npx tsx scripts/diag-stamp.ts 26-0142         # by estimate number
//   npx tsx scripts/diag-stamp.ts 137             # by proposal-log entry id
//
// This bypasses the browser, the Folder button, the download, and the zip —
// it exercises exactly the code the Folder button runs (buildSummaryStampCells
// + stampWorkbookCells) so we can see, with certainty, what gets stamped.

import JSZip from "jszip";
import { db } from "../server/db";
import { proposalLogEntries } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { getActiveEstimateTemplate, getEstimateTemplateFileBuffer } from "../server/templateStorage";
import {
  buildSummaryStampCells,
  stampWorkbookCells,
  SUMMARY_SHEET_NAME,
  SUMMARY_CELLS,
} from "../server/estimateTemplateStamp";

async function readCell(buf: Buffer, ref: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const wb = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!wb || !rels) return "(no workbook.xml)";
  const sheetTag = wb.match(new RegExp(`<sheet[^>]*name="${SUMMARY_SHEET_NAME}"[^>]*/?>`, "i"))?.[0];
  if (!sheetTag) return `(no "${SUMMARY_SHEET_NAME}" tab)`;
  const rId = sheetTag.match(/r:id="([^"]+)"/)?.[1];
  const target = rels.match(new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*/?>`, "i"))?.[0]?.match(/Target="([^"]+)"/)?.[1];
  if (!target) return "(no sheet target)";
  const p = target.startsWith("/") ? target.slice(1) : "xl/" + target;
  const xml = await zip.file(p)?.async("string");
  if (!xml) return "(no sheet xml)";
  const cell = xml.match(new RegExp(`<c r="${ref}"[\\s\\S]*?<\\/c>`));
  if (!cell) return "(cell absent)";
  const inline = cell[0].match(/<t[^>]*>([\s\S]*?)<\/t>/);
  const num = cell[0].match(/<v>([\s\S]*?)<\/v>/);
  return inline ? `"${inline[1]}"` : (num ? `${num[1]} (number)` : "(empty)");
}

async function main() {
  const arg = process.argv[2];

  // 1) Active estimate template (exactly what the Folder button uses)
  const tmpl = await getActiveEstimateTemplate();
  if (!tmpl) {
    console.log("❌ No ACTIVE estimate template configured. Set one in Settings → Templates.");
    console.log("   The Folder button has nothing to stamp, so the estimate is omitted/original.");
    process.exit(0);
  }
  const templateBuffer = await getEstimateTemplateFileBuffer(tmpl);
  if (!templateBuffer) {
    console.log(`❌ Active template row exists (v${tmpl.version}) but its file bytes are missing.`);
    process.exit(0);
  }
  console.log(`✔ Active estimate template: v${tmpl.version} "${tmpl.originalFilename || tmpl.filePath}" (${templateBuffer.length} bytes)`);

  // 2) Pick a proposal-log entry
  let entry;
  if (arg && /^\d+$/.test(arg)) {
    [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, parseInt(arg))).limit(1);
  } else if (arg) {
    [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.estimateNumber, arg)).limit(1);
  } else {
    [entry] = await db.select().from(proposalLogEntries).orderBy(desc(proposalLogEntries.id)).limit(1);
  }
  if (!entry) { console.log(`❌ No proposal-log entry found for "${arg ?? "(newest)"}"`); process.exit(0); }
  console.log(`✔ Entry #${entry.id}: "${entry.projectName}"  est#=${entry.estimateNumber}  region=${entry.region}`);
  console.log(`   SP estimator="${entry.selfPerformEstimator ?? ""}"  address="${entry.projectAddress ?? ""}"  due=${entry.dueDate}`);
  console.log(`   anticipatedStart=${entry.anticipatedStart ?? ""}  anticipatedFinish=${entry.anticipatedFinish ?? ""}`);

  // 3) Build cells + stamp — the exact Folder-button code path
  const cells = await buildSummaryStampCells({
    projectName: entry.projectName,
    dueDate: entry.dueDate,
    estimateNumber: entry.estimateNumber,
    projectAddress: entry.projectAddress,
    spEstimator: entry.selfPerformEstimator,
    anticipatedStart: entry.anticipatedStart,
    anticipatedFinish: entry.anticipatedFinish,
  });
  console.log(`\nBuilt ${cells.length} stamp cells: ${cells.map(c => c.ref).join(", ")}`);

  let stamped: Buffer;
  try {
    stamped = await stampWorkbookCells(templateBuffer, SUMMARY_SHEET_NAME, cells);
  } catch (err) {
    console.log("\n❌ stampWorkbookCells THREW — this is why the estimate stays original:");
    console.log(err);
    process.exit(0);
  }

  // 4) Read back every target cell
  console.log("\nSummary Sheet cell values AFTER stamping the active template:");
  for (const [label, ref] of Object.entries(SUMMARY_CELLS)) {
    console.log(`  ${ref.padEnd(4)} ${label.padEnd(18)} => ${await readCell(stamped, ref)}`);
  }
  const z = await JSZip.loadAsync(stamped);
  console.log(`\n  macros preserved (vbaProject.bin): ${!!z.file("xl/vbaProject.bin")}`);
  console.log(`  calcChain removed: ${!z.file("xl/calcChain.xml")}`);
  console.log("\nIf these values look right here but the downloaded file looks original,");
  console.log("the running server is serving old code — restart it (pkill + npm run dev).");
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
