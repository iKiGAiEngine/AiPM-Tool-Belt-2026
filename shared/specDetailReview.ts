// Shared types for the Spec Extractor's "Detailed Spec Review" feature.
//
// When the estimator opts in, every extracted spec section is read line-by-line
// by AI and distilled into a Short Order Form: one row per distinct material the
// section actually buys, with the fields an estimator needs to price and order
// it. Anything the spec does not say becomes an Open Item, classified as
// something to RFI, something we are assuming, or something we must qualify in
// the proposal. Section-level risks (two different wall protection panels in one
// section, fire-rated FECs, "no substitutions", etc.) become Flags.

/** What we do about a piece of information the spec never gave us. */
export type OpenItemClassification = "rfi" | "assumed" | "qualify";

export const OPEN_ITEM_LABELS: Record<OpenItemClassification, string> = {
  rfi: "RFI Required",
  assumed: "Assumed",
  qualify: "Qualify in Proposal",
};

export type FlagSeverity = "high" | "medium" | "low";

/**
 * Flags the estimator reviews before pricing. `code` is stable (used by the
 * Excel report and the UI); `label` is what a human reads.
 */
export interface SpecReviewFlagDefinition {
  code: string;
  label: string;
  severity: FlagSeverity;
  /** Shown as help text so the estimator knows why it matters. */
  why: string;
}

export const SPEC_FLAG_CATALOG: SpecReviewFlagDefinition[] = [
  {
    code: "multiple_variants",
    label: "Multiple Versions of Same Material",
    severity: "high",
    why: "The section specifies more than one type of the same product (e.g. two wall protection panel types, several visual display board types). Each type prices and orders separately.",
  },
  {
    code: "fire_rated_fec",
    label: "Fire-Rated Fire Extinguisher Cabinet",
    severity: "high",
    why: "Fire-rated FECs cost substantially more than standard cabinets and have longer lead times. Confirm which locations require the rated cabinet.",
  },
  {
    code: "fire_rating_required",
    label: "Fire Rating / Flame Spread Requirement",
    severity: "high",
    why: "The section carries a fire-rating or flame-spread requirement that limits which products qualify.",
  },
  {
    code: "no_substitutions",
    label: "No Substitutions Permitted",
    severity: "high",
    why: "Sole-source or basis-of-design-only language removes vendor competition. Price the named product.",
  },
  {
    code: "missing_manufacturer",
    label: "No Approved Manufacturer Listed",
    severity: "high",
    why: "The spec names no manufacturer for this item, so the product basis has to be assumed or an RFI issued.",
  },
  {
    code: "missing_model",
    label: "No Model / Series Number",
    severity: "medium",
    why: "Without a model number the exact product (and its price) is an assumption.",
  },
  {
    code: "custom_color_finish",
    label: "Custom or Architect-Selected Finish",
    severity: "medium",
    why: "Custom colors, premium finishes, or 'as selected by Architect' carry upcharges and longer lead times.",
  },
  {
    code: "quantity_not_specified",
    label: "Quantities Not in Spec",
    severity: "medium",
    why: "Counts must come from the drawings or a takeoff; the spec alone cannot price the section.",
  },
  {
    code: "stainless_grade_unclear",
    label: "Stainless Grade / Gauge Unclear",
    severity: "medium",
    why: "Type 304 vs 316 and gauge changes material cost materially.",
  },
  {
    code: "ada_requirement",
    label: "ADA / Accessibility Requirement",
    severity: "medium",
    why: "Accessibility requirements drive specific models, mounting heights, and sometimes extra units.",
  },
  {
    code: "mockup_required",
    label: "Mock-Up or Sample Panel Required",
    severity: "medium",
    why: "Mock-ups are a real labor and material cost that is easy to miss at bid time.",
  },
  {
    code: "extended_warranty",
    label: "Extended Warranty Required",
    severity: "medium",
    why: "Warranties beyond the manufacturer's standard usually carry a cost or a vendor qualification.",
  },
  {
    code: "owner_furnished",
    label: "Owner-Furnished / OFCI Scope",
    severity: "medium",
    why: "Confirm whether we furnish, install, or both — a common scope-gap at buyout.",
  },
  {
    code: "installation_by_others",
    label: "Installation By Others",
    severity: "medium",
    why: "The section may be supply-only; make sure the proposal says so.",
  },
  {
    code: "sustainability_requirement",
    label: "LEED / Sustainability Requirement",
    severity: "low",
    why: "Recycled content, low-VOC, or documentation requirements can restrict products and add submittal work.",
  },
  {
    code: "cross_section_reference",
    label: "References Another Section",
    severity: "low",
    why: "Scope is split across sections; make sure the related section was also extracted.",
  },
  {
    code: "open_rfi",
    label: "Open RFI Items",
    severity: "high",
    why: "Information is missing that cannot be safely assumed — issue an RFI before the bid closes.",
  },
  {
    code: "other",
    label: "Other Estimator Note",
    severity: "low",
    why: "A section-specific note that did not fit the standard flags.",
  },
];

export const SPEC_FLAG_CODES = SPEC_FLAG_CATALOG.map((f) => f.code);

export function flagDefinition(code: string): SpecReviewFlagDefinition {
  return (
    SPEC_FLAG_CATALOG.find((f) => f.code === code) || {
      code,
      label: code.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      severity: "low",
      why: "",
    }
  );
}

/** One row of the Short Order Form — one distinct material to buy. */
export interface SpecOrderFormItem {
  /** "Wall Protection Panel — Type A", "Fire Extinguisher Cabinet — Rated" */
  itemName: string;
  /** Plain-language product category. */
  materialType: string;
  /** Basis of design as written in the spec ("Construction Specialties Acrovyn 4000"). */
  basisOfDesign: string;
  manufacturers: string[];
  modelNumbers: string[];
  /** Material composition / substrate: PVC, phenolic, Type 304 SS, etc. */
  material: string;
  /** Size, gauge, thickness. */
  sizeThickness: string;
  colorFinish: string;
  mounting: string;
  fireRating: string;
  /** What the count is based on — usually "per drawings". */
  quantityBasis: string;
  /** Rooms / areas the item goes in, if the spec says. */
  locations: string;
  /** Trim, end caps, keying, anchors, blocking and similar add-ons. */
  accessories: string;
  warranty: string;
  notes: string;
}

export interface SpecReviewFlag {
  code: string;
  label: string;
  severity: FlagSeverity;
  /** What was found in this particular section. */
  detail: string;
  recommendedAction: string;
  /** Which order-form item triggered it, when it is item-specific. */
  itemName?: string;
}

export interface SpecOpenItem {
  /** The order-form field that is blank — "Color / Finish", "Quantity". */
  field: string;
  itemName?: string;
  classification: OpenItemClassification;
  /** RFI-ready question text. */
  question: string;
  /** What we will carry if nobody answers. */
  assumption: string;
  impact: FlagSeverity;
}

export interface SpecSectionDetailReview {
  sectionId: string;
  sectionNumber: string;
  title: string;
  /** Two or three sentences: what this section actually buys. */
  scopeSummary: string;
  substitutionsAllowed: "yes" | "no" | "unclear";
  items: SpecOrderFormItem[];
  flags: SpecReviewFlag[];
  openItems: SpecOpenItem[];
  /** 0–100: how much of the order form the spec was able to fill in. */
  completeness: number;
  reviewedAt: string;
  /** Set when the section could not be reviewed. */
  error?: string;
}

export const EMPTY_ORDER_FORM_ITEM: SpecOrderFormItem = {
  itemName: "",
  materialType: "",
  basisOfDesign: "",
  manufacturers: [],
  modelNumbers: [],
  material: "",
  sizeThickness: "",
  colorFinish: "",
  mounting: "",
  fireRating: "",
  quantityBasis: "",
  locations: "",
  accessories: "",
  warranty: "",
  notes: "",
};

/** Column order shared by the Excel Order Form sheet and the on-screen table. */
export const ORDER_FORM_FIELDS: { key: keyof SpecOrderFormItem; label: string; width: number }[] = [
  { key: "itemName", label: "Item", width: 30 },
  { key: "materialType", label: "Material Type", width: 24 },
  { key: "basisOfDesign", label: "Basis of Design", width: 30 },
  { key: "manufacturers", label: "Approved Manufacturers", width: 34 },
  { key: "modelNumbers", label: "Model / Series", width: 24 },
  { key: "material", label: "Material / Substrate", width: 26 },
  { key: "sizeThickness", label: "Size / Gauge / Thickness", width: 24 },
  { key: "colorFinish", label: "Color / Finish", width: 24 },
  { key: "mounting", label: "Mounting", width: 22 },
  { key: "fireRating", label: "Fire Rating", width: 18 },
  { key: "quantityBasis", label: "Quantity Basis", width: 22 },
  { key: "locations", label: "Locations", width: 24 },
  { key: "accessories", label: "Accessories / Trim", width: 26 },
  { key: "warranty", label: "Warranty", width: 20 },
  { key: "notes", label: "Notes", width: 40 },
];

export function orderFormValue(item: SpecOrderFormItem, key: keyof SpecOrderFormItem): string {
  const raw = item[key];
  if (Array.isArray(raw)) return raw.join(", ");
  return raw || "";
}

/** Blank fields are what the estimator has to chase — count them for the UI. */
export function missingFieldCount(item: SpecOrderFormItem): number {
  return ORDER_FORM_FIELDS.filter(({ key }) => !orderFormValue(item, key).trim()).length;
}

export interface DetailReviewSummary {
  sectionsReviewed: number;
  totalItems: number;
  totalFlags: number;
  highSeverityFlags: number;
  rfiCount: number;
  assumedCount: number;
  qualifyCount: number;
}

export function summarizeDetailReviews(reviews: SpecSectionDetailReview[]): DetailReviewSummary {
  const flags = reviews.flatMap((r) => r.flags);
  const openItems = reviews.flatMap((r) => r.openItems);
  return {
    sectionsReviewed: reviews.length,
    totalItems: reviews.reduce((n, r) => n + r.items.length, 0),
    totalFlags: flags.length,
    highSeverityFlags: flags.filter((f) => f.severity === "high").length,
    rfiCount: openItems.filter((o) => o.classification === "rfi").length,
    assumedCount: openItems.filter((o) => o.classification === "assumed").length,
    qualifyCount: openItems.filter((o) => o.classification === "qualify").length,
  };
}
