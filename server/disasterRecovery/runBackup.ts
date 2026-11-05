/**
 * Disaster Recovery — runs one complete backup: build → upload → verify → publish → prune.
 *
 * Safe to call from the web server (nightly schedule / admin button / Power Automate)
 * or from the command line (scripts/dr-backup.ts). Only one backup can run at a time,
 * enforced by a PostgreSQL advisory lock, even across multiple server instances.
 */
import fs from "fs";
import path from "path";
import type pg from "pg";
import { getDrConfig, isMicrosoftConfigured, describeDestination, type DrConfig } from "./config";
import { buildBackupPackage } from "./packageBuilder";
import { SharePointClient } from "./sharepointClient";
import { topLevelReadme } from "./guides";

const LOCK_KEY = 815_204_661; // arbitrary constant identifying "AiPM DR backup"
const STATUS_KEY = "dr_backup_status";
const BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{4}Z$/;

export interface BackupRunRecord {
  backupId: string;
  startedAt: string;
  finishedAt: string;
  result: "success" | "local_only" | "failed";
  trigger: string;
  durationSec: number;
  totalBytes?: number;
  totalRows?: number;
  tableCount?: number;
  fileCount?: number;
  webUrl?: string;
  error?: string;
  warnings?: string[];
  pruned?: string[];
}

export interface BackupStatus {
  lastAttempt?: BackupRunRecord;
  lastSuccess?: BackupRunRecord;
  history: BackupRunRecord[];
}

let running: { startedAt: string; trigger: string; step: string } | null = null;
export function currentRun() {
  return running;
}

export async function readStatus(pool: pg.Pool): Promise<BackupStatus> {
  try {
    const r = await pool.query(`SELECT value FROM system_settings WHERE key = $1`, [STATUS_KEY]);
    if (r.rows[0]) return JSON.parse(r.rows[0].value);
  } catch {}
  return { history: [] };
}

export async function writeStatus(pool: pg.Pool, rec: BackupRunRecord) {
  const status = await readStatus(pool);
  status.lastAttempt = rec;
  if (rec.result === "success") status.lastSuccess = rec;
  status.history = [rec, ...(status.history || [])].slice(0, 30);
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [STATUS_KEY, JSON.stringify(status)],
  );
}

/**
 * Pick which backup folders to delete. Kept:
 *   - every backup from the last 48 hours,
 *   - the newest backup of each of the last `retainDaily` days that have backups,
 *   - the newest backup of each of the last `retainMonthly` months (month-end copy).
 */
export function selectBackupsToPrune(names: string[], retainDaily: number, retainMonthly: number, now = new Date()): string[] {
  const sorted = names.filter((n) => BACKUP_NAME_RE.test(n)).sort().reverse();
  const keep = new Set<string>();
  const cutoff = now.getTime() - 48 * 3600 * 1000;
  for (const n of sorted) {
    const t = Date.UTC(+n.slice(0, 4), +n.slice(5, 7) - 1, +n.slice(8, 10), +n.slice(11, 13), +n.slice(13, 15));
    if (t >= cutoff) keep.add(n);
  }
  const newestPer = (keyLen: number, limit: number) => {
    const seen = new Set<string>();
    for (const n of sorted) {
      const k = n.slice(0, keyLen);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(n);
    }
  };
  newestPer(10, retainDaily);   // YYYY-MM-DD
  newestPer(7, retainMonthly);  // YYYY-MM
  return sorted.filter((n) => !keep.has(n));
}

async function uploadAndPublish(cfg: DrConfig, folder: string, backupId: string, log: (m: string) => void) {
  const sp = new SharePointClient(cfg);
  const root = cfg.rootFolder;
  const stagingPath = `${root}/_in-progress/${backupId}`;

  // Upload every file, manifest LAST, into a staging folder.
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(folder, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk("");
  files.sort((a, b) => (a === "manifest.json" ? 1 : b === "manifest.json" ? -1 : a.localeCompare(b)));

  let n = 0;
  for (const rel of files) {
    n++;
    if (n % 10 === 1 || fs.statSync(path.join(folder, rel)).size > 20 * 1024 * 1024) log(`Uploading ${n}/${files.length}: ${rel}`);
    await sp.uploadFile(path.join(folder, rel), `${stagingPath}/${rel}`);
  }

  // Only now that every file is confirmed, move it into Backups/ in one step.
  const staged = await sp.getItem(stagingPath);
  if (!staged) throw new Error("Uploaded backup folder disappeared before it could be published.");
  const existing = await sp.getItem(`${root}/Backups/${backupId}`);
  if (existing) await sp.deleteItem(existing.id);
  const published = await sp.moveItem(staged.id, `${root}/Backups`, backupId);
  log(`Published to SharePoint: ${root}/Backups/${backupId}`);

  await sp.uploadText(`${root}/00_READ_ME_FIRST.md`, topLevelReadme(backupId, describeDestination(cfg), cfg.retainDaily, cfg.retainMonthly));
  await sp.uploadText(`${root}/LATEST_BACKUP.txt`, `${backupId}\nBackups/${backupId}\n${new Date().toISOString()}\n`);

  // Retention.
  const pruned: string[] = [];
  const children = await sp.listChildren(`${root}/Backups`);
  const toDelete = selectBackupsToPrune(children.filter((c) => c.folder).map((c) => c.name), cfg.retainDaily, cfg.retainMonthly);
  for (const name of toDelete) {
    const item = children.find((c) => c.name === name);
    if (item && name !== backupId) {
      await sp.deleteItem(item.id);
      pruned.push(name);
    }
  }
  // Clear abandoned staging uploads older than 2 days.
  const staging = await sp.listChildren(`${root}/_in-progress`);
  for (const s of staging) {
    const age = Date.now() - new Date(s.createdDateTime || 0).getTime();
    if (age > 2 * 24 * 3600 * 1000) await sp.deleteItem(s.id);
  }
  if (pruned.length) log(`Removed ${pruned.length} old backup(s) per retention policy: ${pruned.join(", ")}`);
  return { webUrl: published.webUrl, pruned };
}

async function notifyFailure(rec: BackupRunRecord) {
  const to = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!process.env.SENDGRID_API_KEY || !to) return;
  try {
    const sgMail = (await import("@sendgrid/mail")).default;
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to,
      from: process.env.EMAIL_FROM || "no-reply@aipmapp.com",
      subject: "AiPM disaster-recovery backup FAILED",
      text: `The AiPM backup to SharePoint/OneDrive did not complete.\n\nStarted: ${rec.startedAt}\nError: ${rec.error}\n\nIt will retry automatically within the hour. Check Admin → Data Backup & Recovery for details.`,
    });
  } catch (err: any) {
    console.error("[DR] Could not send failure email:", err?.message);
  }
}

export interface RunOptions {
  pool: pg.Pool;
  databaseUrl: string;
  appRoot?: string;
  trigger: string;
  onProgress?: (msg: string) => void;
}

export async function runDisasterRecoveryBackup(opts: RunOptions): Promise<BackupRunRecord> {
  const cfg = getDrConfig();
  const appRoot = opts.appRoot || process.cwd();
  const workDir = path.join(appRoot, "backups", "dr");
  const started = new Date();
  const log = (m: string) => {
    if (running) running.step = m;
    (opts.onProgress ?? ((x: string) => console.log(`[DR] ${x}`)))(m);
  };

  const lockClient = await opts.pool.connect();
  let locked = false;
  try {
    const lr = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    locked = lr.rows[0]?.ok === true;
    if (!locked || running) throw new Error("A backup is already running. Please wait for it to finish.");
    running = { startedAt: started.toISOString(), trigger: opts.trigger, step: "Starting" };

    let rec: BackupRunRecord;
    let folder: string | null = null;
    try {
      const built = await buildBackupPackage({ pool: opts.pool, databaseUrl: opts.databaseUrl, appRoot, workDir, onProgress: log });
      folder = built.folder;
      const m = built.manifest;
      const base = {
        backupId: m.backupId, startedAt: started.toISOString(), trigger: opts.trigger,
        totalBytes: m.totalBytes, totalRows: m.database.totalRows, tableCount: m.database.tables.length,
        fileCount: m.files.length, warnings: m.warnings,
      };
      if (isMicrosoftConfigured(cfg)) {
        const { webUrl, pruned } = await uploadAndPublish(cfg, folder, m.backupId, log);
        rec = { ...base, result: "success", webUrl, pruned, finishedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started.getTime()) / 1000) };
      } else {
        const pickup = !!cfg.triggerToken;
        log(pickup ? "Backup ready for the Power Automate flow to pick up." : "SharePoint/OneDrive is not configured yet — backup kept on this server only.");
        rec = { ...base, result: "local_only", error: pickup ? "Built and waiting for the Power Automate flow to copy it to OneDrive." : "SharePoint/OneDrive not configured; backup saved on the server only.", finishedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started.getTime()) / 1000) };
      }
    } catch (err: any) {
      rec = {
        backupId: folder ? path.basename(folder) : "", startedAt: started.toISOString(), trigger: opts.trigger,
        result: "failed", error: String(err?.message || err).slice(0, 2000),
        finishedAt: new Date().toISOString(), durationSec: Math.round((Date.now() - started.getTime()) / 1000),
      };
    }

    // Keep only the newest local copy (the cloud is the real backup).
    try {
      if (fs.existsSync(workDir)) {
        const locals = fs.readdirSync(workDir).filter((n) => BACKUP_NAME_RE.test(n)).sort().reverse();
        const keep = rec.result === "failed" ? 0 : 1;
        for (const n of locals.slice(keep)) fs.rmSync(path.join(workDir, n), { recursive: true, force: true });
      }
    } catch {}

    await writeStatus(opts.pool, rec).catch((e) => console.error("[DR] Could not save backup status:", e.message));
    if (rec.result === "failed") {
      console.error(`[DR] Backup FAILED: ${rec.error}`);
      await notifyFailure(rec);
    } else {
      console.log(`[DR] Backup ${rec.result === "success" ? "completed" : "saved locally"}: ${rec.backupId} (${rec.totalRows} rows, ${((rec.totalBytes || 0) / 1024 / 1024).toFixed(1)} MB, ${rec.durationSec}s)`);
    }
    return rec;
  } finally {
    running = null;
    if (locked) await lockClient.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
}

/** Most recent scheduled time at or before `now` (anchored on DR_BACKUP_HOUR_UTC, repeating every DR_BACKUP_EVERY_HOURS). */
export function lastScheduledSlot(cfg: Pick<DrConfig, "backupHourUtc" | "everyHours">, now = new Date()): Date {
  const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cfg.backupHourUtc) - 24 * 3600 * 1000;
  const step = cfg.everyHours * 3600 * 1000;
  const k = Math.floor((now.getTime() - anchor) / step);
  return new Date(anchor + k * step);
}

/** Is a scheduled backup due right now? Used by the scheduler (checks every 15 minutes). */
export function isBackupDue(status: BackupStatus, cfg: DrConfig, now = new Date()): boolean {
  const scheduled = lastScheduledSlot(cfg, now);
  const lastOk = status.lastSuccess ? new Date(status.lastSuccess.startedAt) : null;
  if (lastOk && lastOk >= scheduled) return false;
  // After a failure, wait ~an hour before retrying.
  const lastTry = status.lastAttempt ? new Date(status.lastAttempt.startedAt) : null;
  if (lastTry && status.lastAttempt?.result === "failed" && now.getTime() - lastTry.getTime() < 55 * 60 * 1000) return false;
  // While SharePoint is not configured, make one local copy per slot rather than retrying.
  if (lastTry && status.lastAttempt?.result === "local_only" && lastTry >= scheduled) return false;
  return true;
}
