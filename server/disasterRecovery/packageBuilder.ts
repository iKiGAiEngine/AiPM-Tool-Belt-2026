/**
 * Disaster Recovery — builds one complete, self-contained backup folder on local disk.
 * The folder is then uploaded as-is to SharePoint/OneDrive (see sharepointClient.ts).
 */
import fs from "fs";
import path from "path";
import { execFileSync, execFile } from "child_process";
import archiver from "archiver";
import type pg from "pg";
import { exportDatabase, sha256File } from "./databaseSnapshot";
import { writeReadableWorkbook } from "./readableWorkbook";
import { MANIFEST_FORMAT_VERSION, type BackupManifest, type ManifestFile } from "./manifest";
import { backupSummary, databaseReadme, restoreGuide, secretsGuide } from "./guides";
import { REQUIRED_SECRETS } from "./config";

export const DB_FOLDER = "1_Database";
const READABLE_FOLDER = "2_Readable_Spreadsheet";
const FILES_FOLDER = "3_Server_Files";
const SOURCE_FOLDER = "4_Application_Source";
const CONFIG_FOLDER = "5_Configuration";

/** Folders on the server's disk that hold user-created files. */
const SERVER_FILE_DIRS = ["data", "projects"];
/** Never put these in the source-code copy (generated, huge, or captured elsewhere). */
const SOURCE_EXCLUDE = [/^node_modules\//, /^dist\//, /^backups\//, /^data\//, /^projects\//, /^\.git\//, /^test-results\//, /^playwright-report\//, /^\.cache\//, /^\.local\//, /^\.config\//];

export function makeBackupId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString().trim();
  } catch {
    return null;
  }
}

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

async function zipFiles(root: string, relFiles: string[], outFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const zip = archiver("zip", { zlib: { level: 6 } });
    output.on("close", () => resolve());
    zip.on("error", reject);
    zip.on("warning", (e) => console.warn("[DR] zip warning:", e.message));
    zip.pipe(output);
    for (const rel of relFiles) zip.file(path.join(root, rel), { name: rel });
    void zip.finalize();
  });
}

function listSourceFiles(appRoot: string): string[] {
  const fromGit = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], appRoot);
  const files = fromGit !== null && fromGit.length > 0 ? fromGit.split("\0").filter(Boolean) : walk(appRoot);
  return files
    .filter((f) => !SOURCE_EXCLUDE.some((re) => re.test(f)))
    .filter((f) => !/(^|\/)\.env(\.|$)/.test(f)) // never copy local secret files
    .filter((f) => {
      try { return fs.statSync(path.join(appRoot, f)).isFile(); } catch { return false; }
    });
}

function runPgDump(databaseUrl: string, outFile: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--exclude-table-data=session", "--exclude-table-data=auth_tokens", `--file=${outFile}`, `--dbname=${databaseUrl}`],
      { timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          fs.rmSync(outFile, { force: true });
          const reason = (stderr || err.message || "").split("\n").find((l) => l.trim()) || "unknown error";
          resolve(reason.replace(databaseUrl, "<DATABASE_URL>"));
        } else resolve(null);
      },
    );
  });
}

export interface BuildOptions {
  pool: pg.Pool;
  databaseUrl: string;
  appRoot: string;
  workDir: string; // parent directory; the backup folder is created inside it
  backupId?: string;
  onProgress?: (msg: string) => void;
}

export interface BuildResult {
  folder: string;
  manifest: BackupManifest;
}

export async function buildBackupPackage(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.onProgress ?? ((m: string) => console.log(`[DR] ${m}`));
  const startedAt = new Date();
  const backupId = opts.backupId || makeBackupId(startedAt);
  const folder = path.join(opts.workDir, backupId);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const warnings: string[] = [];

  // 1. Database — exact copy.
  log("Taking database snapshot...");
  const dbDir = path.join(folder, DB_FOLDER);
  const dbx = await exportDatabase(opts.pool, dbDir, log);
  warnings.push(...dbx.warnings);
  fs.writeFileSync(path.join(dbDir, "README.md"), databaseReadme());

  log("Creating standard pg_dump copy...");
  const pgDumpError = await runPgDump(opts.databaseUrl, path.join(dbDir, "aipm-database.pgdump"));
  if (pgDumpError) warnings.push(`The optional pg_dump copy was skipped (${pgDumpError}). The primary database copy is unaffected.`);

  // 2. Readable spreadsheet.
  log("Writing readable spreadsheet...");
  const label = backupId;
  warnings.push(...(await writeReadableWorkbook(dbDir, dbx.tables, path.join(folder, READABLE_FOLDER, `AiPM_All_Data_${backupId}.xlsx`), label)));

  // 3. Server files on disk.
  log("Packing server files...");
  const serverFiles = SERVER_FILE_DIRS.flatMap((d) => walk(opts.appRoot, d)).filter((f) => !/\.part$/.test(f));
  let serverFilesInfo: BackupManifest["serverFiles"];
  if (serverFiles.length > 0) {
    await zipFiles(opts.appRoot, serverFiles, path.join(folder, FILES_FOLDER, "aipm-server-files.zip"));
    serverFilesInfo = { included: true, file: `${FILES_FOLDER}/aipm-server-files.zip`, fileCount: serverFiles.length };
  } else {
    fs.mkdirSync(path.join(folder, FILES_FOLDER), { recursive: true });
    fs.writeFileSync(path.join(folder, FILES_FOLDER, "README.md"), "No files were stored on the server's disk at backup time. All stored files live inside the database copy.\n");
    serverFilesInfo = { included: false, fileCount: 0, note: "No files on server disk (all stored files are in the database)" };
  }

  // 4. Application source code.
  log("Packing application source code...");
  const sourceFiles = listSourceFiles(opts.appRoot);
  let sourceInfo: BackupManifest["sourceCode"];
  if (sourceFiles.length > 0) {
    await zipFiles(opts.appRoot, sourceFiles, path.join(folder, SOURCE_FOLDER, "aipm-source-code.zip"));
    sourceInfo = { included: true, file: `${SOURCE_FOLDER}/aipm-source-code.zip`, fileCount: sourceFiles.length };
  } else {
    sourceInfo = { included: false, fileCount: 0, note: "Source files were not available on this server" };
    warnings.push("Application source code was not found on this server; use the GitHub repository at the commit listed above.");
  }

  // 5. Configuration (names of secrets only — never values).
  const cfgDir = path.join(folder, CONFIG_FOLDER);
  fs.mkdirSync(cfgDir, { recursive: true });
  const present = new Set(REQUIRED_SECRETS.map((s) => s.name).filter((n) => !!process.env[n]));
  fs.writeFileSync(path.join(cfgDir, "REQUIRED_SECRETS.md"), secretsGuide(present));
  const deployment: Record<string, string> = {};
  for (const f of [".replit", "replit.nix", "package.json", "drizzle.config.ts"]) {
    const p = path.join(opts.appRoot, f);
    if (fs.existsSync(p)) deployment[f] = fs.readFileSync(p, "utf8");
  }
  fs.writeFileSync(path.join(cfgDir, "deployment-settings.json"), JSON.stringify({
    note: "Copies of the files that tell Replit how to run AiPM. Also inside the source code zip.",
    nodeVersion: process.version,
    files: deployment,
  }, null, 2));

  // Application/version info.
  const gitCommit = git(["rev-parse", "HEAD"], opts.appRoot) || process.env.REPLIT_GIT_COMMIT || "unknown";
  const gitBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], opts.appRoot) || "unknown";

  const manifest: BackupManifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    backupId,
    createdAt: startedAt.toISOString(),
    completedAt: "",
    application: {
      name: "AiPM Tool Belt",
      gitCommit,
      gitBranch,
      nodeVersion: process.version,
      hostEnvironment: process.env.REPLIT_DEPLOYMENT ? "Replit deployment" : process.env.REPL_ID ? "Replit workspace" : "other",
    },
    database: {
      folder: DB_FOLDER,
      serverVersion: dbx.serverVersion,
      databaseName: dbx.databaseName,
      snapshotTakenAt: dbx.snapshotTakenAt,
      totalRows: dbx.tables.reduce((s, t) => s + t.rowCount, 0),
      tables: dbx.tables.map((t) => ({ table: t.table, rowCount: t.rowCount, dataSkipped: t.dataSkipped, skipReason: t.skipReason, file: t.file, columns: t.columns })),
      sequences: dbx.sequences,
      pgDumpIncluded: !pgDumpError,
    },
    serverFiles: serverFilesInfo,
    sourceCode: sourceInfo,
    files: [],
    totalBytes: 0,
    warnings,
  };

  // Human documents (written with final counts; checksummed like everything else).
  manifest.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(folder, "00_HOW_TO_RESTORE.md"), restoreGuide(manifest));

  // Checksum every file (except the manifest and summary, written last).
  log("Checksumming all files...");
  const files: ManifestFile[] = [];
  for (const rel of walk(folder)) {
    const abs = path.join(folder, rel);
    files.push({ path: rel, bytes: fs.statSync(abs).size, sha256: await sha256File(abs) });
  }
  manifest.files = files.sort((a, b) => a.path.localeCompare(b.path));
  manifest.totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  fs.writeFileSync(path.join(folder, "01_BACKUP_SUMMARY.md"), backupSummary(manifest));
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2));

  log(`Backup package ready: ${files.length} files, ${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MB`);
  return { folder, manifest };
}
