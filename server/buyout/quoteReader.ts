// AI quote reading for the Buyout Bot.
//
// Decision (Phase 0): AiPM has no Anthropic SDK/key — all in-app AI uses OpenAI
// gpt-4o. Per the user's call we reuse that path here instead of Fable 5. The
// output is ALWAYS unverified (aiSuggested) — a human must verify before it
// enters the buyout math (spec guardrail).

import OpenAI from "openai";
import { extractPdfText } from "../pdfUtils";
import type { AiQuoteExtraction } from "@shared/buyout/types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type { AiQuoteExtraction };

const SYSTEM_PROMPT = `You read a vendor quote for Division 10 construction materials and extract structured data.
Respond ONLY with valid JSON matching this shape:
{
  "vendor": string|null,            // company that ISSUED the quote (not the customer)
  "quoteAmount": number|null,       // grand total / net total; if absent, SUM line extended prices
  "leadTimeWeeks": number|null,     // convert any stated lead time to whole weeks
  "exclusions": string[],           // anything explicitly excluded
  "coveredLines": string[],         // short descriptions of items/lines this quote covers
  "lines": [{"description": string, "model": string|null, "qty": number|null, "unitPrice": number|null, "extendedPrice": number|null}],
  "note": string|null               // any caveat worth surfacing to the PM
}
Rules:
- quoteAmount: return a number whenever any prices are visible; never invent one.
- Be conservative: if a field is not determinable, use null (or [] for arrays).`;

function coerce(raw: any): AiQuoteExtraction {
  const num = (v: any): number | null => (typeof v === "number" && isFinite(v) ? v : null);
  return {
    vendor: typeof raw?.vendor === "string" && raw.vendor.trim() ? raw.vendor.trim() : null,
    quoteAmount: num(raw?.quoteAmount),
    leadTimeWeeks: num(raw?.leadTimeWeeks),
    exclusions: Array.isArray(raw?.exclusions) ? raw.exclusions.filter((x: any) => typeof x === "string") : [],
    coveredLines: Array.isArray(raw?.coveredLines) ? raw.coveredLines.filter((x: any) => typeof x === "string") : [],
    lines: Array.isArray(raw?.lines)
      ? raw.lines.map((l: any) => ({
          description: String(l?.description ?? ""),
          model: l?.model ? String(l.model) : undefined,
          qty: num(l?.qty) ?? undefined,
          unitPrice: num(l?.unitPrice) ?? undefined,
          extendedPrice: num(l?.extendedPrice) ?? undefined,
        }))
      : [],
    note: typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim() : null,
  };
}

/**
 * Read a quote file (PDF text or image) into a structured extraction.
 * Mirrors the existing estimateRoutes quote-reading approach: PDF -> text -> LLM,
 * image -> vision. Throws on transport errors; the route wraps it.
 */
export async function readQuoteFile(buffer: Buffer, mimeType: string): Promise<AiQuoteExtraction> {
  if (mimeType === "application/pdf") {
    const extracted = await extractPdfText(buffer);
    const text = (extracted.text || "").trim();
    if (text.length >= 10) {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Extract the quote data from this document:\n\n${text.slice(0, 12000)}` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1200,
      });
      return coerce(JSON.parse(response.choices[0].message.content || "{}"));
    }
    // Scanned PDF with no text layer — fall through to a vision attempt is not
    // available here (no rasterizer in scope); return an empty extraction so the
    // PM can type the quote manually.
    return coerce({});
  }

  if (mimeType.startsWith("image/")) {
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the quote data from this quote image:" },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1200,
    });
    return coerce(JSON.parse(response.choices[0].message.content || "{}"));
  }

  throw new Error(`Unsupported quote file type: ${mimeType}`);
}
