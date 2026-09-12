// ══════════════════════════════════════════════════════════════════════════
// AiPM ESTIMATING — SCOPE CATALOG
// ══════════════════════════════════════════════════════════════════════════
//
// The canonical list of scope sections an estimate can carry. Every line item
// stores one of these ids in `estimate_line_items.category`, and every quote
// stores one in `estimate_quotes.category`.
//
// This list used to live only inside EstimatingModulePage.tsx. It moved here
// so the server (Excel export, the SharePoint/Power Automate integration API)
// resolves an id like "corner_guards" to the exact same human label
// ("Wall Protection") and CSI code the estimator sees on screen. One list, one
// set of labels — no drift between the UI, the workbook, and SharePoint.

export interface EstimateScope {
  /** Stable id stored in the database. Never rename — data references it. */
  id: string;
  /** Human label shown in the UI, the Excel workbook, and SharePoint. */
  label: string;
  /** CSI MasterFormat section number. */
  csi: string;
}

export const ALL_SCOPES: EstimateScope[] = [
  { id: "accessories",      label: "Toilet Accessories",   csi: "10 28 00" },
  { id: "partitions",       label: "Toilet Compartments",  csi: "10 21 00" },
  { id: "fire_ext",         label: "FEC",                  csi: "10 44 00" },
  { id: "corner_guards",    label: "Wall Protection",      csi: "10 26 00" },
  { id: "appliances",       label: "Appliances",           csi: "11 31 00" },
  { id: "lockers",          label: "Lockers",              csi: "10 51 00" },
  { id: "display_boards",   label: "Visual Displays",      csi: "10 11 00" },
  { id: "bike_racks",       label: "Bike Racks",           csi: "10 73 00" },
  { id: "wire_mesh",        label: "Wire Mesh Partitions", csi: "10 22 13" },
  { id: "cubicle_curtains", label: "Cubicle Curtains",     csi: "12 48 00" },
  { id: "med_equipment",    label: "Med Equipment",        csi: "11 71 00" },
  { id: "expansion_joints", label: "Expansion Joints",     csi: "07 95 00" },
  { id: "storage_units",    label: "Shelving",             csi: "10 51 13" },
  { id: "equipment",        label: "Equipment",            csi: "11 00 00" },
  { id: "entrance_mats",    label: "Entrance Mats",        csi: "12 48 13" },
  { id: "mailboxes",        label: "Mailbox",              csi: "10 55 00" },
  { id: "flagpoles",        label: "Flagpole",             csi: "10 75 00" },
  { id: "knox_box",         label: "Knox Box",             csi: "08 71 13" },
  { id: "site_furnishing",  label: "Site Furnishing",      csi: "12 93 00" },
];

/**
 * Catch-all bucket for items that arrived from an extraction without a
 * confident scope match. Not part of ALL_SCOPES — it only exists on an
 * estimate once something lands in it.
 */
export const UNCATEGORIZED_SCOPE: EstimateScope = { id: "uncategorized", label: "Uncategorized", csi: "" };

/** Every scope id including the uncategorized bucket. */
export const ALL_SCOPE_IDS: string[] = [...ALL_SCOPES.map(s => s.id), UNCATEGORIZED_SCOPE.id];

/** Look up a scope by id; falls back to the uncategorized bucket's shape. */
export function getScope(id: string): EstimateScope {
  if (id === UNCATEGORIZED_SCOPE.id) return UNCATEGORIZED_SCOPE;
  return ALL_SCOPES.find(s => s.id === id) ?? { id, label: id, csi: "" };
}

/** Human label for a scope id — "corner_guards" → "Wall Protection". */
export function scopeLabel(id: string): string {
  return getScope(id).label;
}
