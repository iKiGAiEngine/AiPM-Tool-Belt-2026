// Platform checks: environment/config sanity, integration wiring, background-job
// freshness, and process health. These run in-process (they read env vars and
// the local filesystem), so they only execute when the audit is co-located with
// the app.

import fs from "fs";
import path from "path";
import { runProbe, type CheckResult } from "./types";

const isProd = process.env.NODE_ENV === "production";

export async function runPlatformChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Required configuration present and safe.
  results.push(
    await runProbe(
      { id: "cfg_required", name: "Required configuration", category: "Configuration", critical: true },
      async () => {
        const problems: string[] = [];
        if (!process.env.DATABASE_URL) problems.push("DATABASE_URL is not set");
        const secret = process.env.SESSION_SECRET;
        if (!secret) {
          problems.push(isProd ? "SESSION_SECRET is not set (production)" : "SESSION_SECRET is not set (dev default in use)");
        } else if (secret === "dev-secret-change-me" && isProd) {
          problems.push("SESSION_SECRET is still the insecure dev default in production");
        }
        const hard = problems.filter((p) => p.includes("DATABASE_URL") || p.includes("production"));
        if (hard.length > 0) return { status: "fail", summary: hard.join("; ") + ".", evidence: { problems } };
        if (problems.length > 0) return { status: "warn", summary: problems.join("; ") + ".", evidence: { problems } };
        return { status: "pass", summary: "DATABASE_URL and SESSION_SECRET are set." };
      },
    ),
  );

  // 2. Integration wiring — informational inventory of what's connected.
  results.push(
    await runProbe(
      { id: "cfg_integrations", name: "Integration wiring", category: "Configuration", critical: false },
      async () => {
        const integrations: Record<string, boolean> = {
          "Email (SendGrid)": !!process.env.SENDGRID_API_KEY,
          "OpenAI": !!process.env.OPENAI_API_KEY,
          "Autodesk (APS)": !!(process.env.APS_CLIENT_ID || process.env.AUTODESK_CLIENT_ID),
          "Google Sheet sync": !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SHEET_ID),
        };
        const configured = Object.entries(integrations).filter(([, v]) => v).map(([k]) => k);
        const missing = Object.entries(integrations).filter(([, v]) => !v).map(([k]) => k);
        // Email in console-only mode in production is worth flagging.
        if (isProd && !integrations["Email (SendGrid)"]) {
          return {
            status: "warn",
            summary: "Email is in console-only mode in production (no SENDGRID_API_KEY).",
            detail: `Configured: ${configured.join(", ") || "none"}. Missing: ${missing.join(", ")}.`,
            evidence: { integrations },
          };
        }
        return {
          status: "pass",
          summary: `${configured.length}/${Object.keys(integrations).length} integrations configured.`,
          detail: `Configured: ${configured.join(", ") || "none"}. Not configured: ${missing.join(", ") || "none"}.`,
          evidence: { integrations },
        };
      },
    ),
  );

  // 3. Nightly backup freshness — the app writes a proposal-log backup daily.
  results.push(
    await runProbe(
      { id: "job_backup_freshness", name: "Nightly backup freshness", category: "Background jobs", critical: false },
      async () => {
        const dir = path.join(process.cwd(), "backups");
        if (!fs.existsSync(dir)) {
          return { status: "warn", summary: "Backups directory does not exist yet.", detail: "Expected server/nightlyBackup.ts to create it on first run." };
        }
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.startsWith("proposal-log-") && f.endsWith(".xlsx"))
          .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length === 0) return { status: "warn", summary: "No backup files found yet.", evidence: { dir } };
        const newest = files[0];
        const ageHours = (Date.now() - newest.mtime) / 3_600_000;
        if (ageHours > 26) return { status: "fail", summary: `Latest backup is ${ageHours.toFixed(1)}h old (>26h) — nightly job may be stalled.`, evidence: { newest: newest.f, ageHours: +ageHours.toFixed(1), count: files.length } };
        return { status: "pass", summary: `Latest backup ${ageHours.toFixed(1)}h old (${files.length} retained).`, evidence: { newest: newest.f, ageHours: +ageHours.toFixed(1), count: files.length } };
      },
    ),
  );

  // 4. Process health — uptime and memory headroom.
  results.push(
    await runProbe(
      { id: "proc_health", name: "Process health", category: "Reliability", critical: false },
      async () => {
        const uptimeH = process.uptime() / 3600;
        const mem = process.memoryUsage();
        const rssMb = Math.round(mem.rss / 1_048_576);
        const heapMb = Math.round(mem.heapUsed / 1_048_576);
        return {
          status: "pass",
          summary: `Up ${uptimeH.toFixed(1)}h · RSS ${rssMb}MB · heap ${heapMb}MB · Node ${process.version}.`,
          evidence: { uptimeHours: +uptimeH.toFixed(2), rssMb, heapMb, node: process.version },
        };
      },
    ),
  );

  return results;
}
