// Cost model / rate card for the QA audit's Cost & Usage report.
//
// All rates are ASSUMPTIONS with sensible current defaults and are fully
// overridable via environment variables — provider pricing changes, and every
// deployment has a different infra plan. Nothing here calls the network or the
// DB; it is pure arithmetic so it is easy to reason about and test.
//
// Token prices are USD per 1,000,000 tokens.

export interface ModelRate {
  inputPerM: number;
  outputPerM: number;
}

export interface RateCard {
  models: Record<string, ModelRate>;
  /** USD per email sent (SendGrid). */
  emailPerMessage: number;
  /** Fixed monthly infrastructure costs (hosting + database), USD/month. */
  hostingMonthly: number;
  databaseMonthly: number;
  /** Fallback token assumptions when the AI ledger has no measured data. */
  estimate: {
    inputTokensPerOp: number;
    outputTokensPerOp: number;
    model: string;
  };
}

// Defaults reflect published OpenAI list prices for the models this app uses
// (gpt-4o, gpt-4o-mini) as of the last update; treat as an estimate and set the
// env overrides to match your actual contract/invoice.
export const DEFAULT_RATE_CARD: RateCard = {
  models: {
    "gpt-4o": { inputPerM: 2.5, outputPerM: 10.0 },
    "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
    "gpt-4.1": { inputPerM: 2.0, outputPerM: 8.0 },
    "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6 },
    "text-embedding-3-small": { inputPerM: 0.02, outputPerM: 0 },
    "text-embedding-3-large": { inputPerM: 0.13, outputPerM: 0 },
    default: { inputPerM: 2.5, outputPerM: 10.0 },
  },
  emailPerMessage: 0.0006, // ~ $19.95 / 50k on SendGrid Essentials
  hostingMonthly: 0,
  databaseMonthly: 0,
  estimate: {
    inputTokensPerOp: 3000,
    outputTokensPerOp: 1200,
    model: "gpt-4o",
  },
};

function num(env: string | undefined, fallback: number): number {
  const n = env == null ? NaN : Number(env);
  return Number.isFinite(n) ? n : fallback;
}

/** Build the effective rate card, applying env overrides on top of defaults. */
export function loadRateCard(): RateCard {
  const card: RateCard = JSON.parse(JSON.stringify(DEFAULT_RATE_CARD));

  // Whole-card override as JSON (advanced): QA_AUDIT_RATES_JSON.
  if (process.env.QA_AUDIT_RATES_JSON) {
    try {
      const parsed = JSON.parse(process.env.QA_AUDIT_RATES_JSON);
      Object.assign(card, parsed);
    } catch (err: any) {
      console.error("[QaAudit] Invalid QA_AUDIT_RATES_JSON, using defaults:", err?.message || err);
    }
  }

  // Common individual overrides.
  card.emailPerMessage = num(process.env.QA_AUDIT_EMAIL_RATE, card.emailPerMessage);
  card.hostingMonthly = num(process.env.QA_AUDIT_INFRA_MONTHLY_USD, card.hostingMonthly);
  card.databaseMonthly = num(process.env.QA_AUDIT_DB_MONTHLY_USD, card.databaseMonthly);
  card.estimate.inputTokensPerOp = num(process.env.QA_AUDIT_EST_TOKENS_IN, card.estimate.inputTokensPerOp);
  card.estimate.outputTokensPerOp = num(process.env.QA_AUDIT_EST_TOKENS_OUT, card.estimate.outputTokensPerOp);

  return card;
}

export function rateFor(card: RateCard, model: string): ModelRate {
  if (card.models[model]) return card.models[model];
  // Normalise dated/suffixed model ids like "gpt-4o-2024-08-06" → "gpt-4o".
  // Match the LONGEST matching prefix so "gpt-4o-mini-..." picks "gpt-4o-mini",
  // not the shorter "gpt-4o".
  const base = Object.keys(card.models)
    .filter((k) => k !== "default" && model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return base ? card.models[base] : card.models.default;
}

/** Cost in USD for a single completion's token usage. */
export function costUsd(card: RateCard, model: string, promptTokens: number, completionTokens: number): number {
  const r = rateFor(card, model);
  return (promptTokens / 1e6) * r.inputPerM + (completionTokens / 1e6) * r.outputPerM;
}

/** Cost in micro-dollars (integer) — used by the ledger for precision. */
export function costMicros(card: RateCard, model: string, promptTokens: number, completionTokens: number): number {
  return Math.round(costUsd(card, model, promptTokens, completionTokens) * 1e6);
}
