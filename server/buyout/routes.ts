// =====================================================
// BUYOUT BOT — server routes
// =====================================================
// Follows the same "db directly in the route file" pattern as
// vendorDatabaseRoutes. The full board lives in a single JSONB column; list-view
// fields are cached on each write from the shared boardTotals() helper so the
// project log never has to deserialize every board.

import type { Express, Request, Response } from "express";
import multer from "multer";
import { db } from "../db";
import { buyoutProjects } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { parseEstimateBuffer } from "@shared/buyout/estimateParser";
import { boardTotals, type BuyoutBoard, BUYOUT_BOARD_VERSION } from "@shared/buyout/types";
import { buildRfqEmail, type RfqContext } from "./rfqBuilder";
import { sendRfqEmail } from "../emailService";
import { readQuoteFile } from "./quoteReader";
import { buildBuyoutWorkbook } from "./excelExport";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function cacheFields(board: BuyoutBoard) {
  const t = boardTotals(board);
  return {
    status: t.complete ? "complete" : "in_progress",
    scopeCount: t.scopeCount,
    boughtOutCount: t.boughtOut,
    budgetTotal: String(t.budgetTotal),
    awardedTotal: String(t.awardedTotal),
    awardedBudget: String(t.awardedBudget),
  };
}

function normalizeBoard(input: any): BuyoutBoard {
  const scopes = Array.isArray(input?.scopes) ? input.scopes : [];
  return { version: BUYOUT_BOARD_VERSION, scopes };
}

export function registerBuyoutRoutes(app: Express) {
  // ---- Parse an uploaded estimate workbook (no persistence) ----------------
  app.post("/api/buyout/parse", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const parsed = parseEstimateBuffer(req.file.buffer);
      res.json({ ...parsed, sourceFilename: req.file.originalname });
    } catch (err: any) {
      console.error("[Buyout] parse error:", err);
      res.status(500).json({ error: err.message || "Failed to parse estimate" });
    }
  });

  // ---- List projects (cached header fields only) ---------------------------
  app.get("/api/buyout/projects", async (_req: Request, res: Response) => {
    try {
      const rows = await db
        .select({
          id: buyoutProjects.id,
          name: buyoutProjects.name,
          sourceFilename: buyoutProjects.sourceFilename,
          projectId: buyoutProjects.projectId,
          estimateId: buyoutProjects.estimateId,
          status: buyoutProjects.status,
          scopeCount: buyoutProjects.scopeCount,
          boughtOutCount: buyoutProjects.boughtOutCount,
          budgetTotal: buyoutProjects.budgetTotal,
          awardedTotal: buyoutProjects.awardedTotal,
          awardedBudget: buyoutProjects.awardedBudget,
          isTest: buyoutProjects.isTest,
          createdBy: buyoutProjects.createdBy,
          createdAt: buyoutProjects.createdAt,
          updatedAt: buyoutProjects.updatedAt,
        })
        .from(buyoutProjects)
        .orderBy(desc(buyoutProjects.updatedAt));
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Create a project from a parsed board --------------------------------
  app.post("/api/buyout/projects", async (req: Request, res: Response) => {
    try {
      const { name, sourceFilename, projectId, estimateId, board, isTest } = req.body || {};
      const cleanName = String(name || "").trim();
      if (!cleanName) return res.status(400).json({ error: "Project name required" });
      const normalized = normalizeBoard(board);
      const createdBy = (req.session as any)?.userId ? String((req.session as any).userId) : null;
      const [row] = await db
        .insert(buyoutProjects)
        .values({
          name: cleanName,
          sourceFilename: sourceFilename || null,
          projectId: Number.isFinite(Number(projectId)) ? Number(projectId) : null,
          estimateId: Number.isFinite(Number(estimateId)) ? Number(estimateId) : null,
          boardData: normalized,
          isTest: !!isTest,
          createdBy,
          ...cacheFields(normalized),
        })
        .returning();
      res.json(row);
    } catch (err: any) {
      console.error("[Buyout] create error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Get one full project (resume) ---------------------------------------
  app.get("/api/buyout/projects/:id", async (req: Request, res: Response) => {
    try {
      const [row] = await db.select().from(buyoutProjects).where(eq(buyoutProjects.id, Number(req.params.id)));
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Auto-save (board + optional name) -----------------------------------
  app.patch("/api/buyout/projects/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { name, board } = req.body || {};
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (name !== undefined) {
        const cleanName = String(name || "").trim();
        if (!cleanName) return res.status(400).json({ error: "Name cannot be empty" });
        updates.name = cleanName;
      }
      if (board !== undefined) {
        const normalized = normalizeBoard(board);
        updates.boardData = normalized;
        Object.assign(updates, cacheFields(normalized));
      }
      const [row] = await db.update(buyoutProjects).set(updates).where(eq(buyoutProjects.id, id)).returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (err: any) {
      console.error("[Buyout] save error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/buyout/projects/:id", async (req: Request, res: Response) => {
    try {
      await db.delete(buyoutProjects).where(eq(buyoutProjects.id, Number(req.params.id)));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Send RFQs — one individual email per vendor (confirmation is a
  // client-side gate; this endpoint always sends to the recipients given) -----
  app.post("/api/buyout/projects/:id/rfq", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { scopeId, recipients, quotesDueBy, senderName, senderEmail } = req.body || {};
      if (!scopeId || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: "scopeId and at least one recipient are required" });
      }
      const [row] = await db.select().from(buyoutProjects).where(eq(buyoutProjects.id, id));
      if (!row) return res.status(404).json({ error: "Not found" });
      const board = row.boardData as BuyoutBoard;
      const scope = board.scopes.find((s) => s.id === scopeId);
      if (!scope) return res.status(404).json({ error: "Scope not found" });

      const results: { vendorId: string; vendorName: string; email: string; ok: boolean; error?: string }[] = [];
      for (const r of recipients) {
        const email = String(r?.email || "").trim();
        const ctx: RfqContext = {
          vendorName: r?.vendorName || "Vendor",
          vendorContactName: r?.contactName,
          projectName: row.name,
          senderName,
          senderEmail,
          quotesDueBy,
          rosDate: scope.rosDate,
        };
        const { subject, html, text } = buildRfqEmail(ctx, scope);
        const result = await sendRfqEmail({
          to: email,
          vendorName: ctx.vendorName,
          projectName: row.name,
          scopeName: scope.name,
          subject,
          html,
          text,
          replyTo: senderEmail,
        });
        results.push({ vendorId: String(r?.vendorId ?? ""), vendorName: ctx.vendorName, email, ok: result.ok, error: result.error });
      }

      const anySent = results.some((x) => x.ok);
      // On success, advance the scope to rfq_sent and persist.
      if (anySent && scope.status === "not_started") {
        scope.status = "rfq_sent";
        await db
          .update(buyoutProjects)
          .set({ boardData: board, updatedAt: new Date(), ...cacheFields(board) })
          .where(eq(buyoutProjects.id, id));
      }
      res.json({ results, sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length });
    } catch (err: any) {
      console.error("[Buyout] rfq error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- AI vendor gap-fill — suggest Division 10 vendors for a scope that has
  // zero tagged vendors. Never auto-adds; the client offers to add them. --------
  app.post("/api/buyout/suggest-vendors", async (req: Request, res: Response) => {
    try {
      const { scopeName, sampleItems } = req.body || {};
      if (!scopeName) return res.status(400).json({ error: "scopeName required" });
      if (!process.env.OPENAI_API_KEY) return res.json({ suggestions: [] });
      const { default: OpenAI } = await import("openai");
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const items = Array.isArray(sampleItems) ? sampleItems.slice(0, 6).join("; ") : "";
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content:
              `You are a Division 10 specialty-construction procurement assistant. ` +
              `Respond ONLY with JSON: {"suggestions":[{"name":string,"note":string}]} — ` +
              `the 2-3 manufacturers/vendors a subcontractor would actually send an RFQ to for the given scope.`,
          },
          { role: "user", content: `Scope: "${scopeName}". Line items: ${items || "(none provided)"}.` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 400,
      });
      const parsed = JSON.parse(response.choices[0].message.content || "{}");
      const suggestions = Array.isArray(parsed?.suggestions)
        ? parsed.suggestions.filter((s: any) => s?.name).map((s: any) => ({ name: String(s.name), note: String(s.note || "") }))
        : [];
      res.json({ suggestions });
    } catch (err: any) {
      console.error("[Buyout] suggest-vendors error:", err);
      res.json({ suggestions: [] });
    }
  });

  // ---- Add a suggested vendor to the central Vendor Database (with the scope
  // tag) — the only write into the vendor store, gated by an explicit click. ----
  app.post("/api/buyout/add-vendor", async (req: Request, res: Response) => {
    try {
      const { name, scopeName } = req.body || {};
      const clean = String(name || "").trim();
      if (!clean || !scopeName) return res.status(400).json({ error: "name and scopeName required" });
      const { mfrVendors } = await import("@shared/schema");
      const [vendor] = await db
        .insert(mfrVendors)
        .values({ name: clean, legalName: clean, scopes: [String(scopeName)], tags: [] as any })
        .returning();
      res.json(vendor);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- AI quote reading (OpenAI) — returns unverified extraction ------------
  app.post("/api/buyout/read-quote", upload.single("file"), async (req: Request, res: Response) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ error: "AI quote reading is unavailable (no OPENAI_API_KEY configured)" });
      }
      const extraction = await readQuoteFile(req.file.buffer, req.file.mimetype);
      res.json({ extraction, filename: req.file.originalname });
    } catch (err: any) {
      console.error("[Buyout] read-quote error:", err);
      res.status(500).json({ error: err.message || "Failed to read quote" });
    }
  });

  // ---- Excel export (multi-sheet exec report) ------------------------------
  app.get("/api/buyout/projects/:id/export", async (req: Request, res: Response) => {
    try {
      const [row] = await db.select().from(buyoutProjects).where(eq(buyoutProjects.id, Number(req.params.id)));
      if (!row) return res.status(404).json({ error: "Not found" });
      const wb = await buildBuyoutWorkbook(row.name, row.boardData as BuyoutBoard);
      const safeName = row.name.replace(/[^a-z0-9_\- ]/gi, "_").slice(0, 80);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="Buyout_${safeName}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err: any) {
      console.error("[Buyout] export error:", err);
      res.status(500).json({ error: err.message });
    }
  });
}
