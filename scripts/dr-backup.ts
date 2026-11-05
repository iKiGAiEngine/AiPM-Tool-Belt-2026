/**
 * AiPM disaster-recovery BACKUP tool (command-line version).
 *
 * Runs the same full backup as the nightly schedule. Useful for:
 *   - a one-off backup from the Replit Shell before a risky change
 *   - a Replit "Scheduled Deployment" running:  npx tsx scripts/dr-backup.ts
 *
 * Usage:   npx tsx scripts/dr-backup.ts
 * Needs:   DATABASE_URL, plus the DR_* settings to upload to SharePoint/OneDrive
 *          (without them the backup is written to backups/dr/ on this machine only).
 */
import pg from "pg";
import { runDisasterRecoveryBackup } from "../server/disasterRecovery/runBackup";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const rec = await runDisasterRecoveryBackup({ pool, databaseUrl, trigger: "command line", onProgress: (m) => console.log(`  ${m}`) });
    console.log(`\nResult: ${rec.result.toUpperCase()}  ${rec.backupId}`);
    if (rec.webUrl) console.log(`SharePoint: ${rec.webUrl}`);
    if (rec.error) console.log(`Note: ${rec.error}`);
    process.exitCode = rec.result === "failed" ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
