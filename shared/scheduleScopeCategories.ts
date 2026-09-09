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

const NORMALIZED_LOOKUP = new Map<string, string>(
  SCHEDULE_SCOPE_CATEGORIES.map((name) => [name.toLowerCase().trim(), name])
);

/** Resolve a raw AI-returned label to one of the exact canonical category
 * strings, or null if it doesn't match any option. */
export function resolveScheduleScopeCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const norm = raw.toLowerCase().trim();
  if (!norm) return null;
  return NORMALIZED_LOOKUP.get(norm) ?? null;
}
