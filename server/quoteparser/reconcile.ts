/**
 * Gate 1 — deterministic math verification of an AI parse.
 *
 * The AI extracts per-line prices; this module does what an estimator does by
 * hand: check qty × unit price against each line's extension, and check that
 * the lines add up to the material subtotal. Pure functions, unit-tested.
 */
import type { ParsedLineItem, QuoteParseResult } from "./openaiQuoteParser";

export type ReconciliationStatus = "pass" | "mismatch" | "no_prices";

export interface ReconciliationResult {
  status: ReconciliationStatus;
  /** Positive confirmations ("math verified …"). */
  confirmations: string[];
  /** Problems that must go on the NEEDS REVIEW list. */
  issues: string[];
  /** Sum of extended prices across countable lines (product/tag/decal). */
  lineSum: number;
  pricedLineCount: number;
  totalLineCount: number;
}

const TOLERANCE = 0.02;

function money(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Verify the parse's arithmetic. Also downgrades per-line confidence in place
 * when a line's own math (qty × unit ≠ extended) doesn't hold, so the
 * NEEDS REVIEW list names the exact line.
 */
export function reconcileTotals(result: QuoteParseResult): ReconciliationResult {
  const confirmations: string[] = [];
  const issues: string[] = [];
  // Material subtotal covers everything that isn't freight/other.
  const countable = result.lineItems.filter(
    (i) => i.lineType === "product" || i.lineType === "tag" || i.lineType === "decal"
  );

  let lineSum = 0;
  let pricedLineCount = 0;

  for (const item of countable) {
    const qty = parseFloat(item.qty);
    if (item.unitPrice !== null && item.extendedPrice !== null && !isNaN(qty) && qty > 0) {
      const expected = Math.round(qty * item.unitPrice * 100) / 100;
      if (Math.abs(expected - item.extendedPrice) > TOLERANCE) {
        issues.push(
          `Line "${item.modelNumber || item.description.slice(0, 40)}": ${item.qty} × ${money(item.unitPrice)} = ${money(expected)}, but the quote shows ${money(item.extendedPrice)} — one of these numbers was misread.`
        );
        item.confidence = Math.min(item.confidence, 70);
        item.confidenceNote = item.confidenceNote
          ? `${item.confidenceNote}; line math does not balance`
          : "line math does not balance";
      }
    }
    if (item.extendedPrice !== null) {
      lineSum += item.extendedPrice;
      pricedLineCount++;
    }
  }

  lineSum = Math.round(lineSum * 100) / 100;
  const base = { lineSum, pricedLineCount, totalLineCount: countable.length };

  if (pricedLineCount === 0) {
    issues.unshift("No per-line prices were readable on this quote — the material total could not be independently verified.");
    return { status: "no_prices", confirmations, issues, ...base };
  }

  if (pricedLineCount < countable.length) {
    const missing = countable.length - pricedLineCount;
    issues.push(`${missing} of ${countable.length} lines had no readable price — the total check is partial.`);
  }

  if (result.materialTotal > 0) {
    const diff = Math.abs(lineSum - result.materialTotal);
    if (diff <= TOLERANCE) {
      confirmations.unshift(
        `Math verified: ${pricedLineCount} line${pricedLineCount === 1 ? "" : "s"} sum to ${money(lineSum)}, matching the material total.`
      );
      // A partial price read can't be a full pass even if the sums agree.
      const status: ReconciliationStatus =
        pricedLineCount === countable.length && issues.length === 0 ? "pass" : "mismatch";
      return { status, confirmations, issues, ...base };
    }
    issues.unshift(
      `Math check FAILED: line items sum to ${money(lineSum)} but the material total reads ${money(result.materialTotal)} (difference ${money(diff)}). A line or the total was misread — verify before using.`
    );
    return { status: "mismatch", confirmations, issues, ...base };
  }

  issues.unshift(
    `No material total was found on the quote; the line items sum to ${money(lineSum)} — verify against the quote document.`
  );
  return { status: "mismatch", confirmations, issues, ...base };
}

/**
 * Fold tag and decal lines into their parent product, matching the behavior
 * the estimate sheet expects: extinguisher tags become "… - tagged" on the
 * extinguisher line, cabinet decals become "…, decals included".
 * Freight lines are dropped here (freight is reported in the summary row).
 * Returns a new array; does not mutate the input items.
 */
export function consolidateLineItems(lineItems: ParsedLineItem[]): ParsedLineItem[] {
  const out: ParsedLineItem[] = [];

  for (const item of lineItems) {
    if (item.lineType === "tag") {
      for (let j = out.length - 1; j >= 0; j--) {
        const candidate = out[j];
        if (candidate.lineType !== "product") continue;
        const desc = candidate.description.toUpperCase();
        if (
          /\b(EXT|FIRE|ANSUL|AMEREX|BADGER|KIDDE|RED\s*LINE|CARTRIDGE)\b/.test(desc) ||
          /^FE[A-Z]?\d/.test(candidate.modelNumber)
        ) {
          if (!/- tagged\b/i.test(candidate.description)) {
            out[j] = { ...candidate, description: candidate.description + " - tagged" };
          }
          break;
        }
      }
      continue;
    }

    if (item.lineType === "decal") {
      for (let j = out.length - 1; j >= 0; j--) {
        const candidate = out[j];
        if (candidate.lineType !== "product") continue;
        const desc = candidate.description.toUpperCase();
        const model = candidate.modelNumber.toUpperCase();
        if (
          /\b(CABINET|FE\s*FX|COSMOPOLITAN|AMBASSADOR|ACADEMY|EMBASSY)\b/.test(desc) ||
          /^C\d{4}/.test(model)
        ) {
          if (!/decals included/i.test(candidate.description)) {
            out[j] = { ...candidate, description: candidate.description + ", decals included" };
          }
          break;
        }
      }
      continue;
    }

    if (item.lineType === "freight") continue;

    out.push({ ...item });
  }

  return out;
}
