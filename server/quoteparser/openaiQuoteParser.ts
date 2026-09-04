import OpenAI from "openai";
import { z } from "zod";
import { db } from "../db";
import { systemSettings, vendors } from "@shared/schema";
import { eq } from "drizzle-orm";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o";

// ── Schema ────────────────────────────────────────────────────────────────────

const LineItemSchema = z.object({
  description: z.string().default(""),
  modelNumber: z.string().default(""),
  qty: z.coerce.string().default("1"),
  lineType: z.enum(["product", "tag", "decal", "freight", "other"]).default("product"),
  confidence: z.number().min(0).max(100).default(90),
  confidenceNote: z.string().default(""),
  defaultChecked: z.boolean().default(true),
});

const QuoteResultSchema = z.object({
  manufacturer: z.string().default(""),
  quoteNumber: z.string().default(""),
  materialTotal: z.number().default(0),
  freightTotal: z.number().default(0),
  lineItems: z.array(LineItemSchema),
  warnings: z.array(z.string()).default([]),
});

export interface ParsedLineItem {
  description: string;
  modelNumber: string;
  qty: string;
  lineType: "product" | "tag" | "decal" | "freight" | "other";
  confidence: number;
  confidenceNote: string;
  defaultChecked: boolean;
}

export interface QuoteParseResult {
  lineItems: ParsedLineItem[];
  manufacturer: string;
  quoteNumber: string;
  materialTotal: number;
  freightTotal: number;
  warnings: string[];
  detectedVendorId: number | null;
  detectedVendorName: string | null;
}

export interface SpecCheckResult {
  checks: Array<{
    status: "pass" | "fail" | "warn";
    message: string;
    checkType: "model_match" | "qty_match" | "spec_compliance";
  }>;
}

// ── System Prompt Storage ─────────────────────────────────────────────────────

const PROMPT_KEY = "quote_parser_system_prompt";

export const DEFAULT_SYSTEM_PROMPT = `You are a construction vendor quote parser for a Division 10 specialty contractor (toilet accessories, fire extinguishers, fire extinguisher cabinets, toilet partitions, lockers, visual display boards, etc.).

Your job is to extract structured data from vendor quotes — PDFs, images, or pasted text — and return ONLY a valid JSON object. No prose, no markdown fences, no explanation.

OUTPUT SCHEMA:
{
  "manufacturer": string,       // vendor/manufacturer name from the quote header
  "quoteNumber": string,        // quote or sales order number
  "materialTotal": number,      // material subtotal (before freight and tax), as a number
  "freightTotal": number,       // freight/shipping total, as a number (0 if none)
  "lineItems": [
    {
      "description": string,    // product description in ALL CAPS
      "modelNumber": string,    // model/part number exactly as shown
      "qty": string,            // quantity as a string
      "lineType": "product" | "tag" | "decal" | "freight" | "other",
      "confidence": number,     // 0-100 confidence this line was read correctly
      "confidenceNote": string, // brief note if confidence < 95, otherwise ""
      "defaultChecked": boolean // true if this is a main material piece, false if accessory/incidental
    }
  ],
  "warnings": string[]          // any issues or ambiguities you encountered
}

LINE TYPE RULES:
- "product": standard product line item (extinguisher, cabinet, accessory, partition, etc.)
- "tag": inspection tags, ID tags, extinguisher tags (e.g. "TAG-CA", "TAGGING", "ANNUAL TAG")
- "decal": decals, die-cut stickers, labels (e.g. "LDCVBFE", "DIE CUT DECAL")
- "freight": any shipping, freight, delivery, or outbound freight line (e.g. "FREIGHT", "FRTOUT", "SHIPPING")
- "other": discount lines, tax lines, subtotals, or anything that is not a product

IMPORTANT RULES:
- Tags and decals should NOT appear as separate product rows — mark them as "tag" or "decal" lineType so they can be consolidated with their parent product
- Freight lines should be marked as "freight" lineType and their amount included in freightTotal, NOT materialTotal
- materialTotal = subtotal of all product lines (BEFORE freight, tax, or discounts)
- If you see "Subtotal", "Material Total", or similar, use that value for materialTotal
- If you only see a Grand Total, subtract freightTotal to get materialTotal
- Descriptions should be in ALL CAPS
- Include every line item from the quote — do not skip any
- If the quote number starts with "SQ", that is a Sales Quote number — include it as-is
- Quote numbers, PO numbers, and SO numbers are all acceptable as quoteNumber

CONFIDENCE SCORING:
- 95-100: clearly readable, no ambiguity
- 80-94: minor uncertainty (e.g. OCR artifact, slightly blurry text)
- 60-79: significant uncertainty, reviewer should verify
- Below 60: could not read reliably

DEFAULT SELECTION (defaultChecked):
Set defaultChecked to indicate whether a line should be pre-selected for copying into an estimate. The estimator wants MAIN material pieces pre-checked and INCIDENTAL accessories left unchecked.
- defaultChecked = true for the primary/main material piece of any scope. Examples: locker frames/units, fire extinguishers, fire extinguisher cabinets, toilet partition panels/doors/pilasters, the principal product being purchased.
- defaultChecked = false for incidental or add-on accessory lines. Examples: locker filler panels, spacers, end panels, sloped tops, trim, base/leg kits, number plates, mounting hardware, brackets, and any item that is an accessory to a main piece.
- defaultChecked = false ALWAYS for lineType "tag", "decal", and "freight".
- When unsure whether a product is a main piece or an accessory, lean toward true (checked) only if it is clearly a primary deliverable; otherwise false.
- Apply this same primary-vs-accessory logic to ALL material types, not only the examples above.

VENDOR-SPECIFIC RULES:
(Additional rules for specific vendors will appear here as they are learned)`;

export async function getSystemPrompt(): Promise<string> {
  try {
    const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, PROMPT_KEY));
    if (rows.length > 0) return rows[0].value;
  } catch {
    // fall through to default
  }
  return DEFAULT_SYSTEM_PROMPT;
}

export async function saveSystemPrompt(prompt: string): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key: PROMPT_KEY, value: prompt, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: prompt, updatedAt: new Date() } });
}

// ── Vendor Detection ──────────────────────────────────────────────────────────

async function detectVendor(text: string): Promise<{ id: number; name: string } | null> {
  try {
    const allVendors = await db.select({ id: vendors.id, name: vendors.name, shortName: vendors.shortName, quotePatterns: vendors.quotePatterns }).from(vendors).where(eq(vendors.isActive, true));
    const upper = text.toUpperCase();
    for (const v of allVendors) {
      const patterns: string[] = (v.quotePatterns as string[]) || [];
      for (const p of patterns) {
        if (upper.includes(p.toUpperCase())) return { id: v.id, name: v.name };
      }
      if (v.name && upper.includes(v.name.toUpperCase())) return { id: v.id, name: v.name };
      if (v.shortName && upper.includes(v.shortName.toUpperCase())) return { id: v.id, name: v.name };
    }
  } catch {
    // ignore
  }
  return null;
}

// ── Update vendor parse count / last seen ─────────────────────────────────────

export async function recordVendorParse(vendorId: number): Promise<void> {
  // We use a systemSettings key per vendor to track parse count and last seen
  const key = `quote_parser_vendor_${vendorId}`;
  try {
    const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
    const existing = rows[0] ? JSON.parse(rows[0].value) : { count: 0, lastSeen: null };
    const updated = { count: (existing.count || 0) + 1, lastSeen: new Date().toISOString() };
    await db
      .insert(systemSettings)
      .values({ key, value: JSON.stringify(updated), updatedAt: new Date() })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: JSON.stringify(updated), updatedAt: new Date() } });
  } catch {
    // non-fatal
  }
}

export async function getVendorMemory(): Promise<Array<{ id: number; name: string; parseCount: number; lastSeen: string | null }>> {
  try {
    const allVendors = await db.select({ id: vendors.id, name: vendors.name }).from(vendors).where(eq(vendors.isActive, true));
    const results = [];
    for (const v of allVendors) {
      const key = `quote_parser_vendor_${v.id}`;
      const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
      if (rows.length > 0) {
        const data = JSON.parse(rows[0].value);
        results.push({ id: v.id, name: v.name, parseCount: data.count || 0, lastSeen: data.lastSeen || null });
      }
    }
    return results.sort((a, b) => b.parseCount - a.parseCount);
  } catch {
    return [];
  }
}

// ── JSON Parsing Helper ───────────────────────────────────────────────────────

function parseJson(content: string): unknown {
  let s = content.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.substring(start, end + 1);
  return JSON.parse(s);
}

// ── Main Parse: Text ──────────────────────────────────────────────────────────

export async function parseQuoteFromText(text: string): Promise<QuoteParseResult> {
  const systemPrompt = await getSystemPrompt();
  const detectedVendor = await detectVendor(text);

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Parse this vendor quote:\n\n${text}` },
    ],
  });

  const content = response.choices?.[0]?.message?.content || "";
  const parsed = parseJson(content);
  const validated = QuoteResultSchema.parse(parsed);

  if (detectedVendor) {
    await recordVendorParse(detectedVendor.id);
  }

  return {
    ...validated,
    detectedVendorId: detectedVendor?.id ?? null,
    detectedVendorName: detectedVendor?.name ?? (validated.manufacturer || null),
  };
}

// ── Main Parse: Image (vision) ────────────────────────────────────────────────

export async function parseQuoteFromImage(imageBuffer: Buffer, mimeType: string): Promise<QuoteParseResult> {
  const systemPrompt = await getSystemPrompt();
  const base64 = imageBuffer.toString("base64");

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } },
          { type: "text", text: "Parse this vendor quote image. Return ONLY the JSON object." },
        ],
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content || "";
  const parsed = parseJson(content);
  const validated = QuoteResultSchema.parse(parsed);

  const detectedVendor = await detectVendor(validated.manufacturer + " " + validated.quoteNumber);
  if (detectedVendor) await recordVendorParse(detectedVendor.id);

  return {
    ...validated,
    detectedVendorId: detectedVendor?.id ?? null,
    detectedVendorName: detectedVendor?.name ?? (validated.manufacturer || null),
  };
}

// ── Spec Compliance Check ─────────────────────────────────────────────────────

export async function checkSpecCompliance(quoteResult: QuoteParseResult, specText: string): Promise<SpecCheckResult> {
  const quoteDescription = [
    `Vendor: ${quoteResult.manufacturer}`,
    `Quote: ${quoteResult.quoteNumber}`,
    `Line Items:`,
    ...quoteResult.lineItems
      .filter(i => i.lineType === "product")
      .map(i => `  - ${i.qty}x ${i.modelNumber}: ${i.description}`),
  ].join("\n");

  const response = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 4096,
    messages: [
      {
        role: "system",
        content: `You are a construction specification compliance reviewer for Division 10 specialty products.

You will receive:
1. A list of products from a vendor quote (each with a quantity and model number)
2. Specification requirements from the project spec section

Return ONLY a valid JSON object:
{
  "checks": [
    {
      "status": "pass" | "fail" | "warn",
      "message": string,
      "checkType": "model_match" | "qty_match" | "spec_compliance"
    }
  ]
}

You must produce THREE kinds of checks ("checkType"), and the array must contain ALL "model_match" checks first, then ALL "qty_match" checks, then ALL "spec_compliance" checks after that — in that order.

1. "model_match" — one check for EVERY quoted line item, no exceptions:
   - If the spec names a model/part number for that product and it matches the quoted model number exactly (ignoring case, spacing, and punctuation), status = "pass".
   - If the spec's model number and the quote's model number are a PARTIAL match — e.g. the quote has extra prefix/suffix characters or digits the spec doesn't mention, or vice versa (such as spec "B-4112" vs quote "B-4112-99" or "B-41"), status = "warn", and the message must name both numbers and describe exactly what differs (what's added/missing).
   - If the spec names a model number and it does NOT match the quoted one at all, status = "fail", and the message must state both the spec's required model and the quoted model.
   - If the spec does not specify a model number to check that product against, status = "warn" with a message saying no spec model number was found to verify against.
   - NEVER omit a line item from this list, even when it is a confident pass. A confirmed match must still be reported, not left out.

2. "qty_match" — one check for EVERY quoted line item, no exceptions:
   - If the spec states a required quantity for that product and it equals the quoted quantity, status = "pass".
   - If the spec states a required quantity and it does NOT equal the quoted quantity, status = "fail", and the message must state both the spec-required quantity and the quoted quantity.
   - If the spec does not state a quantity for that product, status = "warn" with a message saying no spec quantity was found to verify against.
   - NEVER omit a line item from this list, even when it is a confident pass. A confirmed match must still be reported, not left out.

3. "spec_compliance" — general checks for anything else the spec requires (type, size, mounting, finish, material, mounting height, accessories, alternates, etc.) that isn't a model number or quantity match. Use "pass" / "fail" / "warn" per the rules below.

STATUS RULES (for "spec_compliance" checks):
- "pass": product clearly meets the spec requirement
- "fail": product clearly conflicts with the spec (wrong type, wrong size, wrong mounting, etc.)
- "warn": cannot confirm compliance — something needs verification (finish not specified, alternate accepted language, etc.)

Be specific in every message. Name the product, model number, and the specific spec requirement that passes, fails, or needs verification.
Return ONLY valid JSON, no prose, no markdown.`,
      },
      {
        role: "user",
        content: `QUOTED PRODUCTS:\n${quoteDescription}\n\nSPECIFICATION REQUIREMENTS:\n${specText}`,
      },
    ],
  });

  const content = response.choices?.[0]?.message?.content || "";
  try {
    const parsed = parseJson(content) as any;
    const rawChecks: any[] = parsed.checks || [];
    const checks = rawChecks.map(c => ({
      status: c.status || "warn",
      message: c.message || "",
      checkType: c.checkType || "spec_compliance",
    }));

    // Guarantee model/qty match results always lead, regardless of AI ordering.
    const order: Record<string, number> = { model_match: 0, qty_match: 1, spec_compliance: 2 };
    checks.sort((a, b) => (order[a.checkType] ?? 2) - (order[b.checkType] ?? 2));

    return { checks };
  } catch {
    return { checks: [{ status: "warn", message: "Could not parse compliance check response — review manually.", checkType: "spec_compliance" }] };
  }
}

export function formatCurrency(amount: number | null): string {
  if (!amount || isNaN(amount) || amount === 0) return "$-";
  return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
