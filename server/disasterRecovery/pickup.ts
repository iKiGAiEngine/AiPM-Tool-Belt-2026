/**
 * Disaster Recovery — "pickup" mode for Power Automate (no IT / no app registration needed).
 *
 * The AiPM owner's own Power Automate flow uses the standard OneDrive for Business action
 * "Upload file from URL" to pull the latest backup into their Swinerton OneDrive each night,
 * signed in as themselves. AiPM only has to offer the backup at a secret link:
 *
 *   GET /api/dr-backup/download?token=<DR_BACKUP_TRIGGER_TOKEN>              the whole backup, one .zip
 *   GET /api/dr-backup/download?token=<DR_BACKUP_TRIGGER_TOKEN>&file=guide   the restore guide, plain text
 *
 * If no recent backup exists (for example, the server was asleep), one is built on the spot.
 */
import fs from "fs";
import path from "path";
import archiver from "archiver";
import type pg from "pg";
import { runDisasterRecoveryBackup, currentRun } from "./runBackup";

const BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{4}Z$/;
/** A backup newer than this is reused rather than rebuilt (lets the guide + zip downloads share one build). */
const REUSE_MS = 3 * 3600 * 1000;

export interface PickupPackage {
  backupId: string;
  zipPath: string;
  zipBytes: number;
  folder: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function workDirFor(appRoot: string) {
  return path.join(appRoot, "backups", "dr");
}

function newestLocal(workDir: string): { id: string; folder: string } | null {
  if (!fs.existsSync(workDir)) return null;
  const ids = fs.readdirSync(workDir).filter((n) => BACKUP_NAME_RE.test(n) && fs.existsSync(path.join(workDir, n, "manifest.json"))).sort().reverse();
  return ids[0] ? { id: ids[0], folder: path.join(workDir, ids[0]) } : null;
}

async function zipFolder(folder: string, id: string, outFile: string) {
  const tmp = `${outFile}.partial`;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    // Contents are mostly already compressed, so light compression keeps this fast.
    const zip = archiver("zip", { zlib: { level: 1 } });
    out.on("close", () => resolve());
    zip.on("error", reject);
    zip.pipe(out);
    zip.directory(folder, `AiPM-Backup-${id}`);
    void zip.finalize();
  });
  fs.renameSync(tmp, outFile);
}

/** Return a recent backup as a single zip, building one first if needed. */
export async function getPickupPackage(pool: pg.Pool, databaseUrl: string, appRoot = process.cwd()): Promise<PickupPackage> {
  const workDir = workDirFor(appRoot);

  // If a backup is already being built (nightly schedule, or the other download), wait for it.
  for (let waited = 0; currentRun() && waited < 20 * 60 * 1000; waited += 2000) await sleep(2000);

  let latest = newestLocal(workDir);
  const fresh = latest && Date.now() - fs.statSync(path.join(latest.folder, "manifest.json")).mtimeMs < REUSE_MS;
  if (!fresh) {
    const rec = await runDisasterRecoveryBackup({ pool, databaseUrl, appRoot, trigger: "Power Automate pickup" });
    if (rec.result === "failed") throw new Error(rec.error || "Backup failed");
    latest = newestLocal(workDir);
  }
  if (!latest) throw new Error("No backup is available.");

  const zipPath = path.join(workDir, `${latest.id}.zip`);
  if (!fs.existsSync(zipPath)) await zipFolder(latest.folder, latest.id, zipPath);
  // Remove zips of older backups.
  for (const n of fs.readdirSync(workDir)) {
    if (n.endsWith(".zip") && n !== `${latest.id}.zip`) fs.rmSync(path.join(workDir, n), { force: true });
    if (n.endsWith(".zip.partial") && !currentRun()) fs.rmSync(path.join(workDir, n), { force: true });
  }
  return { backupId: latest.id, zipPath, zipBytes: fs.statSync(zipPath).size, folder: latest.folder };
}

/** The plain-text guide saved next to the zip in OneDrive, so nobody has to unzip anything to get started. */
export function pickupGuide(pkg: PickupPackage): string {
  const howTo = fs.readFileSync(path.join(pkg.folder, "00_HOW_TO_RESTORE.md"), "utf8");
  const summary = fs.readFileSync(path.join(pkg.folder, "01_BACKUP_SUMMARY.md"), "utf8");
  return `# READ ME FIRST — AiPM Disaster Recovery Backups

This OneDrive folder holds automatic backups of AiPM Tool Belt, saved every night by a
Power Automate flow. Each .zip file is a COMPLETE backup: all data, all stored files,
the application code, and the instructions below. Any one of them can rebuild AiPM
from nothing.

## Which file to use

* Daily/AiPM-Backup-<weekday>.zip    — one for each of the last 7 days (newest = today/yesterday)
* Monthly/AiPM-Backup-<month>.zip    — the last backup of each of the last 12 months

Normally use the newest Daily file. Download it, unzip it, and follow the steps below.

---

${howTo}

---

${summary}`;
}
