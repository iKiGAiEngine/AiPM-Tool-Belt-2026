// Fixed scope category options for the Schedule Converter's AI-assigned
// "Scope Category" column. Kept as an ordered list (not a Set/canonical
// scope resolver) because these are the exact labels shown in the UI
// dropdown and sent to the AI extraction prompt verbatim.
export const SCHEDULE_SCOPE_CATEGORIES = [
  "Toilet Accessories",
  "Toilet Compartments",
  "FEC",
  "Wall Protection",
  "Appliances",
  "Lockers",
  "Visual Displays",
  "Bike Racks",
  "Wire Mesh Partitions",
  "Cubicle Curtains",
  "Med Equipment",
  "Expansion Joints",
  "Shelving",
  "Equipment",
  "Window Shades",
  "Entrance Mats",
  "Mailbox",
  "Flagpole",
  "Knox Box",
  "Site Furnishing",
] as const;

export type ScheduleScopeCategory = (typeof SCHEDULE_SCOPE_CATEGORIES)[number];

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ") // strip punctuation to spaces
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip a trailing "s" so "Appliance" / "Appliances" both normalize the same way. */
function singularize(norm: string): string {
  return norm.endsWith("s") ? norm.slice(0, -1) : norm;
}

const NORMALIZED_LOOKUP = new Map<string, string>();
for (const name of SCHEDULE_SCOPE_CATEGORIES) {
  const norm = normalize(name);
  NORMALIZED_LOOKUP.set(norm, name);
  NORMALIZED_LOOKUP.set(singularize(norm), name);
}

/** Resolve a raw AI-returned label to one of the exact canonical category
 * strings, or null if it doesn't match any option. Tolerant of case,
 * punctuation, and singular/plural mismatches (e.g. "appliance" still
 * matches "Appliances") so a near-miss from the model isn't silently
 * dropped. */
export function resolveScheduleScopeCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = normalize(raw);
  if (!norm) return null;

  const exact = NORMALIZED_LOOKUP.get(norm) ?? NORMALIZED_LOOKUP.get(singularize(norm));
  if (exact) return exact;

  // Fallback: the raw label contains (or is contained in) a category name,
  // e.g. "Kitchen Appliances" -> "Appliances".
  for (const name of SCHEDULE_SCOPE_CATEGORIES) {
    const nName = normalize(name);
    if (nName.length >= 4 && (norm.includes(nName) || nName.includes(norm))) {
      return name;
    }
  }

  return null;
}
