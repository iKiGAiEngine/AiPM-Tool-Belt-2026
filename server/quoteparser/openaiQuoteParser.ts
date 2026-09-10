import OpenAI from "openai";
import { z } from "zod";
import sharp from "sharp";
import { db } from "../db";
import { systemSettings, vendors } from "@shared/schema";
import { eq } from "drizzle-orm";

// Lazy so importing this module never throws when the key is absent — the
// /parse route reports a clean CONFIG_ERROR instead.
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
export const MODEL = process.env.OPENAI_QUOTE_MODEL || "gpt-4o";

// ── Input sources ─────────────────────────────────────────────────────────────
// A parse can combine several sources (uploaded file + pasted screenshot +
// pasted text). All of them go to the model in a single request.

export type QuoteSource =
  | { kind: "text"; label: string; text: string }
  | { kind: "image"; label: string; buffer: Buffer; mimeType: string };

// ── Schema ────────────────────────────────────────────────────────────────────

const LineItemSchema = z.object({
  description: z.string().default(""),
  modelNumber: z.string().default(""),
  qty: z.coerce.string().default("1"),
  unitPrice: z.number().nullable().default(null),
  extendedPrice: z.number().nullable().default(null),
  lineType: z.enum(["product", "tag", "decal", "freight", "other"]).default("product"),
  confidence: z.number().min(0).max(100).default(90),
  confidenceNote: z.string().default(""),
  defaultChecked: z.boolean().default(true),
});

export const QuoteResultSchema = z.object({
  manufacturer: z.string().default(""),
  quoteNumber: z.string().default(""),
  materialTotal: z.number().default(0),
  freightTotal: z.number().default(0),
  taxTotal: z.number().default(0),
  lineItems: z.array(LineItemSchema),
  warnings: z.array(z.string()).default([]),
});

export interface ParsedLineItem {
  description: string;
  modelNumber: string;
  qty: string;
  unitPrice: number | null;
  extendedPrice: number | null;
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
  taxTotal: number;
  warnings: string[];
  detectedVendorId: number | null;
  detectedVendorName: string | null;
}

export interface SpecCheckResult {
  checks: Array<{
    status: "pass" | "fail" | "warn";
    message: string;
  }>;
}

export interface ScheduleEntry {
  callout: string;
  description: string;
  modelNumber: string;
  qty: string;
}

const ScheduleResultSchema = z.object({
  entries: z.array(
    z.object({
      callout: z.coerce.string().default(""),
      description: z.string().default(""),
      modelNumber: z.string().default(""),
      qty: z.coerce.string().default(""),
    })
  ),
  warnings: z.array(z.string()).default([]),
});

// ── Strict JSON schemas for OpenAI Structured Outputs ────────────────────────
// strict mode guarantees the model's reply matches this shape exactly, which
// eliminates the "model improvised and the parse blew up" failure class.

const QUOTE_JSON_SCHEMA = {
  name: "quote_parse_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      manufacturer: { type: "string" },
      quoteNumber: { type: "string" },
      materialTotal: { type: "number" },
      freightTotal: { type: "number" },
      taxTotal: { type: "number" },
      lineItems: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            description: { type: "string" },
            modelNumber: { type: "string" },
            qty: { type: "string" },
            unitPrice: { type: ["number", "null"] },
            extendedPrice: { type: ["number", "null"] },
            lineType: { type: "string", enum: ["product", "tag", "decal", "freight", "other"] },
            confidence: { type: "number" },
            confidenceNote: { type: "string" },
            defaultChecked: { type: "boolean" },
          },
          required: [
            "description", "modelNumber", "qty", "unitPrice", "extendedPrice",
            "lineType", "confidence", "confidenceNote", "defaultChecked",
          ],
        },
      },
      warnings: { type: "array", items: { type: "string" } },
    },
    required: ["manufacturer", "quoteNumber", "materialTotal", "freightTotal", "taxTotal", "lineItems", "warnings"],
  },
} as const;

const SCHEDULE_JSON_SCHEMA = {
  name: "schedule_extract_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            callout: { type: "string" },
            description: { type: "string" },
            modelNumber: { type: "string" },
            qty: { type: "string" },
          },
          required: ["callout", "description", "modelNumber", "qty"],
        },
      },
      warnings: { type: "array", items: { type: "string" } },
    },
    required: ["entries", "warnings"],
  },
} as const;

const SPEC_JSON_SCHEMA = {
  name: "spec_check_result",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      checks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["pass", "fail", "warn"] },
            message: { type: "string" },
          },
          required: ["status", "message"],
        },
      },
    },
    required: ["checks"],
  },
} as const;

// ── System Prompt Storage ─────────────────────────────────────────────────────

const PROMPT_KEY = "quote_parser_system_prompt";

export const DEFAULT_SYSTEM_PROMPT = `You are a construction vendor quote parser for a Division 10 specialty contractor (toilet accessories, fire extinguishers, fire extinguisher cabinets, toilet partitions, lockers, visual display boards, etc.).

Your job is to extract structured data from vendor quotes — PDFs, images, or pasted text — and return ONLY a valid JSON object. No prose, no markdown fences, no explanation.

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
- If you only see a Grand Total, subtract freightTotal AND taxTotal to get materialTotal
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
- Apply this same primary-vs-accessory logic to ALL material types, not only the examples above.`;

// Always appended server-side AFTER the (editable) stored prompt so pricing
// extraction and the honesty contract apply even if the stored handbook
// predates these fields. Not editable through the UI on purpose.
export const CORE_OUTPUT_CONTRACT = `
CORE OUTPUT CONTRACT (always applies, overrides anything above if in conflict):
- For EVERY line item, extract "unitPrice" (price for one unit) and "extendedPrice" (the line's total: qty × unit price) as numbers when they are printed on the quote.
- If a price is genuinely not shown or not readable, use null — NEVER guess, NEVER compute a number you cannot see, NEVER output 0 for an unknown price.
- Extract "taxTotal" (sales tax) as a number; 0 if the quote shows no tax.
- If any value is uncertain, say so: lower that line's confidence and explain in confidenceNote. It is always better to flag uncertainty than to output a wrong number confidently.
- "qty" must be the numeric quantity as a string (e.g. "12").
- Return ONLY the JSON object.`;

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

// ── Vendor rules (the learning loop) ─────────────────────────────────────────
// Curated, per-vendor parsing rules injected into the system prompt whenever
// that vendor's quote is detected. Size-capped so the prompt can never bloat.

const VENDOR_RULES_KEY_PREFIX = "quote_parser_vendor_rules_";
export const VENDOR_RULES_MAX_CHARS = 4000;

export async function getVendorRules(vendorId: number): Promise<string> {
  try {
    const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, `${VENDOR_RULES_KEY_PREFIX}${vendorId}`));
    return rows[0]?.value || "";
  } catch {
    return "";
  }
}

export async function saveVendorRules(vendorId: number, rules: string): Promise<void> {
  const trimmed = rules.trim().slice(0, VENDOR_RULES_MAX_CHARS);
  await db
    .insert(systemSettings)
    .values({ key: `${VENDOR_RULES_KEY_PREFIX}${vendorId}`, value: trimmed, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value: trimmed, updatedAt: new Date() } });
}

async function buildSystemPrompt(vendor: { id: number; name: string } | null): Promise<string> {
  let prompt = (await getSystemPrompt()) + "\n" + CORE_OUTPUT_CONTRACT;
  if (vendor) {
    const rules = await getVendorRules(vendor.id);
    if (rules) {
      prompt += `\n\nVENDOR-SPECIFIC RULES for ${vendor.name} (learned from past corrections — follow these):\n${rules}`;
    }
  }
  return prompt;
}

// ── Vendor Detection ──────────────────────────────────────────────────────────

export async function detectVendor(text: string): Promise<{ id: number; name: string } | null> {
  if (!text.trim()) return null;
  try {
    const allVendors = await db
      .select({ id: vendors.id, name: vendors.name, shortName: vendors.shortName, quotePatterns: vendors.quotePatterns })
      .from(vendors)
      .where(eq(vendors.isActive, true));
    const upper = text.toUpperCase();
    for (const v of allVendors) {
      const patterns: string[] = (v.quotePatterns as string[]) || [];
      for (const p of patterns) {
        if (p && upper.includes(p.toUpperCase())) return { id: v.id, name: v.name };
      }
      if (v.name && upper.includes(v.name.toUpperCase())) return { id: v.id, name: v.name };
      if (v.shortName && upper.includes(v.shortName.toUpperCase())) return { id: v.id, name: v.name };
    }
  } catch {
    // ignore
  }
  return null;
}

// ── JSON Parsing Helper ───────────────────────────────────────────────────────

export function parseJson(content: string): unknown {
  let s = content.trim();
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) s = s.substring(start, end + 1);
  return JSON.parse(s);
}

// ── Image normalization ───────────────────────────────────────────────────────
// The vision API accepts png/jpeg/webp/gif. Anything else (HEIC from iPhones
// being the big one) is converted to PNG first.

const VISION_SAFE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function normalizeImageForVision(
  buffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (VISION_SAFE_TYPES.has(mimeType)) return { buffer, mimeType };
  const png = await sharp(buffer).png().toBuffer();
  return { buffer: png, mimeType: "image/png" };
}

// ── Core structured call with validation + one retry ─────────────────────────

type UserContent = OpenAI.Chat.Completions.ChatCompletionContentPart[];

async function callStructured<T>(opts: {
  systemPrompt: string;
  userContent: UserContent;
  jsonSchema: any;
  zodSchema: z.ZodType<T, any, any>;
  maxTokens: number;
}): Promise<{ data: T; warnings: string[] }> {
  const warnings: string[] = [];
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userContent },
  ];

  const attempt = async (useStrict: boolean) => {
    return getOpenAI().chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: opts.maxTokens,
      messages,
      ...(useStrict ? { response_format: { type: "json_schema" as const, json_schema: opts.jsonSchema } } : {}),
    });
  };

  let response;
  try {
    response = await attempt(true);
  } catch (err: any) {
    // Some models don't support strict structured outputs — fall back to a
    // plain call and rely on Zod validation.
    if (err?.status === 400) {
      warnings.push("Model does not support strict output mode — used fallback validation.");
      response = await attempt(false);
    } else {
      throw err;
    }
  }

  const validate = (resp: typeof response): T | { error: string } => {
    const choice = resp.choices?.[0];
    if (choice?.finish_reason === "length") {
      warnings.push("AI response was cut off (quote may be very long) — results may be incomplete. Please verify.");
    }
    const content = choice?.message?.content || "";
    try {
      const parsed = parseJson(content);
      const result = opts.zodSchema.safeParse(parsed);
      if (result.success) return result.data;
      return { error: JSON.stringify(result.error.issues.slice(0, 5)) };
    } catch (e: any) {
      return { error: `Invalid JSON: ${e.message}` };
    }
  };

  const first = validate(response);
  if (!(typeof first === "object" && first !== null && "error" in first)) {
    return { data: first as T, warnings };
  }

  // One repair retry: feed the validation error back so the model can fix it.
  messages.push({ role: "assistant", content: response.choices?.[0]?.message?.content || "" });
  messages.push({
    role: "user",
    content: `Your previous response failed validation with this error:\n${(first as { error: string }).error}\n\nReturn the corrected JSON object ONLY.`,
  });
  const retryResponse = await attempt(true).catch(() => attempt(false));
  const second = validate(retryResponse);
  if (typeof second === "object" && second !== null && "error" in second) {
    throw new Error(`AI response failed validation after retry: ${(second as { error: string }).error}`);
  }
  warnings.push("First AI response needed an automatic correction pass.");
  return { data: second as T, warnings };
}

// ── Build user content from mixed sources ─────────────────────────────────────

async function sourcesToContent(sources: QuoteSource[], instruction: string): Promise<UserContent> {
  const content: UserContent = [{ type: "text", text: instruction }];
  for (const source of sources) {
    if (source.kind === "text") {
      content.push({ type: "text", text: `--- ${source.label} ---\n${source.text}` });
    } else {
      const { buffer, mimeType } = await normalizeImageForVision(source.buffer, source.mimeType);
      content.push({ type: "text", text: `--- ${source.label} (image follows) ---` });
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}`, detail: "high" },
      });
    }
  }
  return content;
}

function combinedText(sources: QuoteSource[]): string {
  return sources
    .filter((s): s is Extract<QuoteSource, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
}

// ── Main Parse ────────────────────────────────────────────────────────────────

export async function parseQuoteSources(sources: QuoteSource[]): Promise<QuoteParseResult> {
  if (sources.length === 0) throw new Error("No quote content provided");

  // Detect vendor from any text sources up front so vendor-specific rules can
  // steer the parse itself.
  let detectedVendor = await detectVendor(combinedText(sources));
  const systemPrompt = await buildSystemPrompt(detectedVendor);

  const instruction =
    sources.length > 1
      ? `Parse this vendor quote. The quote is provided as ${sources.length} sources (listed below) that together describe ONE quote — combine them; if the same line item appears in multiple sources, include it once.`
      : "Parse this vendor quote.";

  const userContent = await sourcesToContent(sources, instruction);

  const { data: validated, warnings: callWarnings } = await callStructured({
    systemPrompt,
    userContent,
    jsonSchema: QUOTE_JSON_SCHEMA,
    zodSchema: QuoteResultSchema,
    maxTokens: 16384,
  });

  // Image-only parses can't detect the vendor until the model has read the
  // manufacturer name.
  if (!detectedVendor && validated.manufacturer) {
    detectedVendor = await detectVendor(validated.manufacturer + " " + validated.quoteNumber);
  }

  return {
    ...validated,
    warnings: [...validated.warnings, ...callWarnings],
    detectedVendorId: detectedVendor?.id ?? null,
    detectedVendorName: detectedVendor?.name ?? (validated.manufacturer || null),
  };
}

// ── Schedule extraction (Gate 3 input) ────────────────────────────────────────

export async function extractScheduleEntries(sources: QuoteSource[]): Promise<{ entries: ScheduleEntry[]; warnings: string[] }> {
  const systemPrompt = `You are reading a construction plan schedule (e.g. a fire extinguisher schedule, toilet accessory schedule, or door/room schedule) for a Division 10 specialty contractor.

Extract every scheduled item and return ONLY a valid JSON object with:
- "entries": array of { "callout": string, "description": string, "modelNumber": string, "qty": string }
  - callout: the plan mark / tag / callout identifier (e.g. "FE-1", "TA-3", "10A"). Empty string if none shown.
  - description: the item description in ALL CAPS.
  - modelNumber: the specified model/part number exactly as shown; empty string if none.
  - qty: total quantity as a numeric string; empty string if the schedule does not give quantities.
- "warnings": array of strings for anything ambiguous or unreadable.

Do not invent items, quantities, or model numbers. If something is unreadable, note it in warnings.`;

  const userContent = await sourcesToContent(sources, "Extract the schedule items from the following.");
  const { data, warnings } = await callStructured({
    systemPrompt,
    userContent,
    jsonSchema: SCHEDULE_JSON_SCHEMA,
    zodSchema: ScheduleResultSchema,
    maxTokens: 8192,
  });
  return { entries: data.entries, warnings: [...data.warnings, ...warnings] };
}

// ── Spec Compliance Check (Gate 2) ────────────────────────────────────────────

export async function checkSpecCompliance(quoteResult: QuoteParseResult, specSources: QuoteSource[]): Promise<SpecCheckResult> {
  const quoteDescription = [
    `Vendor: ${quoteResult.manufacturer}`,
    `Quote: ${quoteResult.quoteNumber}`,
    `Line Items:`,
    ...quoteResult.lineItems
      .filter((i) => i.lineType === "product")
      .map((i) => `  - ${i.qty}x ${i.modelNumber}: ${i.description}`),
  ].join("\n");

  const systemPrompt = `You are a construction specification compliance reviewer for Division 10 specialty products.

You will receive:
1. A list of products from a vendor quote
2. Specification requirements from the project spec section (text and/or images)

Compare each quoted product against the spec requirements and return ONLY a valid JSON object:
{
  "checks": [
    {
      "status": "pass" | "fail" | "warn",
      "message": string
    }
  ]
}

STATUS RULES:
- "pass": product clearly meets the spec requirement
- "fail": product clearly conflicts with the spec (wrong type, wrong size, wrong mounting, etc.)
- "warn": cannot confirm compliance — something needs verification (finish not specified, alternate accepted language, etc.)

Be specific in every message. Name the product, model number, and the specific spec requirement that passes, fails, or needs verification.
Never claim compliance you cannot see evidence for — when unsure, use "warn" and say what to verify.
Return ONLY valid JSON, no prose, no markdown.`;

  const userContent = await sourcesToContent(
    specSources,
    `QUOTED PRODUCTS:\n${quoteDescription}\n\nThe specification requirements follow.`
  );

  try {
    const { data } = await callStructured({
      systemPrompt,
      userContent,
      jsonSchema: SPEC_JSON_SCHEMA,
      zodSchema: z.object({ checks: z.array(z.object({ status: z.enum(["pass", "fail", "warn"]), message: z.string() })) }),
      maxTokens: 4096,
    });
    return { checks: data.checks };
  } catch {
    return { checks: [{ status: "warn", message: "Could not complete the spec compliance check — review manually." }] };
  }
}

// ── Draft a vendor rule from feedback (learning loop) ─────────────────────────

export async function draftVendorRule(input: {
  vendorName: string;
  issueDescription: string;
  rawTextSnippet?: string | null;
}): Promise<string> {
  const response = await getOpenAI().chat.completions.create({
    model: MODEL,
    temperature: 0,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content: `You maintain vendor-specific parsing rules for a construction quote parser. Given a user's complaint about a bad parse (and optionally a snippet of the quote text), write 1-3 short, imperative rules that would prevent this mistake on future quotes from this vendor. Rules must be general (about the vendor's quote FORMAT), not about this one quote's specific values. Output only the rules, one per line, each starting with "- ". If the complaint doesn't reveal a reusable format rule, output exactly: NO_RULE`,
      },
      {
        role: "user",
        content: `Vendor: ${input.vendorName}\nComplaint: ${input.issueDescription}\n${input.rawTextSnippet ? `Quote text snippet:\n${input.rawTextSnippet.slice(0, 3000)}` : ""}`,
      },
    ],
  });
  const text = response.choices?.[0]?.message?.content?.trim() || "";
  return text === "NO_RULE" ? "" : text;
}

export function formatCurrency(amount: number | null): string {
  if (amount === null || amount === undefined || isNaN(amount) || amount === 0) return "$-";
  return "$" + amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
