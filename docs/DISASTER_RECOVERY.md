# AiPM Disaster Recovery — Swinerton SharePoint / OneDrive Backup

**Audience:** AiPM owners, Swinerton leadership, Swinerton IT, and whoever performs a recovery.
**Purpose:** Explain how AiPM is fully backed up to a Swinerton-owned Microsoft 365 location, how to set it up, and how to rebuild AiPM from that backup alone.

---

## 1. Summary for leadership

> AiPM is backed up automatically to a SharePoint site owned and run by Swinerton.
> Each backup is complete and stands on its own. It holds every database table,
> every stored file, the full application source code, and step-by-step restore
> instructions. If AiPM's hosting, database, or code repository were deleted, lost,
> compromised or shut down, AiPM could be rebuilt from any single backup on new
> infrastructure.
>
> Every backup is checked for completeness when it is made, and again before it is
> restored. The restore process has been tested end to end: a backup was restored into
> an empty database and matched the original exactly, table by table.

**How much data could be lost?** At most, whatever changed since the last backup.
The default is one backup per night. `DR_BACKUP_EVERY_HOURS` can raise this to as
often as every hour (for example, `4` caps any loss at about 4 hours of changes).

**How long does a recovery take?** About 1–2 hours of hands-on work by a developer or IT
person, following `00_HOW_TO_RESTORE.md` inside the backup.

---

## 2. What is protected

| Area | Included? | Where it lives in each backup |
|---|---|---|
| All database tables (Proposal Log, projects, estimates, line items, quotes, vendors, manufacturers, users, permissions, settings, audit history, …) | **Yes, every table, found automatically.** Tables added in future are included without code changes. | `1_Database/` |
| Files stored inside the database (spec PDFs, estimate templates, vendor quote PDFs, screenshots, folder templates) | **Yes**, byte-for-byte | `1_Database/` |
| Files saved on the server's disk (`projects/` folders, `data/` templates) | **Yes** | `3_Server_Files/aipm-server-files.zip` |
| Application source code | **Yes**, the exact running version, plus its git commit number | `4_Application_Source/aipm-source-code.zip` |
| Deployment settings (`.replit`, `replit.nix`, `package.json`) | **Yes** | `5_Configuration/` and the source zip |
| List of every password/API key the app needs | **Names, purpose and where to get each.** | `5_Configuration/REQUIRED_SECRETS.md` |
| The actual password/API key **values** | **No, by design.** Keep these in Swinerton's password vault. | — |
| Active login sessions and one-time login codes | **No, by design** (short-lived security tokens). Tables are recreated empty; users just sign in again. | — |

Each backup has **two independent copies of the database**:

1. **The AiPM portable copy:** plain SQL plus one compressed file per table. The restore tool uses this one, and any PostgreSQL 16 database can load it.
2. **A standard `pg_dump` copy** (`aipm-database.pgdump`): a format any database administrator knows. They can restore it with `pg_restore` without AiPM's tools.

There's also a **readable Excel copy** (`2_Readable_Spreadsheet/`) with every table as a tab, so the data can be read even if AiPM is never brought back.

---

## 3. How it works

```
 AiPM server (Replit)                                   Swinerton Microsoft 365 (SharePoint)
 ─────────────────────                                  ─────────────────────────────────────
 1. Snapshot the whole database at one instant  ─┐
 2. Pack server files + source code              │      AiPM Disaster Recovery/
 3. Write guides, summary, checksums (SHA-256)   │        00_READ_ME_FIRST.md
 4. Upload every file to _in-progress/  ─────────┼──▶     LATEST_BACKUP.txt
 5. Confirm each file's size on SharePoint       │        Backups/
 6. Move the finished folder into Backups/  ─────┘          2026-11-05_0900Z/   ← complete backups only
 7. Remove old backups per the retention policy             2026-11-04_0900Z/
 8. Record the result; email the admin if it failed         …
                                                          _in-progress/        ← unfinished uploads only
```

* **Consistent snapshot.** All tables are read inside one database transaction, so the backup reflects a single moment. You never get, say, an estimate whose line items were saved a second later.
* **Never half a backup.** A folder only appears under `Backups/` after every file is uploaded and confirmed. Interrupted uploads stay in `_in-progress/` and are cleared after 2 days.
* **Damage detection.** `manifest.json` records the size and SHA-256 checksum of every file. The restore tool checks all of them before touching any database.
* **Retention.** Keeps every backup from the last 48 hours, one per day for 30 days, and one per month for 12 months. Change this with `DR_RETAIN_DAILY` and `DR_RETAIN_MONTHLY`. Removed backups stay in the SharePoint recycle bin for 93 days.
* **One at a time.** A database lock stops two backups from ever running at once.
* **Alerts.** If a backup fails, it retries about an hour later and emails `ADMIN_NOTIFICATION_EMAIL`. The Admin screen shows a red warning until a backup succeeds.
* **Visibility.** **Admin → Data Backup & Recovery** shows status, destination, schedule, the last 14 runs, a **Back up now** button, and a **Test connection** button.

### When backups run

The AiPM server checks every 15 minutes whether a backup is due (default: daily at 09:00 UTC, which is 1–2 AM Pacific).
If the server was asleep at that time, the backup runs within minutes of the next wake-up.

AiPM is on Replit **Autoscale**, which may put the server to sleep when nobody is using it.
To guarantee a backup every night whether or not anyone is using AiPM, also set up **one** of these:

* **Option A — Power Automate (recommended, Swinerton-owned).** See section 4, step 5.
* **Option B — Replit Scheduled Deployment.** In Replit, create a *Scheduled* deployment from the same project, with run command `npx tsx scripts/dr-backup.ts` and a daily schedule. Give it the same Secrets.

---

## 4. Setup

There are two ways to connect AiPM to Swinerton Microsoft 365. Pick one.

| | **Option 1 — Power Automate → your OneDrive (no IT)** | **Option 2 — SharePoint site via app registration (IT)** |
|---|---|---|
| Who sets it up | The AiPM owner, alone | Swinerton IT |
| Needs | Power Automate (standard actions only) + OneDrive | Entra ID app registration + SharePoint admin |
| Where backups go | Owner's OneDrive: 7 daily + 12 monthly .zip files | A SharePoint site: 48 h + 30 daily + 12 monthly folders |
| Guide | **[`DR_SETUP_POWER_AUTOMATE.md`](DR_SETUP_POWER_AUTOMATE.md)** | Steps below |

Option 1 is the default plan. Option 2 can be added later, and both can run together.

### Option 2 steps (Swinerton IT, about 30 minutes, one time)

### Step 1: Create the SharePoint site

Create a SharePoint site, for example `https://swinerton.sharepoint.com/sites/AiPM-Backups`.
Limit its members to the AiPM owners and IT. The backups contain business data (vendor pricing, user emails, the Autodesk connection token), so treat the site as confidential.
Optional: apply a Microsoft Purview retention label to the library so backups can't be permanently deleted early.

### Step 2: Register an app in Microsoft Entra ID (Azure AD)

1. Entra admin center → **App registrations** → **New registration** → name it `AiPM Disaster Recovery Backup` → single tenant → Register.
2. Note the **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets** → **New client secret** → set an expiry (for example, 24 months) → copy the **Value**.
   *Put a calendar reminder before it expires. An expired secret makes backups fail, and the admin is emailed.*
4. **API permissions** → **Add a permission** → Microsoft Graph → **Application permissions** → **`Sites.Selected`** → Add → **Grant admin consent**.

`Sites.Selected` means the app can reach **no** SharePoint site until it is granted one explicitly, which is the next step. AiPM can never see any other Swinerton data.

### Step 3: Give the app write access to the backup site only

With PnP PowerShell, as a SharePoint admin:

```powershell
Connect-PnPOnline -Url "https://swinerton.sharepoint.com/sites/AiPM-Backups" -Interactive
Grant-PnPAzureADAppSitePermission -AppId "<client id>" -DisplayName "AiPM Disaster Recovery Backup" -Site "https://swinerton.sharepoint.com/sites/AiPM-Backups" -Permissions Write
```

(Or, in Graph Explorer: `POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions` with role `write` for the app.)

*Using OneDrive instead:* set `DR_ONEDRIVE_USER` to a dedicated service account's address instead of a site URL. That requires the broader `Files.ReadWrite.All` permission, so the SharePoint site approach above is preferred.

### Step 4: Enter the settings in Replit

In the Replit workspace, open **Tools → Secrets** and add:

| Secret | Value |
|---|---|
| `DR_MS_TENANT_ID` | Directory (tenant) ID |
| `DR_MS_CLIENT_ID` | Application (client) ID |
| `DR_MS_CLIENT_SECRET` | The client secret **value** |
| `DR_SHAREPOINT_SITE_URL` | `https://swinerton.sharepoint.com/sites/AiPM-Backups` |
| `DR_BACKUP_TRIGGER_TOKEN` | A long random string (for Option A below), e.g. from a password generator |

Optional settings: `DR_SHAREPOINT_LIBRARY` (default: the site's "Documents"), `DR_ROOT_FOLDER` (default `AiPM Disaster Recovery`), `DR_BACKUP_HOUR_UTC` (default `9`), `DR_BACKUP_EVERY_HOURS` (default `24`), `DR_RETAIN_DAILY` (default `30`), `DR_RETAIN_MONTHLY` (default `12`), `DR_BACKUP_DISABLED`.

Then **Republish** the deployment so production picks up the Secrets, and restart the dev server (see `CLAUDE.md`).
Open **Admin → Data Backup & Recovery** → **Test connection** → **Back up now**. Then confirm the folder appears in SharePoint.

### Step 5: Option A, the Power Automate nightly flow

1. Power Automate → **Create** → **Scheduled cloud flow** → daily, for example 01:30 Pacific.
2. Add the **HTTP** action (a Premium connector):
   * Method `POST`
   * URI `https://<your AiPM address>/api/dr-backup/trigger`
   * Headers: `Authorization` = `Bearer <DR_BACKUP_TRIGGER_TOKEN>`
   * Settings → **Asynchronous pattern: On** (the default). Timeout: `PT1H`.
3. Optional: add a condition. If the HTTP status isn't 200, send an email or Teams alert to IT.

AiPM replies "started" right away along with a status link. Power Automate keeps checking that link until the backup finishes, and those check-ins keep the server awake the whole time. The final status is 200 when the backup succeeded and 500 when it failed.

---

## 5. Recovery

Full step-by-step instructions are written into **every backup** as `00_HOW_TO_RESTORE.md`, filled in with that backup's details. In short:

```bash
# 1. Get the code (GitHub, or unzip 4_Application_Source/aipm-source-code.zip)
# 2. Create an empty PostgreSQL 16 database (Replit: Database tool) → DATABASE_URL
# 3. Re-enter Secrets listed in 5_Configuration/REQUIRED_SECRETS.md
npm install
npx tsx scripts/dr-restore.ts --backup "/path/to/2026-11-05_0900Z"            # verifies, then restores the DB
npx tsx scripts/dr-restore.ts --backup "/path/to/2026-11-05_0900Z" --files-only # unpacks server files
npm run dev
```

The `--backup` argument can be the downloaded folder **or** the `.zip` SharePoint gives you when you download a folder.

Safety features of the restore tool:

* It checks every file's checksum first. A damaged or incomplete backup is rejected before anything is changed.
* It refuses to overwrite a database that already has tables, unless you add `--wipe-target`.
* The whole restore is one all-or-nothing transaction. If anything fails, the target database is left exactly as it was.
* After loading, it compares every table's row count with the backup.
* `--verify-only` checks a backup without restoring anything. Use it for routine spot checks.

---

## 6. Ongoing checks

| When | What | Who |
|---|---|---|
| Weekly (1 minute) | Glance at **Admin → Data Backup & Recovery**: green "Protected" status. | AiPM admin |
| Quarterly (about 1 hour) | **Restore drill:** download the latest backup, run `--verify-only`, then restore into a scratch Replit database and open the app. Note the date in the table below. | AiPM owner + IT |
| Before the client secret expires | Create a new secret in Entra and update `DR_MS_CLIENT_SECRET`. | Swinerton IT |
| When a new password/API key is added to AiPM | Add it to `REQUIRED_SECRETS` in `server/disasterRecovery/config.ts` and to the password vault. | Developer |

### Restore drill log

| Date | Backup used | Result | By |
|---|---|---|---|
| 2026-11-05 | Test database (69 tables, 25k rows, 3 MB binary file, emoji/Unicode/arrays/JSON) | Restored into an empty database: 66 of 67 tables identical row-for-row; the only difference was the backup's own status row, written after the snapshot. Structure, keys, indexes and ID counters identical. Also tested: the `pg_dump` copy, a SharePoint-style zip download, a damaged file (rejected), and a non-empty target (refused). | Claude Code (development) |

---

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| "Microsoft sign-in failed (401)" | Wrong tenant/client ID, or the client secret is wrong or expired. Create a new secret in Entra. |
| "…failed (403): Access denied" | Step 3 wasn't done, or was done for a different site. Re-run `Grant-PnPAzureADAppSitePermission`. |
| "…failed (404)" on the site | `DR_SHAREPOINT_SITE_URL` has a typo, or `DR_SHAREPOINT_LIBRARY` names a library that doesn't exist. |
| Status says "Server only" | The `DR_*` Secrets aren't set (or production wasn't republished after adding them). |
| No backup for days, no error | Autoscale was asleep and no scheduler is set up. Set up Option A or B in section 3. |
| Folders piling up in `_in-progress/` | Uploads are being interrupted (server going to sleep). Use Option A. Old ones clear automatically after 2 days. |
| "The optional pg_dump copy was skipped" warning | `pg_dump` isn't installed on that server, or is an older version than the database. The main database copy is unaffected. |

---

## 8. Technical reference (for developers)

| File | Role |
|---|---|
| `server/disasterRecovery/config.ts` | All settings, the required-secrets list, and the excluded transient tables |
| `server/disasterRecovery/databaseSnapshot.ts` | Catalog-driven schema export and consistent, lossless data export |
| `server/disasterRecovery/databaseRestore.ts` | Checksum verification and transactional restore |
| `server/disasterRecovery/readableWorkbook.ts` | The Excel copy |
| `server/disasterRecovery/packageBuilder.ts` | Assembles one backup folder plus its manifest |
| `server/disasterRecovery/guides.ts` | The documents written into each backup |
| `server/disasterRecovery/sharepointClient.ts` | Microsoft Graph upload, move, list and delete, with retry on throttling |
| `server/disasterRecovery/runBackup.ts` | Orchestration, locking, status, retention, alerts and schedule rules |
| `server/disasterRecovery/routes.ts` | Admin API, Power Automate trigger and download link, and the scheduler |
| `server/disasterRecovery/pickup.ts` | Power Automate pickup: one-zip download and the READ ME guide |
| `client/src/components/DisasterRecoveryCard.tsx` | Admin UI card |
| `scripts/dr-backup.ts` / `scripts/dr-restore.ts` | Command-line backup and restore |
| `server/disasterRecovery/schedule.test.ts` | Tests for schedule and retention (`npx tsx server/disasterRecovery/schedule.test.ts`) |

The older backups still exist alongside this one: the nightly Proposal Log Excel file on the server's disk, and the admin "Download Backup" workbook. Both are partial convenience exports. This disaster-recovery backup is the one that supports a full rebuild.
