// ══════════════════════════════════════════════════════════════════════════
// AiPM INTEGRATION API  —  /api/integration/v1
// ══════════════════════════════════════════════════════════════════════════
//
// The estimating data surface that SharePoint and Power Automate talk to.
// Full documentation, example payloads and flow recipes: docs/INTEGRATION_API.md
//
// WHY THIS IS A SEPARATE ROUTER AND NOT JUST MORE /api/estimates ROUTES
//
//   The existing /api/estimates/* endpoints are the browser's private back
//   end: they authenticate with a login session cookie, they return AiPM's
//   raw table rows, and their shape changes whenever the UI needs it to.
//   Neither property works for a corporate automation contract.
//
//   This router is the opposite on all three counts. It authenticates with an
//   API key (no cookie), it returns a documented, stable, flattened shape with
//   the totals already computed, and it is versioned in the path so a future
//   /v2 can change that shape without breaking a live Power Automate flow.
//
// WHERE THE DATA LIVES
//
//   AiPM stays the system of record for estimating. This API never reaches
//   into SharePoint and holds no Microsoft credentials — Power Automate, which
//   already runs inside the corporate tenant, pulls from here and writes into
//   SharePoint itself. That is what keeps the corporate data-isolation story
//   intact: the tenant's credentials never leave the tenant.

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  estimates, estimateLineItems, estimateQuotes, estimateVersions,
  estimateBreakoutGroups, estimateBreakoutAllocations, estimateSpecSections,
  estimateReviewComments, estimateScopeManufacturers, ohApprovalLog, rfqLog,
  vendorQuoteLineItems, vendorQuoteToEstimateLineItemMap,
  proposalLogEntries,
} from "@shared/schema";
import { ALL_SCOPES, UNCATEGORIZED_SCOPE } from "@shared/estimateScopes";
import { auditLog } from "../auditService";
import { integrationCors, requireApiKey, apiError } from "./security";
import { loadEstimate, toEstimate, toSummary, listEstimates } from "./estimateResource";
import { buildSheets, renderWorkbook, sheetsToJson, workbookFilename } from "./workbook";

export const INTEGRATION_API_PREFIX = "/api/integration/v1";
const API_VERSION = "1.0.0";

// ── Validation ─────────────────────────────────────────────────────────────

const KNOWN_SCOPE_IDS = [...ALL_SCOPES.map(s => s.id), UNCATEGORIZED_SCOPE.id];

/** Accept a number or a numeric string ("1,250.00" included) as a number. */
const numeric = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const parsed = typeof v === "number" ? v : parseFloat(v.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a number" });
    return z.NEVER;
  }
  return parsed;
});

const percent = numeric.pipe(z.number().min(0).max(100));

const lineItemInput = z.object({
  lineItemId: z.number().int().positive().optional(),
  scopeId: z.string().min(1),
  name: z.string().min(1).max(255),
  planCallout: z.string().max(50).nullish(),
  model: z.string().max(100).nullish(),
  manufacturer: z.string().max(100).nullish(),
  qty: numeric.pipe(z.number().int().min(0)).default(1),
  uom: z.string().max(10).default("EA"),
  unitCost: numeric.pipe(z.number().min(0)).default(0),
  escalationOverridePct: percent.nullish(),
  quoteId: z.number().int().positive().nullish(),
  source: z.string().max(30).default("power_automate"),
  note: z.string().nullish(),
  hasBackup: z.boolean().default(false),
  sortOrder: z.number().int().optional(),
});

/**
 * The same fields with no defaults and nothing required — used by the
 * single-line-item PUT, where an absent field must mean "leave it alone"
 * rather than "reset it to the default".
 */
const lineItemPatchInput = z.object({
  scopeId: z.string().min(1).optional(),
  name: z.string().min(1).max(255).optional(),
  planCallout: z.string().max(50).nullish(),
  model: z.string().max(100).nullish(),
  manufacturer: z.string().max(100).nullish(),
  qty: numeric.pipe(z.number().int().min(0)).optional(),
  uom: z.string().max(10).optional(),
  unitCost: numeric.pipe(z.number().min(0)).optional(),
  escalationOverridePct: percent.nullish(),
  quoteId: z.number().int().positive().nullish(),
  source: z.string().max(30).optional(),
  note: z.string().nullish(),
  hasBackup: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

const ratesInput = z.object({
  overheadPct: percent.optional(),
  feePct: percent.optional(),
  escalationPct: percent.optional(),
  taxPct: percent.optional(),
  bondPct: percent.optional(),
}).strict();

const createEstimateInput = z.object({
  proposalLogId: z.number().int().positive().optional(),
  estimateNumber: z.string().min(1).max(50),
  projectName: z.string().min(1).max(255),
  selfPerformEstimator: z.string().max(200).nullish(),
  nbsEstimator: z.string().max(200).nullish(),
  gcEstimateLead: z.string().max(200).nullish(),
  region: z.string().max(200).nullish(),
  primaryMarket: z.string().max(200).nullish(),
  dueDate: z.string().max(20).nullish(),
  projectAddress: z.string().max(1000).nullish(),
  activeScopes: z.array(z.string()).optional(),
  rates: ratesInput.optional(),
  assumptions: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  reviewStatus: z.string().max(30).optional(),
  isTest: z.boolean().optional(),
  createdBy: z.string().max(100).nullish(),
  lineItems: z.array(lineItemInput).optional(),
});

const updateEstimateInput = z.object({
  estimateNumber: z.string().min(1).max(50).optional(),
  projectName: z.string().min(1).max(255).optional(),
  activeScopes: z.array(z.string()).optional(),
  rates: ratesInput.optional(),
  scopeRateOverrides: z.record(z.object({
    oh: percent.nullish(),
    fee: percent.nullish(),
    esc: percent.nullish(),
  })).optional(),
  assumptions: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  reviewStatus: z.string().max(30).optional(),
  isTest: z.boolean().optional(),
  updatedBy: z.string().max(100).nullish(),
  lineItems: z.array(lineItemInput).optional(),
  /**
   * "merge"   — update the line items sent, insert the ones without an id,
   *             leave everything else alone. The default: safe to retry.
   * "replace" — additionally DELETE any line item not present in the payload,
   *             making the estimate exactly match what was sent.
   */
  lineItemMode: z.enum(["merge", "replace"]).default("merge"),
});

function zodDetails(err: z.ZodError) {
  return err.issues.map(i => ({
    field: i.path.join(".") || "(body)",
    message: i.message,
  }));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function unknownScopes(ids: string[]): string[] {
  return ids.filter(id => !KNOWN_SCOPE_IDS.includes(id));
}

async function audit(req: Request, action: string, estimateId: number | string | null, summary: string, status: number, metadata?: Record<string, any>) {
  await auditLog({
    actorEmail: `integration:${req.integrationKey?.label ?? "unknown"}`,
    actionType: action,
    entityType: "estimate",
    entityId: estimateId != null ? String(estimateId) : undefined,
    summary,
    metadata,
    ipAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "",
    userAgent: req.headers["user-agent"] || "",
    requestPath: req.originalUrl || req.path,
    requestMethod: req.method,
    responseStatus: status,
  });
}

/** Map an API line item onto the estimate_line_items column names. */
function toLineItemRow(estimateId: number, input: z.infer<typeof lineItemInput>, fallbackSort: number) {
  return {
    estimateId,
    category: input.scopeId,
    planCallout: input.planCallout ?? null,
    name: input.name,
    model: input.model ?? null,
    mfr: input.manufacturer ?? null,
    qty: input.qty,
    uom: input.uom,
    unitCost: String(input.unitCost),
    escOverride: input.escalationOverridePct != null ? String(input.escalationOverridePct) : null,
    quoteId: input.quoteId ?? null,
    source: input.source,
    note: input.note ?? null,
    hasBackup: input.hasBackup,
    sortOrder: input.sortOrder ?? fallbackSort,
  };
}

/** Touch `updatedAt` so `?updatedSince=` polling sees the change. */
async function touch(estimateId: number) {
  await db.update(estimates).set({ updatedAt: new Date() }).where(eq(estimates.id, estimateId));
}

async function respondWithEstimate(res: Response, estimateId: number, status = 200) {
  const loaded = await loadEstimate(estimateId);
  if (!loaded) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${estimateId}.`);
  return res.status(status).json(toEstimate(loaded));
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerIntegrationRoutes(app: Express) {
  const p = INTEGRATION_API_PREFIX;

  // CORS first, so even a rejected request answers the browser's preflight.
  app.use(p, integrationCors);

  // ── Health ──
  // Deliberately open: Power Automate's "test connection" step needs
  // something to hit before a key is configured. It exposes nothing.
  app.get(`${p}/health`, (_req: Request, res: Response) => {
    res.json({ status: "ok", api: "aipm-estimating-integration", version: API_VERSION, time: new Date().toISOString() });
  });

  // Everything past this point needs a valid API key.
  app.use(p, requireApiKey);

  // ── Reference data ──
  // Feed this to a SharePoint Choice column so its options can never drift
  // from the scope ids AiPM actually stores.
  app.get(`${p}/scopes`, (_req: Request, res: Response) => {
    res.json({
      scopes: [...ALL_SCOPES, UNCATEGORIZED_SCOPE].map(s => ({
        scopeId: s.id, scopeLabel: s.label, csiCode: s.csi,
      })),
    });
  });

  // ── LIST ──
  app.get(`${p}/estimates`, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);

      let updatedSince: Date | undefined;
      if (req.query.updatedSince) {
        const d = new Date(String(req.query.updatedSince));
        if (isNaN(d.getTime())) {
          return apiError(res, 400, "INVALID_PARAMETER",
            "updatedSince must be an ISO 8601 timestamp, e.g. 2026-09-12T00:00:00Z.");
        }
        updatedSince = d;
      }

      const { rows, total } = await listEstimates({
        updatedSince,
        reviewStatus: req.query.reviewStatus ? String(req.query.reviewStatus) : undefined,
        estimateNumber: req.query.estimateNumber ? String(req.query.estimateNumber) : undefined,
        proposalLogId: req.query.proposalLogId ? Number(req.query.proposalLogId) : undefined,
        includeTest: String(req.query.includeTest || "false") === "true",
        limit, offset,
      });

      res.json({
        estimates: rows,
        pagination: { total, limit, offset, returned: rows.length, hasMore: offset + rows.length < total },
        // Hand back the moment this page was produced so the next poll can
        // pass it straight back as updatedSince with no clock math.
        polledAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[IntegrationAPI] GET /estimates failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to list estimates.");
    }
  });

  // ── READ ONE ──
  app.get(`${p}/estimates/:id`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");
    try {
      const loaded = await loadEstimate(id);
      if (!loaded) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);
      res.json(toEstimate(loaded));
    } catch (err: any) {
      console.error("[IntegrationAPI] GET /estimates/:id failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to load estimate.");
    }
  });

  // ── SHAREPOINT LIST ITEM ──
  // One flat object, no nesting, ready for "Create item" / "Update item".
  // The SharePoint list is the index; the workbook is the detail.
  app.get(`${p}/estimates/:id/sharepoint-item`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");
    try {
      const loaded = await loadEstimate(id);
      if (!loaded) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);
      const e = toEstimate(loaded);
      res.json({
        Title: e.projectName,
        EstimateId: e.estimateId,
        EstimateNumber: e.estimateNumber,
        ProposalLogId: e.proposalLogId,
        ProjectName: e.projectName,
        SelfPerformEstimator: e.selfPerformEstimator ?? "",
        NBSEstimator: e.nbsEstimator ?? "",
        GCEstimateLead: e.gcEstimateLead ?? "",
        Region: e.region ?? "",
        PrimaryMarket: e.primaryMarket ?? "",
        Owner: e.owner ?? "",
        DueDate: e.dueDate ?? "",
        ProjectAddress: e.projectAddress ?? "",
        SquareFeet: e.squareFeet ?? "",
        ReviewStatus: e.reviewStatus,
        ProposalStatus: e.proposalStatus ?? "",
        ScopeSections: e.activeScopeLabels.join("; "),
        LineItemCount: e.lineItemCount,
        MaterialCost: e.totals.material,
        Freight: e.totals.freight,
        Escalation: e.totals.escalation,
        Subtotal: e.totals.subtotal,
        Overhead: e.totals.overhead,
        Fee: e.totals.fee,
        Tax: e.totals.tax,
        Bond: e.totals.bond,
        TotalValue: e.totals.totalValue,
        OverheadPct: e.rates.overheadPct,
        FeePct: e.rates.feePct,
        EscalationPct: e.rates.escalationPct,
        TaxPct: e.rates.taxPct,
        BondPct: e.rates.bondPct,
        IsTest: e.isTest,
        CreatedBy: e.createdBy ?? "",
        CreatedAt: e.createdAt,
        UpdatedAt: e.updatedAt,
      });
    } catch (err: any) {
      console.error("[IntegrationAPI] GET /sharepoint-item failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to build the SharePoint item.");
    }
  });

  // ── EXCEL ROWS (fill an existing workbook cell by cell) ──
  app.get(`${p}/estimates/:id/excel-rows`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");
    try {
      const loaded = await loadEstimate(id);
      if (!loaded) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);
      const sheets = buildSheets(loaded);
      const wanted = req.query.sheet ? String(req.query.sheet).toLowerCase() : null;
      const selected = wanted ? sheets.filter(s => s.name.toLowerCase() === wanted) : sheets;
      if (wanted && selected.length === 0) {
        return apiError(res, 404, "SHEET_NOT_FOUND",
          `No sheet named "${req.query.sheet}". Available: ${sheets.map(s => s.name).join(", ")}.`);
      }
      res.json({
        estimateId: id,
        estimateNumber: loaded.estimate.estimateNumber,
        projectName: loaded.estimate.projectName,
        workbookFilename: workbookFilename(loaded),
        generatedAt: new Date().toISOString(),
        sheets: sheetsToJson(selected),
      });
    } catch (err: any) {
      console.error("[IntegrationAPI] GET /excel-rows failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to build the Excel rows.");
    }
  });

  // ── WORKBOOK (the .xlsx file itself) ──
  // Returns raw bytes by default — Power Automate's "Create file" takes the
  // response body straight as file content. ?encoding=base64 returns JSON
  // instead, for connectors that insist on a $content envelope.
  app.get(`${p}/estimates/:id/workbook`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");
    try {
      const loaded = await loadEstimate(id);
      if (!loaded) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);
      const buffer = renderWorkbook(buildSheets(loaded));
      const filename = workbookFilename(loaded);

      if (String(req.query.encoding || "").toLowerCase() === "base64") {
        return res.json({
          filename,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          $content: buffer.toString("base64"),
          byteLength: buffer.length,
        });
      }

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Length", String(buffer.length));
      res.send(buffer);
    } catch (err: any) {
      console.error("[IntegrationAPI] GET /workbook failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to build the workbook.");
    }
  });

  // ── CREATE ──
  app.post(`${p}/estimates`, async (req: Request, res: Response) => {
    const parsed = createEstimateInput.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 422, "VALIDATION_FAILED", "The estimate payload is not valid.", zodDetails(parsed.error));
    }
    const body = parsed.data;

    const bad = unknownScopes([...(body.activeScopes ?? []), ...(body.lineItems ?? []).map(i => i.scopeId)]);
    if (bad.length) {
      return apiError(res, 422, "UNKNOWN_SCOPE",
        `Unrecognized scope id(s): ${bad.join(", ")}. GET ${p}/scopes for the valid list.`,
        { unknownScopes: bad, validScopes: KNOWN_SCOPE_IDS });
    }

    try {
      // An estimate hangs off a proposal log entry — that is where the project
      // facts live. Reuse the one named, or open a draft entry so the estimate
      // still shows up in the Proposal Log for a human to confirm.
      let proposalLogId = body.proposalLogId;
      if (proposalLogId != null) {
        const [entry] = await db.select({ id: proposalLogEntries.id })
          .from(proposalLogEntries).where(eq(proposalLogEntries.id, proposalLogId));
        if (!entry) {
          return apiError(res, 422, "PROPOSAL_LOG_NOT_FOUND",
            `No proposal log entry with id ${proposalLogId}. Omit proposalLogId to have one created.`);
        }
      } else {
        const [entry] = await db.insert(proposalLogEntries).values({
          projectName: body.projectName,
          estimateNumber: body.estimateNumber,
          selfPerformEstimator: body.selfPerformEstimator ?? null,
          nbsEstimator: body.nbsEstimator ?? null,
          gcEstimateLead: body.gcEstimateLead ?? null,
          region: body.region ?? null,
          primaryMarket: body.primaryMarket ?? null,
          dueDate: body.dueDate ?? null,
          projectAddress: body.projectAddress ?? null,
          sourceType: "integration_api",
          isDraft: true,
          isTest: body.isTest ?? false,
        }).returning({ id: proposalLogEntries.id });
        proposalLogId = entry.id;
      }

      // One estimate per proposal log entry. Repeat POSTs return the existing
      // one rather than duplicating, so a retried flow run stays harmless.
      const [existing] = await db.select({ id: estimates.id })
        .from(estimates).where(eq(estimates.proposalLogId, proposalLogId));
      if (existing) {
        await audit(req, "integration_estimate_create_noop", existing.id,
          `Estimate already exists for proposal log ${proposalLogId}`, 200);
        return respondWithEstimate(res, existing.id, 200);
      }

      const [est] = await db.insert(estimates).values({
        proposalLogId,
        estimateNumber: body.estimateNumber,
        projectName: body.projectName,
        activeScopes: body.activeScopes ?? [],
        defaultOh: String(body.rates?.overheadPct ?? 8),
        defaultFee: String(body.rates?.feePct ?? 15),
        defaultEsc: String(body.rates?.escalationPct ?? 0),
        taxRate: String(body.rates?.taxPct ?? 0),
        bondRate: String(body.rates?.bondPct ?? 0),
        assumptions: body.assumptions ?? [],
        risks: body.risks ?? [],
        reviewStatus: body.reviewStatus ?? "drafting",
        isTest: body.isTest ?? false,
        createdBy: body.createdBy ?? `integration:${req.integrationKey?.label ?? "api"}`,
      }).returning();

      if (body.lineItems?.length) {
        await db.insert(estimateLineItems).values(
          body.lineItems.map((i, idx) => toLineItemRow(est.id, i, idx))
        );
      }

      await db.insert(estimateVersions).values({
        estimateId: est.id, version: 1,
        savedBy: body.createdBy ?? `integration:${req.integrationKey?.label ?? "api"}`,
        notes: "Created through the integration API",
        grandTotal: "0",
      });

      await audit(req, "integration_estimate_create", est.id,
        `Created estimate ${est.estimateNumber} — ${est.projectName}`, 201,
        { proposalLogId, lineItemCount: body.lineItems?.length ?? 0 });

      return respondWithEstimate(res, est.id, 201);
    } catch (err: any) {
      console.error("[IntegrationAPI] POST /estimates failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to create the estimate.");
    }
  });

  // ── UPDATE (header + line item sync) ──
  const handleUpdate = async (req: Request, res: Response, isPatch: boolean) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");

    const parsed = updateEstimateInput.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 422, "VALIDATION_FAILED", "The update payload is not valid.", zodDetails(parsed.error));
    }
    const body = parsed.data;

    // PATCH is header-only by contract — line item changes go through PUT or
    // the line item endpoints, so a partial update can never delete rows.
    if (isPatch && body.lineItems) {
      return apiError(res, 400, "LINE_ITEMS_NOT_ALLOWED",
        "PATCH updates estimate fields only. Send line items with PUT, or use the /line-items endpoints.");
    }

    const bad = unknownScopes([
      ...(body.activeScopes ?? []),
      ...(body.lineItems ?? []).map(i => i.scopeId),
      ...Object.keys(body.scopeRateOverrides ?? {}),
    ]);
    if (bad.length) {
      return apiError(res, 422, "UNKNOWN_SCOPE",
        `Unrecognized scope id(s): ${bad.join(", ")}. GET ${p}/scopes for the valid list.`,
        { unknownScopes: bad });
    }

    try {
      const [existing] = await db.select().from(estimates).where(eq(estimates.id, id));
      if (!existing) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (body.estimateNumber !== undefined) updates.estimateNumber = body.estimateNumber;
      if (body.projectName !== undefined) updates.projectName = body.projectName;
      if (body.activeScopes !== undefined) updates.activeScopes = body.activeScopes;
      if (body.assumptions !== undefined) updates.assumptions = body.assumptions;
      if (body.risks !== undefined) updates.risks = body.risks;
      if (body.reviewStatus !== undefined) updates.reviewStatus = body.reviewStatus;
      if (body.isTest !== undefined) updates.isTest = body.isTest;
      if (body.rates?.overheadPct !== undefined) updates.defaultOh = String(body.rates.overheadPct);
      if (body.rates?.feePct !== undefined) updates.defaultFee = String(body.rates.feePct);
      if (body.rates?.escalationPct !== undefined) updates.defaultEsc = String(body.rates.escalationPct);
      if (body.rates?.taxPct !== undefined) updates.taxRate = String(body.rates.taxPct);
      if (body.rates?.bondPct !== undefined) updates.bondRate = String(body.rates.bondPct);
      if (body.scopeRateOverrides !== undefined) {
        const merged = { ...((existing.catOverrides ?? {}) as Record<string, any>) };
        for (const [scopeId, ov] of Object.entries(body.scopeRateOverrides)) {
          const next: Record<string, number> = {};
          if (ov.oh != null) next.oh = ov.oh;
          if (ov.fee != null) next.fee = ov.fee;
          if (ov.esc != null) next.esc = ov.esc;
          if (Object.keys(next).length === 0) delete merged[scopeId];
          else merged[scopeId] = next;
        }
        updates.catOverrides = merged;
      }

      await db.update(estimates).set(updates).where(eq(estimates.id, id));

      let inserted = 0, updated = 0, deleted = 0;
      if (body.lineItems) {
        const current = await db.select({ id: estimateLineItems.id })
          .from(estimateLineItems).where(eq(estimateLineItems.estimateId, id));
        const currentIds = new Set(current.map(r => r.id));

        // Reject ids that belong to a different estimate before writing
        // anything, so a mistyped id cannot move another project's row.
        const claimed = body.lineItems.map(i => i.lineItemId).filter((v): v is number => v != null);
        const foreign = claimed.filter(lid => !currentIds.has(lid));
        if (foreign.length) {
          return apiError(res, 422, "LINE_ITEM_NOT_ON_ESTIMATE",
            `Line item id(s) ${foreign.join(", ")} do not belong to estimate ${id}.`, { lineItemIds: foreign });
        }

        for (let idx = 0; idx < body.lineItems.length; idx++) {
          const item = body.lineItems[idx];
          const row = toLineItemRow(id, item, idx);
          if (item.lineItemId != null) {
            const { estimateId: _ignored, ...fields } = row;
            await db.update(estimateLineItems).set(fields).where(eq(estimateLineItems.id, item.lineItemId));
            updated++;
          } else {
            await db.insert(estimateLineItems).values(row);
            inserted++;
          }
        }

        if (body.lineItemMode === "replace") {
          const keep = new Set(claimed);
          const remove = current.map(r => r.id).filter(lid => !keep.has(lid));
          if (remove.length) {
            await db.delete(estimateBreakoutAllocations).where(inArray(estimateBreakoutAllocations.lineItemId, remove));
            await db.delete(vendorQuoteToEstimateLineItemMap).where(inArray(vendorQuoteToEstimateLineItemMap.estimateLineItemId, remove));
            await db.delete(estimateLineItems).where(inArray(estimateLineItems.id, remove));
            deleted = remove.length;
          }
        }
      }

      await audit(req, "integration_estimate_update", id,
        `Updated estimate ${existing.estimateNumber} (${inserted} added, ${updated} changed, ${deleted} removed)`, 200,
        { lineItemMode: body.lineItemMode, inserted, updated, deleted, updatedBy: body.updatedBy ?? null });

      return respondWithEstimate(res, id, 200);
    } catch (err: any) {
      console.error("[IntegrationAPI] update estimate failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to update the estimate.");
    }
  };

  app.put(`${p}/estimates/:id`, (req, res) => handleUpdate(req, res, false));
  app.patch(`${p}/estimates/:id`, (req, res) => handleUpdate(req, res, true));

  // ── DELETE ──
  // Removes the estimate and every child row. The proposal log entry is left
  // standing — it is the project's record and usually predates the estimate.
  app.delete(`${p}/estimates/:id`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");
    try {
      const [existing] = await db.select().from(estimates).where(eq(estimates.id, id));
      if (!existing) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);

      const quoteIds = (await db.select({ id: estimateQuotes.id })
        .from(estimateQuotes).where(eq(estimateQuotes.estimateId, id))).map(r => r.id);

      if (quoteIds.length) {
        await db.delete(vendorQuoteToEstimateLineItemMap).where(inArray(vendorQuoteToEstimateLineItemMap.quoteId, quoteIds));
        await db.delete(vendorQuoteLineItems).where(inArray(vendorQuoteLineItems.quoteId, quoteIds));
      }
      await db.delete(estimateBreakoutAllocations).where(eq(estimateBreakoutAllocations.estimateId, id));
      await db.delete(estimateBreakoutGroups).where(eq(estimateBreakoutGroups.estimateId, id));
      await db.delete(estimateLineItems).where(eq(estimateLineItems.estimateId, id));
      await db.delete(estimateQuotes).where(eq(estimateQuotes.estimateId, id));
      await db.delete(estimateSpecSections).where(eq(estimateSpecSections.estimateId, id));
      await db.delete(estimateScopeManufacturers).where(eq(estimateScopeManufacturers.estimateId, id));
      await db.delete(estimateReviewComments).where(eq(estimateReviewComments.estimateId, id));
      await db.delete(estimateVersions).where(eq(estimateVersions.estimateId, id));
      await db.delete(ohApprovalLog).where(eq(ohApprovalLog.estimateId, id));
      await db.delete(rfqLog).where(eq(rfqLog.estimateId, id));
      await db.delete(estimates).where(eq(estimates.id, id));

      await audit(req, "integration_estimate_delete", id,
        `Deleted estimate ${existing.estimateNumber} — ${existing.projectName}`, 200,
        { proposalLogId: existing.proposalLogId });

      res.json({
        deleted: true,
        estimateId: id,
        estimateNumber: existing.estimateNumber,
        projectName: existing.projectName,
        proposalLogId: existing.proposalLogId,
        note: "The proposal log entry for this project was kept.",
      });
    } catch (err: any) {
      console.error("[IntegrationAPI] DELETE /estimates/:id failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to delete the estimate.");
    }
  });

  // ── LINE ITEMS ──
  // Single-row endpoints, for a flow reacting to one SharePoint list item
  // changing rather than syncing the whole estimate.

  app.post(`${p}/estimates/:id/line-items`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) return apiError(res, 400, "INVALID_ID", "Estimate id must be a positive integer.");

    const parsed = z.union([lineItemInput, z.object({ lineItems: z.array(lineItemInput).min(1) })])
      .safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 422, "VALIDATION_FAILED", "The line item payload is not valid.", zodDetails(parsed.error));
    }
    const items = "lineItems" in parsed.data ? parsed.data.lineItems : [parsed.data];

    const bad = unknownScopes(items.map(i => i.scopeId));
    if (bad.length) {
      return apiError(res, 422, "UNKNOWN_SCOPE",
        `Unrecognized scope id(s): ${bad.join(", ")}. GET ${p}/scopes for the valid list.`, { unknownScopes: bad });
    }

    try {
      const [existing] = await db.select({ id: estimates.id }).from(estimates).where(eq(estimates.id, id));
      if (!existing) return apiError(res, 404, "ESTIMATE_NOT_FOUND", `No estimate with id ${id}.`);

      // New rows land after whatever is already there.
      const [agg] = await db
        .select({ maxSort: sql<number>`coalesce(max(${estimateLineItems.sortOrder}), 0)::int` })
        .from(estimateLineItems)
        .where(eq(estimateLineItems.estimateId, id));
      const base = agg?.maxSort ?? 0;
      const rows = await db.insert(estimateLineItems)
        .values(items.map((i, idx) => toLineItemRow(id, i, base + idx + 1)))
        .returning({ id: estimateLineItems.id });
      await touch(id);

      await audit(req, "integration_line_item_create", id, `Added ${rows.length} line item(s)`, 201,
        { lineItemIds: rows.map(r => r.id) });

      const loaded = await loadEstimate(id);
      res.status(201).json({
        created: rows.map(r => r.id),
        estimate: loaded ? toSummary(loaded) : null,
      });
    } catch (err: any) {
      console.error("[IntegrationAPI] POST /line-items failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to add the line item(s).");
    }
  });

  app.put(`${p}/estimates/:id/line-items/:itemId`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const itemId = parseId(req.params.itemId);
    if (id == null || itemId == null) return apiError(res, 400, "INVALID_ID", "Ids must be positive integers.");

    const parsed = lineItemPatchInput.safeParse(req.body);
    if (!parsed.success) {
      return apiError(res, 422, "VALIDATION_FAILED", "The line item payload is not valid.", zodDetails(parsed.error));
    }
    const body = parsed.data;
    if (body.scopeId && unknownScopes([body.scopeId]).length) {
      return apiError(res, 422, "UNKNOWN_SCOPE", `Unrecognized scope id "${body.scopeId}".`);
    }

    try {
      const [row] = await db.select().from(estimateLineItems).where(eq(estimateLineItems.id, itemId));
      if (!row) return apiError(res, 404, "LINE_ITEM_NOT_FOUND", `No line item with id ${itemId}.`);
      if (row.estimateId !== id) {
        return apiError(res, 409, "LINE_ITEM_ESTIMATE_MISMATCH",
          `Line item ${itemId} belongs to estimate ${row.estimateId}, not ${id}.`);
      }

      const updates: Record<string, any> = {};
      if (body.scopeId !== undefined) updates.category = body.scopeId;
      if (body.name !== undefined) updates.name = body.name;
      if (body.planCallout !== undefined) updates.planCallout = body.planCallout ?? null;
      if (body.model !== undefined) updates.model = body.model ?? null;
      if (body.manufacturer !== undefined) updates.mfr = body.manufacturer ?? null;
      if (body.qty !== undefined) updates.qty = body.qty;
      if (body.uom !== undefined) updates.uom = body.uom;
      if (body.unitCost !== undefined) updates.unitCost = String(body.unitCost);
      if (body.escalationOverridePct !== undefined) {
        updates.escOverride = body.escalationOverridePct != null ? String(body.escalationOverridePct) : null;
      }
      if (body.quoteId !== undefined) updates.quoteId = body.quoteId ?? null;
      if (body.source !== undefined) updates.source = body.source;
      if (body.note !== undefined) updates.note = body.note ?? null;
      if (body.hasBackup !== undefined) updates.hasBackup = body.hasBackup;
      if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

      if (Object.keys(updates).length === 0) {
        return apiError(res, 400, "NO_FIELDS", "No updatable fields were supplied.");
      }

      await db.update(estimateLineItems).set(updates).where(eq(estimateLineItems.id, itemId));
      await touch(id);

      await audit(req, "integration_line_item_update", id, `Updated line item ${itemId}`, 200,
        { lineItemId: itemId, fields: Object.keys(updates) });

      const loaded = await loadEstimate(id);
      res.json({
        updated: itemId,
        estimate: loaded ? toSummary(loaded) : null,
      });
    } catch (err: any) {
      console.error("[IntegrationAPI] PUT /line-items/:itemId failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to update the line item.");
    }
  });

  app.delete(`${p}/estimates/:id/line-items/:itemId`, async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const itemId = parseId(req.params.itemId);
    if (id == null || itemId == null) return apiError(res, 400, "INVALID_ID", "Ids must be positive integers.");
    try {
      const [row] = await db.select().from(estimateLineItems).where(eq(estimateLineItems.id, itemId));
      if (!row) return apiError(res, 404, "LINE_ITEM_NOT_FOUND", `No line item with id ${itemId}.`);
      if (row.estimateId !== id) {
        return apiError(res, 409, "LINE_ITEM_ESTIMATE_MISMATCH",
          `Line item ${itemId} belongs to estimate ${row.estimateId}, not ${id}.`);
      }
      await db.delete(estimateBreakoutAllocations).where(eq(estimateBreakoutAllocations.lineItemId, itemId));
      await db.delete(vendorQuoteToEstimateLineItemMap).where(eq(vendorQuoteToEstimateLineItemMap.estimateLineItemId, itemId));
      await db.delete(estimateLineItems).where(eq(estimateLineItems.id, itemId));
      await touch(id);

      await audit(req, "integration_line_item_delete", id, `Deleted line item ${itemId} (${row.name})`, 200,
        { lineItemId: itemId });

      const loaded = await loadEstimate(id);
      res.json({ deleted: true, lineItemId: itemId, estimate: loaded ? toSummary(loaded) : null });
    } catch (err: any) {
      console.error("[IntegrationAPI] DELETE /line-items/:itemId failed:", err);
      apiError(res, 500, "INTERNAL_ERROR", "Failed to delete the line item.");
    }
  });

  // ── Catch-all ──
  // A typo'd path inside this prefix answers in the API's own error shape
  // instead of falling through to the SPA's HTML.
  app.use(p, (req: Request, res: Response) => {
    apiError(res, 404, "ENDPOINT_NOT_FOUND",
      `${req.method} ${req.originalUrl.split("?")[0]} is not an endpoint of the AiPM integration API. See docs/INTEGRATION_API.md.`);
  });
}
