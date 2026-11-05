/**
 * AiPM disaster-recovery RESTORE tool.
 *
 * Usage (from the AiPM code folder, after `npm install`):
 *
 *   npx tsx scripts/dr-restore.ts --backup <folder-or-zip>               verify + restore database
 *   npx tsx scripts/dr-restore.ts --backup <folder-or-zip> --verify-only check the backup, change nothing
 *   npx tsx scripts/dr-restore.ts --backup <folder-or-zip> --files-only  unpack server files only
 *
 * Options:
 *   --database-url <url>   target database (default: the DATABASE_URL environment variable)
 *   --wipe-target          erase everything already in the target database first
 *   --app-dir <dir>        where to unpack server files (default: current folder)
 *
 * <folder-or-zip> is a backup folder downloaded from SharePoint/OneDrive
 * (e.g. "2026-11-05_0900Z"), or the .zip SharePoint gives you when you download it.
 */
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import * as unzipper from "unzipper";
import { verifyBackupFolder, restoreDatabase } from "../server/disasterRecovery/databaseRestore";
import type { BackupManifest } from "../server/disasterRecovery/manifest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/** Find the folder that contains manifest.json (SharePoint zips may add a top folder). */
function findBackupRoot(dir: string, depth = 0): string | null {
  if (fs.existsSync(path.join(dir, "manifest.json"))) return dir;
  if (depth >= 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const hit = findBackupRoot(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

async function main() {
  const input = arg("--backup");
  if (!input) fail("Please say which backup to use:  --backup <folder-or-zip>");
  if (!fs.existsSync(input)) fail(`Not found: ${input}`);

  let dir = path.resolve(input);
  if (fs.statSync(dir).isFile() && dir.toLowerCase().endsWith(".zip")) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aipm-restore-"));
    console.log(`Unzipping ${path.basename(dir)} ...`);
    await (await unzipper.Open.file(dir)).extract({ path: tmp, concurrency: 4 });
    dir = tmp;
  }
  const root = findBackupRoot(dir);
  if (!root) fail(`No manifest.json found in ${input}. Is this an AiPM backup folder?`);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as BackupManifest;

  console.log(`\nAiPM backup ${manifest.backupId}`);
  console.log(`  taken:        ${manifest.database.snapshotTakenAt}`);
  console.log(`  app version:  ${manifest.application.gitCommit}`);
  console.log(`  tables/rows:  ${manifest.database.tables.length} / ${manifest.database.totalRows.toLocaleString()}`);

  console.log(`\nStep 1 — Verifying ${manifest.files.length} files against their checksums...`);
  const v = await verifyBackupFolder(root, manifest);
  if (!v.ok) fail(`The backup is damaged or incomplete:\n  ${v.problems.join("\n  ")}\nTry the previous night's backup instead.`);
  console.log(`  ✔ All ${v.checked} files are complete and unchanged.`);
  if (flag("--verify-only")) {
    console.log("\nVerify-only: nothing was changed.\n");
    return;
  }

  if (flag("--files-only")) {
    const appDir = path.resolve(arg("--app-dir") || process.cwd());
    if (!manifest.serverFiles.included || !manifest.serverFiles.file) {
      console.log("\nThis backup has no server files to unpack (all stored files are in the database).\n");
      return;
    }
    console.log(`\nUnpacking ${manifest.serverFiles.fileCount} server files into ${appDir} ...`);
    await (await unzipper.Open.file(path.join(root, manifest.serverFiles.file))).extract({ path: appDir, concurrency: 4 });
    console.log("  ✔ Server files restored.\n");
    return;
  }

  const databaseUrl = arg("--database-url") || process.env.DATABASE_URL;
  if (!databaseUrl) fail("No target database. Set DATABASE_URL (Replit does this when you create a database) or pass --database-url.");

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    console.log("\nStep 2 — Restoring the database (all-or-nothing)...");
    const r = await restoreDatabase(pool, root, manifest, { wipeTarget: flag("--wipe-target"), onProgress: (m) => console.log(`  ${m}`) });
    console.log(`\n✔ RESTORE COMPLETE — ${r.tablesRestored} tables, ${r.rowsRestored.toLocaleString()} rows. Every row count matches the backup.`);
    if (manifest.serverFiles.included) {
      console.log(`\nNext: unpack the server files with\n  npx tsx scripts/dr-restore.ts --backup "${input}" --files-only`);
    }
    console.log("Then start the app with:  npm run dev\n");
  } catch (err: any) {
    fail(`Restore stopped — the target database was NOT changed.\n  ${err?.message || err}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => fail(e?.message || String(e)));
