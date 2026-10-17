// ─────────────────────────────────────────────────────────────────────────────
// Vendor Directory scope vocabulary.
//
// The estimate workbook's "Vendor Directory" tab is partitioned into one block
// per scope, with the scope's DISPLAY LABEL pre-filled down column A. Every
// scope tab then pulls its own vendors back out with a dynamic-array formula:
//
//   FILTER(tblVendorDirectory[Contact Name],
//          (TRIM(tblVendorDirectory[Scope]) = "Toilet Accessories") * (...))
//
// so the labels below must match the strings in column A of the template
// EXACTLY (after trimming) or a scope tab's RFQ list silently comes back empty.
// They are also, deliberately, the same 20 labels used by the Proposal Log's
// scope checklist (NBS_SCOPES in public/tools/proposal-log.html) and by the
// Schedule Converter (shared/scheduleScopeCategories.ts).
//
// Vendors, however, are tagged in `mfr_vendors.scopes` with short internal IDs
// ("accessories", "corner_guards"), and the database still holds LEGACY ids
// alongside the current ones. Matching only the current id silently drops every
// vendor that was tagged before the rename — so each label maps to the FULL set
// of ids that have ever meant it.
//
// Do NOT use shared/buyout/canonicalScopes.ts for this join. It defines only 11
// canonical scopes against these 20, returns null for 11 of them, and its
// substring fallback actively mis-resolves "Wire Mesh Partitions" to "Toilet
// Partitions" (the alias "partitions" is a substring of it) — which would put
// toilet-partition vendors on the wire-mesh RFQ list.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scope block labels, in the order the blocks appear on the Vendor Directory
 * tab of the v60b template. NOTE this is NOT the same order as NBS_SCOPES
 * (Lockers/Appliances and Equipment/Bike Racks are transposed), which is why
 * blocks are located by reading column A rather than by index.
 */
export const VENDOR_DIRECTORY_SCOPES = [
  "Toilet Accessories",
  "Toilet Compartments",
  "FEC",
  "Wall Protection",
  "Lockers",
  "Appliances",
  "Visual Displays",
  "Equipment",
  "Bike Racks",
  "Wire Mesh Partitions",
  "Cubicle Curtains",
  "Med Equipment",
  "Expansion Joints",
  "Shelving",
  "Window Shades",
  "Entrance Mats",
  "Mailbox",
  "Flagpole",
  "Knox Box",
  "Site Furnishing",
] as const;

export type VendorDirectoryScope = (typeof VENDOR_DIRECTORY_SCOPES)[number];

/**
 * Blocks that exist on the tab but are reserved for the estimator's own manual
 * entry — never written by the generator.
 */
export const MANUAL_ONLY_SCOPE_BLOCKS = ["Alternate 1", "Alternate 2", "Alternate 3"] as const;

/**
 * Scope label → every `mfr_vendors.scopes` tag id that means it.
 *
 * The first id in each list is the current/canonical one (the value
 * CONTACT_SCOPE_OPTIONS writes today); any after it are legacy ids still
 * present in vendor records. Sourced from the SCOPE_LABELS map that
 * /api/mfr/contacts-report already uses, so the two reports agree.
 */
export const SCOPE_TAG_IDS: Record<VendorDirectoryScope, string[]> = {
  "Toilet Accessories": ["accessories", "hand_dryers"],
  "Toilet Compartments": ["partitions"],
  "FEC": ["fire_ext", "fec"],
  "Wall Protection": ["corner_guards", "wall_protection"],
  "Lockers": ["lockers"],
  "Appliances": ["appliances"],
  "Visual Displays": ["display_boards", "visual_display", "projection_screens"],
  "Equipment": ["equipment"],
  "Bike Racks": ["bike_racks"],
  "Wire Mesh Partitions": ["wire_mesh", "wire_partitions"],
  "Cubicle Curtains": ["cubicle_curtains"],
  "Med Equipment": ["med_equipment", "aed"],
  "Expansion Joints": ["expansion_joints"],
  "Shelving": ["storage_units"],
  // `window_shades` does not yet exist in CONTACT_SCOPE_OPTIONS, so no vendor
  // can currently carry it and this block will populate empty until the tag is
  // added to the Vendor Database UI and vendors are re-tagged. The template
  // already has a Window Shades block, so the gap is in the tag list, not here.
  "Window Shades": ["window_shades"],
  "Entrance Mats": ["entrance_mats"],
  "Mailbox": ["mailboxes", "postal"],
  "Flagpole": ["flagpoles"],
  "Knox Box": ["knox_box"],
  "Site Furnishing": ["site_furnishing"],
};

/** Reverse index: tag id → scope label. Built once at module load. */
const LABEL_BY_TAG_ID = new Map<string, VendorDirectoryScope>();
for (const label of VENDOR_DIRECTORY_SCOPES) {
  for (const id of SCOPE_TAG_IDS[label]) LABEL_BY_TAG_ID.set(id, label);
}

/** Every tag id that maps to some scope block. */
export const KNOWN_SCOPE_TAG_IDS: ReadonlySet<string> = new Set(LABEL_BY_TAG_ID.keys());

/**
 * Resolve one `mfr_vendors.scopes` tag id to its Vendor Directory scope label,
 * or null when the id isn't one we place (e.g. "signage", "photolum", or a typo).
 * Exact id match only — no fuzzy matching, deliberately: a near-miss here means
 * a vendor lands on the wrong scope's RFQ list, which is worse than omitting it.
 */
export function scopeLabelForTagId(tagId: string | null | undefined): VendorDirectoryScope | null {
  if (!tagId) return null;
  return LABEL_BY_TAG_ID.get(tagId.trim()) ?? null;
}

/**
 * All Vendor Directory scope labels a vendor belongs under, de-duplicated and
 * returned in template block order. Unrecognised tags are ignored (surface them
 * separately rather than guessing a block).
 */
export function scopeLabelsForVendorTags(tags: readonly (string | null | undefined)[] | null | undefined): VendorDirectoryScope[] {
  if (!tags || tags.length === 0) return [];
  const hits = new Set<VendorDirectoryScope>();
  for (const t of tags) {
    const label = scopeLabelForTagId(t);
    if (label) hits.add(label);
  }
  return VENDOR_DIRECTORY_SCOPES.filter((s) => hits.has(s));
}
