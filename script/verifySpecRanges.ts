/**
 * Verification harness for the Spec Extractor page-range fix.
 *
 * Runs the real regex extraction engine (runExtraction) against one or more
 * spec PDFs and prints each detected Division-10 section's page range, flagging
 * anything suspicious:
 *   - pageCount === 1  → likely a multi-page section that collapsed (the bug)
 *   - pageCount  > 60  → likely bleeding past the next section header
 *
 * Usage:
 *   npx tsx script/verifySpecRanges.ts <path-to.pdf> [<path-to.pdf> ...]
 *
 * With no arguments it runs against the sample manuals in attached_assets/.
 */
import fs from "fs";
import path from "path";
import { runExtraction } from "../server/specExtractorEngine";

const DEFAULT_SAMPLES = [
  "20251215_CPH_Science_A_100__PD_Project_Manual_1770915455352.pdf",
  "AS_PDX_Hangar_Specifications_Volume_2_-_Permit_Set_1770246469876.pdf",
  "National_Building_Specialties_-_Welbe_Health_West_Covina_Senio_1776210550729.pdf",
  "Pages_from_ProjMan-UCHMCROR9Expansion-IFC-2026-05-07_1780680626662.pdf",
  "10_26_13_-_CORNER_GUARDS_-_Crockett_HS_New_Gym_1770319681973.pdf",
  "10_44_13_-_FIRE_EXTINGUISHERS_AND_CABINETS_-_Crockett_HS_New_G_1770319688935.pdf",
].map(f => path.join(process.cwd(), "attached_assets", f));

async function verifyOne(pdfPath: string): Promise<void> {
  const label = path.basename(pdfPath);
  console.log(`\n${"=".repeat(80)}\n${label}\n${"=".repeat(80)}`);
  if (!fs.existsSync(pdfPath)) {
    console.log(`  SKIP: file not found`);
    return;
  }

  const buffer = fs.readFileSync(pdfPath);
  const result = await runExtraction(buffer);

  const other = result.otherDivisionSections || [];
  console.log(`  totalPages=${result.totalPages}  tocBounds=${result.tocBounds.start + 1}-${result.tocBounds.end + 1}  div10=${result.sections.length}  div11/12=${other.length}`);

  const printRow = (s: { section: string; start: number; end: number; title: string }) => {
    const pageCount = s.end - s.start + 1;
    const flags: string[] = [];
    if (pageCount === 1) flags.push("⚠ SINGLE-PAGE");
    if (pageCount > 60) flags.push("⚠ OVER-BLEED");
    console.log(
      `  ${s.section.padEnd(10)} ${String(s.start + 1).padStart(4)}-${String(s.end + 1).padStart(4)}  ` +
      `(${String(pageCount).padStart(3)}p)  ${s.title}${flags.length ? "   " + flags.join(" ") : ""}`
    );
  };

  console.log("  -- Division 10 --");
  for (const s of result.sections) printRow(s);
  if (other.length > 0) {
    console.log("  -- Division 11 / 12 --");
    for (const s of other) printRow(s);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : DEFAULT_SAMPLES;
  for (const t of targets) {
    try {
      await verifyOne(t);
    } catch (err: any) {
      console.error(`  ERROR on ${path.basename(t)}: ${err?.message || err}`);
    }
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
