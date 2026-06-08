import type { Express, Request, Response } from "express";
import multer from "multer";
import { db } from "./db";
import {
  mfrVendors, mfrContacts, mfrProducts, mfrPricing,
  mfrLogistics, mfrTaxInfo, mfrResaleCerts, mfrFiles,
  mfrManufacturers, mfrVendorManufacturers,
} from "@shared/schema";
import { normalizeAliases } from "@shared/vendorNames";
import { eq, ilike, or, sql } from "drizzle-orm";
import * as xlsx from "xlsx";
import ExcelJS from "exceljs";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- helpers ----

function getCertStatus(cert: { sent?: boolean | null; vendorConfirmed?: boolean | null; expirationDate?: string | null }) {
  if (cert.expirationDate) {
    const exp = new Date(cert.expirationDate);
    const now = new Date();
    const diffDays = Math.floor((exp.getTime() - now.getTime()) / 86400000);
    if (diffDays < 0) return "expired";
    if (diffDays <= 90) return "expiring";
  }
  if (!cert.sent) return "not_sent";
  if (cert.vendorConfirmed) return "confirmed";
  return "sent";
}

async function getFullVendor(id: number) {
  try {
    const [vendor] = await db.select().from(mfrVendors).where(eq(mfrVendors.id, id));
    if (!vendor) return null;
    const contacts = await db.select().from(mfrContacts).where(eq(mfrContacts.vendorId, id));
    const products = await db.select().from(mfrProducts).where(eq(mfrProducts.vendorId, id));
    const [pricing] = await db.select().from(mfrPricing).where(eq(mfrPricing.vendorId, id));
    const [logistics] = await db.select().from(mfrLogistics).where(eq(mfrLogistics.vendorId, id));
    const [taxInfo] = await db.select().from(mfrTaxInfo).where(eq(mfrTaxInfo.vendorId, id));
    const certs = await db.select().from(mfrResaleCerts).where(eq(mfrResaleCerts.vendorId, id));
    const files = await db.select().from(mfrFiles).where(eq(mfrFiles.vendorId, id));
    return { ...vendor, contacts, products, pricing: pricing || null, logistics: logistics || null, taxInfo: taxInfo || null, certs, files };
  } catch (err: any) {
    console.error(`[getFullVendor(${id})] DIAGNOSTIC ERROR:`, err.message, err.stack?.split("\n")[1]);
    throw err;
  }
}

export function registerVendorDatabaseRoutes(app: Express) {

  // ---- MANUFACTURERS (lightweight list + create) ----

  app.get("/api/mfr/manufacturers", async (req: Request, res: Response) => {
    try {
      const { search } = req.query as Record<string, string>;
      let rows = await db.select().from(mfrManufacturers).orderBy(mfrManufacturers.name);
      if (search) {
        const s = search.toLowerCase();
        rows = rows.filter(m => m.name.toLowerCase().includes(s));
      }
      res.json(rows);
    } catch (err: any) {
      console.error("[mfr/manufacturers GET]", err);
      res.status(500).json({ message: err.message || "Failed to load manufacturers" });
    }
  });

  app.post("/api/mfr/manufacturers", async (req: Request, res: Response) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ message: "Name required" });
      // Naming fields (legalName falls back to name; shortCode auto-uppercased; aliases trimmed)
      const legalName = String(req.body?.legalName || name).trim() || name;
      const shortCodeRaw = String(req.body?.shortCode || "").trim();
      const shortCode = shortCodeRaw ? shortCodeRaw.toUpperCase() : null;
      const aliases = normalizeAliases(req.body?.aliases);
      // De-dupe: case-insensitive name match
      const existing = await db.select().from(mfrManufacturers);
      const dup = existing.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (dup) return res.status(200).json(dup); // idempotent — return existing
      // Uniqueness check on shortCode (case-insensitive)
      if (shortCode && existing.some(m => (m.shortCode || "").toUpperCase() === shortCode)) {
        return res.status(409).json({ message: `Short code "${shortCode}" is already used by another manufacturer.` });
      }
      const [row] = await db.insert(mfrManufacturers).values({
        name,
        legalName,
        shortCode,
        aliases,
        website: req.body?.website || null,
        primaryContact: req.body?.primaryContact || null,
        contactEmail: req.body?.contactEmail || null,
        contactPhone: req.body?.contactPhone || null,
        address: req.body?.address || null,
        notes: req.body?.notes || null,
        scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : null,
      }).returning();
      res.status(201).json(row);
    } catch (err: any) {
      console.error("[mfr/manufacturers POST]", err);
      res.status(500).json({ message: err.message || "Failed to create manufacturer" });
    }
  });

  // List manufacturers with usage counts (linked vendors via tag, line items, approved scope entries)
  app.get("/api/mfr/manufacturers/with-stats", async (_req: Request, res: Response) => {
    try {
      const mfrs = await db.select().from(mfrManufacturers).orderBy(mfrManufacturers.name);
      const stats = await db.execute(sql`
        SELECT
          m.id,
          (SELECT count(*)::int FROM mfr_vendors v WHERE m.id = ANY(v.manufacturer_ids)) AS vendor_tag_count,
          (SELECT count(DISTINCT vendor_id)::int FROM mfr_vendor_manufacturers WHERE manufacturer_id = m.id) AS vendor_link_count,
          (SELECT count(*)::int FROM estimate_line_items WHERE manufacturer_id = m.id) AS line_item_count,
          (SELECT count(*)::int FROM estimate_scope_manufacturers WHERE manufacturer_id = m.id) AS approved_count
        FROM mfr_manufacturers m
      `);
      const statsMap = new Map<number, any>();
      for (const r of (stats as any).rows || stats as any) {
        statsMap.set(Number(r.id), r);
      }
      const result = mfrs.map(m => {
        const s = statsMap.get(m.id) || {};
        const vendorCount = Math.max(Number(s.vendor_tag_count || 0), Number(s.vendor_link_count || 0));
        return {
          ...m,
          vendorCount,
          lineItemCount: Number(s.line_item_count || 0),
          approvedCount: Number(s.approved_count || 0),
        };
      });
      res.json(result);
    } catch (err: any) {
      console.error("[mfr/manufacturers stats GET]", err);
      res.status(500).json({ message: err.message || "Failed to load manufacturer stats" });
    }
  });

  app.patch("/api/mfr/manufacturers/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (typeof req.body?.name === "string") {
        const name = req.body.name.trim();
        if (!name) return res.status(400).json({ message: "Name cannot be empty" });
        const others = await db.select().from(mfrManufacturers);
        if (others.some(m => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) {
          return res.status(409).json({ message: "Another manufacturer already uses that name. Use Merge instead." });
        }
        updates.name = name;
      }
      if (req.body?.website !== undefined) updates.website = req.body.website || null;
      if (req.body?.primaryContact !== undefined) updates.primaryContact = req.body.primaryContact || null;
      if (req.body?.contactEmail !== undefined) updates.contactEmail = req.body.contactEmail || null;
      if (req.body?.contactPhone !== undefined) updates.contactPhone = req.body.contactPhone || null;
      if (req.body?.address !== undefined) updates.address = req.body.address || null;
      if (req.body?.notes !== undefined) updates.notes = req.body.notes || null;
      if (req.body?.scopes !== undefined) updates.scopes = Array.isArray(req.body.scopes) ? req.body.scopes : null;
      if (req.body?.legalName !== undefined) updates.legalName = req.body.legalName ? String(req.body.legalName).trim() : null;
      if (req.body?.shortCode !== undefined) {
        const sc = String(req.body.shortCode || "").trim().toUpperCase();
        if (sc) {
          const others = await db.select().from(mfrManufacturers);
          if (others.some(m => m.id !== id && (m.shortCode || "").toUpperCase() === sc)) {
            return res.status(409).json({ message: `Short code "${sc}" is already used by another manufacturer.` });
          }
          updates.shortCode = sc;
        } else {
          updates.shortCode = null;
        }
      }
      if (req.body?.aliases !== undefined) {
        updates.aliases = normalizeAliases(req.body.aliases);
      }
      const [row] = await db.update(mfrManufacturers).set(updates).where(eq(mfrManufacturers.id, id)).returning();
      if (!row) return res.status(404).json({ message: "Not found" });
      // Sync the cached `mfr` text on line items so display stays in sync after rename
      if (updates.name) {
        await db.execute(sql`UPDATE estimate_line_items SET mfr = ${updates.name} WHERE manufacturer_id = ${id}`);
      }
      res.json(row);
    } catch (err: any) {
      console.error("[mfr/manufacturers PATCH]", err);
      res.status(500).json({ message: err.message || "Failed to update manufacturer" });
    }
  });

  // Merge `:id` (source) into `targetId`. Reassigns line items, vendor tags, vendor links, approved scope rows, then deletes source.
  app.post("/api/mfr/manufacturers/:id/merge", async (req: Request, res: Response) => {
    try {
      const sourceId = parseInt(req.params.id);
      const targetId = parseInt(req.body?.targetId);
      if (!sourceId || !targetId || sourceId === targetId) return res.status(400).json({ message: "Invalid source or target id" });
      const [target] = await db.select().from(mfrManufacturers).where(eq(mfrManufacturers.id, targetId));
      const [source] = await db.select().from(mfrManufacturers).where(eq(mfrManufacturers.id, sourceId));
      if (!target || !source) return res.status(404).json({ message: "Manufacturer not found" });

      // 1. Line items: re-point FK + refresh cached `mfr` text
      await db.execute(sql`UPDATE estimate_line_items SET manufacturer_id = ${targetId}, mfr = ${target.name} WHERE manufacturer_id = ${sourceId}`);

      // 2. Vendor links (legacy join table): move source rows to target, dropping dups
      await db.execute(sql`
        INSERT INTO mfr_vendor_manufacturers (vendor_id, manufacturer_id)
        SELECT vendor_id, ${targetId} FROM mfr_vendor_manufacturers
        WHERE manufacturer_id = ${sourceId}
          AND NOT EXISTS (SELECT 1 FROM mfr_vendor_manufacturers t WHERE t.vendor_id = mfr_vendor_manufacturers.vendor_id AND t.manufacturer_id = ${targetId})
      `);
      await db.execute(sql`DELETE FROM mfr_vendor_manufacturers WHERE manufacturer_id = ${sourceId}`);

      // 3. Vendor tag arrays: replace source id with target id (de-duped)
      await db.execute(sql`
        UPDATE mfr_vendors
        SET manufacturer_ids = (
          SELECT ARRAY(SELECT DISTINCT unnest(array_replace(manufacturer_ids, ${sourceId}, ${targetId})))
        )
        WHERE ${sourceId} = ANY(manufacturer_ids)
      `);

      // 4. Approved-manufacturers per estimate scope: re-point, dropping dups (unique on estimate+scope+mfr)
      await db.execute(sql`
        UPDATE estimate_scope_manufacturers SET manufacturer_id = ${targetId}
        WHERE manufacturer_id = ${sourceId}
          AND NOT EXISTS (SELECT 1 FROM estimate_scope_manufacturers t WHERE t.estimate_id = estimate_scope_manufacturers.estimate_id AND t.scope_id = estimate_scope_manufacturers.scope_id AND t.manufacturer_id = ${targetId})
      `);
      await db.execute(sql`DELETE FROM estimate_scope_manufacturers WHERE manufacturer_id = ${sourceId}`);

      // 5. Delete source
      await db.delete(mfrManufacturers).where(eq(mfrManufacturers.id, sourceId));

      res.json({ ok: true, mergedInto: target });
    } catch (err: any) {
      console.error("[mfr/manufacturers merge POST]", err);
      res.status(500).json({ message: err.message || "Failed to merge manufacturers" });
    }
  });

  app.delete("/api/mfr/manufacturers/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });
      // Pre-clean references that don't have ON DELETE CASCADE
      await db.execute(sql`DELETE FROM mfr_vendor_manufacturers WHERE manufacturer_id = ${id}`);
      await db.execute(sql`UPDATE mfr_vendors SET manufacturer_ids = array_remove(manufacturer_ids, ${id}) WHERE ${id} = ANY(manufacturer_ids)`);
      // estimate_line_items has ON DELETE SET NULL; estimate_scope_manufacturers has ON DELETE CASCADE per replit.md
      await db.delete(mfrManufacturers).where(eq(mfrManufacturers.id, id));
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[mfr/manufacturers DELETE]", err);
      res.status(500).json({ message: err.message || "Failed to delete manufacturer" });
    }
  });

  // ---- VENDORS ----

  app.get("/api/mfr/vendors/scope-tags", async (req: Request, res: Response) => {
    try {
      const rows = await db.select({ scopes: mfrVendors.scopes }).from(mfrVendors);
      const tagSet = new Set<string>();
      for (const row of rows) {
        if (Array.isArray(row.scopes)) {
          for (const tag of row.scopes) { if (tag) tagSet.add(tag); }
        }
      }
      res.json(Array.from(tagSet).sort((a, b) => a.localeCompare(b)));
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to load scope tags" });
    }
  });

  app.get("/api/mfr/vendors", async (req: Request, res: Response) => {
    try {
      const { search, scope } = req.query as Record<string, string>;
      let rows = await db.select().from(mfrVendors);

      if (scope) rows = rows.filter((v) => Array.isArray(v.scopes) && (v.scopes as string[]).includes(scope));

      if (search) {
        const s = search.toLowerCase();
        const matchedByContact = await db.select({ vendorId: mfrContacts.vendorId })
          .from(mfrContacts)
          .where(or(ilike(mfrContacts.name, `%${s}%`), ilike(mfrContacts.email, `%${s}%`)));
        const matchedByProduct = await db.select({ vendorId: mfrProducts.vendorId })
          .from(mfrProducts)
          .where(or(ilike(mfrProducts.model, `%${s}%`), ilike(mfrProducts.description, `%${s}%`)));
        const relatedIds = new Set([
          ...matchedByContact.map((r) => r.vendorId),
          ...matchedByProduct.map((r) => r.vendorId),
        ]);
        rows = rows.filter((v) =>
          v.name.toLowerCase().includes(s) ||
          (v.tags && (v.tags as string[]).some((t) => t.toLowerCase().includes(s))) ||
          relatedIds.has(v.id)
        );
      }

      const contactCounts = await db.select({
        vendorId: mfrContacts.vendorId,
        cnt: sql<number>`count(*)::int`,
      }).from(mfrContacts).groupBy(mfrContacts.vendorId);
      const productCounts = await db.select({
        vendorId: mfrProducts.vendorId,
        cnt: sql<number>`count(*)::int`,
      }).from(mfrProducts).groupBy(mfrProducts.vendorId);
      const certCounts = await db.select({
        vendorId: mfrResaleCerts.vendorId,
        cnt: sql<number>`count(*)::int`,
      }).from(mfrResaleCerts).groupBy(mfrResaleCerts.vendorId);
      const taxRows = await db.select().from(mfrTaxInfo);
      const allCerts = await db.select().from(mfrResaleCerts);

      const ccMap = Object.fromEntries(contactCounts.map((r) => [r.vendorId, r.cnt]));
      const pcMap = Object.fromEntries(productCounts.map((r) => [r.vendorId, r.cnt]));
      const certMap = Object.fromEntries(certCounts.map((r) => [r.vendorId, r.cnt]));
      const taxMap = Object.fromEntries(taxRows.map((r) => [r.vendorId, r]));

      const result = rows.map((v) => {
        const vendorCerts = allCerts.filter((c) => c.vendorId === v.id);
        const hasExpired = vendorCerts.some((c) => getCertStatus(c) === "expired");
        const hasExpiring = vendorCerts.some((c) => getCertStatus(c) === "expiring");
        const tx = taxMap[v.id];
        return {
          ...v,
          contactCount: ccMap[v.id] || 0,
          productCount: pcMap[v.id] || 0,
          certCount: certMap[v.id] || 0,
          w9OnFile: tx?.w9OnFile || false,
          hasExpiredCert: hasExpired,
          hasExpiringCert: hasExpiring,
        };
      });

      rows.sort((a, b) => a.name.localeCompare(b.name));
      result.sort((a, b) => a.name.localeCompare(b.name));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mfr/vendors/:id", async (req: Request, res: Response) => {
    try {
      const vendor = await getFullVendor(Number(req.params.id));
      if (!vendor) return res.status(404).json({ error: "Not found" });
      res.json(vendor);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mfr/vendors", async (req: Request, res: Response) => {
    try {
      const { name, category, website, notes, tags, scopes, manufacturerIds, manufacturerDirect, legalName, shortCode, aliases } = req.body;
      const cleanName = String(name || "").trim();
      if (!cleanName) return res.status(400).json({ error: "Name required" });
      const cleanLegal = String(legalName || cleanName).trim() || cleanName;
      const sc = String(shortCode || "").trim().toUpperCase();
      const cleanAliases = normalizeAliases(aliases);
      // Uniqueness on shortCode (case-insensitive) across vendors
      if (sc) {
        const existing = await db.select().from(mfrVendors);
        if (existing.some(v => (v.shortCode || "").toUpperCase() === sc)) {
          return res.status(409).json({ error: `Short code "${sc}" is already used by another vendor.` });
        }
      }
      const [vendor] = await db.insert(mfrVendors).values({
        name: cleanName, category, website, notes,
        legalName: cleanLegal,
        shortCode: sc || null,
        aliases: cleanAliases,
        tags: tags || [],
        scopes: Array.isArray(scopes) ? scopes : null,
        manufacturerIds: Array.isArray(manufacturerIds) ? manufacturerIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n)) : null,
        manufacturerDirect: !!manufacturerDirect,
      }).returning();
      res.json(vendor);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mfr/vendors/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { name, category, website, notes, tags, scopes, manufacturerIds, manufacturerDirect, legalName, shortCode, aliases } = req.body;
      const updates: Record<string, any> = {
        category, website, notes,
        tags: tags || [],
        scopes: Array.isArray(scopes) ? scopes : null,
        manufacturerIds: Array.isArray(manufacturerIds) ? manufacturerIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n)) : null,
        manufacturerDirect: !!manufacturerDirect,
        updatedAt: new Date(),
      };
      // Name: only update if provided; trim and require non-empty
      if (name !== undefined) {
        const cleanName = String(name ?? "").trim();
        if (!cleanName) return res.status(400).json({ error: "Name cannot be empty" });
        updates.name = cleanName;
      }
      if (legalName !== undefined) updates.legalName = legalName ? String(legalName).trim() : null;
      if (shortCode !== undefined) {
        const sc = String(shortCode || "").trim().toUpperCase();
        if (sc) {
          const others = await db.select().from(mfrVendors);
          if (others.some(v => v.id !== id && (v.shortCode || "").toUpperCase() === sc)) {
            return res.status(409).json({ error: `Short code "${sc}" is already used by another vendor.` });
          }
          updates.shortCode = sc;
        } else {
          updates.shortCode = null;
        }
      }
      if (aliases !== undefined) {
        updates.aliases = Array.isArray(aliases)
          ? aliases.map((a: any) => String(a || "").trim()).filter((a: string) => a.length > 0)
          : null;
      }
      const [updated] = await db.update(mfrVendors)
        .set(updates)
        .where(eq(mfrVendors.id, id))
        .returning();
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mfr/vendors/:id", async (req: Request, res: Response) => {
    try {
      await db.delete(mfrVendors).where(eq(mfrVendors.id, Number(req.params.id)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- CONTACTS ----

  app.post("/api/mfr/vendors/:id/contacts", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const { name, role, email, phone, territory, isPrimary, notes } = req.body;
      if (isPrimary) {
        await db.update(mfrContacts).set({ isPrimary: false }).where(eq(mfrContacts.vendorId, vendorId));
      }
      const [contact] = await db.insert(mfrContacts).values({
        vendorId, name, role, email, phone, territory, isPrimary: !!isPrimary, notes,
      }).returning();
      res.json(contact);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mfr/vendors/:id/contacts/:cid", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const cid = Number(req.params.cid);
      const { name, role, email, phone, territory, isPrimary, notes } = req.body;
      if (isPrimary) {
        await db.update(mfrContacts).set({ isPrimary: false }).where(eq(mfrContacts.vendorId, vendorId));
      }
      const [updated] = await db.update(mfrContacts)
        .set({
          name, role, email, phone, territory, isPrimary: !!isPrimary, notes,
        })
        .where(eq(mfrContacts.id, cid))
        .returning();
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mfr/vendors/:id/contacts/:cid", async (req: Request, res: Response) => {
    try {
      await db.delete(mfrContacts).where(eq(mfrContacts.id, Number(req.params.cid)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PRODUCTS ----

  app.post("/api/mfr/vendors/:id/products", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const { model, description, csiCode, listPrice, unit, notes } = req.body;
      const [product] = await db.insert(mfrProducts).values({ vendorId, model, description, csiCode, listPrice, unit, notes }).returning();
      res.json(product);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mfr/vendors/:id/products/:pid", async (req: Request, res: Response) => {
    try {
      const { model, description, csiCode, listPrice, unit, notes } = req.body;
      const [updated] = await db.update(mfrProducts)
        .set({ model, description, csiCode, listPrice, unit, notes })
        .where(eq(mfrProducts.id, Number(req.params.pid)))
        .returning();
      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mfr/vendors/:id/products/:pid", async (req: Request, res: Response) => {
    try {
      await db.delete(mfrProducts).where(eq(mfrProducts.id, Number(req.params.pid)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- PRICING ----

  app.put("/api/mfr/vendors/:id/pricing", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const { discountTier, paymentTerms, notes } = req.body;
      const existing = await db.select().from(mfrPricing).where(eq(mfrPricing.vendorId, vendorId));
      if (existing.length > 0) {
        const [updated] = await db.update(mfrPricing)
          .set({ discountTier, paymentTerms, notes, updatedAt: new Date() })
          .where(eq(mfrPricing.vendorId, vendorId))
          .returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(mfrPricing).values({ vendorId, discountTier, paymentTerms, notes }).returning();
        res.json(created);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- LOGISTICS ----

  app.put("/api/mfr/vendors/:id/logistics", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const { avgLeadTimeDays, shipsFrom, freightNotes } = req.body;
      const existing = await db.select().from(mfrLogistics).where(eq(mfrLogistics.vendorId, vendorId));
      if (existing.length > 0) {
        const [updated] = await db.update(mfrLogistics)
          .set({ avgLeadTimeDays, shipsFrom, freightNotes, updatedAt: new Date() })
          .where(eq(mfrLogistics.vendorId, vendorId))
          .returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(mfrLogistics).values({ vendorId, avgLeadTimeDays, shipsFrom, freightNotes }).returning();
        res.json(created);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- TAX INFO ----

  app.put("/api/mfr/vendors/:id/tax", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const { ein, w9OnFile, w9ReceivedDate, is1099Eligible, taxExempt, exemptionType, exemptionCertNumber, nexusStates, taxNotes } = req.body;
      const existing = await db.select().from(mfrTaxInfo).where(eq(mfrTaxInfo.vendorId, vendorId));
      if (existing.length > 0) {
        const [updated] = await db.update(mfrTaxInfo)
          .set({ ein, w9OnFile, w9ReceivedDate, is1099Eligible, taxExempt, exemptionType, exemptionCertNumber, nexusStates: nexusStates || [], taxNotes, updatedAt: new Date() })
          .where(eq(mfrTaxInfo.vendorId, vendorId))
          .returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(mfrTaxInfo).values({ vendorId, ein, w9OnFile, w9ReceivedDate, is1099Eligible, taxExempt, exemptionType, exemptionCertNumber, nexusStates: nexusStates || [], taxNotes }).returning();
        res.json(created);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- RESALE CERTS ----

  app.get("/api/mfr/vendors/:id/certs", async (req: Request, res: Response) => {
    try {
      const certs = await db.select().from(mfrResaleCerts).where(eq(mfrResaleCerts.vendorId, Number(req.params.id)));
      res.json(certs.map((c) => ({ ...c, status: getCertStatus(c) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mfr/vendors/:id/certs", async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const { state, certType, certNumber, issueDate, expirationDate, sent, dateSent, contactSentTo, vendorConfirmed, confirmationDate, blanket, projectName, notes } = req.body;
      const [cert] = await db.insert(mfrResaleCerts).values({ vendorId, state, certType, certNumber, issueDate, expirationDate, sent, dateSent, contactSentTo, vendorConfirmed, confirmationDate, blanket, projectName, notes }).returning();
      res.json({ ...cert, status: getCertStatus(cert) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/mfr/vendors/:id/certs/:cid", async (req: Request, res: Response) => {
    try {
      const { state, certType, certNumber, issueDate, expirationDate, sent, dateSent, contactSentTo, vendorConfirmed, confirmationDate, blanket, projectName, notes } = req.body;
      const [updated] = await db.update(mfrResaleCerts)
        .set({ state, certType, certNumber, issueDate, expirationDate, sent, dateSent, contactSentTo, vendorConfirmed, confirmationDate, blanket, projectName, notes, updatedAt: new Date() })
        .where(eq(mfrResaleCerts.id, Number(req.params.cid)))
        .returning();
      res.json({ ...updated, status: getCertStatus(updated) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mfr/vendors/:id/certs/:cid", async (req: Request, res: Response) => {
    try {
      await db.delete(mfrResaleCerts).where(eq(mfrResaleCerts.id, Number(req.params.cid)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // All certs (for tracker tab)
  app.get("/api/mfr/certs/all", async (req: Request, res: Response) => {
    try {
      const certs = await db.select({
        id: mfrResaleCerts.id,
        vendorId: mfrResaleCerts.vendorId,
        vendorName: mfrVendors.name,
        state: mfrResaleCerts.state,
        certType: mfrResaleCerts.certType,
        certNumber: mfrResaleCerts.certNumber,
        issueDate: mfrResaleCerts.issueDate,
        expirationDate: mfrResaleCerts.expirationDate,
        sent: mfrResaleCerts.sent,
        dateSent: mfrResaleCerts.dateSent,
        contactSentTo: mfrResaleCerts.contactSentTo,
        vendorConfirmed: mfrResaleCerts.vendorConfirmed,
        confirmationDate: mfrResaleCerts.confirmationDate,
        blanket: mfrResaleCerts.blanket,
        projectName: mfrResaleCerts.projectName,
        notes: mfrResaleCerts.notes,
        createdAt: mfrResaleCerts.createdAt,
        updatedAt: mfrResaleCerts.updatedAt,
      }).from(mfrResaleCerts).leftJoin(mfrVendors, eq(mfrResaleCerts.vendorId, mfrVendors.id));
      res.json(certs.map((c) => ({ ...c, status: getCertStatus(c) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Dashboard compliance stats
  app.get("/api/mfr/dashboard", async (req: Request, res: Response) => {
    try {
      const allVendors = await db.select().from(mfrVendors);
      const allCerts = await db.select().from(mfrResaleCerts);
      const allTax = await db.select().from(mfrTaxInfo);

      const vendorsWithCerts = new Set(allCerts.map((c) => c.vendorId));
      const vendorsNoCerts = allVendors.filter((v) => !vendorsWithCerts.has(v.id));
      const taxMap = Object.fromEntries(allTax.map((t) => [t.vendorId, t]));

      const certsWithStatus = allCerts.map((c) => ({ ...c, status: getCertStatus(c) }));
      const w9OnFile = allVendors.filter((v) => taxMap[v.id]?.w9OnFile).length;

      res.json({
        totalVendors: allVendors.length,
        w9OnFile,
        w9Missing: allVendors.length - w9OnFile,
        certsTotal: allCerts.length,
        certsSent: certsWithStatus.filter((c) => ["sent", "confirmed", "expiring"].includes(c.status)).length,
        certsConfirmed: certsWithStatus.filter((c) => c.status === "confirmed").length,
        certsExpiring: certsWithStatus.filter((c) => c.status === "expiring").length,
        certsExpired: certsWithStatus.filter((c) => c.status === "expired").length,
        certsNotSent: certsWithStatus.filter((c) => c.status === "not_sent").length,
        vendorsNoCerts: vendorsNoCerts.map((v) => ({ id: v.id, name: v.name })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- FILES ----

  app.post("/api/mfr/vendors/:id/files", fileUpload.single("file"), async (req: Request, res: Response) => {
    try {
      const vendorId = Number(req.params.id);
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file" });
      const fileData = file.buffer.toString("base64");
      const uploadedBy = (req as any).session?.user?.displayName || "Unknown";
      const [mfrFile] = await db.insert(mfrFiles).values({
        vendorId,
        fileType: req.body.fileType || "Other",
        originalName: file.originalname,
        fileData,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedBy,
        notes: req.body.notes || null,
      }).returning();
      res.json({ ...mfrFile, fileData: undefined });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/mfr/files/:fid/download", async (req: Request, res: Response) => {
    try {
      const [file] = await db.select().from(mfrFiles).where(eq(mfrFiles.id, Number(req.params.fid)));
      if (!file || !file.fileData) return res.status(404).json({ error: "Not found" });
      const buf = Buffer.from(file.fileData, "base64");
      res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${file.originalName}"`);
      res.send(buf);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/mfr/files/:fid", async (req: Request, res: Response) => {
    try {
      await db.delete(mfrFiles).where(eq(mfrFiles.id, Number(req.params.fid)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- TEMPLATE DOWNLOAD ----

  app.get("/api/mfr/template", async (req: Request, res: Response) => {
    try {
      const workbook = new ExcelJS.Workbook();
      
      // ---- INSTRUCTIONS SHEET ----
      const instructions = workbook.addWorksheet("Instructions");
      instructions.addRow(["Manufacturer & Vendor Upload Template"]);
      instructions.addRow([""]);
      instructions.addRow(["STRUCTURE:"]);
      instructions.addRow(["- Column A: Scope/Trade category (e.g., Toilet Accessories, Fire Extinguishers)"]);
      instructions.addRow(["- Column B: Manufacturer names (comma-separated if vendor reps multiple brands)"]);
      instructions.addRow(["- Column C: Distributor/Rep Company (the vendor providing products)"]);
      instructions.addRow(["- Column D: Contact Name (primary contact)"]);
      instructions.addRow(["- Column E: Contact Email (primary contact email)"]);
      instructions.addRow(["- Column F: Contact Name 2 (optional, secondary contact)"]);
      instructions.addRow(["- Column G: Contact Email 2 (optional, secondary contact email)"]);
      instructions.addRow(["- Column H: Contact Name 3 (optional, tertiary contact)"]);
      instructions.addRow(["- Column I: Contact Email 3 (optional, tertiary contact email)"]);
      instructions.addRow(["- Column J: Materials Covered (comma-separated, e.g., 'Solid Plastic, Phenolic, Metal')"]);
      instructions.addRow(["  (For toilet partitions: solid plastic, phenolic, metal; for fixtures: chrome, stainless, etc.)"]);
      instructions.addRow([""]);
      instructions.addRow(["HOW IT WORKS:"]);
      instructions.addRow(["1. One Scope header per trade (column A only, leave B-E empty)"]);
      instructions.addRow(["2. Data rows list manufacturers and the vendor that represents them"]);
      instructions.addRow(["3. If vendor ABC Supply reps multiple manufacturers, use comma-separated list: 'Kohler, Bradley, Bobrick'"]);
      instructions.addRow(["4. The system automatically deduplicates vendors and creates relationships for each manufacturer"]);
      instructions.addRow(["5. One contact info per vendor (shared across all manufacturers they represent)"]);
      instructions.addRow([""]);
      instructions.addRow(["EXAMPLE:"]);
      instructions.addRow(["Toilet Accessories | Kohler, Bradley, Bobrick | ABC Supply | John Doe | john@example.com"]);
      instructions.addRow(["                  | Soap Dispensers Brand  | XYZ Distributors | Jane Smith | jane@example.com"]);
      instructions.addRow([""]);
      instructions.addRow(["See 'Data' sheet for the full template with examples."]);
      instructions.columns = [{ width: 80 }];

      // ---- DATA SHEET ----
      const sheet = workbook.addWorksheet("Data");

      // Header row
      const headerRow = sheet.addRow([
        "Scope / Trade", 
        "Manufacturers", 
        "Distributor / Rep", 
        "Contact Name", 
        "Email", 
        "Contact Name 2", 
        "Email 2", 
        "Contact Name 3", 
        "Email 3", 
        "Materials Covered"
      ]);
      headerRow.font = { bold: true };
      headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F0F0" } };

      // Example scope header and data
      sheet.addRow(["Toilet Accessories", "", "", "", "", "", "", "", "", ""]);
      sheet.addRow([
        "", 
        "Kohler, Bradley, Bobrick", 
        "ABC Supply", 
        "John Doe", 
        "john@example.com", 
        "Sarah Johnson", 
        "sarah@abcsupply.com", 
        "", 
        "", 
        "Solid Plastic, Phenolic, Metal"
      ]);
      sheet.addRow([
        "", 
        "Soap Dispenser Brand", 
        "XYZ Distributors", 
        "Jane Smith", 
        "jane@example.com", 
        "", 
        "", 
        "", 
        "", 
        "Automated, Manual Pump"
      ]);

      sheet.addRow([""]);
      sheet.addRow(["Fire Extinguishers", "", "", "", "", "", "", "", "", ""]);
      sheet.addRow([
        "", 
        "Amerex, Tyco", 
        "Safety Plus", 
        "Bob Wilson", 
        "bob@example.com", 
        "Mike Chen", 
        "mike@safetyplus.com", 
        "Lisa Patterson", 
        "lisa@safetyplus.com", 
        "Wet Chemical, Dry Powder, CO2"
      ]);

      // Set column widths
      sheet.columns = [
        { width: 20 },  // Scope
        { width: 25 },  // Manufacturers
        { width: 25 },  // Distributor/Rep
        { width: 18 },  // Contact 1 Name
        { width: 28 },  // Contact 1 Email
        { width: 18 },  // Contact 2 Name
        { width: 28 },  // Contact 2 Email
        { width: 18 },  // Contact 3 Name
        { width: 28 },  // Contact 3 Email
        { width: 35 },  // Materials Covered
      ];

      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename=Manufacturer_Template.xlsx");
      res.send(buffer);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- EXCEL UPLOAD ----

  app.post("/api/mfr/upload-excel", upload.single("file"), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = xlsx.read(file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames.find((n) => n.toLowerCase().includes("estimat")) || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json<any>(sheet, { header: 1, defval: "" });

      let currentScope = "";
      let manufacturersCreated = 0;
      let vendorsCreated = 0;
      let relationshipsCreated = 0;
      let contactsCreated = 0;

      // Find header row
      let dataStart = 0;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const row = rows[i] as any[];
        if (row.some((cell: any) => String(cell).toLowerCase().includes("manufacturer"))) {
          dataStart = i + 1;
          break;
        }
      }

      const existingManufacturers = await db.select().from(mfrManufacturers);
      const manufacturerNameMap = new Map(existingManufacturers.map((m) => [m.name.toLowerCase().trim(), m.id]));

      const existingVendors = await db.select().from(mfrVendors);
      const vendorNameMap = new Map(existingVendors.map((v) => [v.name.toLowerCase().trim(), v.id]));

      const existingRelationships = await db.select().from(mfrVendorManufacturers);
      const relationshipSet = new Set(existingRelationships.map((r) => `${r.vendorId}-${r.manufacturerId}`));

      const vendorScopeAccum = new Map<number, Set<string>>();
      const vendorMfrAccum = new Map<number, Set<number>>();
      for (const v of existingVendors) {
        if (v.scopes && v.scopes.length) vendorScopeAccum.set(v.id, new Set(v.scopes));
        if (v.manufacturerIds && v.manufacturerIds.length) vendorMfrAccum.set(v.id, new Set(v.manufacturerIds));
      }

      for (let i = dataStart; i < rows.length; i++) {
        const row = rows[i] as any[];
        const colA = String(row[0] || "").trim();
        const colB = String(row[1] || "").trim(); // Manufacturer names
        const colC = String(row[2] || "").trim(); // Distributor/Rep (vendor)
        const colD = String(row[3] || "").trim(); // Contact Name 1
        const colE = String(row[4] || "").trim(); // Email 1
        const colF = String(row[5] || "").trim(); // Contact Name 2
        const colG = String(row[6] || "").trim(); // Email 2
        const colH = String(row[7] || "").trim(); // Contact Name 3
        const colI = String(row[8] || "").trim(); // Email 3
        const colJ = String(row[9] || "").trim(); // Materials Covered

        // Scope/Trade header row: has value in col A but nothing in cols B-C
        if (colA && !colB && !colC) {
          currentScope = colA;
          continue;
        }

        if (!colB || !colC) continue; // Skip rows without both manufacturers AND distributor

        // Get or create vendor (distributor) - one per row
        const vendorNameLower = colC.toLowerCase().trim();
        let vendorId: number;
        if (vendorNameMap.has(vendorNameLower)) {
          vendorId = vendorNameMap.get(vendorNameLower)!;
        } else {
          const [newVendor] = await db.insert(mfrVendors).values({
            name: colC,
            category: currentScope || null,
            materials: colJ || null,
          }).returning();
          vendorId = newVendor.id;
          vendorNameMap.set(vendorNameLower, vendorId);
          vendorsCreated++;
        }

        // Parse comma-separated manufacturers
        const manufacturerNames = colB.split(",").map((m) => m.trim()).filter((m) => m.length > 0);

        for (const mfrName of manufacturerNames) {
          // Get or create manufacturer
          const mfrNameLower = mfrName.toLowerCase().trim();
          let manufacturerId: number;
          if (manufacturerNameMap.has(mfrNameLower)) {
            manufacturerId = manufacturerNameMap.get(mfrNameLower)!;
          } else {
            const [newMfr] = await db.insert(mfrManufacturers).values({
              name: mfrName,
            }).returning();
            manufacturerId = newMfr.id;
            manufacturerNameMap.set(mfrNameLower, manufacturerId);
            manufacturersCreated++;
          }

          // Create vendor-manufacturer relationship if it doesn't exist
          const relKey = `${vendorId}-${manufacturerId}`;
          if (!relationshipSet.has(relKey)) {
            await db.insert(mfrVendorManufacturers).values({
              vendorId,
              manufacturerId,
            });
            relationshipSet.add(relKey);
            relationshipsCreated++;
          }

          // Tag vendor with this manufacturer for RFQ eligibility
          if (!vendorMfrAccum.has(vendorId)) vendorMfrAccum.set(vendorId, new Set());
          vendorMfrAccum.get(vendorId)!.add(manufacturerId);
        }

        // Tag vendor with current scope for RFQ eligibility
        if (currentScope) {
          if (!vendorScopeAccum.has(vendorId)) vendorScopeAccum.set(vendorId, new Set());
          vendorScopeAccum.get(vendorId)!.add(currentScope);
        }

        // Create contact(s) once per vendor - support up to 3 contacts
        // Use pre-loaded cache (no per-row SELECT)
        if (!contactKeysByVendorId.has(vendorId)) contactKeysByVendorId.set(vendorId, new Set());
        const existingKeys = contactKeysByVendorId.get(vendorId)!;
        let contactIndex = allExistingContacts.filter((c) => c.vendorId === vendorId).length;

        // Contact pairs: [name, email]
        const contactPairs = [
          [colD, colE],
          [colF, colG],
          [colH, colI],
        ];

        for (const [contactName, contactEmail] of contactPairs) {
          if (!contactName) continue; // Skip empty contact slots

          // Extract first email if semicolon/comma separated
          const firstEmail = contactEmail.split(/[;,]/)[0].trim();

          // Check if this contact already exists (in-memory)
          const exists = existingKeys.has(contactName.toLowerCase());
          if (!exists) {
            await db.insert(mfrContacts).values({
              vendorId,
              name: contactName,
              role: "Contact",
              email: firstEmail || null,
              isPrimary: contactIndex === 0,
            });
            existingKeys.add(contactName.toLowerCase());
            if (firstEmail) existingKeys.add(firstEmail.toLowerCase());
            contactsCreated++;
            contactIndex++;
          }
        }
      }

      // Persist accumulated scope/manufacturer tags onto vendors
      const allVendorIds = new Set<number>([...vendorScopeAccum.keys(), ...vendorMfrAccum.keys()]);
      for (const vId of allVendorIds) {
        await db.update(mfrVendors).set({
          scopes: Array.from(vendorScopeAccum.get(vId) ?? []),
          manufacturerIds: Array.from(vendorMfrAccum.get(vId) ?? []),
          updatedAt: new Date(),
        }).where(eq(mfrVendors.id, vId));
      }

      res.json({ manufacturersCreated, vendorsCreated, relationshipsCreated, contactsCreated });
    } catch (err: any) {
      console.error("Excel upload error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- MANUFACTURER EXCEL UPLOAD (NBS Manufacturer List format) ----
  // Expected sheet: "Manufacturers"
  // Columns: short_code | name | legal_name | aliases | scopes | website | primary_contact | contact_email | contact_phone | address | notes

  app.post("/api/mfr/upload-manufacturers-excel", async (req: Request, res: Response) => {
    try {
      await new Promise<void>((resolve, reject) => {
        upload.single("file")(req, res, (err) => { if (err) reject(err); else resolve(); });
      });
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = xlsx.read(file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames.find((n) => n.toLowerCase().includes("manuf")) || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json<any>(sheet, { header: 1, defval: "" });

      let manufacturersCreated = 0;
      let manufacturersUpdated = 0;

      // Find header row — detect whether the new "id" column is present
      let dataStart = 0;
      let mfrHasIdCol = false;
      for (let i = 0; i < Math.min(10, rows.length); i++) {
        const cell = String((rows[i] as any[])[0] || "").trim().toLowerCase();
        if (cell === "id") { mfrHasIdCol = true; dataStart = i + 1; break; }
        if (cell === "short_code" || cell === "name") { dataStart = i + 1; break; }
      }
      const mfrOff = mfrHasIdCol ? 1 : 0;

      const existing = await db.select().from(mfrManufacturers);
      const byId = new Map(existing.map((m) => [m.id, m]));
      const byShortCode = new Map(existing.filter((m) => m.shortCode).map((m) => [m.shortCode!.toUpperCase(), m]));
      const byName = new Map(existing.map((m) => [m.name.toLowerCase().trim(), m]));

      for (let i = dataStart; i < rows.length; i++) {
        const row = rows[i] as any[];
        const rowId = mfrHasIdCol ? (Number(row[0]) || null) : null;
        const shortCode = String(row[0 + mfrOff] || "").trim().toUpperCase();
        const name = String(row[1 + mfrOff] || "").trim();

        // Skip instruction rows and empty rows
        if (shortCode.startsWith("INSTRUCTION") || (!name && !shortCode)) continue;
        if (!name) continue;

        const legalName = String(row[2 + mfrOff] || "").trim() || null;
        const aliasesRaw = String(row[3 + mfrOff] || "").trim();
        const scopesRaw = String(row[4 + mfrOff] || "").trim();
        const website = String(row[5 + mfrOff] || "").trim() || null;
        const primaryContact = String(row[6 + mfrOff] || "").trim() || null;
        const contactEmail = String(row[7 + mfrOff] || "").trim() || null;
        const contactPhone = String(row[8 + mfrOff] || "").trim() || null;
        const address = String(row[9 + mfrOff] || "").trim() || null;
        const notes = String(row[10 + mfrOff] || "").trim() || null;

        const aliases = aliasesRaw ? aliasesRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];
        const scopes = scopesRaw ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];

        const upsertData = {
          name,
          legalName,
          shortCode: shortCode || null,
          aliases: aliases.length > 0 ? aliases : [],
          scopes: scopes.length > 0 ? scopes : [],
          website,
          primaryContact,
          contactEmail,
          contactPhone,
          address,
          notes,
          updatedAt: new Date(),
        };

        // ID match first (exported file), then short_code, then name
        const existingMfr =
          (rowId && byId.get(rowId)) ||
          (shortCode && byShortCode.get(shortCode)) ||
          byName.get(name.toLowerCase().trim());

        if (existingMfr) {
          await db.update(mfrManufacturers).set(upsertData).where(eq(mfrManufacturers.id, existingMfr.id));
          manufacturersUpdated++;
          byId.set(existingMfr.id, { ...existingMfr, ...upsertData });
          if (shortCode) byShortCode.set(shortCode, { ...existingMfr, ...upsertData });
        } else {
          const [newMfr] = await db.insert(mfrManufacturers).values(upsertData).returning();
          manufacturersCreated++;
          byId.set(newMfr.id, newMfr);
          byName.set(name.toLowerCase().trim(), newMfr);
          if (shortCode) byShortCode.set(shortCode, newMfr);
        }
      }

      res.json({ manufacturersCreated, manufacturersUpdated });
    } catch (err: any) {
      console.error("Manufacturer upload error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- VENDOR EXCEL UPLOAD (NBS Vendor List format) ----
  // Sheet "Vendors": short_code | name | legal_name | aliases | category | scopes | manufacturer_short_codes | manufacturer_direct | website | materials | tags | primary_contact_name | primary_contact_role | primary_contact_email | primary_contact_phone | primary_contact_territory | notes | manufacturer_full_names
  // Sheet "Additional Contacts": vendor_short_code | name | role | email | phone | territory | notes
  // Sheet "Logistics & Pricing": vendor_short_code | avg_lead_time_days | ships_from | freight_notes | discount_tier | payment_terms | pricing_notes

  app.post("/api/mfr/upload-vendors-excel", async (req: Request, res: Response) => {
    console.log("[VendorUpload] DIAGNOSTIC: handler reached. Content-Type:", req.headers["content-type"], "Content-Length:", req.headers["content-length"]);
    try {
      await new Promise<void>((resolve, reject) => {
        upload.single("file")(req, res, (err) => {
          if (err) {
            console.error("[VendorUpload] DIAGNOSTIC: multer error:", err.message);
            reject(err);
          } else {
            console.log("[VendorUpload] DIAGNOSTIC: multer ok. file present:", !!req.file, req.file ? `size=${req.file.size}` : "");
            resolve();
          }
        });
      });
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      const workbook = xlsx.read(file.buffer, { type: "buffer" });
      const getSheet = (keyword: string) => {
        const name = workbook.SheetNames.find((n) => n.toLowerCase().includes(keyword));
        return name ? xlsx.utils.sheet_to_json<any>(workbook.Sheets[name], { header: 1, defval: "" }) : [];
      };
      const vendorRows = getSheet("vendor");
      const contactRows = getSheet("contact");
      const logisticsRows = getSheet("logistic");

      let vendorsCreated = 0;
      let vendorsUpdated = 0;
      let contactsCreated = 0;
      let manufacturerLinksCreated = 0;

      // Load all existing manufacturers for short_code + name matching
      const allMfrsDb = await db.select().from(mfrManufacturers);
      const mfrByShortCode = new Map(allMfrsDb.filter((m) => m.shortCode).map((m) => [m.shortCode!.toUpperCase(), m]));
      const mfrByName = new Map(allMfrsDb.map((m) => [m.name.toLowerCase().trim(), m]));

      // Load existing vendors
      const existingVendors = await db.select().from(mfrVendors);
      const vendorByShortCode = new Map(existingVendors.filter((v) => v.shortCode).map((v) => [v.shortCode!.toUpperCase(), v]));
      const vendorByName = new Map(existingVendors.map((v) => [v.name.toLowerCase().trim(), v]));

      // Load existing vendor-manufacturer relationships
      const existingRels = await db.select().from(mfrVendorManufacturers);
      const relSet = new Set(existingRels.map((r) => `${r.vendorId}-${r.manufacturerId}`));

      // vendorShortCode → vendorId map for later sheets
      const vendorShortCodeToId = new Map<string, number>(
        existingVendors.filter((v) => v.shortCode).map((v) => [v.shortCode!.toUpperCase(), v.id])
      );

      // Pre-load ALL contacts once — avoids a SELECT per vendor row (the main timeout cause)
      const allExistingContacts = await db.select().from(mfrContacts);
      // contactKeysByVendorId: vendorId → Set of lowercase "name|email" dedup keys
      const contactKeysByVendorId = new Map<number, Set<string>>();
      for (const c of allExistingContacts) {
        if (!contactKeysByVendorId.has(c.vendorId)) contactKeysByVendorId.set(c.vendorId, new Set());
        const s = contactKeysByVendorId.get(c.vendorId)!;
        if (c.name) s.add(c.name.toLowerCase());
        if (c.email) s.add(c.email.toLowerCase());
      }

      // Find data start row (skip header + INSTRUCTIONS)
      // Detect whether this file has the new "id" column at position 0
      const detectHasId = (rows: any[][]) => {
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const cell = String(rows[i][0] || "").trim().toLowerCase();
          if (cell === "id") return true;
          if (cell === "short_code" || cell === "vendor_short_code") return false;
        }
        return false;
      };

      const findDataStart = (rows: any[][]) => {
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const cell = String(rows[i][0] || "").trim().toLowerCase();
          if (cell === "id" || cell === "short_code" || cell === "vendor_short_code") return i + 1;
        }
        return 0;
      };

      const vendorHasIdCol = detectHasId(vendorRows);
      const vOff = vendorHasIdCol ? 1 : 0;

      const isSkipRow = (row: any[], off: number) => {
        const nameCol = String(row[1 + off] || "").trim();
        const firstCol = String(row[0] || "").trim();
        return firstCol.startsWith("INSTRUCTION") || (nameCol === "" && firstCol === "");
      };

      // Load existing vendors by ID for fast lookup
      const vendorById = new Map(existingVendors.map((v) => [v.id, v]));

      // ---- Process Vendors sheet ----
      const vendorDataStart = findDataStart(vendorRows);
      for (let i = vendorDataStart; i < vendorRows.length; i++) {
        const row = vendorRows[i] as any[];
        if (isSkipRow(row, vOff)) continue;

        const rowVendorId = vendorHasIdCol ? (Number(row[0]) || null) : null;
        const shortCode = String(row[0 + vOff] || "").trim().toUpperCase() || null;
        const name = String(row[1 + vOff] || "").trim();
        if (!name) continue;

        const legalName = String(row[2 + vOff] || "").trim() || null;
        const aliasesRaw = String(row[3 + vOff] || "").trim();
        const category = String(row[4 + vOff] || "").trim() || null;
        const scopesRaw = String(row[5 + vOff] || "").trim();
        const mfrShortCodesRaw = String(row[6 + vOff] || "").trim();
        const manufacturerDirect = String(row[7 + vOff] || "").trim().toUpperCase() === "YES";
        const website = String(row[8 + vOff] || "").trim() || null;
        const materials = String(row[9 + vOff] || "").trim() || null;
        const tagsRaw = String(row[10 + vOff] || "").trim();
        const primaryContactName = String(row[11 + vOff] || "").trim() || null;
        const primaryContactRole = String(row[12 + vOff] || "").trim() || null;
        const primaryContactEmail = String(row[13 + vOff] || "").trim() || null;
        const primaryContactPhone = String(row[14 + vOff] || "").trim() || null;
        const primaryContactTerritory = String(row[15 + vOff] || "").trim() || null;
        const notes = String(row[16 + vOff] || "").trim() || null;
        const mfrFullNamesRaw = String(row[17 + vOff] || "").trim();

        const aliases = aliasesRaw ? aliasesRaw.split(",").map((a) => a.trim()).filter(Boolean) : [];
        const scopes = scopesRaw ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
        const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [];
        const mfrShortCodes = mfrShortCodesRaw ? mfrShortCodesRaw.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) : [];
        const mfrFullNames = mfrFullNamesRaw ? mfrFullNamesRaw.split(",").map((n) => n.trim()).filter(Boolean) : [];

        // Resolve manufacturer IDs via short_code then full name
        const linkedMfrIds: number[] = [];
        for (let k = 0; k < Math.max(mfrShortCodes.length, mfrFullNames.length); k++) {
          const sc = mfrShortCodes[k];
          const fn = mfrFullNames[k];
          let mfr = (sc && mfrByShortCode.get(sc)) || (fn && mfrByName.get(fn.toLowerCase().trim()));
          if (!mfr && fn) {
            // Auto-create manufacturer from full name
            const [newMfr] = await db.insert(mfrManufacturers).values({ name: fn, shortCode: sc || null }).returning();
            mfr = newMfr;
            mfrByName.set(fn.toLowerCase().trim(), newMfr);
            if (sc) mfrByShortCode.set(sc, newMfr);
          }
          if (mfr && !linkedMfrIds.includes(mfr.id)) linkedMfrIds.push(mfr.id);
        }

        const upsertData = {
          name,
          legalName,
          shortCode,
          aliases,
          category,
          scopes,
          manufacturerDirect,
          website,
          materials,
          tags,
          manufacturerIds: linkedMfrIds,
          notes,
          updatedAt: new Date(),
        };

        // ID match first (exported file), then short_code, then name
        const existingVendor =
          (rowVendorId && vendorById.get(rowVendorId)) ||
          (shortCode && vendorByShortCode.get(shortCode)) ||
          vendorByName.get(name.toLowerCase().trim());
        let vendorId: number;

        if (existingVendor) {
          await db.update(mfrVendors).set(upsertData).where(eq(mfrVendors.id, existingVendor.id));
          vendorId = existingVendor.id;
          vendorsUpdated++;
          vendorById.set(vendorId, { ...existingVendor, ...upsertData });
        } else {
          const [newVendor] = await db.insert(mfrVendors).values(upsertData).returning();
          vendorId = newVendor.id;
          vendorsCreated++;
          vendorById.set(vendorId, newVendor);
          vendorByName.set(name.toLowerCase().trim(), newVendor);
        }
        if (shortCode) {
          vendorByShortCode.set(shortCode, { ...(existingVendor || {}), ...upsertData, id: vendorId } as any);
          vendorShortCodeToId.set(shortCode, vendorId);
        }

        // Link manufacturers
        for (const mfrId of linkedMfrIds) {
          const key = `${vendorId}-${mfrId}`;
          if (!relSet.has(key)) {
            await db.insert(mfrVendorManufacturers).values({ vendorId, manufacturerId: mfrId });
            relSet.add(key);
            manufacturerLinksCreated++;
          }
        }

        // Create primary contact (in-memory dedup — no per-row SELECT)
        if (primaryContactName || primaryContactEmail) {
          if (!contactKeysByVendorId.has(vendorId)) contactKeysByVendorId.set(vendorId, new Set());
          const ckeys = contactKeysByVendorId.get(vendorId)!;
          const nameKey = (primaryContactName || "").toLowerCase();
          const emailKey = (primaryContactEmail || "").toLowerCase();
          const alreadyExists = (nameKey && ckeys.has(nameKey)) || (emailKey && ckeys.has(emailKey));
          if (!alreadyExists) {
            await db.insert(mfrContacts).values({
              vendorId,
              name: primaryContactName,
              role: primaryContactRole || "Contact",
              email: primaryContactEmail,
              phone: primaryContactPhone,
              territory: primaryContactTerritory,
              isPrimary: true,
            });
            if (nameKey) ckeys.add(nameKey);
            if (emailKey) ckeys.add(emailKey);
            contactsCreated++;
          }
        }
      }

      // ---- Process Additional Contacts sheet ----
      const contactDataStart = findDataStart(contactRows);
      for (let i = contactDataStart; i < contactRows.length; i++) {
        const row = contactRows[i] as any[];
        if (isSkipRow(row)) continue;

        const vendorShortCode = String(row[0] || "").trim().toUpperCase();
        const contactName = String(row[1] || "").trim();
        if (!vendorShortCode || !contactName) continue;

        const vendorId = vendorShortCodeToId.get(vendorShortCode);
        if (!vendorId) continue;

        const role = String(row[2] || "").trim() || "Contact";
        const email = String(row[3] || "").trim() || null;
        const phone = String(row[4] || "").trim() || null;
        const territory = String(row[5] || "").trim() || null;
        const notes = String(row[6] || "").trim() || null;

        // In-memory dedup — no per-row SELECT
        if (!contactKeysByVendorId.has(vendorId)) contactKeysByVendorId.set(vendorId, new Set());
        const ckeys2 = contactKeysByVendorId.get(vendorId)!;
        const nameKey2 = contactName.toLowerCase();
        const emailKey2 = (email || "").toLowerCase();
        const alreadyExists = ckeys2.has(nameKey2) || (emailKey2 && ckeys2.has(emailKey2));
        if (!alreadyExists) {
          await db.insert(mfrContacts).values({ vendorId, name: contactName, role, email, phone, territory, notes, isPrimary: false });
          ckeys2.add(nameKey2);
          if (emailKey2) ckeys2.add(emailKey2);
          contactsCreated++;
        }
      }

      // ---- Process Logistics & Pricing sheet ----
      const logDataStart = findDataStart(logisticsRows);
      for (let i = logDataStart; i < logisticsRows.length; i++) {
        const row = logisticsRows[i] as any[];
        if (isSkipRow(row)) continue;

        const vendorShortCode = String(row[0] || "").trim().toUpperCase();
        if (!vendorShortCode) continue;

        const vendorId = vendorShortCodeToId.get(vendorShortCode);
        if (!vendorId) continue;

        const avgLeadTimeDays = parseInt(String(row[1] || ""), 10) || null;
        const shipsFrom = String(row[2] || "").trim() || null;
        const freightNotes = String(row[3] || "").trim() || null;
        const discountTier = String(row[4] || "").trim() || null;
        const paymentTerms = String(row[5] || "").trim() || null;
        const pricingNotes = String(row[6] || "").trim() || null;

        if (avgLeadTimeDays !== null || shipsFrom || freightNotes) {
          await db.insert(mfrLogistics).values({ vendorId, avgLeadTimeDays, shipsFrom, freightNotes })
            .onConflictDoUpdate({ target: mfrLogistics.vendorId, set: { avgLeadTimeDays, shipsFrom, freightNotes, updatedAt: new Date() } });
        }
        if (discountTier || paymentTerms || pricingNotes) {
          await db.insert(mfrPricing).values({ vendorId, discountTier, paymentTerms, notes: pricingNotes })
            .onConflictDoUpdate({ target: mfrPricing.vendorId, set: { discountTier, paymentTerms, notes: pricingNotes, updatedAt: new Date() } });
        }
      }

      res.json({ vendorsCreated, vendorsUpdated, contactsCreated, manufacturerLinksCreated });
    } catch (err: any) {
      console.error("Vendor upload error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- CLEAR ALL ----

  app.delete("/api/mfr/all", async (req: Request, res: Response) => {
    try {
      // Delete in dependency order (child tables before parent tables)
      await db.delete(mfrFiles);
      await db.delete(mfrResaleCerts);
      await db.delete(mfrTaxInfo);
      await db.delete(mfrLogistics);
      await db.delete(mfrPricing);
      await db.delete(mfrProducts);
      await db.delete(mfrContacts);
      await db.delete(mfrVendorManufacturers);
      await db.delete(mfrVendors);
      await db.delete(mfrManufacturers);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- EXPORT (JSON — kept for internal use) ----

  app.get("/api/mfr/export", async (req: Request, res: Response) => {
    try {
      const vendors = await db.select().from(mfrVendors);
      const result = await Promise.all(vendors.map((v) => getFullVendor(v.id)));
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- EXPORT EXCEL (round-trip compatible with upload-manufacturers-excel + upload-vendors-excel) ----

  app.get("/api/mfr/export-excel", async (req: Request, res: Response) => {
    try {
      // Fetch all data up front
      const allMfrs = await db.select().from(mfrManufacturers).orderBy(mfrManufacturers.name);
      const allVendors = await db.select().from(mfrVendors).orderBy(mfrVendors.name);
      const allContacts = await db.select().from(mfrContacts);
      const allLogistics = await db.select().from(mfrLogistics);
      const allPricing = await db.select().from(mfrPricing);
      const allRels = await db.select().from(mfrVendorManufacturers);

      const mfrById = new Map(allMfrs.map((m) => [m.id, m]));

      const contactsByVendor = new Map<number, typeof allContacts>();
      for (const c of allContacts) {
        if (!contactsByVendor.has(c.vendorId)) contactsByVendor.set(c.vendorId, []);
        contactsByVendor.get(c.vendorId)!.push(c);
      }
      const logisticsByVendor = new Map(allLogistics.map((l) => [l.vendorId, l]));
      const pricingByVendor = new Map(allPricing.map((p) => [p.vendorId, p]));
      const relsByVendor = new Map<number, number[]>();
      for (const r of allRels) {
        if (!relsByVendor.has(r.vendorId)) relsByVendor.set(r.vendorId, []);
        relsByVendor.get(r.vendorId)!.push(r.manufacturerId);
      }

      const wb = xlsx.utils.book_new();

      // ---- Sheet 1: Manufacturers ----
      const mfrRows: any[][] = [
        ["id", "short_code", "name", "legal_name", "aliases", "scopes", "website", "primary_contact", "contact_email", "contact_phone", "address", "notes"],
      ];
      for (const m of allMfrs) {
        mfrRows.push([
          m.id,
          m.shortCode || "",
          m.name,
          m.legalName || "",
          (m.aliases || []).join(", "),
          (m.scopes || []).join(", "),
          m.website || "",
          m.primaryContact || "",
          m.contactEmail || "",
          m.contactPhone || "",
          m.address || "",
          m.notes || "",
        ]);
      }
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(mfrRows), "Manufacturers");

      // ---- Sheet 2: Vendors ----
      const vendorRows: any[][] = [
        ["id", "short_code", "name", "legal_name", "aliases", "category", "scopes",
          "manufacturer_short_codes", "manufacturer_direct", "website", "materials", "tags",
          "primary_contact_name", "primary_contact_role", "primary_contact_email",
          "primary_contact_phone", "primary_contact_territory", "notes", "manufacturer_full_names"],
      ];

      // ---- Sheet 3: Additional Contacts ----
      const contactRows: any[][] = [
        ["vendor_short_code", "name", "role", "email", "phone", "territory", "notes"],
      ];

      // ---- Sheet 4: Logistics & Pricing ----
      const logRows: any[][] = [
        ["vendor_short_code", "avg_lead_time_days", "ships_from", "freight_notes", "discount_tier", "payment_terms", "pricing_notes"],
      ];

      for (const v of allVendors) {
        const contacts = contactsByVendor.get(v.id) || [];
        const primaryContact = contacts.find((c) => c.isPrimary) || contacts[0] || null;
        const logistics = logisticsByVendor.get(v.id) || null;
        const pricing = pricingByVendor.get(v.id) || null;
        const linkedMfrIds = relsByVendor.get(v.id) || [];
        const linkedMfrs = linkedMfrIds.map((id) => mfrById.get(id)).filter(Boolean) as typeof allMfrs;
        const mfrShortCodes = linkedMfrs.map((m) => m.shortCode || "").filter(Boolean).join(", ");
        const mfrFullNames = linkedMfrs.map((m) => m.name).join(", ");

        vendorRows.push([
          v.id,
          v.shortCode || "",
          v.name,
          v.legalName || "",
          (v.aliases || []).join(", "),
          v.category || "",
          (v.scopes || []).join(", "),
          mfrShortCodes,
          v.manufacturerDirect ? "YES" : "NO",
          v.website || "",
          v.materials || "",
          (v.tags || []).join(", "),
          primaryContact?.name || "",
          primaryContact?.role || "",
          primaryContact?.email || "",
          primaryContact?.phone || "",
          primaryContact?.territory || "",
          v.notes || "",
          mfrFullNames,
        ]);

        const toEmit = primaryContact ? contacts.filter((c) => c.id !== primaryContact.id) : contacts;
        for (const c of toEmit) {
          contactRows.push([
            v.shortCode || "",
            c.name || "",
            c.role || "",
            c.email || "",
            c.phone || "",
            c.territory || "",
            c.notes || "",
          ]);
        }

        if (logistics || pricing) {
          logRows.push([
            v.shortCode || "",
            logistics?.avgLeadTimeDays ?? "",
            logistics?.shipsFrom || "",
            logistics?.freightNotes || "",
            pricing?.discountTier || "",
            pricing?.paymentTerms || "",
            pricing?.notes || "",
          ]);
        }
      }

      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(vendorRows), "Vendors");
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(contactRows), "Additional Contacts");
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(logRows), "Logistics & Pricing");

      const buffer: Buffer = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Manufacturers_Vendors_${date}.xlsx"`);
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
    } catch (err: any) {
      console.error("Excel export error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
