import type { Express, Request, Response } from "express";
import { db } from "./db";
import { eq, and, desc, sql } from "drizzle-orm";
import {
  estimates, estimateLineItems, estimateQuotes, estimateBreakoutGroups,
  estimateBreakoutAllocations, estimateVersions, estimateReviewComments, ohApprovalLog,
  proposalLogEntries, estimateSpecSections, users,
  vendorQuoteLineItems, vendorQuoteToEstimateLineItemMap,
  mfrManufacturers, mfrContacts, mfrVendors,
  rfqLog, insertRfqLogSchema,
} from "@shared/schema";
import OpenAI from "openai";
import multer from "multer";
import { extractPdfText } from "./pdfUtils";
import { extractScheduleWithAI } from "./openaiScheduleExtractor";
import { extractScheduleFromText } from "./openaiScheduleExtractor";

const estimateImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
});

const estimatePdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

function handleEstimateImageUpload(req: Request, res: Response, next: Function) {
  estimateImageUpload.array("images", 20)(req, res, (err: any) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: "File too large (max 20MB each)" });
      return res.status(400).json({ message: err.message || "Invalid file upload" });
    }
    next();
  });
}

// ── SCOPE KEYWORD MAPPING for auto-assigning scope to extracted items ──
const SCOPE_KEYWORDS: Record<string, string[]> = {
  accessories: ["grab bar", "towel bar", "towel ring", "robe hook", "wall hook", "coat hook", "utility hook", "soap dispenser", "paper towel", "hand dryer", "waste receptacle", "mirror", "shelf", "shower seat", "sanitary napkin", "seat cover dispenser", "toilet paper holder", "toilet paper dispenser", "toilet tissue dispenser", "toilet tissue holder", "tissue dispenser", "tissue holder", "napkin dispenser", "napkin disposal", "feminine hygiene", "feminine napkin", "paper towel dispenser", "hook strip", "mop holder", "diaper changing station", "baby changing", "changing station", "toilet accessory", "restroom accessory", "bath accessory"],
  partitions: ["partition", "urinal screen", "privacy screen", "pilaster", "panel", "headrail", "overhead braced", "floor mounted", "ceiling hung", "compartment", "stall", "toilet partition", "shower partition"],
  fire_ext: ["fire extinguisher", "fire ext", "fec", "fire cabinet", "fire blanket", "extinguisher cabinet"],
  corner_guards: ["corner guard", "wall guard", "bumper guard", "chair rail", "wall protection", "door protection", "kick plate", "push plate", "pull plate", "crash rail"],
  lockers: ["locker", "storage locker", "employee locker", "gym locker", "phenolic locker"],
  display_boards: ["whiteboard", "markerboard", "tackboard", "bulletin board", "display case", "directory board", "poster frame", "chalkboard", "marker board", "tack board"],
  bike_racks: ["bike rack", "bicycle rack", "bike storage", "bicycle storage"],
  wire_mesh: ["wire mesh", "wire partition", "security partition", "welded wire"],
  cubicle_curtains: ["cubicle curtain", "privacy curtain", "cubicle track", "curtain track"],
  med_equipment: ["medical equipment", "med equipment", "hospital equipment", "clinic equipment"],
  expansion_joints: ["expansion joint", "expansion cover", "seismic joint", "floor joint", "wall joint", "ceiling joint"],
  storage_units: ["shelving", "shelf unit", "storage shelving", "wire shelving", "storage rack", "storage unit"],
  mailboxes: ["mailbox", "mail slot", "package locker", "parcel locker", "postal"],
  flagpoles: ["flagpole", "flag pole", "flag staff"],
  knox_box: ["knox box", "key box", "key cabinet"],
  site_furnishing: ["bench", "picnic table", "bollard", "bike locker", "planter", "site furniture", "outdoor furniture"],
  entrance_mats: ["entrance mat", "entry mat", "floor mat", "walk-off mat", "recessed mat"],
  appliances: ["refrigerator", "dishwasher", "microwave", "oven", "range", "washer", "dryer", "appliance"],
};

// Map CSI code prefixes to scope IDs
const CSI_TO_SCOPE: Record<string, string> = {
  "10 28": "accessories",
  "10 21": "partitions",
  "10 44": "fire_ext",
  "10 26": "corner_guards",
  "10 51": "lockers",
  "10 11": "display_boards",
  "10 73": "bike_racks",
  "10 22 13": "wire_mesh",
  "12 48 00": "cubicle_curtains",
  "10 55": "mailboxes",
  "10 75": "flagpoles",
  "08 71 13": "knox_box",
  "12 93": "site_furnishing",
  "12 48 13": "entrance_mats",
  "11 31": "appliances",
};

// Tag/symbol codes commonly used on plan schedules. Matched with word boundaries
// so codes like "TPDC1", "TPDC-2", "TPDC_3" all hit but substrings inside other
// words do not (e.g. "WR" won't match inside "WRENCH").
const SCOPE_TAG_CODES: Record<string, string[]> = {
  accessories: [
    "tpd", "tpdc", "tph", "tpc",          // toilet paper dispenser/holder/combo
    "snd", "sndc", "snr", "snrc",         // sanitary napkin dispenser/receptacle
    "scd",                                 // seat cover dispenser
    "ptd", "ptdc", "ctd",                 // paper towel dispenser / combo
    "sd", "sdc",                          // soap dispenser
    "hd",                                  // hand dryer
    "gb",                                  // grab bar
    "wr",                                  // waste receptacle
    "bcs", "bcd", "dcs",                  // baby/diaper changing station
    "rh",                                  // robe hook
    "wh",                                  // wall hook
    "ch",                                  // coat hook
    "tb",                                  // towel bar
    "mir",                                 // mirror
  ],
  partitions: ["tp", "tpt", "tc", "us"],   // toilet partition/compartment, urinal screen
  fire_ext: ["fec", "fe"],                 // fire extinguisher cabinet
  corner_guards: ["cg", "wg"],             // corner / wall guard
  lockers: ["lk", "lkr"],
  display_boards: ["mb", "wb", "tk", "bb"],// markerboard, whiteboard, tackboard, bulletin
};

function matchesTagCode(text: string, code: string): boolean {
  // Word-boundary match that allows trailing digits / dashes (e.g. TPDC1, TPDC-2)
  const re = new RegExp(`(^|[^a-z0-9])${code}([^a-z]|$)`, "i");
  return re.test(text);
}

function suggestScope(description: string, mfr: string): { scopeId: string | null; confidence: number } {
  const text = `${description} ${mfr}`.toLowerCase();
  let best: string | null = null;
  let bestScore = 0;

  for (const [scopeId, keywords] of Object.entries(SCOPE_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) {
        score += kw.split(" ").length * 20;
      }
    }
    // Tag/symbol code boost (e.g. "TPDC1" → accessories)
    const codes = SCOPE_TAG_CODES[scopeId] || [];
    for (const code of codes) {
      if (matchesTagCode(text, code)) {
        score += 30;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = scopeId;
    }
  }

  const notDiv10 = ["plumbing", "electrical", "mechanical", "hvac", "sprinkler", "pipe", "duct", "conduit", "receptacle", "outlet", "fixture"].some(w => text.includes(w));
  if (notDiv10 && bestScore < 40) return { scopeId: "not_div10", confidence: 70 };
  if (!best) return { scopeId: null, confidence: 0 };
  return { scopeId: best, confidence: Math.min(95, 50 + bestScore) };
}

function scopeIdToCsi(scopeId: string): string {
  const ALL_SCOPES: Record<string, string> = {
    accessories: "10 28 00", partitions: "10 21 00", fire_ext: "10 44 00",
    corner_guards: "10 26 00", appliances: "11 31 00", lockers: "10 51 00",
    display_boards: "10 11 00", bike_racks: "10 73 00", wire_mesh: "10 22 13",
    cubicle_curtains: "12 48 00", med_equipment: "11 71 00", expansion_joints: "07 95 00",
    storage_units: "10 51 13", equipment: "11 00 00", entrance_mats: "12 48 13",
    mailboxes: "10 55 00", flagpoles: "10 75 00", knox_box: "08 71 13",
    site_furnishing: "12 93 00",
  };
  return ALL_SCOPES[scopeId] || "";
}

// ── SPEC EXTRACTION AI FUNCTION ──
const SPEC_EXTRACT_SYSTEM = `You are a construction specification analyzer specializing in Division 10 specialties. Extract specification sections from construction project documents.

For each Division 10 specification section found, return structured data. Focus ONLY on Division 10 (section numbers starting with "10").

Known Division 10 scope mappings:
- "10 28 00" or "10 28" → scopeId: "accessories" (Toilet Accessories, Restroom Accessories)
- "10 21 00", "10 21 13", "10 21" → scopeId: "partitions" (Toilet Compartments, Toilet Partitions)
- "10 44 00", "10 44" → scopeId: "fire_ext" (Fire Extinguisher Cabinets, Fire Protection Specialties)
- "10 26 00", "10 26" → scopeId: "corner_guards" (Wall and Door Protection, Corner Guards)
- "10 51 00", "10 51" → scopeId: "lockers" (Lockers)
- "10 11 00", "10 11" → scopeId: "display_boards" (Visual Display Boards, Markerboards)
- "10 73 00" → scopeId: "bike_racks" (Bicycle Racks)
- "10 22 13" → scopeId: "wire_mesh" (Wire Mesh Partitions)
- "10 55 00", "10 55" → scopeId: "mailboxes" (Mailboxes)
- "10 75 00" → scopeId: "flagpoles" (Flagpoles)
- "12 93 00", "12 93" → scopeId: "site_furnishing" (Site Furnishings)
- "12 48 13" → scopeId: "entrance_mats" (Entrance Mats)

For each section, extract:
- scopeId: matching ID from the list above (or "other" if not matched)
- csiCode: the section number (e.g., "10 28 00")
- specSectionNumber: exact section number from document
- specSectionTitle: exact title as written
- content: the full specification text for this section (verbatim, may be long)
- manufacturers: array of manufacturer names listed as acceptable (look for "Basis of Design", "Acceptable Manufacturers", "or equal" sections)
- keyRequirements: array of key technical requirements as bullet-point strings (look for material specs, performance requirements, ADA requirements, finish requirements)
- substitutionPolicy: one of "no substitutions", "or equal", "as approved", or "basis of design" based on what the spec states
- confidence: 0-100 extraction confidence
- sourcePages: page numbers or reference where this section was found

Return ONLY valid JSON:
{ "sections": [{ "scopeId": string, "csiCode": string, "specSectionNumber": string, "specSectionTitle": string, "content": string, "manufacturers": string[], "keyRequirements": string[], "substitutionPolicy": string, "confidence": number, "sourcePages": string }] }

If no Division 10 sections are found, return { "sections": [] }.`;

async function extractSpecSectionsFromText(openai: OpenAI, text: string): Promise<any[]> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8000,
    messages: [
      { role: "system", content: SPEC_EXTRACT_SYSTEM },
      { role: "user", content: `Extract Division 10 specification sections from this text:\n\n${text.substring(0, 50000)}` },
    ],
  });
  const content = response.choices[0]?.message?.content || "{}";
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.sections || [];
  } catch {
    return [];
  }
}

async function extractSpecSectionsFromImages(openai: OpenAI, images: { base64: string; mime: string }[]): Promise<any[]> {
  const imageContent: any[] = images.map(img => ({
    type: "image_url",
    image_url: { url: `data:${img.mime};base64,${img.base64}`, detail: "high" },
  }));
  imageContent.push({ type: "text", text: "Extract all Division 10 specification sections from these spec pages. Return ONLY the JSON object." });

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 8000,
    messages: [
      { role: "system", content: SPEC_EXTRACT_SYSTEM },
      { role: "user", content: imageContent },
    ],
  });
  const content = response.choices[0]?.message?.content || "{}";
  try {
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.sections || [];
  } catch {
    return [];
  }
}

/**
 * For large spec books (full bid packs), Division 10 sections are buried deep.
 * This function scans the full PDF text, finds every Division 10 section marker,
 * and returns only those segments (up to ~50 000 chars) for the AI to analyze.
 * Falls back to the first 50 000 chars when no markers are found.
 */
function extractDiv10Segments(fullText: string, maxChars = 50000): string {
  // Match common patterns for Division 10 CSI section numbers and headers
  const div10Markers = [
    /\bDIVISION\s+10\b/gi,
    /\bSECTION\s+10\s*[\d\s]/gi,
    /\b10\s+\d{2}\s+\d{2}\b/g,   // e.g. "10 28 00"
    /\b10\s+\d{2}\s+00\b/g,
    /\b102[1-9]\d{2}\b/g,         // compact: 10280, 10210, etc.
  ];

  const positions: number[] = [];
  for (const pattern of div10Markers) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(fullText)) !== null) {
      positions.push(m.index);
    }
  }

  if (positions.length === 0) {
    // No Division 10 markers found — sample across doc so AI has something to work with
    const len = fullText.length;
    if (len <= maxChars) return fullText;
    const chunk = Math.floor(maxChars / 3);
    return [
      fullText.substring(0, chunk),
      fullText.substring(Math.max(0, Math.floor(len / 2) - Math.floor(chunk / 2)), Math.floor(len / 2) + Math.floor(chunk / 2)),
      fullText.substring(Math.max(0, len - chunk)),
    ].join("\n\n--- (sampled from document) ---\n\n");
  }

  // Sort and build merged segments with context around each match
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const BEFORE = 400;
  const AFTER = 4000;
  const segments: Array<{ start: number; end: number }> = [];

  for (const pos of sorted) {
    const start = Math.max(0, pos - BEFORE);
    const end = Math.min(fullText.length, pos + AFTER);
    const last = segments[segments.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      segments.push({ start, end });
    }
  }

  const parts: string[] = [];
  let total = 0;
  for (const seg of segments) {
    if (total >= maxChars) break;
    const remaining = maxChars - total;
    const chunk = fullText.substring(seg.start, Math.min(seg.end, seg.start + remaining));
    parts.push(chunk);
    total += chunk.length;
  }

  return parts.join("\n\n--- Section Break ---\n\n");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function getFullEstimate(estimateId: number) {
  const [est] = await db.select().from(estimates).where(eq(estimates.id, estimateId));
  if (!est) return null;
  const lineItems = await db.select().from(estimateLineItems).where(eq(estimateLineItems.estimateId, estimateId)).orderBy(estimateLineItems.sortOrder, estimateLineItems.createdAt);
  const quotes = await db.select().from(estimateQuotes).where(eq(estimateQuotes.estimateId, estimateId)).orderBy(estimateQuotes.createdAt);
  const breakoutGroups = await db.select().from(estimateBreakoutGroups).where(eq(estimateBreakoutGroups.estimateId, estimateId)).orderBy(estimateBreakoutGroups.sortOrder);
  const allocations = await db.select().from(estimateBreakoutAllocations).where(eq(estimateBreakoutAllocations.estimateId, estimateId));
  const versions = await db.select().from(estimateVersions).where(eq(estimateVersions.estimateId, estimateId)).orderBy(desc(estimateVersions.version));
  const reviewComments = await db.select().from(estimateReviewComments).where(eq(estimateReviewComments.estimateId, estimateId)).orderBy(estimateReviewComments.createdAt);
  const ohLog = await db.select().from(ohApprovalLog).where(eq(ohApprovalLog.estimateId, estimateId)).orderBy(desc(ohApprovalLog.requestedAt));
  const specSections = await db.select().from(estimateSpecSections).where(eq(estimateSpecSections.estimateId, estimateId));
  return { ...est, lineItems, quotes, breakoutGroups, allocations, versions, reviewComments, ohApprovalLog: ohLog, specSections };
}

export function registerEstimateRoutes(app: Express) {

  // ─── RFQ Log ───
  app.post("/api/rfq-log", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId ?? null;
      const parsed = insertRfqLogSchema.parse({ ...req.body, userId });
      const [row] = await db.insert(rfqLog).values(parsed).returning();
      res.json(row);
    } catch (e: any) {
      res.status(400).json({ message: e?.message || "Invalid RFQ log entry" });
    }
  });

  app.get("/api/rfq-log", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(String(req.query.estimateId || ""));
      const scopeId = String(req.query.scopeId || "");
      if (isNaN(estimateId) || !scopeId) return res.status(400).json({ message: "estimateId and scopeId required" });
      const rows = await db.select().from(rfqLog)
        .where(and(eq(rfqLog.estimateId, estimateId), eq(rfqLog.scopeId, scopeId)))
        .orderBy(desc(rfqLog.sentAt));
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Failed to load RFQ log" });
    }
  });

  // GET — vendor IDs previously used for RFQs on this estimate + scope.
  // Joins rfq_log.recipient_emails (text[]) ↔ mfr_contacts.email (case-insensitive)
  // ↔ mfr_contacts.vendor_id. Read-only; returns [] safely when no matches.
  app.get("/api/estimates/:id/scopes/:scope/rfq-used-vendor-ids", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      const scopeId = String(req.params.scope || "");
      if (isNaN(estimateId) || !scopeId) {
        return res.status(400).json({ message: "Valid estimateId and scope required" });
      }

      const logRows = await db
        .select({ recipientEmails: rfqLog.recipientEmails })
        .from(rfqLog)
        .where(and(eq(rfqLog.estimateId, estimateId), eq(rfqLog.scopeId, scopeId)));

      const emails = new Set<string>();
      for (const row of logRows) {
        for (const e of (row.recipientEmails || [])) {
          const v = (e || "").trim().toLowerCase();
          if (v) emails.add(v);
        }
      }

      if (emails.size === 0) return res.json([]);

      const emailArr = Array.from(emails);
      const matched = await db
        .select({ vendorId: mfrContacts.vendorId })
        .from(mfrContacts)
        .where(sql`LOWER(TRIM(${mfrContacts.email})) = ANY(${emailArr}::text[])`);

      const vendorIds = Array.from(new Set(matched.map(r => r.vendorId).filter((v): v is number => typeof v === "number")));
      res.json(vendorIds);
    } catch (err: any) {
      // Best-effort priority signal — fail safely with [] so the UI just falls back
      // to scope-tag / mfr-tag rank ordering instead of breaking the picker.
      console.error("[rfq-used-vendor-ids GET]", err);
      res.json([]);
    }
  });

  // GET — vendor + manufacturer pairs derived from the RFQ log for an
  // estimate+scope. Used by the New Vendor Quote dropdown to surface "the
  // people we already RFQ'd for this scope" first, and to capture the
  // originating rfq_log_id on the resulting quote so the RFQ Log can show a
  // precise per-row "Quote received" indicator.
  //
  // Returns one entry per (rfq_log row × recipient email):
  //   { rfqLogId, manufacturerName, recipientEmail,
  //     vendorId | null, vendorName | null, sentAt }
  //
  // Recipient email is resolved against mfr_contacts → mfr_vendors. Emails
  // with no contact match are still returned (vendorId/vendorName = null) so
  // the user can still pick the row and tie the quote back to its RFQ.
  // Fails safely with [] on any error.
  app.get("/api/estimates/:id/scopes/:scope/rfq-recipient-pairs", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      const scopeId = String(req.params.scope || "");
      if (isNaN(estimateId) || !scopeId) {
        return res.status(400).json({ message: "Valid estimateId and scope required" });
      }

      const logRows = await db
        .select({
          id: rfqLog.id,
          manufacturerName: rfqLog.manufacturerName,
          recipientEmails: rfqLog.recipientEmails,
          sentAt: rfqLog.sentAt,
        })
        .from(rfqLog)
        .where(and(eq(rfqLog.estimateId, estimateId), eq(rfqLog.scopeId, scopeId)))
        .orderBy(desc(rfqLog.sentAt));

      // Collect the unique set of recipient emails we need to resolve.
      const allEmails = new Set<string>();
      for (const row of logRows) {
        for (const e of (row.recipientEmails || [])) {
          const v = (e || "").trim().toLowerCase();
          if (v) allEmails.add(v);
        }
      }

      // email → { vendorId, vendorName } lookup table.
      const lookup = new Map<string, { vendorId: number; vendorName: string }>();
      if (allEmails.size > 0) {
        const emailArr = Array.from(allEmails);
        const matched = await db
          .select({
            email: mfrContacts.email,
            vendorId: mfrContacts.vendorId,
            vendorName: mfrVendors.name,
          })
          .from(mfrContacts)
          .leftJoin(mfrVendors, eq(mfrContacts.vendorId, mfrVendors.id))
          .where(sql`LOWER(TRIM(${mfrContacts.email})) = ANY(${emailArr}::text[])`);

        for (const m of matched) {
          const key = (m.email || "").trim().toLowerCase();
          if (!key || m.vendorId == null) continue;
          // First win — multiple contacts under one vendor share the same vendor id/name.
          if (!lookup.has(key)) {
            lookup.set(key, { vendorId: m.vendorId, vendorName: m.vendorName || "" });
          }
        }
      }

      // Expand rfqLog rows into one pair per recipient email, dedupe by
      // (rfqLogId, vendorId|email) so the same vendor isn't listed twice when
      // multiple of their contacts received the same RFQ.
      const seen = new Set<string>();
      const pairs: Array<{
        rfqLogId: number;
        manufacturerName: string;
        recipientEmail: string;
        vendorId: number | null;
        vendorName: string | null;
        sentAt: Date;
      }> = [];

      for (const row of logRows) {
        for (const raw of (row.recipientEmails || [])) {
          const email = (raw || "").trim();
          if (!email) continue;
          const lc = email.toLowerCase();
          const hit = lookup.get(lc);
          // Dedupe key: same rfqLog row + same vendor (or same email if no vendor).
          const dedupeKey = `${row.id}::${hit ? `v${hit.vendorId}` : `e${lc}`}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          pairs.push({
            rfqLogId: row.id,
            manufacturerName: row.manufacturerName,
            recipientEmail: email,
            vendorId: hit?.vendorId ?? null,
            vendorName: hit?.vendorName ?? null,
            sentAt: row.sentAt,
          });
        }
      }

      res.json(pairs);
    } catch (err: any) {
      console.error("[rfq-recipient-pairs GET]", err);
      res.json([]);
    }
  });

  // GET /api/proposal-log/entry/:id — get a single proposal log entry
  app.get("/api/proposal-log/entry/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Valid numeric id required" });
      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id));
      if (!entry) return res.status(404).json({ message: "Entry not found" });
      res.json(entry);
    } catch (err) {
      console.error("GET /api/proposal-log/entry/:id error:", err);
      res.status(500).json({ message: "Failed to fetch entry" });
    }
  });

  // GET /api/estimates/by-proposal/:proposalLogId — get or null
  app.get("/api/estimates/by-proposal/:proposalLogId", async (req: Request, res: Response) => {
    try {
      const proposalLogId = parseInt(req.params.proposalLogId);
      if (isNaN(proposalLogId)) return res.status(400).json({ message: "Invalid id" });
      const [est] = await db.select().from(estimates).where(eq(estimates.proposalLogId, proposalLogId));
      if (!est) return res.json(null);
      const full = await getFullEstimate(est.id);
      res.json(full);
    } catch (err) {
      console.error("GET estimates by proposal error:", err);
      res.status(500).json({ message: "Failed to fetch estimate" });
    }
  });

  // GET /api/estimates/:id — full estimate
  app.get("/api/estimates/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const full = await getFullEstimate(id);
      if (!full) return res.status(404).json({ message: "Estimate not found" });
      res.json(full);
    } catch (err) {
      console.error("GET estimate error:", err);
      res.status(500).json({ message: "Failed to fetch estimate" });
    }
  });

  // POST /api/estimates — create estimate
  app.post("/api/estimates", async (req: Request, res: Response) => {
    try {
      const { proposalLogId, estimateNumber, projectName, activeScopes, checklist, assumptions, risks, createdBy } = req.body;
      if (!proposalLogId || !estimateNumber || !projectName) {
        return res.status(400).json({ message: "proposalLogId, estimateNumber, projectName required" });
      }
      const existing = await db.select({ id: estimates.id }).from(estimates).where(eq(estimates.proposalLogId, proposalLogId));
      if (existing.length > 0) {
        const full = await getFullEstimate(existing[0].id);
        return res.status(200).json(full);
      }
      const [est] = await db.insert(estimates).values({
        proposalLogId, estimateNumber, projectName,
        activeScopes: activeScopes || [],
        defaultOh: "8",
        defaultFee: "15",
        checklist: checklist || [],
        assumptions: assumptions || [
          "Pricing assumes delivery to jobsite — no offloading or distribution to floors",
          "All items are FURNISH ONLY — installation by others",
          "Vendor pricing valid through bid due date only",
        ],
        risks: risks || ["Lead times may extend beyond anticipated start date — verify with vendors"],
        createdBy: createdBy || null,
      }).returning();
      await db.insert(estimateVersions).values({ estimateId: est.id, version: 1, savedBy: createdBy || null, notes: "Initial project setup", grandTotal: "0" });
      const full = await getFullEstimate(est.id);
      res.status(201).json(full);
    } catch (err) {
      console.error("POST estimate error:", err);
      res.status(500).json({ message: "Failed to create estimate" });
    }
  });

  // PATCH /api/estimates/:id — update top-level estimate fields
  app.patch("/api/estimates/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      // Determine if the requesting user is an admin
      const userId = (req.session as any)?.userId;
      let isAdminUser = false;
      if (userId) {
        const [requestingUser] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
        isAdminUser = requestingUser?.role === "admin";
      }

      // Build the body, stripping fee-related fields for non-admins
      const body: Record<string, any> = { ...req.body };
      if (!isAdminUser) {
        delete body.defaultFee;
        if (body.catOverrides && typeof body.catOverrides === "object") {
          const cleaned: Record<string, any> = {};
          for (const [catId, ovr] of Object.entries(body.catOverrides)) {
            if (ovr && typeof ovr === "object") {
              const { fee: _fee, ...rest } = ovr as Record<string, any>;
              cleaned[catId] = rest;
            }
          }
          body.catOverrides = cleaned;
        }
      }

      const allowed = ["activeScopes", "defaultOh", "defaultFee", "defaultEsc", "taxRate", "bondRate", "catOverrides", "catComplete", "catQuals", "assumptions", "risks", "checklist", "reviewStatus"];
      const updates: Record<string, any> = { updatedAt: new Date() };
      for (const f of allowed) {
        if (body[f] !== undefined) updates[f] = body[f];
      }
      await db.update(estimates).set(updates).where(eq(estimates.id, id));
      const full = await getFullEstimate(id);
      res.json(full);
    } catch (err: any) {
      console.error("PATCH estimate error:", err);
      res.status(500).json({ message: "Failed to update estimate", detail: err?.message || String(err) });
    }
  });

  // POST /api/estimates/:id/save-version — save a version snapshot
  app.post("/api/estimates/:id/save-version", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
      const { savedBy, notes, grandTotal, snapshotData } = req.body;
      const versionRows = await db.select({ version: estimateVersions.version }).from(estimateVersions).where(eq(estimateVersions.estimateId, id)).orderBy(desc(estimateVersions.version));
      const nextVersion = (versionRows[0]?.version || 0) + 1;
      await db.insert(estimateVersions).values({ estimateId: id, version: nextVersion, savedBy, notes, grandTotal: String(grandTotal || 0), snapshotData: snapshotData || null });
      await db.update(estimates).set({ updatedAt: new Date() }).where(eq(estimates.id, id));
      const full = await getFullEstimate(id);
      res.json(full);
    } catch (err) {
      console.error("POST save-version error:", err);
      res.status(500).json({ message: "Failed to save version" });
    }
  });

  // ── LINE ITEMS ──

  app.post("/api/estimates/:id/line-items", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { category, planCallout, name, model, mfr, manufacturerId, qty, uom, unitCost, escOverride, quoteId, source, note, hasBackup, sortOrder, extractionConfidence } = req.body;
      if (!category || !name) return res.status(400).json({ message: "category and name required" });
      const [item] = await db.insert(estimateLineItems).values({
        estimateId, category, planCallout: planCallout || null, name, model: model || null, mfr: mfr || null,
        manufacturerId: manufacturerId ?? null,
        qty: qty || 1, uom: uom || "EA", unitCost: String(unitCost || 0),
        escOverride: escOverride != null ? String(escOverride) : null,
        quoteId: quoteId || null, source: source || "manual",
        note: note || null, hasBackup: hasBackup || false, sortOrder: sortOrder || 0,
        extractionConfidence: extractionConfidence || null,
      }).returning();
      res.status(201).json(item);
    } catch (err) {
      console.error("POST line item error:", err);
      res.status(500).json({ message: "Failed to create line item" });
    }
  });

  app.patch("/api/estimates/line-items/:itemId", async (req: Request, res: Response) => {
    try {
      const itemId = parseInt(req.params.itemId);
      if (isNaN(itemId)) return res.status(400).json({ message: "Invalid item id" });
      const allowed = ["name", "planCallout", "model", "mfr", "manufacturerId", "qty", "uom", "unitCost", "escOverride", "quoteId", "source", "note", "hasBackup", "sortOrder", "category", "extractionConfidence"];
      const updates: Record<string, any> = {};
      for (const f of allowed) {
        if (req.body[f] !== undefined) {
          if (f === "unitCost") {
            // unit_cost is NOT NULL with default 0 — coerce empty/null to "0"
            // so the column never receives "" (which Postgres rejects as numeric).
            const raw = req.body[f];
            const str = raw == null ? "" : String(raw).trim();
            updates[f] = str === "" ? "0" : str;
          } else if (f === "escOverride") {
            // esc_override is nullable — empty / null clears the override.
            const raw = req.body[f];
            const str = raw == null ? "" : String(raw).trim();
            updates[f] = str === "" ? null : str;
          } else {
            updates[f] = req.body[f];
          }
        }
      }
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: "No valid fields to update" });
      const [item] = await db.update(estimateLineItems).set(updates).where(eq(estimateLineItems.id, itemId)).returning();
      if (!item) return res.status(404).json({ message: "Line item not found" });
      res.json(item);
    } catch (err) {
      console.error("PATCH line item error:", err);
      res.status(500).json({ message: "Failed to update line item" });
    }
  });

  app.delete("/api/estimates/line-items/:itemId", async (req: Request, res: Response) => {
    try {
      const itemId = parseInt(req.params.itemId);
      if (isNaN(itemId)) return res.status(400).json({ message: "Invalid item id" });
      await db.delete(estimateLineItems).where(eq(estimateLineItems.id, itemId));
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE line item error:", err);
      res.status(500).json({ message: "Failed to delete line item" });
    }
  });

  // Bulk line item operations
  app.post("/api/estimates/:id/line-items/bulk", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "items array required" });
      const rows = items.map((item: any, idx: number) => ({
        estimateId, category: item.category, name: item.name,
        model: item.model || null, mfr: item.mfr || null,
        manufacturerId: item.manufacturerId ?? null,
        qty: item.qty || 1, unitCost: String(item.unitCost || 0),
        escOverride: item.escOverride != null ? String(item.escOverride) : null,
        quoteId: item.quoteId || null, source: item.source || "vendor_quote",
        note: item.note || null, hasBackup: item.hasBackup ?? false, sortOrder: idx,
      }));
      const inserted = await db.insert(estimateLineItems).values(rows).returning();
      res.status(201).json(inserted);
    } catch (err) {
      console.error("POST bulk line items error:", err);
      res.status(500).json({ message: "Failed to bulk insert line items" });
    }
  });

  // ── QUOTES ──

  app.post("/api/estimates/:id/quotes", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { category, vendor, note, freight, taxIncluded, pricingMode, lumpSumTotal, breakoutGroupId, hasBackup, materialTotalCost } = req.body;
      if (!category || !vendor) return res.status(400).json({ message: "category and vendor required" });
      const [quote] = await db.insert(estimateQuotes).values({
        estimateId, category, vendor, note: note || null,
        freight: String(freight || 0), taxIncluded: taxIncluded || false,
        pricingMode: pricingMode || "per_item", lumpSumTotal: String(lumpSumTotal || 0),
        breakoutGroupId: breakoutGroupId || null, hasBackup: hasBackup || false,
        materialTotalCost: materialTotalCost != null && materialTotalCost !== "" ? String(materialTotalCost) : null,
      }).returning();
      res.status(201).json(quote);
    } catch (err) {
      console.error("POST quote error:", err);
      res.status(500).json({ message: "Failed to create quote" });
    }
  });

  app.patch("/api/estimates/quotes/:quoteId", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
      const allowed = ["vendor", "note", "freight", "taxIncluded", "pricingMode", "lumpSumTotal", "breakoutGroupId", "hasBackup", "filePath", "materialTotalCost"];
      const updates: Record<string, any> = {};
      for (const f of allowed) {
        if (req.body[f] !== undefined) {
          if (f === "freight" || f === "lumpSumTotal") updates[f] = String(req.body[f]);
          else if (f === "materialTotalCost") updates[f] = req.body[f] != null && req.body[f] !== "" ? String(req.body[f]) : null;
          else updates[f] = req.body[f];
        }
      }
      const [quote] = await db.update(estimateQuotes).set(updates).where(eq(estimateQuotes.id, quoteId)).returning();
      res.json(quote);
    } catch (err) {
      console.error("PATCH quote error:", err);
      res.status(500).json({ message: "Failed to update quote" });
    }
  });

  app.delete("/api/estimates/quotes/:quoteId", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
      // Reset hasBackup on any line items linked to this quote — the documented
      // backup is going away with the quote, so the indicator should flip back
      // to "missing backup" until a new quote/file is attached.
      await db.update(estimateLineItems)
        .set({ hasBackup: false })
        .where(eq(estimateLineItems.quoteId, quoteId));
      await db.delete(estimateQuotes).where(eq(estimateQuotes.id, quoteId));
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE quote error:", err);
      res.status(500).json({ message: "Failed to delete quote" });
    }
  });

  // ── QUOTE MATERIAL TOTAL EXTRACTION ──

  app.post("/api/estimates/quotes/extract-total",
    (req, res, next) => estimateImageUpload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message || "Invalid file" });
      next();
    }),
    async (req: Request, res: Response) => {
      try {
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) return res.status(400).json({ message: "File required" });

        let materialTotalCost: number | null = null;

        let vendor: string | null = null;

        if (file.mimetype === "application/pdf") {
          const extracted = await extractPdfText(file.buffer);
          const text = extracted.text || "";
          if (text.trim().length >= 10) {
            const response = await openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: [
                { role: "system", content: `You extract key fields from a vendor quote document for construction materials.
Respond ONLY with valid JSON:
{"materialTotalCost": number_or_null, "vendor": string_or_null}

Rules:
- materialTotalCost: Look for a grand total, net total, subtotal, or total line. If none exists but individual line item prices are present, SUM all "Net Price" values to get the total. Return a number, never null if prices are visible.
- vendor: The company NAME that issued the quote (not the customer). Look for company name near the top, letterhead, or "Quoted By" / "Company" field.
- Return null only if truly not determinable.` },
                { role: "user", content: `Extract vendor name and total material cost from this quote:\n\n${text.trim().slice(0, 8000)}` },
              ],
              response_format: { type: "json_object" },
              max_tokens: 150,
            });
            const parsed = JSON.parse(response.choices[0].message.content || "{}");
            if (typeof parsed.materialTotalCost === "number" && parsed.materialTotalCost > 0) {
              materialTotalCost = parsed.materialTotalCost;
            }
            if (typeof parsed.vendor === "string" && parsed.vendor.trim()) {
              vendor = parsed.vendor.trim();
            }
          }
        } else if (file.mimetype.startsWith("image/")) {
          const base64 = file.buffer.toString("base64");
          const dataUrl = `data:${file.mimetype};base64,${base64}`;
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              { role: "system", content: `You extract key fields from a vendor quote document image.
Respond ONLY with valid JSON:
{"materialTotalCost": number_or_null, "vendor": string_or_null}

Rules:
- materialTotalCost: Grand total, net total, or sum of line items. Return a number if any prices are visible.
- vendor: Company name that issued the quote.` },
              { role: "user", content: [
                { type: "text", text: "Extract vendor name and total material cost from this quote image:" },
                { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
              ]},
            ],
            response_format: { type: "json_object" },
            max_tokens: 150,
          });
          const parsed = JSON.parse(response.choices[0].message.content || "{}");
          if (typeof parsed.materialTotalCost === "number" && parsed.materialTotalCost > 0) {
            materialTotalCost = parsed.materialTotalCost;
          }
          if (typeof parsed.vendor === "string" && parsed.vendor.trim()) {
            vendor = parsed.vendor.trim();
          }
        }

        res.json({ materialTotalCost, vendor });
      } catch (err) {
        console.error("extract-total error:", err);
        res.json({ materialTotalCost: null });
      }
    }
  );

  // ── QUOTE BACKUP FILE UPLOAD / DOWNLOAD ──

  app.post("/api/estimates/quotes/:quoteId/backup-file",
    (req, res, next) => estimateImageUpload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message || "Invalid file" });
      next();
    }),
    async (req: Request, res: Response) => {
      try {
        const quoteId = parseInt(req.params.quoteId);
        if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
        const multerReq = req as Request & { file?: Express.Multer.File };
        if (!multerReq.file) return res.status(400).json({ message: "No file uploaded" });
        const [quote] = await db.update(estimateQuotes).set({
          backupFileData: multerReq.file.buffer,
          backupMimeType: multerReq.file.mimetype,
          filePath: multerReq.file.originalname,
          hasBackup: true,
        }).where(eq(estimateQuotes.id, quoteId)).returning();
        const { backupFileData: _ignored, ...safeQuote } = quote;
        res.json(safeQuote);
      } catch (err) {
        console.error("POST quote backup error:", err);
        res.status(500).json({ message: "Failed to upload quote backup" });
      }
    }
  );

  app.get("/api/estimates/quotes/:quoteId/backup-file", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
      const [quote] = await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, quoteId));
      if (!quote || !quote.backupFileData) return res.status(404).json({ message: "No backup file found" });
      const mime = quote.backupMimeType || "application/octet-stream";
      const filename = quote.filePath || "backup";
      res.setHeader("Content-Type", mime);
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      res.send(quote.backupFileData);
    } catch (err) {
      console.error("GET quote backup error:", err);
      res.status(500).json({ message: "Failed to download quote backup" });
    }
  });

  app.delete("/api/estimates/quotes/:quoteId/backup-file", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
      const [quote] = await db.update(estimateQuotes).set({
        backupFileData: null,
        backupMimeType: null,
        filePath: null,
        hasBackup: false,
      }).where(eq(estimateQuotes.id, quoteId)).returning();
      const { backupFileData: _ignored, ...safeQuote } = quote;
      res.json(safeQuote);
    } catch (err) {
      console.error("DELETE quote backup error:", err);
      res.status(500).json({ message: "Failed to remove quote backup" });
    }
  });

  // ── VENDOR QUOTE AI EXTRACTION ──

  app.post("/api/estimates/quotes/:quoteId/process", async (req: Request, res: Response) => {
    const quoteId = parseInt(req.params.quoteId);
    if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
    try {
      console.log("[VendorQuoteProcess] start", {
        quoteId,
        userId: (req.session as any)?.userId || null,
      });
      const [quote] = await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, quoteId));
      if (!quote) {
        console.log("[VendorQuoteProcess] quote not found", { quoteId });
        return res.status(404).json({ message: "Quote not found" });
      }
      if (!quote.backupFileData) {
        console.log("[VendorQuoteProcess] missing backup file", { quoteId, mime: quote.backupMimeType || null });
        return res.status(400).json({ message: "No PDF file uploaded for this quote" });
      }

      await db.update(estimateQuotes).set({ status: "processing", latestError: null }).where(eq(estimateQuotes.id, quoteId));

      let pdfText = "";
      let pdfPages = 0;
      try {
        if (quote.backupMimeType === "application/pdf") {
          const extracted = await extractPdfText(quote.backupFileData as Buffer);
          pdfText = extracted.text || "";
          pdfPages = extracted.numpages || 0;
        }
      } catch (pdfErr: any) {
        console.log("[VendorQuoteProcess] pdf text extraction failed", {
          quoteId,
          mime: quote.backupMimeType || null,
          message: pdfErr?.message || String(pdfErr),
        });
        await db.update(estimateQuotes).set({
          status: "failed",
          latestError: `PDF text extraction failed: ${pdfErr?.message || "Unknown error"}`,
          processingMetadataJson: { mime: quote.backupMimeType || null, pdfPages, textLength: 0 },
        }).where(eq(estimateQuotes.id, quoteId));
        return res.status(422).json({
          message: "PDF text extraction failed",
          error: pdfErr?.message || "Unknown error",
          code: "PDF_TEXT_EXTRACTION_FAILED",
        });
      }

      console.log("[VendorQuoteProcess] pdf extracted", {
        quoteId,
        mime: quote.backupMimeType || null,
        pdfPages,
        textLength: pdfText.length,
      });

      if (quote.backupMimeType === "application/pdf" && pdfText.trim().length < 20) {
        const message = "This PDF does not contain extractable text. Scanned/image PDFs are not supported in this V1 flow.";
        console.log("[VendorQuoteProcess] non-text pdf detected", { quoteId, pdfPages, textLength: pdfText.length });
        await db.update(estimateQuotes).set({
          status: "needs_review",
          latestError: message,
          processingMetadataJson: { mime: quote.backupMimeType || null, pdfPages, textLength: pdfText.length, parsed: false },
        }).where(eq(estimateQuotes.id, quoteId));
        return res.status(422).json({ message, code: "SCANNED_PDF_NOT_SUPPORTED" });
      }

      let aiResult: any = null;
      try {
        console.log("[VendorQuoteProcess] ai extraction start", { quoteId, hasText: pdfText.trim().length >= 20 });
        const systemPrompt = `You are an expert at extracting structured line item data from vendor quotes for Division 10 construction materials (FURNISH ONLY — no labor/installation).
Extract the following from the quote document:
1. Header: vendor name (if different from file), quote number, quote date, grand total, notes
2. Line items array — for each row extract: description, part_number (if present), qty (number), unit (EA/LF/SF etc), unit_cost (number), extended_cost (number), notes
3. For each line item, assign a confidence score 0-1 based on how complete and clear the data is:
   - 1.0 = description + qty + unit_cost clearly present
   - 0.7-0.9 = mostly complete, minor ambiguity
   - 0.4-0.6 = description present but cost missing or ambiguous
   - 0.0-0.3 = very incomplete

Respond ONLY with valid JSON:
{
  "header": { "vendor": string|null, "quoteNumber": string|null, "quoteDate": string|null, "grandTotal": number|null, "notes": string|null },
  "lineItems": [{ "description": string, "partNumber": string|null, "qty": number|null, "unit": string|null, "unitCost": number|null, "extendedCost": number|null, "confidence": number, "notes": string|null }],
  "quoteConfidence": number
}`;

        const messages: any[] = [{ role: "system", content: systemPrompt }];
        if (pdfText && pdfText.trim().length >= 20) {
          messages.push({ role: "user", content: `Extract line items from this vendor quote:\n\n${pdfText.trim().slice(0, 12000)}` });
          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
            response_format: { type: "json_object" },
            max_tokens: 4000,
          });
          aiResult = JSON.parse(response.choices[0].message.content || "{}");
        } else if (quote.backupMimeType?.startsWith("image/")) {
          const base64 = (quote.backupFileData as Buffer).toString("base64");
          const dataUrl = `data:${quote.backupMimeType};base64,${base64}`;
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: [
                { type: "text", text: "Extract line items from this vendor quote image:" },
                { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
              ]},
            ],
            response_format: { type: "json_object" },
            max_tokens: 4000,
          });
          aiResult = JSON.parse(response.choices[0].message.content || "{}");
        } else {
          throw new Error("Could not extract text from PDF and file is not an image");
        }
      } catch (aiErr: any) {
        console.log("[VendorQuoteProcess] ai extraction failed", {
          quoteId,
          message: aiErr?.message || String(aiErr),
        });
        await db.update(estimateQuotes).set({
          status: "failed",
          latestError: aiErr?.message || "AI extraction failed",
        }).where(eq(estimateQuotes.id, quoteId));
        return res.status(500).json({ message: "AI extraction failed", error: aiErr?.message });
      }

      const lineItems: any[] = Array.isArray(aiResult?.lineItems) ? aiResult.lineItems : [];
      const quoteConfidence: number = typeof aiResult?.quoteConfidence === "number" ? aiResult.quoteConfidence : 0.5;

      const CONFIDENCE_THRESHOLD = 0.6;
      const hasIncomplete = lineItems.some((li: any) =>
        !li.description || (li.unitCost == null && li.extendedCost == null)
      );
      const newStatus = (lineItems.length === 0 || quoteConfidence < CONFIDENCE_THRESHOLD || hasIncomplete)
        ? "needs_review"
        : "ready_for_approval";

      await db.delete(vendorQuoteLineItems).where(eq(vendorQuoteLineItems.quoteId, quoteId));
      if (lineItems.length > 0) {
        console.log("[VendorQuoteProcess] writing extracted rows", { quoteId, rowCount: lineItems.length, status: newStatus });
        await db.insert(vendorQuoteLineItems).values(
          lineItems.map((li: any, idx: number) => ({
            quoteId,
            sortOrder: idx,
            description: li.description || null,
            partNumber: li.partNumber || null,
            qty: li.qty != null ? String(li.qty) : null,
            unit: li.unit || null,
            unitCost: li.unitCost != null ? String(li.unitCost) : null,
            extendedCost: li.extendedCost != null ? String(li.extendedCost) : null,
            confidence: String(li.confidence ?? 0.5),
            notes: li.notes || null,
            isApproved: false,
          }))
        );
      }

      await db.update(estimateQuotes).set({
        status: newStatus,
        latestExtractionJson: aiResult.header || null,
        processingMetadataJson: { quoteConfidence, rowCount: lineItems.length },
        latestError: null,
      }).where(eq(estimateQuotes.id, quoteId));

      const [updatedQuote] = await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, quoteId));
      const { backupFileData: _bd, ...safeQuote } = updatedQuote;
      res.json({ quote: safeQuote, lineItemCount: lineItems.length, quoteConfidence, status: newStatus });
    } catch (err) {
      console.error("process quote error:", err);
      await db.update(estimateQuotes).set({ status: "failed", latestError: String(err) }).where(eq(estimateQuotes.id, quoteId));
      res.status(500).json({ message: "Processing failed" });
    }
  });

  app.get("/api/estimates/quotes/:quoteId/line-items", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
      const items = await db.select().from(vendorQuoteLineItems)
        .where(eq(vendorQuoteLineItems.quoteId, quoteId))
        .orderBy(vendorQuoteLineItems.sortOrder);
      res.json(items);
    } catch (err) {
      console.error("GET quote line-items error:", err);
      res.status(500).json({ message: "Failed to fetch line items" });
    }
  });

  app.patch("/api/estimates/quotes/:quoteId/line-items/:itemId", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      const itemId = parseInt(req.params.itemId);
      if (isNaN(quoteId) || isNaN(itemId)) return res.status(400).json({ message: "Invalid id" });
      const allowed = ["description", "partNumber", "qty", "unit", "unitCost", "extendedCost", "notes", "isApproved"];
      const updates: Record<string, any> = {};
      for (const f of allowed) {
        if (req.body[f] !== undefined) {
          if (["qty", "unitCost", "extendedCost"].includes(f)) {
            updates[f] = req.body[f] != null && req.body[f] !== "" ? String(req.body[f]) : null;
          } else {
            updates[f] = req.body[f];
          }
        }
      }
      const [item] = await db.update(vendorQuoteLineItems).set(updates)
        .where(and(eq(vendorQuoteLineItems.id, itemId), eq(vendorQuoteLineItems.quoteId, quoteId)))
        .returning();
      res.json(item);
    } catch (err) {
      console.error("PATCH quote line-item error:", err);
      res.status(500).json({ message: "Failed to update line item" });
    }
  });

  app.post("/api/estimates/quotes/:quoteId/approve", async (req: Request, res: Response) => {
    try {
      const quoteId = parseInt(req.params.quoteId);
      if (isNaN(quoteId)) return res.status(400).json({ message: "Invalid quote id" });
      const [quote] = await db.select().from(estimateQuotes).where(eq(estimateQuotes.id, quoteId));
      if (!quote) return res.status(404).json({ message: "Quote not found" });
      const { approvedIds } = req.body;
      const rows = await db.select().from(vendorQuoteLineItems)
        .where(eq(vendorQuoteLineItems.quoteId, quoteId));
      const toApprove = Array.isArray(approvedIds) && approvedIds.length > 0
        ? rows.filter(r => approvedIds.includes(r.id))
        : rows;

      const n = (v: any) => parseFloat(v) || 0;
      let createdCount = 0;
      for (const row of toApprove) {
        const existingMap = await db.select().from(vendorQuoteToEstimateLineItemMap)
          .where(and(
            eq(vendorQuoteToEstimateLineItemMap.quoteId, quoteId),
            eq(vendorQuoteToEstimateLineItemMap.vendorQuoteLineItemId, row.id)
          ));
        if (existingMap.length > 0) {
          await db.update(estimateLineItems).set({
            description: row.description || "",
            qty: row.qty != null ? n(row.qty) : 1,
            unitCost: row.unitCost != null ? String(n(row.unitCost)) : "0",
            unit: row.unit || "EA",
          }).where(eq(estimateLineItems.id, existingMap[0].estimateLineItemId));
        } else {
          const [newItem] = await db.insert(estimateLineItems).values({
            estimateId: quote.estimateId,
            category: quote.category,
            description: row.description || "(from vendor quote)",
            qty: row.qty != null ? n(row.qty) : 1,
            unit: row.unit || "EA",
            unitCost: row.unitCost != null ? String(n(row.unitCost)) : "0",
            quoteId: quote.id,
            hasBackup: true,
            source: "vendor_quote",
          }).returning();
          await db.insert(vendorQuoteToEstimateLineItemMap).values({
            quoteId,
            vendorQuoteLineItemId: row.id,
            estimateLineItemId: newItem.id,
          });
          createdCount++;
        }
        await db.update(vendorQuoteLineItems).set({ isApproved: true }).where(eq(vendorQuoteLineItems.id, row.id));
      }
      await db.update(estimateQuotes).set({ status: "approved" }).where(eq(estimateQuotes.id, quoteId));
      res.json({ success: true, createdCount, quoteId });
    } catch (err) {
      console.error("approve quote error:", err);
      res.status(500).json({ message: "Approval failed" });
    }
  });

  // ── BREAKOUT GROUPS ──

  app.post("/api/estimates/:id/breakout-groups", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { code, label, type, sortOrder } = req.body;
      if (!code || !label) return res.status(400).json({ message: "code and label required" });
      const [group] = await db.insert(estimateBreakoutGroups).values({
        estimateId, code: code.toUpperCase(), label, type: type || "building", sortOrder: sortOrder || 0,
      }).returning();
      res.status(201).json(group);
    } catch (err) {
      console.error("POST breakout group error:", err);
      res.status(500).json({ message: "Failed to create breakout group" });
    }
  });

  app.patch("/api/estimates/breakout-groups/:groupId", async (req: Request, res: Response) => {
    try {
      const groupId = parseInt(req.params.groupId);
      if (isNaN(groupId)) return res.status(400).json({ message: "Invalid group id" });

      // Determine if the requesting user is an admin
      const userId = (req.session as any)?.userId;
      let isAdminUser = false;
      if (userId) {
        const [requestingUser] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
        isAdminUser = requestingUser?.role === "admin";
      }

      // Non-admins cannot change feeOverride
      const allowed = ["code", "label", "type", "ohOverride", "feeOverride", "escOverride", "freightMethod", "manualFreight", "sortOrder"];
      const effectiveAllowed = isAdminUser ? allowed : allowed.filter(f => f !== "feeOverride");

      const updates: Record<string, any> = {};
      for (const f of effectiveAllowed) {
        if (req.body[f] !== undefined) {
          if (["ohOverride", "feeOverride", "escOverride", "manualFreight"].includes(f)) {
            updates[f] = req.body[f] != null ? String(req.body[f]) : null;
          } else {
            updates[f] = req.body[f];
          }
        }
      }
      const [group] = await db.update(estimateBreakoutGroups).set(updates).where(eq(estimateBreakoutGroups.id, groupId)).returning();
      res.json(group);
    } catch (err) {
      console.error("PATCH breakout group error:", err);
      res.status(500).json({ message: "Failed to update breakout group" });
    }
  });

  app.delete("/api/estimates/breakout-groups/:groupId", async (req: Request, res: Response) => {
    try {
      const groupId = parseInt(req.params.groupId);
      if (isNaN(groupId)) return res.status(400).json({ message: "Invalid group id" });
      await db.delete(estimateBreakoutAllocations).where(eq(estimateBreakoutAllocations.breakoutGroupId, groupId));
      await db.delete(estimateBreakoutGroups).where(eq(estimateBreakoutGroups.id, groupId));
      res.json({ ok: true });
    } catch (err) {
      console.error("DELETE breakout group error:", err);
      res.status(500).json({ message: "Failed to delete breakout group" });
    }
  });

  // ── BREAKOUT ALLOCATIONS ──

  app.post("/api/estimates/:id/allocations", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { lineItemId, breakoutGroupId, qty } = req.body;
      if (!lineItemId || !breakoutGroupId) return res.status(400).json({ message: "lineItemId and breakoutGroupId required" });
      const existing = await db.select().from(estimateBreakoutAllocations).where(
        and(eq(estimateBreakoutAllocations.lineItemId, lineItemId), eq(estimateBreakoutAllocations.breakoutGroupId, breakoutGroupId))
      );
      if (existing.length > 0) {
        const [alloc] = await db.update(estimateBreakoutAllocations).set({ qty: qty || 0 }).where(eq(estimateBreakoutAllocations.id, existing[0].id)).returning();
        return res.json(alloc);
      }
      const [alloc] = await db.insert(estimateBreakoutAllocations).values({ estimateId, lineItemId, breakoutGroupId, qty: qty || 0 }).returning();
      res.status(201).json(alloc);
    } catch (err) {
      console.error("POST allocation error:", err);
      res.status(500).json({ message: "Failed to upsert allocation" });
    }
  });

  // Bulk allocation sync (replaces all allocations for an estimate with the provided data)
  app.post("/api/estimates/:id/allocations/bulk", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { allocations } = req.body;
      if (!Array.isArray(allocations)) return res.status(400).json({ message: "allocations array required" });
      await db.delete(estimateBreakoutAllocations).where(eq(estimateBreakoutAllocations.estimateId, estimateId));
      if (allocations.length > 0) {
        await db.insert(estimateBreakoutAllocations).values(
          allocations.map((a: any) => ({ estimateId, lineItemId: a.lineItemId, breakoutGroupId: a.breakoutGroupId, qty: a.qty || 0 }))
        );
      }
      res.json({ ok: true, count: allocations.length });
    } catch (err) {
      console.error("POST bulk allocations error:", err);
      res.status(500).json({ message: "Failed to sync allocations" });
    }
  });

  // ── REVIEW COMMENTS ──

  app.post("/api/estimates/:id/comments", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { author, comment } = req.body;
      if (!author || !comment) return res.status(400).json({ message: "author and comment required" });
      const [c] = await db.insert(estimateReviewComments).values({ estimateId, author, comment }).returning();
      res.status(201).json(c);
    } catch (err) {
      console.error("POST comment error:", err);
      res.status(500).json({ message: "Failed to create comment" });
    }
  });

  app.patch("/api/estimates/comments/:commentId", async (req: Request, res: Response) => {
    try {
      const commentId = parseInt(req.params.commentId);
      if (isNaN(commentId)) return res.status(400).json({ message: "Invalid comment id" });
      const [c] = await db.update(estimateReviewComments).set({ resolved: req.body.resolved }).where(eq(estimateReviewComments.id, commentId)).returning();
      res.json(c);
    } catch (err) {
      console.error("PATCH comment error:", err);
      res.status(500).json({ message: "Failed to update comment" });
    }
  });

  // ── OH APPROVAL ──

  app.post("/api/estimates/:id/oh-approval", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { catId, catLabel, oldRate, newRate, requestedBy, type } = req.body;
      const [log] = await db.insert(ohApprovalLog).values({
        estimateId, catId, catLabel: catLabel || catId,
        oldRate: String(oldRate || 0), newRate: String(newRate || 0),
        requestedBy: requestedBy || null, status: "pending",
        type: type === "fee" ? "fee" : "oh",
      }).returning();
      await db.update(estimates).set({ updatedAt: new Date() }).where(eq(estimates.id, estimateId));
      res.status(201).json(log);
    } catch (err) {
      console.error("POST oh-approval error:", err);
      res.status(500).json({ message: "Failed to log OH approval request" });
    }
  });

  app.patch("/api/estimates/oh-approval/:logId", async (req: Request, res: Response) => {
    try {
      const logId = parseInt(req.params.logId);
      if (isNaN(logId)) return res.status(400).json({ message: "Invalid log id" });
      const { status, approvedBy } = req.body;
      const [log] = await db.update(ohApprovalLog).set({ status, approvedBy: approvedBy || null, approvedAt: new Date() }).where(eq(ohApprovalLog.id, logId)).returning();

      // If approved, apply the override to the estimate
      if (status === "approved") {
        const [entry] = await db.select().from(ohApprovalLog).where(eq(ohApprovalLog.id, logId));
        if (entry) {
          const [est] = await db.select().from(estimates).where(eq(estimates.id, entry.estimateId));
          if (est) {
            const catOverrides = (est.catOverrides as any) || {};
            const field = (entry as any).type === "fee" ? "fee" : "oh";
            catOverrides[entry.catId] = { ...catOverrides[entry.catId], [field]: parseFloat(entry.newRate || "0") };
            await db.update(estimates).set({ catOverrides, updatedAt: new Date() }).where(eq(estimates.id, entry.estimateId));
          }
        }
      }
      res.json(log);
    } catch (err) {
      console.error("PATCH oh-approval error:", err);
      res.status(500).json({ message: "Failed to update OH approval" });
    }
  });

  // ── AI QUOTE PARSER ──

  app.post("/api/estimates/ai/parse-quote", async (req: Request, res: Response) => {
    try {
      const { text: quoteText, category, catLabel } = req.body;
      if (!quoteText) return res.status(400).json({ message: "text required" });
      const systemPrompt = `You parse vendor quotes for Division 10 construction specialties (FURNISH ONLY — no labor or installation).
Respond ONLY with valid JSON, no markdown, no explanation.
Structure:
{
  "vendor": "",
  "note": "",
  "freight": 0,
  "taxIncluded": false,
  "pricingMode": "per_item",
  "lumpSumTotal": 0,
  "materialTotalCost": 0,
  "items": [
    { "name": "", "model": "", "mfr": "", "unitCost": 0, "qty": 1 }
  ]
}
If the quote is a lump sum with no unit prices, set pricingMode to "lump_sum" and fill lumpSumTotal.
For materialTotalCost, use the grand total or subtotal of all materials in the quote (before tax and freight if possible). Set to 0 if not found.
Category context: ${catLabel || category || "Division 10 Specialties"}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Parse this vendor quote:\n\n${quoteText.trim()}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000,
      });
      const parsed = JSON.parse(response.choices[0].message.content || "{}");
      if (parsed.items) parsed.items = parsed.items.map((i: any) => ({ ...i, selected: true, category }));
      res.json(parsed);
    } catch (err) {
      console.error("AI parse-quote error:", err);
      res.status(500).json({ message: "AI parsing failed" });
    }
  });

  // ── AI QUOTE PARSER — PDF FILE UPLOAD ──

  app.post("/api/estimates/ai/parse-quote-pdf", estimateImageUpload.single("file"), async (req: Request, res: Response) => {
    try {
      const file = (req as any).file;
      if (!file) return res.status(400).json({ message: "PDF file required" });
      const { category, catLabel } = req.body;

      let quoteText: string;
      if (file.mimetype === "application/pdf") {
        quoteText = await extractPdfText(file.buffer);
      } else {
        return res.status(400).json({ message: "Only PDF files are accepted for this endpoint" });
      }

      if (!quoteText || quoteText.trim().length < 10) {
        return res.status(422).json({ message: "Could not extract readable text from this PDF. Try copying and pasting the text instead." });
      }

      const systemPrompt = `You parse vendor quotes for Division 10 construction specialties (FURNISH ONLY — no labor or installation).
Respond ONLY with valid JSON, no markdown, no explanation.
Structure:
{
  "vendor": "",
  "note": "",
  "freight": 0,
  "taxIncluded": false,
  "pricingMode": "per_item",
  "lumpSumTotal": 0,
  "materialTotalCost": 0,
  "items": [
    { "name": "", "model": "", "mfr": "", "unitCost": 0, "qty": 1 }
  ]
}
If the quote is a lump sum with no unit prices, set pricingMode to "lump_sum" and fill lumpSumTotal.
For materialTotalCost, use the grand total or subtotal of all materials in the quote (before tax and freight if possible). Set to 0 if not found.
Category context: ${catLabel || category || "Division 10 Specialties"}`;

      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Parse this vendor quote:\n\n${quoteText.trim().slice(0, 8000)}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000,
      });
      const parsed = JSON.parse(response.choices[0].message.content || "{}");
      if (parsed.items) parsed.items = parsed.items.map((i: any) => ({ ...i, selected: true, category }));
      res.json(parsed);
    } catch (err) {
      console.error("AI parse-quote-pdf error:", err);
      res.status(500).json({ message: "AI PDF parsing failed" });
    }
  });

  // ── WRITE GRAND TOTAL BACK TO PROPOSAL LOG ──

  app.post("/api/estimates/:id/sync-to-proposal", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid estimate id" });
      const { grandTotal, reviewStatus } = req.body;
      const [est] = await db.select().from(estimates).where(eq(estimates.id, id));
      if (!est) return res.status(404).json({ message: "Estimate not found" });
      if (!est.proposalLogId) {
        return res.status(400).json({ message: "This estimate has no linked Proposal Log entry. Cannot sync status." });
      }

      const updates: Record<string, any> = {};
      if (grandTotal != null) updates.proposalTotal = String(Math.round(grandTotal));
      if (reviewStatus === "submitted") updates.estimateStatus = "Submitted";

      let rowsUpdated = 0;
      if (Object.keys(updates).length > 0) {
        const updated = await db
          .update(proposalLogEntries)
          .set(updates)
          .where(eq(proposalLogEntries.id, est.proposalLogId))
          .returning({ id: proposalLogEntries.id });
        rowsUpdated = updated.length;
      }
      res.json({ ok: true, rowsUpdated });
    } catch (err) {
      console.error("sync-to-proposal error:", err);
      res.status(500).json({ message: "Failed to sync to proposal log" });
    }
  });

  // ── PENDING OH APPROVALS (admin view) ──

  app.get("/api/estimates/oh-approval/pending", async (req: Request, res: Response) => {
    try {
      const pending = await db.select().from(ohApprovalLog).where(eq(ohApprovalLog.status, "pending")).orderBy(desc(ohApprovalLog.requestedAt));
      res.json(pending);
    } catch (err) {
      console.error("GET pending OH error:", err);
      res.status(500).json({ message: "Failed to fetch pending approvals" });
    }
  });

  // ── SCHEDULE EXTRACTION (Line Item Extraction) ──

  // POST /api/estimates/:id/extract-images — extract from plan images
  app.post("/api/estimates/:id/extract-images", (req: Request, res: Response, next: Function) => {
    handleEstimateImageUpload(req, res, async () => {
      try {
        const estimateId = parseInt(req.params.id);
        if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) return res.status(400).json({ message: "No images uploaded" });

        const results: any[] = [];
        for (const file of files) {
          try {
            const result = await extractScheduleWithAI(file.buffer, file.mimetype || "image/png");
            results.push(...result.items);
          } catch (e: any) {
            console.error("Image extraction error:", e.message);
          }
        }

        const enriched = results.map(item => {
          const { scopeId, confidence } = suggestScope(item.description || "", item.manufacturer || "");
          return {
            ...item,
            suggestedScope: scopeId,
            suggestedScopeCsi: scopeId && scopeId !== "not_div10" ? scopeIdToCsi(scopeId) : null,
            scopeConfidence: confidence,
          };
        });

        res.json({ items: enriched, total: enriched.length });
      } catch (err: any) {
        console.error("POST extract-images error:", err);
        res.status(500).json({ message: err.message || "Extraction failed" });
      }
    });
  });

  // POST /api/estimates/:id/extract-text — extract from pasted text
  app.post("/api/estimates/:id/extract-text", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ message: "text required" });

      const result = await extractScheduleFromText(text.trim());
      const enriched = result.items.map(item => {
        const { scopeId, confidence } = suggestScope(item.description || "", item.manufacturer || "");
        return {
          ...item,
          suggestedScope: scopeId,
          suggestedScopeCsi: scopeId && scopeId !== "not_div10" ? scopeIdToCsi(scopeId) : null,
          scopeConfidence: confidence,
        };
      });

      res.json({ items: enriched, total: enriched.length });
    } catch (err: any) {
      console.error("POST extract-text error:", err);
      res.status(500).json({ message: err.message || "Extraction failed" });
    }
  });

  // POST /api/estimates/:id/import-items — create line items from extracted items
  app.post("/api/estimates/:id/import-items", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ message: "items array required" });

      const allMfrs = await db.select({ id: mfrManufacturers.id, name: mfrManufacturers.name }).from(mfrManufacturers);
      const mfrByLowerName = new Map(allMfrs.map(m => [m.name.trim().toLowerCase(), m.id]));

      const created: any[] = [];
      let skipped = 0;
      for (const item of items) {
        // Resolve a display name from the first non-empty source field.
        const resolvedName = (
          (item.description || "").toString().trim() ||
          (item.name        || "").toString().trim() ||
          (item.planCallout || "").toString().trim() ||
          (item.model       || "").toString().trim() ||
          ((item.manufacturer || item.mfr) || "").toString().trim()
        );
        if (!item.category || !resolvedName) { skipped++; continue; }
        const mfrName: string | null = (item.manufacturer || item.mfr || "").toString().trim() || null;
        const matchedMfrId = mfrName ? (mfrByLowerName.get(mfrName.toLowerCase()) ?? null) : null;
        const [row] = await db.insert(estimateLineItems).values({
          estimateId,
          category: item.category,
          name: resolvedName,
          model: item.modelNumber || item.model || null,
          mfr: mfrName,
          manufacturerId: matchedMfrId,
          qty: item.quantity || item.qty || 1,
          uom: item.uom || "EA",
          unitCost: "0",
          source: item.source || "extracted",
          note: item.note || null,
          hasBackup: false,
          sortOrder: 0,
          planCallout: item.planCallout || null,
          extractionConfidence: item.extractionConfidence || item.confidence || null,
        }).returning();
        created.push(row);
      }

      res.status(201).json({ created: created.length, skipped, items: created });
    } catch (err: any) {
      console.error("POST import-items error:", err);
      res.status(500).json({ message: err.message || "Failed to import items" });
    }
  });

  // ── SPEC EXTRACTION ──

  // POST /api/estimates/:id/extract-spec-images — extract spec sections from images
  app.post("/api/estimates/:id/extract-spec-images", (req: Request, res: Response, next: Function) => {
    handleEstimateImageUpload(req, res, async () => {
      try {
        const estimateId = parseInt(req.params.id);
        if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
        const files = req.files as Express.Multer.File[];
        if (!files || files.length === 0) return res.status(400).json({ message: "No images uploaded" });

        const images = files.map(f => ({
          base64: f.buffer.toString("base64"),
          mime: f.mimetype || "image/png",
        }));

        const sections = await extractSpecSectionsFromImages(openai, images);
        res.json({ sections, total: sections.length });
      } catch (err: any) {
        console.error("POST extract-spec-images error:", err);
        res.status(500).json({ message: err.message || "Spec extraction failed" });
      }
    });
  });

  // POST /api/estimates/:id/extract-spec-text — extract spec sections from pasted text
  app.post("/api/estimates/:id/extract-spec-text", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { text } = req.body;
      if (!text || !text.trim()) return res.status(400).json({ message: "text required" });

      const sections = await extractSpecSectionsFromText(openai, text.trim());
      res.json({ sections, total: sections.length });
    } catch (err: any) {
      console.error("POST extract-spec-text error:", err);
      res.status(500).json({ message: err.message || "Spec extraction failed" });
    }
  });

  // POST /api/estimates/:id/extract-spec-pdf — extract spec sections from a PDF file
  app.post("/api/estimates/:id/extract-spec-pdf", (req: Request, res: Response, next: Function) => {
    estimatePdfUpload.single("pdf")(req, res, async (err: any) => {
      if (err) {
        if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: "PDF too large (max 150MB)" });
        return res.status(400).json({ message: err.message || "Invalid file upload" });
      }
      try {
        const estimateId = parseInt(req.params.id);
        if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
        const file = req.file as Express.Multer.File | undefined;
        if (!file) return res.status(400).json({ message: "No PDF uploaded" });

        const parsed = await extractPdfText(file.buffer);
        const fullText = parsed.text || "";
        if (!fullText.trim()) return res.status(422).json({ message: "Could not extract text from this PDF. Try uploading spec page screenshots instead." });

        // For large spec books / full bid packs, Division 10 sections are buried deep in the document.
        // We find Division 10 markers and extract the relevant segments rather than blindly
        // truncating to the first 40 000 chars (which would only cover the front matter).
        const div10Text = extractDiv10Segments(fullText);
        console.log(`[SpecPDF] ${file.originalname}: ${parsed.numpages} pages, ${Math.round(fullText.length / 1000)}k chars extracted, ${Math.round(div10Text.length / 1000)}k chars of Div 10 content sent to AI`);

        const sections = await extractSpecSectionsFromText(openai, div10Text);
        res.json({ sections, total: sections.length, pageCount: parsed.numpages });
      } catch (err: any) {
        console.error("POST extract-spec-pdf error:", err);
        res.status(500).json({ message: err.message || "Spec extraction failed" });
      }
    });
  });

  // POST /api/estimates/:id/save-spec-sections — save approved spec sections
  app.post("/api/estimates/:id/save-spec-sections", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { sections } = req.body;
      if (!Array.isArray(sections) || sections.length === 0) return res.status(400).json({ message: "sections array required" });

      const saved: any[] = [];
      for (const sec of sections) {
        if (!sec.scopeId) continue;

        // Check if a spec section for this scope already exists
        const existing = await db.select({ id: estimateSpecSections.id, content: estimateSpecSections.content })
          .from(estimateSpecSections)
          .where(and(eq(estimateSpecSections.estimateId, estimateId), eq(estimateSpecSections.scopeId, sec.scopeId)));

        if (existing.length > 0) {
          // Append to existing content
          const appendedContent = `${existing[0].content || ""}\n\n--- Extracted from additional pages ---\n\n${sec.content || ""}`;
          const [updated] = await db.update(estimateSpecSections)
            .set({
              content: appendedContent,
              manufacturers: sec.manufacturers || [],
              keyRequirements: sec.keyRequirements || [],
              substitutionPolicy: sec.substitutionPolicy || null,
              sourcePages: sec.sourcePages || null,
              extractionConfidence: sec.confidence || 80,
              updatedAt: new Date(),
            })
            .where(eq(estimateSpecSections.id, existing[0].id))
            .returning();
          saved.push(updated);
        } else {
          const [row] = await db.insert(estimateSpecSections).values({
            estimateId,
            scopeId: sec.scopeId,
            csiCode: sec.csiCode || null,
            specSectionNumber: sec.specSectionNumber || null,
            specSectionTitle: sec.specSectionTitle || null,
            content: sec.content || null,
            manufacturers: sec.manufacturers || [],
            keyRequirements: sec.keyRequirements || [],
            substitutionPolicy: sec.substitutionPolicy || null,
            sourcePages: sec.sourcePages || null,
            extractionConfidence: sec.confidence || 80,
          }).returning();
          saved.push(row);
        }
      }

      res.status(201).json({ saved: saved.length, sections: saved });
    } catch (err: any) {
      console.error("POST save-spec-sections error:", err);
      res.status(500).json({ message: err.message || "Failed to save spec sections" });
    }
  });

  // GET /api/estimates/:id/spec-sections — list all saved spec sections
  app.get("/api/estimates/:id/spec-sections", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const sections = await db.select().from(estimateSpecSections)
        .where(eq(estimateSpecSections.estimateId, estimateId))
        .orderBy(estimateSpecSections.scopeId);
      res.json(sections);
    } catch (err: any) {
      console.error("GET spec-sections error:", err);
      res.status(500).json({ message: "Failed to fetch spec sections" });
    }
  });

  // GET /api/estimates/:id/spec-sections/:scopeId — get spec section for a specific scope
  app.get("/api/estimates/:id/spec-sections/:scopeId", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.id);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { scopeId } = req.params;
      const [section] = await db.select().from(estimateSpecSections)
        .where(and(eq(estimateSpecSections.estimateId, estimateId), eq(estimateSpecSections.scopeId, scopeId)));
      if (!section) return res.json(null);
      res.json(section);
    } catch (err: any) {
      console.error("GET spec-section by scope error:", err);
      res.status(500).json({ message: "Failed to fetch spec section" });
    }
  });

  // ── BULK LINE ITEM OPERATIONS ──

  app.post("/api/estimates/:estimateId/line-items/bulk-transfer", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.estimateId);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { lineItemIds, targetScopeId } = req.body;
      if (!Array.isArray(lineItemIds) || lineItemIds.length === 0) return res.status(400).json({ message: "lineItemIds array required" });
      if (!targetScopeId) return res.status(400).json({ message: "targetScopeId required" });
      const failures: { lineItemId: number; reason: string }[] = [];
      let processed = 0;
      for (const rawId of lineItemIds) {
        const itemId = parseInt(rawId);
        if (isNaN(itemId)) { failures.push({ lineItemId: rawId, reason: "Invalid id" }); continue; }
        try {
          const [existing] = await db.select().from(estimateLineItems)
            .where(and(eq(estimateLineItems.id, itemId), eq(estimateLineItems.estimateId, estimateId)));
          if (!existing) { failures.push({ lineItemId: itemId, reason: "Not found" }); continue; }
          await db.update(estimateLineItems).set({ category: targetScopeId }).where(eq(estimateLineItems.id, itemId));
          processed++;
        } catch { failures.push({ lineItemId: itemId, reason: "DB error" }); }
      }
      res.json({ success: true, processed, failed: failures.length, failures });
    } catch (err) {
      console.error("bulk-transfer error:", err);
      res.status(500).json({ message: "Bulk transfer failed" });
    }
  });

  app.post("/api/estimates/:estimateId/line-items/bulk-delete", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.estimateId);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { lineItemIds } = req.body;
      if (!Array.isArray(lineItemIds) || lineItemIds.length === 0) return res.status(400).json({ message: "lineItemIds array required" });
      const failures: { lineItemId: number; reason: string }[] = [];
      let processed = 0;
      for (const rawId of lineItemIds) {
        const itemId = parseInt(rawId);
        if (isNaN(itemId)) { failures.push({ lineItemId: rawId, reason: "Invalid id" }); continue; }
        try {
          const [existing] = await db.select().from(estimateLineItems)
            .where(and(eq(estimateLineItems.id, itemId), eq(estimateLineItems.estimateId, estimateId)));
          if (!existing) { failures.push({ lineItemId: itemId, reason: "Not found" }); continue; }
          await db.delete(estimateLineItems).where(eq(estimateLineItems.id, itemId));
          processed++;
        } catch { failures.push({ lineItemId: itemId, reason: "DB error" }); }
      }
      res.json({ success: true, processed, failed: failures.length, failures });
    } catch (err) {
      console.error("bulk-delete error:", err);
      res.status(500).json({ message: "Bulk delete failed" });
    }
  });

  app.post("/api/estimates/:estimateId/line-items/bulk-apply-vendor-quote", async (req: Request, res: Response) => {
    try {
      const estimateId = parseInt(req.params.estimateId);
      if (isNaN(estimateId)) return res.status(400).json({ message: "Invalid estimate id" });
      const { lineItemIds, vendorQuoteId, overrideExistingCosts } = req.body;
      if (!Array.isArray(lineItemIds) || lineItemIds.length === 0) return res.status(400).json({ message: "lineItemIds array required" });
      if (!vendorQuoteId) return res.status(400).json({ message: "vendorQuoteId required" });
      const quoteIdInt = parseInt(vendorQuoteId);
      if (isNaN(quoteIdInt)) return res.status(400).json({ message: "Invalid vendorQuoteId" });
      const [quote] = await db.select().from(estimateQuotes)
        .where(and(eq(estimateQuotes.id, quoteIdInt), eq(estimateQuotes.estimateId, estimateId)));
      if (!quote) return res.status(404).json({ message: "Quote not found" });
      const failures: { lineItemId: number; reason: string }[] = [];
      let processed = 0;
      for (const rawId of lineItemIds) {
        const itemId = parseInt(rawId);
        if (isNaN(itemId)) { failures.push({ lineItemId: rawId, reason: "Invalid id" }); continue; }
        try {
          const [existing] = await db.select().from(estimateLineItems)
            .where(and(eq(estimateLineItems.id, itemId), eq(estimateLineItems.estimateId, estimateId)));
          if (!existing) { failures.push({ lineItemId: itemId, reason: "Not found" }); continue; }
          const updates: Record<string, any> = { quoteId: quoteIdInt, hasBackup: true };
          if (overrideExistingCosts && quote.pricingMode === "lump_sum" && n(quote.lumpSumTotal) > 0) {
            const linkedIds = lineItemIds.map((id: any) => parseInt(id)).filter((id: number) => !isNaN(id));
            const linkedItems = await db.select().from(estimateLineItems)
              .where(and(eq(estimateLineItems.estimateId, estimateId)));
            const targetItems = linkedItems.filter(i => linkedIds.includes(i.id));
            const totalQty = targetItems.reduce((s, i) => s + i.qty, 0);
            if (totalQty > 0) {
              const unitCost = n(quote.lumpSumTotal) / totalQty;
              updates.unitCost = String(unitCost.toFixed(2));
            }
          }
          await db.update(estimateLineItems).set(updates).where(eq(estimateLineItems.id, itemId));
          processed++;
        } catch { failures.push({ lineItemId: itemId, reason: "DB error" }); }
      }
      res.json({ success: true, processed, failed: failures.length, failures });
    } catch (err) {
      console.error("bulk-apply-vendor-quote error:", err);
      res.status(500).json({ message: "Bulk apply vendor quote failed" });
    }
  });
}
