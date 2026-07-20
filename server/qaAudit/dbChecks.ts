// Database + data-integrity checks. These run in-process, co-located with the
// app, so they can talk directly to Postgres. They confirm the DB is reachable,
// the session store works, seed/reference data exists, core business tables are
// readable, and there are no fresh unresolved application errors piling up.

import { sql } from "drizzle-orm";
import { runProbe, type CheckResult } from "./types";

async function count(table: string, where?: string): Promise<number> {
  const { db } = await import("../db");
  const q = where
    ? sql.raw(`select count(*)::int as c from "${table}" where ${where}`)
    : sql.raw(`select count(*)::int as c from "${table}"`);
  const rows: any = await db.execute(q as any);
  const list = Array.isArray(rows) ? rows : rows?.rows ?? [];
  return Number(list[0]?.c ?? 0);
}

export async function runDbChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. Raw connectivity — nothing else matters if this fails.
  results.push(
    await runProbe(
      { id: "db_connectivity", name: "Database connectivity", category: "Database", critical: true },
      async () => {
        const { db } = await import("../db");
        const start = Date.now();
        await db.execute(sql`select 1 as ok`);
        return { status: "pass", summary: `Connected — SELECT 1 in ${Date.now() - start}ms.` };
      },
    ),
  );

  // If we couldn't even connect, skip the rest of the DB probes cleanly.
  if (results[0].status === "fail") {
    for (const [id, name] of [
      ["db_session_store", "Session store table"],
      ["db_admin_present", "Active admin account exists"],
      ["db_permission_profiles", "Permission profiles seeded"],
      ["db_regions_seeded", "Regions reference data"],
      ["db_proposal_log", "Proposal log readable"],
      ["db_recent_errors", "Recent application errors"],
    ] as const) {
      results.push({
        id, name, category: "Database", status: "skip", critical: false, durationMs: 0,
        summary: "Skipped — database unreachable.",
      });
    }
    return results;
  }

  // 2. Session store — logins depend on the connect-pg-simple "session" table.
  results.push(
    await runProbe(
      { id: "db_session_store", name: "Session store table", category: "Database", critical: true },
      async () => {
        const c = await count("session");
        return { status: "pass", summary: `Session store reachable (${c} active sessions).`, evidence: { sessions: c } };
      },
    ),
  );

  // 3. At least one active admin — otherwise nobody can administer the platform.
  results.push(
    await runProbe(
      { id: "db_admin_present", name: "Active admin account exists", category: "Database", critical: true },
      async () => {
        const admins = await count("users", "is_active = true and (role = 'admin' or is_admin = true)");
        const total = await count("users");
        if (admins === 0) {
          return { status: "fail", summary: "No active admin account found — platform is unadministrable.", evidence: { admins, users: total } };
        }
        return { status: "pass", summary: `${admins} active admin(s) of ${total} users.`, evidence: { admins, users: total } };
      },
    ),
  );

  // 4. Permission profiles seeded — RBAC breaks without them.
  results.push(
    await runProbe(
      { id: "db_permission_profiles", name: "Permission profiles seeded", category: "Database", critical: false },
      async () => {
        const c = await count("permission_profiles");
        return c > 0
          ? { status: "pass", summary: `${c} permission profile(s) present.`, evidence: { profiles: c } }
          : { status: "warn", summary: "No permission profiles found — RBAC may fall back to defaults.", evidence: { profiles: c } };
      },
    ),
  );

  // 5. Regions reference data — drives region matching across the app.
  results.push(
    await runProbe(
      { id: "db_regions_seeded", name: "Regions reference data", category: "Database", critical: false },
      async () => {
        const c = await count("regions");
        return c > 0
          ? { status: "pass", summary: `${c} region(s) configured.`, evidence: { regions: c } }
          : { status: "warn", summary: "No regions configured — region matching will be degraded.", evidence: { regions: c } };
      },
    ),
  );

  // 6. Core business table readable — the proposal log is the heart of the app.
  results.push(
    await runProbe(
      { id: "db_proposal_log", name: "Proposal log readable", category: "Database", critical: true },
      async () => {
        const active = await count("proposal_log_entries", "deleted_at is null");
        const deleted = await count("proposal_log_entries", "deleted_at is not null");
        return { status: "pass", summary: `Proposal log OK — ${active} active, ${deleted} soft-deleted.`, evidence: { active, deleted } };
      },
    ),
  );

  // 7. Fresh unresolved application errors — the app self-reports to system_errors.
  results.push(
    await runProbe(
      { id: "db_recent_errors", name: "Recent application errors (24h)", category: "Reliability", critical: false },
      async () => {
        const fresh = await count("system_errors", "status = 'new' and last_seen_at > now() - interval '24 hours'");
        const critical = await count(
          "system_errors",
          "status = 'new' and priority = 'high' and last_seen_at > now() - interval '24 hours'",
        );
        if (critical > 0) {
          return {
            status: "fail",
            summary: `${critical} high-priority error(s) reported in the last 24h.`,
            detail: "Review the Admin → Errors dashboard.",
            evidence: { fresh, critical },
          };
        }
        if (fresh > 5) {
          return { status: "warn", summary: `${fresh} new errors in the last 24h (threshold 5).`, evidence: { fresh, critical } };
        }
        return { status: "pass", summary: fresh === 0 ? "No new errors in the last 24h." : `${fresh} new error(s), none high-priority.`, evidence: { fresh, critical } };
      },
    ),
  );

  return results;
}
