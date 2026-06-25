// =====================================================
// BUYOUT BOT — Canonical Division 10 Scope List
// =====================================================
//
// One enumerated list of standard NBS Division 10 scopes that BOTH estimate
// tab names AND vendor trade tags (mfrVendors.scopes) resolve to. This is the
// glue between the parsed estimate and the vendor list — without it, tab names
// like "Washroom Accessories" and vendor tags like "Toilet Accessories" never
// line up.
//
// Canonical names intentionally match the scope names AiPM already seeds in
// server/seedData.ts (Toilet Accessories, Toilet Partitions, Wall Protection,
// Fire Extinguisher Cabinets, Cubicle Curtains, Visual Display, Lockers,
// Shelving) so vendor `scopes` tags resolve without a migration.

/** A canonical scope is always one of CANONICAL_SCOPE_NAMES. */
export type CanonicalScope = string;

interface ScopeDef {
  /** Canonical display name — the single source of truth. */
  name: string;
  /** Alternate names / tab titles / vendor tags that resolve to this scope. */
  aliases: string[];
  /** CSI MasterFormat numeric prefixes (digits only) that map here. */
  csi: string[];
}

export const CANONICAL_SCOPE_DEFS: ScopeDef[] = [
  {
    name: "Toilet Accessories",
    aliases: [
      "toilet accessory",
      "washroom accessories",
      "washroom accessory",
      "bath accessories",
      "bathroom accessories",
      "restroom accessories",
      "restroom accessory",
      "toilet & bath accessories",
      "toilet and bath accessories",
      "accessories",
      "ta",
    ],
    csi: ["102800", "1028", "102813", "102816"],
  },
  {
    name: "Toilet Partitions",
    aliases: [
      "toilet partition",
      "toilet compartments",
      "toilet compartment",
      "restroom partitions",
      "bathroom partitions",
      "partitions",
      "compartments",
      "urinal screens",
      "privacy screens",
      "tp",
    ],
    csi: ["102113", "102100", "1021", "102114", "102116", "102119"],
  },
  {
    name: "Wall Protection",
    aliases: [
      "wall protection",
      "corner guards",
      "corner guard",
      "crash rails",
      "crash rail",
      "handrails",
      "handrail",
      "bumper guards",
      "wall guards",
      "chair rail",
      "impact protection",
      "surface protection",
      "wp",
    ],
    csi: ["102600", "1026", "102613", "102616", "102623", "102626"],
  },
  {
    name: "Fire Extinguisher Cabinets",
    aliases: [
      "fire extinguisher cabinets",
      "fire extinguisher cabinet",
      "fire extinguishers and cabinets",
      "fire extinguishers & cabinets",
      "fire extinguishers",
      "fire extinguisher",
      "fec",
      "fire cabinets",
      "extinguisher cabinets",
      "fire protection specialties",
    ],
    csi: ["104413", "104416", "104400", "1044", "104100", "1041"],
  },
  {
    name: "Cubicle Curtains",
    aliases: [
      "cubicle curtain",
      "cubicle curtains and track",
      "privacy curtains",
      "hospital curtains",
      "exam curtains",
      "curtain track",
      "cubicle track",
      "cc",
    ],
    csi: ["102123", "1021 23", "102113.23"],
  },
  {
    name: "Visual Display",
    aliases: [
      "visual display",
      "visual display boards",
      "visual display units",
      "markerboards",
      "marker boards",
      "whiteboards",
      "white boards",
      "chalkboards",
      "tackboards",
      "tack boards",
      "bulletin boards",
      "display rails",
    ],
    csi: ["101100", "1011", "101113", "101116", "101123"],
  },
  {
    name: "Lockers",
    aliases: [
      "locker",
      "metal lockers",
      "plastic lockers",
      "phenolic lockers",
      "athletic lockers",
      "wood lockers",
      "benches",
    ],
    csi: ["105113", "105100", "1051", "105116", "105126"],
  },
  {
    name: "Shelving",
    aliases: [
      "shelf",
      "metal shelving",
      "storage shelving",
      "wire shelving",
      "wall shelving",
    ],
    csi: ["105600", "1056", "105613", "104400"],
  },
  {
    name: "Signage",
    aliases: [
      "signs",
      "interior signage",
      "room signage",
      "ada signage",
      "panel signage",
      "dimensional letters",
    ],
    csi: ["101400", "1014", "101419", "101423"],
  },
  {
    name: "Operable Partitions",
    aliases: [
      "operable partition",
      "operable walls",
      "accordion partitions",
      "folding partitions",
      "movable partitions",
      "demountable partitions",
    ],
    csi: ["102239", "102200", "1022", "102226"],
  },
  {
    name: "Other Div10",
    aliases: ["other division 10", "other div 10", "miscellaneous specialties", "misc specialties", "specialties"],
    csi: ["10"],
  },
];

export const CANONICAL_SCOPE_NAMES: string[] = CANONICAL_SCOPE_DEFS.map((s) => s.name);

// Build lookup maps once at module load.
const ALIAS_MAP = new Map<string, string>();
const CSI_MAP = new Map<string, string>();

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[–—]/g, "-") // en/em dash -> hyphen
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ") // strip punctuation to spaces
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCsi(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

for (const def of CANONICAL_SCOPE_DEFS) {
  ALIAS_MAP.set(normalize(def.name), def.name);
  for (const a of def.aliases) ALIAS_MAP.set(normalize(a), def.name);
  for (const c of def.csi) {
    const n = normalizeCsi(c);
    if (n) CSI_MAP.set(n, def.name);
  }
}

/**
 * Resolve a raw string (estimate tab name, vendor trade tag, scope category)
 * to a canonical scope name. Trim + case-insensitive + alias-aware, and falls
 * back to CSI-number and substring matching for messy real-world labels.
 * Returns null when nothing plausibly matches.
 */
export function resolveScope(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = normalize(raw);
  if (!norm) return null;

  // 1. Exact canonical / alias hit.
  const exact = ALIAS_MAP.get(norm);
  if (exact) return exact;

  // 2. CSI-number embedded in the label (e.g. "10 28 00 - Toilet Accessories").
  const csiDigits = normalizeCsi(raw);
  if (csiDigits.length >= 4) {
    // Try progressively shorter prefixes (6 -> 4 digits) for a CSI match.
    for (const len of [6, 4]) {
      const prefix = csiDigits.slice(0, len);
      const hit = CSI_MAP.get(prefix);
      if (hit) return hit;
    }
  }

  // 3. Substring match against any alias (handles "10 28 00 toilet accessory schedule").
  for (const [alias, name] of ALIAS_MAP) {
    if (alias.length >= 4 && norm.includes(alias)) return name;
  }

  return null;
}

/** True when the raw label resolves to the given canonical scope. */
export function matchesScope(raw: string | null | undefined, canonical: string): boolean {
  return resolveScope(raw) === canonical;
}

/** Sheet names that are never priced scopes (trim + lowercase comparison). */
export const NON_SCOPE_SHEET_NAMES = new Set([
  "summary sheet",
  "bobrick material pricing 2025",
  "bobrick labor factors",
  "buyout",
  "po review",
  "change log",
  "print preview",
  "proposal",
]);

/** True when a sheet/tab name should be skipped by the estimate parser. */
export function isNonScopeSheet(sheetName: string): boolean {
  return NON_SCOPE_SHEET_NAMES.has(sheetName.trim().toLowerCase());
}
