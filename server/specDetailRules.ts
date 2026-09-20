// Pure rule engine behind the Detailed Spec Review.
//
// Everything here is deterministic and dependency-free (no DB, no OpenAI) so it
// can be unit-tested directly: see server/specDetailRules.test.ts. The
// orchestration that actually calls the model lives in specDetailReview.ts.

import {
  SPEC_FLAG_CODES,
  flagDefinition,
  type SpecOpenItem,
  type SpecOrderFormItem,
  type SpecReviewFlag,
} from "@shared/specDetailReview";

export interface DetailReviewTarget {
  id: string;
  sectionNumber: string;
  title: string;
  startPage: number;
  endPage: number;
}

const MAX_SECTION_CHARS = 60000;

// ── Helpers ────────────────────────────────────────────────────────────────

export function str(v: any): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ");
  return String(v).replace(/\s+/g, " ").trim();
}

function strArray(v: any): string[] {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : String(v).split(/[,;]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const cleaned = str(entry);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function severity(v: any): "high" | "medium" | "low" {
  const s = str(v).toLowerCase();
  return s === "high" || s === "medium" || s === "low" ? s : "medium";
}

function classification(v: any): SpecOpenItem["classification"] {
  const s = str(v).toLowerCase();
  if (s === "rfi" || s === "assumed" || s === "qualify") return s;
  // The model occasionally answers in prose; map the common phrasings.
  if (s.includes("rfi")) return "rfi";
  if (s.includes("assum")) return "assumed";
  return "qualify";
}

/** Section text, clipped so a very long section still fits one request. */
export function buildSectionText(pages: string[], startPage: number, endPage: number): string {
  const start = Math.max(0, Math.min(startPage, pages.length - 1));
  const end = Math.max(start, Math.min(endPage, pages.length - 1));
  const parts: string[] = [];
  let total = 0;
  for (let i = start; i <= end; i++) {
    const body = pages[i] || "";
    const chunk = `--- Page ${i + 1} ---\n${body}`;
    if (total + chunk.length > MAX_SECTION_CHARS) {
      parts.push(chunk.slice(0, Math.max(0, MAX_SECTION_CHARS - total)));
      parts.push("\n... (section text truncated)");
      break;
    }
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.join("\n\n");
}

// ── Prompt ─────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a senior Division 10 estimator reviewing a single construction specification section so it can be priced and ordered. You read the section line by line and fill out a Short Order Form.

Return ONLY a JSON object with this exact shape:
{
  "scopeSummary": "2-3 sentences: what this section actually buys",
  "substitutionsAllowed": "yes" | "no" | "unclear",
  "items": [
    {
      "itemName": "short name including the type designation when the spec uses one, e.g. 'Wall Protection Panel - Type A'",
      "materialType": "plain-language product category",
      "basisOfDesign": "manufacturer + product named as basis of design, verbatim if stated",
      "manufacturers": ["every acceptable manufacturer named"],
      "modelNumbers": ["model / series / catalog numbers"],
      "material": "composition or substrate, e.g. 'PVC/acrylic sheet', 'Type 304 stainless steel', 'solid phenolic'",
      "sizeThickness": "size, gauge, thickness as specified",
      "colorFinish": "color, finish, texture as specified",
      "mounting": "surface / recessed / semi-recessed / wall / floor / ceiling, mounting heights",
      "fireRating": "fire rating, flame spread, or ASTM class if stated, else empty",
      "quantityBasis": "what the count comes from, e.g. 'Per drawings - not stated in spec'",
      "locations": "rooms/areas named in the spec, else empty",
      "accessories": "trim, end caps, anchors, blocking, keying, filler pieces",
      "warranty": "warranty term if stated",
      "notes": "anything else that changes price or lead time"
    }
  ],
  "flags": [
    { "code": "<one of the allowed codes>", "detail": "what was found in THIS section", "recommendedAction": "what the estimator should do", "itemName": "optional - the item it applies to" }
  ],
  "openItems": [
    { "field": "the order-form field that is blank", "itemName": "optional", "classification": "rfi" | "assumed" | "qualify", "question": "RFI-ready question", "assumption": "what we carry if nobody answers", "impact": "high" | "medium" | "low" }
  ]
}

RULES:
1. Create a SEPARATE item for every distinct version of a material. If the section specifies two or more types of the same product — Type A and Type B wall protection panels, a marker board and a tack board, standard and fire-rated fire extinguisher cabinets, different partition materials — each gets its own row. Never merge them.
2. Use ONLY what the section text says. Never invent a manufacturer, model, color, or dimension. Leave a field as an empty string when the spec is silent.
3. Every field you leave empty that an estimator needs must appear in openItems, classified as:
   - "rfi" when the answer changes price materially and cannot be safely assumed (missing manufacturer, contradictory requirements, unclear fire rating, scope that may belong to another trade).
   - "assumed" when standard industry practice gives a safe default — say exactly what you are assuming.
   - "qualify" when we can bid it but the proposal must state the limit or exclusion.
4. Quantities are almost never in the spec. Say so in quantityBasis and raise it as an open item rather than guessing a count.
5. Flag codes you may use: ${SPEC_FLAG_CODES.join(", ")}. Use "other" only when nothing else fits.
6. Pay particular attention to fire extinguisher cabinets: if ANY cabinet is required to be fire-rated, flag it with "fire_rated_fec" and make the rated cabinet its own item.
7. If the section is not really a product section (general conditions, an index, a drawing list), return an empty items array and say so in scopeSummary.`;

// ── Deterministic rules ────────────────────────────────────────────────────

const FEC_HINTS = /fire\s*extinguisher|\bfec\b|extinguisher cabinet/i;
const FIRE_RATED_HINTS = /fire[\s-]*rated|rated cabinet|\b1[\s-]*(?:hour|hr)\b|\b2[\s-]*(?:hour|hr)\b|ul\s*rated/i;
const CUSTOM_FINISH_HINTS = /custom|special order|as selected by (?:the )?architect|architect'?s? selection|premium color|match existing/i;
const NO_SUB_HINTS = /no substitution|substitutions? (?:are |will )?not (?:be )?(?:permitted|accepted|allowed)|sole source|basis of design only|single source/i;
const MOCKUP_HINTS = /mock[\s-]*up|sample panel|field sample/i;
const OWNER_FURNISHED_HINTS = /owner[\s-]*furnished|ofci|ofoi|furnished by owner|by owner/i;
const INSTALL_BY_OTHERS_HINTS = /install(?:ed|ation)? by others|furnish only|supply only|not in contract|nic\b/i;
const SUSTAINABILITY_HINTS = /leed|recycled content|low[\s-]*voc|greenguard|red list|epd\b|hpd\b|declare label/i;
const ADA_HINTS = /\bada\b|accessib|barrier[\s-]*free|ansi\s*a117/i;
const STAINLESS_HINTS = /stainless/i;
const STAINLESS_RESOLVED = /type\s*(?:304|316|430)|\b(?:304|316|430)\b|\d{2}\s*gauge|\bga\.?\b/i;
const CROSS_REF_HINTS = /(?:refer to|see|specified in|furnished under)\s+section\s+\d{2}\s*\d{2}\s*\d{2}/i;
const WARRANTY_HINTS = /(\d+)\s*[-\s]*year/i;

function itemHaystack(item: SpecOrderFormItem): string {
  return [
    item.itemName, item.materialType, item.basisOfDesign, item.material,
    item.sizeThickness, item.colorFinish, item.mounting, item.fireRating,
    item.accessories, item.warranty, item.notes, item.locations,
    item.manufacturers.join(" "), item.modelNumbers.join(" "),
  ].join(" ");
}

function makeFlag(code: string, detail: string, recommendedAction: string, itemName?: string): SpecReviewFlag {
  const def = flagDefinition(code);
  return { code, label: def.label, severity: def.severity, detail, recommendedAction, itemName };
}

/**
 * Flags an estimator must never miss, derived from the parsed order form and
 * the raw section text rather than from the model's judgement.
 */
export function deterministicFlags(
  target: DetailReviewTarget,
  items: SpecOrderFormItem[],
  openItems: SpecOpenItem[],
  substitutionsAllowed: string,
  sectionText: string,
): SpecReviewFlag[] {
  const flags: SpecReviewFlag[] = [];
  const text = sectionText;
  const sectionLabel = `${target.sectionNumber} ${target.title}`;

  // Multiple versions of the same material in one section.
  if (items.length > 1) {
    flags.push(makeFlag(
      "multiple_variants",
      `${items.length} distinct products in this section: ${items.map(i => i.itemName || i.materialType || "unnamed item").join("; ")}.`,
      "Price and order each type separately — confirm the quantity split from the drawings or finish schedule.",
    ));
  }

  // Fire-rated fire extinguisher cabinets.
  const isFecSection = FEC_HINTS.test(sectionLabel) || FEC_HINTS.test(text);
  if (isFecSection) {
    const ratedItems = items.filter(i => FIRE_RATED_HINTS.test(itemHaystack(i)));
    const ratedInText = FIRE_RATED_HINTS.test(text);
    if (ratedItems.length > 0 || ratedInText) {
      flags.push(makeFlag(
        "fire_rated_fec",
        ratedItems.length > 0
          ? `Fire-rated fire extinguisher cabinet specified: ${ratedItems.map(i => i.itemName || i.materialType).join("; ")}.`
          : "Fire-rating language appears in a fire extinguisher cabinet section — rated cabinets may be required.",
        "Confirm which locations need the rated cabinet, price the rated unit separately, and check lead time.",
        ratedItems[0]?.itemName,
      ));
    }
  } else if (FIRE_RATED_HINTS.test(text)) {
    flags.push(makeFlag(
      "fire_rating_required",
      "The section carries fire-rating or flame-spread language.",
      "Verify the specified products carry the required rating and that test reports are available for submittal.",
    ));
  }

  if (str(substitutionsAllowed).toLowerCase() === "no" || NO_SUB_HINTS.test(text)) {
    flags.push(makeFlag(
      "no_substitutions",
      "Sole-source / no-substitution language found in the section.",
      "Price the named basis of design. If a substitution is needed, submit it before the bid date.",
    ));
  }

  for (const item of items) {
    const name = item.itemName || item.materialType || "Unnamed item";
    if (item.manufacturers.length === 0 && !item.basisOfDesign) {
      flags.push(makeFlag(
        "missing_manufacturer",
        `No approved manufacturer or basis of design is given for ${name}.`,
        "Issue an RFI, or state the assumed manufacturer in the proposal.",
        name,
      ));
    } else if (item.modelNumbers.length === 0) {
      flags.push(makeFlag(
        "missing_model",
        `No model or series number is given for ${name}.`,
        "Confirm the model with the manufacturer's rep before pricing.",
        name,
      ));
    }

    if (CUSTOM_FINISH_HINTS.test(item.colorFinish) || CUSTOM_FINISH_HINTS.test(item.notes)) {
      flags.push(makeFlag(
        "custom_color_finish",
        `${name}: ${item.colorFinish || item.notes}`,
        "Carry the custom-color upcharge and the longer lead time, or qualify the proposal to standard colors.",
        name,
      ));
    }

    if (STAINLESS_HINTS.test(itemHaystack(item)) && !STAINLESS_RESOLVED.test(itemHaystack(item))) {
      flags.push(makeFlag(
        "stainless_grade_unclear",
        `${name} is stainless steel but neither the type (304/316) nor the gauge is stated.`,
        "Assume Type 304 and state it in the proposal, or RFI for the grade.",
        name,
      ));
    }

    if (!item.quantityBasis.trim()) {
      flags.push(makeFlag(
        "quantity_not_specified",
        `No quantity basis captured for ${name}.`,
        "Take off the count from the drawings before pricing.",
        name,
      ));
    }
  }

  if (ADA_HINTS.test(text)) {
    flags.push(makeFlag(
      "ada_requirement",
      "Accessibility (ADA / ANSI A117.1) requirements appear in this section.",
      "Confirm accessible models and mounting heights are carried where required.",
    ));
  }
  if (MOCKUP_HINTS.test(text)) {
    flags.push(makeFlag(
      "mockup_required",
      "A mock-up or sample panel is required.",
      "Add the mock-up material and labor to the estimate.",
    ));
  }
  if (OWNER_FURNISHED_HINTS.test(text)) {
    flags.push(makeFlag(
      "owner_furnished",
      "Owner-furnished / OFCI language appears in this section.",
      "Confirm furnish vs. install responsibility and state it in the proposal.",
    ));
  }
  if (INSTALL_BY_OTHERS_HINTS.test(text)) {
    flags.push(makeFlag(
      "installation_by_others",
      "The section contains furnish-only or install-by-others language.",
      "Confirm whether our scope includes installation and qualify the proposal accordingly.",
    ));
  }
  if (SUSTAINABILITY_HINTS.test(text)) {
    flags.push(makeFlag(
      "sustainability_requirement",
      "LEED / sustainability documentation requirements appear in this section.",
      "Confirm the specified products meet the requirement and allow time for documentation.",
    ));
  }
  if (CROSS_REF_HINTS.test(text)) {
    const ref = text.match(CROSS_REF_HINTS)?.[0] || "";
    flags.push(makeFlag(
      "cross_section_reference",
      `Scope is split with another section: "${ref.trim()}".`,
      "Make sure the referenced section was extracted and that the scope split is clear.",
    ));
  }

  const warrantyMatch = text.match(WARRANTY_HINTS);
  if (warrantyMatch && parseInt(warrantyMatch[1], 10) > 1) {
    flags.push(makeFlag(
      "extended_warranty",
      `A ${warrantyMatch[1]}-year warranty is required.`,
      "Confirm the manufacturer will issue the warranty term and price any upcharge.",
    ));
  }

  const rfiCount = openItems.filter(o => o.classification === "rfi").length;
  if (rfiCount > 0) {
    flags.push(makeFlag(
      "open_rfi",
      `${rfiCount} item${rfiCount === 1 ? "" : "s"} cannot be safely assumed and need${rfiCount === 1 ? "s" : ""} an RFI.`,
      "Issue the RFIs listed on the Open Items tab before the bid closes.",
    ));
  }

  return flags;
}

export function dedupeFlags(flags: SpecReviewFlag[]): SpecReviewFlag[] {
  const byKey = new Map<string, SpecReviewFlag>();
  for (const flag of flags) {
    const key = `${flag.code}::${(flag.itemName || "").toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, flag);
      continue;
    }
    // Keep the richer of the two descriptions.
    if (flag.detail.length > existing.detail.length) {
      byKey.set(key, { ...flag, recommendedAction: flag.recommendedAction || existing.recommendedAction });
    }
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  return Array.from(byKey.values()).sort((a, b) => order[a.severity] - order[b.severity]);
}

// ── Parsing the model response ─────────────────────────────────────────────

export function parseItems(raw: any): SpecOrderFormItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i: any) => i && typeof i === "object")
    .map((i: any): SpecOrderFormItem => ({
      itemName: str(i.itemName) || str(i.name),
      materialType: str(i.materialType),
      basisOfDesign: str(i.basisOfDesign),
      manufacturers: strArray(i.manufacturers),
      modelNumbers: strArray(i.modelNumbers),
      material: str(i.material),
      sizeThickness: str(i.sizeThickness),
      colorFinish: str(i.colorFinish),
      mounting: str(i.mounting),
      fireRating: str(i.fireRating),
      quantityBasis: str(i.quantityBasis),
      locations: str(i.locations),
      accessories: str(i.accessories),
      warranty: str(i.warranty),
      notes: str(i.notes),
    }))
    .filter(i => i.itemName || i.materialType || i.basisOfDesign);
}

export function parseOpenItems(raw: any): SpecOpenItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o: any) => o && typeof o === "object")
    .map((o: any): SpecOpenItem => ({
      field: str(o.field) || "Unspecified",
      itemName: str(o.itemName) || undefined,
      classification: classification(o.classification),
      question: str(o.question),
      assumption: str(o.assumption),
      impact: severity(o.impact),
    }))
    .filter(o => o.question || o.assumption);
}

export function parseAiFlags(raw: any): SpecReviewFlag[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f: any) => f && typeof f === "object" && f.code)
    .map((f: any) => {
      const code = SPEC_FLAG_CODES.includes(str(f.code)) ? str(f.code) : "other";
      const def = flagDefinition(code);
      return {
        code,
        label: def.label,
        severity: f.severity ? severity(f.severity) : def.severity,
        detail: str(f.detail) || def.why,
        recommendedAction: str(f.recommendedAction),
        itemName: str(f.itemName) || undefined,
      };
    });
}

/** 0-100: how much of the order form the spec managed to fill in. */
export function completenessScore(items: SpecOrderFormItem[], openItems: SpecOpenItem[]): number {
  if (items.length === 0) return 0;
  const weighted: (keyof SpecOrderFormItem)[] = [
    "materialType", "basisOfDesign", "manufacturers", "modelNumbers",
    "material", "sizeThickness", "colorFinish", "mounting",
  ];
  let filled = 0;
  let total = 0;
  for (const item of items) {
    for (const key of weighted) {
      total++;
      const value = item[key];
      if (Array.isArray(value) ? value.length > 0 : str(value)) filled++;
    }
  }
  const base = total === 0 ? 0 : (filled / total) * 100;
  // Every open RFI knocks the score down — those are the real gaps.
  const penalty = openItems.filter(o => o.classification === "rfi").length * 4;
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

