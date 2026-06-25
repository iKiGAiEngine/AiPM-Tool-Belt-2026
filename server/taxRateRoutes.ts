import type { Express } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import pg from "pg";
import { db } from "./db";
import { taxRates } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { requireAuth } from "./authRoutes";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export function registerTaxRateRoutes(app: Express) {
  // Upload & replace all tax rates from an Excel file
  app.post("/api/tax-rates/upload", requireAuth, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file provided" });

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];

      const zips: string[] = [];
      const states: (string | null)[] = [];
      const counties: (string | null)[] = [];
      const cities: (string | null)[] = [];
      const taxes: (string | null)[] = [];

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // skip header
        const zip = String(row.getCell(1).value ?? "").trim();
        if (!zip) return;
        zips.push(zip);
        states.push(String(row.getCell(2).value ?? "").trim() || null);
        counties.push(String(row.getCell(3).value ?? "").trim() || null);
        cities.push(String(row.getCell(4).value ?? "").trim() || null);
        const rawTax = row.getCell(15).value;
        let totalUseTax: string | null = null;
        if (rawTax !== null && rawTax !== undefined && rawTax !== "") {
          const num = parseFloat(String(rawTax));
          if (!isNaN(num)) totalUseTax = String(num);
        }
        taxes.push(totalUseTax);
      });

      if (zips.length === 0) return res.status(400).json({ error: "No data rows found in spreadsheet" });

      // Use raw pg with unnest() — sends data as arrays, Postgres expands server-side
      // This avoids any JS call-stack issues with large datasets
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      const pgClient = await pool.connect();
      try {
        await pgClient.query("BEGIN");
        await pgClient.query("DELETE FROM tax_rates");
        await pgClient.query(
          `INSERT INTO tax_rates (zip_code, state, county, city, total_use_tax)
           SELECT * FROM unnest($1::varchar[], $2::text[], $3::text[], $4::text[], $5::numeric[])`,
          [zips, states, counties, cities, taxes]
        );
        await pgClient.query("COMMIT");
      } catch (e) {
        await pgClient.query("ROLLBACK");
        throw e;
      } finally {
        pgClient.release();
        await pool.end();
      }

      res.json({ success: true, rowCount: zips.length });
    } catch (err: any) {
      console.error("Tax rate upload error:", err);
      res.status(500).json({ error: err.message || "Failed to parse file" });
    }
  });

  // Lookup by zip code
  app.get("/api/tax-rates/lookup", requireAuth, async (req, res) => {
    const zip = String(req.query.zip ?? "").trim();
    if (!zip) return res.status(400).json({ error: "zip query param required" });
    const results = await db.select().from(taxRates).where(eq(taxRates.zipCode, zip));
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
