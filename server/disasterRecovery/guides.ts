/**
 * Disaster Recovery — the plain-language documents placed inside every backup.
 * Written so a person who has never seen AiPM before can recover it.
 */
import type { BackupManifest } from "./manifest";
import { REQUIRED_SECRETS, TRANSIENT_TABLES } from "./config";

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function folderLayout(): string {
  return [
    "```",
    "<backup folder, e.g. 2026-11-05_0900Z>/",
    "  00_HOW_TO_RESTORE.md        ← step-by-step recovery instructions (start here)",
    "  01_BACKUP_SUMMARY.md        ← what this backup contains, with row counts",
    "  manifest.json               ← machine-readable packing list + checksums",
    "  1_Database/                 ← the EXACT database copy used to restore",
    "      schema_1_tables.sql",
    "      schema_2_keys_indexes.sql",
    "      sequences.json",
    "      data/<table>.jsonl.gz   ← one file per table, every row",
    "      aipm-database.pgdump    ← second, independent copy in standard PostgreSQL format",
    "  2_Readable_Spreadsheet/     ← every table as a tab in Excel (for people to read)",
    "  3_Server_Files/             ← files saved on the server's disk (project folders, templates)",
    "  4_Application_Source/       ← the complete AiPM application source code",
    "  5_Configuration/            ← list of passwords/keys to re-enter + deployment settings",
    "```",
  ].join("\n");
}

export function restoreGuide(m: BackupManifest): string {
  return `# How to restore AiPM from this backup

**Backup:** \`${m.backupId}\`  ·  **Taken:** ${m.database.snapshotTakenAt}  ·  **App version (git commit):** \`${m.application.gitCommit}\`

This folder alone is enough to rebuild AiPM completely — the application, the database,
and the stored files — on a brand-new server, even if the original Replit account,
database and GitHub repository are all gone.

Plan for about **1–2 hours**. You need someone comfortable typing commands
(a developer or Swinerton IT), plus the passwords/keys listed in
\`5_Configuration/REQUIRED_SECRETS.md\` (kept in Swinerton's password vault, never in this backup).

---

## Step 0 — Check the backup is complete

Open \`01_BACKUP_SUMMARY.md\`. It should say **Status: COMPLETE**. Then download this
whole folder to the computer/server you will restore from (in SharePoint: select the
folder → **Download**; it arrives as a .zip — unzip it).

## Step 1 — Get the application code

* **If GitHub still exists:** use repository \`ikigaiengine/aipm-tool-belt-2026\` at commit \`${m.application.gitCommit}\`.
* **If not:** unzip \`4_Application_Source/aipm-source-code.zip\`. That is the identical code.

Put the code into a new Replit project (Create Repl → Import → upload the files) or any
Linux server with **Node.js 20+** and **PostgreSQL 16**.

## Step 2 — Create an empty database

* **Replit:** open the **Database** tool → *Create a database*. Replit sets \`DATABASE_URL\` automatically.
* **Elsewhere:** create an empty PostgreSQL 16 database and note its connection string.

## Step 3 — Re-enter the secrets

Add each value in \`5_Configuration/REQUIRED_SECRETS.md\` as a Replit *Secret*
(or environment variable). At minimum: \`DATABASE_URL\`, \`SESSION_SECRET\`,
\`OPENAI_API_KEY\`, \`SENDGRID_API_KEY\`.

## Step 4 — Install the app

In the Shell, inside the code folder:

\`\`\`
npm install
\`\`\`

## Step 5 — Restore the database

\`\`\`
npx tsx scripts/dr-restore.ts --backup "/path/to/${m.backupId}"
\`\`\`

The tool will:
1. check every file against its checksum (stops if anything is damaged),
2. create all ${m.database.tables.length} tables,
3. load all ${m.database.totalRows.toLocaleString()} rows,
4. add keys, links between tables, and indexes,
5. compare every table's row count with this backup.

It runs as a single all-or-nothing step: if anything fails, the database is left untouched.
It refuses to run against a database that already has data, unless you add \`--wipe-target\`.

*Alternative for database administrators:* \`1_Database/aipm-database.pgdump\` is a
standard PostgreSQL backup: \`pg_restore --no-owner --no-privileges -d "$DATABASE_URL" aipm-database.pgdump\`.

## Step 6 — Restore the server files

\`\`\`
npx tsx scripts/dr-restore.ts --backup "/path/to/${m.backupId}" --files-only
\`\`\`

This unpacks \`3_Server_Files/aipm-server-files.zip\` (project folders and templates) into the app folder.
(Most stored files — PDFs, templates, vendor files — are also inside the database itself.)

## Step 7 — Start and check

\`\`\`
npm run dev
\`\`\`

Wait for \`serving on port 5000\`. Open the app, sign in with your email code, and check:
* the Proposal Log shows the expected number of entries (see the summary),
* a recent estimate opens with its line items and quotes,
* a vendor in the Vendor Database shows its files.

For a permanent site, use Replit **Deploy/Publish** (\`npm run build\` then \`npm run start\`).

## Step 8 — Reconnect outside services

* **Autodesk / BuildingConnected:** if the web address changed, update the callback URL in the
  Autodesk developer portal and \`APS_REDIRECT_DOMAIN\`, then reconnect from the app.
* **Email (SendGrid):** confirm a login email arrives.
* **This backup:** re-enter the \`DR_*\` settings so nightly backups to SharePoint resume.

---
_Questions: the full disaster-recovery runbook is in the source code at \`docs/DISASTER_RECOVERY.md\`._
`;
}

export function backupSummary(m: BackupManifest): string {
  const rows = m.database.tables
    .map((t) => `| ${t.table} | ${t.dataSkipped ? "— (not backed up, see note)" : t.rowCount.toLocaleString()} |`)
    .join("\n");
  const skipped = Object.entries(TRANSIENT_TABLES).map(([k, v]) => `* \`${k}\`: ${v}`).join("\n");
  const warnings = m.warnings.length ? m.warnings.map((w) => `* ${w}`).join("\n") : "* None";
  return `# AiPM backup summary — ${m.backupId}

**Status: COMPLETE** — every section below was written and checksummed.

| Item | Value |
|---|---|
| Backup started | ${m.createdAt} |
| Backup finished | ${m.completedAt} |
| Database snapshot (single point in time) | ${m.database.snapshotTakenAt} |
| Application version (git commit) | \`${m.application.gitCommit}\` (${m.application.gitBranch}) |
| Database | PostgreSQL ${m.database.serverVersion} |
| Tables | ${m.database.tables.length} |
| Total rows | ${m.database.totalRows.toLocaleString()} |
| Standard pg_dump copy included | ${m.database.pgDumpIncluded ? "Yes" : "No"} |
| Server files | ${m.serverFiles.included ? `${m.serverFiles.fileCount.toLocaleString()} files` : m.serverFiles.note || "None"} |
| Source code | ${m.sourceCode.included ? `${m.sourceCode.fileCount.toLocaleString()} files` : m.sourceCode.note || "Not included"} |
| Total backup size | ${mb(m.totalBytes)} |
| Files in this backup (all checksummed) | ${m.files.length} |

## Folder layout

${folderLayout()}

## Rows per table

| Table | Rows |
|---|---|
${rows}

## Intentionally excluded

Only short-lived security tokens are left out (their tables are still recreated, empty):

${skipped}

## Warnings

${warnings}
`;
}

export function databaseReadme(): string {
  return `# 1_Database — the exact copy of the AiPM database

Use \`scripts/dr-restore.ts\` (see ../00_HOW_TO_RESTORE.md) to load this. You do not need to open these files by hand.

| File | What it is |
|---|---|
| schema_1_tables.sql | Creates every table and column (plain SQL). |
| schema_2_keys_indexes.sql | Adds primary keys, links between tables (foreign keys) and indexes. |
| sequences.json | The next ID number for every table, so new records continue the same numbering. |
| data/<table>.jsonl.gz | Every row of one table. Gzip-compressed text: line 1 is the column list, each later line is one row. Values are in PostgreSQL's own text format (exact dates, amounts, JSON, and stored files in hex). |
| aipm-database.pgdump | (If present) a second, independent copy made with PostgreSQL's standard \`pg_dump\` tool. A DBA can restore it with \`pg_restore\`. |

Every file's SHA-256 checksum is recorded in ../manifest.json so damage or tampering is detected before restoring.
`;
}

export function secretsGuide(presentNames: Set<string>): string {
  const rows = REQUIRED_SECRETS.map((s) =>
    `| \`${s.name}\` | ${s.required ? "**Yes**" : "Optional"} | ${presentNames.has(s.name) ? "Set" : "Not set"} | ${s.purpose} | ${s.source} |`,
  ).join("\n");
  return `# Passwords and keys AiPM needs (names only — no values)

For security, **secret values are never written into this backup.** Keep the actual values
in Swinerton's password manager / IT vault. During a recovery, re-enter each one as a
Replit Secret (or environment variable) with exactly the name shown.

"In production" shows whether the setting existed on the server when this backup was taken.

| Name | Required | In production | What it does | Where to get it |
|---|---|---|---|---|
${rows}
`;
}

/** The guide kept at the very top of the SharePoint folder (overwritten every night). */
export function topLevelReadme(latestId: string, destination: string, retainDaily = 30, retainMonthly = 12): string {
  return `# AiPM — Disaster Recovery Backups

This folder holds the complete, automatic nightly backups of **AiPM Tool Belt**.
It is owned and controlled by Swinerton (Microsoft 365).

**Latest complete backup:** \`Backups/${latestId}\`

Each backup folder under \`Backups/\` is self-contained: with any single one of them,
AiPM can be rebuilt from nothing — application, database and files — even if the
original hosting, database and code repository are lost.

## Where to start

1. Open \`Backups/${latestId}/00_HOW_TO_RESTORE.md\`.
2. Follow the steps in order.

## How backups are kept

* A new backup is added automatically (at least nightly).
* Kept: every backup from the last 48 hours, one per day for the last ${retainDaily} days, and one per month for the last ${retainMonthly} months.
* Older ones are removed automatically (they stay in the SharePoint recycle bin for 93 days).
* A backup folder only appears here after it is 100% uploaded. An unfinished
  upload is held in \`_in-progress/\` and is never mistaken for a complete one.

## Each backup contains

${folderLayout()}

---
_Destination: ${destination}. Last updated ${new Date().toISOString()}._
`;
}
