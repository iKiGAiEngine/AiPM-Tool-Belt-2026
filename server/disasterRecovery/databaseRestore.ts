/**
 * Disaster Recovery — rebuild a database from a backup folder.
 *
 * Used by `scripts/dr-restore.ts`. The whole restore runs inside ONE transaction:
 * it either completes fully or changes nothing at all.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import readline from "readline";
import type pg from "pg";
import { sha256File } from "./databaseSnapshot";
import type { BackupManifest } from "./manifest";

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

export interface VerifyResult {
  ok: boolean;
  checked: number;
  problems: string[];
}

/** Confirm every file listed in the manifest is present and unchanged (SHA-256 checksum). */
export async function verifyBackupFolder(backupDir: string, manifest: BackupManifest): Promise<VerifyResult> {
  const problems: string[] = [];
  let checked = 0;
  for (const f of manifest.files) {
    const p = path.join(backupDir, f.path);
    if (!fs.existsSync(p)) {
      problems.push(`MISSING: ${f.path}`);
      continue;
    }
    const size = fs.statSync(p).size;
    if (size !== f.bytes) {
      problems.push(`WRONG SIZE: ${f.path} (expected ${f.bytes} bytes, found ${size})`);
      continue;
    }
    const sum = await sha256File(p);
    if (sum !== f.sha256) problems.push(`CHECKSUM MISMATCH: ${f.path}`);
    checked++;
  }
  return { ok: problems.length === 0, checked, problems };
}

async function existingPublicTables(client: pg.PoolClient): Promise<string[]> {
  const r = await client.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1`);
  return r.rows.map((x: any) => x.relname);
}

async function wipePublicSchema(client: pg.PoolClient) {
  const objs = await client.query(`
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v','m','r','p','S')`);
  for (const kind of ["v", "m", "r", "p", "S"]) {
    for (const o of objs.rows.filter((x: any) => x.relkind === kind)) {
      const word = kind === "v" ? "VIEW" : kind === "m" ? "MATERIALIZED VIEW" : kind === "S" ? "SEQUENCE" : "TABLE";
      await client.query(`DROP ${word} IF EXISTS ${qi(o.relname)} CASCADE`);
    }
  }
  const types = await client.query(`
    SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'e'`);
  for (const t of types.rows) await client.query(`DROP TYPE IF EXISTS ${qi(t.typname)} CASCADE`);
}

/** Insert rows in batches, staying well under PostgreSQL's 65,535-parameter limit. */
async function loadTable(client: pg.PoolClient, file: string, overridingSystem: boolean): Promise<number> {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let header: { table: string; columns: string[] } | null = null;
  let batch: unknown[][] = [];
  let batchBytes = 0;
  let total = 0;

  const flush = async () => {
    if (!header || batch.length === 0) return;
    const n = header.columns.length;
    const params: unknown[] = [];
    const tuples = batch.map((row, i) => {
      params.push(...row);
      return `(${row.map((_, j) => `$${i * n + j + 1}`).join(", ")})`;
    });
    const sql = `INSERT INTO ${qi(header.table)} (${header.columns.map(qi).join(", ")})` +
      `${overridingSystem ? " OVERRIDING SYSTEM VALUE" : ""} VALUES ${tuples.join(", ")}`;
    await client.query(sql, params);
    total += batch.length;
    batch = [];
    batchBytes = 0;
  };

  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = JSON.parse(line);
      continue;
    }
    const row = JSON.parse(line) as unknown[];
    batch.push(row);
    batchBytes += line.length;
    const maxRows = Math.floor(60000 / Math.max(1, header.columns.length));
    if (batch.length >= Math.min(500, maxRows) || batchBytes > 16 * 1024 * 1024) await flush();
  }
  await flush();
  return total;
}

export interface RestoreOptions {
  /** Drop everything already in the target database first. Without this the target must be empty. */
  wipeTarget: boolean;
  onProgress?: (msg: string) => void;
}

export interface RestoreResult {
  tablesRestored: number;
  rowsRestored: number;
  mismatches: string[];
}

export async function restoreDatabase(pool: pg.Pool, backupDir: string, manifest: BackupManifest, opts: RestoreOptions): Promise<RestoreResult> {
  const dbDir = path.join(backupDir, manifest.database.folder);
  const log = opts.onProgress ?? (() => {});
  const client = await pool.connect();
  try {
    const existing = await existingPublicTables(client);
    if (existing.length > 0 && !opts.wipeTarget) {
      throw new Error(
        `The target database is not empty (it already has ${existing.length} tables). ` +
        `Point DATABASE_URL at a brand-new empty database, or re-run with --wipe-target to erase it first.`,
      );
    }

    await client.query("BEGIN");
    if (existing.length > 0) {
      log(`Erasing ${existing.length} existing tables in the target database...`);
      await wipePublicSchema(client);
    }

    log("Creating tables (schema part 1)...");
    await client.query(fs.readFileSync(path.join(dbDir, "schema_1_tables.sql"), "utf8"));

    let rowsRestored = 0;
    let tablesRestored = 0;
    for (const t of manifest.database.tables) {
      if (t.dataSkipped || !t.file) continue;
      const overriding = t.columns.some((c) => c.identity === "a");
      const n = await loadTable(client, path.join(dbDir, t.file), overriding);
      log(`  ${t.table}: ${n.toLocaleString()} rows`);
      rowsRestored += n;
      tablesRestored++;
    }

    log("Adding keys, constraints and indexes (schema part 2)...");
    await client.query(fs.readFileSync(path.join(dbDir, "schema_2_keys_indexes.sql"), "utf8"));

    log("Restoring ID counters...");
    for (const s of manifest.database.sequences) {
      if (s.lastValue === null) continue;
      await client.query(`SELECT setval($1::regclass, $2::bigint, $3::boolean)`, [qi(s.name), s.lastValue, s.isCalled]);
    }

    log("Checking row counts against the backup...");
    const mismatches: string[] = [];
    for (const t of manifest.database.tables) {
      if (t.dataSkipped) continue;
      const r = await client.query(`SELECT count(*)::bigint AS n FROM ${qi(t.table)}`);
      const n = parseInt(r.rows[0].n, 10);
      if (n !== t.rowCount) mismatches.push(`${t.table}: expected ${t.rowCount}, restored ${n}`);
    }
    if (mismatches.length > 0) {
      throw new Error(`Row counts do not match the backup — nothing was changed.\n  ${mismatches.join("\n  ")}`);
    }

    await client.query("COMMIT");
    return { tablesRestored, rowsRestored, mismatches };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
