import OpenAI from "openai";
import { instrumentOpenAI } from "./aiUsage";
import { z } from "zod";

const openai = instrumentOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), "schedule-extractor");

const DEFAULT_MODEL = "gpt-4o";
const FALLBACK_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 16384;
const MAX_CONTINUATION_ATTEMPTS = 3;
const VERIFICATION_MIN_ITEMS = 3;

const RawItemSchema = z.object({
  planCallout: z.coerce.string().default(""),
  description: z.coerce.string().default(""),
  manufacturer: z.coerce.string().default(""),
  model: z.coerce.string().default(""),
  quantity: z.coerce.number().default(0),
  sourceSection: z.coerce.string().default(""),
  confidence: z.coerce.number().min(0).max(100).default(80),
  flags: z.array(z.coerce.string()).default([]),
});

const ResponseSchema = z.object({
  totalRowCount: z.coerce.number().optional().default(0),
  items: z.array(RawItemSchema),
});

export interface ScheduleItem {
  planCallout: string;
  description: string;
  manufacturer: string;
  rawModel: string;
  modelNumber: string;
  quantity: number;
  sourceSection: string;
  confidence: number;
  flags: string[];
  needsReview: boolean;
}

export interface ExtractionResult {
  items: ScheduleItem[];
  rawText: string;
  processingTimeMs: number;
  modelUsed: string;
  retried: boolean;
  continuationUsed: boolean;
  possibleTruncation: boolean;
  totalRowCount: number;
  verified: boolean;
}

const SYSTEM_PROMPT = `You are a construction document data extractor specializing in accurate table reading. You will receive an image of a construction schedule (accessory schedule, fixture schedule, equipment schedule, etc).

Extract every line item from the schedule table into structured JSON. Return ONLY valid JSON, no prose, no markdown fences, no explanation.

PROCESSING METHOD — ROW-BY-ROW ANCHORING:
1. First, identify all column headers in the schedule table.
2. Count the total number of data rows (excluding headers and section titles). Store this as totalRowCount.
3. Process each row one at a time, from top to bottom. For each row, read across ALL columns left to right before moving to the next row.
4. Do NOT jump between rows or process columns independently. Stay on one row until every cell is captured.

CRITICAL RULES:
- You MUST extract EVERY SINGLE ROW. Do not skip any rows for any reason.
- Rows with empty/blank callouts: still extract them — use "" for planCallout.
- Rows with no manufacturer or model: still extract them — use "" and add appropriate flags.
- Multi-line cells: if a single row spans multiple lines visually, treat it as ONE item. Combine the multi-line text.
- Sub-items or continuation lines that are clearly part of a parent row: merge them into the parent item's description.
- Section headers (like "ACCESSORY SCHEDULE", "096400 CUSTOM CASEWORK"): these are NOT data rows. Use them as the sourceSection value for items beneath them. Do NOT count them in totalRowCount.

For each row, extract:
- planCallout: The plan callout/tag/mark (e.g. "TA-01", "PF-03", "EQ-1"). If the row has no callout, use "".
- description: The item description PLUS ALL additional details from every other column in this row that is not planCallout, manufacturer, model, or quantity. You MUST capture every single piece of data visible in the row. This includes but is not limited to: finish, color, size, dimensions, mounting type, material, ADA compliance notes, door swing, hinge type, fire rating, installation notes, remarks, location, room numbers, specifications, series, options, accessories, voltage, capacity, weight, type, style, coating, UL listing, gauge, and ANY other column data. Separate each detail with a semicolon. Example: "Paper Towel Dispenser; Surface Mounted; Satin Finish; ADA Compliant; 18 ga. stainless steel; Type 304; UL Listed"
- manufacturer: The manufacturer name (e.g. "Bobrick", "Kohler", "ASI")
- model: The model number, product name, or product line exactly as shown. If there is an explicit model number (e.g. "B-2621", "K-14367-CP"), use that. If there is no model number but there IS a product name or item title shown alongside the manufacturer (e.g. "RIGID SHEET PANEL", "PALLADIUM RIGID SHEET"), use the product name/title as the model. The goal is that manufacturer + model together form a complete product identifier.
- quantity: The numeric quantity as an integer. If not visible, use 0.
- sourceSection: The schedule section name from the nearest header above this row (e.g. "ACCESSORY SCHEDULE", "FIXTURE SCHEDULE")
- confidence: Your confidence 0-100 that this row was extracted accurately. Lower this if any data is unclear.
- flags: Array of issue strings. Use these exact flag values when applicable:
  "Callout uncertain" - callout text is unclear/partial
  "Model uncertain" - model number is unclear/partial
  "Quantity uncertain" - quantity is unclear or missing
  "Manufacturer missing" - no manufacturer identified
  "Model missing" - no model number identified

DESCRIPTION FIELD — ZERO DATA LOSS RULE:
Do NOT leave any visible data from any column out of your output. Every cell in every column of the schedule row must appear somewhere in your extracted fields. If you cannot determine which field a piece of data belongs to, append it to the description field with a semicolon. It is better to have extra details in the description than to lose data.

FINAL VERIFICATION:
Before returning your response, verify:
1. Your items array length equals totalRowCount.
2. Every row from the image is represented.
3. No data from one row has been accidentally placed in another row's fields.

Response schema:
{ "totalRowCount": number, "items": [{ "planCallout": string, "description": string, "manufacturer": string, "model": string, "quantity": number, "sourceSection": string, "confidence": number, "flags": string[] }] }`;

const STRICT_RETRY_PROMPT = `You MUST return ONLY a valid JSON object matching this exact schema. No markdown, no code fences, no text before or after the JSON. Do not include any explanation.

{ "totalRowCount": number, "items": [{ "planCallout": string, "description": string, "manufacturer": string, "model": string, "quantity": number, "sourceSection": string, "confidence": number, "flags": string[] }] }

PROCESSING METHOD: Process the schedule image ONE ROW AT A TIME, top to bottom. For each row, read ALL columns left to right before moving to the next row. Count all data rows first and store as totalRowCount.

Extract ALL line items from the schedule image. Each field must be present in every item. The description field must include the item name PLUS ALL additional details from every column in the row (finish, size, mounting, material, notes, color, dimensions, ADA, fire rating, location, room numbers, type, style, gauge, coating, etc.) separated by semicolons. Do NOT discard any information — every cell visible in every row must appear in your output.

CRITICAL: Extract EVERY row from EVERY section. Do not stop early. Do not skip rows with empty callouts or missing manufacturers. If the schedule has multiple sections, include items from ALL sections. Verify your items count matches totalRowCount.`;

const VERIFICATION_PROMPT = `You are a quality assurance reviewer for construction schedule data extraction. You will receive:
1. An image of a construction schedule
2. The extracted data in JSON format

Your job is to carefully compare each extracted item against the original image and fix any errors.

CHECK FOR THESE SPECIFIC ISSUES:
- Data from one row placed in the wrong item (row misalignment)
- Missing rows that were not extracted
- Incorrect quantities, model numbers, or manufacturer names
- Description details that belong to a different row
- Merged or split rows that should be combined or separated
- Any column data that was dropped and not included in the description

PROCESS:
1. Go through the image row by row, top to bottom.
2. For each row in the image, find the corresponding item in the extracted data.
3. Verify every field matches what is shown in the image for that specific row.
4. If you find errors, correct them.
5. If rows are missing, add them.
6. Update totalRowCount if it changed.

Return the CORRECTED JSON in the exact same schema. Return ONLY valid JSON, no prose, no markdown fences.
{ "totalRowCount": number, "items": [{ "planCallout": string, "description": string, "manufacturer": string, "model": string, "quantity": number, "sourceSection": string, "confidence": number, "flags": string[] }] }`;

function formatModelNumber(manufacturer: string, rawModel: string, flags: string[]): string {
  const mfr = manufacturer.trim();
  const model = rawModel.trim();

  if (!mfr && !model) {
    if (!flags.includes("Model missing")) flags.push("Model missing");
    if (!flags.includes("Manufacturer missing")) flags.push("Manufacturer missing");
    return "";
  }

  if (!mfr && model) {
    if (!flags.includes("Manufacturer missing")) flags.push("Manufacturer missing");
    return model;
  }

  if (mfr && !model) {
    if (!flags.includes("Model missing")) flags.push("Model missing");
    return mfr;
  }

  if (mfr.toLowerCase() === "bobrick" && /^B-?\d/.test(model)) {
    const normalizedModel = model.startsWith("B-") ? model : "B-" + model.substring(1);
    return normalizedModel;
  }

  return `${mfr} ${model}`;
}

function applyFormattingRules(rawItems: z.infer<typeof RawItemSchema>[]): ScheduleItem[] {
  const items: ScheduleItem[] = rawItems.map(raw => {
    const flags = [...raw.flags];

    const modelNumber = formatModelNumber(raw.manufacturer, raw.model, flags);

    if (raw.quantity === 0 && !flags.includes("Quantity uncertain")) {
      flags.push("Quantity uncertain");
    }

    let confidence = raw.confidence;
    if (flags.includes("Quantity uncertain") && confidence > 85) confidence = 85;
    if (flags.includes("Model missing") && confidence > 80) confidence = 80;
    if (flags.includes("Manufacturer missing") && confidence > 85) confidence = 85;
    confidence = Math.max(0, Math.min(100, confidence));

    const needsReview = confidence < 90 || flags.length > 0;

    return {
      planCallout: raw.planCallout,
      description: raw.description,
      manufacturer: raw.manufacturer,
      rawModel: raw.model,
      modelNumber,
      quantity: raw.quantity,
      sourceSection: raw.sourceSection,
      confidence,
      flags,
      needsReview,
    };
  });

  const calloutCounts: Record<string, number> = {};
  for (const item of items) {
    if (item.planCallout) {
      calloutCounts[item.planCallout] = (calloutCounts[item.planCallout] || 0) + 1;
    }
  }
  for (const item of items) {
    if (item.planCallout && calloutCounts[item.planCallout] > 1) {
      if (!item.flags.includes("Possible duplicate callout")) {
        item.flags.push("Possible duplicate callout");
        item.needsReview = true;
      }
    }
  }

  return items;
}

function parseJsonFromResponse(content: string): unknown {
  let cleaned = content.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }

  return JSON.parse(cleaned);
}

function tryRepairTruncatedJson(content: string): z.infer<typeof RawItemSchema>[] | null {
  let cleaned = content.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.indexOf("{");
  if (jsonStart === -1) return null;
  cleaned = cleaned.substring(jsonStart);

  const itemsMatch = cleaned.match(/"items"\s*:\s*\[/);
  if (!itemsMatch) return null;

  const arrayStart = cleaned.indexOf("[", itemsMatch.index);
  if (arrayStart === -1) return null;

  const itemStrings: string[] = [];
  let depth = 0;
  let currentItemStart = -1;

  for (let i = arrayStart + 1; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") {
      if (depth === 0) currentItemStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && currentItemStart !== -1) {
        itemStrings.push(cleaned.substring(currentItemStart, i + 1));
        currentItemStart = -1;
      }
    }
  }

  if (itemStrings.length === 0) return null;

  const parsedItems: z.infer<typeof RawItemSchema>[] = [];
  for (const itemStr of itemStrings) {
    try {
      const obj = JSON.parse(itemStr);
      const validated = RawItemSchema.parse(obj);
      parsedItems.push(validated);
    } catch {
    }
  }

  return parsedItems.length > 0 ? parsedItems : null;
}

interface CallResult {
  items: z.infer<typeof RawItemSchema>[];
  totalRowCount: number;
  wasTruncated: boolean;
}

async function callOpenAI(imageBase64: string, mimeType: string, model: string, isRetry: boolean, continuationPrompt?: string): Promise<CallResult> {
  const systemPrompt = isRetry ? STRICT_RETRY_PROMPT : SYSTEM_PROMPT;

  const userContent: any[] = [
    {
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${imageBase64}`,
        detail: "high",
      },
    },
    {
      type: "text",
      text: continuationPrompt || "Extract all line items from this construction schedule image. Process each row one at a time, top to bottom, reading all columns left to right. Return ONLY the JSON object, nothing else.",
    },
  ];

  const response = await openai.chat.completions.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  const finishReason = response.choices?.[0]?.finish_reason;
  const wasTruncated = finishReason === "length";

  if (!content) {
    throw new Error("Empty response from OpenAI");
  }

  if (wasTruncated) {
    console.warn(`OpenAI response was truncated (finish_reason=length). Attempting to repair...`);
    const repairedItems = tryRepairTruncatedJson(content);
    if (repairedItems && repairedItems.length > 0) {
      console.log(`Repaired ${repairedItems.length} items from truncated response`);
      return { items: repairedItems, totalRowCount: 0, wasTruncated: true };
    }
    throw new Error("Response was truncated and could not be repaired");
  }

  const parsed = parseJsonFromResponse(content);
  const validated = ResponseSchema.parse(parsed);
  return { items: validated.items, totalRowCount: validated.totalRowCount || 0, wasTruncated: false };
}

async function verifyExtraction(imageBase64: string, mimeType: string, model: string, extractedItems: z.infer<typeof RawItemSchema>[], totalRowCount: number): Promise<{ items: z.infer<typeof RawItemSchema>[]; totalRowCount: number }> {
  const extractedJson = JSON.stringify({ totalRowCount, items: extractedItems }, null, 2);

  const userContent: any[] = [
    {
      type: "image_url",
      image_url: {
        url: `data:${mimeType};base64,${imageBase64}`,
        detail: "high",
      },
    },
    {
      type: "text",
      text: `Here is the extracted data from this schedule image. Please verify each row against the image and correct any errors. Pay special attention to row alignment — make sure data from each row is matched to the correct item.\n\nExtracted data:\n${extractedJson}`,
    },
  ];

  const response = await openai.chat.completions.create({
    model,
    max_tokens: MAX_TOKENS,
    temperature: 0,
    messages: [
      { role: "system", content: VERIFICATION_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    console.warn("Verification pass returned empty response, using original extraction");
    return { items: extractedItems, totalRowCount };
  }

  try {
    const parsed = parseJsonFromResponse(content);
    const validated = ResponseSchema.parse(parsed);
    console.log(`Verification pass completed: ${validated.items.length} items (was ${extractedItems.length})`);
    return { items: validated.items, totalRowCount: validated.totalRowCount || totalRowCount };
  } catch (err: any) {
    console.warn(`Verification pass failed to parse: ${err.message}. Using original extraction.`);
    return { items: extractedItems, totalRowCount };
  }
}

async function extractWithContinuation(imageBase64: string, mimeType: string, model: string): Promise<{ items: z.infer<typeof RawItemSchema>[]; totalRowCount: number; continuationUsed: boolean; possibleTruncation: boolean }> {
  let allItems: z.infer<typeof RawItemSchema>[] = [];
  let continuationUsed = false;
  let possibleTruncation = false;
  let totalRowCount = 0;

  const firstResult = await callOpenAI(imageBase64, mimeType, model, false);
  allItems = [...firstResult.items];
  totalRowCount = firstResult.totalRowCount;

  if (firstResult.wasTruncated && allItems.length > 0) {
    continuationUsed = true;
    let attempts = 0;

    while (attempts < MAX_CONTINUATION_ATTEMPTS) {
      attempts++;
      const lastCallouts = allItems.slice(-3).map(i => i.planCallout).filter(Boolean);
      const lastCallout = lastCallouts[lastCallouts.length - 1] || "";

      const continuationPrompt = `Your previous response was cut off. You already extracted these items: ${allItems.map(i => i.planCallout).filter(Boolean).join(", ")}.

Continue extracting the REMAINING items from the schedule image that come AFTER "${lastCallout}". Do NOT re-extract items you already provided. Process each remaining row one at a time, top to bottom, reading all columns left to right. Include ALL column data in the description field.

Return ONLY a JSON object with the remaining items:
{ "totalRowCount": number, "items": [{ "planCallout": string, "description": string, "manufacturer": string, "model": string, "quantity": number, "sourceSection": string, "confidence": number, "flags": string[] }] }

Set totalRowCount to the TOTAL number of data rows in the entire schedule (not just the remaining ones).`;

      console.log(`Continuation attempt ${attempts}: requesting items after "${lastCallout}" (${allItems.length} items so far)`);

      try {
        const contResult = await callOpenAI(imageBase64, mimeType, model, false, continuationPrompt);

        if (contResult.totalRowCount > totalRowCount) {
          totalRowCount = contResult.totalRowCount;
        }

        if (contResult.items.length === 0) {
          console.log(`Continuation returned 0 new items, stopping`);
          break;
        }

        const itemSignature = (i: z.infer<typeof RawItemSchema>) =>
          `${i.planCallout}|${i.description}|${i.manufacturer}|${i.model}|${i.quantity}`.toLowerCase();
        const existingSignatures = new Set(allItems.map(itemSignature));
        const newItems = contResult.items.filter(i => !existingSignatures.has(itemSignature(i)));

        if (newItems.length === 0) {
          console.log(`All continuation items were duplicates, stopping`);
          break;
        }

        console.log(`Continuation added ${newItems.length} new items`);
        allItems = [...allItems, ...newItems];

        if (!contResult.wasTruncated) {
          break;
        }
      } catch (contError: any) {
        console.warn(`Continuation attempt ${attempts} failed: ${contError.message}`);
        possibleTruncation = true;
        break;
      }
    }

    if (attempts >= MAX_CONTINUATION_ATTEMPTS) {
      possibleTruncation = true;
      console.warn(`Reached max continuation attempts (${MAX_CONTINUATION_ATTEMPTS})`);
    }
  } else if (firstResult.wasTruncated && allItems.length === 0) {
    possibleTruncation = true;
  }

  return { items: allItems, totalRowCount, continuationUsed, possibleTruncation };
}

const TEXT_SYSTEM_PROMPT = `You are a construction document data extractor. You will receive raw text from a construction schedule (accessory schedule, fixture schedule, equipment schedule, etc) that was copied/pasted from a document, email, or spreadsheet.

Parse every line item from the text into structured JSON. Return ONLY valid JSON, no prose, no markdown fences, no explanation.

PROCESSING METHOD:
1. Identify columns or data patterns in the text (tabs, pipes, consistent spacing, CSV, or free-form lists).
2. Count the total number of data rows (excluding headers and section titles). Store this as totalRowCount.
3. Process each row one at a time, from top to bottom.

CRITICAL RULES:
- Extract EVERY SINGLE data row. Do not skip any rows.
- Rows with empty/blank callouts: still extract them — use "" for planCallout.
- Rows with no manufacturer or model: still extract them — use "" and add appropriate flags.
- If the text has tab-separated or pipe-separated columns, use those delimiters to identify fields.
- If the text is free-form (paragraph-style), identify each distinct item/product and extract it as a separate row.

For each row, extract:
- planCallout: The plan callout/tag/mark (e.g. "TA-01", "PF-03"). If none, use "".
- description: The item description PLUS ALL additional details that don't map to other fields. Include finish, color, size, dimensions, mounting type, material, notes, remarks, location, room numbers, etc. Separate each detail with a semicolon.
- manufacturer: The manufacturer name (e.g. "Bobrick", "Kohler", "ASI")
- model: The model number or product name exactly as shown.
- quantity: The numeric quantity as an integer. If not visible, use 0.
- sourceSection: The schedule section name from the nearest header above this row (e.g. "ACCESSORY SCHEDULE"). If none, use "".
- confidence: Your confidence 0-100 that this row was extracted accurately.
- flags: Array of issue strings: "Callout uncertain", "Model uncertain", "Quantity uncertain", "Manufacturer missing", "Model missing"

DESCRIPTION FIELD — ZERO DATA LOSS RULE:
Do NOT leave any data out. Every piece of text in the row must appear somewhere in your extracted fields. If unsure where it belongs, append it to description with a semicolon.

Response schema:
{ "totalRowCount": number, "items": [{ "planCallout": string, "description": string, "manufacturer": string, "model": string, "quantity": number, "sourceSection": string, "confidence": number, "flags": string[] }] }`;

export async function extractScheduleFromText(text: string): Promise<ExtractionResult> {
  const startTime = Date.now();
  const modelUsed = DEFAULT_MODEL;

  const response = await openai.chat.completions.create({
    model: modelUsed,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: TEXT_SYSTEM_PROMPT },
      { role: "user", content: `Here is the schedule text to parse:\n\n${text}` },
    ],
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("No response from AI model");
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromResponse(content);
  } catch {
    const retryResponse = await openai.chat.completions.create({
      model: modelUsed,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: STRICT_RETRY_PROMPT.replace(/schedule image/g, "schedule text") },
        { role: "user", content: `Here is the schedule text to parse:\n\n${text}` },
      ],
    });
    const retryContent = retryResponse.choices?.[0]?.message?.content;
    if (!retryContent) throw new Error("No response on retry");
    parsed = parseJsonFromResponse(retryContent);
  }

  const validated = ResponseSchema.parse(parsed);
  const allRawItems = validated.items;
  let totalRowCount = validated.totalRowCount || allRawItems.length;

  const items = applyFormattingRules(allRawItems);
  const processingTimeMs = Date.now() - startTime;

  return {
    items,
    rawText: text.slice(0, 500),
    processingTimeMs,
    modelUsed,
    retried: false,
    continuationUsed: false,
    possibleTruncation: false,
    totalRowCount,
    verified: false,
  };
}

export async function extractScheduleWithAI(imageBuffer: Buffer, mimeType: string = "image/png"): Promise<ExtractionResult> {
  const startTime = Date.now();
  const imageBase64 = imageBuffer.toString("base64");

  let modelUsed = DEFAULT_MODEL;
  let retried = false;
  let continuationUsed = false;
  let possibleTruncation = false;
  let totalRowCount = 0;
  let verified = false;
  let allRawItems: z.infer<typeof RawItemSchema>[];

  try {
    const result = await extractWithContinuation(imageBase64, mimeType, DEFAULT_MODEL);
    allRawItems = result.items;
    totalRowCount = result.totalRowCount;
    continuationUsed = result.continuationUsed;
    possibleTruncation = result.possibleTruncation;
  } catch (firstError: any) {
    console.warn(`First attempt with ${DEFAULT_MODEL} failed: ${firstError.message}. Retrying with stricter prompt...`);
    retried = true;
    try {
      const retryResult = await callOpenAI(imageBase64, mimeType, DEFAULT_MODEL, true);
      allRawItems = retryResult.items;
      totalRowCount = retryResult.totalRowCount;
      if (retryResult.wasTruncated) {
        possibleTruncation = true;
      }
    } catch (retryError: any) {
      console.error(`Retry with ${DEFAULT_MODEL} also failed: ${retryError.message}. Trying ${FALLBACK_MODEL}...`);
      try {
        const fallbackResult = await extractWithContinuation(imageBase64, mimeType, FALLBACK_MODEL);
        allRawItems = fallbackResult.items;
        totalRowCount = fallbackResult.totalRowCount;
        modelUsed = FALLBACK_MODEL;
        continuationUsed = fallbackResult.continuationUsed;
        possibleTruncation = fallbackResult.possibleTruncation;
      } catch (fallbackError: any) {
        throw new Error(`Schedule extraction failed with all models: ${fallbackError.message}`);
      }
    }
  }

  if (allRawItems.length >= VERIFICATION_MIN_ITEMS) {
    console.log(`Running verification pass on ${allRawItems.length} items...`);
    try {
      const verifyResult = await verifyExtraction(imageBase64, mimeType, modelUsed, allRawItems, totalRowCount);
      allRawItems = verifyResult.items;
      totalRowCount = verifyResult.totalRowCount;
      verified = true;
      console.log(`Verification complete: ${allRawItems.length} items, totalRowCount=${totalRowCount}`);
    } catch (verifyError: any) {
      console.warn(`Verification pass failed: ${verifyError.message}. Using original extraction.`);
    }
  }

  if (totalRowCount === 0) {
    totalRowCount = allRawItems.length;
  }

  const items = applyFormattingRules(allRawItems);
  const processingTimeMs = Date.now() - startTime;

  return {
    items,
    rawText: `Extracted by ${modelUsed} (${items.length} items)`,
    processingTimeMs,
    modelUsed,
    retried,
    continuationUsed,
    possibleTruncation,
    totalRowCount,
    verified,
  };
}
