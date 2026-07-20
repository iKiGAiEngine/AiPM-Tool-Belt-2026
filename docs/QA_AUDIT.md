# AiPM QA Audit — Automated Site Health & Quality Assurance

A synthetic-monitoring / smoke-test system that audits the full AiPM site and
platform on a schedule and produces a single at-a-glance verdict:

- 🟢 **GREEN** — all checks passed, all is well.
- 🟡 **YELLOW** — site is up, but one or more checks are failing or warning; review needed.
- 🔴 **RED** — a critical check failed (site down, DB unreachable, auth not enforced, etc.).

Every run lists **exactly what was checked**, pass/fail per item, timing, and
evidence — so the report is both a green light and an itemized inspection.

---

## What it checks

| Category | Checks |
| --- | --- |
| **Availability** | `/health` liveness, `/api/version` API layer, web app shell (`/`) renders, unknown API routes return clean 404s |
| **Performance** | API response-time budget (warn ≥ 2.5s, fail ≥ 8s) |
| **Security** | Authentication is actually enforced on a protected admin API (anonymous request must be rejected); user-features endpoint gated |
| **Database** | Connectivity (`SELECT 1`), session store table, ≥1 active admin account, permission profiles seeded, regions reference data, proposal log readable (active vs soft-deleted counts) |
| **Reliability** | Fresh unresolved application errors in the last 24h (from `system_errors`), process uptime/memory |
| **Configuration** | Required env present & safe (`DATABASE_URL`, `SESSION_SECRET` not the dev default in prod), integration wiring inventory (SendGrid, OpenAI, Autodesk APS, Google Sheet) |
| **Background jobs** | Nightly backup freshness (fails if newest backup > 26h old) |
| **Cost** | Estimated monthly run-rate vs. optional budget, AI cost visibility (see Cost & Usage below) |

Checks are marked **critical** or not. A critical failure ⇒ RED. A non-critical
failure or any warning ⇒ YELLOW. Everything green ⇒ GREEN.

Full list lives in `server/qaAudit/httpChecks.ts`, `dbChecks.ts`, and
`platformChecks.ts`. Add a check by pushing another `runProbe(...)` result — the
runner, report, email, and dashboards pick it up automatically.

---

## How it runs (three independent paths — use any or all)

### 1. In-app scheduler (default, zero setup)
The server starts `startQaAuditScheduler()` on boot (`server/index.ts`). It runs
**~90s after startup and then every 12 hours** (twice daily), auditing the live
site over loopback **plus** the in-process database and config. Each run is:
- **persisted** to the `qa_audit_runs` table (rolling history), and
- **emailed** to the ops recipient per the alert policy below.

### 2. On-demand from the admin API
Admin-gated endpoints:
- `POST /api/admin/qa-audit/run` — run now, returns the full JSON report.
- `GET  /api/admin/qa-audit/latest` — most recent stored run.
- `GET  /api/admin/qa-audit/history?limit=30` — recent runs, newest first.
- `GET  /api/admin/qa-audit/report.html` — latest run as a styled HTML page
  (add `?run=1` to run a fresh one). This is the human "what was checked" view.

### 3. Standalone CLI / external cron / GitHub Actions
```bash
# HTTP-only audit of the live site (no DB needed) — ideal for CI or external cron:
QA_AUDIT_BASE_URL=https://your-aipm-app.example npm run qa:audit

# Full local audit (HTTP + DB + config), co-located with the app:
DATABASE_URL=postgres://... QA_AUDIT_BASE_URL=http://localhost:5000 \
  npm run qa:audit -- --out qa-audit-report
```
The CLI prints a Markdown report (or `--json`), writes `report.{json,md,html}`
when `--out` is given, and **exits non-zero on RED** (or on YELLOW with
`--strict`) so it gates a pipeline.

A ready-to-use **GitHub Actions workflow** (`.github/workflows/qa-audit.yml`)
runs the CLI twice daily against the deployed URL, uploads the report as an
artifact, writes it to the job summary, and fails (notifying you) on RED.
Setup: add a repository **variable** `QA_AUDIT_BASE_URL` = the deployed site URL.

---

## Cost & Usage (what it costs to run the site)

Every in-process audit (scheduler / admin / `--local` CLI) includes a **Cost &
Usage** section: last-24h cost, last-30d cost, and a **projected monthly
run-rate**, broken down by driver (AI, email, infrastructure). Also exposed on
its own at `GET /api/admin/qa-audit/cost`.

Two sources of truth:
- **AI (measured)** — every OpenAI call is wrapped by `instrumentOpenAI()`
  (`server/aiUsage.ts`), which records real token usage per model/operation to
  the `ai_usage_events` ledger. Cost is `tokens × rate card`, exact.
- **AI (estimated)** — before the ledger has data, AI cost is ballparked from the
  volume of already-processed work (emails parsed, quotes read, chats, spec/plan/
  estimate runs) × assumed tokens per operation. Clearly labelled "estimated";
  it becomes measured automatically as AI features get used.
- **Email** — logged sends (`rfq_log`) × per-email rate.
- **Infrastructure** — fixed hosting + DB monthly cost you provide via env.

The **rate card** (`server/qaAudit/costModel.ts`) ships with current OpenAI list
prices for the models this app uses (`gpt-4o`, `gpt-4o-mini`) and is fully
overridable — provider pricing changes, so treat the defaults as an estimate and
set the env vars below to match your invoice.

| Env var | Purpose | Default |
| --- | --- | --- |
| `QA_AUDIT_INFRA_MONTHLY_USD` | Hosting cost per month | `0` |
| `QA_AUDIT_DB_MONTHLY_USD` | Database cost per month | `0` |
| `QA_AUDIT_EMAIL_RATE` | USD per email sent | `0.0006` |
| `QA_AUDIT_MONTHLY_BUDGET_USD` | Budget; warns at 80%, fails over 100% | unset |
| `QA_AUDIT_EST_TOKENS_IN` / `_OUT` | Assumed tokens/op for the estimate fallback | `3000` / `1200` |
| `QA_AUDIT_RATES_JSON` | Full rate-card override (JSON) | — |

Set `QA_AUDIT_MONTHLY_BUDGET_USD` to turn the run-rate into an alert: the audit
goes YELLOW as you approach it and flags it in the report/email.

## Alert policy (email)

Controlled by `QA_AUDIT_EMAIL_ON`:
- `problems` *(default)* — email on RED and YELLOW.
- `red-only` — email only on RED.
- `always` — email every run, including a daily GREEN "all clear".

Recipient: `QA_AUDIT_ALERT_EMAIL` → falls back to `ADMIN_NOTIFICATION_EMAIL`.
Email is sent via SendGrid when `SENDGRID_API_KEY` is set; otherwise the summary
is logged to the console (dev mode).

---

## Configuration reference

| Env var | Purpose | Default |
| --- | --- | --- |
| `QA_AUDIT_DISABLE` | `true` disables the in-app scheduler | off |
| `QA_AUDIT_SELF_URL` | Base URL the scheduler probes | `http://127.0.0.1:$PORT` |
| `QA_AUDIT_ALERT_EMAIL` | Report recipient | `ADMIN_NOTIFICATION_EMAIL` |
| `QA_AUDIT_EMAIL_ON` | `problems` \| `red-only` \| `always` | `problems` |
| `QA_AUDIT_BASE_URL` | CLI/CI target URL | — |
| `QA_AUDIT_STRICT` | `1` ⇒ YELLOW also fails the CLI/CI | off |
| `QA_AUDIT_OUT` | CLI: directory to write report files | — |

## Database migration

The audit history table is defined in `shared/schema.ts` (`qaAuditRuns`). Apply
it with:
```bash
npm run db:push
```
Persistence is best-effort — if the table isn't migrated yet, audits still run
and report; they just skip writing history (logged, non-fatal).
