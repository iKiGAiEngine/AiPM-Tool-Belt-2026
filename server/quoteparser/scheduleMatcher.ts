/**
 * Gate 3 — cross-reference the parsed quote against the project's plan
 * schedule: fill in plan callouts, and flag anything the quote is missing,
 * anything extra, and any quantity disagreements.
 *
 * Matching is deterministic (model number > description similarity > qty
 * corroboration) so results are repeatable and unit-testable. The schedule
 * itself is extracted by the AI (see extractScheduleEntries), but pairing
 * quote lines to schedule entries happens here, in plain code.
 */
import type { ParsedLineItem, ScheduleEntry } from "./openaiQuoteParser";

export interface ScheduleMatch {
  lineIndex: number;
  callout: string;
  confidence: number;
  reasons: string[];
}

export interface ScheduleCoverage {
  matches: ScheduleMatch[];
  /** Schedule entries no quote line could be paired with. */
  missing: ScheduleEntry[];
  /** Indexes of quote product lines that matched nothing on the schedule. */
  extraLineIndexes: number[];
  qtyMismatches: Array<{
    callout: string;
    description: string;
    scheduledQty: string;
    quotedQty: string;
  }>;
  confirmations: string[];
  issues: string[];
}

const MATCH_THRESHOLD = 40;

export function normalizeModel(model: string): string {
  return model.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] =
        b.charAt(i - 1) === a.charAt(j - 1)
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "was", "are", "were", "be", "been",
  "each", "per", "ea", "pcs", "pc", "qty", "unit", "units",
]);

export function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_,.:;()\/]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function scorePair(item: ParsedLineItem, entry: ScheduleEntry): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (item.modelNumber && entry.modelNumber) {
    const quoteModel = normalizeModel(item.modelNumber);
    const schedModel = normalizeModel(entry.modelNumber);
    if (quoteModel && schedModel) {
      if (quoteModel === schedModel) {
        score += 55;
        reasons.push("exact model match");
      } else if (quoteModel.includes(schedModel) || schedModel.includes(quoteModel)) {
        score += 38;
        reasons.push("partial model match");
      } else if (similarity(quoteModel, schedModel) > 0.75) {
        score += 25;
        reasons.push("similar model number");
      }
    }
  }

  if (item.description && entry.description) {
    const descSim = similarity(item.description.toLowerCase(), entry.description.toLowerCase());
    if (descSim > 0.8) {
      score += 30;
      reasons.push("strong description match");
    } else if (descSim > 0.5) {
      score += 20;
      reasons.push("moderate description match");
    }
    const common = significantWords(item.description).filter((w) =>
      significantWords(entry.description).includes(w)
    );
    if (common.length >= 2) {
      score += 12;
      reasons.push(`shared keywords: ${common.slice(0, 3).join(", ")}`);
    }
  }

  if (item.qty && entry.qty && item.qty === entry.qty) {
    score += 8;
    reasons.push("quantity agrees");
  }

  return { score, reasons };
}

export function matchQuoteToSchedule(
  lineItems: ParsedLineItem[],
  entries: ScheduleEntry[]
): ScheduleCoverage {
  const confirmations: string[] = [];
  const issues: string[] = [];
  const productIndexes = lineItems
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.lineType === "product");

  if (entries.length === 0) {
    return { matches: [], missing: [], extraLineIndexes: [], qtyMismatches: [], confirmations, issues };
  }

  // Score every (quote line, schedule entry) pair, then assign greedily from
  // the highest score down so each schedule entry pairs with at most one line.
  const pairs: Array<{ lineIndex: number; entryIndex: number; score: number; reasons: string[] }> = [];
  for (const { item, i } of productIndexes) {
    for (let e = 0; e < entries.length; e++) {
      const { score, reasons } = scorePair(item, entries[e]);
      if (score >= MATCH_THRESHOLD) pairs.push({ lineIndex: i, entryIndex: e, score, reasons });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedLines = new Set<number>();
  const usedEntries = new Set<number>();
  const matches: ScheduleMatch[] = [];
  const qtyMismatches: ScheduleCoverage["qtyMismatches"] = [];

  for (const pair of pairs) {
    if (usedLines.has(pair.lineIndex) || usedEntries.has(pair.entryIndex)) continue;
    usedLines.add(pair.lineIndex);
    usedEntries.add(pair.entryIndex);
    const entry = entries[pair.entryIndex];
    const item = lineItems[pair.lineIndex];
    matches.push({
      lineIndex: pair.lineIndex,
      callout: entry.callout,
      confidence: Math.min(100, pair.score),
      reasons: pair.reasons,
    });
    if (entry.qty && item.qty && entry.qty !== item.qty) {
      qtyMismatches.push({
        callout: entry.callout,
        description: entry.description || item.description,
        scheduledQty: entry.qty,
        quotedQty: item.qty,
      });
    }
  }

  const missing = entries.filter((_, e) => !usedEntries.has(e));
  const extraLineIndexes = productIndexes.map(({ i }) => i).filter((i) => !usedLines.has(i));

  if (matches.length > 0) {
    confirmations.push(
      `Schedule coverage: ${matches.length} of ${entries.length} scheduled item${entries.length === 1 ? "" : "s"} found on the quote.`
    );
  }
  for (const entry of missing) {
    const label = [entry.callout, entry.description || entry.modelNumber].filter(Boolean).join(" — ");
    issues.push(
      `Schedule item NOT on the quote: ${label}${entry.qty ? ` (schedule calls for ${entry.qty})` : ""}.`
    );
  }
  for (const mm of qtyMismatches) {
    issues.push(
      `Quantity mismatch for ${mm.callout || mm.description}: schedule calls for ${mm.scheduledQty}, quote has ${mm.quotedQty}.`
    );
  }
  if (extraLineIndexes.length > 0) {
    const names = extraLineIndexes
      .slice(0, 5)
      .map((i) => lineItems[i].modelNumber || lineItems[i].description.slice(0, 30))
      .join(", ");
    issues.push(
      `${extraLineIndexes.length} quoted item${extraLineIndexes.length === 1 ? "" : "s"} not found on the schedule: ${names}${extraLineIndexes.length > 5 ? ", …" : ""} — confirm they belong on this project.`
    );
  }

  return { matches, missing, extraLineIndexes, qtyMismatches, confirmations, issues };
}
