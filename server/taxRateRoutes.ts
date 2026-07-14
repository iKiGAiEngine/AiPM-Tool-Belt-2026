import type { Express } from "express";
import multer from "multer";
import { db, pool } from "./db";
import { taxRates } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { requireAuth, requireAdmin } from "./authRoutes";
import { parseAvalaraWorkbook, normalizeZip } from "./taxRates/parser";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function registerTaxRateRoutes(app: Express) {
  // Upload & replace all tax rates from the Avalara Excel export.
  // Destructive (replaces the entire nationwide dataset) → admin only.
  app.post("/api/tax-rates/upload", requireAdmin, (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "File upload error" });
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const startedAt = Date.now();

    // ── Parse + validate FULLY before touching the database ──────────────────
    let parsed;
    try {
      parsed = await parseAvalaraWorkbook(req.file.buffer);
    } catch (err: any) {
      console.error("[tax-rates] parse error:", err);
      return res.status(400).json({ error: err?.message || "Failed to parse file" });
    }
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const { rows, stats } = parsed;
    const zips = rows.map((r) => r.zip);
    const states = rows.map((r) => r.state);
    const counties = rows.map((r) => r.county);
    const cities = rows.map((r) => r.city);
    const inOut = rows.map((r) => r.inOutCityLocal);
    const taxes = rows.map((r) => r.totalUseTax);
    console.log(`[tax-rates] Parsed ${rows.length} valid rows (${stats.skippedRows} skipped) from Excel`);

    // ── Replace in a single transaction; roll back delete + insert on any failure ─
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM tax_rates");
      // unnest() expands parallel arrays server-side — one round-trip, no per-row
      // parameter limits or JS call-stack issues for the full 54k dataset.
      await client.query(
        `INSERT INTO tax_rates (zip_code, state, county, city, in_out_city_local, total_use_tax)
         SELECT * FROM unnest($1::varchar[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[])`,
        [zips, states, counties, cities, inOut, taxes]
      );
      // Sanity check inside the transaction — if the row count doesn't match what
      // we parsed, something is wrong; abort so we never commit a partial load.
      const check = await client.query("SELECT count(*)::int AS n FROM tax_rates");
      const inserted = check.rows[0]?.n ?? 0;
      if (inserted !== rows.length) {
        throw new Error(`Row count mismatch after insert: expected ${rows.length}, got ${inserted}`);
      }
      await client.query("COMMIT");
      console.log(`[tax-rates] Insert complete: ${inserted} rows in ${Date.now() - startedAt}ms`);
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[tax-rates] transaction failed, rolled back:", e?.message);
      return res.status(500).json({ error: `Upload failed — existing data preserved. ${e?.message || ""}`.trim() });
    } finally {
      client.release();
    }

    res.json({
      success: true,
      rowCount: rows.length,
      stats: {
        validRows: stats.validRows,
        uniqueZips: stats.uniqueZips,
        duplicateJurisdictionRows: stats.duplicateJurisdictionRows,
        skippedRows: stats.skippedRows,
        invalidTaxRows: stats.invalidTaxRows,
        zeroTaxRows: stats.zeroTaxRows,
        durationMs: Date.now() - startedAt,
      },
    });
  });

  // Lookup by zip code — returns ALL matching jurisdiction rows, deterministically
  // ordered. Optional state/county/city/inOut filters narrow multi-jurisdiction ZIPs.
  app.get("/api/tax-rates/lookup", requireAuth, async (req, res) => {
    const zip = normalizeZip(req.query.zip);
    if (!zip) return res.status(400).json({ error: "A valid 5-digit zip code is required" });

    const filters = [eq(taxRates.zipCode, zip)];
    const state = String(req.query.state ?? "").trim();
    const county = String(req.query.county ?? "").trim();
    const city = String(req.query.city ?? "").trim();
    if (state) filters.push(eq(taxRates.state, state));
    if (county) filters.push(eq(taxRates.county, county));
    if (city) filters.push(eq(taxRates.city, city));

    const results = await db
      .select()
      .from(taxRates)
      .where(and(...filters))
      // Deterministic order so the client never sees an arbitrary first row.
      .orderBy(taxRates.state, taxRates.county, taxRates.city, taxRates.id);
    res.json(results);
  });

  // Status: row count + upload time
  app.get("/api/tax-rates/status", requireAuth, async (req, res) => {
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(taxRates);
    const latest = await db.select({ uploadedAt: taxRates.uploadedAt }).from(taxRates).orderBy(sql`uploaded_at desc`).limit(1);
    res.json({
      rowCount: Number(countResult[0]?.count ?? 0),
      lastUploadedAt: latest[0]?.uploadedAt ?? null,
    });
  });
}
