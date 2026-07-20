// Cost & Usage analysis for the QA audit.
//
// Produces a CostSummary (what it costs to run the site, by driver) plus a small
// set of CheckResults (e.g. a monthly-budget guardrail). Two sources of truth:
//
//   1. MEASURED — the ai_usage_events ledger (populated by instrumentOpenAI)
//      gives exact token spend by model. Preferred whenever data exists.
//   2. ESTIMATED — before the ledger has accumulated, we ballpark AI spend from
//      the volume of AI-processed work already in the DB (emails parsed, quotes
//      read, chats, spec/plan/estimate runs) × assumed tokens/op. Clearly
//      labelled as an estimate.
//
// Every DB read is defensive (try/catch → 0) so a missing table or column can
// never break the audit.

import { sql } from "drizzle-orm";
import { runProbe, type CheckResult, type CostLine, type CostSummary } from "./types";
import { loadRateCard, costUsd, type RateCard } from "./costModel";

async function scalar(query: string): Promise<number> {
  try {
    const { db } = await import("../db");
    const rows: any = await db.execute(sql.raw(query) as any);
    const list = Array.isArray(rows) ? rows : rows?.rows ?? [];
    const v = list[0] ? Object.values(list[0])[0] : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

interface LedgerWindow {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

async function ledgerWindow(intervalSql: string): Promise<LedgerWindow> {
  try {
    const { db } = await import("../db");
    const rows: any = await db.execute(
      sql.raw(
        `select
           count(*)::bigint as calls,
           coalesce(sum(prompt_tokens),0)::bigint as pt,
           coalesce(sum(completion_tokens),0)::bigint as ct,
           coalesce(sum(estimated_cost_micros),0)::bigint as micros
         from "ai_usage_events"
         where occurred_at > now() - interval '${intervalSql}'`,
      ) as any,
    );
    const list = Array.isArray(rows) ? rows : rows?.rows ?? [];
    const r = list[0] || {};
    return {
      calls: Number(r.calls) || 0,
      promptTokens: Number(r.pt) || 0,
      completionTokens: Number(r.ct) || 0,
      costUsd: (Number(r.micros) || 0) / 1e6,
    };
  } catch {
    return { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  }
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function usd(n: number): number {
  return Math.round(n * 100) / 100;
}

// Tables that represent one-or-more AI calls, with an approximate calls-per-row
// weight, used only for the pre-instrumentation ESTIMATE. Each is queried
// defensively; a missing table/column contributes 0.
const AI_WORK: Array<{ table: string; tsCol: string; callsPerRow: number; label: string }> = [
  { table: "email_intake_log", tsCol: "created_at", callsPerRow: 1, label: "emails parsed" },
  { table: "estimate_quotes", tsCol: "created_at", callsPerRow: 1, label: "quotes read" },
  { table: "chat_sessions", tsCol: "created_at", callsPerRow: 4, label: "chat sessions" },
  { table: "spec_extractor_sessions", tsCol: "created_at", callsPerRow: 3, label: "spec extractions" },
  { table: "sessions", tsCol: "created_at", callsPerRow: 2, label: "accessory extractions" },
  { table: "plan_parser_jobs", tsCol: "created_at", callsPerRow: 2, label: "plan parses" },
];

async function estimatedAiOps(intervalSql: string): Promise<number> {
  let ops = 0;
  for (const w of AI_WORK) {
    // created_at is a real timestamp on some tables and an ISO varchar on others;
    // a string literal comparison works for both (ISO-8601 sorts lexically).
    const since = `now() - interval '${intervalSql}'`;
    const c = await scalar(
      `select count(*)::bigint from "${w.table}" where "${w.tsCol}"::text > (${since})::text`,
    );
    ops += c * w.callsPerRow;
  }
  return ops;
}

function estimateCost(card: RateCard, ops: number): number {
  const { inputTokensPerOp, outputTokensPerOp, model } = card.estimate;
  return costUsd(card, model, ops * inputTokensPerOp, ops * outputTokensPerOp);
}

/** Build the Cost & Usage summary and any cost-related checks. */
export async function runCostAnalysis(): Promise<{ summary: CostSummary; checks: CheckResult[] }> {
  const card = loadRateCard();
  const lines: CostLine[] = [];

  // ---- AI (OpenAI) --------------------------------------------------------
  const led24 = await ledgerWindow("24 hours");
  const led30 = await ledgerWindow("30 days");
  const hasMeasuredAi = led30.calls > 0;

  if (hasMeasuredAi) {
    lines.push({
      driver: "AI — OpenAI (measured)",
      measured: true,
      usage: `${led24.calls} calls / 24h · ${fmtTokens(led30.promptTokens)} in + ${fmtTokens(led30.completionTokens)} out / 30d`,
      last24hUsd: usd(led24.costUsd),
      last30dUsd: usd(led30.costUsd),
      basis: "Exact token usage from the ai_usage_events ledger × rate card.",
    });
  } else {
    const ops24 = await estimatedAiOps("24 hours");
    const ops30 = await estimatedAiOps("30 days");
    lines.push({
      driver: "AI — OpenAI (estimated)",
      measured: false,
      usage: `~${ops24} AI ops / 24h · ~${ops30} AI ops / 30d (from processed-work volume)`,
      last24hUsd: usd(estimateCost(card, ops24)),
      last30dUsd: usd(estimateCost(card, ops30)),
      basis: `Estimate: AI operations × ${card.estimate.inputTokensPerOp}+${card.estimate.outputTokensPerOp} tokens @ ${card.estimate.model} rates. Accurate numbers accrue in the ledger from now on.`,
    });
  }

  // ---- Email (SendGrid) ---------------------------------------------------
  const emails24 = await scalar(`select count(*)::bigint from "rfq_log" where "sent_at" > now() - interval '24 hours'`);
  const emails30 = await scalar(`select count(*)::bigint from "rfq_log" where "sent_at" > now() - interval '30 days'`);
  lines.push({
    driver: "Email — SendGrid",
    measured: emails30 > 0,
    usage: `${emails24} sent / 24h · ${emails30} sent / 30d (RFQ + notifications)`,
    last24hUsd: usd(emails24 * card.emailPerMessage),
    last30dUsd: usd(emails30 * card.emailPerMessage),
    basis: `Logged sends × $${card.emailPerMessage}/email. Transactional emails not in rfq_log are not counted.`,
  });

  // ---- Fixed infrastructure ----------------------------------------------
  const fixedMonthly = card.hostingMonthly + card.databaseMonthly;
  lines.push({
    driver: "Infrastructure — hosting + database",
    measured: false,
    usage: fixedMonthly > 0 ? "fixed monthly plan" : "not configured",
    last24hUsd: usd(fixedMonthly / 30),
    last30dUsd: usd(fixedMonthly),
    basis:
      fixedMonthly > 0
        ? `Hosting $${card.hostingMonthly}/mo + DB $${card.databaseMonthly}/mo (set via QA_AUDIT_INFRA_MONTHLY_USD / QA_AUDIT_DB_MONTHLY_USD).`
        : "Set QA_AUDIT_INFRA_MONTHLY_USD and QA_AUDIT_DB_MONTHLY_USD to include hosting/DB.",
  });

  // ---- Totals & projection ------------------------------------------------
  const total24hUsd = usd(lines.reduce((s, l) => s + l.last24hUsd, 0));
  const total30dUsd = usd(lines.reduce((s, l) => s + l.last30dUsd, 0));
  // Variable = everything except the fixed infra line; projected = run-rate + fixed.
  const variable24h = lines.filter((l) => !l.driver.startsWith("Infrastructure")).reduce((s, l) => s + l.last24hUsd, 0);
  const projectedMonthlyUsd = usd(variable24h * 30 + fixedMonthly);

  const summary: CostSummary = {
    currency: "USD",
    hasMeasuredAi,
    lines,
    total24hUsd,
    total30dUsd,
    projectedMonthlyUsd,
    note: hasMeasuredAi
      ? "AI spend is measured from the token ledger. Email/infra are estimates; adjust rates via env."
      : "AI spend is an estimate until the token ledger accumulates data; all figures are estimates. Adjust rates via env.",
  };

  // ---- Checks -------------------------------------------------------------
  const checks: CheckResult[] = [];

  checks.push(
    await runProbe(
      { id: "cost_run_rate", name: "Estimated monthly run-rate", category: "Cost", critical: false },
      async () => {
        const budget = Number(process.env.QA_AUDIT_MONTHLY_BUDGET_USD);
        const summ = `Projected ~$${projectedMonthlyUsd}/mo (24h run-rate ×30 + fixed). Last 24h: $${total24hUsd}.`;
        if (Number.isFinite(budget) && budget > 0) {
          if (projectedMonthlyUsd > budget) {
            return { status: "fail", summary: `${summ} Over budget ($${budget}/mo).`, evidence: { projectedMonthlyUsd, budget } };
          }
          if (projectedMonthlyUsd > budget * 0.8) {
            return { status: "warn", summary: `${summ} Approaching budget ($${budget}/mo).`, evidence: { projectedMonthlyUsd, budget } };
          }
          return { status: "pass", summary: `${summ} Within budget ($${budget}/mo).`, evidence: { projectedMonthlyUsd, budget } };
        }
        return { status: "pass", summary: `${summ} Set QA_AUDIT_MONTHLY_BUDGET_USD to enable a budget alert.`, evidence: { projectedMonthlyUsd } };
      },
    ),
  );

  checks.push(
    await runProbe(
      { id: "cost_ai_visibility", name: "AI cost visibility", category: "Cost", critical: false },
      async () => {
        if (hasMeasuredAi) {
          return { status: "pass", summary: `Token ledger active — ${led30.calls} AI calls measured in 30d ($${usd(led30.costUsd)}).`, evidence: { calls30d: led30.calls } };
        }
        return {
          status: "warn",
          summary: "No measured AI usage yet — cost shown is estimated. Ledger will populate as AI features are used.",
          detail: "Run db:push to create ai_usage_events if you just deployed this.",
        };
      },
    ),
  );

  return { summary, checks };
}
