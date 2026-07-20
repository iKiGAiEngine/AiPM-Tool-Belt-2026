// AI usage ledger + a safe wrapper for the OpenAI client.
//
// instrumentOpenAI() wraps an OpenAI instance so that every
// chat.completions.create() call records its real token usage to the
// ai_usage_events table. This turns the QA audit's cost report from an estimate
// into a measured figure, broken down by model and operation.
//
// Safety contract: instrumentation must NEVER change behaviour or throw. The
// wrapped method returns exactly what the original returned; the ledger write is
// fire-and-forget and swallows all errors (including a not-yet-migrated table).

import type OpenAI from "openai";
import { loadRateCard, costMicros } from "./qaAudit/costModel";

const rateCard = loadRateCard();

export interface AiUsageRecord {
  operation: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  userId?: number | null;
}

/** Record one AI completion's usage. Best-effort; never throws. */
export async function recordAiUsage(rec: AiUsageRecord): Promise<void> {
  try {
    if (!process.env.DATABASE_URL) return;
    const { db } = await import("./db");
    const { aiUsageEvents } = await import("@shared/schema");
    const prompt = Math.max(0, Math.round(rec.promptTokens || 0));
    const completion = Math.max(0, Math.round(rec.completionTokens || 0));
    await db.insert(aiUsageEvents).values({
      operation: (rec.operation || "unknown").slice(0, 80),
      model: (rec.model || "unknown").slice(0, 80),
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: rec.totalTokens ?? prompt + completion,
      estimatedCostMicros: costMicros(rateCard, rec.model || "default", prompt, completion),
      userId: rec.userId ?? null,
    });
  } catch (err: any) {
    // A missing ai_usage_events table (migration pending) or any DB hiccup must
    // never affect the AI feature that generated this usage.
    console.error("[AiUsage] ledger write skipped:", err?.message || err);
  }
}

/**
 * Wrap an OpenAI client so completions self-report token usage to the ledger.
 * Usage:  const openai = instrumentOpenAI(new OpenAI({ apiKey }), "quote-parser");
 * Returns the same client (mutated) typed as OpenAI, so call sites are unchanged.
 */
export function instrumentOpenAI(client: OpenAI, operation: string): OpenAI {
  try {
    const completions: any = (client as any)?.chat?.completions;
    if (!completions || typeof completions.create !== "function" || completions.__aipmInstrumented) {
      return client;
    }
    const original = completions.create.bind(completions);
    completions.create = async (...args: any[]) => {
      const res: any = await original(...args);
      try {
        const params = args[0] || {};
        // Streaming responses are async iterables without a top-level usage
        // object (unless stream_options.include_usage is set) — skip them.
        if (!params.stream && res && res.usage) {
          void recordAiUsage({
            operation,
            model: res.model || params.model || "unknown",
            promptTokens: res.usage.prompt_tokens ?? 0,
            completionTokens: res.usage.completion_tokens ?? 0,
            totalTokens: res.usage.total_tokens,
          });
        }
      } catch {
        /* never let bookkeeping affect the call */
      }
      return res;
    };
    completions.__aipmInstrumented = true;
  } catch {
    /* if anything about the client shape is unexpected, return it untouched */
  }
  return client;
}
