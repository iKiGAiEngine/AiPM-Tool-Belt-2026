/**
 * Quote Parser self-test.
 *
 * Exercises the deterministic parts of the quote QC pipeline — math
 * reconciliation, tag/decal consolidation, schedule matching, PDF line
 * grouping, PDF page rendering, and result-schema validation — with no
 * database and no OpenAI calls, so it runs anywhere:
 *
 *   npx tsx scripts/quoteparser-test.ts
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { reconcileTotals, consolidateLineItems } from "../server/quoteparser/reconcile";
import { matchQuoteToSchedule, normalizeModel, similarity } from "../server/quoteparser/scheduleMatcher";
import { renderPdfToImages } from "../server/quoteparser/pdfToImages";
import { extractPdfText, groupTextItemsIntoLines } from "../server/pdfUtils";
import { QuoteResultSchema, type QuoteParseResult, type ParsedLineItem } from "../server/quoteparser/openaiQuoteParser";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function line(partial: Partial<ParsedLineItem>): ParsedLineItem {
  return {
    description: "",
    modelNumber: "",
    qty: "1",
    unitPrice: null,
    extendedPrice: null,
    lineType: "product",
    confidence: 100,
    confidenceNote: "",
    defaultChecked: true,
    ...partial,
  };
}

function result(items: ParsedLineItem[], materialTotal: number): QuoteParseResult {
  return {
    lineItems: items,
    manufacturer: "Test Vendor",
    quoteNumber: "SQ123",
    materialTotal,
    freightTotal: 0,
    taxTotal: 0,
    warnings: [],
    detectedVendorId: null,
    detectedVendorName: "Test Vendor",
  };
}

// ── 1. Math reconciliation ────────────────────────────────────────────────────

console.log("\nreconcileTotals:");
{
  const r = reconcileTotals(
    result(
      [
        line({ modelNumber: "C1017V10", qty: "2", unitPrice: 425, extendedPrice: 850 }),
        line({ modelNumber: "FEA10", qty: "2", unitPrice: 89.5, extendedPrice: 179 }),
      ],
      1029
    )
  );
  check("balanced quote passes", r.status === "pass", `got ${r.status}`);
  check("balanced quote has confirmation", r.confirmations.length === 1 && r.issues.length === 0);
}
{
  const r = reconcileTotals(
    result(
      [
        line({ modelNumber: "C1017V10", qty: "2", unitPrice: 425, extendedPrice: 850 }),
        line({ modelNumber: "FEA10", qty: "2", unitPrice: 89.5, extendedPrice: 179 }),
      ],
      1100 // total misread
    )
  );
  check("total mismatch flagged", r.status === "mismatch");
  check("mismatch names both numbers", r.issues[0].includes("$1,029.00") && r.issues[0].includes("$1,100.00"), r.issues[0]);
}
{
  const items = [line({ modelNumber: "FEA10", qty: "3", unitPrice: 100, extendedPrice: 250 })];
  const r = reconcileTotals(result(items, 250));
  check("bad line math flagged", r.issues.some((i) => i.includes("FEA10")));
  check("bad line math downgrades confidence", items[0].confidence <= 70, `confidence ${items[0].confidence}`);
}
{
  const r = reconcileTotals(result([line({ modelNumber: "X" }), line({ modelNumber: "Y" })], 500));
  check("no prices → no_prices status", r.status === "no_prices");
  check("no prices is an issue, not silence", r.issues.length > 0);
}
{
  const r = reconcileTotals(
    result(
      [
        line({ modelNumber: "A", qty: "1", unitPrice: 100, extendedPrice: 100 }),
        line({ modelNumber: "B" }), // unpriced line
      ],
      100
    )
  );
  check("partial prices can't fully pass", r.status !== "pass", `got ${r.status}`);
}

// ── 2. Tag/decal consolidation ────────────────────────────────────────────────

console.log("\nconsolidateLineItems:");
{
  const items = [
    line({ description: "FIRE EXT, RED LINE 10LB", modelNumber: "FEA10" }),
    line({ description: "EXTINGUISHER TAG", modelNumber: "TAG-CA", lineType: "tag" }),
    line({ description: "COSMOPOLITAN CABINET", modelNumber: "C1017V10" }),
    line({ description: "DIE CUT DECAL", modelNumber: "LDCVBFE", lineType: "decal" }),
    line({ description: "OUTBOUND FREIGHT", modelNumber: "FRTOUT", lineType: "freight" }),
  ];
  const out = consolidateLineItems(items);
  check("tag/decal/freight rows removed", out.length === 2, `got ${out.length}`);
  check("extinguisher marked tagged", out[0].description.endsWith("- tagged"), out[0].description);
  check("cabinet marked decals included", out[1].description.endsWith(", decals included"), out[1].description);
  check("input not mutated", items[0].description === "FIRE EXT, RED LINE 10LB");
}

// ── 3. Schedule matching ──────────────────────────────────────────────────────

console.log("\nmatchQuoteToSchedule:");
{
  check("normalizeModel strips punctuation", normalizeModel("b- 3944/x") === "B3944X");
  check("similarity identical", similarity("abc", "abc") === 1);

  const quote = [
    line({ description: "COSMOPOLITAN CABINET SEMI-RECESSED", modelNumber: "C1017V10", qty: "10" }),
    line({ description: "FIRE EXT 10LB ABC", modelNumber: "FEA10", qty: "12" }),
    line({ description: "MYSTERY WIDGET", modelNumber: "ZZZ999", qty: "1" }),
  ];
  const schedule = [
    { callout: "FEC-1", description: "SEMI-RECESSED FE CABINET COSMOPOLITAN", modelNumber: "C1017-V10", qty: "10" },
    { callout: "FE-1", description: "FIRE EXTINGUISHER 10 LB ABC", modelNumber: "FEA-10", qty: "14" },
    { callout: "FE-2", description: "WHEELED EXTINGUISHER 150LB", modelNumber: "WE150", qty: "1" },
  ];
  const cov = matchQuoteToSchedule(quote, schedule);
  const byLine = new Map(cov.matches.map((m) => [m.lineIndex, m.callout]));
  check("cabinet matched to FEC-1", byLine.get(0) === "FEC-1", `got ${byLine.get(0)}`);
  check("extinguisher matched to FE-1", byLine.get(1) === "FE-1", `got ${byLine.get(1)}`);
  check("missing schedule item flagged", cov.missing.length === 1 && cov.missing[0].callout === "FE-2");
  check("qty mismatch flagged (12 vs 14)", cov.qtyMismatches.length === 1 && cov.qtyMismatches[0].scheduledQty === "14");
  check("extra quote item flagged", cov.extraLineIndexes.length === 1 && quote[cov.extraLineIndexes[0]].modelNumber === "ZZZ999");
  check("issues include missing item text", cov.issues.some((i) => i.includes("FE-2")));
}
{
  const cov = matchQuoteToSchedule([line({ modelNumber: "A1" })], []);
  check("empty schedule → no findings", cov.matches.length === 0 && cov.issues.length === 0);
}

// ── 4. PDF line grouping ──────────────────────────────────────────────────────

console.log("\ngroupTextItemsIntoLines:");
{
  const lines = groupTextItemsIntoLines([
    { str: "850.00", x: 500, y: 680, width: 30 },
    { str: "QTY", x: 50, y: 700, width: 20 },
    { str: "2", x: 50, y: 680, width: 6 },
    { str: "MODEL", x: 100, y: 700.8, width: 35 },
    { str: "C1017V10", x: 100, y: 679.5, width: 50 },
  ]);
  check("two visual lines reconstructed", lines.length === 2, JSON.stringify(lines));
  check("header row ordered left-to-right", lines[0].startsWith("QTY") && lines[0].includes("MODEL"), lines[0]);
  check("data row keeps qty/model/price together", /^2\s+C1017V10\s+850\.00$/.test(lines[1]), lines[1]);
}

// ── 5. Schema validation ──────────────────────────────────────────────────────

console.log("\nQuoteResultSchema:");
{
  const parsed = QuoteResultSchema.safeParse({
    manufacturer: "JL Industries",
    quoteNumber: "SQ02630085",
    materialTotal: 1713.8,
    freightTotal: 120,
    taxTotal: 0,
    lineItems: [
      {
        description: "FIRE EXT",
        modelNumber: "FEA10",
        qty: 2, // number should coerce to string
        unitPrice: 89.5,
        extendedPrice: 179,
        lineType: "product",
        confidence: 98,
        confidenceNote: "",
        defaultChecked: true,
      },
    ],
    warnings: [],
  });
  check("valid payload parses", parsed.success);
  check("numeric qty coerces to string", parsed.success && parsed.data.lineItems[0].qty === "2");

  const bad = QuoteResultSchema.safeParse({ lineItems: [{ lineType: "banana" }] });
  check("invalid lineType rejected", !bad.success);
}

// ── 6. PDF pipeline (extraction + page rendering) ─────────────────────────────

async function pdfChecks() {
  console.log("\nPDF pipeline:");
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const rows = [
    ["QTY", "MODEL", "DESCRIPTION", "UNIT", "EXT"],
    ["2", "C1017V10", "COSMOPOLITAN CABINET", "425.00", "850.00"],
    ["2", "FEA10", "FIRE EXT 10LB ABC", "89.50", "179.00"],
  ];
  const xs = [50, 100, 220, 420, 500];
  rows.forEach((r, ri) => {
    r.forEach((cell, ci) => page.drawText(cell, { x: xs[ci], y: 700 - ri * 20, size: 10, font }));
  });
  const pdfBytes = Buffer.from(await doc.save());

  const { text } = await extractPdfText(pdfBytes);
  const textLines = text.split("\n").filter((l) => l.trim());
  check("table rows stay separate lines", textLines.length === 3, `got ${textLines.length}: ${JSON.stringify(textLines)}`);
  check("row keeps columns in order", /2\s+C1017V10\s+COSMOPOLITAN CABINET\s+425\.00\s+850\.00/.test(textLines[1] || ""), textLines[1]);

  const pages = await renderPdfToImages(pdfBytes);
  check("PDF renders to PNG pages", pages.length === 1 && pages[0].png.length > 1000, `pages=${pages.length}`);
  const sig = pages[0]?.png.subarray(1, 4).toString("ascii");
  check("output is a real PNG", sig === "PNG", `signature ${sig}`);
}

pdfChecks()
  .catch((e) => {
    failed++;
    console.error("  ✗ PDF pipeline threw:", e.message);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
