import OpenAI from "openai";
import { z } from "zod";
import type { ParsedPage, ScopeMaterialDetails } from "@shared/schema";
import { guessSheetNumber } from "./calloutHarvester";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-4o-mini";

export interface SpecSectionInput {
  sectionNumber: string;
  title: string;
  text: string;
  sourceFile: string;
}

const DetailItemSchema = z.object({
  typeMark: z.string().nullable().default(null),
  description: z.string().default(""),
  material: z.string().nullable().default(null),
  dimensions: z.string().nullable().default(null),
  modelNumber: z.string().nullable().default(null),
  manufacturer: z.string().nullable().default(null),
  quantity: z.string().nullable().default(null),
  source: z.string().default(""),
  notes: z.string().nullable().default(null),
});

const ScopeDetailsResponseSchema = z.object({
  specSectionNumber: z.string().nullable().default(null),
  specSectionTitle: z.string().nullable().default(null),
  requiredManufacturers: z.array(z.string()).default([]),
  items: z.array(DetailItemSchema).default([]),
});

/**
 * Words that hint a spec section belongs to a plan-parser scope. Used to pair
 * extracted spec sections with the scopes being processed.
 */
const SCOPE_SECTION_HINTS: Record<string, string[]> = {
  "Toilet Accessories": ["toilet accessor", "bath accessor", "restroom accessor", "10 28", "102800"],
  "Toilet Partitions": ["toilet compartment", "toilet partition", "10 21", "102113"],
  "Wall Protection": ["wall protection", "corner guard", "impact protection", "10 26", "102600"],
  "Fire Extinguisher Cabinets": ["fire extinguisher", "fire protection cabinet", "10 44", "104413"],
  "Cubicle Curtains": ["cubicle curtain", "curtain track", "10 21 23", "102123"],
  "Visual Display": ["visual display", "markerboard", "tackboard", "10 11", "101100"],
  "Lockers": ["locker", "10 51", "105100"],
  "Shelving": ["shelving", "10 56", "105600"],
};

export function matchSpecSectionsToScope(scope: string, sections: SpecSectionInput[]): SpecSectionInput[] {
  const hints = SCOPE_SECTION_HINTS[scope] || [scope.toLowerCase()];
  return sections.filter(s => {
    const hay = `${s.sectionNumber} ${s.title}`.toLowerCase();
    return hints.some(h => hay.includes(h.toLowerCase()));
  });
}

/**
 * Run the material-details AI pass for each scope: reads the OCR text of that
 * scope's flagged plan pages plus its matching spec sections and pulls the
 * order-ready details (type marks, dimensions, materials, models,
 * manufacturers, quantities) with the sheet/section each came from.
 *
 * Degrades gracefully: with no API key or on model errors, returns skeleton
 * entries (scope + sheet refs, empty items) so the report still generates.
 */
export async function extractScopeMaterialDetails(
  scopes: string[],
  relevantPages: ParsedPage[],
  specSections: SpecSectionInput[],
  scopeSheetRefs: Record<string, string[]>,
): Promise<ScopeMaterialDetails[]> {
  const results: ScopeMaterialDetails[] = [];
  const hasKey = !!process.env.OPENAI_API_KEY;

  for (const scope of scopes) {
    const pages = relevantPages.filter(p => p.tags.includes(scope as any));
    if (pages.length === 0) continue;

    const matchedSections = matchSpecSectionsToScope(scope, specSections);
    const skeleton: ScopeMaterialDetails = {
      scope,
      specSectionNumber: matchedSections[0]?.sectionNumber ?? null,
      specSectionTitle: matchedSections[0]?.title ?? null,
      requiredManufacturers: [],
      items: [],
      sheetReferences: scopeSheetRefs[scope] || [],
    };

    if (!hasKey) {
      results.push(skeleton);
      continue;
    }

    try {
      // Plan-page text, each chunk labeled with its sheet for source citation
      const pageChunks = pages.slice(0, 12).map(p => {
        const sheet = guessSheetNumber(p.ocrText) || `page ${p.pageNumber}`;
        return `--- SHEET ${sheet} (${p.originalFilename} p.${p.pageNumber}) ---\n${p.ocrText.slice(0, 3500)}`;
      });
      const specChunks = matchedSections.slice(0, 2).map(s =>
        `--- SPEC SECTION ${s.sectionNumber} ${s.title} ---\n${s.text.slice(0, 8000)}`
      );

      const prompt = `You are helping a Division 10 specialties estimator build a "scope short order form" for the scope: "${scope}".

From the construction plan sheets and spec section text below, extract every ORDER-READY material detail for this scope:
- type marks / callouts (e.g. WP-1, CG-2, TA-5)
- descriptions of each item
- materials (e.g. stainless steel, Acrovyn, phenolic)
- dimensions (heights, wing widths, lengths, mounting heights)
- model numbers
- manufacturers (list required/approved manufacturers separately too)
- quantities when shown
- the SOURCE each detail came from (sheet number or spec section)

Only include details that actually appear in the text. Leave a field null when the documents are silent. Do not invent model numbers or dimensions.

Respond with JSON: {"specSectionNumber": string|null, "specSectionTitle": string|null, "requiredManufacturers": string[], "items": [{"typeMark": string|null, "description": string, "material": string|null, "dimensions": string|null, "modelNumber": string|null, "manufacturer": string|null, "quantity": string|null, "source": string, "notes": string|null}]}

${specChunks.join("\n\n")}

${pageChunks.join("\n\n")}`;

      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 4096,
        temperature: 0,
      });

      const raw = response.choices[0]?.message?.content || "{}";
      const parsed = ScopeDetailsResponseSchema.parse(JSON.parse(raw));

      results.push({
        scope,
        specSectionNumber: parsed.specSectionNumber ?? skeleton.specSectionNumber,
        specSectionTitle: parsed.specSectionTitle ?? skeleton.specSectionTitle,
        requiredManufacturers: parsed.requiredManufacturers,
        items: parsed.items,
        sheetReferences: scopeSheetRefs[scope] || [],
      });
      console.log(`[BidDocs] Detail extraction for "${scope}": ${parsed.items.length} items, ${parsed.requiredManufacturers.length} manufacturers`);
    } catch (err) {
      console.error(`[BidDocs] Detail extraction failed for "${scope}":`, err instanceof Error ? err.message : err);
      results.push(skeleton);
    }
  }

  return results;
}
