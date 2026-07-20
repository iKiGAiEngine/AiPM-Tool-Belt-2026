// HTTP-level smoke checks. These exercise the live site the way a real browser
// or API client would: is it up, does it answer fast, is authentication
// actually enforced, does the SPA shell render, are public endpoints healthy.
//
// These checks only need a base URL, so they work identically from inside the
// running server (loopback) and from CI against the production URL.

import { runProbe, type AuditContext, type CheckResult } from "./types";

interface FetchOutcome {
  ok: boolean;
  status: number;
  ms: number;
  body: string;
  error?: string;
}

async function probe(
  baseUrl: string,
  pathOrUrl: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<FetchOutcome> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${baseUrl}${pathOrUrl}`;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "AiPM-QA-Audit/1.0", ...(init?.headers || {}) },
    });
    let body = "";
    try {
      // Cap body read so a huge HTML page doesn't blow up memory.
      body = (await res.text()).slice(0, 20_000);
    } catch {
      /* ignore body read errors */
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - start, body };
  } catch (err: any) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      ms: Date.now() - start,
      body: "",
      error: isTimeout ? `Timed out after ${timeoutMs}ms` : err?.message || String(err),
    };
  }
}

export async function runHttpChecks(ctx: AuditContext): Promise<CheckResult[]> {
  const baseUrl = ctx.baseUrl;
  if (!baseUrl) {
    return [
      {
        id: "http_target",
        name: "HTTP target configured",
        category: "Availability",
        status: "skip",
        summary: "No base URL supplied — HTTP smoke checks skipped.",
        detail: "Set QA_AUDIT_BASE_URL to enable end-to-end HTTP checks.",
        durationMs: 0,
        critical: false,
      },
    ];
  }
  const t = ctx.httpTimeoutMs;
  const results: CheckResult[] = [];

  // 1. Liveness — the single most important signal.
  results.push(
    await runProbe(
      { id: "http_health", name: "Server liveness (/health)", category: "Availability", critical: true },
      async () => {
        const r = await probe(baseUrl, "/health", t);
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}`, evidence: { url: baseUrl } };
        if (r.status !== 200) return { status: "fail", summary: `Expected 200, got ${r.status}.`, evidence: { status: r.status } };
        let ok = false;
        try {
          ok = JSON.parse(r.body)?.status === "ok";
        } catch {
          /* fall through */
        }
        return ok
          ? { status: "pass", summary: `Alive — responded 200 in ${r.ms}ms.`, evidence: { ms: r.ms } }
          : { status: "warn", summary: `200 but unexpected body.`, detail: r.body.slice(0, 200) };
      },
    ),
  );

  // 2. Version endpoint — confirms the API layer (not just the proxy) is serving.
  results.push(
    await runProbe(
      { id: "http_version", name: "API version endpoint (/api/version)", category: "Availability", critical: true },
      async () => {
        const r = await probe(baseUrl, "/api/version", t);
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}` };
        if (r.status !== 200) return { status: "fail", summary: `Expected 200, got ${r.status}.`, evidence: { status: r.status } };
        try {
          const j = JSON.parse(r.body);
          if (j?.name && j?.version) {
            return { status: "pass", summary: `Serving ${j.name} v${j.version}.`, evidence: { name: j.name, version: j.version, buildTime: j.buildTime } };
          }
        } catch {
          /* fall through */
        }
        return { status: "warn", summary: "200 but version payload malformed.", detail: r.body.slice(0, 200) };
      },
    ),
  );

  // 3. Response time budget — early warning on degradation.
  results.push(
    await runProbe(
      { id: "http_latency", name: "Response-time budget", category: "Performance", critical: false },
      async () => {
        const r = await probe(baseUrl, "/api/version", t);
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}` };
        const WARN = 2500;
        const FAIL = 8000;
        if (r.ms >= FAIL) return { status: "fail", summary: `Very slow: ${r.ms}ms (budget ${WARN}ms).`, evidence: { ms: r.ms, warnMs: WARN } };
        if (r.ms >= WARN) return { status: "warn", summary: `Slow: ${r.ms}ms (budget ${WARN}ms).`, evidence: { ms: r.ms, warnMs: WARN } };
        return { status: "pass", summary: `Snappy: ${r.ms}ms (budget ${WARN}ms).`, evidence: { ms: r.ms, warnMs: WARN } };
      },
    ),
  );

  // 4. SPA shell renders — the app actually loads for end users.
  results.push(
    await runProbe(
      { id: "http_app_shell", name: "Web app shell (/)", category: "Availability", critical: true },
      async () => {
        const r = await probe(baseUrl, "/", t, { headers: { accept: "text/html" } });
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}` };
        // Dev serves via Vite, prod serves built index.html — both return the root div + a script.
        if (r.status !== 200) return { status: "fail", summary: `Expected 200, got ${r.status}.`, evidence: { status: r.status } };
        const looksLikeApp = /<div id="root"/.test(r.body) || /<script/.test(r.body);
        return looksLikeApp
          ? { status: "pass", summary: "App shell served (HTML + root mount)." }
          : { status: "warn", summary: "200 but HTML did not contain expected app markers.", detail: r.body.slice(0, 200) };
      },
    ),
  );

  // 5. Authentication is actually enforced — a protected API rejects anon users.
  results.push(
    await runProbe(
      { id: "http_auth_enforced", name: "Authentication enforced on protected API", category: "Security", critical: true },
      async () => {
        const r = await probe(baseUrl, "/api/admin/users", t);
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}` };
        if (r.status === 401 || r.status === 403) {
          return { status: "pass", summary: `Anonymous request correctly rejected (${r.status}).`, evidence: { status: r.status } };
        }
        if (r.status === 200) {
          return { status: "fail", summary: "SECURITY: protected admin API served data to an anonymous request.", evidence: { status: r.status } };
        }
        return { status: "warn", summary: `Unexpected ${r.status} on protected endpoint.`, evidence: { status: r.status } };
      },
    ),
  );

  // 6. Feature endpoint also gates anonymous access (second auth signal).
  results.push(
    await runProbe(
      { id: "http_features_gated", name: "User-features endpoint gated", category: "Security", critical: false },
      async () => {
        const r = await probe(baseUrl, "/api/user/features", t);
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}` };
        if (r.status === 401) return { status: "pass", summary: "Anonymous request correctly rejected (401)." };
        if (r.status === 200) return { status: "warn", summary: "Returned 200 to anonymous request — verify this is intended." };
        return { status: "warn", summary: `Unexpected ${r.status}.`, evidence: { status: r.status } };
      },
    ),
  );

  // 7. Unknown API route returns a clean 404 (routing/catch-all sane).
  results.push(
    await runProbe(
      { id: "http_unknown_route", name: "Unknown API route handling", category: "Availability", critical: false },
      async () => {
        const r = await probe(baseUrl, "/api/__qa_audit_nonexistent__", t);
        if (r.error) return { status: "fail", summary: `Unreachable: ${r.error}` };
        if (r.status === 404) return { status: "pass", summary: "Unknown API path returns 404 as expected." };
        if (r.status >= 500) return { status: "fail", summary: `Unknown path returned server error ${r.status}.`, evidence: { status: r.status } };
        return { status: "warn", summary: `Unknown path returned ${r.status} (expected 404).`, evidence: { status: r.status } };
      },
    ),
  );

  return results;
}
