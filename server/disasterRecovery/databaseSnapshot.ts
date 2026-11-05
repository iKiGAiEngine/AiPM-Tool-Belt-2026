/**
 * Disaster Recovery — full, lossless database export.
 *
 * Produces, inside `<outDir>`:
 *   schema_1_tables.sql                 extensions, enum types, sequences, tables (columns + defaults)
 *   schema_2_keys_indexes.sql           primary keys, unique/check constraints, foreign keys, indexes, views
 *   data/<table>.jsonl.gz               one gzipped JSON-lines file per table (every row, every column)
 *   sequences.json                      current value of every ID counter
 *
 * Design notes
 * - The schema is read from PostgreSQL's own catalog, NOT from the app's code, so
 *   tables added in the future are picked up automatically and nothing is missed.
 * - All data is read inside ONE "repeatable read" transaction, so every table is
 *   captured at the same instant (no half-saved estimate with missing line items).
 * - Values are stored in PostgreSQL's own text format (dates, money, JSON, arrays and
 *   binary files exactly as the database stores them), so a restore is byte-for-byte.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import crypto from "crypto";
import type pg from "pg";
import { TRANSIENT_TABLES } from "./config";

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  identity: "" | "a" | "d";
  generated: "" | "s";
}

export interface TableExport {
  table: string;
  columns: ColumnInfo[];
  /** Columns actually written to the data file (generated columns are excluded). */
  dataColumns: string[];
  rowCount: number;
  dataSkipped: boolean;
  skipReason?: string;
  file?: string;
  bytes?: number;
  sha256?: string;
}

export interface SequenceState {
  name: string;
  lastValue: string | null;
  isCalled: boolean;
}

export interface DatabaseExportResult {
  serverVersion: string;
  databaseName: string;
  snapshotTakenAt: string;
  tables: TableExport[];
  sequences: SequenceState[];
  schemaFiles: { file: string; sha256: string; bytes: number }[];
  warnings: string[];
}

/** Return every value as PostgreSQL's raw text instead of converting to JS types. */
const RAW_TEXT = { getTypeParser: () => (v: string) => v } as any;

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("end", () => resolve()).on("error", reject);
  });
  return hash.digest("hex");
}

async function q<T = any>(client: pg.PoolClient | pg.Client, text: string, values: unknown[] = []): Promise<T[]> {
  const r = await client.query({ text, values, types: RAW_TEXT });
  return r.rows as T[];
}

async function listTables(client: pg.PoolClient | pg.Client): Promise<string[]> {
  const rows = await q<{ relname: string }>(client, `
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`);
  return rows.map((r) => r.relname);
}

async function getColumns(client: pg.PoolClient | pg.Client, table: string): Promise<ColumnInfo[]> {
  const rows = await q<any>(client, `
    SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity AS identity, a.attgenerated AS generated
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum`, [table]);
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    notNull: r.not_null === "t",
    default: r.default_expr,
    identity: (r.identity || "") as ColumnInfo["identity"],
    generated: (r.generated || "") as ColumnInfo["generated"],
  }));
}

/** Build the two SQL files that recreate the database structure. */
async function buildSchemaSql(client: pg.PoolClient | pg.Client, tables: string[], columnsByTable: Map<string, ColumnInfo[]>, warnings: string[]) {
  const pre: string[] = [
    "-- AiPM disaster-recovery schema, part 1 of 2: tables.",
    "-- Generated automatically from the live database catalog. Run BEFORE loading data.",
    "",
  ];
  const post: string[] = [
    "-- AiPM disaster-recovery schema, part 2 of 2: keys, constraints, indexes, views.",
    "-- Run AFTER loading data.",
    "",
  ];

  const exts = await q<any>(client, `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`);
  for (const e of exts) pre.push(`CREATE EXTENSION IF NOT EXISTS ${qi(e.extname)};`);

  const enums = await q<any>(client, `
    SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname`);
  for (const t of enums) pre.push(`CREATE TYPE ${qi(t.typname)} AS ENUM (${t.labels});`);

  // Free-standing sequences (serial columns). Identity-column sequences are created by the table itself.
  const seqs = await q<any>(client, `
    SELECT s.sequencename, s.data_type, s.start_value, s.min_value, s.max_value, s.increment_by, s.cycle, s.cache_size
    FROM pg_sequences s
    WHERE s.schemaname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend dep JOIN pg_class sc ON sc.oid = dep.objid
        WHERE sc.relname = s.sequencename AND dep.deptype = 'i')
    ORDER BY s.sequencename`);
  for (const s of seqs) {
    pre.push(`CREATE SEQUENCE ${qi(s.sequencename)} AS ${s.data_type} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} START WITH ${s.start_value} CACHE ${s.cache_size}${s.cycle === "t" ? " CYCLE" : " NO CYCLE"};`);
  }
  pre.push("");

  for (const table of tables) {
    const cols = columnsByTable.get(table)!;
    const defs = cols.map((c) => {
      let def = `  ${qi(c.name)} ${c.type}`;
      if (c.generated === "s" && c.default) def += ` GENERATED ALWAYS AS (${c.default}) STORED`;
      else if (c.identity === "a") def += " GENERATED ALWAYS AS IDENTITY";
      else if (c.identity === "d") def += " GENERATED BY DEFAULT AS IDENTITY";
      else if (c.default) def += ` DEFAULT ${c.default}`;
      if (c.notNull) def += " NOT NULL";
      return def;
    });
    pre.push(`CREATE TABLE ${qi(table)} (\n${defs.join(",\n")}\n);`);
    pre.push("");
  }

  // Sequence ownership (so dropping a table drops its counter, like the original).
  const owned = await q<any>(client, `
    SELECT seq.relname AS seq, tbl.relname AS tbl, att.attname AS col
    FROM pg_depend dep
    JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
    JOIN pg_class tbl ON tbl.oid = dep.refobjid
    JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = dep.refobjsubid
    JOIN pg_namespace n ON n.oid = seq.relnamespace
    WHERE dep.deptype = 'a' AND n.nspname = 'public'`);
  for (const o of owned) post.push(`ALTER SEQUENCE ${qi(o.seq)} OWNED BY ${qi(o.tbl)}.${qi(o.col)};`);
  post.push("");

  // Constraints: primary keys first, then unique/check/exclusion, then foreign keys.
  const cons = await q<any>(client, `
    SELECT c.conname, t.relname AS tbl, c.contype, pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.contype IN ('p','u','c','x','f')
    ORDER BY CASE c.contype WHEN 'p' THEN 1 WHEN 'u' THEN 2 WHEN 'c' THEN 3 WHEN 'x' THEN 4 ELSE 5 END, t.relname, c.conname`);
  for (const c of cons) post.push(`ALTER TABLE ${qi(c.tbl)} ADD CONSTRAINT ${qi(c.conname)} ${c.def};`);
  post.push("");

  // Indexes that are not already created by a constraint above.
  const idx = await q<any>(client, `
    SELECT pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.contype IN ('p','u','x'))
    ORDER BY ic.relname`);
  for (const i of idx) post.push(`${i.def};`);
  post.push("");

  const views = await q<any>(client, `
    SELECT c.relname, c.relkind, pg_get_viewdef(c.oid, true) AS def
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v','m') ORDER BY c.oid`);
  for (const v of views) {
    post.push(`CREATE ${v.relkind === "m" ? "MATERIALIZED VIEW" : "VIEW"} ${qi(v.relname)} AS\n${v.def}`);
  }

  const fns = await q<any>(client, `
    SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
  if (parseInt(fns[0]?.n ?? "0", 10) > 0) {
    warnings.push("The database contains custom SQL functions/triggers. They are captured in the pg_dump copy (aipm-database.pgdump) but not in the portable SQL files.");
  }

  return { pre: pre.join("\n") + "\n", post: post.join("\n") + "\n" };
}

/** Write one table's rows to a gzipped JSON-lines file, reading in small pages. */
async function exportTableData(client: pg.PoolClient | pg.Client, table: string, cols: ColumnInfo[], file: string): Promise<number> {
  const dataCols = cols.filter((c) => c.generated !== "s");
  const hasBinary = dataCols.some((c) => c.type === "bytea");
  // Tables that hold PDFs/Excel files are read a few rows at a time to keep memory low.
  const pageSize = hasBinary ? 10 : 1000;
  const selectList = dataCols.map((c) => qi(c.name)).join(", ");

  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(file);
  const finished = new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
    gzip.on("error", reject);
  });
  gzip.pipe(out);

  const write = async (line: string) => {
    if (!gzip.write(line + "\n")) await new Promise<void>((r) => gzip.once("drain", () => r()));
  };

  await write(JSON.stringify({ table, columns: dataCols.map((c) => c.name), types: dataCols.map((c) => c.type) }));

  // Page through the table by physical row id (ctid). Inside our snapshot this is stable
  // and uses an efficient "TID range scan" — no reliance on the table having an id column.
  let lastCtid = "(0,0)";
  let count = 0;
  for (;;) {
    const rows = await client.query({
      text: `SELECT ctid::text AS "__ctid", ${selectList} FROM ${qi(table)} WHERE ctid > $1::tid ORDER BY ctid LIMIT ${pageSize}`,
      values: [lastCtid],
      types: RAW_TEXT,
      rowMode: "array",
    });
    if (rows.rows.length === 0) break;
    for (const r of rows.rows as unknown[][]) {
      lastCtid = r[0] as string;
      await write(JSON.stringify(r.slice(1)));
      count++;
    }
    if (rows.rows.length < pageSize) break;
  }

  gzip.end();
  await finished;
  return count;
}

export async function exportDatabase(pool: pg.Pool, outDir: string, onProgress?: (msg: string) => void): Promise<DatabaseExportResult> {
  const dataDir = path.join(outDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const warnings: string[] = [];

  const client = await pool.connect();
  try {
    // One consistent, read-only point-in-time snapshot of the whole database.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const [meta] = await q<any>(client, `SELECT current_setting('server_version') AS v, current_database() AS db, now()::text AS at`);

    const tables = await listTables(client);
    const columnsByTable = new Map<string, ColumnInfo[]>();
    for (const t of tables) columnsByTable.set(t, await getColumns(client, t));

    const schema = await buildSchemaSql(client, tables, columnsByTable, warnings);
    const schemaFiles: DatabaseExportResult["schemaFiles"] = [];
    for (const [file, text] of [["schema_1_tables.sql", schema.pre], ["schema_2_keys_indexes.sql", schema.post]] as const) {
      const p = path.join(outDir, file);
      fs.writeFileSync(p, text, "utf8");
      schemaFiles.push({ file, sha256: await sha256File(p), bytes: fs.statSync(p).size });
    }

    const exports: TableExport[] = [];
    for (const table of tables) {
      const columns = columnsByTable.get(table)!;
      const dataColumns = columns.filter((c) => c.generated !== "s").map((c) => c.name);
      if (TRANSIENT_TABLES[table]) {
        exports.push({ table, columns, dataColumns, rowCount: 0, dataSkipped: true, skipReason: TRANSIENT_TABLES[table] });
        continue;
      }
      onProgress?.(`Exporting table ${table}`);
      const file = path.join(dataDir, `${table}.jsonl.gz`);
      const rowCount = await exportTableData(client, table, columns, file);
      exports.push({
        table, columns, dataColumns, rowCount, dataSkipped: false,
        file: `data/${table}.jsonl.gz`,
        bytes: fs.statSync(file).size,
        sha256: await sha256File(file),
      });
    }

    await client.query("COMMIT");

    // Sequences are read last (they are never rolled back, so these values are always
    // >= the highest id in the snapshot — new records after a restore can never collide).
    const seqRows = await q<any>(client, `SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`);
    const sequences: SequenceState[] = seqRows.map((s) => ({ name: s.sequencename, lastValue: s.last_value, isCalled: s.last_value !== null }));
    fs.writeFileSync(path.join(outDir, "sequences.json"), JSON.stringify(sequences, null, 2));

    return {
      serverVersion: meta.v,
      databaseName: meta.db,
      snapshotTakenAt: meta.at,
      tables: exports,
      sequences,
      schemaFiles,
      warnings,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
