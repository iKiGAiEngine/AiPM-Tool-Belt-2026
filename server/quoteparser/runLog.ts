/**
 * Background data gathering for the quote parser.
 *
 * Every parse is recorded in quote_parser_runs (the accuracy scorecard,
 * vendor memory, and regression golden set all derive from it), and every
 * priced product line is recorded in vendor_price_history for later price
 * trend analysis. All writes are best-effort: a logging failure must never
 * break a parse.
 */
import { db } from "../db";
import { quoteParserRuns, vendorPriceHistory, quoteParserFeedback } from "@shared/schema";
import { desc, eq, sql } from "drizzle-orm";
import type { QuoteParseResult } from "./openaiQuoteParser";

const SNIPPET_MAX = 4000;

export interface RunGateSummary {
  math: { status: string; issues: number };
  spec: { ran: boolean; fails: number; warns: number };
  schedule: { ran: boolean; missing: number; qtyMismatches: number; extras: number };
}

export async function logParseRun(params: {
  result: QuoteParseResult;
  inputTypes: string[];
  model: string;
  durationMs: number;
  extractedText: string;
  gateResults: RunGateSummary;
  verdict: "verified" | "needs_review";
  reconciliationStatus: string;
}): Promise<number | null> {
  try {
    const { result } = params;
    const inserted = await db
      .insert(quoteParserRuns)
      .values({
        vendorId: result.detectedVendorId,
        vendorName: result.detectedVendorName || result.manufacturer || null,
        quoteNumber: result.quoteNumber || null,
        inputTypes: params.inputTypes,
        model: params.model,
        durationMs: params.durationMs,
        extractedTextSnippet: params.extractedText.slice(0, SNIPPET_MAX),
        resultJson: result as any,
        gateResults: params.gateResults as any,
        verdict: params.verdict,
        reconciliationStatus: params.reconciliationStatus,
        lineItemCount: result.lineItems.length,
      })
      .returning({ id: quoteParserRuns.id });

    const runId = inserted[0]?.id ?? null;

    // Price history: one row per priced product line.
    if (runId !== null) {
      const priceRows = result.lineItems
        .filter((i) => i.lineType === "product" && i.unitPrice !== null && i.modelNumber)
        .map((i) => ({
          vendorId: result.detectedVendorId,
          vendorName: result.detectedVendorName || result.manufacturer || null,
          modelNumber: i.modelNumber,
          description: i.description || null,
          unitPrice: i.unitPrice!.toFixed(2),
          extendedPrice: i.extendedPrice !== null ? i.extendedPrice.toFixed(2) : null,
          qty: parseInt(i.qty, 10) || null,
          quoteNumber: result.quoteNumber || null,
          sourceRunId: runId,
        }));
      if (priceRows.length > 0) {
        await db.insert(vendorPriceHistory).values(priceRows);
      }
    }

    return runId;
  } catch (err) {
    console.warn("Quote parser: failed to log run (non-fatal):", err);
    return null;
  }
}

export async function recordRunFeedback(runId: number, feedback: "up" | "down"): Promise<void> {
  try {
    await db.update(quoteParserRuns).set({ feedback }).where(eq(quoteParserRuns.id, runId));
  } catch (err) {
    console.warn("Quote parser: failed to record run feedback (non-fatal):", err);
  }
}

export async function getRun(runId: number) {
  const rows = await db.select().from(quoteParserRuns).where(eq(quoteParserRuns.id, runId));
  return rows[0] ?? null;
}

/** Vendor memory, derived from the run log (replaces the old key/value hack). */
export async function getVendorMemory(): Promise<
  Array<{ id: number | null; name: string; parseCount: number; lastSeen: string | null; thumbsUp: number; thumbsDown: number }>
> {
  try {
    const rows = await db
      .select({
        vendorId: quoteParserRuns.vendorId,
        vendorName: quoteParserRuns.vendorName,
        parseCount: sql<number>`count(*)::int`,
        lastSeen: sql<string>`max(${quoteParserRuns.createdAt})::text`,
        thumbsUp: sql<number>`count(*) filter (where ${quoteParserRuns.feedback} = 'up')::int`,
        thumbsDown: sql<number>`count(*) filter (where ${quoteParserRuns.feedback} = 'down')::int`,
      })
      .from(quoteParserRuns)
      .groupBy(quoteParserRuns.vendorId, quoteParserRuns.vendorName)
      .orderBy(desc(sql`count(*)`));
    return rows
      .filter((r) => r.vendorName)
      .map((r) => ({
        id: r.vendorId,
        name: r.vendorName!,
        parseCount: r.parseCount,
        lastSeen: r.lastSeen,
        thumbsUp: r.thumbsUp,
        thumbsDown: r.thumbsDown,
      }));
  } catch {
    return [];
  }
}

/** Accuracy scorecard for the settings page. */
export async function getParserStats() {
  try {
    const [totals] = await db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        verified: sql<number>`count(*) filter (where ${quoteParserRuns.verdict} = 'verified')::int`,
        mathPass: sql<number>`count(*) filter (where ${quoteParserRuns.reconciliationStatus} = 'pass')::int`,
        thumbsUp: sql<number>`count(*) filter (where ${quoteParserRuns.feedback} = 'up')::int`,
        thumbsDown: sql<number>`count(*) filter (where ${quoteParserRuns.feedback} = 'down')::int`,
        avgDurationMs: sql<number>`coalesce(avg(${quoteParserRuns.durationMs}), 0)::int`,
        priceRows: sql<number>`(select count(*) from ${vendorPriceHistory})::int`,
      })
      .from(quoteParserRuns);
    const openFeedback = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(quoteParserFeedback)
      .where(eq(quoteParserFeedback.status, "open"));
    return { ...totals, openFeedback: openFeedback[0]?.count ?? 0 };
  } catch {
    return {
      totalRuns: 0, verified: 0, mathPass: 0, thumbsUp: 0, thumbsDown: 0,
      avgDurationMs: 0, priceRows: 0, openFeedback: 0,
    };
  }
}
