import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import { createPortal } from "react-dom";
import { useParams, useLocation } from "wouter";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { useActivityTracker } from "@/hooks/use-activity-tracker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Calculator, ChevronRight, Plus, Trash2, FileText, Zap, X,
  CheckSquare, Square, AlertTriangle, BarChart3, Send, RotateCcw,
  ClipboardList, Lock, Users, ChevronDown, ChevronUp, Copy,
  Upload, ClipboardPaste, ImageIcon, BookOpen, Loader2, FileSpreadsheet,
  Paperclip, CheckCircle2, ExternalLink, RefreshCw, Info, Pencil
} from "lucide-react";
import { exportEstimateToExcel } from "@/lib/exportEstimateExcel";
import { MAX_UPLOAD_LABEL } from "@shared/uploadLimits";
import nbsLogoUrl from "@assets/image_1777258527973.png";

// ══════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════

const ALL_SCOPES = [
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

const CHECKLIST_TEMPLATE = [
  { id: "c1", stage: "intake", label: "Spec sections identified and reviewed", done: false, auto: false },
  { id: "c2", stage: "intake", label: "Scope sections confirmed with PM", done: false, auto: false },
  { id: "c3", stage: "intake", label: "Due date logged and calendar reminder set", done: false, auto: false },
  { id: "c4", stage: "intake", label: "Project added to bid schedule", done: false, auto: false },
  { id: "c5", stage: "lineItems", label: "All line items entered", done: false, auto: false },
  { id: "c6", stage: "lineItems", label: "All items priced (no $0 items)", done: false, auto: true, check: "allPriced" },
  { id: "c7", stage: "lineItems", label: "Quote backup attached for all vendor pricing", done: false, auto: true, check: "allBackup" },
  { id: "c8", stage: "lineItems", label: "RFQ sent to all relevant vendors", done: false, auto: false },
  { id: "c9", stage: "calculations", label: "Tax rate confirmed for project location", done: false, auto: false },
  { id: "c10", stage: "calculations", label: "All scope sections marked complete", done: false, auto: false },
  { id: "c11", stage: "calculations", label: "Escalation reviewed and justified", done: false, auto: false },
  { id: "c12", stage: "output", label: "Proposal reviewed by senior estimator", done: false, auto: false },
  { id: "c13", stage: "output", label: "Total synced to Proposal Log Dashboard", done: false, auto: false },
  { id: "c14", stage: "output", label: "Proposal letter generated and reviewed", done: false, auto: false },
];

// ══════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════

interface LineItem {
  id: number;
  estimateId: number;
  category: string;
  name: string;
  model: string | null;
  mfr: string | null;
  manufacturerId: number | null;
  qty: number;
  unitCost: string;
  escOverride: string | null;
  quoteId: number | null;
  source: string;
  note: string | null;
  hasBackup: boolean;
  sortOrder: number;
}

interface Quote {
  id: number;
  estimateId: number;
  category: string;
  vendor: string;
  note: string | null;
  freight: string;
  taxIncluded: boolean;
  pricingMode: string;
  lumpSumTotal: string;
  materialTotalCost: string | null;
  breakoutGroupId: number | null;
  hasBackup: boolean;
  filePath: string | null;
  status: string | null;
  latestExtractionJson: any | null;
  latestError: string | null;
  processingMetadataJson: any | null;
  rfqLogId: number | null;
}

interface VendorQuoteLineItemRow {
  id: number;
  quoteId: number;
  sortOrder: number;
  description: string | null;
  partNumber: string | null;
  qty: string | null;
  unit: string | null;
  unitCost: string | null;
  extendedCost: string | null;
  confidence: string | null;
  notes: string | null;
  isApproved: boolean;
}

interface BreakoutGroup {
  id: number;
  estimateId: number;
  code: string;
  label: string;
  type: string;
  ohOverride: string | null;
  feeOverride: string | null;
  escOverride: string | null;
  freightMethod: string;
  manualFreight: string | null;
  sortOrder: number;
}

interface BreakoutAllocation {
  id: number;
  estimateId: number;
  lineItemId: number;
  breakoutGroupId: number;
  qty: number;
}

interface EstimateVersion {
  id: number;
  estimateId: number;
  version: number;
  savedBy: string | null;
  notes: string | null;
  grandTotal: string;
  snapshotData: unknown | null;
  savedAt: string;
}

interface ReviewComment {
  id: number;
  estimateId: number;
  author: string;
  comment: string;
  resolved: boolean;
  createdAt: string;
}

interface OhApprovalEntry {
  id: number;
  estimateId: number;
  catId: string;
  catLabel: string | null;
  oldRate: string | null;
  newRate: string | null;
  requestedBy: string | null;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  status: string;
  type?: string;
}

interface ExtractedItem {
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
  suggestedScope: string | null;
  suggestedScopeCsi: string | null;
  scopeConfidence: number;
  // UI state
  _selected: boolean;
  _assignedScope: string | null;
  _id: string;
}

interface ExtractedSpecSection {
  scopeId: string;
  csiCode: string;
  specSectionNumber: string;
  specSectionTitle: string;
  content: string;
  manufacturers: string[];
  keyRequirements: string[];
  substitutionPolicy: string;
  confidence: number;
  sourcePages: string;
  // UI state
  _selected: boolean;
  _id: string;
}

interface SavedSpecSection {
  id: number;
  estimateId: number;
  scopeId: string;
  csiCode: string | null;
  specSectionNumber: string | null;
  specSectionTitle: string | null;
  content: string | null;
  manufacturers: string[];
  keyRequirements: string[];
  substitutionPolicy: string | null;
  sourcePages: string | null;
  extractionConfidence: number | null;
  createdAt: string;
  updatedAt: string;
}

interface FullEstimate {
  id: number;
  proposalLogId: number;
  estimateNumber: string;
  projectName: string;
  activeScopes: string[];
  defaultOh: string;
  defaultFee: string;
  defaultEsc: string;
  taxRate: string;
  bondRate: string;
  catOverrides: Record<string, { oh?: number; fee?: number; esc?: number }>;
  catComplete: Record<string, boolean>;
  catQuals: Record<string, { inclusions?: string; exclusions?: string; qualifications?: string }>;
  assumptions: string[];
  risks: string[];
  checklist: any[];
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
  lineItems: LineItem[];
  quotes: Quote[];
  breakoutGroups: BreakoutGroup[];
  allocations: BreakoutAllocation[];
  versions: EstimateVersion[];
  reviewComments: ReviewComment[];
  ohApprovalLog: OhApprovalEntry[];
}

// ══════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════

const fmt = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });

const n = (s: string | null | undefined) => parseFloat(s || "0") || 0;

// Auto-select the contents of a number input on focus when its value is the
// default 0 (or empty), so the user's first keystroke replaces the placeholder
// rather than appending to it (e.g. typing "4" into a "0" field becoming "04").
// Non-zero (previously typed) values are left untouched so the user can
// position the cursor and append/edit normally.
const selectIfZero = (e: React.FocusEvent<HTMLInputElement>) => {
  const v = e.target.value;
  if (v === "" || v === "0" || parseFloat(v) === 0) {
    e.target.select();
  }
};

// Dollar-amount input. Used everywhere we edit Unit Cost.
//   • type="text" + inputMode="decimal" → no spinner arrows, mobile shows numeric keypad.
//   • Unfocused: shows "$30,050" (or "$35.81") — matches the Line Total look.
//     Whole numbers render with no trailing ".00"; cents only show when there's a
//     real fractional value (35.81, 500.50).
//   • Focused: switches to the raw editable value (no commas, no "$") so typing
//     and cursor positioning stay clean.
//   • Zero unfocused → red "$0"; zero focused → empty field so you can just start typing.
type MoneyInputProps = {
  value: number | string | null | undefined;
  onChange: (raw: string) => void;
  className?: string;
  style?: React.CSSProperties;
  inputClassName?: string;
  size?: "xs" | "sm" | "md";
  ariaLabel?: string;
};
const MoneyInput: React.FC<MoneyInputProps> = ({
  value, onChange, className, style, inputClassName, size = "md", ariaLabel,
}) => {
  const [focused, setFocused] = useState(false);
  // While focused & actively typing, hold the literal user-typed string so
  // partial input like "500." or "0." is preserved across re-renders.
  // null = not actively editing → show the clean numeric value derived from props.
  const [editing, setEditing] = useState<string | null>(null);
  const numeric = typeof value === "number" ? value : parseFloat(value || "0") || 0;
  const isZero = numeric === 0;
  const hasFraction = Math.abs(numeric - Math.trunc(numeric)) > 0.0049;
  const formatted = numeric.toLocaleString("en-US", {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  });
  // Clean focused-display: zero → empty so it never blocks fresh typing;
  // whole dollars → no decimals; cents → exactly two decimals.
  const cleanFocused = isZero
    ? ""
    : (hasFraction ? numeric.toFixed(2) : String(Math.trunc(numeric)));
  const display = !focused
    ? (isZero ? "$0" : `$${formatted}`)
    : (editing !== null ? editing : cleanFocused);
  const fontClass =
    size === "xs" ? "text-xs"
    : size === "sm" ? "text-sm"
    : "text-sm";
  const inputColor = isZero ? "#ef4444" : "var(--text)";
  return (
    <div className={`flex items-center rounded ${className || ""}`} style={style}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel || "Amount in dollars"}
        value={display}
        placeholder="$0"
        onChange={e => {
          // Strip $, commas, spaces, and any non-numeric chars; keep one decimal point.
          let v = e.target.value.replace(/[^0-9.]/g, "");
          const firstDot = v.indexOf(".");
          if (firstDot !== -1) {
            v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
          }
          setEditing(v);
          onChange(v);
        }}
        onFocus={e => {
          setFocused(true);
          setEditing(null);
          // Defer select() until after React paints the focused-mode value,
          // so the user's first keystroke cleanly replaces the whole amount
          // instead of being inserted between digits of "0.00".
          const target = e.target;
          setTimeout(() => {
            try { target.select(); } catch {}
          }, 0);
        }}
        onBlur={() => {
          setFocused(false);
          setEditing(null);
        }}
        className={`flex-1 bg-transparent border-none outline-none text-right px-1.5 py-1 min-w-0 ${fontClass} ${inputClassName || ""}`}
        style={{ color: inputColor }}
      />
    </div>
  );
};

// ══════════════════════════════════════════════════
// VERSION SNAPSHOT + DIFF (auto-summary + detail)
// ══════════════════════════════════════════════════
// A snapshot captures the meaningful state of an estimate at save time so we
// can compute a diff (added/removed/changed line items, markup overrides,
// scope toggles, status, totals) against any other version on demand.
type SnapItem = {
  id: number; category: string; name: string; mfr: string | null;
  model: string | null; qty: number; unitCost: number;
};
type SnapMarkups = { oh?: number; fee?: number; esc?: number };
type EstimateSnapshotV2 = {
  v: 2;
  status: string;
  scopes: string[];
  defaults: { oh: number; fee: number; esc: number; tax: number; bond: number };
  catOverrides: Record<string, SnapMarkups>;
  items: SnapItem[];
  itemCount: number;
  quoteCount: number;
  grandTotal: number;
};
function buildSnapshot(args: {
  reviewStatus: string;
  activeScopes: string[];
  defaultOh: number; defaultFee: number; defaultEsc: number;
  taxRate: number; bondRate: number;
  catOverrides: Record<string, SnapMarkups>;
  lineItems: LineItem[];
  quoteCount: number;
  grandTotal: number;
}): EstimateSnapshotV2 {
  return {
    v: 2,
    status: args.reviewStatus,
    scopes: [...args.activeScopes].sort(),
    defaults: {
      oh: args.defaultOh, fee: args.defaultFee, esc: args.defaultEsc,
      tax: args.taxRate, bond: args.bondRate,
    },
    catOverrides: args.catOverrides || {},
    items: args.lineItems.map(li => ({
      id: li.id, category: li.category, name: li.name,
      mfr: li.mfr, model: li.model, qty: li.qty,
      unitCost: parseFloat(li.unitCost || "0") || 0,
    })),
    itemCount: args.lineItems.length,
    quoteCount: args.quoteCount,
    grandTotal: args.grandTotal,
  };
}

type ItemDiff = {
  before: SnapItem; after: SnapItem; fields: Array<"qty" | "unitCost" | "mfr" | "model" | "name" | "category">;
};
type MarkupDiff = { scope: string; field: "oh" | "fee" | "esc"; before: number | null; after: number | null };
type RateDiff = { field: "oh" | "fee" | "esc" | "tax" | "bond"; before: number; after: number };
type EstimateDiff = {
  scopes: { added: string[]; removed: string[] };
  items: { added: SnapItem[]; removed: SnapItem[]; changed: ItemDiff[]; byCategory: Record<string, { added: number; removed: number; changed: number }> };
  markups: MarkupDiff[];
  rates: RateDiff[];
  status: { before: string; after: string } | null;
  totals: { before: number; after: number };
  quotes: { before: number; after: number };
};

function diffSnapshots(prev: EstimateSnapshotV2 | null, curr: EstimateSnapshotV2): EstimateDiff {
  const empty: EstimateSnapshotV2 = prev || {
    v: 2, status: curr.status, scopes: [], defaults: curr.defaults,
    catOverrides: {}, items: [], itemCount: 0, quoteCount: 0, grandTotal: 0,
  };
  const prevSet = new Set(empty.scopes);
  const currSet = new Set(curr.scopes);
  const scopesAdded = curr.scopes.filter(s => !prevSet.has(s));
  const scopesRemoved = empty.scopes.filter(s => !currSet.has(s));

  const prevItems = new Map(empty.items.map(i => [i.id, i]));
  const currItems = new Map(curr.items.map(i => [i.id, i]));
  const itemsAdded: SnapItem[] = [];
  const itemsRemoved: SnapItem[] = [];
  const itemsChanged: ItemDiff[] = [];
  currItems.forEach((after, id) => {
    const before = prevItems.get(id);
    if (!before) { itemsAdded.push(after); return; }
    const fields: ItemDiff["fields"] = [];
    if ((before.qty || 0) !== (after.qty || 0)) fields.push("qty");
    if ((before.unitCost || 0) !== (after.unitCost || 0)) fields.push("unitCost");
    if ((before.mfr || "") !== (after.mfr || "")) fields.push("mfr");
    if ((before.model || "") !== (after.model || "")) fields.push("model");
    if ((before.name || "") !== (after.name || "")) fields.push("name");
    if ((before.category || "") !== (after.category || "")) fields.push("category");
    if (fields.length) itemsChanged.push({ before, after, fields });
  });
  prevItems.forEach((before, id) => { if (!currItems.has(id)) itemsRemoved.push(before); });
  const byCategory: Record<string, { added: number; removed: number; changed: number }> = {};
  const bump = (cat: string, k: "added" | "removed" | "changed") => {
    byCategory[cat] = byCategory[cat] || { added: 0, removed: 0, changed: 0 };
    byCategory[cat][k]++;
  };
  itemsAdded.forEach(i => bump(i.category, "added"));
  itemsRemoved.forEach(i => bump(i.category, "removed"));
  itemsChanged.forEach(d => bump(d.after.category, "changed"));

  const markups: MarkupDiff[] = [];
  const allCats = new Set([...Object.keys(empty.catOverrides || {}), ...Object.keys(curr.catOverrides || {})]);
  allCats.forEach(scope => {
    const a = empty.catOverrides[scope] || {};
    const b = curr.catOverrides[scope] || {};
    (["oh", "fee", "esc"] as const).forEach(f => {
      const av = a[f] ?? null;
      const bv = b[f] ?? null;
      if (av !== bv) markups.push({ scope, field: f, before: av, after: bv });
    });
  });

  const rates: RateDiff[] = [];
  (["oh", "fee", "esc", "tax", "bond"] as const).forEach(f => {
    const av = empty.defaults[f] || 0;
    const bv = curr.defaults[f] || 0;
    if (av !== bv) rates.push({ field: f, before: av, after: bv });
  });

  return {
    scopes: { added: scopesAdded, removed: scopesRemoved },
    items: { added: itemsAdded, removed: itemsRemoved, changed: itemsChanged, byCategory },
    markups,
    rates,
    status: empty.status !== curr.status ? { before: empty.status, after: curr.status } : null,
    totals: { before: empty.grandTotal || 0, after: curr.grandTotal || 0 },
    quotes: { before: empty.quoteCount || 0, after: curr.quoteCount || 0 },
  };
}

function summarizeDiff(diff: EstimateDiff, scopeLabel: (id: string) => string): string {
  const parts: string[] = [];
  // Items by category — pick the busiest 1-2 categories for the headline
  const catEntries = Object.entries(diff.items.byCategory)
    .map(([cat, c]) => ({ cat, total: c.added + c.removed + c.changed, ...c }))
    .filter(c => c.total > 0)
    .sort((a, b) => b.total - a.total);
  catEntries.slice(0, 2).forEach(c => {
    const segs: string[] = [];
    if (c.added) segs.push(`+${c.added}`);
    if (c.removed) segs.push(`−${c.removed}`);
    if (c.changed) segs.push(`✎${c.changed}`);
    parts.push(`${scopeLabel(c.cat)}: ${segs.join(", ")} item${c.total > 1 ? "s" : ""}`);
  });
  if (catEntries.length > 2) parts.push(`+${catEntries.length - 2} more scope${catEntries.length - 2 > 1 ? "s" : ""}`);

  if (diff.scopes.added.length) parts.push(`+${diff.scopes.added.length} scope${diff.scopes.added.length > 1 ? "s" : ""}`);
  if (diff.scopes.removed.length) parts.push(`−${diff.scopes.removed.length} scope${diff.scopes.removed.length > 1 ? "s" : ""}`);

  if (diff.markups.length === 1) {
    const m = diff.markups[0];
    parts.push(`${m.field.toUpperCase()} ${m.before ?? "—"}→${m.after ?? "—"}%`);
  } else if (diff.markups.length > 1) {
    parts.push(`${diff.markups.length} markup overrides`);
  }
  if (diff.rates.length) {
    diff.rates.slice(0, 1).forEach(r => parts.push(`${r.field.toUpperCase()} ${r.before}→${r.after}%`));
    if (diff.rates.length > 1) parts.push(`+${diff.rates.length - 1} rate change${diff.rates.length - 1 > 1 ? "s" : ""}`);
  }
  if (diff.quotes.after !== diff.quotes.before) {
    const delta = diff.quotes.after - diff.quotes.before;
    parts.push(`${delta > 0 ? "+" : ""}${delta} quote${Math.abs(delta) > 1 ? "s" : ""}`);
  }

  if (!parts.length) {
    if (diff.totals.before !== diff.totals.after) {
      return `Totals only ($${Math.round(diff.totals.before).toLocaleString()} → $${Math.round(diff.totals.after).toLocaleString()})`;
    }
    return "No changes";
  }
  return parts.join(" · ");
}

// ══════════════════════════════════════════════════
// MANUFACTURER COMBO (datalist + auto-create on miss)
// ══════════════════════════════════════════════════

interface MfrComboProps {
  value: string;
  manufacturerId: number | null;
  allMfrs: Array<{ id: number; name: string }>;
  approvedMfrs?: Array<{ manufacturerId: number; isBasisOfDesign?: boolean }>;
  scopeLabel?: string;
  onChange: (name: string, manufacturerId: number | null) => void;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
}

// Themed manufacturer combobox (replaces native <datalist>) — surfaces the
// active scope's Approved Manufacturers in a dedicated section above the
// rest of the global list. Renders the popover via portal + fixed positioning
// so it escapes parent overflow:auto containers (e.g. the line items table).
function ManufacturerCombo({ value, manufacturerId, allMfrs, approvedMfrs = [], scopeLabel, onChange, className, style, placeholder }: MfrComboProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState(value || "");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setText(value || ""); }, [value]);

  const approvedIds = useMemo(() => new Set(approvedMfrs.map(a => a.manufacturerId)), [approvedMfrs]);
  const basisOfDesignIds = useMemo(
    () => new Set(approvedMfrs.filter(a => a.isBasisOfDesign).map(a => a.manufacturerId)),
    [approvedMfrs],
  );

  // Position the portalled popover under the input and keep it pinned on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setRect({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  const { approved, others } = useMemo(() => {
    const q = text.trim().toLowerCase();
    const matches = (m: { id: number; name: string }) => !q || m.name.toLowerCase().includes(q);
    const approved = allMfrs.filter(m => approvedIds.has(m.id) && matches(m)).sort((a, b) => a.name.localeCompare(b.name));
    const others = allMfrs.filter(m => !approvedIds.has(m.id) && matches(m)).sort((a, b) => a.name.localeCompare(b.name));
    return { approved, others };
  }, [allMfrs, approvedIds, text]);

  const commit = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (manufacturerId !== null || value) onChange("", null);
      return;
    }
    const exact = allMfrs.find(m => m.name.toLowerCase() === trimmed.toLowerCase());
    if (exact) {
      if (exact.id !== manufacturerId || exact.name !== value) onChange(exact.name, exact.id);
      setText(exact.name);
      return;
    }
    setBusy(true);
    try {
      const created = await apiRequest("POST", "/api/mfr/manufacturers", { name: trimmed }) as any as { id: number; name: string };
      qc.invalidateQueries({ queryKey: ["/api/mfr/manufacturers"] });
      onChange(created.name, created.id);
      setText(created.name);
      toast({ title: "Manufacturer added", description: `"${created.name}" was added to your manufacturer list.` });
    } catch {
      toast({ title: "Could not save manufacturer", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const pick = (m: { id: number; name: string }) => {
    setText(m.name);
    if (m.id !== manufacturerId || m.name !== value) onChange(m.name, m.id);
    setOpen(false);
  };

  const totalShown = approved.length + others.length;
  const trimmedQ = text.trim();

  return (
    <>
      <input
        ref={inputRef}
        value={text}
        onChange={e => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={e => { setTimeout(() => setOpen(false), 150); commit(e.target.value); }}
        onKeyDown={e => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") setOpen(false);
        }}
        placeholder={busy ? "Saving…" : placeholder}
        className={className}
        style={style}
        disabled={busy}
        autoComplete="off"
        data-testid="input-mfr-combo"
      />
      {open && rect && createPortal(
        <div
          className="rounded shadow-lg"
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: Math.max(rect.width, 240),
            zIndex: 1000,
            background: "var(--bg-card)",
            border: "1px solid var(--border-ds)",
            maxHeight: 320,
            display: "flex",
            flexDirection: "column",
          }}
          data-testid="dropdown-mfr-suggestions"
          onMouseDown={e => e.preventDefault()}
        >
          <div style={{ overflowY: "auto", flex: 1 }}>
            {approved.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold"
                  style={{ color: "var(--text-muted)", background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)40" }}
                  data-testid="header-mfr-approved-section">
                  {scopeLabel ? `Approved for ${scopeLabel}` : "Approved for this scope"} · {approved.length}
                </div>
                {approved.map(m => (
                  <button key={`appr-${m.id}`} type="button"
                    onMouseDown={e => { e.preventDefault(); pick(m); }}
                    className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--bg3)]"
                    style={{ borderBottom: "1px solid var(--border-ds)40", color: "var(--text)", minHeight: 36 }}
                    data-testid={`option-mfr-approved-${m.id}`}>
                    <span style={{ color: "var(--gold)", flexShrink: 0 }}>★</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                    {basisOfDesignIds.has(m.id) && (
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(201,168,76,0.15)", color: "var(--gold)", flexShrink: 0 }}>BoD</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {others.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold"
                  style={{ color: "var(--text-muted)", background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)40" }}
                  data-testid="header-mfr-other-section">
                  {approved.length > 0 ? "Other manufacturers" : "All manufacturers"} · {others.length}
                </div>
                {others.slice(0, 200).map(m => (
                  <button key={`other-${m.id}`} type="button"
                    onMouseDown={e => { e.preventDefault(); pick(m); }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg3)]"
                    style={{ borderBottom: "1px solid var(--border-ds)40", color: "var(--text)", minHeight: 36, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    data-testid={`option-mfr-${m.id}`}>
                    {m.name}
                  </button>
                ))}
                {others.length > 200 && (
                  <div className="px-3 py-1.5 text-[10px] italic" style={{ color: "var(--text-muted)" }}>
                    Showing first 200 — keep typing to narrow.
                  </div>
                )}
              </>
            )}
            {totalShown === 0 && (
              <div className="px-3 py-3 text-xs" style={{ color: "var(--text-muted)" }} data-testid="text-mfr-no-matches">
                {trimmedQ
                  ? <>No matches — keep typing to add "<span style={{ color: "var(--text)" }}>{trimmedQ}</span>" as a new manufacturer.</>
                  : "No manufacturers available."}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ══════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════

function EstimatingModuleInner() {
  const [, navigate] = useLocation();
  const { id: proposalLogIdStr } = useParams<{ id: string }>();
  const proposalLogId = parseInt(proposalLogIdStr || "0");
  const { user, isAdmin, isViewer } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { hasFeature } = useFeatureAccess();
  const isMobile = useIsMobile();

  // ── Stage navigation (persisted per-estimate in localStorage so a hard reload returns to the same tab) ──
  const STAGE_STORAGE_KEY = proposalLogIdStr ? `aipm:estimating:stage:${proposalLogIdStr}` : null;
  const [stage, setStage] = useState<"intake" | "lineItems" | "calculations" | "output">(() => {
    if (typeof window === "undefined" || !STAGE_STORAGE_KEY) return "intake";
    try {
      const saved = window.localStorage.getItem(STAGE_STORAGE_KEY);
      if (saved === "intake" || saved === "lineItems" || saved === "calculations" || saved === "output") {
        return saved;
      }
    } catch { /* ignore storage errors */ }
    return "intake";
  });
  useEffect(() => {
    if (typeof window === "undefined" || !STAGE_STORAGE_KEY) return;
    try { window.localStorage.setItem(STAGE_STORAGE_KEY, stage); } catch { /* ignore */ }
  }, [stage, STAGE_STORAGE_KEY]);
  // Activity tracker is wired further down once estimateId is known.
  const [activeCat, setActiveCat] = useState<string>("");

  // ── Approved Manufacturers (RFQ Vendor Lookup) ──
  const [showAddMfrModal, setShowAddMfrModal] = useState(false);
  const [mfrSearchTerm, setMfrSearchTerm] = useState("");
  const [newMfrName, setNewMfrName] = useState("");
  const [creatingMfr, setCreatingMfr] = useState(false);

  // ── RFQ Recipient Picker ──
  const [rfqPickerMfr, setRfqPickerMfr] = useState<string | null>(null);
  const [rfqSelectedContactIds, setRfqSelectedContactIds] = useState<Set<number>>(new Set());

  // ── RFQ View Mode + Vendor-Group Picker ──
  const [rfqGroupByVendor, setRfqGroupByVendor] = useState(false);
  void setRfqGroupByVendor;
  const [rfqVendorPicker, setRfqVendorPicker] = useState<number | null>(null);
  const [rfqVendorPickerContactIds, setRfqVendorPickerContactIds] = useState<Set<number>>(new Set());

  // ── Open RFQ (ad-hoc, pick line items + send to any vendor) ──
  const [showOpenRfq, setShowOpenRfq] = useState(false);
  const [openRfqVendorMode, setOpenRfqVendorMode] = useState<"existing" | "new">("existing");
  const [openRfqExistingVendorIds, setOpenRfqExistingVendorIds] = useState<Set<number>>(new Set());
  const [openRfqVendorSearch, setOpenRfqVendorSearch] = useState("");
  const [openRfqOnlyDirect, setOpenRfqOnlyDirect] = useState(false);
  const [openRfqNewVendorName, setOpenRfqNewVendorName] = useState("");
  const [openRfqNewVendorEmail, setOpenRfqNewVendorEmail] = useState("");
  const [openRfqSelectedItemIds, setOpenRfqSelectedItemIds] = useState<Set<string>>(new Set());
  const [openRfqExtraNotes, setOpenRfqExtraNotes] = useState("");
  const [openRfqSentVendorKeys, setOpenRfqSentVendorKeys] = useState<Set<string>>(new Set());
  // Scope-aware default vendor filter for Open RFQ. Off = show only ranks A/B/C
  // (RFQ-used + scope-tagged + relevant-mfr-tagged). On = show every vendor in DB.
  const [openRfqShowAll, setOpenRfqShowAll] = useState(false);
  // ── New Vendor Quote vendor picker (mobile-friendly, scope-aware) ──
  // Same A/B/C ranking as Open RFQ; D (other) hidden behind toggle.
  const [showAllVendorsInQuote, setShowAllVendorsInQuote] = useState(false);
  const [vendorSuggestionsOpen, setVendorSuggestionsOpen] = useState(false);
  // Visual-only search inside the Per-Manufacturer RFQ Recipient Picker.
  const [rfqPickerSearch, setRfqPickerSearch] = useState("");
  // Reset the picker's visual search whenever the picker opens for a different manufacturer (or closes).
  useEffect(() => { setRfqPickerSearch(""); }, [rfqPickerMfr]);

  // ── RFQ response date overrides (per scope) and log expansion ──
  const [responseNeededByByCat, setResponseNeededByByCat] = useState<Record<string, string>>({});
  const [rfqLogExpandAll, setRfqLogExpandAll] = useState(false);
  const [rfqLogCollapsed, setRfqLogCollapsed] = useState(false);

  // ── Dirty tracking ──
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [headerExpanded, setHeaderExpanded] = useState(false);
  const [isHeaderScrolled, setIsHeaderScrolled] = useState(false);
  useEffect(() => {
    // Hysteresis prevents oscillation: collapsing shortens the page, which
    // would drop scrollY below a single threshold and immediately re-expand.
    // Use two thresholds — collapse at >120, only re-expand when <40.
    const COLLAPSE_AT = 120;
    const EXPAND_AT = 40;
    const onScroll = () => {
      const y = window.scrollY;
      setIsHeaderScrolled(prev => {
        const next = prev ? y > EXPAND_AT : y > COLLAPSE_AT;
        if (next && !prev) setHeaderExpanded(false);
        return next;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const markDirty = useCallback(() => setIsDirty(true), []);

  // ── Local mutable state (mirrors DB) ──
  const [activeScopes, setActiveScopes] = useState<string[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [breakoutGroups, setBreakoutGroups] = useState<BreakoutGroup[]>([]);
  const [allocations, setAllocations] = useState<BreakoutAllocation[]>([]);
  const [versions, setVersions] = useState<EstimateVersion[]>([]);
  const [expandedVersionId, setExpandedVersionId] = useState<number | null>(null);
  const [expandedSessionKey, setExpandedSessionKey] = useState<string | null>(null);
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  const [ohLog, setOhLog] = useState<OhApprovalEntry[]>([]);

  const [defaultOh, setDefaultOh] = useState(8);
  const [defaultFee, setDefaultFee] = useState(15);
  const [defaultEsc, setDefaultEsc] = useState(0);
  const [taxRate, setTaxRate] = useState(0);
  const [bondRate, setBondRate] = useState(0);
  const [catOverrides, setCatOverrides] = useState<Record<string, { oh?: number; fee?: number; esc?: number }>>({});
  const [catComplete, setCatComplete] = useState<Record<string, boolean>>({});
  const [catQuals, setCatQuals] = useState<Record<string, { inclusions?: string; exclusions?: string; qualifications?: string }>>({});
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [risks, setRisks] = useState<string[]>([]);
  const [checklist, setChecklist] = useState(CHECKLIST_TEMPLATE.map(c => ({ ...c })));
  const [reviewStatus, setReviewStatus] = useState("drafting");
  const [projInfo, setProjInfo] = useState<Record<string, string>>({});
  const [projInfoLoaded, setProjInfoLoaded] = useState(false);

  // ── UI state ──
  const [showNewQuote, setShowNewQuote] = useState(false);
  const [showAiParse, setShowAiParse] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [aiParsing, setAiParsing] = useState(false);
  const [parsedQuote, setParsedQuote] = useState<any>(null);
  const [newQuote, setNewQuote] = useState<{ vendor: string; note: string; freight: number; taxIncluded: boolean; pricingMode: string; lumpSumTotal: number; materialTotalCost: string; rfqLogId: number | null }>({ vendor: "", note: "", freight: 0, taxIncluded: true, pricingMode: "lump_sum", lumpSumTotal: 0, materialTotalCost: "", rfqLogId: null });
  const [newQuoteFile, setNewQuoteFile] = useState<File | null>(null);
  const [extractingTotal, setExtractingTotal] = useState(false);
  const [aiExtractNote, setAiExtractNote] = useState<string | null>(null);
  const [editingQuoteId, setEditingQuoteId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{ vendor: string; note: string; pricingMode: string; lumpSumTotal: string; freight: string; taxIncluded: boolean; materialTotalCost: string }>({ vendor: "", note: "", pricingMode: "lump_sum", lumpSumTotal: "", freight: "", taxIncluded: true, materialTotalCost: "" });
  const [showBreakoutPanel, setShowBreakoutPanel] = useState(false);
  const [showMarkupsBar, setShowMarkupsBar] = useState(false);
  const [newBreakoutGroup, setNewBreakoutGroup] = useState({ code: "", label: "", type: "building" });
  const [expandedItems, setExpandedItems] = useState<Set<number>>(new Set());
  const [showCatQuals, setShowCatQuals] = useState(false);
  const [showUnitPricing, setShowUnitPricing] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [newAssumption, setNewAssumption] = useState("");
  const [newRisk, setNewRisk] = useState("");
  const [showRfq, setShowRfq] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [newItemForm, setNewItemForm] = useState<{ planCallout: string; name: string; model: string; mfr: string; manufacturerId: number | null; qty: number; uom: string; unitCost: number; source: string }>({ planCallout: "", name: "", model: "", mfr: "", manufacturerId: null, qty: 1, uom: "EA", unitCost: 0, source: "manual" });
  const pdfParseInputRef = useRef<HTMLInputElement>(null);
  const [aiParseTab, setAiParseTab] = useState<"text" | "pdf">("text");
  const [pdfDragActive, setPdfDragActive] = useState(false);
  const [pdfParsing, setPdfParsing] = useState(false);

  // ── Vendor quote AI review state ──
  const [reviewQuote, setReviewQuote] = useState<Quote | null>(null);
  const [reviewRows, setReviewRows] = useState<VendorQuoteLineItemRow[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewProcessing, setReviewProcessing] = useState(false);
  const [reviewApproving, setReviewApproving] = useState(false);
  const [reviewChecked, setReviewChecked] = useState<Set<number>>(new Set());

  // ── Extraction panel state ──
  const [showScheduleExtractor, setShowScheduleExtractor] = useState(false);
  const [showSpecExtractor, setShowSpecExtractor] = useState(false);
  const [extractorTab, setExtractorTab] = useState<"image" | "text">("image");
  const [specExtractorTab, setSpecExtractorTab] = useState<"image" | "text" | "pdf">("pdf");
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [extractedSpecs, setExtractedSpecs] = useState<ExtractedSpecSection[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [importingItems, setImportingItems] = useState(false);
  const [savingSpecs, setSavingSpecs] = useState(false);
  const [extractPasteText, setExtractPasteText] = useState("");
  const [schedulePasteCount, setSchedulePasteCount] = useState(0);
  const [scheduleClipboardImages, setScheduleClipboardImages] = useState<File[]>([]);
  const [scheduleImagePasteCount, setScheduleImagePasteCount] = useState(0);
  const [specPasteText, setSpecPasteText] = useState("");
  const [specDropActive, setSpecDropActive] = useState(false);
  const [specPdfDropActive, setSpecPdfDropActive] = useState(false);
  const [specPdfFile, setSpecPdfFile] = useState<File | null>(null);
  const [expandedSpecSections, setExpandedSpecSections] = useState<Set<string>>(new Set());
  const [expandedSpecPanels, setExpandedSpecPanels] = useState<Set<string>>(new Set());
  const scheduleImageInputRef = useRef<HTMLInputElement>(null);
  const specImageInputRef = useRef<HTMLInputElement>(null);
  const specPdfInputRef = useRef<HTMLInputElement>(null);

  const [selectedLineItemIds, setSelectedLineItemIds] = useState<Set<number>>(new Set());
  const [isBulkActionLoading, setIsBulkActionLoading] = useState(false);
  const [activeBulkAction, setActiveBulkAction] = useState<"transfer" | "delete" | "vendorQuote" | null>(null);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isVendorQuoteModalOpen, setIsVendorQuoteModalOpen] = useState(false);
  const [transferTargetScope, setTransferTargetScope] = useState("");
  const [applyQuoteId, setApplyQuoteId] = useState("");
  const [applyQuoteOverrideCosts, setApplyQuoteOverrideCosts] = useState(false);

  // ── Fetch regions for dropdown ──
  const { data: dbRegions = [] } = useQuery<{ id: number; code: string; name: string | null; isActive: boolean }[]>({
    queryKey: ["/api/regions", "active"],
    queryFn: async () => {
      const res = await fetch("/api/regions?active=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load regions");
      return res.json();
    },
  });

  // ── Fetch proposal log entry ──
  const { data: proposalEntry } = useQuery<any>({
    queryKey: ["/api/proposal-log/entry", proposalLogId],
    queryFn: async () => {
      const r = await fetch(`/api/proposal-log/entry/${proposalLogId}`);
      if (!r.ok) throw new Error("Not found");
      return r.json();
    },
    enabled: !!proposalLogId,
  });

  // ── Fetch or create estimate ──
  const { data: estimateData, isLoading } = useQuery<FullEstimate | null>({
    queryKey: ["/api/estimates/by-proposal", proposalLogId],
    queryFn: async () => {
      const r = await fetch(`/api/estimates/by-proposal/${proposalLogId}`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: !!proposalLogId,
  });

  // ── Create estimate if not exists ──
  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const r = await apiRequest("POST", "/api/estimates", data);
      return r.json();
    },
    onSuccess: (est: FullEstimate) => {
      qc.setQueryData(["/api/estimates/by-proposal", proposalLogId], est);
      initFromEstimate(est);
    },
  });

  // ── Initialize local state from fetched data ──
  const initFromEstimate = useCallback((est: FullEstimate) => {
    setActiveScopes(est.activeScopes || []);
    setLineItems(est.lineItems || []);
    setQuotes(est.quotes || []);
    setBreakoutGroups(est.breakoutGroups || []);
    setAllocations(est.allocations || []);
    setVersions(est.versions || []);
    setReviewComments(est.reviewComments || []);
    setOhLog(est.ohApprovalLog || []);
    setDefaultOh(n(est.defaultOh));
    setDefaultFee(n(est.defaultFee));
    setDefaultEsc(n(est.defaultEsc));
    setTaxRate(n(est.taxRate));
    setBondRate(n(est.bondRate));
    setCatOverrides((est.catOverrides as any) || {});
    setCatComplete((est.catComplete as any) || {});
    setCatQuals((est.catQuals as any) || {});
    setAssumptions(est.assumptions || []);
    setRisks(est.risks || []);
    setReviewStatus(est.reviewStatus || "drafting");
    if (est.checklist && est.checklist.length > 0) {
      setChecklist(est.checklist);
    }
    if (est.activeScopes?.length > 0 && !activeCat) {
      setActiveCat(est.activeScopes[0]);
    }
    setIsDirty(false);
  }, [activeCat]);

  // Track which estimate id has already been hydrated into local state.
  // Once hydrated, we ignore subsequent refetches so they cannot blow away
  // unsaved local edits (line items, scope toggles, etc). All ongoing
  // changes flow through immediate API mutations + local setState.
  const initializedEstimateIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (estimateData === null && proposalEntry) {
      // Seed activeScopes from proposal log's nbsSelectedScopes if available
      let seedScopes: string[] = [];
      try {
        const nbsLabels: string[] = proposalEntry.nbsSelectedScopes ? JSON.parse(proposalEntry.nbsSelectedScopes) : [];
        seedScopes = nbsLabels
          .map((label: string) => ALL_SCOPES.find(s => s.label === label)?.id)
          .filter(Boolean) as string[];
      } catch { seedScopes = []; }
      // Create estimate from proposal log entry
      createMutation.mutate({
        proposalLogId,
        estimateNumber: proposalEntry.estimateNumber || proposalEntry.pvNumber || `PV-${proposalLogId}`,
        projectName: proposalEntry.projectName || "Untitled Project",
        activeScopes: seedScopes,
        createdBy: user?.displayName || user?.username || user?.email || null,
      });
    } else if (estimateData && initializedEstimateIdRef.current !== estimateData.id) {
      initFromEstimate(estimateData);
      initializedEstimateIdRef.current = estimateData.id;
    }
  }, [estimateData, proposalEntry]);

  // ── Categories derived from active scopes ──
  const CATEGORIES = useMemo(() => ALL_SCOPES.filter(s => activeScopes.includes(s.id)), [activeScopes]);

  useEffect(() => {
    if (CATEGORIES.length > 0 && (!activeCat || !activeScopes.includes(activeCat))) {
      setActiveCat(CATEGORIES[0].id);
    }
  }, [CATEGORIES, activeCat, activeScopes]);

  // ── Warn before browser close / refresh / hard navigation when there are unsaved changes ──
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // ── Clear selection when leaving line items stage ──
  useEffect(() => {
    if (stage !== "lineItems") setSelectedLineItemIds(new Set());
  }, [stage]);

  // ══════════════════════════════════════════════════
  // CALCULATIONS ENGINE
  // ══════════════════════════════════════════════════

  const calcData = useMemo(() => {
    const data: Record<string, any> = {};
    ALL_SCOPES.forEach(cat => {
      const items = lineItems.filter(i => i.category === cat.id);
      const catQ = quotes.filter(q => q.category === cat.id);
      const material = items.reduce((s, i) => s + n(i.unitCost) * i.qty, 0);
      const lumpAdj = catQ.reduce((s, q) => {
        if (q.pricingMode === "lump_sum" && n(q.lumpSumTotal) > 0) {
          const qTotal = items.filter(i => i.quoteId === q.id).reduce((ss, i) => ss + n(i.unitCost) * i.qty, 0);
          return s + Math.max(0, n(q.lumpSumTotal) - qTotal);
        }
        return s;
      }, 0);
      const effMat = material + lumpAdj;
      const escRate = catOverrides[cat.id]?.esc ?? defaultEsc;
      const isEscOvr = catOverrides[cat.id]?.esc != null;
      const escalation = items.reduce((s, i) => {
        const r = i.escOverride != null ? n(i.escOverride) : escRate;
        return s + n(i.unitCost) * i.qty * (r / 100);
      }, 0) + lumpAdj * (escRate / 100);
      const totalFreight = catQ.reduce((s, q) => s + n(q.freight), 0);
      const subtotal = effMat + escalation + totalFreight;
      const ohRate = catOverrides[cat.id]?.oh ?? defaultOh;
      const isOhOvr = catOverrides[cat.id]?.oh != null;
      const oh = subtotal * (ohRate / 100);
      const ohImpact = oh - subtotal * (defaultOh / 100);
      const feeRate = catOverrides[cat.id]?.fee ?? defaultFee;
      const isFeeOvr = catOverrides[cat.id]?.fee != null;
      const feePct = feeRate / 100;
      const fee = feePct <= 0 || feePct >= 1 ? 0 : (subtotal / (1 - feePct)) - subtotal;
      const defaultFeePct = defaultFee / 100;
      const defaultFeeAmt = defaultFeePct <= 0 || defaultFeePct >= 1 ? 0 : (subtotal / (1 - defaultFeePct)) - subtotal;
      const feeImpact = fee - defaultFeeAmt;
      const escImpact = escalation - effMat * (defaultEsc / 100);
      const tax = effMat * (taxRate / 100);
      const bond = subtotal * (bondRate / 100);
      const total = subtotal + oh + fee + tax + bond;
      const missingBackup = items.filter(i => !i.hasBackup).length;
      const isComplete = catComplete[cat.id] || false;
      data[cat.id] = {
        items: items.length, material: effMat, escalation, escRate, isEscOvr, escImpact,
        totalFreight, catQuotes: catQ, subtotal, ohRate, isOhOvr, oh, ohImpact,
        feeRate, isFeeOvr, fee, feeImpact, tax, bond, total, missingBackup, isComplete,
      };
    });
    const g = (fn: (d: any) => number) => Object.values(data).reduce((s, d) => s + fn(d), 0);
    const allMat = g(d => d.material), allEsc = g(d => d.escalation), allFrt = g(d => d.totalFreight);
    const allSub = g(d => d.subtotal), allOh = g(d => d.oh), allFee = g(d => d.fee);
    const allTax = g(d => d.tax), allBond = g(d => d.bond);
    const grandTotal = allSub + allOh + allFee + allTax + allBond;
    return { ...data, allMat, allEsc, allFrt, allSub, allOh, allFee, allTax, allBond, grandTotal };
  }, [lineItems, quotes, catOverrides, defaultOh, defaultFee, defaultEsc, taxRate, bondRate, catComplete]);

  // ── Breakout calculations ──
  const allocMap = useMemo(() => {
    const m: Record<number, Record<number, number>> = {};
    allocations.forEach(a => {
      if (!m[a.lineItemId]) m[a.lineItemId] = {};
      m[a.lineItemId][a.breakoutGroupId] = a.qty;
    });
    return m;
  }, [allocations]);

  const breakoutCalcData = useMemo(() => {
    if (breakoutGroups.length === 0) return {};
    const data: Record<number, any> = {};
    breakoutGroups.forEach(group => {
      let material = 0; let itemCount = 0;
      lineItems.forEach(item => {
        const allocQty = allocMap[item.id]?.[group.id] || 0;
        if (allocQty > 0) { material += n(item.unitCost) * allocQty; itemCount++; }
      });
      const ohRate = n(group.ohOverride) || defaultOh;
      const feeRate = n(group.feeOverride) || defaultFee;
      const escRate = n(group.escOverride) || defaultEsc;
      const escalation = material * (escRate / 100);
      const totalMat = calcData.allMat || 1;
      const freight = group.freightMethod === "manual" && group.manualFreight != null
        ? n(group.manualFreight)
        : totalMat > 0 ? (material / totalMat) * calcData.allFrt : 0;
      const subtotal = material + escalation + freight;
      const oh = subtotal * (ohRate / 100);
      const breakoutFeePct = feeRate / 100;
      const fee = breakoutFeePct <= 0 || breakoutFeePct >= 1 ? 0 : (subtotal / (1 - breakoutFeePct)) - subtotal;
      const tax = material * (taxRate / 100);
      const bond = subtotal * (bondRate / 100);
      const total = subtotal + oh + fee + tax + bond;
      data[group.id] = { material, escalation, freight, subtotal, oh, fee, tax, bond, total, itemCount, ohRate, feeRate, escRate };
    });
    return data;
  }, [breakoutGroups, lineItems, allocMap, defaultOh, defaultFee, defaultEsc, taxRate, bondRate, calcData]);

  // ── Breakout validation ──
  const breakoutValidation = useMemo(() => {
    if (breakoutGroups.length === 0) return { valid: true, issues: [], allocatedCount: 0, totalItems: lineItems.length };
    const issues: any[] = [];
    let allocatedCount = 0;
    lineItems.forEach(item => {
      const allocs = allocMap[item.id] || {};
      const totalAlloc = Object.values(allocs).reduce((s: number, q: any) => s + (q || 0), 0);
      if (totalAlloc > 0) allocatedCount++;
      if (Object.keys(allocs).length > 0 && totalAlloc !== item.qty) {
        issues.push({ itemId: item.id, itemName: item.name, parentQty: item.qty, allocatedQty: totalAlloc, delta: totalAlloc - item.qty, type: totalAlloc > item.qty ? "over" : "under" });
      }
    });
    return { valid: issues.length === 0, issues, allocatedCount, totalItems: lineItems.length };
  }, [lineItems, allocMap, breakoutGroups]);

  // ── Auto checklist ──
  const autoChecklist = useMemo(() => {
    const allItems = lineItems.length;
    const allPriced = allItems > 0 && lineItems.filter(i => n(i.unitCost) === 0 && !quotes.find(q => q.id === i.quoteId && q.pricingMode === "lump_sum")).length === 0;
    const allBackup = allItems > 0 && lineItems.filter(i => !i.hasBackup).length === 0;
    return { allPriced, allBackup };
  }, [lineItems, quotes]);

  const effectiveChecklist = useMemo(() => checklist.map(c => {
    if (c.auto && c.check && autoChecklist[c.check as keyof typeof autoChecklist] !== undefined) {
      return { ...c, done: autoChecklist[c.check as keyof typeof autoChecklist] };
    }
    return c;
  }), [checklist, autoChecklist]);

  // ── Progress ──
  const progress = useMemo(() => {
    const intakeChecks = effectiveChecklist.filter(c => c.stage === "intake");
    const intakePct = intakeChecks.length > 0 ? (intakeChecks.filter(c => c.done).length / intakeChecks.length) * 100 : 0;
    const activeCatList = CATEGORIES.filter(c => calcData[c.id]?.items > 0);
    const catScores = activeCatList.map(c => {
      const d = calcData[c.id];
      const hasItems = d.items > 0 ? 25 : 0;
      const allPriced = d.items > 0 ? 25 * (lineItems.filter(i => i.category === c.id && n(i.unitCost) > 0).length / d.items) : 0;
      const allBackup = d.items > 0 ? 25 * ((d.items - d.missingBackup) / d.items) : 0;
      const complete = d.isComplete ? 25 : 0;
      return hasItems + allPriced + allBackup + complete;
    });
    const lineItemsPct = catScores.length > 0 ? catScores.reduce((s, v) => s + v, 0) / catScores.length : 0;
    const calcChecks = effectiveChecklist.filter(c => c.stage === "calculations");
    const calcsPct = calcChecks.length > 0 ? (calcChecks.filter(c => c.done).length / calcChecks.length) * 100 : 0;
    const outChecks = effectiveChecklist.filter(c => c.stage === "output");
    const outputPct = outChecks.length > 0 ? (outChecks.filter(c => c.done).length / outChecks.length) * 100 : 0;
    const overall = (intakePct * 10 + lineItemsPct * 50 + calcsPct * 15 + outputPct * 25) / 100;
    return { overall, intakePct, lineItemsPct, calcsPct, outputPct };
  }, [effectiveChecklist, CATEGORIES, calcData, lineItems]);

  // ══════════════════════════════════════════════════
  // MUTATIONS
  // ══════════════════════════════════════════════════

  const estimateId = estimateData?.id;

  // Track active engagement time for admin analytics. Per-scope tracking
  // is only meaningful in the Line Items stage; other stages report a null scope.
  useActivityTracker({
    estimateId,
    stage,
    scope: stage === "lineItems" ? (activeCat || null) : null,
  });

  // Save top-level estimate settings.
  // statusOverride: when provided, this value is sent to the API directly —
  // bypassing the React state that may not have updated yet (e.g. Mark as Submitted).
  // noteOverride: when provided, used as the version-history note instead of the
  // auto-generated change summary (for stage/status checkpoints).
  const saveEstimate = useCallback(async (statusOverride?: string, noteOverride?: string, silent?: boolean) => {
    if (!estimateId) {
      toast({ title: "Cannot save", description: "Estimate is not loaded yet.", variant: "destructive" });
      return;
    }
    const effectiveStatus = statusOverride ?? reviewStatus;
    if (statusOverride) setReviewStatus(statusOverride);
    setIsSaving(true);

    // Stage 1: persist estimate record
    try {
      await apiRequest("PATCH", `/api/estimates/${estimateId}`, {
        activeScopes, defaultOh: String(defaultOh), defaultFee: String(defaultFee),
        defaultEsc: String(defaultEsc), taxRate: String(taxRate), bondRate: String(bondRate),
        catOverrides, catComplete, catQuals, assumptions, risks,
        checklist: effectiveChecklist, reviewStatus: effectiveStatus,
      });
    } catch (err: any) {
      const detail = err?.message || "Unknown error";
      toast({ title: "Save failed", description: detail, variant: "destructive" });
      setIsSaving(false);
      return;
    }

    // Stage 1b: persist breakout allocations (bulk replace).
    // Allocation edits live in local React state until this runs — without
    // it, every quantity the estimator typed into a breakout cell is lost
    // on the next page load.
    try {
      await apiRequest("POST", `/api/estimates/${estimateId}/allocations/bulk`, {
        allocations: allocations.map(a => ({
          lineItemId: a.lineItemId,
          breakoutGroupId: a.breakoutGroupId,
          qty: a.qty || 0,
        })),
      });
    } catch (err: any) {
      const detail = err?.message || "Unknown error";
      toast({ title: "Breakout save failed", description: `Allocations could not be saved: ${detail}`, variant: "destructive" });
      setIsSaving(false);
      return;
    }

    // Stage 2: save version snapshot (non-blocking on failure)
    const userName = user?.displayName || user?.username || user?.email || "Unknown";
    const snapshot = buildSnapshot({
      reviewStatus: effectiveStatus,
      activeScopes,
      defaultOh, defaultFee, defaultEsc, taxRate, bondRate,
      catOverrides,
      lineItems,
      quoteCount: quotes.length,
      grandTotal: calcData.grandTotal,
    });
    const prevSnap = (versions[0]?.snapshotData as any) as EstimateSnapshotV2 | undefined;
    const hasV2Prev = prevSnap?.v === 2;
    const diff = diffSnapshots(hasV2Prev ? prevSnap : null, snapshot);
    const scopeLabel = (id: string) => ALL_SCOPES.find(s => s.id === id)?.label || id;
    // For the very first save, or the first save after upgrading from a legacy
    // (pre-snapshot) version, we have nothing meaningful to diff against — so
    // record a friendly baseline note instead of declaring everything "added".
    const baselineNote = `Snapshot baseline — ${snapshot.itemCount} item${snapshot.itemCount === 1 ? "" : "s"}, ${fmt(snapshot.grandTotal)}`;
    const autoSummary = hasV2Prev ? summarizeDiff(diff, scopeLabel) : baselineNote;
    const versionNote = noteOverride || (versions.length === 0 ? "Initial save" : autoSummary);
    try {
      await apiRequest("POST", `/api/estimates/${estimateId}/save-version`, {
        savedBy: userName, notes: versionNote, grandTotal: calcData.grandTotal,
        snapshotData: snapshot,
      });
    } catch { /* version snapshot failure is non-critical */ }

    // Stage 3: sync to proposal log
    if (!proposalLogId) {
      toast({ title: "Saved (not synced)", description: "Estimate saved, but there is no linked Proposal Log entry — sync was skipped.", variant: "destructive" });
      setIsDirty(false);
      setLastSaved(new Date());
      setIsSaving(false);
      return;
    }
    try {
      const syncRes = await apiRequest("POST", `/api/estimates/${estimateId}/sync-to-proposal`, {
        grandTotal: calcData.grandTotal, reviewStatus: effectiveStatus,
      });
      const syncData = await syncRes.json();
      if (effectiveStatus === "submitted" && syncData.rowsUpdated === 0) {
        toast({ title: "Sync warning", description: "Estimate saved, but the linked Proposal Log entry could not be found to update. Check that the proposal log link is valid.", variant: "destructive" });
        setIsDirty(false);
        setLastSaved(new Date());
        setIsSaving(false);
        return;
      }
    } catch {
      toast({ title: "Proposal Log sync failed", description: "Estimate was saved, but the status could not be synced to the Proposal Log Dashboard.", variant: "destructive" });
      setIsDirty(false);
      setLastSaved(new Date());
      setIsSaving(false);
      return;
    }

    // Stage 4: sync project info fields back to proposal log entry
    try {
      const scopeLabels = activeScopes
        .map(id => ALL_SCOPES.find(s => s.id === id)?.label)
        .filter(Boolean) as string[];
      const { nbsEstimator: _skip, estimateStatus: _skipStatus, ...projInfoPatch } = projInfo;
      await apiRequest("PATCH", `/api/proposal-log/entry/${proposalLogId}`, {
        ...projInfoPatch,
        nbsSelectedScopes: JSON.stringify(scopeLabels),
      });
      qc.invalidateQueries({ queryKey: ["/api/proposal-log/entry", proposalLogId] });
      qc.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
    } catch { /* project info patch failure is non-critical — log entry sync already succeeded */ }

    qc.invalidateQueries({ queryKey: ["/api/estimates/by-proposal", proposalLogId] });
    setVersions(v => [{ id: Date.now(), estimateId: estimateId!, version: (v[0]?.version || 0) + 1, savedBy: userName, notes: versionNote, grandTotal: String(calcData.grandTotal), snapshotData: snapshot as any, savedAt: new Date().toISOString() }, ...v]);
    setIsDirty(false);
    setLastSaved(new Date());
    if (!silent) {
      toast({
        title: effectiveStatus === "submitted" ? "Marked as Submitted" : "Saved",
        description: effectiveStatus === "submitted"
          ? "Estimate submitted. Proposal Log Dashboard status updated to Submitted."
          : "Estimate saved and synced to Proposal Log Dashboard.",
      });
    }
    setIsSaving(false);
  }, [estimateId, activeScopes, defaultOh, defaultFee, defaultEsc, taxRate, bondRate, catOverrides, catComplete, catQuals, assumptions, risks, effectiveChecklist, reviewStatus, calcData, lineItems, quotes, versions, user, proposalLogId, projInfo, allocations]);

  // Stage transition + status checkpoint helpers.
  // When the user explicitly moves between stages or changes review status,
  // auto-save a labeled checkpoint version so the timeline shows meaningful
  // milestones ("Moved to Markups", "Status: drafting → ready_for_review")
  // instead of relying on a manual save with a generic note.
  const STAGE_LABELS: Record<string, string> = {
    intake: "Project Info", lineItems: "Line Items", calculations: "Markups", output: "Proposal",
  };
  const goToStage = useCallback(async (next: string) => {
    if (!estimateId || stage === next) { setStage(next as any); return; }
    if (isDirty && !isSaving) {
      await saveEstimate(undefined, `Moved to ${STAGE_LABELS[next] || next}`, true);
    }
    setStage(next as any);
  }, [estimateId, stage, isDirty, isSaving, saveEstimate]);

  const STATUS_LABELS: Record<string, string> = {
    drafting: "Drafting", ready_for_review: "Ready for Review",
    reviewed: "Approved", submitted: "Submitted",
  };
  const changeReviewStatus = useCallback(async (next: string) => {
    if (!estimateId || reviewStatus === next) return;
    const prev = reviewStatus;
    setReviewStatus(next);
    if (!isSaving) {
      await saveEstimate(next, `Status: ${STATUS_LABELS[prev] || prev} → ${STATUS_LABELS[next] || next}`);
    }
  }, [estimateId, reviewStatus, isSaving, saveEstimate]);

  // ── Line item mutations ──
  const addLineItem = useCallback(async () => {
    if (guardViewer(isViewer, toast)) return;
    if (!estimateId || !newItemForm.name.trim()) return;
    try {
      const r = await apiRequest("POST", `/api/estimates/${estimateId}/line-items`, {
        category: activeCat, planCallout: newItemForm.planCallout || null, name: newItemForm.name.trim(),
        model: newItemForm.model || null, mfr: newItemForm.mfr || null,
        manufacturerId: newItemForm.manufacturerId,
        qty: newItemForm.qty, uom: newItemForm.uom || "EA", unitCost: String(newItemForm.unitCost),
        source: newItemForm.source, hasBackup: false,
      });
      const item = await r.json();
      setLineItems(prev => [...prev, item]);
      setNewItemForm({ planCallout: "", name: "", model: "", mfr: "", manufacturerId: null, qty: 1, uom: "EA", unitCost: 0, source: "manual" });
      setAddingItem(false);
      markDirty();
    } catch { toast({ title: "Error", description: "Could not add item.", variant: "destructive" }); }
  }, [estimateId, activeCat, newItemForm, markDirty]);

  const updateLineItem = useCallback(async (itemId: number, field: string, value: any) => {
    // Normalize numeric-string fields so an empty input doesn't blow up Postgres.
    let normalized: any = value;
    if (field === "unitCost") {
      // Required column (NOT NULL, default 0). Empty string → "0".
      const str = value == null ? "" : String(value).trim();
      normalized = str === "" ? "0" : str;
    } else if (field === "escOverride") {
      // Nullable column. Empty string → null (clears the override).
      const str = value == null ? "" : String(value).trim();
      normalized = str === "" ? null : str;
    }
    setLineItems(prev => prev.map(i => i.id === itemId ? { ...i, [field]: normalized } : i));
    try {
      await apiRequest("PATCH", `/api/estimates/line-items/${itemId}`, { [field]: normalized });
    } catch { toast({ title: "Error", description: "Could not update item.", variant: "destructive" }); }
  }, []);

  const deleteLineItem = useCallback(async (itemId: number) => {
    if (guardViewer(isViewer, toast)) return;
    if (!window.confirm("Delete this line item?")) return;
    setLineItems(prev => prev.filter(i => i.id !== itemId));
    setAllocations(prev => prev.filter(a => a.lineItemId !== itemId));
    try { await apiRequest("DELETE", `/api/estimates/line-items/${itemId}`); }
    catch { toast({ title: "Error", description: "Could not delete item.", variant: "destructive" }); }
  }, []);

  const clearSelection = useCallback(() => setSelectedLineItemIds(new Set()), []);

  const toggleLineItemSelection = useCallback((id: number) => {
    setSelectedLineItemIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const bulkTransfer = useCallback(async (targetScopeId: string, selectedIds: Set<number>) => {
    if (!estimateId || !targetScopeId || isBulkActionLoading) return;
    setIsBulkActionLoading(true);
    setActiveBulkAction("transfer");
    try {
      const res = await fetch(`/api/estimates/${estimateId}/line-items/bulk-transfer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ lineItemIds: Array.from(selectedIds), targetScopeId }),
      });
      const data = await res.json();
      if (res.ok) {
        setLineItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, category: targetScopeId } : i));
        clearSelection();
        setIsTransferModalOpen(false);
        setTransferTargetScope("");
        toast({ title: "Transferred", description: `${data.processed} item(s) moved to ${ALL_SCOPES.find(s => s.id === targetScopeId)?.label || targetScopeId}.` });
      } else {
        toast({ title: "Transfer Failed", description: data.message || "Unknown error.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Transfer request failed.", variant: "destructive" });
    } finally {
      setIsBulkActionLoading(false);
      setActiveBulkAction(null);
    }
  }, [estimateId, isBulkActionLoading, clearSelection]);

  const bulkDelete = useCallback(async (selectedIds: Set<number>) => {
    if (!estimateId || isBulkActionLoading) return;
    setIsBulkActionLoading(true);
    setActiveBulkAction("delete");
    try {
      const res = await fetch(`/api/estimates/${estimateId}/line-items/bulk-delete`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ lineItemIds: Array.from(selectedIds) }),
      });
      const data = await res.json();
      if (res.ok) {
        setLineItems(prev => prev.filter(i => !selectedIds.has(i.id)));
        setAllocations(prev => prev.filter(a => !selectedIds.has(a.lineItemId)));
        clearSelection();
        setIsDeleteModalOpen(false);
        toast({ title: "Deleted", description: `${data.processed} item(s) deleted.` });
      } else {
        toast({ title: "Delete Failed", description: data.message || "Unknown error.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Delete request failed.", variant: "destructive" });
    } finally {
      setIsBulkActionLoading(false);
      setActiveBulkAction(null);
    }
  }, [estimateId, isBulkActionLoading, clearSelection]);

  const bulkApplyVendorQuote = useCallback(async (quoteId: number, overrideCosts: boolean, selectedIds: Set<number>) => {
    if (!estimateId || !quoteId || isBulkActionLoading) return;
    setIsBulkActionLoading(true);
    setActiveBulkAction("vendorQuote");
    try {
      const res = await fetch(`/api/estimates/${estimateId}/line-items/bulk-apply-vendor-quote`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ lineItemIds: Array.from(selectedIds), vendorQuoteId: quoteId, overrideExistingCosts: overrideCosts }),
      });
      const data = await res.json();
      if (res.ok) {
        setLineItems(prev => prev.map(i => selectedIds.has(i.id) ? { ...i, quoteId, hasBackup: true } : i));
        clearSelection();
        setIsVendorQuoteModalOpen(false);
        setApplyQuoteId("");
        setApplyQuoteOverrideCosts(false);
        toast({ title: "Quote Applied", description: `${data.processed} updated${data.failed > 0 ? `, ${data.failed} skipped` : ""}.` });
      } else {
        toast({ title: "Apply Failed", description: data.message || "Unknown error.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Apply request failed.", variant: "destructive" });
    } finally {
      setIsBulkActionLoading(false);
      setActiveBulkAction(null);
    }
  }, [estimateId, isBulkActionLoading, clearSelection]);

  // ── Vendor quote AI processing ──
  const processQuote = useCallback(async (quoteId: number) => {
    setReviewProcessing(true);
    setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, status: "processing" } : q));
    try {
      const res = await fetch(`/api/estimates/quotes/${quoteId}/process`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) {
        const errMsg = data.message || "Processing failed";
        const newStatus = data.code === "SCANNED_PDF_NOT_SUPPORTED" ? "needs_review" : "failed";
        setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, status: newStatus, latestError: errMsg } : q));
        setReviewQuote(prev => prev && prev.id === quoteId ? { ...prev, status: newStatus, latestError: errMsg } : prev);
        toast({ title: "Processing failed", description: errMsg, variant: "destructive" });
        return;
      }
      setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, ...data.quote, status: data.status } : q));
      setReviewQuote(prev => prev && prev.id === quoteId ? { ...prev, ...data.quote, status: data.status } : prev);
      const rowsRes = await fetch(`/api/estimates/quotes/${quoteId}/line-items`, { credentials: "include" });
      if (rowsRes.ok) {
        const rows: VendorQuoteLineItemRow[] = await rowsRes.json();
        setReviewRows(rows);
        setReviewChecked(new Set(rows.map(r => r.id)));
      }
    } catch (err: any) {
      const errMsg = err.message || "Network error — processing failed";
      toast({ title: "Processing failed", description: errMsg, variant: "destructive" });
      setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, status: "failed", latestError: errMsg } : q));
      setReviewQuote(prev => prev && prev.id === quoteId ? { ...prev, status: "failed", latestError: errMsg } : prev);
    } finally {
      setReviewProcessing(false);
    }
  }, [toast]);

  // ── Quote mutations ──
  const addQuote = useCallback(async () => {
    if (guardViewer(isViewer, toast)) return;
    if (!estimateId || !newQuote.vendor.trim()) return;
    try {
      const mtc = newQuote.materialTotalCost !== "" ? parseFloat(newQuote.materialTotalCost) : null;
      const r = await apiRequest("POST", `/api/estimates/${estimateId}/quotes`, {
        category: activeCat, vendor: newQuote.vendor.trim(), note: newQuote.note || null,
        freight: String(newQuote.freight), taxIncluded: newQuote.taxIncluded,
        pricingMode: newQuote.pricingMode, lumpSumTotal: String(newQuote.lumpSumTotal),
        materialTotalCost: mtc != null && !isNaN(mtc) ? mtc : null,
        rfqLogId: newQuote.rfqLogId,
      });
      let q = await r.json();
      setQuotes(prev => [...prev, q]);
      setNewQuote({ vendor: "", note: "", freight: 0, taxIncluded: true, pricingMode: "lump_sum", lumpSumTotal: 0, materialTotalCost: "", rfqLogId: null });
      setNewQuoteFile(null);
      setAiExtractNote(null);
      setShowNewQuote(false);
      if (newQuoteFile) {
        const fd = new FormData();
        fd.append("file", newQuoteFile);
        const br = await fetch(`/api/estimates/quotes/${q.id}/backup-file`, { method: "POST", body: fd, credentials: "include" });
        if (br.ok) {
          const updated = await br.json();
          setQuotes(prev => prev.map(x => x.id === q.id ? { ...x, filePath: updated.filePath, hasBackup: updated.hasBackup, status: "uploaded" } : x));
          toast({ title: "Quote created", description: `${newQuoteFile.name} attached. Starting AI extraction…` });
          processQuote(q.id);
        }
      }
    } catch { toast({ title: "Error", description: "Could not add quote.", variant: "destructive" }); }
  }, [estimateId, activeCat, newQuote, newQuoteFile, processQuote]);

  const updateQuote = useCallback(async (qId: number, field: string, value: any) => {
    setQuotes(prev => prev.map(q => q.id === qId ? { ...q, [field]: value } : q));
    try {
      const payload: Record<string, any> = { [field]: value };
      await apiRequest("PATCH", `/api/estimates/quotes/${qId}`, payload);
    } catch { toast({ title: "Error", description: "Could not update quote.", variant: "destructive" }); }
  }, []);

  const startEditQuote = useCallback((q: Quote) => {
    setEditingQuoteId(q.id);
    setEditDraft({
      vendor: q.vendor || "",
      note: q.note || "",
      pricingMode: q.pricingMode || "lump_sum",
      lumpSumTotal: q.lumpSumTotal != null ? String(q.lumpSumTotal) : "",
      freight: q.freight != null ? String(q.freight) : "",
      taxIncluded: !!q.taxIncluded,
      materialTotalCost: q.materialTotalCost != null ? String(q.materialTotalCost) : "",
    });
  }, []);

  const saveQuoteEdit = useCallback(async (qId: number) => {
    const mtc = editDraft.materialTotalCost !== "" ? parseFloat(editDraft.materialTotalCost) : null;
    const payload = {
      vendor: editDraft.vendor.trim(),
      note: editDraft.note,
      pricingMode: editDraft.pricingMode,
      lumpSumTotal: editDraft.lumpSumTotal === "" ? "0" : editDraft.lumpSumTotal,
      freight: editDraft.freight === "" ? "0" : editDraft.freight,
      taxIncluded: editDraft.taxIncluded,
      materialTotalCost: mtc != null && !isNaN(mtc) ? String(mtc) : null,
    };
    setQuotes(prev => prev.map(q => q.id === qId ? { ...q, ...payload } : q));
    try {
      await apiRequest("PATCH", `/api/estimates/quotes/${qId}`, payload);
      setEditingQuoteId(null);
      toast({ title: "Quote updated" });
    } catch {
      toast({ title: "Error", description: "Could not update quote.", variant: "destructive" });
    }
  }, [editDraft]);

  const deleteQuote = useCallback(async (qId: number) => {
    if (guardViewer(isViewer, toast)) return;
    if (!window.confirm("Delete this quote? Items linked to it will be unlinked and their backup indicator will reset to Missing.")) return;
    setLineItems(prev => prev.map(i => i.quoteId === qId ? { ...i, quoteId: null, hasBackup: false } : i));
    setQuotes(prev => prev.filter(q => q.id !== qId));
    try { await apiRequest("DELETE", `/api/estimates/quotes/${qId}`); }
    catch { toast({ title: "Error", description: "Could not delete quote.", variant: "destructive" }); }
  }, []);

  // ── Vendor quote AI review handlers ──
  const openReviewModal = useCallback(async (q: Quote) => {
    setReviewQuote(q);
    setReviewRows([]);
    setReviewChecked(new Set());
    setReviewLoading(true);
    try {
      const res = await fetch(`/api/estimates/quotes/${q.id}/line-items`, { credentials: "include" });
      if (res.ok) {
        const rows: VendorQuoteLineItemRow[] = await res.json();
        setReviewRows(rows);
        setReviewChecked(new Set(rows.map(r => r.id)));
      }
    } finally {
      setReviewLoading(false);
    }
  }, []);

  const updateReviewRow = useCallback(async (id: number, field: string, value: any) => {
    setReviewRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
    const quoteId = reviewRows.find(r => r.id === id)?.quoteId;
    if (!quoteId) return;
    try {
      await fetch(`/api/estimates/quotes/${quoteId}/line-items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [field]: value }),
      });
    } catch { }
  }, [reviewRows]);

  const approveQuote = useCallback(async (quoteId: number) => {
    if (reviewChecked.size === 0) {
      toast({ title: "No rows selected", description: "Check at least one row to approve.", variant: "destructive" });
      return;
    }
    setReviewApproving(true);
    try {
      const res = await fetch(`/api/estimates/quotes/${quoteId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ approvedIds: Array.from(reviewChecked) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Approval failed");
      setQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, status: "approved" } : q));
      setReviewQuote(prev => prev && prev.id === quoteId ? { ...prev, status: "approved" } : prev);
      if (estimateId) {
        const r = await fetch(`/api/estimates/${estimateId}`, { credentials: "include" });
        if (r.ok) {
          const est = await r.json();
          setLineItems(est.lineItems || []);
        }
      }
      toast({ title: "Quote approved", description: `${data.createdCount} line item(s) added to estimate.` });
      setReviewQuote(null);
    } catch (err: any) {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    } finally {
      setReviewApproving(false);
    }
  }, [reviewChecked, estimateId, toast]);

  // ── Breakout group mutations ──
  const addBreakoutGroup = useCallback(async () => {
    if (guardViewer(isViewer, toast)) return;
    if (!estimateId || !newBreakoutGroup.code.trim() || !newBreakoutGroup.label.trim()) return;
    try {
      const r = await apiRequest("POST", `/api/estimates/${estimateId}/breakout-groups`, {
        code: newBreakoutGroup.code.trim().toUpperCase(), label: newBreakoutGroup.label.trim(), type: newBreakoutGroup.type,
      });
      const g = await r.json();
      setBreakoutGroups(prev => [...prev, g]);
      setNewBreakoutGroup({ code: "", label: "", type: "building" });
    } catch { toast({ title: "Error", description: "Could not add breakout group.", variant: "destructive" }); }
  }, [estimateId, newBreakoutGroup]);

  const removeBreakoutGroup = useCallback(async (groupId: number) => {
    const group = breakoutGroups.find(g => g.id === groupId);
    if (!window.confirm(`Delete breakout "${group?.label}"? All allocations will be removed.`)) return;
    setBreakoutGroups(prev => prev.filter(g => g.id !== groupId));
    setAllocations(prev => prev.filter(a => a.breakoutGroupId !== groupId));
    try { await apiRequest("DELETE", `/api/estimates/breakout-groups/${groupId}`); }
    catch { toast({ title: "Error", description: "Could not delete breakout group.", variant: "destructive" }); }
  }, [breakoutGroups]);

  const setAllocation = useCallback((lineItemId: number, breakoutGroupId: number, qty: number) => {
    setAllocations(prev => {
      const existing = prev.find(a => a.lineItemId === lineItemId && a.breakoutGroupId === breakoutGroupId);
      if (existing) return prev.map(a => a.lineItemId === lineItemId && a.breakoutGroupId === breakoutGroupId ? { ...a, qty } : a);
      return [...prev, { id: Date.now(), estimateId: estimateId!, lineItemId, breakoutGroupId, qty }];
    });
    markDirty();
  }, [estimateId, markDirty]);

  const bulkAllocateCategory = useCallback((groupId: number) => {
    const catItems = lineItems.filter(i => i.category === activeCat);
    setAllocations(prev => {
      const filtered = prev.filter(a => !catItems.find(i => i.id === a.lineItemId));
      const newAllocs = catItems.flatMap(item =>
        breakoutGroups.map(g => ({ id: Date.now() + Math.random(), estimateId: estimateId!, lineItemId: item.id, breakoutGroupId: g.id, qty: g.id === groupId ? item.qty : 0 }))
      );
      return [...filtered, ...newAllocs];
    });
    markDirty();
  }, [lineItems, activeCat, breakoutGroups, estimateId, markDirty]);

  const splitEvenlyCategory = useCallback(() => {
    const catItems = lineItems.filter(i => i.category === activeCat);
    const gc = breakoutGroups.length;
    if (gc === 0) return;
    setAllocations(prev => {
      const filtered = prev.filter(a => !catItems.find(i => i.id === a.lineItemId));
      const newAllocs = catItems.flatMap(item => {
        const base = Math.floor(item.qty / gc);
        const rem = item.qty % gc;
        return breakoutGroups.map((g, idx) => ({ id: Date.now() + Math.random(), estimateId: estimateId!, lineItemId: item.id, breakoutGroupId: g.id, qty: base + (idx < rem ? 1 : 0) }));
      });
      return [...filtered, ...newAllocs];
    });
    markDirty();
  }, [lineItems, activeCat, breakoutGroups, estimateId, markDirty]);

  // ── OH Approval ──
  const requestOhChange = useCallback(async (catId: string, newRate: number) => {
    if (!estimateId) return;
    const current = catOverrides[catId]?.oh ?? defaultOh;
    try {
      const r = await apiRequest("POST", `/api/estimates/${estimateId}/oh-approval`, {
        catId, catLabel: ALL_SCOPES.find(s => s.id === catId)?.label || catId,
        oldRate: current, newRate, requestedBy: user?.displayName || user?.username || user?.email || "Estimator",
      });
      const entry = await r.json();
      setOhLog(prev => [entry, ...prev]);
      toast({ title: "OH Change Requested", description: `Change from ${current}% to ${newRate}% sent for approval.` });
    } catch { toast({ title: "Error", description: "Could not log OH approval request.", variant: "destructive" }); }
  }, [estimateId, catOverrides, defaultOh, user]);

  const approveOhChange = useCallback(async (logId: number) => {
    try {
      const r = await apiRequest("PATCH", `/api/estimates/oh-approval/${logId}`, {
        status: "approved", approvedBy: user?.displayName || user?.username || user?.email || "Admin",
      });
      const updated = await r.json();
      setOhLog(prev => prev.map(l => l.id === logId ? updated : l));
      const entry = ohLog.find(l => l.id === logId);
      if (entry) {
        const field = entry.type === "fee" ? "fee" : "oh";
        setCatOverrides(prev => ({ ...prev, [entry.catId]: { ...prev[entry.catId], [field]: n(entry.newRate) } }));
        toast({ title: "Approved", description: `${entry.type === "fee" ? "Fee" : "OH"} override applied.` });
      } else {
        toast({ title: "Approved", description: "Override applied." });
      }
      markDirty();
    } catch { toast({ title: "Error", description: "Could not approve.", variant: "destructive" }); }
  }, [ohLog, user, markDirty]);

  const denyOhChange = useCallback(async (logId: number) => {
    try {
      const r = await apiRequest("PATCH", `/api/estimates/oh-approval/${logId}`, {
        status: "denied", approvedBy: user?.displayName || user?.username || user?.email || "Admin",
      });
      const updated = await r.json();
      setOhLog(prev => prev.map(l => l.id === logId ? updated : l));
      const entry = ohLog.find(l => l.id === logId);
      toast({ title: "Denied", description: `${entry?.type === "fee" ? "Fee" : "OH"} override request denied.` });
    } catch { toast({ title: "Error", description: "Could not deny.", variant: "destructive" }); }
  }, [ohLog, user]);

  const requestFeeChange = useCallback(async (catId: string, newRate: number) => {
    if (!estimateId) return;
    const current = catOverrides[catId]?.fee ?? defaultFee;
    try {
      const r = await apiRequest("POST", `/api/estimates/${estimateId}/oh-approval`, {
        catId, catLabel: ALL_SCOPES.find(s => s.id === catId)?.label || catId,
        oldRate: current, newRate, requestedBy: user?.displayName || user?.username || user?.email || "Estimator",
        type: "fee",
      });
      const entry = await r.json();
      setOhLog(prev => [entry, ...prev]);
      toast({ title: "Fee Change Requested", description: `Change from ${current}% to ${newRate}% sent for approval.` });
    } catch { toast({ title: "Error", description: "Could not log Fee approval request.", variant: "destructive" }); }
  }, [estimateId, catOverrides, defaultFee, user]);

  const tryCompleteCat = useCallback((catId: string) => {
    const d = calcData[catId];
    if (catComplete[catId]) {
      if (!window.confirm("Uncomplete this scope section? It will reopen for editing.")) return;
      setCatComplete(prev => ({ ...prev, [catId]: false }));
      markDirty();
      return;
    }
    if (d.missingBackup > 0) { toast({ title: "Cannot complete", description: `${d.missingBackup} item(s) missing backup.`, variant: "destructive" }); return; }
    const unpriced = lineItems.filter(i => i.category === catId && n(i.unitCost) === 0 && !quotes.find(q => q.id === i.quoteId && q.pricingMode === "lump_sum"));
    if (unpriced.length > 0) { toast({ title: "Cannot complete", description: `${unpriced.length} item(s) have no pricing.`, variant: "destructive" }); return; }
    setCatComplete(prev => ({ ...prev, [catId]: true }));
    markDirty();
  }, [calcData, catComplete, lineItems, quotes, markDirty]);

  // ── AI Quote Parser ──
  const parseQuoteWithAI = useCallback(async () => {
    if (!pasteText.trim()) return;
    setAiParsing(true);
    setParsedQuote(null);
    try {
      const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
      const r = await apiRequest("POST", "/api/estimates/ai/parse-quote", { text: pasteText.trim(), category: activeCat, catLabel });
      const data = await r.json();
      setParsedQuote(data);
    } catch { toast({ title: "AI Error", description: "Could not parse quote.", variant: "destructive" }); }
    setAiParsing(false);
  }, [pasteText, activeCat]);

  const parseQuoteWithPDF = useCallback(async (file: File) => {
    setPdfParsing(true);
    setParsedQuote(null);
    try {
      const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", activeCat);
      formData.append("catLabel", catLabel);
      const r = await fetch("/api/estimates/ai/parse-quote-pdf", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message || err.code || "Upload failed");
      }
      const data = await r.json();
      setParsedQuote(data);
    } catch (err: any) {
      toast({ title: "PDF Parse Error", description: err.message || "Could not parse PDF.", variant: "destructive" });
    }
    setPdfParsing(false);
  }, [activeCat]);

  const acceptParsedQuote = useCallback(async () => {
    if (!parsedQuote || !estimateId) return;
    try {
      const parsedMtc = parsedQuote.materialTotalCost > 0 ? parsedQuote.materialTotalCost : null;
      const qr = await apiRequest("POST", `/api/estimates/${estimateId}/quotes`, {
        category: activeCat, vendor: parsedQuote.vendor || "Unknown",
        note: parsedQuote.note || null, freight: String(parsedQuote.freight || 0),
        taxIncluded: parsedQuote.taxIncluded || false, pricingMode: parsedQuote.pricingMode || "lump_sum",
        lumpSumTotal: String(parsedQuote.lumpSumTotal || 0), hasBackup: true,
        materialTotalCost: parsedMtc,
      });
      const q = await qr.json();
      setQuotes(prev => [...prev, q]);
      const selectedItems = (parsedQuote.items || []).filter((i: any) => i.selected !== false);
      if (selectedItems.length > 0) {
        const ir = await apiRequest("POST", `/api/estimates/${estimateId}/line-items/bulk`, {
          items: selectedItems.map((i: any) => ({
            category: activeCat, name: i.name, model: i.model || null, mfr: i.mfr || null,
            qty: i.qty || 1, unitCost: i.unitCost || 0, source: "vendor_quote",
            hasBackup: true, quoteId: q.id,
          })),
        });
        const newItems = await ir.json();
        setLineItems(prev => [...prev, ...newItems]);
      }
      setParsedQuote(null); setPasteText(""); setShowAiParse(false); setShowNewQuote(false); setAiParseTab("text");
      toast({ title: "Quote imported", description: `${selectedItems.length} items added.` });
    } catch { toast({ title: "Error", description: "Could not import quote.", variant: "destructive" }); }
  }, [parsedQuote, estimateId, activeCat]);

  // ── Review comments ──
  const addComment = useCallback(async () => {
    if (!estimateId || !newComment.trim()) return;
    try {
      const r = await apiRequest("POST", `/api/estimates/${estimateId}/comments`, {
        author: user?.displayName || user?.username || user?.email || "User", comment: newComment.trim(),
      });
      const c = await r.json();
      setReviewComments(prev => [...prev, c]);
      setNewComment("");
    } catch { toast({ title: "Error", description: "Could not add comment.", variant: "destructive" }); }
  }, [estimateId, newComment, user]);

  const handlePrint = useCallback(() => {
    const el = document.getElementById("proposal-print-area");
    if (!el) return;
    const html = el.innerHTML;
    const projectName = estimateData?.projectName ?? "Proposal";
    const win = window.open("", "_blank", "width=820,height=1000,scrollbars=yes");
    if (!win) { toast({ title: "Popup blocked", description: "Allow popups for this site and try again.", variant: "destructive" }); return; }
    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Proposal — ${projectName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;0,900;1,400;1,700&family=Rajdhani:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Rajdhani', sans-serif;
      font-weight: 500;
      font-size: 10pt;
      line-height: 1.55;
      color: #1a1a1a;
      background: #fff;
      padding: 48px 56px;
    }
    p { margin: 6px 0; }
    @media print {
      body { padding: 24px 32px; }
      @page { margin: 0.75in 0.75in; size: letter portrait; }
    }
  </style>
</head>
<body>
${html}
<script>
  window.onload = function() { window.print(); };
</script>
</body>
</html>`);
    win.document.close();
  }, [estimateData, toast]);

  useEffect(() => {
    if (proposalEntry && !projInfoLoaded) {
      setProjInfo({
        projectName:       proposalEntry.projectName       || "",
        gcEstimateLead:    proposalEntry.gcEstimateLead    || "",
        region:            proposalEntry.region            || "",
        nbsEstimator:      proposalEntry.nbsEstimator      || "",
        dueDate:           proposalEntry.dueDate           || "",
        primaryMarket:     proposalEntry.primaryMarket     || "",
        estimateStatus:    proposalEntry.estimateStatus    || "",
        owner:             proposalEntry.owner             || "",
        anticipatedStart:  proposalEntry.anticipatedStart  || "",
        anticipatedFinish: proposalEntry.anticipatedFinish || "",
        notes:             proposalEntry.notes             || "",
      });
      setProjInfoLoaded(true);
    }
  }, [proposalEntry, projInfoLoaded]);

  // ── Sync scope changes from Proposal Log Dashboard to existing estimate ──
  useEffect(() => {
    if (estimateData && proposalEntry?.nbsSelectedScopes) {
      try {
        const nbsLabels: string[] = JSON.parse(proposalEntry.nbsSelectedScopes);
        const ids = nbsLabels
          .map((label: string) => ALL_SCOPES.find(s => s.label === label)?.id)
          .filter(Boolean) as string[];
        if (JSON.stringify(ids.sort()) !== JSON.stringify(activeScopes.sort())) {
          setActiveScopes(ids);
        }
      } catch { /* ignore parse errors */ }
    }
  }, [proposalEntry?.nbsSelectedScopes, estimateData]);

  // ── Scope toggle ──
  const toggleScope = useCallback((scopeId: string) => {
    setActiveScopes(prev => prev.includes(scopeId) ? prev.filter(s => s !== scopeId) : [...prev, scopeId]);
    markDirty();
  }, [markDirty]);

  // ── Spec sections query ──
  const { data: savedSpecSections = [], refetch: refetchSpecSections } = useQuery<SavedSpecSection[]>({
    queryKey: ["/api/estimates", estimateId, "spec-sections"],
    queryFn: async () => {
      if (!estimateId) return [];
      const r = await fetch(`/api/estimates/${estimateId}/spec-sections`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!estimateId,
  });

  const specSectionForScope = useCallback((scopeId: string) => {
    return savedSpecSections.find(s => s.scopeId === scopeId) || null;
  }, [savedSpecSections]);

  // ── Schedule Extractor functions ──
  const runScheduleExtractImages = useCallback(async (files: File[]) => {
    if (!estimateId || files.length === 0) return;
    setExtracting(true);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append("images", f));
      const r = await fetch(`/api/estimates/${estimateId}/extract-images`, { method: "POST", body: fd, credentials: "include" });
      if (!r.ok) throw new Error((await r.json()).message || "Extraction failed");
      const data = await r.json();
      const items: ExtractedItem[] = (data.items || []).map((item: any, i: number) => ({
        ...item,
        _selected: item.suggestedScope !== "not_div10",
        _assignedScope: item.suggestedScope !== "not_div10" ? item.suggestedScope : null,
        _id: `item-${Date.now()}-${i}`,
      }));
      setExtractedItems(items);
    } catch (err: any) {
      toast({ title: "Extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  }, [estimateId, toast]);

  const runScheduleExtractText = useCallback(async (text: string) => {
    if (!estimateId || !text.trim()) return;
    setExtracting(true);
    try {
      const r = await fetch(`/api/estimates/${estimateId}/extract-text`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error((await r.json()).message || "Extraction failed");
      const data = await r.json();
      const items: ExtractedItem[] = (data.items || []).map((item: any, i: number) => ({
        ...item,
        _selected: item.suggestedScope !== "not_div10",
        _assignedScope: item.suggestedScope !== "not_div10" ? item.suggestedScope : null,
        _id: `item-${Date.now()}-${i}`,
      }));
      setExtractedItems(items);
    } catch (err: any) {
      toast({ title: "Extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  }, [estimateId, toast]);

  const importExtractedItems = useCallback(async () => {
    if (!estimateId) return;
    const toImport = extractedItems.filter(i => i._selected && i._assignedScope);
    const unassigned = extractedItems.filter(i => i._selected && !i._assignedScope);
    if (unassigned.length > 0) {
      toast({ title: "Unassigned items", description: `${unassigned.length} items have no scope assigned. Assign a scope or deselect them.`, variant: "destructive" });
      return;
    }
    if (toImport.length === 0) {
      toast({ title: "Nothing to import", description: "Select items to import." });
      return;
    }
    setImportingItems(true);
    try {
      const r = await fetch(`/api/estimates/${estimateId}/import-items`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: toImport.map(i => ({ category: i._assignedScope, planCallout: i.planCallout || null, name: i.description, model: i.modelNumber || null, mfr: i.manufacturer || null, qty: i.quantity, uom: i.uom || "EA", source: "schedule", extractionConfidence: i.confidence })) }),
      });
      if (!r.ok) throw new Error((await r.json()).message || "Import failed");
      const data = await r.json();
      // Auto-check scopes that received items
      const newScopes = [...new Set(toImport.map(i => i._assignedScope!).filter(Boolean))];
      const mergedScopes = [...new Set([...activeScopes, ...newScopes])];
      setActiveScopes(mergedScopes);
      // Persist merged scopes to DB immediately — before invalidateQueries triggers a
      // refetch that would run initFromEstimate and overwrite the in-memory state
      try {
        await apiRequest("PATCH", `/api/estimates/${estimateId}`, { activeScopes: mergedScopes });
      } catch { /* non-critical — state is already correct in memory */ }
      // Refresh estimate data (safe now that DB is up-to-date).
      // Reset the init-once gate so the refetched estimate (with the newly
      // imported line items) actually re-hydrates local state.
      initializedEstimateIdRef.current = null;
      qc.invalidateQueries({ queryKey: ["/api/estimates/by-proposal", proposalLogId] });
      setShowScheduleExtractor(false);
      setExtractedItems([]);
      setScheduleClipboardImages([]);
      setScheduleImagePasteCount(0);
      setExtractPasteText("");
      setSchedulePasteCount(0);
      const scopeBreakdown = newScopes.map(s => {
        const scopeLabel = ALL_SCOPES.find(sc => sc.id === s)?.label || s;
        const count = toImport.filter(i => i._assignedScope === s).length;
        return `${scopeLabel} (${count})`;
      }).join(", ");
      toast({ title: `${data.created} items added`, description: scopeBreakdown });
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setImportingItems(false);
    }
  }, [estimateId, extractedItems, activeScopes, toast, qc, proposalLogId, markDirty]);

  // ── Spec Extractor functions ──
  const runSpecExtractImages = useCallback(async (files: File[]) => {
    if (!estimateId || files.length === 0) return;
    setExtracting(true);
    try {
      const fd = new FormData();
      files.forEach(f => fd.append("images", f));
      const r = await fetch(`/api/estimates/${estimateId}/extract-spec-images`, { method: "POST", body: fd, credentials: "include" });
      if (!r.ok) throw new Error((await r.json()).message || "Spec extraction failed");
      const data = await r.json();
      const sections: ExtractedSpecSection[] = (data.sections || []).map((s: any, i: number) => ({
        ...s,
        _selected: true,
        _id: `spec-${Date.now()}-${i}`,
      }));
      setExtractedSpecs(sections);
    } catch (err: any) {
      toast({ title: "Spec extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  }, [estimateId, toast]);

  const runSpecExtractText = useCallback(async (text: string) => {
    if (!estimateId || !text.trim()) return;
    setExtracting(true);
    try {
      const r = await fetch(`/api/estimates/${estimateId}/extract-spec-text`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error((await r.json()).message || "Spec extraction failed");
      const data = await r.json();
      const sections: ExtractedSpecSection[] = (data.sections || []).map((s: any, i: number) => ({
        ...s,
        _selected: true,
        _id: `spec-${Date.now()}-${i}`,
      }));
      setExtractedSpecs(sections);
    } catch (err: any) {
      toast({ title: "Spec extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  }, [estimateId, toast]);

  const runSpecExtractPdf = useCallback(async (file: File) => {
    if (!estimateId) return;
    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const r = await fetch(`/api/estimates/${estimateId}/extract-spec-pdf`, { method: "POST", body: fd, credentials: "include" });
      if (!r.ok) throw new Error((await r.json()).message || "Spec extraction failed");
      const data = await r.json();
      const sections: ExtractedSpecSection[] = (data.sections || []).map((s: any, i: number) => ({
        ...s,
        _selected: true,
        _id: `spec-${Date.now()}-${i}`,
      }));
      setExtractedSpecs(sections);
    } catch (err: any) {
      toast({ title: "Spec extraction failed", description: err.message, variant: "destructive" });
    } finally {
      setExtracting(false);
    }
  }, [estimateId, toast]);

  const saveSpecSections = useCallback(async () => {
    if (!estimateId) return;
    const toSave = extractedSpecs.filter(s => s._selected);
    if (toSave.length === 0) {
      toast({ title: "Nothing to save", description: "Select spec sections to save." });
      return;
    }
    setSavingSpecs(true);
    try {
      const r = await fetch(`/api/estimates/${estimateId}/save-spec-sections`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sections: toSave }),
      });
      if (!r.ok) throw new Error((await r.json()).message || "Save failed");
      const data = await r.json();
      // Auto-check scopes
      const newScopes = [...new Set(toSave.map(s => s.scopeId).filter(s => s && s !== "other"))];
      setActiveScopes(prev => [...new Set([...prev, ...newScopes])]);
      markDirty();
      refetchSpecSections();
      setShowSpecExtractor(false);
      setExtractedSpecs([]);
      toast({ title: `${data.saved} spec sections saved`, description: "Spec reference panels are now available in each scope tab." });
    } catch (err: any) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSavingSpecs(false);
    }
  }, [estimateId, extractedSpecs, toast, markDirty, refetchSpecSections]);

  // ══════════════════════════════════════════════════
  // APPROVED MANUFACTURERS (RFQ Vendor Lookup)
  // ══════════════════════════════════════════════════

  const rfqLookupEnabled = hasFeature("rfq-vendor-lookup");

  // All manufacturers (for the picker dropdown AND the line-item manufacturer combo)
  type MfrRow = { id: number; name: string; website?: string | null };
  const { data: allManufacturers = [] } = useQuery<MfrRow[]>({
    queryKey: ["/api/mfr/manufacturers"],
  });

  // Approved manufacturers for the active scope
  type ApprovedMfr = {
    id: number;
    manufacturerId: number;
    manufacturerName: string;
    isBasisOfDesign: boolean;
    notes: string | null;
    vendors: Array<{
      vendorId: number;
      vendorName: string;
      scopes?: string[];
      manufacturerIds?: number[];
      manufacturerDirect?: boolean;
      contacts: Array<{
        id: number;
        name: string;
        role?: string | null;
        email: string | null;
        phone?: string | null;
        isPrimary: boolean;
      }>;
    }>;
  };
  const approvedMfrsQueryKey = ["/api/estimates", estimateId, "scopes", activeCat, "approved-manufacturers"] as const;
  const { data: approvedMfrs = [] } = useQuery<ApprovedMfr[]>({
    queryKey: approvedMfrsQueryKey,
    enabled: rfqLookupEnabled && !!estimateId && !!activeCat,
  });

  const invalidateApprovedMfrs = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/estimates", estimateId, "scopes", activeCat, "approved-manufacturers"] });
  }, [qc, estimateId, activeCat]);

  // Discovered manufacturers — line-item-only mfrs that resolve to a manufacturer record.
  // Compute the id list from current line items + the global manufacturer list, fetch vendor+contact data so RFQ eligibility works for them.
  type DiscoveredMfr = { manufacturerId: number; manufacturerName: string; vendors: ApprovedMfr["vendors"] };
  const discoveredMfrIds = useMemo(() => {
    if (!estimateId || !activeCat) return [] as number[];
    const approvedSet = new Set(approvedMfrs.map(a => a.manufacturerId));
    const ids = new Set<number>();
    for (const li of lineItems) {
      if (li.category !== activeCat) continue;
      const fk = (li as any).manufacturerId as number | null | undefined;
      if (fk && !approvedSet.has(fk)) { ids.add(fk); continue; }
      if (li.mfr) {
        const match = allManufacturers.find(m => m.name.trim().toLowerCase() === li.mfr!.trim().toLowerCase());
        if (match && !approvedSet.has(match.id)) ids.add(match.id);
      }
    }
    return Array.from(ids).sort((a, b) => a - b);
  }, [lineItems, activeCat, allManufacturers, approvedMfrs, estimateId]);
  const discoveredKey = discoveredMfrIds.join(",");
  const { data: discoveredMfrs = [] } = useQuery<DiscoveredMfr[]>({
    queryKey: ["/api/estimates", estimateId, "scopes", activeCat, "discovered-manufacturers", discoveredKey],
    queryFn: async () => {
      if (!discoveredKey) return [];
      const res = await fetch(`/api/estimates/${estimateId}/scopes/${activeCat}/discovered-manufacturers?ids=${discoveredKey}`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!estimateId && !!activeCat && discoveredMfrIds.length > 0,
  });

  // Vendors list (for Open RFQ ad-hoc picker). Loaded on demand when modal opens.
  // Includes scopes / manufacturerIds tag arrays so the picker can rank by relevance.
  type VendorListItem = {
    id: number;
    name: string;
    category?: string | null;
    manufacturerDirect?: boolean | null;
    scopes?: string[] | null;
    manufacturerIds?: number[] | null;
  };
  const { data: allVendorsForRfq = [] } = useQuery<VendorListItem[]>({
    queryKey: ["/api/mfr/vendors", "open-rfq-list"],
    queryFn: async () => {
      const res = await fetch(`/api/mfr/vendors`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    // Loaded for both the Open RFQ picker AND the New Vendor Quote vendor picker.
    enabled: showOpenRfq || showNewQuote,
  });

  // Vendor IDs previously used for an RFQ on this estimate + active scope.
  // Used to give those vendors top priority (rank A) in the Open RFQ picker.
  const { data: rfqUsedVendorIdsList = [] } = useQuery<number[]>({
    queryKey: ["/api/estimates", estimateId, "scopes", activeCat, "rfq-used-vendor-ids"],
    queryFn: async () => {
      if (!estimateId || !activeCat) return [];
      const res = await fetch(
        `/api/estimates/${estimateId}/scopes/${encodeURIComponent(activeCat)}/rfq-used-vendor-ids`,
        { credentials: "include" }
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!estimateId && !!activeCat,
  });

  // ── Scope-aware vendor ranking helper (shared by Open RFQ + New Vendor Quote picker) ──
  // 1) RFQ-used for this estimate+scope, 2) tagged for active scope,
  // 3) tagged to a manufacturer relevant to the user's items, 4) other.
  const rankVendorByScope = (
    v: VendorListItem,
    opts: { rfqUsedSet: Set<number>; scope: string; relevantMfrSet: Set<number> }
  ): 1 | 2 | 3 | 4 => {
    if (opts.rfqUsedSet.has(v.id)) return 1;
    if (Array.isArray(v.scopes) && v.scopes.includes(opts.scope)) return 2;
    if (
      opts.relevantMfrSet.size > 0 &&
      Array.isArray(v.manufacturerIds) &&
      v.manufacturerIds.some(id => opts.relevantMfrSet.has(id))
    ) return 3;
    return 4;
  };

  // Selected vendors' full records (with contacts), loaded when picked in Open RFQ.
  const selectedVendorIdList = useMemo(() => Array.from(openRfqExistingVendorIds), [openRfqExistingVendorIds]);
  const openRfqSelectedVendorQueries = useQueries({
    queries: selectedVendorIdList.map(vid => ({
      queryKey: ["/api/mfr/vendors", vid] as const,
      queryFn: async () => {
        const res = await fetch(`/api/mfr/vendors/${vid}`, { credentials: "include" });
        if (!res.ok) return null;
        return res.json();
      },
      enabled: showOpenRfq,
    })),
  });
  const openRfqSelectedVendors = useMemo(
    () => openRfqSelectedVendorQueries.map(q => q.data).filter((v): v is any => !!v),
    [openRfqSelectedVendorQueries],
  );

  const addApprovedMfrMutation = useMutation({
    mutationFn: async (manufacturerId: number) => {
      return await apiRequest("POST", `/api/estimates/${estimateId}/scopes/${activeCat}/approved-manufacturers`, { manufacturerId });
    },
    onSuccess: () => { invalidateApprovedMfrs(); toast({ title: "Manufacturer added" }); },
    onError: (e: any) => {
      const msg = e?.message?.includes("already approved") ? "Manufacturer is already in this scope" : (e?.message || "Failed to add");
      toast({ title: "Could not add", description: msg, variant: "destructive" });
    },
  });

  const removeApprovedMfrMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/estimates/${estimateId}/scopes/${activeCat}/approved-manufacturers/${id}`),
    onSuccess: () => { invalidateApprovedMfrs(); toast({ title: "Manufacturer removed" }); },
  });

  const toggleBasisOfDesignMutation = useMutation({
    mutationFn: async ({ id, isBasisOfDesign }: { id: number; isBasisOfDesign: boolean }) =>
      apiRequest("PATCH", `/api/estimates/${estimateId}/scopes/${activeCat}/approved-manufacturers/${id}`, { isBasisOfDesign }),
    onSuccess: () => invalidateApprovedMfrs(),
  });

  // ── RFQ Log: query and create mutation ──
  const { data: rfqLogEntries = [] } = useQuery<Array<{ id: number; manufacturerName: string; sentBy: string; sentAt: string; projectName: string; scopeLabel: string; action: string; recipientEmails: string[] }>>({
    queryKey: ["/api/rfq-log", estimateId, activeCat],
    queryFn: async () => {
      if (!estimateId || !activeCat) return [];
      const r = await fetch(`/api/rfq-log?estimateId=${estimateId}&scopeId=${encodeURIComponent(activeCat)}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!estimateId && !!activeCat,
  });
  const logRfqMutation = useMutation({
    mutationFn: async (payload: { manufacturerName: string; action: "copy" | "email"; recipientEmails: string[] }) => {
      const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
      const sentBy = user?.displayName || user?.username || user?.email || "NBS Estimating";
      return apiRequest("POST", "/api/rfq-log", {
        estimateId,
        scopeId: activeCat,
        scopeLabel: catLabel,
        manufacturerName: payload.manufacturerName,
        projectName: proposalEntry?.projectName || "",
        sentBy,
        action: payload.action,
        recipientEmails: payload.recipientEmails || [],
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/rfq-log", estimateId, activeCat] }),
  });
  const logRfq = useCallback((manufacturerName: string, action: "copy" | "email", recipientEmails: string[] = []) => {
    logRfqMutation.mutate({ manufacturerName: manufacturerName || "(unspecified)", action, recipientEmails });
  }, [logRfqMutation]);

  // ── RFQ recipient pairs (vendor + manufacturer combos) for the New Vendor Quote dropdown.
  // One entry per (rfq_log row × resolved recipient). Selecting a pair binds the new
  // quote to a specific rfq_log_id so the RFQ Log can show a precise per-row "Quote
  // received" indicator. Only fetched while the New Vendor Quote panel is open.
  type RfqRecipientPair = {
    rfqLogId: number;
    manufacturerName: string;
    recipientEmail: string;
    vendorId: number | null;
    vendorName: string | null;
    sentAt: string;
  };
  const { data: rfqRecipientPairs = [] } = useQuery<RfqRecipientPair[]>({
    queryKey: ["/api/estimates", estimateId, "scopes", activeCat, "rfq-recipient-pairs"],
    queryFn: async () => {
      if (!estimateId || !activeCat) return [];
      const r = await fetch(`/api/estimates/${estimateId}/scopes/${encodeURIComponent(activeCat)}/rfq-recipient-pairs`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!estimateId && !!activeCat && showNewQuote,
  });

  const createMfrInline = useCallback(async () => {
    const name = newMfrName.trim();
    if (!name) return;
    setCreatingMfr(true);
    try {
      const created: MfrRow = await apiRequest("POST", "/api/mfr/manufacturers", { name }) as any;
      qc.invalidateQueries({ queryKey: ["/api/mfr/manufacturers"] });
      // Auto-select: add it to the current scope
      await addApprovedMfrMutation.mutateAsync(created.id);
      setNewMfrName("");
      setMfrSearchTerm("");
      setShowAddMfrModal(false);
    } catch (e: any) {
      toast({ title: "Could not create", description: e?.message || "Failed", variant: "destructive" });
    } finally {
      setCreatingMfr(false);
    }
  }, [newMfrName, qc, addApprovedMfrMutation, toast]);

  // Case-insensitive name match helper:
  // - if either name is shorter than 3 chars → strict equality (case-insensitive)
  // - else → bidirectional substring match
  const namesMatch = useCallback((a: string, b: string): boolean => {
    const x = (a || "").trim().toLowerCase();
    const y = (b || "").trim().toLowerCase();
    if (!x || !y) return false;
    if (x.length < 3 || y.length < 3) return x === y;
    return x === y || x.includes(y) || y.includes(x);
  }, []);

  // ── RFQ email helpers ──
  const formatItemsTable = useCallback((items: { name: string; model?: string | null; qty: number; uom?: string | null }[]) => {
    if (items.length === 0) return "  TBD — see attached plans and specs";
    // Monospace-aligned plain-text table for mailto: bodies.
    // Columns: # (3 + period) | Desc 36 | Model 16 | Qty 6 (right) | Unit
    const SEP = "-".repeat(70);
    const header = `     ${"Description".padEnd(36)}${"Model #".padEnd(16)}${"Qty".padStart(6)}   Unit`;
    const rows = items.map((i, idx) => {
      const num = String(idx + 1);
      const model = (i.model || "").trim();
      // Strip the model number out of the description if it already appears there
      let desc = (i.name || "").trim();
      if (model) {
        const re = new RegExp(`\\s*\\b${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*`, "gi");
        desc = desc.replace(re, " ").replace(/\s{2,}/g, " ").trim();
      }
      if (!desc) desc = "(unnamed item)";
      // Truncate to column widths to keep alignment
      const dCol = desc.length > 36 ? desc.slice(0, 35) + "…" : desc;
      const mCol = model.length > 16 ? model.slice(0, 15) + "…" : model;
      const qty = String(i.qty ?? "");
      const unit = (i.uom || "EA").trim();
      return `${num.padStart(3)}. ${dCol.padEnd(36)}${mCol.padEnd(16)}${qty.padStart(6)}   ${unit}`;
    });
    return [SEP, header, SEP, ...rows, SEP].join("\n");
  }, []);

  // ── HTML email helpers (for .eml file download) ──
  const escapeHtml = useCallback((s: string) => {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }, []);

  const formatItemsTableHtml = useCallback((items: { name: string; model?: string | null; qty: number; uom?: string | null }[]) => {
    if (items.length === 0) {
      return `<p style="font-style: italic; color: #555;">TBD — see attached plans and specs</p>`;
    }
    const rows = items.map((item, i) => {
      const model = (item.model || "").trim();
      let desc = (item.name || "").trim();
      if (model) {
        const re = new RegExp(`\\s*\\b${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\s*`, "gi");
        desc = desc.replace(re, " ").replace(/\s{2,}/g, " ").trim();
      }
      desc = desc.replace(/;?\s*$/, "").trim() || "(unnamed item)";
      const bg = i % 2 === 0 ? "#f9f9f9" : "#ffffff";
      const cell = `font-family: Calibri, Arial, sans-serif; font-size: 11pt; border: 1px solid #ccc; padding: 4px 8px; vertical-align: top;`;
      return `
        <tr style="background-color: ${bg};">
          <td style="${cell} text-align: center; white-space: nowrap;">${i + 1}</td>
          <td style="${cell} word-wrap: break-word; overflow-wrap: break-word;">${escapeHtml(desc)}</td>
          <td style="${cell} white-space: nowrap;">${model ? escapeHtml(model) : "&mdash;"}</td>
          <td style="${cell} text-align: center; white-space: nowrap;">${escapeHtml(String(item.qty ?? ""))}</td>
          <td style="${cell} text-align: center; white-space: nowrap;">${escapeHtml((item.uom || "EA").trim())}</td>
        </tr>`;
    }).join("");
    const headCell = `font-family: Calibri, Arial, sans-serif; font-size: 11pt; border: 1px solid #999; padding: 5px 8px;`;
    return `
      <table style="border-collapse: collapse; width: auto; max-width: 560px; table-layout: auto; font-family: Calibri, Arial, sans-serif; font-size: 11pt;">
        <thead>
          <tr style="background-color: #1a1a2e; color: #ffffff;">
            <th style="${headCell} text-align: center;">#</th>
            <th style="${headCell} text-align: left;">Description</th>
            <th style="${headCell} text-align: left;">Model #</th>
            <th style="${headCell} text-align: center;">Qty</th>
            <th style="${headCell} text-align: center;">Unit</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }, [escapeHtml]);

  const buildRfqHtmlBody = useCallback((opts: {
    greeting: string;
    intro: string;
    projectName: string;
    gc: string;
    dueDate: string;
    estimateNumber: string;
    scope: string;
    shipTo: string; // plain text, will be rendered with <br/>
    specHtml?: string; // pre-built HTML or empty
    itemsHtml: string; // pre-built table or grouped tables
    notes?: string; // optional plain-text notes
    estimatorName: string;
  }) => {
    const F = `font-family: Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.15; color: #000000;`;
    const P = `style="${F} margin: 0;"`;
    const PB = `style="${F} margin: 0 0 11pt 0;"`; // paragraph with single blank-line gap after
    const infoRow = (label: string, val: string) => `
      <tr>
        <td style="${F} padding: 0; vertical-align: top; white-space: nowrap;"><strong>${escapeHtml(label)}:</strong></td>
        <td style="${F} padding: 0 0 0 8px; vertical-align: top;">${escapeHtml(val)}</td>
      </tr>`;
    const shipToRow = opts.shipTo
      ? `
      <tr>
        <td style="${F} padding: 0; vertical-align: top; white-space: nowrap;"><strong>SHIP TO:</strong></td>
        <td style="${F} padding: 0 0 0 8px; vertical-align: top;">${escapeHtml(opts.shipTo)}</td>
      </tr>`
      : "";
    const notesHtml = opts.notes && opts.notes.trim()
      ? `<p ${PB.replace('style="', 'style="')}><strong>Additional Notes:</strong><br/>${escapeHtml(opts.notes.trim()).replace(/\n/g, "<br/>")}</p>`
      : "";
    return `<html>
<body style="${F} margin: 0; padding: 20px;">
  <p ${PB}>${escapeHtml(opts.greeting)},</p>
  <p ${PB}>${escapeHtml(opts.intro)}</p>
  <table style="border-collapse: collapse; margin: 0 0 11pt 0; ${F}">
    ${infoRow("PROJECT", opts.projectName)}
    ${infoRow("BID DUE", opts.dueDate)}
    ${infoRow("NBS ESTIMATE #", opts.estimateNumber)}
    ${infoRow("SCOPE", opts.scope)}
    ${shipToRow}
  </table>
  ${opts.specHtml || ""}
  <p style="${F} margin: 0 0 4pt 0;"><strong>ITEMS REQUESTED:</strong></p>
  ${opts.itemsHtml}
  <div style="height: 11pt;"></div>
  ${notesHtml}
  <p style="${F} margin: 0 0 4pt 0;"><strong>Please provide:</strong></p>
  <ol style="${F} margin: 0 0 11pt 0; padding-left: 24pt;">
    <li>MATERIAL ONLY unit pricing (NO labor or installation)</li>
    <li>Freight cost to jobsite</li>
    <li>Lead time / availability</li>
    <li>Indicate if pricing includes or excludes sales tax</li>
  </ol>
  <p ${PB}><strong>Pricing Needed By:</strong> ${escapeHtml(opts.dueDate || "bid due date")}</p>
  <p ${P}>Thank you,<br/>
  ${escapeHtml(opts.estimatorName)}<br/>
  National Building Specialties</p>
</body>
</html>`;
  }, [escapeHtml]);

  const downloadRfqEml = useCallback((opts: { to: string[]; subject: string; html: string; filename: string }) => {
    const eml = [
      `X-Unsent: 1`,
      `To: ${opts.to.join(", ")}`,
      `Subject: ${opts.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      opts.html,
    ].join("\r\n");
    const blob = new Blob([eml], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (opts.filename || "RFQ_Draft").replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_") + ".eml";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const buildShipToBlock = useCallback(() => {
    const addr = (proposalEntry?.projectAddress || "").trim();
    return addr || "[Address not on file — please add to project record]";
  }, [proposalEntry]);

  const effectiveDueDate = useCallback((scopeId: string) => {
    return responseNeededByByCat[scopeId] || proposalEntry?.dueDate || "";
  }, [responseNeededByByCat, proposalEntry]);

  // ── RFQ email ──
  const generateRfqEmail = useCallback((mfr: string) => {
    const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
    // Match line items to manufacturer using flexible name match (3-char min substring)
    const catItems = lineItems.filter(i => i.category === activeCat && i.mfr && namesMatch(i.mfr, mfr));
    const estimatorName = user?.displayName || user?.username || user?.email || "NBS Estimating";
    const subject = `${proposalEntry?.projectName || ""} — ${catLabel}`;
    const itemsTable = formatItemsTable(catItems);
    const dueDate = effectiveDueDate(activeCat);
    const shipTo = buildShipToBlock();

    // Spec requirements block (if saved spec data exists for this scope)
    const specRef = specSectionForScope(activeCat);
    let specBlock = "";
    if (specRef) {
      const specLines: string[] = [];
      if (specRef.csiCode || specRef.specSectionTitle) {
        specLines.push(`SPECIFICATION REFERENCE: ${[specRef.csiCode, specRef.specSectionTitle].filter(Boolean).join(" — ")}`);
      }
      if (specRef.manufacturers && specRef.manufacturers.length > 0) {
        specLines.push(`SPECIFIED MANUFACTURERS: ${specRef.manufacturers.join(", ")}`);
      }
      if (specRef.substitutionPolicy) {
        specLines.push(`SUBSTITUTION POLICY: "${specRef.substitutionPolicy}"`);
      }
      if (specRef.keyRequirements && specRef.keyRequirements.length > 0) {
        specLines.push(`KEY REQUIREMENTS:\n${specRef.keyRequirements.map(r => `  • ${r}`).join("\n")}`);
      }
      if (specLines.length > 0) {
        specBlock = `\n\nSPECIFICATION REQUIREMENTS (from project specs):\n${specLines.join("\n")}`;
      }
    }

    const body = `Dear ${mfr} Sales Team,\n\nNational Building Specialties is requesting pricing for the following Division 10 items on the project below.\n\nPROJECT: ${proposalEntry?.projectName || ""}\nGC: ${proposalEntry?.gcEstimateLead || ""}\nBID DUE: ${dueDate}\nNBS ESTIMATE #: ${estimateData?.estimateNumber || ""}\n\n${shipTo}${specBlock}\n\nITEMS REQUESTED:\n${itemsTable}\n\nPlease provide:\n  1. MATERIAL ONLY unit pricing (NO labor or installation)\n  2. Freight cost to jobsite\n  3. Lead time / availability\n  4. Indicate if pricing includes or excludes sales tax\n\nPricing Needed By: ${dueDate || "bid due date"}\n\nThank you,\n${estimatorName}\nNational Building Specialties`;
    return { mfr, subject, body };
  }, [lineItems, activeCat, proposalEntry, estimateData, user, specSectionForScope, formatItemsTable, buildShipToBlock, effectiveDueDate]);

  // ── Proposal letter text ──
  const proposalText = useMemo(() => {
    const catLines = CATEGORIES.filter(c => calcData[c.id]?.items > 0).map(c => {
      const catItems = lineItems.filter(i => i.category === c.id);
      const d = calcData[c.id];
      const itemLines = catItems.map(i => `  • ${i.name}${i.model ? ` (${i.model})` : ""} — Qty: ${i.qty}  ${showUnitPricing ? `@ ${fmt(n(i.unitCost))} = ` : ""}${fmt(n(i.unitCost) * i.qty)}`).join("\n");
      return `${c.label} (${c.csi})\n${itemLines}\n  ${c.label} Total: ${fmt(d.total)}`;
    }).join("\n\n");
    return `NATIONAL BUILDING SPECIALTIES\n\nDate: ${new Date().toLocaleDateString()}\nRe: ${estimateData?.projectName || ""}\nPV#: ${estimateData?.estimateNumber || ""}\n\nNational Building Specialties is pleased to submit the following proposal for FURNISHING Division 10 Specialties:\n\n${catLines}\n\nTOTAL BID (Furnish Only — Material Only): ${fmt(calcData.grandTotal)}\n\nAssumptions:\n${assumptions.map(a => `• ${a}`).join("\n")}\n\nInclusions:\n• Furnish all Division 10 materials per plans and specifications\n• ${taxRate > 0 ? `Sales tax included (${taxRate}%)` : "Sales tax NOT included"}\n• Freight to jobsite included\n\nExclusions:\n• Installation labor by others\n• Blocking, backing, and rough-in by others\n• Offloading, distribution, and handling by others\n• Items not specifically listed above\n\n${risks.length > 0 ? `Notes & Risks:\n${risks.map(r => `⚠ ${r}`).join("\n")}\n\n` : ""}Proposal valid 30 days.\n\nRespectfully,\nNational Building Specialties — Furnish Only`;
  }, [CATEGORIES, calcData, lineItems, estimateData, assumptions, risks, taxRate, showUnitPricing]);

  // ══════════════════════════════════════════════════
  // LOADING STATE
  // ══════════════════════════════════════════════════

  if (isLoading || (!estimateData && !proposalEntry)) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-page)" }}>
        <div className="text-center">
          <Calculator className="w-12 h-12 mx-auto mb-4 animate-pulse" style={{ color: "var(--gold)" }} />
          <p style={{ color: "var(--text-secondary)" }}>Loading estimate...</p>
        </div>
      </div>
    );
  }

  if (isLoading === false && estimateData === null && !proposalEntry) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--bg-page)" }}>
        <div className="text-center">
          <p style={{ color: "var(--text-secondary)" }}>Proposal log entry not found.</p>
          <Button onClick={() => { window.location.href = "/tools/proposal-log"; }} className="mt-4">Back to Proposal Log Dashboard</Button>
        </div>
      </div>
    );
  }

  const catQuotes = quotes.filter(q => q.category === activeCat);
  const catLineItems = lineItems.filter(i => i.category === activeCat);
  const selectedCount = selectedLineItemIds.size;
  const allVisibleSelected = catLineItems.length > 0 && catLineItems.every(i => selectedLineItemIds.has(i.id));
  const someVisibleSelected = catLineItems.some(i => selectedLineItemIds.has(i.id)) && !allVisibleSelected;
  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedLineItemIds(prev => { const next = new Set(prev); catLineItems.forEach(i => next.delete(i.id)); return next; });
    } else {
      setSelectedLineItemIds(prev => { const next = new Set(prev); catLineItems.forEach(i => next.add(i.id)); return next; });
    }
  };
  const pendingOh = ohLog.filter(l => l.status === "pending" && l.type !== "fee");
  const pendingFee = ohLog.filter(l => l.status === "pending" && l.type === "fee");

  // ══════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════

  return (
    <div className="min-h-screen pb-12" style={{ background: "var(--bg-page)", color: "var(--text)" }}>
      <ReadOnlyBanner />
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&display=swap" rel="stylesheet" />

      {/* ── REDESIGNED HEADER (3-row card + collapsible progress) ── */}
      {(() => {
        const STATUS_META: Record<string, { label: string; color: string }> = {
          drafting:         { label: "Draft",            color: "#C8A44E" },
          ready_for_review: { label: "Ready for Review", color: "#f59e0b" },
          reviewed:         { label: "Approved",         color: "#4ade80" },
          submitted:        { label: "Submitted",        color: "#06b6d4" },
        };
        const sm = STATUS_META[reviewStatus] || STATUS_META.drafting;
        const STAGES = [
          { id: "intake",       label: "Project Info",  color: "#C8A44E" },
          { id: "lineItems",    label: "Line Items",   color: "#4ade80" },
          { id: "calculations", label: "Markups", color: "#f97316" },
          { id: "output",       label: "Proposal", color: "#ef4444" },
        ] as const;
        const scopeAbbr = (label: string) => {
          if (label.length <= 4) return label.toUpperCase();
          const words = label.split(/\s+/);
          if (words.length >= 2) return words.map(w => w[0]).join("").toUpperCase().slice(0, 4);
          return label.slice(0, 3).toUpperCase();
        };
        return (
          <>
            <div className="sticky top-14 z-40" style={{ background: "var(--bg-page)" }} data-testid="container-sticky-estimate-header">
            <div
              className="px-4"
              style={{
                background: "var(--bg-page)",
                boxShadow: isHeaderScrolled ? "0 4px 12px rgba(0,0,0,0.25)" : "0 0 0 rgba(0,0,0,0)",
                paddingTop: isHeaderScrolled ? 8 : 16,
                paddingBottom: isHeaderScrolled ? 4 : 8,
                transition: "padding 280ms cubic-bezier(0.4,0,0.2,1), box-shadow 280ms ease-out",
              }}
            >
              <div className="max-w-7xl mx-auto">
                {/* Single header card */}
                <div className="rounded-xl"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", fontFamily: "'Source Sans Pro', system-ui, sans-serif" }}>
                  {/* Row 1: Project name + Save / Back / Collapse — animates closed when scrolled */}
                  <div
                    className="overflow-hidden"
                    style={{
                      maxHeight: isHeaderScrolled ? 0 : 80,
                      opacity: isHeaderScrolled ? 0 : 1,
                      transform: isHeaderScrolled ? "translateY(-4px)" : "translateY(0)",
                      transition: "max-height 280ms cubic-bezier(0.4,0,0.2,1), opacity 200ms ease-out, transform 280ms cubic-bezier(0.4,0,0.2,1)",
                      pointerEvents: isHeaderScrolled ? "none" : "auto",
                    }}
                    aria-hidden={isHeaderScrolled}
                  >
                  <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2 flex-wrap">
                    <h1 className="min-w-0 flex-1 truncate"
                      style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: "var(--text)" }}
                      data-testid="text-project-name">
                      {estimateData?.projectName || proposalEntry?.projectName || "Loading..."}
                    </h1>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Save state button */}
                      <button
                        onClick={() => !isViewer && isDirty && !isSaving && saveEstimate()}
                        disabled={isSaving || !isDirty || !estimateId || isViewer}
                        className="px-3 py-1.5 rounded text-xs font-semibold transition-all flex items-center gap-1"
                        style={{
                          background: isSaving ? "transparent" : isDirty ? "#C8A44E" : "transparent",
                          color: isSaving ? "var(--text-muted)" : isDirty ? "#0A0C10" : "#4ade80",
                          border: `1px solid ${isSaving ? "var(--border-ds)" : isDirty ? "#C8A44E" : "#4ade8050"}`,
                          cursor: isDirty && !isSaving ? "pointer" : "default",
                          opacity: !estimateId ? 0.5 : 1,
                        }}
                        data-testid="button-save-estimate">
                        {isSaving ? (
                          <>
                            <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
                            Saving…
                          </>
                        ) : isDirty ? "💾 Save" : (
                          <>✓ Saved {lastSaved ? `· ${lastSaved.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</>
                        )}
                      </button>
                      {/* Back */}
                      <button
                        onClick={() => {
                          if (isDirty && !window.confirm("You have unsaved changes. Leave without saving?")) return;
                          window.location.href = "/tools/proposal-log";
                        }}
                        className="text-xs px-2 py-1.5 rounded"
                        style={{ background: "transparent", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}
                        data-testid="button-back-to-proposal-log">
                        ← Back
                      </button>
                      {/* Collapse chevron */}
                      <button
                        onClick={() => setHeaderExpanded(v => !v)}
                        className="p-1.5 rounded"
                        style={{ background: "transparent", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}
                        aria-label={headerExpanded ? "Collapse details" : "Expand details"}
                        data-testid="button-toggle-header">
                        {headerExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                  </div>

                  {/* Row 2: PV# · estimator · Due pill · grand total · status pill */}
                  <div className="flex items-center gap-2 px-4 pb-2 flex-wrap">
                    {estimateData?.estimateNumber && (
                      <span className="text-sm font-semibold" style={{ color: "#C8A44E" }} data-testid="text-estimate-number">
                        {estimateData.estimateNumber}
                      </span>
                    )}
                    {proposalEntry?.nbsEstimator && (
                      <>
                        <span className="text-xs" style={{ color: "var(--text-muted)" }}>·</span>
                        <span className="text-xs" style={{ color: "var(--text-secondary)" }} data-testid="text-estimator">
                          {proposalEntry.nbsEstimator}
                        </span>
                      </>
                    )}
                    {proposalEntry?.dueDate && (
                      <>
                        <span className="text-xs" style={{ color: "var(--text-muted)" }}>·</span>
                        <span className="text-[11px] px-2 py-0.5 rounded font-semibold"
                          style={{ background: "#C8A44E20", color: "#C8A44E", border: "1px solid #C8A44E40" }}
                          data-testid="badge-due-date">
                          Due {proposalEntry.dueDate}
                        </span>
                      </>
                    )}
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>·</span>
                    <span className="text-sm font-bold" style={{ color: "#4ade80" }} data-testid="text-grand-total">
                      {fmt(calcData.grandTotal)}
                    </span>
                    {/* Status pill — pushed to the far right */}
                    <span className="ml-auto text-[11px] px-2.5 py-0.5 rounded-full font-semibold"
                      style={{ background: sm.color + "20", color: sm.color, border: `1px solid ${sm.color}50` }}
                      data-testid="badge-review-status">
                      {sm.label}
                    </span>
                  </div>

                  {/* Row 3: Stage tabs as compact pills (always visible) */}
                  <div className="flex gap-1.5 px-4 pb-3 overflow-x-auto">
                    {STAGES.map(s => {
                      const active = stage === s.id;
                      return (
                        <button key={s.id} onClick={() => goToStage(s.id)}
                          className="px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all"
                          style={{
                            background: active ? s.color + "20" : "transparent",
                            color: active ? s.color : "var(--text-muted)",
                            border: `1px solid ${active ? s.color + "60" : "var(--border-ds)"}`,
                          }}
                          data-testid={`tab-stage-${s.id}`}>
                          {s.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* Collapsible details: progress bars + saved timestamp */}
                  {headerExpanded && (
                    <div className="px-4 pb-3 pt-1 border-t" style={{ borderColor: "var(--border-ds)" }} data-testid="section-header-details">
                      <div className="flex items-center gap-3 flex-wrap mt-2">
                        <span className="text-xs font-bold" style={{ color: progress.overall >= 100 ? "#4ade80" : "#C8A44E", minWidth: 36 }}>
                          {Math.round(progress.overall)}%
                        </span>
                        {[
                          { label: "Project Info",     pct: progress.intakePct,    color: "#C8A44E" },
                          { label: "Line Items", pct: progress.lineItemsPct, color: "#4ade80" },
                          { label: "Markups",    pct: progress.calcsPct,     color: "#f97316" },
                          { label: "Output",     pct: progress.outputPct,    color: "#ef4444" },
                        ].map(({ label, pct, color }) => (
                          <div key={label} className="flex items-center gap-1 flex-1 min-w-[120px]">
                            <span className="text-[11px]" style={{ color: "var(--text-muted)", whiteSpace: "nowrap", minWidth: 60 }}>{label}</span>
                            <div className="flex-1 h-1.5 rounded-full" style={{ background: "var(--border-ds)" }}>
                              <div className="h-full rounded-full transition-all"
                                style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 100 ? "#4ade80" : color }} />
                            </div>
                            <span className="text-[11px]" style={{ color: "var(--text-muted)", minWidth: 28, textAlign: "right" }}>{Math.round(pct)}%</span>
                          </div>
                        ))}
                      </div>
                      {lastSaved && (
                        <div className="text-[11px] mt-2" style={{ color: "#4ade80" }} data-testid="text-last-saved-detail">
                          ✓ Saved {lastSaved.toLocaleString()}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* SCOPE CHIPS BAR — only on the Line Items stage (Project Info has its own scope picker) */}
            {stage === "lineItems" && activeScopes.length > 0 && (
              <div className="px-4 py-2"
                style={{ background: "var(--bg-page)", borderBottom: "1px solid var(--border-ds)", backdropFilter: "blur(12px)" }}>
                <div className="max-w-7xl mx-auto flex gap-1.5 overflow-x-auto" data-testid="bar-scope-chips">
                  {ALL_SCOPES.filter(s => activeScopes.includes(s.id)).map(s => {
                    const active = activeCat === s.id;
                    return (
                      <button key={s.id}
                        onClick={() => { setActiveCat(s.id); goToStage("lineItems"); }}
                        className="px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap transition-all shrink-0"
                        style={{
                          background: active ? "#C8A44E20" : "var(--bg-card)",
                          color: active ? "#C8A44E" : "var(--text-secondary)",
                          border: `1px solid ${active ? "#C8A44E60" : "var(--border-ds)"}`,
                        }}
                        title={s.label}
                        data-testid={`chip-scope-${s.id}`}>
                        {active ? s.label : scopeAbbr(s.label)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            </div>
          </>
        );
      })()}

      {/* ══════════════════════════════════════════════════ */}
      {/* STAGE 1: INTAKE */}
      {/* ══════════════════════════════════════════════════ */}
      {stage === "intake" && (
        <div className="max-w-7xl mx-auto px-6 pt-6 space-y-4">


          {/* Review status */}
          <div className="rounded-lg p-3 flex items-center justify-between flex-wrap gap-2" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>Review Status:</span>
              {["drafting", "ready_for_review", "reviewed", "submitted"].map((s, i) => {
                const active = s === reviewStatus;
                const colors: Record<string, string> = { drafting: "var(--gold)", ready_for_review: "#f97316", reviewed: "#22c55e", submitted: "#06b6d4" };
                const labels: Record<string, string> = { drafting: "Drafting", ready_for_review: "Ready for Review", reviewed: "Approved", submitted: "Submitted" };
                return (
                  <div key={s} className="flex items-center gap-1">
                    <button onClick={() => changeReviewStatus(s)}
                      className="px-2 py-0.5 rounded text-xs font-semibold transition-all"
                      style={{
                        background: active ? colors[s] + "20" : "transparent",
                        color: active ? colors[s] : "var(--text-muted)",
                        border: `1px solid ${active ? colors[s] + "50" : "var(--border-ds)"}`,
                      }}>
                      {labels[s]}
                    </button>
                    {i < 3 && <ChevronRight className="w-3 h-3" style={{ color: "var(--text-muted)" }} />}
                  </div>
                );
              })}
              {isDirty && (
                <span className="text-xs ml-1" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                  — not saved yet
                </span>
              )}
            </div>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>Created: {estimateData?.createdAt ? new Date(estimateData.createdAt).toLocaleString() : "—"}</span>
          </div>

          {/* Project info */}
          <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid var(--gold)" }}>
            <div className="flex items-center justify-between mb-1">
              <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, fontWeight: 700 }}>Project Info</h2>
              <span className="text-xs px-2 py-0.5 rounded" style={{ background: "var(--gold)20", color: "var(--gold)", border: "1px solid var(--gold)40" }}>Syncs to Proposal Log Dashboard on Save</span>
            </div>
            <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>Edit fields below — changes are written back to the Proposal Log Dashboard when you save. — {estimateData?.estimateNumber}</p>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {/* Read-only: Estimate # */}
              <div>
                <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Estimate / PV#</label>
                <div className="text-xs px-2 py-1.5 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                  {estimateData?.estimateNumber || proposalEntry?.estimateNumber || "—"}
                </div>
              </div>
              {/* Read-only: Swinerton Project */}
              <div>
                <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Swinerton Project</label>
                <div className="text-xs px-2 py-1.5 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                  {proposalEntry?.swinertonProject || "—"}
                </div>
              </div>
              {/* Editable text fields */}
              {[
                { key: "projectName",      label: "Project Name" },
                { key: "gcEstimateLead",   label: "GC / Client" },
                { key: "nbsEstimator",     label: "NBS Estimator" },
                { key: "primaryMarket",    label: "Primary Market" },
                { key: "owner",            label: "Owner" },
              ].map(f => (
                <div key={f.key}>
                  <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{f.label}</label>
                  <input
                    type="text"
                    value={projInfo[f.key] ?? ""}
                    onChange={e => { setProjInfo(prev => ({ ...prev, [f.key]: e.target.value })); markDirty(); }}
                    className="w-full text-xs px-2 py-1.5 rounded outline-none"
                    style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-primary)" }}
                  />
                </div>
              ))}
              {/* Region dropdown */}
              <div>
                <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Region</label>
                <select
                  value={projInfo.region ?? ""}
                  onChange={e => { setProjInfo(prev => ({ ...prev, region: e.target.value })); markDirty(); }}
                  className="w-full text-xs px-2 py-1.5 rounded outline-none"
                  style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-primary)" }}
                >
                  <option value="">— Select Region —</option>
                  {dbRegions.map(r => (
                    <option key={r.id} value={`${r.code} - ${r.name}`}>{r.code} - {r.name}</option>
                  ))}
                </select>
              </div>
              {/* Status dropdown */}
              <div>
                <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Status</label>
                <select
                  value={projInfo.estimateStatus ?? ""}
                  onChange={e => { setProjInfo(prev => ({ ...prev, estimateStatus: e.target.value })); markDirty(); }}
                  className="w-full text-xs px-2 py-1.5 rounded outline-none"
                  style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-primary)" }}
                >
                  <option value="">— Select Status —</option>
                  {["Lead", "Estimating", "Submitted", "Won", "Lost", "No Bid"].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              {/* Date fields */}
              {[
                { key: "dueDate",          label: "Due Date" },
                { key: "anticipatedStart", label: "Est. Start" },
                { key: "anticipatedFinish",label: "Est. Finish" },
              ].map(f => (
                <div key={f.key}>
                  <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{f.label}</label>
                  <input
                    type="text"
                    value={projInfo[f.key] ?? ""}
                    placeholder="MM/DD/YYYY"
                    onChange={e => { setProjInfo(prev => ({ ...prev, [f.key]: e.target.value })); markDirty(); }}
                    className="w-full text-xs px-2 py-1.5 rounded outline-none"
                    style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-primary)" }}
                  />
                </div>
              ))}
              {/* Notes — full width */}
              <div className="col-span-2 md:col-span-3 lg:col-span-4">
                <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Notes</label>
                <textarea
                  rows={2}
                  value={projInfo.notes ?? ""}
                  onChange={e => { setProjInfo(prev => ({ ...prev, notes: e.target.value })); markDirty(); }}
                  className="w-full text-xs px-2 py-1.5 rounded outline-none resize-none"
                  style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-primary)" }}
                />
              </div>
            </div>
          </div>

          {/* Scope selector */}
          <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid var(--gold)" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">Scope Sections for This Project</h3>
              {proposalEntry?.nbsSelectedScopes && (
                <button
                  onClick={() => {
                    try {
                      const nbsLabels: string[] = JSON.parse(proposalEntry.nbsSelectedScopes);
                      const ids = nbsLabels
                        .map((label: string) => ALL_SCOPES.find(s => s.label === label)?.id)
                        .filter(Boolean) as string[];
                      setActiveScopes(ids);
                      markDirty();
                      toast({ title: "Scopes refreshed", description: "Loaded scope selections from the Proposal Log Dashboard." });
                    } catch { toast({ title: "Error", description: "Could not parse Proposal Log Dashboard scopes.", variant: "destructive" }); }
                  }}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ background: "var(--gold)15", color: "var(--gold)", border: "1px solid var(--gold)40" }}
                >
                  ↻ Pull from Proposal Log Dashboard
                </button>
              )}
            </div>

            {/* Extraction buttons */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => { setShowScheduleExtractor(true); setExtractedItems([]); setExtractorTab("image"); setExtractPasteText(""); setSchedulePasteCount(0); }}
                disabled={!estimateId}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all"
                style={{ background: "#06b6d410", border: "1px solid #06b6d440", color: "#06b6d4" }}
                data-testid="btn-extract-schedules"
              >
                <ClipboardList className="w-3.5 h-3.5" /> Extract from Schedules
              </button>
              <button
                onClick={() => { setShowSpecExtractor(true); setExtractedSpecs([]); setSpecExtractorTab("image"); }}
                disabled={!estimateId}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all"
                style={{ background: "var(--gold)10", border: "1px solid var(--gold)40", color: "var(--gold)" }}
                data-testid="btn-extract-specs"
              >
                <BookOpen className="w-3.5 h-3.5" /> Extract from Specs
              </button>
            </div>

            {activeScopes.length === 0 && (
              <p className="text-xs mb-3 italic" style={{ color: "var(--text-muted)" }}>
                No scope sections selected yet. Upload your plans and specs above to auto-detect scope, or manually select below.
              </p>
            )}
            {activeScopes.length > 0 && (
              <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>Select Division 10 scope sections to include. These become category tabs in Line Items. Saved selections sync back to the Proposal Log Dashboard.</p>
            )}

            <div className="flex flex-wrap gap-2">
              {ALL_SCOPES.map(s => {
                const active = activeScopes.includes(s.id);
                const itemCount = lineItems.filter(i => i.category === s.id).length;
                const hasSpec = savedSpecSections.some(ss => ss.scopeId === s.id);
                return (
                  <button key={s.id} onClick={() => toggleScope(s.id)}
                    className="px-3 py-1.5 rounded-lg text-xs transition-all text-left"
                    style={{
                      background: active ? "#22c55e15" : "var(--bg3)",
                      border: `1px solid ${active ? "#22c55e50" : "var(--border-ds)"}`,
                      color: active ? "#22c55e" : "var(--text-secondary)",
                      fontWeight: active ? 600 : 400,
                    }}>
                    {s.label}
                    <div className="text-xs mt-0.5" style={{ opacity: 0.7 }}>{s.csi}</div>
                    {(itemCount > 0 || hasSpec) && (
                      <div className="text-xs mt-0.5 flex gap-1 flex-wrap" style={{ color: active ? "#22c55e90" : "var(--text-muted)" }}>
                        {itemCount > 0 && <span>{itemCount} items</span>}
                        {itemCount > 0 && hasSpec && <span>•</span>}
                        {hasSpec && <span>📄 spec</span>}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {activeScopes.length === 0 && (
              <p className="text-xs mt-3" style={{ color: "#f97316" }}>⚠ Select at least one scope section to continue.</p>
            )}
          </div>

          {/* Assumptions & Risks */}
          <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid var(--gold)" }}>
            <h3 className="text-sm font-semibold mb-1">Project Assumptions</h3>
            <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>These carry through to the proposal letter.</p>
            {assumptions.map((a, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                <span style={{ color: "var(--gold)" }}>•</span>
                <span className="flex-1">{a}</span>
                <button onClick={() => { setAssumptions(prev => prev.filter((_, j) => j !== i)); markDirty(); }}
                  className="text-xs hover:text-red-500 transition-colors" style={{ color: "var(--text-muted)" }}>×</button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <input value={newAssumption} onChange={e => setNewAssumption(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newAssumption.trim()) { setAssumptions(p => [...p, newAssumption.trim()]); setNewAssumption(""); markDirty(); } }}
                placeholder="Add assumption..." className="flex-1 text-xs px-2 py-1.5 rounded"
                style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
              <button onClick={() => { if (newAssumption.trim()) { setAssumptions(p => [...p, newAssumption.trim()]); setNewAssumption(""); markDirty(); } }}
                className="text-xs px-3 py-1 rounded" style={{ background: "var(--gold)20", border: "1px solid var(--gold)40", color: "var(--gold)" }}>Add</button>
            </div>

            <h3 className="text-sm font-semibold mt-4 mb-1" style={{ color: "#f97316" }}>Risks & Concerns</h3>
            {risks.map((r, i) => (
              <div key={i} className="flex items-center gap-2 py-1 text-xs" style={{ color: "var(--text-secondary)" }}>
                <span style={{ color: "#f97316" }}>⚠</span>
                <span className="flex-1">{r}</span>
                <button onClick={() => { setRisks(prev => prev.filter((_, j) => j !== i)); markDirty(); }}
                  className="hover:text-red-500 transition-colors" style={{ color: "var(--text-muted)" }}>×</button>
              </div>
            ))}
            <div className="flex gap-2 mt-2">
              <input value={newRisk} onChange={e => setNewRisk(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newRisk.trim()) { setRisks(p => [...p, newRisk.trim()]); setNewRisk(""); markDirty(); } }}
                placeholder="Add a risk..." className="flex-1 text-xs px-2 py-1.5 rounded"
                style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
              <button onClick={() => { if (newRisk.trim()) { setRisks(p => [...p, newRisk.trim()]); setNewRisk(""); markDirty(); } }}
                className="text-xs px-3 py-1 rounded" style={{ background: "#f9731610", border: "1px solid #f9731640", color: "#f97316" }}>Add</button>
            </div>
          </div>

          {/* Project Info checklist */}
          <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid var(--gold)" }}>
            <h3 className="text-sm font-semibold mb-3">Project Info Checklist</h3>
            {effectiveChecklist.filter(c => c.stage === "intake").map(c => (
              <label key={c.id} className="flex items-center gap-2 py-1.5 cursor-pointer text-xs"
                style={{ color: c.done ? "#22c55e" : "var(--text-secondary)" }}>
                <input type="checkbox" checked={c.done} disabled={c.auto}
                  onChange={() => { if (!c.auto) setChecklist(p => p.map(x => x.id === c.id ? { ...x, done: !x.done } : x)); }}
                  style={{ accentColor: "#22c55e" }} />
                <span style={{ textDecoration: c.done ? "line-through" : "none" }}>{c.label}</span>
                {c.auto && <span className="text-xs italic" style={{ color: "var(--text-muted)" }}>(auto)</span>}
              </label>
            ))}
          </div>

          {/* Version history — grouped into work sessions (same user + ≤30 min gaps) */}
          {versions.length > 0 && (() => {
            // versions are ordered newest-first; build sessions newest-first
            const SESSION_GAP_MS = 30 * 60 * 1000;
            const sessions: { key: string; items: typeof versions; startIdx: number; endIdx: number }[] = [];
            for (let i = 0; i < versions.length; i++) {
              const v = versions[i];
              const last = sessions[sessions.length - 1];
              const lastV = last ? last.items[last.items.length - 1] : null;
              const sameUser = lastV && lastV.savedBy === v.savedBy;
              const closeInTime = lastV && (new Date(lastV.savedAt).getTime() - new Date(v.savedAt).getTime()) <= SESSION_GAP_MS;
              if (last && sameUser && closeInTime) {
                last.items.push(v);
                last.endIdx = i;
              } else {
                sessions.push({ key: `s-${v.id}`, items: [v], startIdx: i, endIdx: i });
              }
            }
            return (
            <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }} data-testid="version-history">
              <h3 className="text-sm font-semibold mb-3">Version History</h3>
              {sessions.map((session, si) => {
                // Newest version is first in items[] (since versions newest-first); first edit of session is items[last]
                const newest = session.items[0];
                const oldest = session.items[session.items.length - 1];
                // For net change in this session: diff oldest snapshot's PREVIOUS (i.e. baseline before session) vs newest snapshot
                const newestSnap = (newest.snapshotData as any) as EstimateSnapshotV2 | null;
                const baselineSnap = (versions[session.endIdx + 1]?.snapshotData as any) as EstimateSnapshotV2 | null;
                const canNetDiff = newestSnap?.v === 2 && baselineSnap?.v === 2;
                const netDiff = canNetDiff ? diffSnapshots(baselineSnap, newestSnap) : null;
                const startGT = oldest.grandTotal && n(oldest.grandTotal) > 0 ? n(oldest.grandTotal) : null;
                const endGT = newest.grandTotal && n(newest.grandTotal) > 0 ? n(newest.grandTotal) : null;
                const netDelta = (startGT != null && endGT != null) ? endGT - startGT : null;
                const sessionExpanded = expandedSessionKey === session.key;
                const start = new Date(oldest.savedAt);
                const end = new Date(newest.savedAt);
                const sameDay = start.toDateString() === end.toDateString();
                const timeRange = session.items.length === 1
                  ? start.toLocaleString()
                  : sameDay
                    ? `${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : `${start.toLocaleString()} → ${end.toLocaleString()}`;
                // Headline summary of session
                const headline = session.items.length === 1
                  ? (newest.notes || "Saved")
                  : (netDiff ? summarizeDiff(netDiff, (id) => ALL_SCOPES.find(s => s.id === id)?.label || id) : `${session.items.length} saves`);
                return (
                  <div key={session.key}
                    style={{ borderBottom: si < sessions.length - 1 ? "1px solid var(--border-ds)" : "none" }}>
                    <div className="flex items-center justify-between py-2 text-xs gap-2">
                      <button
                        onClick={() => setExpandedSessionKey(sessionExpanded ? null : session.key)}
                        className="flex items-center gap-1.5 text-left flex-1 min-w-0 hover:opacity-80"
                        data-testid={`button-session-toggle-${si}`}>
                        <ChevronRight
                          className="w-3.5 h-3.5 shrink-0 transition-transform"
                          style={{ transform: sessionExpanded ? "rotate(90deg)" : "none" }} />
                        <span className="truncate" style={{ color: "var(--text-muted)" }}>
                          <span style={{ color: "var(--text)", fontWeight: 600 }}>{newest.savedBy}</span>
                          {" · "}
                          <span style={{ color: "var(--text-secondary)" }}>{session.items.length} save{session.items.length === 1 ? "" : "s"}</span>
                          {" · "}
                          <span style={{ color: "var(--text)" }}>{headline}</span>
                        </span>
                      </button>
                      <span className="shrink-0 whitespace-nowrap text-right" style={{ color: "var(--text-muted)" }}>
                        {netDelta != null && netDelta !== 0 && (
                          <span style={{ color: netDelta > 0 ? "#22c55e" : "#ef4444", fontWeight: 600, marginRight: 8 }}>
                            {netDelta > 0 ? "+" : ""}{fmt(netDelta)}
                          </span>
                        )}
                        {timeRange}
                      </span>
                    </div>
                    {sessionExpanded && session.items.map((v, ii) => {
                      const i = session.startIdx + ii;
                      const expanded = expandedVersionId === v.id;
                      const currSnap = (v.snapshotData as any) as EstimateSnapshotV2 | null;
                      const prevSnap = (versions[i + 1]?.snapshotData as any) as EstimateSnapshotV2 | null;
                      const canDiff = currSnap?.v === 2;
                      const hasPrevV2 = prevSnap?.v === 2;
                      const diff = canDiff ? diffSnapshots(hasPrevV2 ? prevSnap : null, currSnap) : null;
                      const isBaseline = canDiff && !hasPrevV2;
                      return (
                  <div key={v.id} className="ml-5"
                    style={{ borderTop: ii > 0 ? "1px dashed var(--border-ds)" : "none" }}>
                    <div className="flex items-center justify-between py-1.5 text-xs gap-2" style={{ color: "var(--text-muted)" }}>
                      <button
                        onClick={() => setExpandedVersionId(expanded ? null : v.id)}
                        disabled={!canDiff}
                        className="flex items-center gap-1.5 text-left flex-1 min-w-0 hover:opacity-80 disabled:cursor-default disabled:hover:opacity-100"
                        data-testid={`button-version-toggle-${v.version}`}>
                        <ChevronRight
                          className="w-3 h-3 shrink-0 transition-transform"
                          style={{ transform: expanded ? "rotate(90deg)" : "none", opacity: canDiff ? 1 : 0.2 }} />
                        <span className="truncate">
                          <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>v{v.version}</span>
                          {" — "}{v.savedBy}{" — "}<span style={{ color: "var(--text)" }}>{v.notes || "Saved"}</span>
                        </span>
                      </button>
                      <span className="shrink-0 whitespace-nowrap">{v.grandTotal && n(v.grandTotal) > 0 ? fmt(n(v.grandTotal)) + " • " : ""}{new Date(v.savedAt).toLocaleString()}</span>
                    </div>
                    {expanded && diff && (
                      <div className="ml-5 mb-2 p-3 rounded text-xs space-y-2"
                        style={{ background: "var(--bg-page)", border: "1px solid var(--border-ds)" }}
                        data-testid={`detail-version-${v.version}`}>
                        {isBaseline && (
                          <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                            Baseline snapshot — {currSnap!.itemCount} item{currSnap!.itemCount === 1 ? "" : "s"} across {currSnap!.scopes.length} scope{currSnap!.scopes.length === 1 ? "" : "s"}, {fmt(currSnap!.grandTotal)}.
                            Detailed change tracking starts from the next save.
                          </div>
                        )}
                        {!isBaseline && diff.status && (
                          <div><span style={{ color: "var(--text-muted)" }}>Status:</span> {STATUS_LABELS[diff.status.before] || diff.status.before} → <span style={{ color: "var(--text)" }}>{STATUS_LABELS[diff.status.after] || diff.status.after}</span></div>
                        )}
                        {!isBaseline && diff.scopes.added.length > 0 && (
                          <div><span style={{ color: "#22c55e" }}>+ Scopes:</span> {diff.scopes.added.map(s => ALL_SCOPES.find(x => x.id === s)?.label || s).join(", ")}</div>
                        )}
                        {!isBaseline && diff.scopes.removed.length > 0 && (
                          <div><span style={{ color: "#ef4444" }}>− Scopes:</span> {diff.scopes.removed.map(s => ALL_SCOPES.find(x => x.id === s)?.label || s).join(", ")}</div>
                        )}
                        {!isBaseline && diff.rates.length > 0 && (
                          <div>
                            <span style={{ color: "var(--text-muted)" }}>Default rates:</span>
                            <ul className="ml-3">
                              {diff.rates.map((r, ri) => (
                                <li key={ri}>{r.field.toUpperCase()}: {r.before}% → <span style={{ color: "var(--text)" }}>{r.after}%</span></li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {!isBaseline && diff.markups.length > 0 && (
                          <div>
                            <span style={{ color: "var(--text-muted)" }}>Per-scope markup overrides:</span>
                            <ul className="ml-3">
                              {diff.markups.map((m, mi) => (
                                <li key={mi}>
                                  {ALL_SCOPES.find(s => s.id === m.scope)?.label || m.scope} — {m.field.toUpperCase()}: {m.before == null ? "default" : `${m.before}%`} → <span style={{ color: "var(--text)" }}>{m.after == null ? "default" : `${m.after}%`}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {!isBaseline && diff.quotes.before !== diff.quotes.after && (
                          <div><span style={{ color: "var(--text-muted)" }}>Quotes:</span> {diff.quotes.before} → <span style={{ color: "var(--text)" }}>{diff.quotes.after}</span></div>
                        )}
                        {!isBaseline && (diff.items.added.length > 0 || diff.items.removed.length > 0 || diff.items.changed.length > 0) && (
                          <div>
                            <span style={{ color: "var(--text-muted)" }}>Line items:</span>
                            <ul className="ml-3 space-y-0.5 mt-1">
                              {diff.items.added.map(it => (
                                <li key={`a-${it.id}`}><span style={{ color: "#22c55e" }}>+</span> [{ALL_SCOPES.find(s => s.id === it.category)?.label || it.category}] {it.name}{it.mfr ? ` — ${it.mfr}` : ""}{it.model ? ` ${it.model}` : ""} (qty {it.qty} @ {fmt(it.unitCost)})</li>
                              ))}
                              {diff.items.removed.map(it => (
                                <li key={`r-${it.id}`}><span style={{ color: "#ef4444" }}>−</span> [{ALL_SCOPES.find(s => s.id === it.category)?.label || it.category}] {it.name}{it.mfr ? ` — ${it.mfr}` : ""}{it.model ? ` ${it.model}` : ""}</li>
                              ))}
                              {diff.items.changed.map(d => (
                                <li key={`c-${d.after.id}`}>
                                  <span style={{ color: "#f59e0b" }}>✎</span> [{ALL_SCOPES.find(s => s.id === d.after.category)?.label || d.after.category}] {d.after.name}:
                                  {" "}{d.fields.map((f, fi) => {
                                    const before = (d.before as any)[f];
                                    const after = (d.after as any)[f];
                                    const fmtVal = (v: any) => f === "unitCost" ? fmt(v || 0) : (v ?? "—");
                                    return <span key={fi}>{fi > 0 ? ", " : ""}{f} {fmtVal(before)} → <span style={{ color: "var(--text)" }}>{fmtVal(after)}</span></span>;
                                  })}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {diff.totals.before !== diff.totals.after && (
                          <div><span style={{ color: "var(--text-muted)" }}>Grand total:</span> {fmt(diff.totals.before)} → <span style={{ color: "#22c55e", fontWeight: 600 }}>{fmt(diff.totals.after)}</span></div>
                        )}
                        {!diff.status && diff.scopes.added.length === 0 && diff.scopes.removed.length === 0 && diff.rates.length === 0 && diff.markups.length === 0 && diff.items.added.length === 0 && diff.items.removed.length === 0 && diff.items.changed.length === 0 && diff.quotes.before === diff.quotes.after && diff.totals.before === diff.totals.after && (
                          <div style={{ color: "var(--text-muted)" }}>No tracked field changes between this version and the previous one.</div>
                        )}
                      </div>
                    )}
                  </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            );
          })()}

          <button onClick={() => { if (CATEGORIES.length > 0) setActiveCat(CATEGORIES[0].id); goToStage("lineItems"); }}
            className="px-6 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
            style={{ background: "var(--gold)", color: "#000" }}>
            Continue to Line Items <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* STAGE 2: LINE ITEMS */}
      {/* ══════════════════════════════════════════════════ */}
      {stage === "lineItems" && (
        <div className="max-w-7xl mx-auto px-6 pt-4">
          {CATEGORIES.length === 0 && (
            <div className="text-center py-12">
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No scope sections selected. Go back to Project Info to select scopes.</p>
              <button onClick={() => setStage("intake")} className="mt-3 px-4 py-2 rounded text-sm" style={{ background: "var(--gold)", color: "#000" }}>← Go to Project Info</button>
            </div>
          )}

          {CATEGORIES.length > 0 && (
            <>
              {/* Stage 2 action toolbar — extraction + breakouts on a single row.
                  All three buttons share an identical squared, outlined chassis
                  (h-8, px-3, 1px border, rounded-md, text-xs/600). Only the accent
                  color differs so each tool stays visually distinct. */}
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <button
                  onClick={() => { setShowScheduleExtractor(true); setExtractedItems([]); setExtractorTab("image"); setExtractPasteText(""); setSchedulePasteCount(0); }}
                  title="Pull door / window / hardware schedules from a PDF, image paste, or text. Adds the extracted line items into the active scope."
                  className="h-8 inline-flex items-center gap-1.5 px-3 rounded-md text-xs font-semibold transition-colors hover:bg-opacity-100"
                  style={{ background: "transparent", border: "1px solid #06b6d4", color: "#06b6d4" }}
                  data-testid="btn-extract-schedules-s2"
                >
                  <ClipboardList className="w-3.5 h-3.5" /> Extract from Schedules
                </button>
                <button
                  onClick={() => { setShowSpecExtractor(true); setExtractedSpecs([]); setSpecExtractorTab("image"); }}
                  title="Pull line items from Division 10 spec sections (toilet accessories, partitions, lockers, signage, etc.) directly into the active scope."
                  className="h-8 inline-flex items-center gap-1.5 px-3 rounded-md text-xs font-semibold transition-colors"
                  style={{ background: "transparent", border: "1px solid var(--gold)", color: "var(--gold)" }}
                  data-testid="btn-extract-specs-s2"
                >
                  <BookOpen className="w-3.5 h-3.5" /> Extract from Specs
                </button>
                <button onClick={() => setShowBreakoutPanel(!showBreakoutPanel)}
                  title="Define cost breakouts (by building, phase, area, etc.) and allocate each line item to one of those buckets so the proposal can show per-breakout subtotals."
                  className="h-8 inline-flex items-center gap-1.5 px-3 rounded-md text-xs font-semibold transition-colors"
                  data-testid="btn-toggle-breakouts"
                  style={{
                    background: "transparent",
                    border: `1px solid ${breakoutGroups.length > 0 ? "#06b6d4" : "var(--border-ds)"}`,
                    color: breakoutGroups.length > 0 ? "#06b6d4" : "var(--text-secondary)",
                  }}>
                  <BarChart3 className="w-3.5 h-3.5" />
                  {breakoutGroups.length > 0 ? `Breakouts (${breakoutGroups.length})` : "Breakouts"}
                </button>
                {breakoutGroups.length > 0 && !breakoutValidation.valid && (
                  <span className="text-xs" style={{ color: "#ef4444" }}>⚠ {breakoutValidation.issues.length} allocation issue(s)</span>
                )}
                {breakoutGroups.length > 0 && breakoutValidation.valid && (
                  <span className="text-xs" style={{ color: "#22c55e" }}>✓ {breakoutValidation.allocatedCount}/{breakoutValidation.totalItems} items allocated</span>
                )}
              </div>

              {/* Legacy per-category tabs removed — replaced by the sticky
                  scope chips bar in the header (rendered only when stage === "lineItems"). */}

              {/* Breakout panel */}
              {showBreakoutPanel && (
                <div className="rounded-lg p-4 mb-4" style={{ background: "var(--bg-card)", border: "1px solid #06b6d430", borderLeft: "3px solid #06b6d4" }}>
                  <div className="flex justify-between items-center mb-3">
                    <h3 className="text-sm font-semibold" style={{ color: "#06b6d4" }}>📊 Breakout Manager</h3>
                    <button onClick={() => setShowBreakoutPanel(false)} className="text-xs" style={{ color: "var(--text-muted)" }}>× Close</button>
                  </div>
                  {/* How to use */}
                  <div className="mb-3 p-3 rounded-md text-xs leading-relaxed" style={{ background: "#06b6d40d", border: "1px solid #06b6d430", color: "var(--text-secondary)" }}>
                    <div className="font-semibold mb-1" style={{ color: "#06b6d4" }}>How to use</div>
                    Use breakouts when the GC needs pricing split by <strong>building, phase, floor, or area</strong> instead of one bottom-line number.
                    <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                      <li>Add a group below for each split (e.g. <em>BLDG-A</em>, <em>BLDG-B</em>).</li>
                      <li>Open the line items table and assign every item to a group from its breakout dropdown.</li>
                      <li>Subtotals (with OH/Fee/Esc) calculate per group automatically and appear on the proposal as separate rows.</li>
                    </ol>
                    <div className="mt-1" style={{ color: "var(--text-muted)" }}>You can leave this off entirely for single-bid jobs — defaults to one combined total.</div>
                  </div>
                  {breakoutGroups.length === 0 ? (
                    <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>No breakouts required. Add groups when the GC requests pricing by building, phase, or floor.</p>
                  ) : (
                    <>
                      <div className="flex gap-2 flex-wrap mb-3">
                        {breakoutGroups.map(g => {
                          const gd = breakoutCalcData[g.id];
                          return (
                            <div key={g.id} className="p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px solid #06b6d430", minWidth: 140 }}>
                              <div className="flex justify-between items-center mb-1">
                                <span className="text-sm font-bold" style={{ color: "#06b6d4" }}>{g.code}</span>
                                <button onClick={() => removeBreakoutGroup(g.id)} className="text-xs" style={{ color: "var(--text-muted)" }}>×</button>
                              </div>
                              <div className="text-xs mb-0.5" style={{ color: "var(--text)" }}>{g.label}</div>
                              <div className="text-xs mb-1" style={{ color: "var(--text-muted)" }}>{g.type}</div>
                              {gd && <div className="text-sm font-bold" style={{ color: "#22c55e" }}>{fmt(gd.total)}</div>}
                              {gd && <div className="text-xs" style={{ color: "var(--text-muted)" }}>{gd.itemCount} items • OH: {gd.ohRate}% • Fee: {gd.feeRate}%</div>}
                              <div className="flex gap-1 mt-2">
                                {[["oh_override", "OH%"], ["fee_override", "Fee%"], ["esc_override", "Esc%"]].map(([field, label]) => {
                                  const isLockedField = field === "oh_override" || field === "fee_override";
                                  return (
                                  <input key={field} type="number" step={0.5}
                                    placeholder={label}
                                    disabled={false}
                                    onChange={async e => {
                                      const val = e.target.value;
                                      if (field === "oh_override" && val !== "") {
                                        toast({ title: "OH Override Requires Approval", description: "Request logged for executive approval." });
                                      } else if (field === "fee_override" && val !== "") {
                                        toast({ title: "Fee Override Requires Approval", description: "Request logged for executive approval." });
                                      } else {
                                        setBreakoutGroups(prev => prev.map(gr => gr.id === g.id ? { ...gr, [field === "oh_override" ? "ohOverride" : field === "fee_override" ? "feeOverride" : "escOverride"]: val === "" ? null : val } : gr));
                                        markDirty();
                                      }
                                    }}
                                    className="w-12 text-xs px-1 py-0.5 rounded"
                                    style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)", opacity: isLockedField ? 0.7 : 1, cursor: "auto" }}  onFocus={selectIfZero}/>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {/* Bulk allocation */}
                      <div className="flex gap-2 items-center flex-wrap mb-3">
                        <span className="text-xs" style={{ color: "var(--text-muted)" }}>Bulk allocate this category:</span>
                        {breakoutGroups.map(g => (
                          <button key={g.id} onClick={() => bulkAllocateCategory(g.id)}
                            className="text-xs px-2 py-1 rounded" style={{ background: "#06b6d410", border: "1px solid #06b6d440", color: "#06b6d4" }}>
                            All → {g.code}
                          </button>
                        ))}
                        <button onClick={splitEvenlyCategory} className="text-xs px-2 py-1 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Split Evenly</button>
                      </div>
                      {/* Validation */}
                      {!breakoutValidation.valid && (
                        <div className="p-3 rounded-lg mb-3" style={{ background: "#ef444415", border: "1px solid #ef444430" }}>
                          <div className="text-xs font-bold mb-1" style={{ color: "#ef4444" }}>⚠ Allocation Issues ({breakoutValidation.issues.length})</div>
                          {breakoutValidation.issues.slice(0, 5).map((iss, i) => (
                            <div key={i} className="text-xs" style={{ color: "var(--text)" }}>
                              <strong>{iss.itemName}</strong>: Parent qty {iss.parentQty}, allocated {iss.allocatedQty} ({iss.type === "over" ? "+" : ""}{iss.delta})
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Breakout totals */}
                      <div className="p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                        <div className="text-xs font-semibold mb-2">Breakout Totals</div>
                        {breakoutGroups.map(g => {
                          const gd = breakoutCalcData[g.id];
                          return (
                            <div key={g.id} className="flex justify-between text-xs py-0.5">
                              <span style={{ color: "#06b6d4" }}>{g.code}: {g.label}</span>
                              <span className="font-semibold" style={{ color: "#22c55e" }}>{gd ? fmt(gd.total) : "$0"}</span>
                            </div>
                          );
                        })}
                        <div className="flex justify-between text-xs font-bold pt-2 mt-2" style={{ borderTop: "1px solid var(--border-ds)" }}>
                          <span>Breakout Sum</span>
                          <span style={{ color: Math.abs(Object.values(breakoutCalcData).reduce((s, d) => s + d.total, 0) - calcData.grandTotal) < 0.02 ? "#22c55e" : "#ef4444" }}>
                            {fmt(Object.values(breakoutCalcData).reduce((s: number, d: any) => s + d.total, 0))}
                          </span>
                        </div>
                      </div>
                    </>
                  )}
                  {/* Add group */}
                  <div className="mt-3 p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px dashed #06b6d430" }}>
                    <p className="text-xs font-semibold mb-3" style={{ color: "#06b6d4" }}>Add Breakout Group</p>
                    <div className="grid grid-cols-12 gap-3 mb-3">
                      <div className="flex flex-col gap-1 col-span-2">
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Code</label>
                        <input data-testid="input-breakout-code" value={newBreakoutGroup.code} onChange={e => setNewBreakoutGroup(p => ({ ...p, code: e.target.value }))}
                          placeholder="B1" className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                      </div>
                      <div className="flex flex-col gap-1 col-span-7">
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Label</label>
                        <input data-testid="input-breakout-label" value={newBreakoutGroup.label} onChange={e => setNewBreakoutGroup(p => ({ ...p, label: e.target.value }))}
                          placeholder="e.g. Building 1 — Main Tower" className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                      </div>
                      <div className="flex flex-col gap-1 col-span-3">
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Type</label>
                        <select data-testid="select-breakout-type" value={newBreakoutGroup.type} onChange={e => setNewBreakoutGroup(p => ({ ...p, type: e.target.value }))}
                          className="text-xs px-2 py-1.5 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}>
                          <option value="building">Building</option>
                          <option value="phase">Phase</option>
                          <option value="floor">Floor</option>
                          <option value="scope_split">Scope Split</option>
                          <option value="custom">Custom</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button data-testid="button-add-breakout" onClick={addBreakoutGroup} disabled={isViewer} className="text-xs px-3 py-1.5 rounded font-semibold" style={{ background: "#06b6d4", color: "#fff", opacity: isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }}>+ Add Breakout Group</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Spec Reference Panel */}
              {(() => {
                const specRef = specSectionForScope(activeCat);
                if (!specRef) return null;
                const isExpanded = expandedSpecPanels.has(activeCat);
                return (
                  <div className="rounded-lg mb-3" style={{ background: "var(--bg-card)", border: "1px solid var(--gold)30", borderLeft: "3px solid var(--gold)" }}>
                    <button
                      className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold"
                      style={{ color: "var(--gold)" }}
                      onClick={() => setExpandedSpecPanels(prev => {
                        const next = new Set(prev);
                        if (next.has(activeCat)) next.delete(activeCat); else next.add(activeCat);
                        return next;
                      })}
                    >
                      <span className="flex items-center gap-2">
                        <BookOpen className="w-3.5 h-3.5" />
                        📄 Spec Reference — {specRef.csiCode} {specRef.specSectionTitle || ALL_SCOPES.find(s => s.id === activeCat)?.label}
                      </span>
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                    {isExpanded && (
                      <div className="px-4 pb-4">
                        <div className="h-px mb-3" style={{ background: "var(--gold)30" }} />
                        {specRef.manufacturers && specRef.manufacturers.length > 0 && (
                          <div className="mb-2">
                            <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Specified Manufacturers: </span>
                            <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{specRef.manufacturers.join(", ")}</span>
                          </div>
                        )}
                        {specRef.substitutionPolicy && (
                          <div className="mb-2">
                            <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Substitution Policy: </span>
                            <span className="text-xs font-semibold" style={{ color: specRef.substitutionPolicy.includes("no sub") ? "#ef4444" : "#f97316" }}>"{specRef.substitutionPolicy}"</span>
                          </div>
                        )}
                        {specRef.keyRequirements && specRef.keyRequirements.length > 0 && (
                          <div className="mb-2">
                            <div className="text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>Key Requirements:</div>
                            <ul className="pl-3">
                              {specRef.keyRequirements.map((req, i) => (
                                <li key={i} className="text-xs mb-0.5" style={{ color: "var(--text-secondary)" }}>• {req}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {specRef.sourcePages && (
                          <div className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>Source: {specRef.sourcePages}</div>
                        )}
                        {specRef.content && (
                          <div className="mt-2">
                            <button
                              className="text-xs flex items-center gap-1"
                              style={{ color: "var(--gold)" }}
                              onClick={() => setExpandedSpecSections(prev => {
                                const next = new Set(prev);
                                const key = `spec-${activeCat}`;
                                if (next.has(key)) next.delete(key); else next.add(key);
                                return next;
                              })}
                            >
                              Full Spec Text {expandedSpecSections.has(`spec-${activeCat}`) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            </button>
                            {expandedSpecSections.has(`spec-${activeCat}`) && (
                              <pre className="mt-2 p-3 rounded text-xs whitespace-pre-wrap leading-relaxed" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)", maxHeight: 300, overflow: "auto" }}>
                                {specRef.content}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Vendor Quotes */}
              <div className="rounded-lg p-4 mb-3" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #a855f7" }}>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm font-semibold">Vendor Quotes</span>
                  <div className="flex gap-2">
                    <button onClick={() => { setShowNewQuote(!showNewQuote); setShowAiParse(false); }}
                      className="text-xs px-3 py-1.5 rounded flex items-center gap-1"
                      style={{ background: "#a855f710", border: "1px solid #a855f740", color: "#a855f7" }}>
                      <Plus className="w-3 h-3" /> Manual
                    </button>
                    <button onClick={() => { setShowNewQuote(true); setShowAiParse(true); }}
                      className="text-xs px-3 py-1.5 rounded flex items-center gap-1"
                      style={{ background: "var(--gold)10", border: "1px solid var(--gold)40", color: "var(--gold)" }}>
                      <Zap className="w-3 h-3" /> AI Parse Quote
                    </button>
                  </div>
                </div>
                {/* How to use */}
                <details className="mb-3 rounded-md" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                  <summary className="cursor-pointer px-3 py-2 text-xs font-semibold flex items-center gap-1.5 select-none" style={{ color: "var(--text)" }}>
                    <Info className="w-3 h-3" style={{ color: "var(--text-muted)" }} /> How Vendor Quotes Work
                  </summary>
                  <div className="px-3 pb-3 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    Log every vendor's pricing here so the line items below can be costed against real bids.
                    <ul className="list-disc ml-4 mt-1 space-y-0.5">
                      <li><strong>Manual</strong> — type vendor + freight + lump-sum or per-item pricing yourself.</li>
                      <li><strong>AI Parse Quote</strong> — drop the vendor's PDF or image; AI extracts header, freight, and line items into a reviewable table.</li>
                      <li>Attach the original PDF/image with the paperclip on any quote — extraction runs automatically and the row moves through <em>Processing → Needs Review → Ready to Approve</em>.</li>
                      <li>Approving a quote pushes its line items into the table below and links them so unit costs stay in sync.</li>
                    </ul>
                  </div>
                </details>

                {/* Existing quotes */}
                {catQuotes.map(q => (
                  <div key={q.id} className="py-2 text-xs"
                    style={{ borderBottom: "1px solid var(--border-ds)" }}>
                    {(() => {
                      // Uniform chip chassis — same height, padding, border, font weight.
                      // Only status pills keep their semantic color; value chips
                      // (Lump Sum / Per Item / Freight / Total / Material) use a
                      // neutral outlined look so the row is calm and scannable.
                      const chipBase = "h-6 inline-flex items-center px-2 rounded-md text-xs font-semibold whitespace-nowrap";
                      const neutralChip: React.CSSProperties = {
                        background: "transparent",
                        border: "1px solid var(--border-ds)",
                        color: "var(--text-secondary)",
                      };
                      const totalChip: React.CSSProperties = {
                        background: "transparent",
                        border: "1px solid var(--text)",
                        color: "var(--text)",
                      };
                      const isEditing = editingQuoteId === q.id;
                      const editInputCls = "text-xs px-2 py-1 rounded h-7";
                      const editInputStyle: React.CSSProperties = { background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" };
                      return (
                    <div className="flex items-center gap-2 flex-wrap">
                      {isEditing ? (
                        <>
                          <input
                            data-testid={`input-edit-quote-vendor-${q.id}`}
                            value={editDraft.vendor}
                            onChange={e => setEditDraft(p => ({ ...p, vendor: e.target.value }))}
                            placeholder="Vendor"
                            className={editInputCls} style={{ ...editInputStyle, width: 140 }} />
                          <input
                            data-testid={`input-edit-quote-note-${q.id}`}
                            value={editDraft.note}
                            onChange={e => setEditDraft(p => ({ ...p, note: e.target.value }))}
                            placeholder="Note (optional)"
                            className={editInputCls} style={{ ...editInputStyle, width: 160 }} />
                          <select
                            data-testid={`select-edit-quote-mode-${q.id}`}
                            value={editDraft.pricingMode}
                            onChange={e => setEditDraft(p => ({ ...p, pricingMode: e.target.value }))}
                            className={editInputCls} style={editInputStyle}>
                            <option value="lump_sum">Lump Sum</option>
                            <option value="per_item">Per Item</option>
                          </select>
                          {editDraft.pricingMode === "lump_sum" && (
                            <input
                              data-testid={`input-edit-quote-lump-${q.id}`}
                              type="number" min={0} step={100}
                              value={editDraft.lumpSumTotal}
                              onChange={e => setEditDraft(p => ({ ...p, lumpSumTotal: e.target.value }))}
                              placeholder="Lump Sum"
                              className={editInputCls} style={{ ...editInputStyle, width: 110, color: "#f97316" }} onFocus={selectIfZero} />
                          )}
                          <input
                            data-testid={`input-edit-quote-freight-${q.id}`}
                            type="number" min={0} step={10}
                            value={editDraft.freight}
                            onChange={e => setEditDraft(p => ({ ...p, freight: e.target.value }))}
                            placeholder="Freight"
                            className={editInputCls} style={{ ...editInputStyle, width: 90, color: "#f97316" }} onFocus={selectIfZero} />
                          <button
                            data-testid={`toggle-edit-quote-tax-${q.id}`}
                            onClick={() => setEditDraft(p => ({ ...p, taxIncluded: !p.taxIncluded }))}
                            className={editInputCls + " whitespace-nowrap"}
                            style={{ background: editDraft.taxIncluded ? "#22c55e15" : "var(--bg2)", border: `1px solid ${editDraft.taxIncluded ? "#22c55e40" : "var(--border-ds)"}`, color: editDraft.taxIncluded ? "#22c55e" : "var(--text-muted)" }}>
                            {editDraft.taxIncluded ? "✓ Tax Incl" : "Tax Excl"}
                          </button>
                          <div className="flex items-center gap-1 ml-auto">
                            <button
                              data-testid={`button-save-quote-${q.id}`}
                              onClick={() => saveQuoteEdit(q.id)}
                              className="text-xs px-2 py-1 rounded font-semibold"
                              style={{ background: "#22c55e", color: "#fff" }}>
                              Save
                            </button>
                            <button
                              data-testid={`button-cancel-edit-quote-${q.id}`}
                              onClick={() => setEditingQuoteId(null)}
                              className="text-xs px-2 py-1 rounded"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                      <span className={chipBase} style={neutralChip} data-testid={`text-quote-vendor-${q.id}`}>{q.vendor}</span>
                      {q.note && <span className="text-xs" style={{ color: "var(--text-muted)" }}>({q.note})</span>}
                      {q.status === "processing" && <span className={chipBase + " gap-1"} style={{ background: "transparent", border: "1px solid #06b6d4", color: "#06b6d4" }}><Loader2 className="w-2.5 h-2.5 animate-spin" />Processing…</span>}
                      {q.status === "needs_review" && <span className={chipBase} style={{ background: "transparent", border: "1px solid #f5a623", color: "#f5a623" }}>⚠ Needs Review</span>}
                      {q.status === "ready_for_approval" && <span className={chipBase} style={{ background: "transparent", border: "1px solid #22c55e", color: "#22c55e" }}>✓ Ready to Approve</span>}
                      {q.status === "approved" && <span className={chipBase} style={{ background: "transparent", border: "1px solid #22c55e", color: "#22c55e" }}>✓ Approved</span>}
                      {q.status === "failed" && <span className={chipBase} style={{ background: "transparent", border: "1px solid #ef4444", color: "#ef4444" }}>✗ Failed</span>}
                      {q.status === "uploaded" && <span className={chipBase} style={neutralChip}>Uploaded</span>}
                      <span className={chipBase} style={neutralChip}>
                        {q.pricingMode === "lump_sum" ? `Lump Sum: ${fmt(n(q.lumpSumTotal))}` : "Per Item"}
                      </span>
                      {q.materialTotalCost && n(q.materialTotalCost) > 0 && (
                        <span className={chipBase} style={neutralChip}>
                          Material: {fmt(n(q.materialTotalCost))}
                        </span>
                      )}
                      <span className={chipBase} style={neutralChip}>Freight: {fmt(n(q.freight))}</span>
                      {(() => {
                        const baseTotal = q.pricingMode === "lump_sum"
                          ? n(q.lumpSumTotal)
                          : (n(q.materialTotalCost) > 0
                              ? n(q.materialTotalCost)
                              : lineItems.filter(i => i.quoteId === q.id).reduce((s, i) => s + n(i.unitCost) * i.qty, 0));
                        const quoteTotal = baseTotal + n(q.freight);
                        return quoteTotal > 0 ? (
                          <span
                            data-testid={`text-quote-total-${q.id}`}
                            className={chipBase}
                            style={totalChip}
                            title={`Quote total = ${q.pricingMode === "lump_sum" ? "Lump Sum" : (n(q.materialTotalCost) > 0 ? "Material Total" : "Linked line items")} + Freight`}>
                            Total: {fmt(quoteTotal)}
                          </span>
                        ) : null;
                      })()}
                      {q.taxIncluded && <span className={chipBase} style={neutralChip}>Tax Incl</span>}
                      <div className="flex items-center gap-1 ml-auto">
                        {q.hasBackup && (q.status === null || q.status === "failed") && (
                          <button
                            onClick={() => processQuote(q.id)}
                            disabled={reviewProcessing}
                            title={q.status === "failed" ? "Retry AI extraction" : "Run AI extraction"}
                            className="text-xs px-2 py-0.5 rounded flex items-center gap-1 font-semibold"
                            style={{ background: "#ef444415", border: "1px solid #ef444450", color: "#ef4444", opacity: reviewProcessing ? 0.5 : 1 }}>
                            <Zap className="w-3 h-3" /> {q.status === "failed" ? "Retry AI" : "Run AI"}
                          </button>
                        )}
                        {q.hasBackup && (q.status === "needs_review" || q.status === "ready_for_approval") && (
                          <button
                            onClick={() => openReviewModal(q)}
                            title="AI Review & Approve this quote"
                            className="text-xs px-2 py-0.5 rounded flex items-center gap-1 font-semibold"
                            style={{ background: "var(--gold)15", border: "1px solid var(--gold)50", color: "var(--gold)" }}>
                            <Zap className="w-3 h-3" /> Review
                          </button>
                        )}
                        <button
                          data-testid={`button-edit-quote-${q.id}`}
                          onClick={() => startEditQuote(q)}
                          title="Edit quote"
                          className="p-1 rounded hover:bg-purple-500/10"
                          style={{ color: "var(--text-muted)" }}>
                          <Pencil className="w-3 h-3" />
                        </button>
                        {/* Backup file attachment */}
                        <input
                          id={`quote-backup-input-${q.id}`}
                          type="file"
                          accept=".pdf,.png,.jpg,.jpeg"
                          style={{ display: "none" }}
                          onChange={async e => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            e.target.value = "";
                            try {
                              const fd = new FormData();
                              fd.append("file", file);
                              const res = await fetch(`/api/estimates/quotes/${q.id}/backup-file`, { method: "POST", body: fd, credentials: "include" });
                              if (!res.ok) throw new Error("Upload failed");
                              const updated = await res.json();
                              setQuotes(prev => prev.map(x => x.id === q.id ? { ...x, filePath: updated.filePath, hasBackup: updated.hasBackup, status: "uploaded" } : x));
                              toast({ title: "Backup attached", description: `${file.name} saved. Starting AI extraction…` });
                              processQuote(q.id);
                            } catch {
                              toast({ title: "Upload failed", description: "Could not attach backup file.", variant: "destructive" });
                            }
                          }}
                        />
                        <button
                          onClick={() => document.getElementById(`quote-backup-input-${q.id}`)?.click()}
                          title={q.filePath ? `Backup: ${q.filePath} — Click to replace` : "Attach backup PDF/image"}
                          className="p-1 rounded hover:bg-purple-500/10"
                          style={{ color: q.filePath ? "#22c55e" : "var(--text-muted)" }}>
                          <Paperclip className="w-3 h-3" />
                        </button>
                        {q.filePath && (
                          <button
                            onClick={async () => {
                              try {
                                const res = await fetch(`/api/estimates/quotes/${q.id}/backup-file`);
                                if (!res.ok) throw new Error("Not found");
                                const blob = await res.blob();
                                const url = URL.createObjectURL(blob);
                                window.open(url, "_blank");
                              } catch {
                                toast({ title: "Could not open file", variant: "destructive" });
                              }
                            }}
                            title={`Open: ${q.filePath}`}
                            className="text-xs underline"
                            style={{ color: "#22c55e", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {q.filePath}
                          </button>
                        )}
                        <button onClick={() => deleteQuote(q.id)} className="p-1 rounded hover:bg-red-500/10">
                          <Trash2 className="w-3 h-3" style={{ color: "#ef4444" }} />
                        </button>
                      </div>
                        </>
                      )}
                    </div>
                      );
                    })()}
                    {(q.latestError?.includes("Scanned/image PDF") || q.latestError?.includes("extractable text")) && (
                      <div className="mt-2 text-xs px-2 py-1 rounded" style={{ background: "#ef44440f", color: "#ef4444", border: "1px solid #ef444430" }}>
                        Scanned/image PDF detected — this V1 flow only supports PDFs with extractable text.
                      </div>
                    )}
                    {q.latestError && !(q.latestError.includes("Scanned/image PDF") || q.latestError.includes("extractable text")) && q.status === "failed" && (
                      <div className="mt-2 text-xs px-2 py-1 rounded" style={{ background: "#ef44440f", color: "#ef4444", border: "1px solid #ef444430" }}>
                        {q.latestError}
                      </div>
                    )}
                  </div>
                ))}

                {/* Empty state — different messages for no-quotes-on-this-tab vs no-quotes-at-all */}
                {catQuotes.length === 0 && !showNewQuote && (
                  <div className="py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                    {quotes.length > 0
                      ? <>No vendor quotes on this tab. Quotes exist under: {quotes.map(q => q.category).filter((c, i, a) => a.indexOf(c) === i).join(", ")}. Navigate to the matching scope tab to see them, or add a new quote here.</>
                      : <>No vendor quotes yet. Use <span style={{ color: "#a855f7" }}>+ Manual</span> or <span style={{ color: "var(--gold)" }}>AI Parse Quote</span> above to add one.</>
                    }
                  </div>
                )}

                {/* New quote form (manual) */}
                {showNewQuote && !showAiParse && (
                  <div className="mt-3 p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px dashed #a855f740" }}>
                    <p className="text-xs font-semibold mb-2" style={{ color: "var(--text-secondary)" }}>New Vendor Quote</p>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div className="flex flex-col gap-1" style={{ position: "relative" }}>
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Vendor Name</label>
                        <input data-testid="input-quote-vendor" value={newQuote.vendor}
                          onChange={e => { setNewQuote(p => ({ ...p, vendor: e.target.value, rfqLogId: null })); setVendorSuggestionsOpen(true); }}
                          onFocus={() => setVendorSuggestionsOpen(true)}
                          onBlur={() => { setTimeout(() => setVendorSuggestionsOpen(false), 150); }}
                          autoComplete="off"
                          placeholder="Pick from RFQs sent or type new…" className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        {/* Bound-pair indicator: shows the manufacturer this quote is tied to once the user picks an RFQ recipient. */}
                        {newQuote.rfqLogId != null && (() => {
                          const pair = rfqRecipientPairs.find(p => p.rfqLogId === newQuote.rfqLogId);
                          return (
                            <div style={{ fontSize: 10, color: "#22c55e", marginTop: 2 }} data-testid="badge-quote-rfq-tie">
                              ✓ Tied to RFQ for {pair?.manufacturerName || "this scope"}
                              {' · '}
                              <button type="button"
                                onMouseDown={e => { e.preventDefault(); setNewQuote(p => ({ ...p, rfqLogId: null })); }}
                                style={{ color: "var(--text-muted)", textDecoration: "underline" }}
                                data-testid="button-quote-rfq-untie">untie</button>
                            </div>
                          );
                        })()}
                        {vendorSuggestionsOpen && (() => {
                          const q = newQuote.vendor.trim().toLowerCase();
                          // Top section — RFQ recipient pairs (vendor + manufacturer combos)
                          const filteredPairs = q
                            ? rfqRecipientPairs.filter(p =>
                                ((p.vendorName || p.recipientEmail).toLowerCase().includes(q)) ||
                                p.manufacturerName.toLowerCase().includes(q)
                              )
                            : rfqRecipientPairs;
                          // Bottom section — existing scope/mfr-ranked vendor list (free-typing fallback)
                          const rfqUsedSet = new Set<number>(rfqUsedVendorIdsList);
                          const relevantMfrSet = new Set<number>(
                            catLineItems
                              .map(i => i.manufacturerId)
                              .filter((id): id is number => typeof id === "number" && id > 0)
                          );
                          const ranked = allVendorsForRfq.map(v => ({
                            v,
                            rank: rankVendorByScope(v, { rfqUsedSet, scope: activeCat, relevantMfrSet }),
                          }));
                          const visibleByRank = showAllVendorsInQuote ? ranked : ranked.filter(r => r.rank <= 3);
                          const sorted = [...visibleByRank].sort((a, b) => {
                            if (a.rank !== b.rank) return a.rank - b.rank;
                            if (!!a.v.manufacturerDirect !== !!b.v.manufacturerDirect) return a.v.manufacturerDirect ? -1 : 1;
                            return a.v.name.localeCompare(b.v.name);
                          });
                          const filteredRanked = (q ? sorted.filter(r => r.v.name.toLowerCase().includes(q)) : sorted).slice(0, 50);
                          const hiddenCount = showAllVendorsInQuote ? 0 : ranked.filter(r => r.rank === 4).length;
                          const totalShown = filteredPairs.length + filteredRanked.length;
                          return (
                            <div className="absolute left-0 right-0 z-20 rounded shadow-lg"
                              style={{ top: "100%", marginTop: 4, background: "var(--bg-card)", border: "1px solid var(--border-ds)", maxHeight: 320, display: "flex", flexDirection: "column" }}
                              data-testid="dropdown-quote-vendor-suggestions">
                              <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px]"
                                style={{ borderBottom: "1px solid var(--border-ds)", color: "var(--text-muted)", background: "var(--bg3)" }}>
                                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>RFQ recipients → other vendors{showAllVendorsInQuote ? " → all" : ""}</span>
                                <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap"
                                  style={{ color: "var(--text-secondary)" }}
                                  onMouseDown={e => e.preventDefault()}>
                                  <input type="checkbox" checked={showAllVendorsInQuote}
                                    onChange={e => setShowAllVendorsInQuote(e.target.checked)}
                                    style={{ accentColor: "var(--gold)" }}
                                    data-testid="checkbox-quote-vendor-show-all" />
                                  Show all{!showAllVendorsInQuote && hiddenCount > 0 ? ` (+${hiddenCount})` : ""}
                                </label>
                              </div>
                              <div style={{ overflowY: "auto", flex: 1 }}>
                                {/* Section 1: RFQ recipient pairs (vendor + manufacturer combos) */}
                                {filteredPairs.length > 0 && (
                                  <>
                                    <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold"
                                      style={{ color: "var(--text-muted)", background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)40" }}
                                      data-testid="header-quote-vendor-rfq-section">
                                      From RFQs sent · {filteredPairs.length}
                                    </div>
                                    {filteredPairs.map(p => (
                                      <button key={`pair-${p.rfqLogId}-${p.vendorId ?? p.recipientEmail}`} type="button"
                                        onMouseDown={e => {
                                          e.preventDefault();
                                          setNewQuote(prev => ({
                                            ...prev,
                                            vendor: (p.vendorName || p.recipientEmail),
                                            rfqLogId: p.rfqLogId,
                                          }));
                                          setVendorSuggestionsOpen(false);
                                        }}
                                        className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 hover:bg-[var(--bg3)]"
                                        style={{ borderBottom: "1px solid var(--border-ds)40", color: "var(--text)", minHeight: 44 }}
                                        data-testid={`option-quote-rfq-pair-${p.rfqLogId}-${p.vendorId ?? "email"}`}>
                                        <span style={{ flex: 1, minWidth: 0 }}>
                                          <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {p.vendorName || p.recipientEmail}
                                          </span>
                                          <span style={{ display: "block", fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            for {p.manufacturerName} · {new Date(p.sentAt).toLocaleDateString()}
                                          </span>
                                        </span>
                                        <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>RFQ</span>
                                      </button>
                                    ))}
                                  </>
                                )}
                                {/* Section 2: Other vendors (free-typing fallback list) */}
                                {filteredRanked.length > 0 && (
                                  <>
                                    <div className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold"
                                      style={{ color: "var(--text-muted)", background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)40" }}
                                      data-testid="header-quote-vendor-other-section">
                                      Other vendors · {filteredRanked.length}
                                    </div>
                                    {filteredRanked.map(r => (
                                      <button key={`vendor-${r.v.id}`} type="button"
                                        onMouseDown={e => { e.preventDefault(); setNewQuote(p => ({ ...p, vendor: r.v.name, rfqLogId: null })); setVendorSuggestionsOpen(false); }}
                                        className="w-full text-left px-3 py-2.5 text-xs flex items-center gap-2 hover:bg-[var(--bg3)]"
                                        style={{ borderBottom: "1px solid var(--border-ds)40", color: "var(--text)", minHeight: 40 }}
                                        data-testid={`option-quote-vendor-${r.v.id}`}>
                                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.v.name}</span>
                                        {r.rank === 1 && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(34,197,94,0.15)", color: "#22c55e" }}>RFQ SENT</span>}
                                        {r.rank === 2 && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(201,168,76,0.15)", color: "var(--gold)" }}>SCOPE</span>}
                                        {r.rank === 3 && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(168,85,247,0.15)", color: "#a855f7" }}>MFR</span>}
                                        {r.v.manufacturerDirect && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(91,141,239,0.15)", color: "#5B8DEF" }}>DIRECT</span>}
                                      </button>
                                    ))}
                                  </>
                                )}
                                {totalShown === 0 && (
                                  <div className="px-3 py-3 text-xs" style={{ color: "var(--text-muted)" }} data-testid="text-quote-vendor-no-matches">
                                    {q
                                      ? <>No matches — keep typing to add "<span style={{ color: "var(--text)" }}>{newQuote.vendor.trim()}</span>" as a new vendor.</>
                                      : "No vendors available."}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Note / Description</label>
                        <input data-testid="input-quote-note" value={newQuote.note} onChange={e => setNewQuote(p => ({ ...p, note: e.target.value }))}
                          placeholder="e.g. Base bid, Option 2…" className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                      </div>
                      {(() => {
                        const baseAmount = newQuote.pricingMode === "lump_sum"
                          ? (newQuote.lumpSumTotal || 0)
                          : (parseFloat(newQuote.materialTotalCost) || 0);
                        const quoteTotal = baseAmount + (newQuote.freight || 0);
                        const baseLabel = newQuote.pricingMode === "lump_sum" ? "Lump Sum" : "Material Subtotal";
                        return (
                          <div className="flex flex-col gap-1">
                            <label className="text-xs font-medium" style={{ color: "var(--gold)" }}>Quote Total ($)</label>
                            <div
                              data-testid="display-quote-total"
                              className="text-xs px-2 py-1.5 rounded font-semibold"
                              style={{ background: "var(--bg2)", border: "1px solid var(--gold)40", color: "var(--gold)", minHeight: "30px", display: "flex", alignItems: "center" }}
                            >
                              ${quoteTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                              = {baseLabel} + Freight
                            </span>
                            {aiExtractNote && (
                              <span className="text-xs" style={{ color: aiExtractNote.startsWith("✓") ? "var(--gold)" : "var(--text-muted)" }}>{aiExtractNote}</span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Pricing Mode</label>
                        <select data-testid="select-quote-mode" value={newQuote.pricingMode} onChange={e => setNewQuote(p => ({ ...p, pricingMode: e.target.value }))}
                          className="text-xs px-2 py-1.5 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}>
                          <option value="per_item">Per Item</option>
                          <option value="lump_sum">Lump Sum</option>
                        </select>
                      </div>
                      {newQuote.pricingMode === "lump_sum" ? (
                        <div className="flex flex-col gap-1">
                          <label className="text-xs font-medium" style={{ color: "#f97316" }}>Lump Sum Total ($)</label>
                          <input data-testid="input-quote-lump-sum" type="number" min={0} step={100} value={newQuote.lumpSumTotal} onChange={e => setNewQuote(p => ({ ...p, lumpSumTotal: parseFloat(e.target.value) || 0 }))}
                            placeholder="0" className="text-xs px-2 py-1.5 rounded"
                            style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "#f97316" }}  onFocus={selectIfZero}/>
                        </div>
                      ) : <div />}
                      <div className="flex flex-col gap-1">
                        <label className="text-xs font-medium" style={{ color: "#f97316" }}>Freight ($)</label>
                        <input data-testid="input-quote-freight" type="number" min={0} step={10} value={newQuote.freight} onChange={e => setNewQuote(p => ({ ...p, freight: parseFloat(e.target.value) || 0 }))}
                          placeholder="0" className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "#f97316" }}  onFocus={selectIfZero}/>
                      </div>
                    </div>
                    <div className="flex gap-3 mb-3 items-start">
                      <div className="flex flex-col gap-1" style={{ width: "fit-content", flex: "0 0 auto" }}>
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Tax</label>
                        <button data-testid="toggle-quote-tax" onClick={() => setNewQuote(p => ({ ...p, taxIncluded: !p.taxIncluded }))}
                          className="text-xs px-2 py-1.5 rounded text-left whitespace-nowrap"
                          style={{ background: newQuote.taxIncluded ? "#22c55e15" : "var(--bg2)", border: `1px solid ${newQuote.taxIncluded ? "#22c55e40" : "var(--border-ds)"}`, color: newQuote.taxIncluded ? "#22c55e" : "var(--text-muted)" }}>
                          {newQuote.taxIncluded ? "✓ Tax Included" : "Tax Excluded"}
                        </button>
                      </div>
                      <div className="flex flex-col gap-1" style={{ flex: 1, minWidth: 0 }}>
                        <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                          Quote Attachment {extractingTotal && <span style={{ color: "var(--gold)" }}>⟳ extracting…</span>}
                          {newQuoteFile && !extractingTotal && <span style={{ color: "#22c55e" }}> ✓ {newQuoteFile.name}</span>}
                        </label>
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                          Text-based PDFs are supported in V1. Scanned/image PDFs are not yet supported.
                        </p>
                        <input
                          data-testid="input-quote-file"
                          type="file"
                          accept="image/*,application/pdf"
                          className="text-xs"
                          style={{ color: "var(--text-muted)" }}
                          onChange={async e => {
                            const f = e.target.files?.[0] ?? null;
                            setNewQuoteFile(f);
                            setAiExtractNote(null);
                            if (!f) return;
                            setExtractingTotal(true);
                            try {
                              const fd = new FormData();
                              fd.append("file", f);
                              const r = await fetch("/api/estimates/quotes/extract-total", { method: "POST", body: fd, credentials: "include" });
                              const data = await r.json();
                              const updates: Record<string, string> = {};
                              if (data.materialTotalCost != null) updates.materialTotalCost = String(data.materialTotalCost);
                              if (data.vendor) updates.vendor = data.vendor;
                              if (Object.keys(updates).length > 0) setNewQuote(p => ({ ...p, ...updates }));
                              if (data.materialTotalCost != null) {
                                setAiExtractNote(`✓ AI found: $${Number(data.materialTotalCost).toLocaleString()}${data.vendor ? ` · ${data.vendor}` : ""}`);
                              } else {
                                setAiExtractNote(data.vendor ? `✓ Vendor: ${data.vendor} — enter total manually` : "AI could not find a total — enter manually");
                              }
                            } catch {
                              setAiExtractNote("Extraction failed — enter manually");
                            }
                            setExtractingTotal(false);
                          }} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button data-testid="button-create-quote" onClick={addQuote} disabled={extractingTotal || isViewer} className="text-xs px-4 py-1.5 rounded font-semibold" style={{ background: "#a855f7", color: "#fff", opacity: extractingTotal || isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }}>Create Quote</button>
                      <button onClick={() => { setShowNewQuote(false); setNewQuoteFile(null); setAiExtractNote(null); }} className="text-xs px-3 py-1.5 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Cancel</button>
                    </div>
                  </div>
                )}

                {/* AI Parse */}
                {showNewQuote && showAiParse && (
                  <div className="mt-3 p-4 rounded-lg" style={{ background: "var(--bg3)", border: "1px dashed var(--gold)40" }}>
                    {!parsedQuote ? (
                      <>
                        {/* Tab switcher */}
                        <div className="flex gap-1 mb-3 p-1 rounded-md w-fit" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)" }}>
                          <button
                            onClick={() => setAiParseTab("text")}
                            className="text-xs px-3 py-1 rounded flex items-center gap-1.5 font-medium transition-colors"
                            style={{
                              background: aiParseTab === "text" ? "var(--gold)" : "transparent",
                              color: aiParseTab === "text" ? "#000" : "var(--text-secondary)",
                            }}>
                            📋 Paste Text
                          </button>
                          <button
                            onClick={() => setAiParseTab("pdf")}
                            className="text-xs px-3 py-1 rounded flex items-center gap-1.5 font-medium transition-colors"
                            style={{
                              background: aiParseTab === "pdf" ? "var(--gold)" : "transparent",
                              color: aiParseTab === "pdf" ? "#000" : "var(--text-secondary)",
                            }}>
                            📄 Upload PDF
                          </button>
                        </div>

                        {aiParseTab === "text" ? (
                          <>
                            <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>Paste vendor quote text below — AI will parse items, pricing, and freight automatically.</p>
                            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={8}
                              placeholder="Paste vendor quote text here..." className="w-full text-xs px-3 py-2 rounded mb-2 resize-y"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)", minHeight: 120 }} />
                            <div className="flex gap-2">
                              <button onClick={parseQuoteWithAI} disabled={aiParsing || !pasteText.trim()}
                                className="text-xs px-4 py-2 rounded font-semibold flex items-center gap-1.5"
                                style={{ background: "var(--gold)", color: "#000", opacity: aiParsing || !pasteText.trim() ? 0.6 : 1 }}>
                                <Zap className="w-3 h-3" />
                                {aiParsing ? "Parsing..." : "Parse with AI"}
                              </button>
                              <button onClick={() => { setShowNewQuote(false); setShowAiParse(false); setPasteText(""); }}
                                className="text-xs px-3 py-2 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Cancel</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>Drop a vendor quote PDF here — AI will extract text and parse items, pricing, and freight automatically.</p>
                            {/* Hidden file input */}
                            <input
                              ref={pdfParseInputRef}
                              type="file"
                              accept=".pdf"
                              style={{ display: "none" }}
                              onChange={e => {
                                const f = e.target.files?.[0];
                                if (f) parseQuoteWithPDF(f);
                                e.target.value = "";
                              }}
                            />
                            {/* Drag-and-drop zone */}
                            <div
                              data-testid="pdf-drop-zone"
                              onClick={() => !pdfParsing && pdfParseInputRef.current?.click()}
                              onDragOver={e => { e.preventDefault(); setPdfDragActive(true); }}
                              onDragLeave={() => setPdfDragActive(false)}
                              onDrop={e => {
                                e.preventDefault();
                                setPdfDragActive(false);
                                const f = e.dataTransfer.files?.[0];
                                if (f && f.type === "application/pdf") parseQuoteWithPDF(f);
                                else toast({ title: "PDF only", description: "Please drop a PDF file.", variant: "destructive" });
                              }}
                              className="w-full flex flex-col items-center justify-center gap-2 rounded-lg cursor-pointer transition-colors mb-3"
                              style={{
                                minHeight: 140,
                                border: `2px dashed ${pdfDragActive ? "var(--gold)" : "var(--border-ds)"}`,
                                background: pdfDragActive ? "var(--gold)10" : "var(--bg2)",
                                color: "var(--text-muted)",
                              }}>
                              {pdfParsing ? (
                                <>
                                  <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "var(--gold)", borderTopColor: "transparent" }} />
                                  <span className="text-xs font-medium">Extracting text and parsing with AI…</span>
                                </>
                              ) : (
                                <>
                                  <svg className="w-8 h-8 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                  </svg>
                                  <span className="text-xs font-semibold">Drop PDF here or click to select</span>
                                  <span className="text-xs opacity-70">Vendor quote PDFs with text content work best</span>
                                </>
                              )}
                            </div>
                            <div className="flex justify-end">
                              <button onClick={() => { setShowNewQuote(false); setShowAiParse(false); }}
                                className="text-xs px-3 py-2 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Cancel</button>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-sm font-semibold" style={{ color: "#22c55e" }}>✓ Quote Parsed — Review & Accept</span>
                          <button onClick={() => setParsedQuote(null)} className="text-xs" style={{ color: "var(--text-muted)" }}>← Re-parse</button>
                        </div>
                        <div className="text-xs mb-3 flex gap-4 flex-wrap">
                          <span><strong>Vendor:</strong> {parsedQuote.vendor}</span>
                          <span><strong>Freight:</strong> {fmt(parsedQuote.freight || 0)}</span>
                          <span><strong>Mode:</strong> {parsedQuote.pricingMode}</span>
                          {parsedQuote.lumpSumTotal > 0 && <span><strong>LS Total:</strong> {fmt(parsedQuote.lumpSumTotal)}</span>}
                          {parsedQuote.materialTotalCost > 0 && <span style={{ color: "var(--gold)", fontWeight: 600 }}><strong>Mat Total:</strong> {fmt(parsedQuote.materialTotalCost)}</span>}
                          <span style={{ color: parsedQuote.taxIncluded ? "#f97316" : "#22c55e" }}>{parsedQuote.taxIncluded ? "⚠ Tax Included" : "Tax Excluded"}</span>
                        </div>
                        <div className="space-y-1 mb-3">
                          {(parsedQuote.items || []).map((item: any, i: number) => (
                            <div key={i} className="flex items-center gap-2 py-1 text-xs"
                              style={{ borderBottom: "1px solid var(--border-ds)", color: item.selected !== false ? "var(--text)" : "var(--text-muted)" }}>
                              <input type="checkbox" checked={item.selected !== false}
                                onChange={() => setParsedQuote((p: any) => ({ ...p, items: p.items.map((x: any, j: number) => j === i ? { ...x, selected: x.selected === false } : x) }))}
                                style={{ accentColor: "#22c55e" }} />
                              <span className="flex-1">{item.name} {item.model ? `(${item.model})` : ""}</span>
                              <span style={{ color: "var(--text-muted)" }}>{item.mfr}</span>
                              <span>Qty: {item.qty}</span>
                              <span className="font-semibold" style={{ color: "#22c55e" }}>{fmt(item.unitCost || 0)}/ea</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <button onClick={acceptParsedQuote} className="text-xs px-4 py-2 rounded font-semibold" style={{ background: "#22c55e", color: "#fff" }}>
                            Accept & Add {(parsedQuote.items || []).filter((i: any) => i.selected !== false).length} Line Items
                          </button>
                          <button onClick={() => { setParsedQuote(null); setShowNewQuote(false); setShowAiParse(false); }}
                            className="text-xs px-3 py-2 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Cancel</button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Line items table */}
              <div className="rounded-lg overflow-hidden mb-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
                <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid var(--border-ds)" }}>
                  <span className="text-sm font-semibold">
                    Line Items — {ALL_SCOPES.find(s => s.id === activeCat)?.label}
                    {calcData[activeCat]?.items > 0 && (
                      <span className="ml-2 font-bold" style={{ color: "#22c55e" }}>{fmt(calcData[activeCat].total)}</span>
                    )}
                  </span>
                  <button onClick={() => setAddingItem(!addingItem)}
                    className="text-xs px-3 py-1.5 rounded flex items-center gap-1"
                    style={{ background: "#22c55e15", border: "1px solid #22c55e40", color: "#22c55e" }}>
                    <Plus className="w-3 h-3" /> Add Item
                  </button>
                </div>
                {/* How to use */}
                <details style={{ background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)" }}>
                  <summary className="cursor-pointer px-4 py-2 text-xs font-semibold flex items-center gap-1.5 select-none" style={{ color: "var(--text)" }}>
                    <Info className="w-3 h-3" style={{ color: "var(--text-muted)" }} /> How Line Items Work
                  </summary>
                  <div className="px-4 pb-3 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                    This is the cost table that drives the proposal total for the active scope.
                    <ul className="list-disc ml-4 mt-1 space-y-0.5">
                      <li>Add items by hand with <strong>Add Item</strong>, or import them via the <em>Extract</em> buttons or by approving a vendor quote above.</li>
                      <li>Quantity × Unit Cost = extended cost. Markups (OH / Fee / Esc / Freight) apply on top — see the markups tile below.</li>
                      <li>Set the <strong>Manufacturer</strong> to drive the RFQ Generator and keep the global manufacturer list in sync. Link a row to a quote to lock its unit cost.</li>
                      <li>Scroll right on small screens — every column stays visible.</li>
                    </ul>
                  </div>
                </details>

                {/* Add item form */}
                {addingItem && (
                  <div className="px-4 py-3 overflow-x-auto" style={{ background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)" }}>
                    {false && isMobile ? (
                      // (legacy mobile stacked layout — disabled in favor of horizontal scroll)
                      <div className="flex flex-col gap-2">
                        <label className="block">
                          <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Plan Callout</span>
                          <input value={newItemForm.planCallout} onChange={e => setNewItemForm(p => ({ ...p, planCallout: e.target.value }))}
                            className="w-full text-sm px-2 py-2 rounded"
                            style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        </label>
                        <label className="block">
                          <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Description *</span>
                          <input value={newItemForm.name} onChange={e => setNewItemForm(p => ({ ...p, name: e.target.value }))}
                            className="w-full text-sm px-2 py-2 rounded"
                            style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        </label>
                        <label className="block">
                          <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Manufacturer</span>
                          <ManufacturerCombo
                            value={newItemForm.mfr}
                            manufacturerId={newItemForm.manufacturerId}
                            allMfrs={allManufacturers}
                            approvedMfrs={approvedMfrs}
                            scopeLabel={ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat}
                            onChange={(name, id) => setNewItemForm(p => ({ ...p, mfr: name, manufacturerId: id }))}
                            placeholder="Pick or type…"
                            className="w-full text-sm px-2 py-2 rounded"
                            style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        </label>
                        <label className="block">
                          <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Model #</span>
                          <input value={newItemForm.model} onChange={e => setNewItemForm(p => ({ ...p, model: e.target.value }))}
                            className="w-full text-sm px-2 py-2 rounded"
                            style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        </label>
                        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                          <label className="block">
                            <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Qty</span>
                            <input type="number" min={1} value={newItemForm.qty} onChange={e => setNewItemForm(p => ({ ...p, qty: parseInt(e.target.value) || 1 }))}
                              className="w-full text-sm px-2 py-2 rounded text-right"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}  onFocus={selectIfZero}/>
                          </label>
                          <label className="block">
                            <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>UOM</span>
                            <select value={newItemForm.uom} onChange={e => setNewItemForm(p => ({ ...p, uom: e.target.value }))}
                              className="w-full text-sm px-2 py-2 rounded"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}>
                              {["EA", "LF", "SF", "SET"].map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          </label>
                        </div>
                        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                          <label className="block">
                            <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Unit Cost ($)</span>
                            <MoneyInput
                              value={newItemForm.unitCost}
                              onChange={raw => setNewItemForm(p => ({ ...p, unitCost: raw === "" ? 0 : (parseFloat(raw) || 0) }))}
                              size="sm"
                              className="w-full"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)" }}
                              ariaLabel="Unit cost in dollars"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[11px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Line Total</span>
                            <div className="text-sm px-2 py-2 rounded font-semibold flex items-center justify-end"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: newItemForm.qty * newItemForm.unitCost === 0 ? "var(--text-muted)" : "#22c55e" }}>
                              {fmt(newItemForm.qty * newItemForm.unitCost)}
                            </div>
                          </label>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <button onClick={addLineItem} disabled={isViewer} className="flex-1 text-sm px-3 py-2 rounded font-semibold" style={{ background: "#22c55e", color: "#fff", opacity: isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }}>Add Item</button>
                          <button onClick={() => setAddingItem(false)} className="text-sm px-3 py-2 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      // Desktop: original 9-column grid
                      <div className="grid gap-x-3 gap-y-2" style={{ gridTemplateColumns: "110px 1fr 140px 120px 60px 72px 110px 90px auto" }}>
                        {/* Row 1: Labels */}
                        {["Plan Callout", "Description *", "Manufacturer", "Model #", "Qty", "UOM", "Unit Cost ($)", "Line Total"].map(label => (
                          <div key={label} className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>{label}</div>
                        ))}
                        <div />
                        {/* Row 2: Inputs */}
                        <input value={newItemForm.planCallout} onChange={e => setNewItemForm(p => ({ ...p, planCallout: e.target.value }))}
                          className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        <input value={newItemForm.name} onChange={e => setNewItemForm(p => ({ ...p, name: e.target.value }))}
                          onKeyDown={e => e.key === "Enter" && addLineItem()}
                          className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        <ManufacturerCombo
                          value={newItemForm.mfr}
                          manufacturerId={newItemForm.manufacturerId}
                          allMfrs={allManufacturers}
                          approvedMfrs={approvedMfrs}
                          scopeLabel={ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat}
                          onChange={(name, id) => setNewItemForm(p => ({ ...p, mfr: name, manufacturerId: id }))}
                          placeholder="Pick or type…"
                          className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        <input value={newItemForm.model} onChange={e => setNewItemForm(p => ({ ...p, model: e.target.value }))}
                          className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                        <input type="number" min={1} value={newItemForm.qty} onChange={e => setNewItemForm(p => ({ ...p, qty: parseInt(e.target.value) || 1 }))}
                          className="text-xs px-2 py-1.5 rounded text-right"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}  onFocus={selectIfZero}/>
                        <select value={newItemForm.uom} onChange={e => setNewItemForm(p => ({ ...p, uom: e.target.value }))}
                          className="text-xs px-2 py-1.5 rounded"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}>
                          {["EA", "LF", "SF", "SET"].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                        <MoneyInput
                          value={newItemForm.unitCost}
                          onChange={raw => setNewItemForm(p => ({ ...p, unitCost: raw === "" ? 0 : (parseFloat(raw) || 0) }))}
                          size="xs"
                          className="px-0 py-0"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)" }}
                          ariaLabel="Unit cost in dollars"
                        />
                        <div className="text-xs px-2 py-1.5 rounded font-semibold flex items-center justify-end"
                          style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: newItemForm.qty * newItemForm.unitCost === 0 ? "var(--text-muted)" : "#22c55e" }}>
                          {fmt(newItemForm.qty * newItemForm.unitCost)}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={addLineItem} disabled={isViewer} className="text-xs px-3 py-1.5 rounded font-semibold" style={{ background: "#22c55e", color: "#fff", opacity: isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }}>Add</button>
                          <button onClick={() => setAddingItem(false)} className="text-xs px-2 py-1.5 rounded" style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>✕</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {catLineItems.length === 0 && !addingItem && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm" style={{ color: "var(--text-muted)" }}>No line items yet. Use "Add Item" or "AI Parse Quote" to add items.</p>
                  </div>
                )}

                {selectedCount > 0 && (
                  <div className="flex items-center gap-3 px-4 py-2.5 mb-2 rounded-lg"
                    style={{ background: "var(--bg-card)", border: "1px solid var(--gold)40", borderLeft: "3px solid var(--gold)" }}>
                    <span className="text-sm font-semibold" style={{ color: "var(--gold)" }}>{selectedCount} selected</span>
                    <div className="flex gap-2 flex-1 flex-wrap">
                      <button onClick={() => setIsTransferModalOpen(true)} disabled={isBulkActionLoading}
                        className="text-xs px-3 py-1.5 rounded font-semibold transition-opacity"
                        style={{ background: "#06b6d415", border: "1px solid #06b6d440", color: "#06b6d4", opacity: isBulkActionLoading ? 0.5 : 1 }}>
                        ↗ Transfer to Scope
                      </button>
                      <button onClick={() => setIsVendorQuoteModalOpen(true)} disabled={isBulkActionLoading}
                        className="text-xs px-3 py-1.5 rounded font-semibold transition-opacity"
                        style={{ background: "#a855f715", border: "1px solid #a855f740", color: "#a855f7", opacity: isBulkActionLoading ? 0.5 : 1 }}>
                        📎 Apply Vendor Quote
                      </button>
                      <button onClick={() => setIsDeleteModalOpen(true)} disabled={isBulkActionLoading}
                        className="text-xs px-3 py-1.5 rounded font-semibold transition-opacity"
                        style={{ background: "#ef444415", border: "1px solid #ef444440", color: "#ef4444", opacity: isBulkActionLoading ? 0.5 : 1 }}>
                        🗑 Delete
                      </button>
                    </div>
                    <button onClick={clearSelection} className="text-xs" style={{ color: "var(--text-muted)" }}>✕ Clear</button>
                  </div>
                )}

                {false && catLineItems.length > 0 && isMobile && (
                  <div className="flex flex-col gap-3 p-3" style={{ background: "var(--bg-card)" }}>
                    {catLineItems.map((item, idx) => {
                      const extended = n(item.unitCost) * item.qty;
                      const quoteOpts = [{ id: "", label: "— No Quote —" }, ...catQuotes.map(q => ({ id: String(q.id), label: q.vendor + (q.note ? ` (${q.note})` : "") }))];
                      const isExpanded = expandedItems.has(item.id);
                      const isSelected = selectedLineItemIds.has(item.id);
                      return (
                        <div key={item.id} className="rounded-lg p-3"
                          style={{ background: isSelected ? "var(--gold)08" : idx % 2 === 0 ? "var(--bg-card)" : "var(--bg3)50", border: `1px solid ${isSelected ? "var(--gold)40" : "var(--border-ds)"}` }}
                          data-testid={`card-line-item-${item.id}`}>
                          {/* Card header: select + #, line total, delete */}
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <input type="checkbox" aria-label={`Select line item ${item.name || item.id}`}
                                checked={isSelected}
                                onChange={() => toggleLineItemSelection(item.id)}
                                style={{ accentColor: "var(--gold)", cursor: "pointer", width: 16, height: 16 }} />
                              <span className="text-[11px] font-semibold" style={{ color: "var(--text-muted)" }}>#{idx + 1}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold" style={{ color: extended === 0 ? "#ef4444" : "#22c55e" }}>{fmt(extended)}</span>
                              <button onClick={() => updateLineItem(item.id, "hasBackup", !item.hasBackup)}
                                title={item.hasBackup ? "Has backup" : "Missing backup"}
                                className="p-1 rounded">
                                {item.hasBackup
                                  ? <CheckSquare className="w-4 h-4" style={{ color: "#22c55e" }} />
                                  : <AlertTriangle className="w-4 h-4" style={{ color: "#ef4444" }} />}
                              </button>
                              <button onClick={() => deleteLineItem(item.id)} className="p-1 rounded">
                                <Trash2 className="w-4 h-4" style={{ color: "#ef4444" }} />
                              </button>
                            </div>
                          </div>

                          {/* Description */}
                          <label className="block mb-2">
                            <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Description</span>
                            <input value={item.name || ""} onChange={e => updateLineItem(item.id, "name", e.target.value)}
                              className="w-full text-sm px-2 py-1.5 rounded"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                            {item.note && <div className="text-[11px] italic mt-0.5" style={{ color: "#f97316" }}>▸ {item.note}</div>}
                          </label>

                          {/* Plan callout + Model row */}
                          <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                            <label className="block">
                              <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Plan Callout</span>
                              <input value={item.planCallout || ""} onChange={e => updateLineItem(item.id, "planCallout", e.target.value)}
                                className="w-full text-sm px-2 py-1.5 rounded"
                                style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-muted)" }} />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Model #</span>
                              <input value={item.model || ""} onChange={e => updateLineItem(item.id, "model", e.target.value)}
                                placeholder="—" className="w-full text-sm px-2 py-1.5 rounded"
                                style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-muted)" }} />
                            </label>
                          </div>

                          {/* Manufacturer */}
                          <label className="block mb-2">
                            <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Manufacturer</span>
                            <ManufacturerCombo
                              value={item.mfr || ""}
                              manufacturerId={item.manufacturerId}
                              allMfrs={allManufacturers}
                              approvedMfrs={approvedMfrs}
                            scopeLabel={ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat}
                              onChange={(name, id) => {
                                setLineItems(prev => prev.map(i => i.id === item.id ? { ...i, mfr: name || null, manufacturerId: id } : i));
                                apiRequest("PATCH", `/api/estimates/line-items/${item.id}`, { mfr: name || null, manufacturerId: id }).catch(() => toast({ title: "Error", description: "Could not update item.", variant: "destructive" }));
                              }}
                              placeholder="—"
                              className="w-full text-sm px-2 py-1.5 rounded"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                          </label>

                          {/* Qty / UOM / Unit Cost row */}
                          <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: "1fr 1fr 1.4fr" }}>
                            <label className="block">
                              <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Qty</span>
                              <input type="number" min={1} value={item.qty} onChange={e => updateLineItem(item.id, "qty", parseInt(e.target.value) || 1)}
                                className="w-full text-sm px-2 py-1.5 rounded text-right"
                                style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text)" }}  onFocus={selectIfZero}/>
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>UOM</span>
                              <select value={item.uom || "EA"} onChange={e => updateLineItem(item.id, "uom", e.target.value)}
                                className="w-full text-sm px-2 py-1.5 rounded"
                                style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                                {["EA", "LF", "SF", "SET"].map(v => <option key={v} value={v}>{v}</option>)}
                              </select>
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Unit Cost</span>
                              <MoneyInput
                                value={item.unitCost}
                                onChange={raw => updateLineItem(item.id, "unitCost", raw)}
                                size="sm"
                                className="w-full"
                                style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)" }}
                                ariaLabel="Unit cost in dollars"
                              />
                            </label>
                          </div>

                          {/* Quote */}
                          <label className="block mb-2">
                            <span className="text-[10px] font-semibold block mb-0.5" style={{ color: "var(--text-muted)" }}>Quote</span>
                            <select value={item.quoteId ? String(item.quoteId) : ""}
                              onChange={e => updateLineItem(item.id, "quoteId", e.target.value ? parseInt(e.target.value) : null)}
                              className="w-full text-sm px-2 py-1.5 rounded"
                              style={{ background: "var(--bg2)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                              {quoteOpts.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
                            </select>
                          </label>

                          {/* Allocation expand button */}
                          {breakoutGroups.length > 0 && (
                            <button onClick={() => setExpandedItems(prev => { const s = new Set(prev); s.has(item.id) ? s.delete(item.id) : s.add(item.id); return s; })}
                              className="w-full text-xs px-2 py-1.5 rounded flex items-center justify-center gap-1"
                              style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "#06b6d4" }}>
                              {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                              Allocate Qty
                            </button>
                          )}
                          {isExpanded && breakoutGroups.length > 0 && (
                            <div className="mt-2 p-2 rounded" style={{ background: "#06b6d408", border: "1px solid #06b6d440" }}>
                              <div className="text-[11px] font-semibold mb-1" style={{ color: "#06b6d4" }}>Allocate Qty {item.qty}:</div>
                              <div className="flex flex-wrap gap-2">
                                {breakoutGroups.map(g => {
                                  const alloc = allocMap[item.id]?.[g.id] || 0;
                                  const totalAlloc = Object.values(allocMap[item.id] || {}).reduce((s: number, q: any) => s + q, 0);
                                  const isOver = totalAlloc > item.qty;
                                  return (
                                    <div key={g.id} className="flex items-center gap-1">
                                      <span className="text-[11px]" style={{ color: "#06b6d4", fontWeight: 600 }}>{g.code}:</span>
                                      <input type="number" min={0} value={alloc}
                                        onChange={e => setAllocation(item.id, g.id, parseInt(e.target.value) || 0)}
                                        className="w-14 text-xs text-center px-1 py-0.5 rounded"
                                        style={{ background: "var(--bg2)", border: `1px solid ${isOver ? "#ef444440" : "var(--border-ds)"}`, color: isOver ? "#ef4444" : "var(--text)" }}  onFocus={selectIfZero}/>
                                    </div>
                                  );
                                })}
                                <span className="text-[11px]" style={{ color: (() => { const total = Object.values(allocMap[item.id] || {}).reduce((s: number, q: any) => s + q, 0); return total === item.qty ? "#22c55e" : total > item.qty ? "#ef4444" : "var(--text-muted)"; })() }}>
                                  {(() => { const total = Object.values(allocMap[item.id] || {}).reduce((s: number, q: any) => s + q, 0); return `${total}/${item.qty}`; })()}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {/* Mobile totals card */}
                    <div className="rounded-lg p-3" style={{ background: "var(--bg3)", border: "2px solid var(--border-ds)" }}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold" style={{ color: "var(--text-secondary)" }}>{catLineItems.length} items</span>
                        <span className="text-base font-bold" style={{ color: "#22c55e" }}>{fmt(calcData[activeCat]?.material || 0)}</span>
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                        + Esc: {fmt(calcData[activeCat]?.escalation || 0)} + Frt: {fmt(calcData[activeCat]?.totalFreight || 0)}
                        <span className="block mt-0.5">= Sub: <strong style={{ color: "var(--text)" }}>{fmt(calcData[activeCat]?.subtotal || 0)}</strong></span>
                      </div>
                    </div>
                  </div>
                )}

                {catLineItems.length > 0 && (
                  <div className="overflow-x-auto -webkit-overflow-scrolling-touch">
                    <table className="text-xs" style={{ width: "100%", minWidth: 1200 }}>
                      <thead>
                        <tr style={{ background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)" }}>
                          <th className="px-2 py-2 text-center" style={{ width: "3%" }}>
                            <input type="checkbox" aria-label="Select all line items"
                              checked={allVisibleSelected} ref={el => { if (el) el.indeterminate = someVisibleSelected; }}
                              onChange={toggleSelectAllVisible}
                              style={{ accentColor: "var(--gold)", cursor: "pointer" }} />
                          </th>
                          <th className="text-left px-3 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "10%" }}>Plan Callout</th>
                          <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "24%" }}>Description</th>
                          <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "11%" }}>Manufacturer</th>
                          <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "11%" }}>Model Number</th>
                          <th className="text-right px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "6%" }}>Qty</th>
                          <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "7%" }}>UOM</th>
                          <th className="text-right px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "9%" }}>Unit Cost</th>
                          <th className="text-right px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "9%" }}>Line Total</th>
                          <th className="text-left px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "18%", minWidth: 180 }}>Quote</th>
                          <th className="text-center px-2 py-2 font-semibold" style={{ color: "var(--text-muted)", width: "4%" }}>Bkup</th>
                          <th className="px-2 py-2" style={{ width: "4%" }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {catLineItems.map((item, idx) => {
                          const extended = n(item.unitCost) * item.qty;
                          const quoteOpts = [{ id: "", label: "— No Quote —" }, ...catQuotes.map(q => ({ id: String(q.id), label: q.vendor + (q.note ? ` (${q.note})` : "") }))];
                          const isExpanded = expandedItems.has(item.id);
                          return [
                              <tr key={`${item.id}-main`} style={{ borderBottom: "1px solid var(--border-ds)", background: selectedLineItemIds.has(item.id) ? "var(--gold)08" : idx % 2 === 0 ? "transparent" : "var(--bg3)50" }}
                                className="hover:bg-blue-500/5 transition-colors">
                                <td className="px-2 py-1.5 text-center">
                                  <input type="checkbox" aria-label={`Select line item ${item.name || item.id}`}
                                    checked={selectedLineItemIds.has(item.id)}
                                    onChange={() => toggleLineItemSelection(item.id)}
                                    style={{ accentColor: "var(--gold)", cursor: "pointer" }} />
                                </td>
                                <td className="px-3 py-1.5">
                                  <input value={item.planCallout || ""} onChange={e => updateLineItem(item.id, "planCallout", e.target.value)}
                                    className="w-full text-xs bg-transparent border-none outline-none"
                                    style={{ color: "var(--text-muted)" }} />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input value={item.name || ""} onChange={e => updateLineItem(item.id, "name", e.target.value)}
                                    className="w-full text-xs bg-transparent border-none outline-none"
                                    style={{ color: "var(--text)" }} />
                                  {item.note && <div className="text-xs italic" style={{ color: "#f97316" }}>▸ {item.note}</div>}
                                </td>
                                <td className="px-2 py-1.5">
                                  <ManufacturerCombo
                                    value={item.mfr || ""}
                                    manufacturerId={item.manufacturerId}
                                    allMfrs={allManufacturers}
                                    approvedMfrs={approvedMfrs}
                            scopeLabel={ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat}
                                    onChange={(name, id) => {
                                      setLineItems(prev => prev.map(i => i.id === item.id ? { ...i, mfr: name || null, manufacturerId: id } : i));
                                      apiRequest("PATCH", `/api/estimates/line-items/${item.id}`, { mfr: name || null, manufacturerId: id }).catch(() => toast({ title: "Error", description: "Could not update item.", variant: "destructive" }));
                                    }}
                                    placeholder="—"
                                    className="w-full text-xs bg-transparent border-none outline-none"
                                    style={{ color: "var(--text-muted)" }} />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input value={item.model || ""} onChange={e => updateLineItem(item.id, "model", e.target.value)}
                                    placeholder="—" className="w-full text-xs bg-transparent border-none outline-none"
                                    style={{ color: "var(--text-muted)" }} />
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <input type="number" min={1} value={item.qty} onChange={e => updateLineItem(item.id, "qty", parseInt(e.target.value) || 1)}
                                    className="w-12 text-xs text-right bg-transparent border-none outline-none"
                                    style={{ color: "var(--text)" }}  onFocus={selectIfZero}/>
                                </td>
                                <td className="px-2 py-1.5">
                                  <select value={item.uom || "EA"} onChange={e => updateLineItem(item.id, "uom", e.target.value)}
                                    className="text-xs px-1 py-0.5 rounded w-full"
                                    style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                                    {["EA", "LF", "SF", "SET"].map(v => <option key={v} value={v}>{v}</option>)}
                                  </select>
                                </td>
                                <td className="px-2 py-1.5 text-right">
                                  <MoneyInput
                                    value={item.unitCost}
                                    onChange={raw => updateLineItem(item.id, "unitCost", raw)}
                                    size="xs"
                                    className="w-24 ml-auto"
                                    ariaLabel="Unit cost in dollars"
                                  />
                                </td>
                                <td className="px-2 py-1.5 text-right font-semibold">
                                  <span style={{ color: extended === 0 ? "#ef4444" : "#22c55e" }}>{fmt(extended)}</span>
                                </td>
                                <td className="px-2 py-1.5">
                                  <select value={item.quoteId ? String(item.quoteId) : ""}
                                    onChange={e => updateLineItem(item.id, "quoteId", e.target.value ? parseInt(e.target.value) : null)}
                                    className="text-xs px-1 py-0.5 rounded w-full"
                                    style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                                    {quoteOpts.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
                                  </select>
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  <button onClick={() => updateLineItem(item.id, "hasBackup", !item.hasBackup)}
                                    title={item.hasBackup ? "Has backup" : "Missing backup"}>
                                    {item.hasBackup
                                      ? <CheckSquare className="w-3.5 h-3.5 mx-auto" style={{ color: "#22c55e" }} />
                                      : <AlertTriangle className="w-3.5 h-3.5 mx-auto" style={{ color: "#ef4444" }} />}
                                  </button>
                                </td>
                                <td className="px-2 py-1.5 text-center">
                                  <div className="flex items-center gap-0.5">
                                    {breakoutGroups.length > 0 && (
                                      <button onClick={() => setExpandedItems(prev => { const s = new Set(prev); s.has(item.id) ? s.delete(item.id) : s.add(item.id); return s; })}
                                        className="p-0.5 rounded hover:bg-blue-500/10" title="Toggle allocation row">
                                        {isExpanded ? <ChevronUp className="w-3 h-3" style={{ color: "#06b6d4" }} /> : <ChevronDown className="w-3 h-3" style={{ color: "var(--text-muted)" }} />}
                                      </button>
                                    )}
                                    <button onClick={() => deleteLineItem(item.id)} className="p-0.5 rounded hover:bg-red-500/10">
                                      <Trash2 className="w-3 h-3" style={{ color: "#ef4444" }} />
                                    </button>
                                  </div>
                                </td>
                              </tr>,
                              /* Allocation row */
                              (isExpanded && breakoutGroups.length > 0) && (
                                <tr key={`alloc-${item.id}`} style={{ background: "#06b6d408", borderBottom: "1px solid var(--border-ds)" }}>
                                  <td colSpan={12} className="px-4 py-2">
                                    <div className="flex items-center gap-3 text-xs">
                                      <span style={{ color: "#06b6d4", fontWeight: 600, minWidth: 80 }}>Allocate Qty {item.qty}:</span>
                                      {breakoutGroups.map(g => {
                                        const alloc = allocMap[item.id]?.[g.id] || 0;
                                        const totalAlloc = Object.values(allocMap[item.id] || {}).reduce((s: number, q: any) => s + q, 0);
                                        const isOver = totalAlloc > item.qty;
                                        return (
                                          <div key={g.id} className="flex items-center gap-1">
                                            <span style={{ color: "#06b6d4", fontWeight: 600 }}>{g.code}:</span>
                                            <input type="number" min={0} value={alloc}
                                              onChange={e => setAllocation(item.id, g.id, parseInt(e.target.value) || 0)}
                                              className="w-12 text-xs text-center px-1 py-0.5 rounded"
                                              style={{ background: "var(--bg2)", border: `1px solid ${isOver ? "#ef444440" : "var(--border-ds)"}`, color: isOver ? "#ef4444" : "var(--text)" }}  onFocus={selectIfZero}/>
                                          </div>
                                        );
                                      })}
                                      <span style={{ color: (() => { const total = Object.values(allocMap[item.id] || {}).reduce((s: number, q: any) => s + q, 0); return total === item.qty ? "#22c55e" : total > item.qty ? "#ef4444" : "var(--text-muted)"; })() }}>
                                        {(() => { const total = Object.values(allocMap[item.id] || {}).reduce((s: number, q: any) => s + q, 0); return `${total}/${item.qty}`; })()}
                                      </span>
                                    </div>
                                  </td>
                                </tr>
                              ),
                          ];
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: "2px solid var(--border-ds)", background: "var(--bg3)" }}>
                          <td colSpan={5} className="px-3 py-2 text-xs font-bold" style={{ color: "var(--text-secondary)" }}>
                            {catLineItems.length} items
                          </td>
                          <td className="px-2 py-2 text-right text-sm font-bold" style={{ color: "#22c55e" }}>
                            {fmt(calcData[activeCat]?.material || 0)}
                          </td>
                          <td colSpan={3} className="px-2 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                            + Esc: {fmt(calcData[activeCat]?.escalation || 0)}
                            {" + "}Frt: {fmt(calcData[activeCat]?.totalFreight || 0)}
                            {" = Sub: "}<strong>{fmt(calcData[activeCat]?.subtotal || 0)}</strong>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>

              {/* Category Qualifications + RFQ Generator — paired on one row */}
              <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
                <button onClick={() => setShowCatQuals(!showCatQuals)}
                  className="text-xs px-3 py-1.5 rounded flex items-center gap-1"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}
                  data-testid="btn-toggle-cat-quals">
                  <FileText className="w-3 h-3" /> Category Qualifications {showCatQuals ? "▲" : "▼"}
                </button>
                <button onClick={() => setShowRfq(!showRfq)}
                  className="text-sm px-4 py-2 rounded-lg flex items-center gap-2 font-bold transition-all hover:opacity-90"
                  style={{
                    background: "linear-gradient(135deg, var(--gold) 0%, #d4a017 100%)",
                    border: "1px solid var(--gold)",
                    color: "#1a1a1a",
                    boxShadow: "0 2px 8px rgba(212,160,23,0.35)",
                  }}
                  data-testid="btn-toggle-rfq-generator">
                  <Send className="w-4 h-4" /> RFQ Generator {showRfq ? "▲" : "▼"}
                </button>
              </div>
              {showCatQuals && (
                <div className="mb-4 p-4 rounded-lg" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
                  {["inclusions", "exclusions", "qualifications"].map(f => (
                    <div key={f} className="mb-3">
                      <label className="text-xs block mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{f}</label>
                      <textarea value={catQuals[activeCat]?.[f as keyof typeof catQuals[string]] || ""}
                        onChange={e => { setCatQuals(p => ({ ...p, [activeCat]: { ...p[activeCat], [f]: e.target.value } })); markDirty(); }}
                        placeholder={`Enter ${f}...`} rows={2}
                        className="w-full text-xs px-2 py-1.5 rounded resize-y"
                        style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Approved Manufacturers (RFQ Vendor Lookup) — only when feature is enabled */}
              {rfqLookupEnabled && (
                <div className="mb-4 p-4 rounded-lg" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid var(--gold)" }} data-testid="card-approved-manufacturers">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>Approved Manufacturers</div>
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>Curate the manufacturers you'll RFQ for this scope. Linked vendor contacts auto-populate the RFQ email.</div>
                    </div>
                    <button
                      onClick={() => { setMfrSearchTerm(""); setNewMfrName(""); setShowAddMfrModal(true); }}
                      className="text-xs px-3 py-1.5 rounded flex items-center gap-1"
                      style={{ background: "var(--gold)15", border: "1px solid var(--gold)40", color: "var(--gold)" }}
                      data-testid="button-add-approved-mfr"
                    >
                      <Plus className="w-3 h-3" /> Add Manufacturer
                    </button>
                  </div>
                  {approvedMfrs.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>No approved manufacturers yet. Add one to drive the RFQ Generator below.</p>
                  ) : (
                    <div className="space-y-2">
                      {approvedMfrs.map(am => (
                        <div key={am.id} className="p-3 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }} data-testid={`row-approved-mfr-${am.manufacturerId}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-semibold" style={{ color: "var(--gold)" }}>{am.manufacturerName}</span>
                              {am.isBasisOfDesign && <Badge className="text-[10px]" style={{ background: "#22c55e20", color: "#22c55e", border: "1px solid #22c55e40" }}>Basis of Design</Badge>}
                              {am.vendors.length === 0 && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>(no linked vendor)</span>}
                            </div>
                            <div className="flex gap-1">
                              <button
                                onClick={() => toggleBasisOfDesignMutation.mutate({ id: am.id, isBasisOfDesign: !am.isBasisOfDesign })}
                                className="text-[10px] px-2 py-0.5 rounded"
                                style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", color: "var(--text-muted)" }}
                                data-testid={`button-toggle-bod-${am.manufacturerId}`}
                              >{am.isBasisOfDesign ? "Unset BOD" : "Set BOD"}</button>
                              <button
                                onClick={() => { if (!guardViewer(isViewer, toast)) removeApprovedMfrMutation.mutate(am.id); }}
                                disabled={isViewer}
                                className="text-[10px] px-2 py-0.5 rounded flex items-center gap-1"
                                style={{ background: "#ef444415", border: "1px solid #ef444440", color: "#ef4444", opacity: isViewer ? 0.4 : 1, cursor: isViewer ? "not-allowed" : "pointer" }}
                                data-testid={`button-remove-approved-mfr-${am.manufacturerId}`}
                              ><Trash2 className="w-3 h-3" /></button>
                            </div>
                          </div>
                          {am.vendors.length > 0 && (
                            <div className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                              {am.vendors.map(v => {
                                const primary = v.contacts.find(c => c.isPrimary) || v.contacts[0];
                                return (
                                  <div key={v.vendorId} className="flex items-center gap-1.5">
                                    <Users className="w-3 h-3" />
                                    <span style={{ color: "var(--text-secondary)" }}>{v.vendorName}</span>
                                    {v.manufacturerDirect && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(91,141,239,0.15)", color: "#5B8DEF" }} title="Manufacturer Direct" data-testid={`badge-direct-approved-${v.vendorId}`}>DIRECT</span>}
                                    {primary && <span>· {primary.name}{primary.email ? ` <${primary.email}>` : ""}</span>}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* RFQ Generator — toggle is now in the header row above */}
              <div className="mb-4">
                {showRfq && (() => {
                  // Combine approved manufacturers + manufacturers found on line items
                  const lineItemMfrs = Array.from(new Set(catLineItems.map(i => i.mfr).filter(Boolean))) as string[];
                  const approvedNames = approvedMfrs.map(a => a.manufacturerName);
                  type Combined = { name: string; approved?: ApprovedMfr; discoveredMfrId?: number };
                  const combined: Combined[] = [];
                  for (const am of approvedMfrs) combined.push({ name: am.manufacturerName, approved: am });
                  for (const li of lineItemMfrs) {
                    if (approvedNames.some(an => namesMatch(an, li))) continue;
                    const itemWithId = catLineItems.find(i => i.mfr === li && (i as any).manufacturerId);
                    const fkId: number | undefined = (itemWithId as any)?.manufacturerId;
                    const byName = allManufacturers.find(m => m.name.trim().toLowerCase() === li.trim().toLowerCase());
                    const discoveredMfrId = fkId ?? byName?.id;
                    combined.push({ name: li, discoveredMfrId });
                  }

                  // Resolve eligible vendor source for an entry
                  const sourceFor = (entry: Combined): { mfrId: number; vendors: ApprovedMfr["vendors"] } | null => {
                    if (entry.approved) return { mfrId: entry.approved.manufacturerId, vendors: entry.approved.vendors };
                    if (entry.discoveredMfrId) {
                      const d = discoveredMfrs.find(x => x.manufacturerId === entry.discoveredMfrId);
                      return d ? { mfrId: d.manufacturerId, vendors: d.vendors } : null;
                    }
                    return null;
                  };
                  const itemsForMfr = (mfrName: string) => catLineItems.filter(i => i.mfr && namesMatch(i.mfr, mfrName));

                  // Build per-vendor groupings (vendor → set of manufacturers it can quote for this scope)
                  type VendorGroup = {
                    vendorId: number;
                    vendorName: string;
                    manufacturerDirect: boolean;
                    contacts: Array<{ id: number; name: string; role?: string | null; email: string | null; isPrimary: boolean }>;
                    manufacturers: Array<{ name: string; mfrId: number; items: typeof catLineItems }>;
                  };
                  const byVendor = new Map<number, VendorGroup>();
                  for (const entry of combined) {
                    const src = sourceFor(entry);
                    if (!src) continue;
                    for (const v of src.vendors) {
                      const scopesOk = !v.scopes || v.scopes.length === 0 || v.scopes.includes(activeCat);
                      // Loosened eligibility: only the scope tag gates a vendor.
                      // Manufacturer tags are no longer required — any scope-eligible
                      // vendor surfaces for every manufacturer card.
                      if (!scopesOk) continue;
                      let g = byVendor.get(v.vendorId);
                      if (!g) {
                        g = { vendorId: v.vendorId, vendorName: v.vendorName, manufacturerDirect: !!v.manufacturerDirect, contacts: [], manufacturers: [] };
                        byVendor.set(v.vendorId, g);
                      }
                      for (const c of v.contacts) {
                        if (!g.contacts.find(x => x.id === c.id)) g.contacts.push(c);
                      }
                      if (!g.manufacturers.find(m => m.mfrId === src.mfrId)) {
                        g.manufacturers.push({ name: entry.name, mfrId: src.mfrId, items: itemsForMfr(entry.name) });
                      }
                    }
                  }
                  const vendorGroups = Array.from(byVendor.values()).sort((a, b) => {
                    if (!!a.manufacturerDirect !== !!b.manufacturerDirect) return a.manufacturerDirect ? -1 : 1;
                    return a.vendorName.localeCompare(b.vendorName);
                  });

                  return (
                    <div className="mt-2 p-4 rounded-lg" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
                      {/* Bid Due / Vendor Response Override */}
                      <div className="mb-3 p-3 rounded flex items-center gap-4 flex-wrap" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }} data-testid="rfq-due-date-row">
                        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                          Bid Due Date: <span style={{ color: "var(--text-secondary)", fontWeight: 600 }} data-testid="text-rfq-bid-due">{proposalEntry?.dueDate || "—"}</span>
                        </div>
                        <label className="flex items-center gap-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                          Vendor Response Needed By:
                          <input
                            type="date"
                            value={responseNeededByByCat[activeCat] ?? (proposalEntry?.dueDate || "")}
                            onChange={e => setResponseNeededByByCat(prev => ({ ...prev, [activeCat]: e.target.value }))}
                            className="text-xs px-2 py-1 rounded"
                            style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                            data-testid="input-rfq-response-needed-by"
                          />
                          {responseNeededByByCat[activeCat] && responseNeededByByCat[activeCat] !== (proposalEntry?.dueDate || "") && (
                            <button
                              onClick={() => setResponseNeededByByCat(prev => { const n = { ...prev }; delete n[activeCat]; return n; })}
                              className="text-[10px] underline"
                              style={{ color: "var(--text-muted)" }}
                              data-testid="button-clear-rfq-override"
                            >reset</button>
                          )}
                        </label>
                        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>(override only affects RFQ emails — proposal log is not changed)</span>
                        <div className="ml-auto">
                          <button
                            onClick={() => {
                              if (guardViewer(isViewer, toast)) return;
                              setOpenRfqSelectedItemIds(new Set(catLineItems.map(i => String(i.id))));
                              setOpenRfqExistingVendorIds(new Set());
                              setOpenRfqVendorMode("existing");
                              setOpenRfqVendorSearch("");
                              setOpenRfqOnlyDirect(false);
                              setOpenRfqNewVendorName("");
                              setOpenRfqNewVendorEmail("");
                              setOpenRfqExtraNotes("");
                              setShowOpenRfq(true);
                            }}
                            disabled={isViewer}
                            className="text-xs px-3 py-1.5 rounded-md flex items-center gap-1.5 font-semibold transition-all hover:brightness-110"
                            style={{ background: "linear-gradient(135deg, var(--gold), #c9962f)", border: "1px solid var(--gold)", color: "#1a1a1a", boxShadow: "0 2px 8px rgba(212,175,55,0.25)", opacity: isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }}
                            data-testid="button-open-rfq">
                            <Send className="w-3.5 h-3.5" /> Open RFQ
                          </button>
                        </div>
                      </div>

                      {/* ── Vendor-grouped view ── */}
                      {(() => {
                        const visibleVendorGroups = vendorGroups.filter(g => g.contacts.length > 0);
                        const hiddenVendorCount = vendorGroups.length - visibleVendorGroups.length;
                        if (!rfqGroupByVendor) return null;
                        return (
                          <div style={{ display: "contents" }}>
                            {combined.length > 0 && visibleVendorGroups.length === 0 && (
                              <p className="text-xs" style={{ color: "var(--text-muted)" }}>No eligible vendors with contacts for this scope. Tag vendors in the Vendor Database with the active scope, or use Open RFQ above for ad-hoc requests.</p>
                            )}
                            {hiddenVendorCount > 0 && (
                              <p className="text-[10px] mb-2" style={{ color: "var(--text-muted)" }}>{hiddenVendorCount} vendor card{hiddenVendorCount === 1 ? "" : "s"} hidden (no contacts).</p>
                            )}
                          </div>
                        );
                      })()}
                      {rfqGroupByVendor && vendorGroups.filter(g => g.contacts.length > 0).map(g => {
                        const eligibleCount = g.contacts.length;
                        return (
                          <div key={g.vendorId} className="mb-3 p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }} data-testid={`rfq-vendor-card-${g.vendorId}`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2 flex-wrap">
                                <Users className="w-3 h-3" style={{ color: "var(--gold)" }} />
                                <span className="text-xs font-semibold" style={{ color: "var(--gold)" }}>{g.vendorName}</span>
                                {g.manufacturerDirect && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "rgba(91,141,239,0.15)", color: "#5B8DEF" }} title="Manufacturer Direct" data-testid={`badge-direct-rfq-vendor-${g.vendorId}`}>DIRECT</span>}
                                <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                                  {g.manufacturers.length} mfr{g.manufacturers.length === 1 ? "" : "s"} · {eligibleCount} contact{eligibleCount === 1 ? "" : "s"}
                                </span>
                              </div>
                              <button
                                onClick={() => {
                                  if (guardViewer(isViewer, toast)) return;
                                  setRfqVendorPicker(g.vendorId);
                                  setRfqVendorPickerContactIds(new Set(g.contacts.map(c => c.id)));
                                }}
                                disabled={eligibleCount === 0 || isViewer}
                                className="text-xs px-2 py-1 rounded flex items-center gap-1"
                                style={{ background: "var(--gold)15", border: "1px solid var(--gold)40", color: "var(--gold)", opacity: eligibleCount === 0 || isViewer ? 0.5 : 1, cursor: eligibleCount === 0 || isViewer ? "not-allowed" : "pointer" }}
                                title={isViewer ? "Read-only access" : eligibleCount === 0 ? "No contacts on this vendor" : "Pick recipients & send consolidated RFQ"}
                                data-testid={`button-vendor-pick-${g.vendorId}`}>
                                <Send className="w-3 h-3" /> Pick Recipients & Send
                              </button>
                            </div>
                            <div className="text-[11px] space-y-0.5" style={{ color: "var(--text-muted)" }}>
                              {g.manufacturers.map(m => (
                                <div key={m.mfrId}>
                                  <span style={{ color: "var(--text-secondary)", fontWeight: 600 }}>★ {m.name}</span>
                                  {m.items.length > 0 ? <> — {m.items.length} item{m.items.length === 1 ? "" : "s"}</> : <> — TBD</>}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}

                      {/* Per-manufacturer RFQ cards hidden — use Open RFQ above for ad-hoc sends */}
                    </div>
                  );
                })()}

                {/* RFQ Sent Log — current scope only */}
                <div className="mt-4 p-4 rounded-lg" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }} data-testid="card-rfq-log">
                  <div className="flex items-center justify-between mb-2">
                    <button
                      type="button"
                      onClick={() => setRfqLogCollapsed(v => !v)}
                      className="flex items-center gap-2"
                      data-testid="button-rfq-log-collapse"
                    >
                      {rfqLogCollapsed ? <ChevronRight className="w-3 h-3" style={{ color: "var(--gold)" }} /> : <ChevronDown className="w-3 h-3" style={{ color: "var(--gold)" }} />}
                      <FileText className="w-3 h-3" style={{ color: "var(--gold)" }} />
                      <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>RFQ Log</span>
                      <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                        {ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat} · {rfqLogEntries.length} entr{rfqLogEntries.length === 1 ? "y" : "ies"}
                      </span>
                    </button>
                    {!rfqLogCollapsed && rfqLogEntries.length > 10 && (
                      <button
                        onClick={() => setRfqLogExpandAll(v => !v)}
                        className="text-[11px] underline"
                        style={{ color: "var(--gold)" }}
                        data-testid="button-rfq-log-toggle-all"
                      >{rfqLogExpandAll ? `Show recent 10` : `View all (${rfqLogEntries.length})`}</button>
                    )}
                  </div>
                  {!rfqLogCollapsed && (rfqLogEntries.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>No RFQs sent for this scope yet. Copy or open an RFQ above to start logging.</p>
                  ) : (
                    <div className="overflow-x-auto rounded" style={{ border: "1px solid var(--border-ds)" }}>
                      <table className="w-full text-xs" style={{ minWidth: 640 }}>
                        <thead style={{ background: "var(--bg3)" }}>
                          <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
                            <th className="px-2 py-1.5 font-semibold">Manufacturer</th>
                            <th className="px-2 py-1.5 font-semibold">Sent To</th>
                            <th className="px-2 py-1.5 font-semibold">Sent By</th>
                            <th className="px-2 py-1.5 font-semibold">Date &amp; Time</th>
                            <th className="px-2 py-1.5 font-semibold">Project</th>
                            <th className="px-2 py-1.5 font-semibold">Scope</th>
                            <th className="px-2 py-1.5 font-semibold text-center">Quote</th>
                            <th className="px-2 py-1.5 font-semibold text-center">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(rfqLogExpandAll ? rfqLogEntries : rfqLogEntries.slice(0, 10)).map(r => {
                            // Tie quotes back to this RFQ row via rfq_log_id (precise — won't false-positive
                            // when one vendor was RFQ'd for multiple manufacturers in the same scope).
                            const matchingQuotes = quotes.filter(q => q.rfqLogId === r.id);
                            return (
                            <tr key={r.id} style={{ borderTop: "1px solid var(--border-ds)40", color: "var(--text-secondary)" }} data-testid={`row-rfq-log-${r.id}`}>
                              <td className="px-2 py-1.5" style={{ color: "var(--text)" }}>{r.manufacturerName}</td>
                              <td className="px-2 py-1.5" style={{ wordBreak: "break-all" }}>
                                {(r.recipientEmails && r.recipientEmails.length > 0) ? r.recipientEmails.join(", ") : <span style={{ color: "var(--text-muted)" }}>—</span>}
                              </td>
                              <td className="px-2 py-1.5">{r.sentBy}</td>
                              <td className="px-2 py-1.5 whitespace-nowrap">{new Date(r.sentAt).toLocaleString()}</td>
                              <td className="px-2 py-1.5">{r.projectName}</td>
                              <td className="px-2 py-1.5">{r.scopeLabel}</td>
                              <td className="px-2 py-1.5 text-center" data-testid={`cell-rfq-log-quote-${r.id}`}>
                                {matchingQuotes.length === 0 ? (
                                  <span style={{ color: "var(--text-muted)" }}>—</span>
                                ) : (
                                  <span title={matchingQuotes.map(q => q.vendor).join(", ")}
                                    style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(34,197,94,0.15)", color: "#22c55e", whiteSpace: "nowrap" }}
                                    data-testid={`badge-rfq-log-quote-received-${r.id}`}>
                                    ✓ {matchingQuotes.length === 1 ? matchingQuotes[0].vendor : `${matchingQuotes.length} QUOTES`}
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: r.action === "email" ? "rgba(91,141,239,0.15)" : "rgba(201,168,76,0.15)", color: r.action === "email" ? "#5B8DEF" : "var(--gold)" }}>
                                  {r.action.toUpperCase()}
                                </span>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>

              {/* OH/Fee/Esc — collapsible markups bar (sits just above the Line Items Checklist) */}
              {(() => {
                const markupRows = [
                  { key: "oh", label: "OH", color: "#f97316", isOvr: calcData[activeCat]?.isOhOvr, rate: calcData[activeCat]?.ohRate, def: defaultOh, onChange: (v: string) => v === "" ? setCatOverrides(p => { const n = { ...p }; if (n[activeCat]) { delete n[activeCat].oh; if (!Object.keys(n[activeCat]).length) delete n[activeCat]; } return n; }) : requestOhChange(activeCat, parseFloat(v) || 0), locked: true, disabled: false },
                  { key: "fee", label: "Fee", color: "#22c55e", isOvr: calcData[activeCat]?.isFeeOvr, rate: calcData[activeCat]?.feeRate, def: defaultFee, onChange: (v: string) => v === "" ? setCatOverrides(p => { const n = { ...p }; if (n[activeCat]) { delete n[activeCat].fee; if (!Object.keys(n[activeCat]).length) delete n[activeCat]; } return n; }) : requestFeeChange(activeCat, parseFloat(v) || 0), locked: true, disabled: false },
                  { key: "esc", label: "Esc", color: "var(--gold)", isOvr: calcData[activeCat]?.isEscOvr, rate: calcData[activeCat]?.escRate, def: defaultEsc, onChange: (v: string) => { v === "" ? setCatOverrides(p => { const n = { ...p }; if (n[activeCat]) { delete n[activeCat].esc; if (!Object.keys(n[activeCat]).length) delete n[activeCat]; } return n; }) : setCatOverrides(p => ({ ...p, [activeCat]: { ...p[activeCat], esc: parseFloat(v) || 0 } })); markDirty(); }, locked: false, disabled: false },
                ];
                const anyOvr = markupRows.some(r => r.isOvr);
                return (
                  <div className="rounded-lg mb-3 overflow-hidden"
                    style={{ background: "#f9731610", border: "1px solid #f9731630" }}>
                    <div className="flex items-center gap-3 flex-wrap px-3 py-2">
                      <button
                        onClick={() => setShowMarkupsBar(v => !v)}
                        data-testid="btn-toggle-markups"
                        className="flex items-center gap-1.5 text-xs font-bold"
                        style={{ color: "#f97316" }}
                        title={showMarkupsBar ? "Collapse markups" : "Expand to edit markups"}>
                        {showMarkupsBar ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        Markups
                      </button>
                      {markupRows.map(r => (
                        <span key={r.key} className="text-xs flex items-center gap-1"
                          style={{ color: r.isOvr ? r.color : "var(--text-muted)" }}>
                          <span className="font-semibold" style={{ color: r.color }}>{r.label}</span>
                          <span style={{ color: r.isOvr ? r.color : "var(--text-secondary)", fontWeight: r.isOvr ? 600 : 400 }}>
                            {(r.isOvr ? r.rate : r.def)}%
                          </span>
                          {r.isOvr && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>(ovr)</span>}
                        </span>
                      ))}
                      {!anyOvr && (
                        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>defaults — click to override</span>
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        {pendingOh.length > 0 && (
                          <span className="text-xs" style={{ color: "#f97316" }}>🔒 {pendingOh.length} OH change(s) pending approval</span>
                        )}
                        <button onClick={() => tryCompleteCat(activeCat)}
                          className="text-xs px-3 py-1.5 rounded font-semibold transition-all"
                          style={{
                            background: calcData[activeCat]?.isComplete ? "#22c55e" : "var(--bg-card)",
                            border: `1px solid ${calcData[activeCat]?.isComplete ? "#22c55e" : "var(--border-ds)"}`,
                            color: calcData[activeCat]?.isComplete ? "#fff" : "var(--text-secondary)",
                          }}>
                          {calcData[activeCat]?.isComplete ? "✓ Complete" : "Mark Complete"}
                        </button>
                      </div>
                    </div>
                    {showMarkupsBar && (
                      <div className="flex items-center gap-4 flex-wrap px-3 pb-2.5 pt-1"
                        style={{ borderTop: "1px solid #f9731625" }}>
                        {markupRows.map(r => (
                          <div key={r.key} className="flex items-center gap-1.5">
                            <span className="text-xs font-bold" style={{ color: r.color }}>{r.label}:</span>
                            <input type="number" step={0.5} value={r.isOvr ? r.rate : ""} placeholder={`${r.def}%`}
                              disabled={r.disabled}
                              onChange={e => r.onChange(e.target.value)}
                              className="text-xs text-right px-2 py-1 rounded w-14"
                              style={{ background: "var(--bg-card)", border: `1px solid ${r.isOvr ? r.color + "60" : "var(--border-ds)"}`, color: r.isOvr ? r.color : "var(--text-muted)", opacity: r.disabled ? 0.6 : 1, cursor: r.disabled ? "not-allowed" : "auto" }}  onFocus={selectIfZero}/>
                            <span className="text-xs" style={{ color: "var(--text-muted)" }}>%</span>
                            {r.locked && r.isOvr && <Lock className="w-3 h-3" style={{ color: "#ef4444" }} />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Line items checklist */}
              <div className="rounded-lg p-4 mb-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
                <div className="text-xs font-semibold mb-2">Line Items Checklist</div>
                {effectiveChecklist.filter(c => c.stage === "lineItems").map(c => (
                  <label key={c.id} className="flex items-center gap-2 py-1 cursor-pointer text-xs"
                    style={{ color: c.done ? "#22c55e" : "var(--text-secondary)" }}>
                    <input type="checkbox" checked={c.done} disabled={c.auto}
                      onChange={() => { if (!c.auto) setChecklist(p => p.map(x => x.id === c.id ? { ...x, done: !x.done } : x)); }}
                      style={{ accentColor: "#22c55e" }} />
                    <span style={{ textDecoration: c.done ? "line-through" : "none" }}>{c.label}</span>
                    {c.auto && <span className="italic" style={{ color: "var(--text-muted)" }}>(auto)</span>}
                  </label>
                ))}
              </div>

              <button onClick={() => goToStage("calculations")}
                className="px-6 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
                style={{ background: "#22c55e", color: "#fff" }}>
                Continue to Markups <ChevronRight className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* STAGE 3: MARKUPS */}
      {/* ══════════════════════════════════════════════════ */}
      {stage === "calculations" && (
        <div className="max-w-7xl mx-auto px-6 pt-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {/* Global defaults */}
            <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #f97316" }}>
              <h3 className="text-sm font-semibold mb-4">Global Defaults</h3>
              {[
                { label: "Escalation (%)", value: defaultEsc, set: setDefaultEsc, step: 0.5, color: "var(--gold)", locked: false, disabled: false },
                { label: "Overhead (%) 🔒", value: defaultOh, set: () => toast({ title: "Executive Approval Required", description: `OH default at ${defaultOh}%. Contact Kenny Ruester to change.` }), step: 0.5, color: "#f97316", locked: true, disabled: false },
                { label: "Fee (%) 🔒", value: defaultFee, set: () => toast({ title: "Executive Approval Required", description: `Fee default at ${defaultFee}%. Contact Kenny Ruester to change.` }), step: 0.5, color: "#22c55e", locked: true, disabled: false },
                { label: "Sales Tax (%)", value: taxRate, set: setTaxRate, step: 0.25, color: "#f97316", locked: false, disabled: false },
                { label: "Bond (%)", value: bondRate, set: setBondRate, step: 0.5, color: "#f97316", locked: false, disabled: false },
              ].map(r => (
                <div key={r.label} className="flex justify-between items-center py-2.5" style={{ borderBottom: "1px solid var(--border-ds)20" }}>
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>{r.label}</span>
                  <input type="number" value={r.value} step={r.step}
                    disabled={r.disabled}
                    onChange={e => { if (!r.locked) { r.set(parseFloat(e.target.value) || 0); markDirty(); } else r.set(0); }}
                    className="w-20 text-sm font-bold text-right px-2 py-1 rounded"
                    style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: r.color, opacity: r.locked ? 0.7 : 1, cursor: r.disabled ? "not-allowed" : "auto" }}  onFocus={selectIfZero}/>
                </div>
              ))}
              <div className="mt-3 p-2 rounded text-xs" style={{ background: "#f9731610", color: "#f97316" }}>
                Material → Escalation → + Freight = Subtotal → OH on subtotal → Net-based fee on subtotal → Tax on material only
              </div>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>🔒 Overhead and Fee changes require executive approval. Category-level overrides can be requested below.</p>
              {/* Fee Calculation Preview */}
              {(() => {
                const previewSub = calcData.allSub || 0;
                const feePct = defaultFee / 100;
                const feeAmount = feePct <= 0 || feePct >= 1 ? 0 : (previewSub / (1 - feePct)) - previewSub;
                const subtotalAfterFee = previewSub + feeAmount;
                return (
                  <div className="mt-4 rounded-lg p-3" style={{ background: "#22c55e08", border: "1px solid #22c55e30" }}>
                    <div className="text-xs font-semibold mb-2" style={{ color: "#22c55e" }}>Fee Calculation Preview</div>
                    {[
                      { label: "Subtotal Before Fee", value: fmt(previewSub), green: false },
                      { label: "Fee (%)", value: `${defaultFee}%`, green: false },
                      { label: "Fee Amount", value: fmt(feeAmount), green: true },
                      { label: "Subtotal After Fee", value: fmt(subtotalAfterFee), green: true },
                    ].map((row, i) => (
                      <div key={row.label} className="flex justify-between py-1 text-xs"
                        style={{ borderBottom: i < 3 ? "1px solid #22c55e15" : "none", color: row.green ? "#22c55e" : "var(--text-secondary)" }}>
                        <span>{row.label}</span>
                        <span className="font-medium">{row.value}</span>
                      </div>
                    ))}
                    <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>Fee is calculated so the selected percent represents the profit portion of the final selling amount.</p>
                    <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>Subtotal After Fee = Subtotal Before Fee ÷ (1 - Fee %)</p>
                  </div>
                );
              })()}
            </div>

            {/* Grand totals */}
            <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #f97316" }}>
              <h3 className="text-sm font-semibold mb-4">Totals</h3>
              {[
                { l: "Material", v: calcData.allMat, bold: true },
                { l: `Escalation (${defaultEsc}%)`, v: calcData.allEsc, color: "var(--gold)" },
                { l: "Freight", v: calcData.allFrt },
                null,
                { l: "Subtotal", v: calcData.allSub, bold: true },
                { l: `Overhead (${defaultOh}%)`, v: calcData.allOh, color: "#f97316" },
                { l: `Fee (${defaultFee}%)`, v: calcData.allFee, color: "#22c55e" },
                { l: `Tax (${taxRate}% on material)`, v: calcData.allTax },
                ...(bondRate > 0 ? [{ l: `Bond (${bondRate}%)`, v: calcData.allBond }] : []),
              ].map((r, i) => !r
                ? <div key={i} className="border-t my-2" style={{ borderColor: "var(--border-ds)" }} />
                : (
                  <div key={i} className="flex justify-between py-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                    <span>{r.l}</span>
                    <span className={r.bold ? "font-bold text-sm" : "font-medium"} style={{ color: (r as any).color || (r.bold ? "var(--text)" : "var(--text-muted)") }}>
                      {fmt(r.v)}
                    </span>
                  </div>
                )
              )}
              <div className="mt-4 p-4 rounded-lg flex justify-between items-center"
                style={{ background: "linear-gradient(135deg, #f9731615, #22c55e10)", border: "1px solid #22c55e30" }}>
                <span className="text-sm font-bold">GRAND TOTAL</span>
                <span className="text-2xl font-black" style={{ color: "#22c55e" }}>{fmt(calcData.grandTotal)}</span>
              </div>
            </div>
          </div>

          {/* Per-category breakdown */}
          <div className="rounded-lg p-5 mb-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #f97316" }}>
            <h3 className="text-sm font-semibold mb-3">By Category</h3>
            {CATEGORIES.filter(c => calcData[c.id]?.items > 0).length === 0 && (
              <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>No line items yet. Add items in Stage 2.</p>
            )}
            {CATEGORIES.filter(c => calcData[c.id]?.items > 0).map(c => {
              const d = calcData[c.id];
              const hasAnyOverride = d.isOhOvr || d.isFeeOvr || d.isEscOvr;
              return (
                <div key={c.id} className="p-3 rounded-lg mb-2"
                  style={{ background: "var(--bg3)", border: `1px solid ${hasAnyOverride ? "#f9731640" : "var(--border-ds)"}` }}>
                  <div className="flex justify-between items-center flex-wrap gap-2 mb-2">
                    <div>
                      <span className="text-sm font-semibold">{c.label}</span>
                      <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>{c.csi}</span>
                      {d.isComplete && <span className="ml-2 text-xs" style={{ color: "#22c55e" }}>✓</span>}
                    </div>
                    <span className="text-base font-bold" style={{ color: "#22c55e" }}>{fmt(d.total)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { label: "Escalation", rate: d.escRate, isOvr: d.isEscOvr, val: d.escalation, impact: d.escImpact, color: "var(--gold)", key: "esc" },
                      { label: "Overhead 🔒", rate: d.ohRate, isOvr: d.isOhOvr, val: d.oh, impact: d.ohImpact, color: "#f97316", key: "oh" },
                      { label: "Fee", rate: d.feeRate, isOvr: d.isFeeOvr, val: d.fee, impact: d.feeImpact, color: "#22c55e", key: "fee" },
                    ].map(r => (
                      <div key={r.key} className="px-3 py-2 rounded"
                        style={{ background: r.isOvr ? r.color + "0A" : "transparent", border: `1px solid ${r.isOvr ? r.color + "30" : "var(--border-ds)60"}` }}>
                        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{r.label}</div>
                        <div className="text-sm font-bold" style={{ color: r.isOvr ? r.color : "var(--text-muted)" }}>
                          {r.rate}%
                          {r.isOvr && <span className="text-xs font-normal ml-1" style={{ color: "var(--text-muted)" }}>(def: {r.key === "esc" ? defaultEsc : r.key === "oh" ? defaultOh : defaultFee}%)</span>}
                        </div>
                        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{fmt(r.val)}</div>
                        {r.isOvr && <div className="text-xs mt-0.5" style={{ color: "#f97316" }}>Impact: {r.impact > 0 ? "+" : ""}{fmt(r.impact)}</div>}
                      </div>
                    ))}
                  </div>
                  <div className="flex justify-between mt-2 text-xs pt-2" style={{ borderTop: "1px solid var(--border-ds)40", color: "var(--text-muted)" }}>
                    <span>Mat: {fmt(d.material)} + Frt: {fmt(d.totalFreight)} + Tax: {fmt(d.tax)}{bondRate > 0 ? ` + Bond: ${fmt(d.bond)}` : ""}</span>
                    {hasAnyOverride && <span style={{ color: "#f97316" }}>⚠ Has overrides</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* OH Approval Log (admin) */}
          {pendingOh.length > 0 && (
            <div className="rounded-lg p-4 mb-4" style={{ background: "var(--bg-card)", border: "1px solid #f9731640", borderLeft: "3px solid #f97316" }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: "#f97316" }}>🔒 Pending OH Approval Requests</h3>
              {pendingOh.map(l => (
                <div key={l.id} className="flex items-center gap-3 py-2 text-xs" style={{ borderBottom: "1px solid var(--border-ds)" }}>
                  <div className="flex-1">
                    <span className="font-semibold">{l.catLabel}</span>
                    <span className="ml-2" style={{ color: "var(--text-muted)" }}>
                      {l.oldRate}% → {l.newRate}% (requested by {l.requestedBy})
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => approveOhChange(l.id)} className="px-2 py-1 rounded text-xs font-semibold" style={{ background: "#22c55e", color: "#fff" }}>Approve</button>
                    <button onClick={() => denyOhChange(l.id)} className="px-2 py-1 rounded text-xs" style={{ background: "#ef444415", border: "1px solid #ef444440", color: "#ef4444" }}>Deny</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Fee Approval Log (admin) */}
          {pendingFee.length > 0 && (
            <div className="rounded-lg p-4 mb-4" style={{ background: "var(--bg-card)", border: "1px solid #22c55e40", borderLeft: "3px solid #22c55e" }}>
              <h3 className="text-sm font-semibold mb-3" style={{ color: "#22c55e" }}>🔒 Pending Fee Approval Requests</h3>
              {pendingFee.map(l => (
                <div key={l.id} className="flex items-center gap-3 py-2 text-xs" style={{ borderBottom: "1px solid var(--border-ds)" }}>
                  <div className="flex-1">
                    <span className="font-semibold">{l.catLabel}</span>
                    <span className="ml-2" style={{ color: "var(--text-muted)" }}>
                      {l.oldRate}% → {l.newRate}% (requested by {l.requestedBy})
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => approveOhChange(l.id)} className="px-2 py-1 rounded text-xs font-semibold" style={{ background: "#22c55e", color: "#fff" }}>Approve</button>
                    <button onClick={() => denyOhChange(l.id)} className="px-2 py-1 rounded text-xs" style={{ background: "#ef444415", border: "1px solid #ef444440", color: "#ef4444" }}>Deny</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Markups checklist */}
          <div className="rounded-lg p-4 mb-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
            <div className="text-xs font-semibold mb-2">Markups Checklist</div>
            {effectiveChecklist.filter(c => c.stage === "calculations").map(c => (
              <label key={c.id} className="flex items-center gap-2 py-1 cursor-pointer text-xs"
                style={{ color: c.done ? "#22c55e" : "var(--text-secondary)" }}>
                <input type="checkbox" checked={c.done} disabled={c.auto}
                  onChange={() => { if (!c.auto) setChecklist(p => p.map(x => x.id === c.id ? { ...x, done: !x.done } : x)); }}
                  style={{ accentColor: "#22c55e" }} />
                <span style={{ textDecoration: c.done ? "line-through" : "none" }}>{c.label}</span>
                {c.auto && <span className="italic" style={{ color: "var(--text-muted)" }}>(auto)</span>}
              </label>
            ))}
          </div>

          <button onClick={() => goToStage("output")}
            className="px-6 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
            style={{ background: "#f97316", color: "#fff" }}>
            Continue to Bid Summary <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* STAGE 4: OUTPUT */}
      {/* ══════════════════════════════════════════════════ */}
      {stage === "output" && (
        <div className="max-w-7xl mx-auto px-6 pt-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* Bid summary */}
            <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #ef4444" }}>
              <h3 className="text-sm font-semibold mb-4" style={{ fontFamily: "'Playfair Display', serif", fontSize: 15 }}>Bid Summary</h3>
              <div className="p-3 rounded-lg mb-4" style={{ background: "var(--bg3)" }}>
                <div className="text-sm font-semibold">{estimateData?.projectName}</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                  {proposalEntry?.gcEstimateLead} • {proposalEntry?.region} • Due {proposalEntry?.dueDate}
                </div>
              </div>

              {CATEGORIES.filter(c => calcData[c.id]?.items > 0).map(c => (
                <div key={c.id} className="flex justify-between py-2 text-sm" style={{ borderBottom: "1px solid var(--border-ds)15" }}>
                  <span style={{ color: "var(--text-secondary)" }}>{c.label}</span>
                  <span className="font-semibold">{fmt(calcData[c.id].total)}</span>
                </div>
              ))}

              <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border-ds)" }}>
                {[
                  { l: "Material", v: calcData.allMat },
                  ...(calcData.allEsc > 0 ? [{ l: "Escalation", v: calcData.allEsc }] : []),
                  { l: "Freight", v: calcData.allFrt },
                  { l: `Overhead (${defaultOh}%)`, v: calcData.allOh },
                  { l: `Fee (${defaultFee}%)`, v: calcData.allFee },
                  { l: taxRate > 0 ? `Tax (${taxRate}% on material)` : "Tax (excluded)", v: calcData.allTax },
                  ...(bondRate > 0 ? [{ l: `Bond (${bondRate}%)`, v: calcData.allBond }] : []),
                ].map(r => (
                  <div key={r.l} className="flex justify-between py-1 text-xs" style={{ color: "var(--text-muted)" }}>
                    <span>{r.l}</span><span>{fmt(r.v)}</span>
                  </div>
                ))}
              </div>

              {/* Tax summary */}
              <div className="mt-4 p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                <div className="text-xs font-semibold mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>Tax Summary</div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: "Tax Rate", val: taxRate > 0 ? `${taxRate}%` : "0% (Excl)", color: taxRate > 0 ? "var(--gold)" : "var(--text-muted)" },
                    { label: "Tax Amount", val: fmt(calcData.allTax), color: taxRate > 0 ? "#22c55e" : "var(--text-muted)" },
                    { label: "Vendor Tax", val: `${quotes.filter(q => !q.taxIncluded).length} excl / ${quotes.filter(q => q.taxIncluded).length} incl`, color: quotes.filter(q => q.taxIncluded).length > 0 ? "#f97316" : "#22c55e" },
                  ].map(s => (
                    <div key={s.label} className="p-2 rounded text-center" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
                      <div className="text-xs mb-1 uppercase tracking-wide" style={{ color: "var(--text-muted)", fontSize: 9 }}>{s.label}</div>
                      <div className="text-sm font-bold" style={{ color: s.color }}>{s.val}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 p-4 rounded-lg flex justify-between items-center"
                style={{ background: "linear-gradient(135deg, #ef444415, #f9731610)" }}>
                <span className="text-sm font-bold">BID TOTAL</span>
                <span className="text-2xl font-black" style={{ color: "#22c55e" }}>{fmt(calcData.grandTotal)}</span>
              </div>

              {/* Breakout summary */}
              {breakoutGroups.length > 0 && (
                <div className="mt-4 p-3 rounded-lg" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                  <div className="text-xs font-semibold mb-2">Pricing Breakout Summary</div>
                  {breakoutGroups.map(g => {
                    const gd = breakoutCalcData[g.id];
                    if (!gd || gd.itemCount === 0) return null;
                    return (
                      <div key={g.id} className="flex justify-between py-1 text-xs" style={{ borderBottom: "1px solid var(--border-ds)" }}>
                        <span><strong>{g.code}</strong> — {g.label} ({gd.itemCount} items)</span>
                        <span className="font-semibold" style={{ color: "#22c55e" }}>{fmt(gd.total)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Proposal letter */}
            <div className="rounded-lg p-5" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #ef4444" }}>
              <div className="flex justify-between items-center mb-3">
                <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 15, fontWeight: 700 }}>Proposal Letter</h3>
                <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-muted)" }}>
                  <input type="checkbox" checked={showUnitPricing} onChange={() => setShowUnitPricing(!showUnitPricing)} style={{ accentColor: "var(--gold)" }} />
                  Show unit pricing
                </label>
              </div>
              <div id="proposal-print-area" className="p-5 rounded-lg overflow-y-auto" style={{ background: "#fff", color: "#1a1a1a", maxHeight: 500, fontFamily: "'Rajdhani', sans-serif", fontWeight: 500, fontSize: 10, lineHeight: 1.55 }}>
                {(() => {
                  const GOLD = "#C8A44E";
                  const INK = "#1a1a1a";
                  const INK_SOFT = "#4a4a4a";
                  const INK_FAINT = "#8a8a8a";
                  const RULE = "#d4d4d4";
                  const RULE_FAINT = "#ececec";
                  const sectionHeader = (num: string, title: string) => (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "20px 0 12px" }}>
                      <span style={{ fontFamily: "'Playfair Display', serif", fontStyle: "italic", fontSize: 20, fontWeight: 700, color: GOLD, lineHeight: 1 }}>{num}</span>
                      <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 11.5, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", flex: 1, color: INK }}>{title}</span>
                      <span style={{ height: 1, background: INK, flex: 1, maxWidth: 60, opacity: 0.15 }} />
                    </div>
                  );
                  const preparedBy = estimateData?.createdBy || "—";
                  const gcLead = proposalEntry?.gcEstimateLead || "—";
                  const metaRows = [
                    { label: "Date", value: new Date().toLocaleDateString() },
                    { label: "Proposal #", value: estimateData?.estimateNumber || "—" },
                    { label: "Project", value: estimateData?.projectName || "—" },
                    { label: "GC", value: gcLead },
                    { label: "Attn", value: gcLead },
                    { label: "Prepared By", value: preparedBy },
                  ];
                  return (
                    <>
                      {/* ============ HEADER (condensed banner row) ============ */}
                      <div style={{ position: "relative", paddingBottom: 8, marginBottom: 14, borderBottom: `3px solid ${GOLD}` }}>
                        <div style={{ display: "grid", gridTemplateColumns: "0.85fr 1.6fr 1fr", gap: 16, alignItems: "center" }}>
                          <div style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "flex-start" }}>
                            <img src={nbsLogoUrl} alt="National Building Specialties" style={{ maxHeight: 44, maxWidth: "100%", width: "auto", objectFit: "contain", display: "block" }} data-testid="img-nbs-logo-proposal" />
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", lineHeight: 1, color: INK }}>Proposal</div>
                            <div style={{ marginTop: 4, fontFamily: "'Rajdhani', sans-serif", fontSize: 9, letterSpacing: 3.5, color: GOLD, fontWeight: 600, textTransform: "uppercase", lineHeight: 1 }}>Furnish Only · Division 10</div>
                          </div>
                          <div style={{ textAlign: "right", fontFamily: "'Rajdhani', sans-serif", fontSize: 10, lineHeight: 1.35, color: INK_SOFT }}>
                            <div><strong style={{ color: INK, fontWeight: 600 }}>4130 Flat Rock Dr, Suite 110</strong> · Riverside, CA 92505</div>
                            <div>NationalBuildingSpecialties.com · <span style={{ color: INK_FAINT, letterSpacing: 0.5 }}>CA LIC #1101865</span></div>
                          </div>
                        </div>
                      </div>

                      {/* ============ META GRID (6 fields) ============ */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", marginBottom: 18, borderTop: `1px solid ${RULE}`, borderBottom: `1px solid ${RULE}` }}>
                        {metaRows.map((row, idx) => {
                          const isOdd = idx % 2 === 0;
                          const isLast = idx >= 4;
                          return (
                            <div key={row.label} style={{ display: "grid", gridTemplateColumns: "100px 1fr", padding: "6px 0", borderBottom: isLast ? "none" : `1px solid ${RULE_FAINT}`, fontSize: 9, paddingRight: isOdd ? 16 : 0, paddingLeft: isOdd ? 0 : 16, borderRight: isOdd ? `1px solid ${RULE_FAINT}` : "none" }}>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8.5, letterSpacing: 1.2, textTransform: "uppercase", color: INK_FAINT, fontWeight: 600, alignSelf: "center" }}>{row.label}</span>
                              <span style={{ color: INK, fontWeight: 600, fontSize: 9.5 }}>{row.value}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* ============ 01 SCOPE OF MATERIAL ============ */}
                      {sectionHeader("01", "Scope of Material")}
                      {CATEGORIES.filter(c => calcData[c.id]?.items > 0).map(c => {
                        const catItems = lineItems.filter(i => i.category === c.id);
                        const d = calcData[c.id];
                        return (
                          <div key={c.id} style={{ marginBottom: 16, pageBreakInside: "avoid" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0 6px", borderBottom: `1px solid ${INK}`, marginBottom: 6 }}>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 11, letterSpacing: 1.3, textTransform: "uppercase", color: INK }}>{c.label}</span>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8.5, fontWeight: 500, letterSpacing: 1.5, color: GOLD }}>{c.csi}</span>
                            </div>
                            {(() => {
                              const showPx = showUnitPricing;

                              // ─── NON-PRICING LAYOUT (unchanged from prior version) ───
                              if (!showPx) {
                                const gridCols = "70px minmax(0,1fr) 110px 50px";
                                return (
                                  <>
                                    <div style={{ display: "grid", gridTemplateColumns: gridCols, columnGap: 10, padding: "3px 12px 4px", fontFamily: "'Rajdhani', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: 1.1, textTransform: "uppercase", color: INK_FAINT, borderBottom: `0.5px solid ${RULE_FAINT}` }} data-testid="row-line-items-header">
                                      <span>Plan Callout</span>
                                      <span>Description</span>
                                      <span>Model Number</span>
                                      <span style={{ textAlign: "right" }}>Qty</span>
                                    </div>
                                    {catItems.map(item => (
                                      <div key={item.id}>
                                        <div style={{ display: "grid", gridTemplateColumns: gridCols, columnGap: 10, padding: "3px 12px", fontSize: 9.5, color: INK, alignItems: "baseline" }} data-testid={`row-line-item-${item.id}`}>
                                          <span style={{ wordBreak: "break-word" }}>{item.planCallout || ""}</span>
                                          <span style={{ wordBreak: "break-word", lineHeight: 1.35 }}>{item.name}</span>
                                          <span style={{ wordBreak: "break-word" }}>{item.model || ""}</span>
                                          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{item.qty || ""}</span>
                                        </div>
                                        {item.note && <div style={{ padding: "1px 12px 3px 82px", fontSize: 8.5, color: INK_FAINT, fontStyle: "italic" }}>▸ {item.note}</div>}
                                      </div>
                                    ))}
                                  </>
                                );
                              }

                              // ─── PRICING LAYOUT (fixed-width <table>, percent column widths) ───
                              const thStyle = { fontFamily: "'Rajdhani', sans-serif", fontSize: 8, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" as const, color: INK_FAINT, borderBottom: `1px solid ${RULE_FAINT}`, padding: "6px 8px", textAlign: "left" as const, verticalAlign: "bottom" as const };
                              const tdStyle = { fontSize: 9.5, color: INK, lineHeight: 1.35, padding: "6px 8px", borderBottom: `0.5px solid ${RULE_FAINT}`, verticalAlign: "top" as const };
                              const descCellStyle = { ...tdStyle, whiteSpace: "normal" as const, wordBreak: "normal" as const, overflowWrap: "normal" as const };
                              const numCellStyle = { ...tdStyle, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };
                              return (
                                <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "collapse" }} data-testid="table-proposal-line-items-pricing">
                                  <colgroup>
                                    <col style={{ width: "11%" }} />
                                    <col style={{ width: "36%" }} />
                                    <col style={{ width: "21%" }} />
                                    <col style={{ width: "8%" }} />
                                    <col style={{ width: "12%" }} />
                                    <col style={{ width: "12%" }} />
                                  </colgroup>
                                  <thead>
                                    <tr>
                                      <th style={thStyle}>Plan Callout</th>
                                      <th style={thStyle}>Description</th>
                                      <th style={thStyle}>Model Number</th>
                                      <th style={{ ...thStyle, textAlign: "right" }}>Qty</th>
                                      <th style={{ ...thStyle, textAlign: "right" }}>Unit Cost</th>
                                      <th style={{ ...thStyle, textAlign: "right" }}>Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {catItems.map(item => (
                                      <Fragment key={item.id}>
                                        <tr data-testid={`row-line-item-${item.id}`}>
                                          <td style={tdStyle}>{item.planCallout || ""}</td>
                                          <td style={descCellStyle}>{item.name}</td>
                                          <td style={tdStyle}>{item.model || ""}</td>
                                          <td style={numCellStyle}>{item.qty || ""}</td>
                                          <td style={numCellStyle}>{fmt(n(item.unitCost))}</td>
                                          <td style={{ ...numCellStyle, fontWeight: 500 }}>{fmt(n(item.unitCost) * item.qty)}</td>
                                        </tr>
                                        {item.note && (
                                          <tr>
                                            <td colSpan={6} style={{ padding: "0 8px 4px 8px", fontSize: 8.5, color: INK_FAINT, fontStyle: "italic", borderBottom: `0.5px solid ${RULE_FAINT}` }}>▸ {item.note}</td>
                                          </tr>
                                        )}
                                      </Fragment>
                                    ))}
                                  </tbody>
                                </table>
                              );
                            })()}
                            {showUnitPricing && (
                              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 10.5, paddingTop: 6, paddingLeft: 12, borderTop: `1px solid ${INK}`, marginTop: 4, fontFamily: "'Rajdhani', sans-serif", letterSpacing: 1, textTransform: "uppercase", color: INK }}>
                                <span>{c.label} Subtotal</span><span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(d.total)}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* ============ TOTAL BID ============ */}
                      <div style={{ marginTop: 24, padding: "18px 22px", background: INK, color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <div>
                          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, letterSpacing: 3, color: GOLD, fontWeight: 600, textTransform: "uppercase" }}>Total Bid</div>
                          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8, color: "rgba(255,255,255,0.55)", letterSpacing: 0.5, marginTop: 2 }}>Furnish Only — Material Only</div>
                        </div>
                        <div style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 24, color: GOLD, fontVariantNumeric: "tabular-nums" }}>{fmt(calcData.grandTotal)}</div>
                      </div>
                    </>
                  );
                })()}

                {/* ───────── PRICING BREAKOUTS (Option B — itemized cards) ───────── */}
                {breakoutGroups.length > 0 && (() => {
                  const GOLD = "#C8A44E";
                  const INK = "#1a1a1a";
                  const INK_FAINT = "#8a8a8a";
                  const RULE = "#d4d4d4";
                  const RULE_FAINT = "#ececec";
                  const sumOfBreakouts = breakoutGroups.reduce((s, g) => s + (breakoutCalcData[g.id]?.total || 0), 0);

                  return (
                    <div style={{ marginTop: 24, pageBreakInside: "avoid" }}>
                      {/* Section header (no number — reconciliation view, sits between 01 and 02) */}
                      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
                        <span style={{ fontFamily: "'Playfair Display', serif", fontStyle: "italic", fontSize: 18, color: GOLD, fontWeight: 700, lineHeight: 1 }}>·</span>
                        <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 11.5, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: INK }}>Pricing Breakouts</span>
                        <span style={{ flex: 1, height: 1, background: RULE }} />
                      </div>
                      <p style={{ fontSize: 8, fontStyle: "italic", color: INK_FAINT, margin: "0 0 14px", lineHeight: 1.55 }}>
                        Itemized pricing for each cost bucket below. The Total Bid above remains the binding price; breakouts shown for reference only.
                      </p>

                      {breakoutGroups.map(group => {
                        const gd = breakoutCalcData[group.id];
                        if (!gd || gd.itemCount === 0) return null;

                        // Build per-scope rows for this breakout from allocations
                        const itemsInThisBreakout = lineItems
                          .map(li => {
                            const allocQty = allocMap[li.id]?.[group.id] || 0;
                            if (allocQty <= 0) return null;
                            const unitCost = n(li.unitCost);
                            return { ...li, allocQty, unitCost, ext: allocQty * unitCost };
                          })
                          .filter(Boolean) as Array<LineItem & { allocQty: number; unitCost: number; ext: number }>;

                        // Group by category
                        const byCat: Record<string, typeof itemsInThisBreakout> = {};
                        itemsInThisBreakout.forEach(it => {
                          if (!byCat[it.category]) byCat[it.category] = [];
                          byCat[it.category].push(it);
                        });
                        const cats = ALL_SCOPES.filter(c => byCat[c.id]?.length);

                        return (
                          <div key={group.id} style={{ border: `1px solid ${RULE}`, borderRadius: 2, marginBottom: 14, pageBreakInside: "avoid", background: "#fff" }}>
                            {/* Card header */}
                            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "baseline", gap: 12, padding: "8px 12px", background: "linear-gradient(to right, rgba(200,164,78,0.08), rgba(200,164,78,0.02))", borderBottom: `1px solid ${GOLD}` }}>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 9, color: GOLD, letterSpacing: 1.5, textTransform: "uppercase" }}>{group.code}</span>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.4, color: INK }}>{group.label}</span>
                              <span style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 13, color: INK, fontVariantNumeric: "tabular-nums" }}>{fmt(gd.total)}</span>
                            </div>

                            {/* Per-scope sub-blocks */}
                            <div style={{ padding: "4px 0 6px" }}>
                              {cats.map(cat => {
                                const rows = byCat[cat.id];
                                const scopeTotal = rows.reduce((s, r) => s + r.ext, 0);
                                const showPx = showUnitPricing;
                                return (
                                  <div key={cat.id} style={{ padding: "6px 12px 0" }}>
                                    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "3px 0 2px", borderBottom: `0.5px solid ${RULE_FAINT}`, marginBottom: 3 }}>
                                      <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.7, color: INK }}>{cat.label}</span>
                                      <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, fontSize: 7.5, color: GOLD, letterSpacing: 0.4 }}>{cat.csi}</span>
                                    </div>
                                    <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                                      <colgroup>
                                        {showPx ? (
                                          <>
                                            <col style={{ width: "11%" }} /><col style={{ width: "16%" }} /><col style={{ width: "36%" }} /><col style={{ width: "6%" }} /><col style={{ width: "6%" }} /><col style={{ width: "12%" }} /><col style={{ width: "13%" }} />
                                          </>
                                        ) : (
                                          <>
                                            <col style={{ width: "13%" }} /><col style={{ width: "22%" }} /><col style={{ width: "55%" }} /><col style={{ width: "5%" }} /><col style={{ width: "5%" }} />
                                          </>
                                        )}
                                      </colgroup>
                                      <thead>
                                        <tr>
                                          <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "left" }}>Callout</th>
                                          <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "left" }}>Model</th>
                                          <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "left" }}>Description</th>
                                          <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "right" }}>Qty</th>
                                          <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "center" }}>UOM</th>
                                          {showPx && <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "right" }}>Unit $</th>}
                                          {showPx && <th style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 6.5, textTransform: "uppercase", letterSpacing: 0.6, color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px solid ${RULE_FAINT}`, textAlign: "right" }}>Extended</th>}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {rows.map(r => (
                                          <tr key={r.id}>
                                            <td style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 8, textAlign: "center", color: INK, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}`, letterSpacing: 0.5 }}>{r.planCallout || "—"}</td>
                                            <td style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, fontSize: 8, color: INK, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}` }}>{r.model || "—"}</td>
                                            <td style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8, color: INK, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}` }}>{r.name}</td>
                                            <td style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8, fontVariantNumeric: "tabular-nums", textAlign: "right", color: INK, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}` }}>{r.allocQty}</td>
                                            <td style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 7.5, textTransform: "uppercase", textAlign: "center", color: INK_FAINT, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}` }}>EA</td>
                                            {showPx && <td style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8, fontVariantNumeric: "tabular-nums", textAlign: "right", color: INK, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}`, whiteSpace: "nowrap" }}>{fmt(r.unitCost)}</td>}
                                            {showPx && <td style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8, fontWeight: 600, fontVariantNumeric: "tabular-nums", textAlign: "right", color: INK, padding: "3px 4px", borderBottom: `0.5px dashed ${RULE_FAINT}`, whiteSpace: "nowrap" }}>{fmt(r.ext)}</td>}
                                          </tr>
                                        ))}
                                        <tr>
                                          <td colSpan={showPx ? 6 : 4} style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, textTransform: "uppercase", fontSize: 7.5, letterSpacing: 0.7, color: INK, paddingTop: 4, paddingBottom: 6, borderTop: `0.5px solid ${INK}` }}>{cat.label} Subtotal</td>
                                          <td style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 8.5, textAlign: "right", paddingTop: 4, paddingBottom: 6, borderTop: `0.5px solid ${INK}`, color: INK, fontVariantNumeric: "tabular-nums" }}>{fmt(scopeTotal)}</td>
                                        </tr>
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Card footer */}
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 12px", background: "rgba(26,26,26,0.03)", borderTop: `0.5px solid ${INK}` }}>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 9, textTransform: "uppercase", letterSpacing: 1.2, color: INK }}>{group.code} — {group.label} Subtotal</span>
                              <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 11, color: INK, fontVariantNumeric: "tabular-nums" }}>{fmt(gd.total)}</span>
                            </div>
                          </div>
                        );
                      })}

                      {/* Reconciliation row */}
                      <div style={{ marginTop: 8, padding: "10px 12px", borderTop: `1.5px solid ${INK}`, borderBottom: `0.5px solid ${GOLD}`, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 9.5, textTransform: "uppercase", letterSpacing: 1.4, color: INK }}>Sum of Breakouts</span>
                        <span style={{ fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 13, color: INK, fontVariantNumeric: "tabular-nums" }}>{fmt(sumOfBreakouts)}</span>
                      </div>
                      <p style={{ marginTop: 4, fontSize: 7, fontStyle: "italic", color: INK_FAINT, textAlign: "right" }}>
                        {Math.abs(sumOfBreakouts - calcData.grandTotal) < 1
                          ? `Reconciles to Total Bid · ${fmt(calcData.grandTotal)}`
                          : `Note: Sum of breakouts (${fmt(sumOfBreakouts)}) does not reconcile to Total Bid (${fmt(calcData.grandTotal)}) — review allocations.`}
                      </p>
                    </div>
                  );
                })()}

                {(() => {
                  const GOLD = "#C8A44E";
                  const INK = "#1a1a1a";
                  const INK_SOFT = "#4a4a4a";
                  const INK_FAINT = "#8a8a8a";
                  const RULE_FAINT = "#ececec";
                  const sectionHeader = (num: string, title: string) => (
                    <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "20px 0 12px" }}>
                      <span style={{ fontFamily: "'Playfair Display', serif", fontStyle: "italic", fontSize: 20, fontWeight: 700, color: GOLD, lineHeight: 1 }}>{num}</span>
                      <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 11.5, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", flex: 1, color: INK }}>{title}</span>
                      <span style={{ height: 1, background: INK, flex: 1, maxWidth: 60, opacity: 0.15 }} />
                    </div>
                  );
                  const addendaList: string[] = (estimateData as any)?.addendaAcknowledged || [];
                  const hasAddenda = addendaList.length > 0;
                  const preparedBy = estimateData?.createdBy || "[Estimator name not set]";
                  const scopeQuals = ALL_SCOPES.filter(s => activeScopes.includes(s.id));
                  const inclusionScopes = scopeQuals.filter(c => catQuals[c.id]?.inclusions);
                  const exclusionScopes = scopeQuals.filter(c => catQuals[c.id]?.exclusions);
                  const qualScopes = scopeQuals.filter(c => catQuals[c.id]?.qualifications);
                  return (
                    <>
                      {/* ============ 02 QUALIFICATIONS ============ */}
                      {(qualScopes.length > 0 || assumptions.length > 0 || risks.length > 0) && (
                        <>
                          {sectionHeader("02", "Qualifications")}
                          {assumptions.length > 0 && (
                            <div style={{ marginBottom: 8, paddingLeft: 4 }}>
                              {assumptions.map((a, i) => <div key={i} style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• {a}</div>)}
                            </div>
                          )}
                          {qualScopes.map(c => (
                            <div key={c.id} style={{ marginBottom: 6, paddingLeft: 4 }}>
                              <div style={{ fontSize: 9.5, fontWeight: 600, color: INK, paddingLeft: 12 }}>{c.label}:</div>
                              <div style={{ fontSize: 9, paddingLeft: 24, color: INK_SOFT, fontStyle: "italic" }}>▸ {catQuals[c.id].qualifications}</div>
                            </div>
                          ))}
                          {risks.length > 0 && (
                            <div style={{ marginTop: 8, paddingLeft: 4 }}>
                              <div style={{ fontSize: 9, fontWeight: 700, color: GOLD, paddingLeft: 12, letterSpacing: 1, textTransform: "uppercase" }}>Notes &amp; Risks</div>
                              {risks.map((r, i) => <div key={i} style={{ fontSize: 9, margin: "2px 0", paddingLeft: 24, color: INK_SOFT, fontStyle: "italic" }}>⚠ {r}</div>)}
                            </div>
                          )}
                        </>
                      )}

                      {/* ============ 03 INCLUSIONS ============ */}
                      {sectionHeader("03", "Inclusions")}
                      <div style={{ paddingLeft: 4 }}>
                        {hasAddenda && (
                          <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK, fontWeight: 600 }}>
                            • Addenda acknowledged: {addendaList.join(", ")}
                          </div>
                        )}
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Furnish all Division 10 materials per plans and specifications</div>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• {taxRate > 0 ? `Sales tax included (${taxRate}%)` : "Sales tax NOT included"}</div>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Freight to jobsite included</div>
                        {inclusionScopes.map(c => (
                          <div key={c.id} style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>
                            • <strong style={{ fontWeight: 600 }}>{c.label}:</strong> {catQuals[c.id].inclusions}
                          </div>
                        ))}
                      </div>

                      {/* ============ 04 EXCLUSIONS ============ */}
                      {sectionHeader("04", "Exclusions")}
                      <div style={{ paddingLeft: 4 }}>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Installation labor by others</div>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Blocking, backing, and rough-in by others</div>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Offloading, distribution, and handling by others</div>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Items not specifically listed above</div>
                        <div style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>• Any work beyond furnishing of materials</div>
                        {exclusionScopes.map(c => (
                          <div key={c.id} style={{ fontSize: 9.5, margin: "2px 0", paddingLeft: 12, color: INK }}>
                            • <strong style={{ fontWeight: 600 }}>{c.label}:</strong> {catQuals[c.id].exclusions}
                          </div>
                        ))}
                      </div>

                      {/* ============ VALIDITY ============ */}
                      <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${RULE_FAINT}` }}>
                        <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 8, letterSpacing: 1.5, textTransform: "uppercase", color: INK_FAINT, fontWeight: 600 }}>Validity</div>
                        <div style={{ fontSize: 9.5, color: INK, marginTop: 2 }}>This proposal is valid for 30 days from the date above.</div>
                      </div>

                      {/* ============ SIGNATURE BLOCK (placeholder — estimator profile in next stage) ============ */}
                      <div style={{ marginTop: 28 }}>
                        <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, color: INK }}>Best Regards,</div>
                        <div style={{ fontFamily: "'Playfair Display', serif", fontStyle: "italic", fontSize: 22, color: INK, marginTop: 6, lineHeight: 1.1 }}>{preparedBy}</div>
                        <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, color: INK, marginTop: 6 }}>{preparedBy}</div>
                        <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, textTransform: "uppercase", letterSpacing: 1.2, color: INK_FAINT, marginTop: 1 }}>National Building Specialties · Furnish Only</div>
                        <div style={{ marginTop: 14, padding: "16px 20px", border: `1px dashed ${GOLD}`, background: "rgba(200,164,78,0.06)", textAlign: "center", fontFamily: "'Rajdhani', sans-serif", fontSize: 8.5, letterSpacing: 2, color: INK_FAINT, textTransform: "uppercase", fontWeight: 600, maxWidth: 320 }}>
                          [ NO SIGNATURE ON FILE ]
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* How to use — export actions */}
              <details className="mt-3 mb-2 rounded-md" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold flex items-center gap-1.5 select-none" style={{ color: "var(--text)" }}>
                  <Info className="w-3 h-3" style={{ color: "var(--text-muted)" }} /> What These Export Buttons Do
                </summary>
                <div className="px-3 pb-3 text-xs leading-relaxed" style={{ color: "var(--text-secondary)" }}>
                  The proposal preview above is locked to your current line items, markups, assumptions, and risks. Pick how you want to deliver it:
                  <ul className="list-disc ml-4 mt-1 space-y-0.5">
                    <li><strong>Copy Text</strong> — copies the formatted proposal body to your clipboard so you can paste it into an email.</li>
                    <li><strong>Print / PDF</strong> — opens the browser print dialog. Choose <em>Save as PDF</em> to produce the deliverable PDF for the GC.</li>
                    <li><strong>Export Excel</strong> — generates the full estimate workbook (line items, quotes, breakouts, version history) for internal records.</li>
                  </ul>
                  <div className="mt-1" style={{ color: "var(--text-muted)" }}>None of these change the estimate's review status. To officially submit, use the Review Workflow below to advance to <em>Submitted</em>.</div>
                </div>
              </details>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => { navigator.clipboard.writeText(proposalText); toast({ title: "Copied", description: "Proposal text copied to clipboard." }); }}
                  className="text-xs px-3 py-2 rounded flex items-center gap-1"
                  style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                  <Copy className="w-3 h-3" /> Copy Text
                </button>
                <button onClick={handlePrint}
                  className="text-xs px-3 py-2 rounded flex items-center gap-1"
                  style={{ background: "#ef444415", border: "1px solid #ef444440", color: "#ef4444" }}>
                  <FileText className="w-3 h-3" /> Print / PDF
                </button>
                <button
                  data-testid="btn-export-excel"
                  onClick={() => exportEstimateToExcel({
                    estimateData: estimateData,
                    proposalEntry,
                    lineItems,
                    quotes,
                    breakoutGroups,
                    allocations,
                    versions,
                    savedSpecSections,
                    assumptions,
                    risks,
                    calcData,
                    breakoutCalcData,
                    defaultOh,
                    defaultFee,
                    defaultEsc,
                    taxRate,
                    bondRate,
                    catOverrides,
                    activeScopes: CATEGORIES,
                  })}
                  className="text-xs px-3 py-2 rounded flex items-center gap-1"
                  style={{ background: "#22c55e15", border: "1px solid #22c55e40", color: "#22c55e" }}>
                  <FileSpreadsheet className="w-3 h-3" /> Export Excel
                </button>
              </div>
            </div>
          </div>

          {/* Review workflow */}
          <div className="rounded-lg p-5 mb-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderLeft: "3px solid #ef4444" }}>
            <h3 className="text-sm font-semibold mb-3">Review Workflow</h3>
            <div className="flex gap-2 mb-4 flex-wrap items-center">
              {["drafting", "ready_for_review", "reviewed", "submitted"].map((s, i) => {
                const colors: Record<string, string> = { drafting: "var(--gold)", ready_for_review: "#f97316", reviewed: "#22c55e", submitted: "#06b6d4" };
                const labels: Record<string, string> = { drafting: "Drafting", ready_for_review: "Ready for Review", reviewed: "Approved", submitted: "Submitted" };
                const active = s === reviewStatus;
                return (
                  <div key={s} className="flex items-center gap-1">
                    <button onClick={() => changeReviewStatus(s)}
                      className="text-xs px-3 py-1.5 rounded font-semibold transition-all"
                      style={{ background: active ? colors[s] + "20" : "transparent", color: active ? colors[s] : "var(--text-muted)", border: `1px solid ${active ? colors[s] + "50" : "var(--border-ds)"}` }}>
                      {labels[s]}
                    </button>
                    {i < 3 && <ChevronRight className="w-3 h-3" style={{ color: "var(--text-muted)" }} />}
                  </div>
                );
              })}
              {isDirty && (
                <span className="text-xs ml-1" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                  — not saved yet
                </span>
              )}
            </div>

            {/* Comments */}
            <div className="space-y-2 mb-3">
              {reviewComments.map(c => (
                <div key={c.id} className="p-2 rounded text-xs" style={{ background: c.resolved ? "#22c55e10" : "var(--bg3)", border: `1px solid ${c.resolved ? "#22c55e30" : "var(--border-ds)"}` }}>
                  <div className="flex justify-between items-center mb-0.5">
                    <span className="font-semibold">{c.author}</span>
                    <div className="flex items-center gap-2">
                      <span style={{ color: "var(--text-muted)" }}>{new Date(c.createdAt).toLocaleString()}</span>
                      {!c.resolved && (
                        <button
                          onClick={async () => {
                            try {
                              const res = await apiRequest("PATCH", `/api/estimates/comments/${c.id}`, { resolved: true });
                              const updated = await res.json();
                              setReviewComments(prev => prev.map(x => x.id === c.id ? updated : x));
                            } catch {
                              toast({ title: "Error", description: "Could not resolve comment.", variant: "destructive" });
                            }
                          }}
                          className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded"
                          style={{ background: "#22c55e15", color: "#22c55e", border: "1px solid #22c55e30" }}
                          title="Mark as resolved">
                          <CheckCircle2 className="w-3 h-3" /> Resolve
                        </button>
                      )}
                    </div>
                  </div>
                  <span style={{ color: c.resolved ? "#22c55e" : "var(--text-secondary)", textDecoration: c.resolved ? "line-through" : "none" }}>{c.comment}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newComment} onChange={e => setNewComment(e.target.value)}
                placeholder="Add review comment..."
                onKeyDown={e => e.key === "Enter" && addComment()}
                className="flex-1 text-xs px-2 py-1.5 rounded"
                style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
              <button onClick={addComment} className="text-xs px-3 py-1.5 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>Add</button>
            </div>
          </div>

          {/* Output checklist */}
          <div className="rounded-lg p-4 mb-4" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
            <div className="text-xs font-semibold mb-2">Output Checklist</div>
            {effectiveChecklist.filter(c => c.stage === "output").map(c => (
              <label key={c.id} className="flex items-center gap-2 py-1 cursor-pointer text-xs"
                style={{ color: c.done ? "#22c55e" : "var(--text-secondary)" }}>
                <input type="checkbox" checked={c.done} disabled={c.auto}
                  onChange={() => { if (!c.auto) setChecklist(p => p.map(x => x.id === c.id ? { ...x, done: !x.done } : x)); }}
                  style={{ accentColor: "#22c55e" }} />
                <span style={{ textDecoration: c.done ? "line-through" : "none" }}>{c.label}</span>
              </label>
            ))}
          </div>

          {/* Final action */}
          <div className="mb-3 p-3 rounded-md text-xs leading-relaxed" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
            <div className="font-semibold mb-1 flex items-center gap-1.5" style={{ color: "var(--text)" }}>
              <Info className="w-3 h-3" style={{ color: "var(--text-muted)" }} /> What These Buttons Do
            </div>
            <ul className="list-disc ml-4 space-y-0.5">
              <li><strong style={{ color: "var(--gold)" }}>Save &amp; Sync to Proposal Log Dashboard</strong> — saves all estimate edits and pushes the bid total, scopes, status, and notes to the matching row on the Proposal Log Dashboard. Use this often; it keeps the dashboard in sync without changing the review status.</li>
              <li><strong style={{ color: "#06b6d4" }}>Mark as Submitted</strong> — saves and flips the review status to <em>Submitted</em>, locks in the version-history snapshot, and updates the dashboard row to <em>Submitted</em>. Use this once the proposal has actually been delivered to the GC.</li>
            </ul>
          </div>
          <div className="flex gap-3 flex-wrap">
            <button onClick={() => !isViewer && saveEstimate()} disabled={isSaving || !estimateId || isViewer}
              className="px-6 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
              style={{ background: "var(--gold)", color: "#000" }}
              title="Save edits and push the bid total, scopes, status and notes to the matching Proposal Log Dashboard row.">
              💾 Save & Sync to Proposal Log Dashboard
            </button>
            <button onClick={() => { if (!isViewer) { markDirty(); saveEstimate("submitted"); } }}
              disabled={isSaving || !estimateId || isViewer}
              className="px-6 py-3 rounded-lg text-sm font-semibold flex items-center gap-2"
              style={{ background: "#06b6d4", color: "#fff" }}
              title="Save, flip review status to Submitted, snapshot the version, and update the Proposal Log Dashboard row to Submitted.">
              <Send className="w-4 h-4" /> Mark as Submitted
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* SCHEDULE EXTRACTOR OVERLAY PANEL */}
      {/* ══════════════════════════════════════════════════ */}
      {showScheduleExtractor && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl flex flex-col" style={{ background: "var(--bg-card)", border: "1px solid #06b6d440" }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 sticky top-0" style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", zIndex: 10 }}>
              <div className="flex items-center gap-2">
                <ClipboardList className="w-5 h-5" style={{ color: "#06b6d4" }} />
                <h2 className="text-base font-bold" style={{ color: "#06b6d4" }}>Extract from Schedules</h2>
                {extractedItems.length > 0 && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#06b6d420", color: "#06b6d4" }}>{extractedItems.length} items extracted</span>}
              </div>
              <button onClick={() => { setShowScheduleExtractor(false); setScheduleClipboardImages([]); setScheduleImagePasteCount(0); }} className="text-xl leading-none" style={{ color: "var(--text-muted)" }}>×</button>
            </div>

            <div className="p-5 flex-1">
              {/* How to use — only shown before extraction starts */}
              {extractedItems.length === 0 && (
                <div className="mb-4 p-3 rounded-md text-xs leading-relaxed" style={{ background: "#06b6d40d", border: "1px solid #06b6d430", color: "var(--text-secondary)" }}>
                  <div className="font-semibold mb-1" style={{ color: "#06b6d4" }}>How to use</div>
                  Best for <strong>door, window, hardware, signage, accessory, and louver schedules</strong> coming off the plans.
                  <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                    <li>Pick a tab — paste a screenshot of the schedule (recommended) or paste the raw text. Multi-page schedules: paste each page; they're combined.</li>
                    <li>Hit <em>Extract Line Items</em>. AI returns a preview table — you can edit Mark, Description, Qty, and Type before importing.</li>
                    <li>Confirm to push the items into the active scope's line items table. Existing items aren't touched; the new ones are appended.</li>
                  </ol>
                  <div className="mt-1" style={{ color: "var(--text-muted)" }}>Tip: clearer screenshots = better extraction. Crop tightly around the schedule grid and skip title blocks.</div>
                </div>
              )}
              {/* Tabs */}
              {extractedItems.length === 0 && (
                <>
                  <div className="flex gap-1 mb-4 p-1 rounded-lg" style={{ background: "var(--bg3)" }}>
                    {[{ id: "image", label: "📷 Upload Images" }, { id: "text", label: "📋 Paste Text" }].map(t => (
                      <button key={t.id} onClick={() => setExtractorTab(t.id as any)}
                        className="flex-1 text-xs px-3 py-2 rounded font-semibold transition-all"
                        style={{ background: extractorTab === t.id ? "#06b6d4" : "transparent", color: extractorTab === t.id ? "#fff" : "var(--text-muted)" }}>
                        {t.label}
                      </button>
                    ))}
                  </div>

                  {extractorTab === "image" && (
                    <div>
                      {/* Hidden file input — adds to queue instead of extracting immediately */}
                      <input ref={scheduleImageInputRef} type="file" multiple accept="image/*" className="hidden"
                        onChange={e => {
                          const files = Array.from(e.target.files || []);
                          if (files.length > 0) {
                            setScheduleClipboardImages(prev => [...prev, ...files]);
                            setScheduleImagePasteCount(c => c + files.length);
                          }
                          e.target.value = "";
                        }} />

                      {/* Primary CTA — clipboard paste */}
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          onClick={async () => {
                            try {
                              const clipItems = await navigator.clipboard.read();
                              let found = false;
                              for (const clipItem of clipItems) {
                                for (const type of clipItem.types) {
                                  if (type.startsWith("image/")) {
                                    const blob = await clipItem.getType(type);
                                    const ext = type.split("/")[1] || "png";
                                    const file = new File([blob], `schedule-paste-${Date.now()}.${ext}`, { type });
                                    setScheduleClipboardImages(prev => [...prev, file]);
                                    setScheduleImagePasteCount(c => c + 1);
                                    found = true;
                                  }
                                }
                              }
                              if (!found) toast({ title: "No image in clipboard", description: "Take a screenshot first, then paste here.", variant: "destructive" });
                            } catch {
                              toast({ title: "Paste blocked", description: "Allow clipboard access or use the file upload below.", variant: "destructive" });
                            }
                          }}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold flex-shrink-0"
                          style={{ background: "#06b6d4", color: "#fff" }}
                          data-testid="btn-clipboard-paste-schedule-image"
                        >
                          <ClipboardPaste className="w-4 h-4" /> Paste from Clipboard
                        </button>
                        {scheduleImagePasteCount > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#06b6d420", color: "#06b6d4" }}>
                            {scheduleImagePasteCount} image{scheduleImagePasteCount !== 1 ? "s" : ""} accumulated
                          </span>
                        )}
                        {scheduleClipboardImages.length > 0 && (
                          <button
                            onClick={() => { setScheduleClipboardImages([]); setScheduleImagePasteCount(0); }}
                            className="text-xs px-2 py-1 rounded ml-auto"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Clear All
                          </button>
                        )}
                      </div>

                      <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
                        Each paste appends to the batch. Paste multiple schedule pages before extracting.
                      </p>

                      {/* Queue preview */}
                      {scheduleClipboardImages.length > 0 && (
                        <div className="mb-3 rounded-lg p-3 space-y-1" style={{ background: "var(--bg3)", border: "1px solid #06b6d430" }}>
                          {scheduleClipboardImages.map((f, i) => (
                            <div key={`${f.name}-${i}`} className="flex items-center justify-between text-xs" style={{ color: "var(--text-secondary)" }}>
                              <span>📷 {f.name}</span>
                              <button
                                onClick={() => {
                                  setScheduleClipboardImages(prev => prev.filter((_, j) => j !== i));
                                  setScheduleImagePasteCount(c => Math.max(0, c - 1));
                                }}
                                className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>×</button>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Secondary — file upload dropzone */}
                      <div
                        onClick={() => scheduleImageInputRef.current?.click()}
                        className="border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all mb-3"
                        style={{ borderColor: "#06b6d430", background: "#06b6d405" }}
                      >
                        <Upload className="w-6 h-6 mx-auto mb-1" style={{ color: "#06b6d480" }} />
                        <p className="text-xs" style={{ color: "var(--text-muted)" }}>Or click to upload image files — PNG, JPG, up to 20 at once</p>
                      </div>

                      {/* Extract button — only visible once images are queued */}
                      {scheduleClipboardImages.length > 0 && (
                        <button
                          onClick={() => runScheduleExtractImages(scheduleClipboardImages)}
                          disabled={extracting}
                          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold"
                          style={{ background: "#06b6d4", color: "#fff", opacity: extracting ? 0.6 : 1 }}
                          data-testid="btn-extract-schedule-images"
                        >
                          {extracting
                            ? <><Loader2 className="w-4 h-4 animate-spin" /> Extracting…</>
                            : `Extract Line Items (${scheduleClipboardImages.length} image${scheduleClipboardImages.length !== 1 ? "s" : ""} combined)`}
                        </button>
                      )}

                      {extracting && scheduleClipboardImages.length === 0 && (
                        <div className="flex items-center justify-center gap-2 mt-4" style={{ color: "#06b6d4" }}>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm">Extracting line items with AI…</span>
                        </div>
                      )}
                    </div>
                  )}

                  {extractorTab === "text" && (
                    <div>
                      {/* Click-to-paste button with accumulation */}
                      <div className="flex items-center gap-2 mb-3">
                        <button
                          onClick={async () => {
                            try {
                              const text = await navigator.clipboard.readText();
                              if (!text.trim()) return;
                              setExtractPasteText(prev =>
                                prev.trim()
                                  ? prev + "\n\n--- Paste #" + (schedulePasteCount + 2) + " ---\n" + text
                                  : text
                              );
                              setSchedulePasteCount(c => c + 1);
                            } catch {
                              toast({ title: "Paste blocked", description: "Click inside the text area and use Ctrl+V / Cmd+V instead.", variant: "destructive" });
                            }
                          }}
                          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold flex-shrink-0"
                          style={{ background: "#06b6d4", color: "#fff" }}
                          data-testid="btn-clipboard-paste-schedule"
                        >
                          <ClipboardPaste className="w-4 h-4" /> Click to Paste from Clipboard
                        </button>
                        {schedulePasteCount > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#06b6d420", color: "#06b6d4" }}>
                            {schedulePasteCount} paste{schedulePasteCount !== 1 ? "s" : ""} accumulated
                          </span>
                        )}
                        {extractPasteText.trim() && (
                          <button
                            onClick={() => { setExtractPasteText(""); setSchedulePasteCount(0); }}
                            className="text-xs px-2 py-1 rounded ml-auto"
                            style={{ color: "var(--text-muted)" }}
                          >
                            Clear All
                          </button>
                        )}
                      </div>
                      <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
                        Each paste appends to the list. You can also type or edit directly below.
                      </p>
                      <textarea
                        value={extractPasteText} onChange={e => setExtractPasteText(e.target.value)}
                        rows={8} placeholder="Paste schedule text here, or use the button above. Paste multiple times to combine pages into one list…"
                        className="w-full text-xs px-3 py-2.5 rounded-lg resize-none outline-none"
                        style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                      />
                      <button
                        onClick={() => runScheduleExtractText(extractPasteText)}
                        disabled={!extractPasteText.trim() || extracting}
                        className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold"
                        style={{ background: "#06b6d4", color: "#fff", opacity: (!extractPasteText.trim() || extracting) ? 0.5 : 1 }}
                      >
                        {extracting ? <><Loader2 className="w-4 h-4 animate-spin" /> Extracting…</> : `Extract Line Items${schedulePasteCount > 1 ? ` (${schedulePasteCount} pages combined)` : ""}`}
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Review table */}
              {extractedItems.length > 0 && (
                <div>
                  {/* Summary + bulk actions */}
                  <div className="flex flex-wrap gap-3 items-center mb-3 pb-3" style={{ borderBottom: "1px solid var(--border-ds)" }}>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {extractedItems.filter(i => i._selected).length} of {extractedItems.length} selected •{" "}
                      {extractedItems.filter(i => i._selected && i._assignedScope).length} assigned •{" "}
                      <span style={{ color: extractedItems.filter(i => i._selected && !i._assignedScope).length > 0 ? "#ef4444" : "var(--text-muted)" }}>
                        {extractedItems.filter(i => i._selected && !i._assignedScope).length} unassigned
                      </span>
                    </span>
                    <button onClick={() => setExtractedItems(prev => prev.map(i => ({ ...i, _selected: true })))} className="text-xs px-2 py-1 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Select All</button>
                    <button onClick={() => setExtractedItems(prev => prev.map(i => ({ ...i, _selected: false })))} className="text-xs px-2 py-1 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Deselect All</button>
                    <button onClick={() => { setExtractedItems([]); setScheduleClipboardImages([]); setScheduleImagePasteCount(0); setExtractPasteText(""); setSchedulePasteCount(0); }} className="text-xs px-2 py-1 rounded ml-auto" style={{ color: "var(--text-muted)" }}>← Start Over</button>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ borderBottom: "1px solid var(--border-ds)", color: "var(--text-muted)" }}>
                          <th className="py-2 pr-2 text-left w-8">✓</th>
                          <th className="py-2 pr-3 text-left">Callout</th>
                          <th className="py-2 pr-3 text-left">Description</th>
                          <th className="py-2 pr-3 text-left">Mfr</th>
                          <th className="py-2 pr-3 text-left">Model</th>
                          <th className="py-2 pr-3 text-right">Qty</th>
                          <th className="py-2 pr-3 text-center">Conf</th>
                          <th className="py-2 text-left">Scope</th>
                        </tr>
                      </thead>
                      <tbody>
                        {extractedItems.map((item, idx) => (
                          <tr key={item._id} style={{ borderBottom: "1px solid var(--border-ds)20", opacity: item._selected ? 1 : 0.4 }}>
                            <td className="py-2 pr-2">
                              <input type="checkbox" checked={item._selected}
                                onChange={() => setExtractedItems(prev => prev.map((i, j) => j === idx ? { ...i, _selected: !i._selected } : i))} />
                            </td>
                            <td className="py-2 pr-3" style={{ color: "var(--text-muted)" }}>{item.planCallout || "—"}</td>
                            <td className="py-2 pr-3 max-w-xs">
                              <input value={item.description} onChange={e => setExtractedItems(prev => prev.map((i, j) => j === idx ? { ...i, description: e.target.value } : i))}
                                className="w-full bg-transparent outline-none" style={{ color: "var(--text)" }} />
                            </td>
                            <td className="py-2 pr-3">
                              <input value={item.manufacturer} onChange={e => setExtractedItems(prev => prev.map((i, j) => j === idx ? { ...i, manufacturer: e.target.value } : i))}
                                className="w-full bg-transparent outline-none" style={{ color: "var(--text-secondary)" }} />
                            </td>
                            <td className="py-2 pr-3">
                              <input value={item.modelNumber} onChange={e => setExtractedItems(prev => prev.map((i, j) => j === idx ? { ...i, modelNumber: e.target.value } : i))}
                                className="w-full bg-transparent outline-none" style={{ color: "var(--text-secondary)" }} />
                            </td>
                            <td className="py-2 pr-3 text-right">
                              <input type="number" value={item.quantity} onChange={e => setExtractedItems(prev => prev.map((i, j) => j === idx ? { ...i, quantity: parseInt(e.target.value) || 0 } : i))}
                                className="w-12 bg-transparent outline-none text-right" style={{ color: "var(--text)" }}  onFocus={selectIfZero}/>
                            </td>
                            <td className="py-2 pr-3 text-center">
                              <span className="px-1.5 py-0.5 rounded" style={{
                                background: item.confidence >= 80 ? "#22c55e15" : item.confidence >= 60 ? "#f9731615" : "#ef444415",
                                color: item.confidence >= 80 ? "#22c55e" : item.confidence >= 60 ? "#f97316" : "#ef4444",
                              }}>{item.confidence}%</span>
                            </td>
                            <td className="py-2">
                              <select value={item._assignedScope || ""}
                                onChange={e => setExtractedItems(prev => prev.map((i, j) => j === idx ? { ...i, _assignedScope: e.target.value || null } : i))}
                                className="text-xs px-2 py-1 rounded"
                                style={{
                                  background: item._assignedScope ? "#22c55e15" : "#ef444415",
                                  border: `1px solid ${item._assignedScope ? "#22c55e40" : "#ef444440"}`,
                                  color: item._assignedScope ? "#22c55e" : "#ef4444",
                                }}>
                                <option value="">🔴 Unassigned</option>
                                {ALL_SCOPES.map(s => (
                                  <option key={s.id} value={s.id}>{s.label}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            {extractedItems.length > 0 && (
              <div className="px-5 py-4 sticky bottom-0 flex items-center justify-between gap-3 flex-wrap" style={{ background: "var(--bg-card)", borderTop: "1px solid var(--border-ds)" }}>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {extractedItems.filter(i => i._selected && !i._assignedScope).length > 0
                    ? `⚠ ${extractedItems.filter(i => i._selected && !i._assignedScope).length} items need a scope before import`
                    : `Ready to import ${extractedItems.filter(i => i._selected).length} items`}
                </span>
                <div className="flex gap-2">
                  <button onClick={() => { setShowScheduleExtractor(false); setScheduleClipboardImages([]); setScheduleImagePasteCount(0); }} className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-muted)" }}>Cancel</button>
                  <button
                    onClick={importExtractedItems}
                    disabled={importingItems || extractedItems.filter(i => i._selected).length === 0}
                    className="text-xs px-4 py-2 rounded font-semibold flex items-center gap-1.5"
                    style={{ background: "#06b6d4", color: "#fff", opacity: importingItems ? 0.7 : 1 }}>
                    {importingItems ? <><Loader2 className="w-3 h-3 animate-spin" /> Importing…</> : `Send ${extractedItems.filter(i => i._selected).length} Line Items to Estimate`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* SPEC EXTRACTOR OVERLAY PANEL */}
      {/* ══════════════════════════════════════════════════ */}
      {showSpecExtractor && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl flex flex-col" style={{ background: "var(--bg-card)", border: "1px solid var(--gold)40" }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 sticky top-0" style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", zIndex: 10 }}>
              <div className="flex items-center gap-2">
                <BookOpen className="w-5 h-5" style={{ color: "var(--gold)" }} />
                <h2 className="text-base font-bold" style={{ color: "var(--gold)" }}>Extract from Specs</h2>
                {extractedSpecs.length > 0 && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "var(--gold)20", color: "var(--gold)" }}>{extractedSpecs.length} sections extracted</span>}
              </div>
              <button onClick={() => setShowSpecExtractor(false)} className="text-xl leading-none" style={{ color: "var(--text-muted)" }}>×</button>
            </div>

            <div className="p-5 flex-1">
              {/* How to use — only shown before extraction starts */}
              {extractedSpecs.length === 0 && (
                <div className="mb-4 p-3 rounded-md text-xs leading-relaxed" style={{ background: "var(--gold)0d", border: "1px solid var(--gold)40", color: "var(--text-secondary)" }}>
                  <div className="font-semibold mb-1" style={{ color: "var(--gold)" }}>How to use</div>
                  Pulls products and quantities out of <strong>Division 10 spec sections</strong> (toilet accessories, partitions, lockers, signage, fire extinguishers, etc.).
                  <ol className="list-decimal ml-4 mt-1 space-y-0.5">
                    <li>Choose a tab — upload the spec PDF, paste a screenshot of a product schedule, or paste raw section text.</li>
                    <li>AI parses Part 2 / Part 3 of the spec and returns a list of products with model numbers, basis-of-design manufacturer, and quantities where stated.</li>
                    <li>Review the preview, then confirm to import. Items land in the active scope's line items table; Approved Manufacturers are auto-suggested from the basis of design.</li>
                  </ol>
                  <div className="mt-1" style={{ color: "var(--text-muted)" }}>Tip: a clean PDF of just the relevant section gives the best results — spec books with hundreds of pages may take longer.</div>
                </div>
              )}
              {/* Tabs */}
              {extractedSpecs.length === 0 && (
                <>
                  <div className="flex gap-1 mb-4 p-1 rounded-lg" style={{ background: "var(--bg3)" }}>
                    {[{ id: "pdf", label: "📄 Upload PDF" }, { id: "image", label: "📷 Spec Screenshots" }, { id: "text", label: "📋 Paste Text" }].map(t => (
                      <button key={t.id} onClick={() => setSpecExtractorTab(t.id as any)}
                        className="flex-1 text-xs px-3 py-2 rounded font-semibold transition-all"
                        style={{ background: specExtractorTab === t.id ? "var(--gold)" : "transparent", color: specExtractorTab === t.id ? "#000" : "var(--text-muted)" }}>
                        {t.label}
                      </button>
                    ))}
                  </div>

                  {specExtractorTab === "pdf" && (
                    <div>
                      <input ref={specPdfInputRef} type="file" accept=".pdf,application/pdf" className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0];
                          if (f) { setSpecPdfFile(f); }
                          e.target.value = "";
                        }} />
                      {!specPdfFile ? (
                        <div
                          onClick={() => specPdfInputRef.current?.click()}
                          onDragOver={e => { e.preventDefault(); setSpecPdfDropActive(true); }}
                          onDragLeave={e => { e.preventDefault(); setSpecPdfDropActive(false); }}
                          onDrop={e => {
                            e.preventDefault();
                            setSpecPdfDropActive(false);
                            const f = Array.from(e.dataTransfer.files).find(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
                            if (f) setSpecPdfFile(f);
                            else toast({ title: "Not a PDF", description: "Please drop a PDF file.", variant: "destructive" });
                          }}
                          className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all"
                          style={{
                            borderColor: specPdfDropActive ? "var(--gold)" : "var(--gold)40",
                            background: specPdfDropActive ? "rgba(200,164,78,0.12)" : "rgba(200,164,78,0.05)",
                            transform: specPdfDropActive ? "scale(1.01)" : "scale(1)",
                          }}
                        >
                          <FileText className="w-10 h-10 mx-auto mb-3" style={{ color: specPdfDropActive ? "var(--gold)" : "var(--gold)99" }} />
                          <p className="text-sm font-semibold" style={{ color: "var(--gold)" }}>
                            {specPdfDropActive ? "Drop your spec PDF here" : "Drag & drop spec PDF, or click to browse"}
                          </p>
                          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                            {specPdfDropActive ? "Release to load" : `PDF spec books up to ${MAX_UPLOAD_LABEL}`}
                          </p>
                        </div>
                      ) : (
                        <div className="rounded-xl p-5" style={{ background: "rgba(200,164,78,0.08)", border: "1px solid rgba(200,164,78,0.3)" }}>
                          <div className="flex items-start gap-3">
                            <FileText className="w-8 h-8 flex-shrink-0 mt-0.5" style={{ color: "var(--gold)" }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>{specPdfFile.name}</p>
                              <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                                {(specPdfFile.size / 1024 / 1024).toFixed(1)} MB — ready to extract
                              </p>
                            </div>
                            <button onClick={() => setSpecPdfFile(null)} className="text-lg leading-none px-1" style={{ color: "var(--text-muted)" }}>×</button>
                          </div>
                          <button
                            onClick={() => runSpecExtractPdf(specPdfFile)}
                            disabled={extracting}
                            className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold"
                            style={{ background: "var(--gold)", color: "#000", opacity: extracting ? 0.6 : 1 }}
                          >
                            {extracting ? <><Loader2 className="w-4 h-4 animate-spin" /> Extracting Division 10 sections…</> : "Extract Spec Sections from PDF"}
                          </button>
                        </div>
                      )}
                      {extracting && (
                        <div className="flex items-center justify-center gap-2 mt-4" style={{ color: "var(--gold)" }}>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm">Reading PDF and finding Division 10 sections…</span>
                        </div>
                      )}
                    </div>
                  )}

                  {specExtractorTab === "image" && (
                    <div>
                      <input ref={specImageInputRef} type="file" multiple accept="image/*" className="hidden"
                        onChange={e => { const f = Array.from(e.target.files || []); if (f.length > 0) runSpecExtractImages(f); }} />
                      <div
                        onClick={() => specImageInputRef.current?.click()}
                        onDragOver={e => { e.preventDefault(); setSpecDropActive(true); }}
                        onDragLeave={e => { e.preventDefault(); setSpecDropActive(false); }}
                        onDrop={e => {
                          e.preventDefault();
                          setSpecDropActive(false);
                          const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
                          if (files.length > 0) runSpecExtractImages(files);
                          else toast({ title: "No images found", description: "Please drop image files (PNG, JPG).", variant: "destructive" });
                        }}
                        className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all"
                        style={{
                          borderColor: specDropActive ? "var(--gold)" : "var(--gold)40",
                          background: specDropActive ? "var(--gold)18" : "var(--gold)08",
                          transform: specDropActive ? "scale(1.01)" : "scale(1)",
                        }}
                      >
                        <Upload className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--gold)" }} />
                        <p className="text-sm font-semibold" style={{ color: "var(--gold)" }}>
                          {specDropActive ? "Drop spec images here" : "Drag & drop or click to upload spec images"}
                        </p>
                        <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>PNG, JPG — screenshots of Division 10 specification pages. Up to 20 files.</p>
                      </div>
                      {extracting && (
                        <div className="flex items-center justify-center gap-2 mt-4" style={{ color: "var(--gold)" }}>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm">Analyzing spec pages with AI…</span>
                        </div>
                      )}
                    </div>
                  )}

                  {specExtractorTab === "text" && (
                    <div>
                      <textarea
                        value={specPasteText} onChange={e => setSpecPasteText(e.target.value)}
                        rows={10} placeholder="Paste specification text here — copy from your PDF or project specs..."
                        className="w-full text-xs px-3 py-2.5 rounded-lg resize-none outline-none"
                        style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                      />
                      <button
                        onClick={() => runSpecExtractText(specPasteText)}
                        disabled={!specPasteText.trim() || extracting}
                        className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold"
                        style={{ background: "var(--gold)", color: "#000", opacity: (!specPasteText.trim() || extracting) ? 0.5 : 1 }}
                      >
                        {extracting ? <><Loader2 className="w-4 h-4 animate-spin" /> Analyzing…</> : "Extract Spec Sections"}
                      </button>
                    </div>
                  )}
                </>
              )}

              {/* Review — extracted spec sections */}
              {extractedSpecs.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-3 pb-3" style={{ borderBottom: "1px solid var(--border-ds)" }}>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>{extractedSpecs.filter(s => s._selected).length} of {extractedSpecs.length} sections selected</span>
                    <button onClick={() => { setExtractedSpecs([]); }} className="text-xs px-2 py-1 rounded" style={{ color: "var(--text-muted)" }}>← Start Over</button>
                  </div>

                  {extractedSpecs.length === 0 && (
                    <p className="text-sm text-center py-8" style={{ color: "var(--text-muted)" }}>No Division 10 sections found. Try a different image or paste the spec text directly.</p>
                  )}

                  <div className="space-y-3">
                    {extractedSpecs.map((sec, idx) => (
                      <div key={sec._id || `sec-${idx}`} className="rounded-lg p-4" style={{
                        background: sec._selected ? "var(--bg3)" : "var(--bg-card)",
                        border: `1px solid ${sec._selected ? "var(--gold)40" : "var(--border-ds)"}`,
                        opacity: sec._selected ? 1 : 0.5,
                      }}>
                        <div className="flex items-start justify-between gap-3 mb-2">
                          <div className="flex items-center gap-2">
                            <input type="checkbox" checked={sec._selected}
                              onChange={() => setExtractedSpecs(prev => prev.map((s, j) => j === idx ? { ...s, _selected: !s._selected } : s))} />
                            <div>
                              <span className="text-sm font-semibold" style={{ color: "var(--text)" }}>{sec.csiCode} — {sec.specSectionTitle}</span>
                              {sec.sourcePages && <span className="text-xs ml-2" style={{ color: "var(--text-muted)" }}>Source: {sec.sourcePages}</span>}
                            </div>
                          </div>
                          <span className="text-xs px-2 py-0.5 rounded flex-shrink-0" style={{
                            background: sec.confidence >= 80 ? "#22c55e15" : "#f9731615",
                            color: sec.confidence >= 80 ? "#22c55e" : "#f97316",
                          }}>{sec.confidence}%</span>
                        </div>

                        {sec.manufacturers && sec.manufacturers.length > 0 && (
                          <div className="text-xs mb-1.5">
                            <span className="font-semibold" style={{ color: "var(--text-muted)" }}>Manufacturers: </span>
                            <span style={{ color: "var(--text-secondary)" }}>{sec.manufacturers.join(", ")}</span>
                          </div>
                        )}
                        {sec.substitutionPolicy && (
                          <div className="text-xs mb-1.5">
                            <span className="font-semibold" style={{ color: "var(--text-muted)" }}>Substitution: </span>
                            <span className="font-semibold" style={{ color: sec.substitutionPolicy.includes("no sub") ? "#ef4444" : "#f97316" }}>"{sec.substitutionPolicy}"</span>
                          </div>
                        )}
                        {sec.keyRequirements && sec.keyRequirements.length > 0 && (
                          <div className="text-xs mb-1.5">
                            <span className="font-semibold" style={{ color: "var(--text-muted)" }}>Key Requirements: </span>
                            {sec.keyRequirements.slice(0, 3).map((r, i) => (
                              <span key={`${sec._id}-req-${i}`} style={{ color: "var(--text-secondary)" }}>• {r} </span>
                            ))}
                            {sec.keyRequirements.length > 3 && <span style={{ color: "var(--text-muted)" }}>+{sec.keyRequirements.length - 3} more</span>}
                          </div>
                        )}

                        {sec.content && (
                          <button
                            onClick={() => setExpandedSpecSections(prev => {
                              const next = new Set(prev);
                              if (next.has(sec._id)) next.delete(sec._id); else next.add(sec._id);
                              return next;
                            })}
                            className="text-xs mt-1 flex items-center gap-1"
                            style={{ color: "var(--gold)" }}
                          >
                            View Full Spec Text {expandedSpecSections.has(sec._id) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          </button>
                        )}
                        {expandedSpecSections.has(sec._id) && sec.content && (
                          <pre className="mt-2 p-3 rounded text-xs whitespace-pre-wrap leading-relaxed" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)", maxHeight: 200, overflow: "auto" }}>
                            {sec.content}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            {extractedSpecs.length > 0 && (
              <div className="px-5 py-4 sticky bottom-0 flex items-center justify-between gap-3 flex-wrap" style={{ background: "var(--bg-card)", borderTop: "1px solid var(--border-ds)" }}>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>Saving will auto-check the corresponding scope sections and make spec language available in each scope tab.</span>
                <div className="flex gap-2">
                  <button onClick={() => setShowSpecExtractor(false)} className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-muted)" }}>Cancel</button>
                  <button
                    onClick={saveSpecSections}
                    disabled={savingSpecs || extractedSpecs.filter(s => s._selected).length === 0}
                    className="text-xs px-4 py-2 rounded font-semibold flex items-center gap-1.5"
                    style={{ background: "var(--gold)", color: "#000", opacity: savingSpecs ? 0.7 : 1 }}>
                    {savingSpecs ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</> : `Save ${extractedSpecs.filter(s => s._selected).length} Spec Sections to Estimate`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── VENDOR QUOTE REVIEW MODAL ── */}
      {reviewQuote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}
          onClick={e => { if (e.target === e.currentTarget) setReviewQuote(null); }}>
          <div className="rounded-xl shadow-2xl flex flex-col" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", width: "min(900px, 96vw)", maxHeight: "88vh" }}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: "var(--border-ds)" }}>
              <div className="flex items-center gap-3">
                <Zap className="w-4 h-4" style={{ color: "var(--gold)" }} />
                <span className="font-semibold text-sm" style={{ color: "var(--text)" }}>AI Quote Review — {reviewQuote.vendor}</span>
                {reviewQuote.status === "needs_review" && <span className="px-2 py-0.5 rounded text-xs" style={{ background: "#f5a62315", color: "#f5a623", border: "1px solid #f5a62340" }}>⚠ Needs Review</span>}
                {reviewQuote.status === "ready_for_approval" && <span className="px-2 py-0.5 rounded text-xs" style={{ background: "#22c55e15", color: "#22c55e", border: "1px solid #22c55e40" }}>✓ Ready</span>}
                {reviewQuote.status === "approved" && <span className="px-2 py-0.5 rounded text-xs" style={{ background: "#22c55e20", color: "#22c55e", border: "1px solid #22c55e50" }}>✓ Approved</span>}
                {reviewQuote.status === "failed" && <span className="px-2 py-0.5 rounded text-xs" style={{ background: "#ef444415", color: "#ef4444", border: "1px solid #ef444440" }}>✗ Extraction Failed</span>}
                {reviewQuote.processingMetadataJson && (
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    Confidence: <strong style={{ color: (reviewQuote.processingMetadataJson as any).quoteConfidence >= 0.7 ? "#22c55e" : "#f5a623" }}>
                      {Math.round(((reviewQuote.processingMetadataJson as any).quoteConfidence || 0) * 100)}%
                    </strong>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {reviewQuote.filePath && (
                  <button onClick={async () => {
                    try {
                      const res = await fetch(`/api/estimates/quotes/${reviewQuote.id}/backup-file`, { credentials: "include" });
                      if (!res.ok) throw new Error();
                      const blob = await res.blob();
                      window.open(URL.createObjectURL(blob), "_blank");
                    } catch { toast({ title: "Could not open file", variant: "destructive" }); }
                  }} className="text-xs px-3 py-1.5 rounded flex items-center gap-1" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-secondary)" }}>
                    <ExternalLink className="w-3 h-3" /> View PDF
                  </button>
                )}
                {(reviewQuote.status === "needs_review" || reviewQuote.status === "failed" || !reviewQuote.status) && (
                  <button onClick={() => processQuote(reviewQuote.id)} disabled={reviewProcessing}
                    className="text-xs px-3 py-1.5 rounded flex items-center gap-1 font-semibold"
                    style={{ background: "#06b6d415", border: "1px solid #06b6d440", color: "#06b6d4", opacity: reviewProcessing ? 0.6 : 1 }}>
                    {reviewProcessing ? <><Loader2 className="w-3 h-3 animate-spin" />Re-processing…</> : <><RefreshCw className="w-3 h-3" />Re-process</>}
                  </button>
                )}
                <button onClick={() => setReviewQuote(null)} className="p-1.5 rounded hover:bg-red-500/10">
                  <X className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                </button>
              </div>
            </div>

            {/* Header info from extraction */}
            {reviewQuote.latestExtractionJson && (
              <div className="px-5 py-2 flex items-center gap-4 text-xs border-b flex-wrap" style={{ borderColor: "var(--border-ds)", background: "var(--bg3)" }}>
                {(reviewQuote.latestExtractionJson as any).quoteNumber && <span><span style={{ color: "var(--text-muted)" }}>Quote #:</span> <strong style={{ color: "var(--text)" }}>{(reviewQuote.latestExtractionJson as any).quoteNumber}</strong></span>}
                {(reviewQuote.latestExtractionJson as any).quoteDate && <span><span style={{ color: "var(--text-muted)" }}>Date:</span> <strong style={{ color: "var(--text)" }}>{(reviewQuote.latestExtractionJson as any).quoteDate}</strong></span>}
                {(reviewQuote.latestExtractionJson as any).grandTotal && <span><span style={{ color: "var(--text-muted)" }}>Grand Total:</span> <strong style={{ color: "var(--gold)" }}>{fmt((reviewQuote.latestExtractionJson as any).grandTotal)}</strong></span>}
                {(reviewQuote.latestExtractionJson as any).notes && <span style={{ color: "var(--text-muted)" }}>{(reviewQuote.latestExtractionJson as any).notes}</span>}
              </div>
            )}

            {/* Error message */}
            {reviewQuote.latestError && (
              <div className="px-5 py-2 text-xs" style={{ background: "#ef444408", color: "#ef4444" }}>⚠ {reviewQuote.latestError}</div>
            )}

            {/* Rows table */}
            <div className="flex-1 overflow-auto px-2 py-2">
              {reviewLoading || reviewProcessing ? (
                <div className="flex items-center justify-center py-12 gap-2 text-sm" style={{ color: "var(--text-muted)" }}>
                  <Loader2 className="w-5 h-5 animate-spin" /> {reviewProcessing ? "Extracting with AI…" : "Loading…"}
                </div>
              ) : reviewRows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
                  <p className="text-sm" style={{ color: "var(--text-muted)" }}>No extracted rows yet.</p>
                  {reviewQuote.hasBackup && (
                    <button onClick={() => processQuote(reviewQuote.id)} className="text-xs px-4 py-2 rounded font-semibold flex items-center gap-1.5"
                      style={{ background: "var(--gold)", color: "#000" }}>
                      <Zap className="w-3 h-3" /> Run AI Extraction
                    </button>
                  )}
                  {!reviewQuote.hasBackup && <p className="text-xs" style={{ color: "var(--text-muted)" }}>Attach a PDF backup file to this quote first, then run extraction.</p>}
                </div>
              ) : (
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border-ds)" }}>
                      <th className="px-2 py-1.5 text-left w-6">
                        <input type="checkbox"
                          checked={reviewRows.length > 0 && reviewChecked.size === reviewRows.length}
                          onChange={e => setReviewChecked(e.target.checked ? new Set(reviewRows.map(r => r.id)) : new Set())}
                          style={{ accentColor: "var(--gold)" }} />
                      </th>
                      <th className="px-2 py-1.5 text-left" style={{ color: "var(--text-secondary)" }}>Description</th>
                      <th className="px-2 py-1.5 text-left" style={{ color: "var(--text-secondary)" }}>Part #</th>
                      <th className="px-2 py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>Qty</th>
                      <th className="px-2 py-1.5 text-left" style={{ color: "var(--text-secondary)" }}>Unit</th>
                      <th className="px-2 py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>Unit Cost</th>
                      <th className="px-2 py-1.5 text-right" style={{ color: "var(--text-secondary)" }}>Ext. Cost</th>
                      <th className="px-2 py-1.5 text-center" style={{ color: "var(--text-secondary)" }}>Conf.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reviewRows.map(row => {
                      const conf = parseFloat(row.confidence || "0");
                      const confColor = conf >= 0.8 ? "#22c55e" : conf >= 0.6 ? "#f5a623" : "#ef4444";
                      const isChecked = reviewChecked.has(row.id);
                      return (
                        <tr key={row.id} style={{ borderBottom: "1px solid var(--border-ds)08", background: isChecked ? "var(--gold)05" : "transparent" }}>
                          <td className="px-2 py-1.5">
                            <input type="checkbox" checked={isChecked}
                              onChange={e => setReviewChecked(prev => { const s = new Set(prev); e.target.checked ? s.add(row.id) : s.delete(row.id); return s; })}
                              style={{ accentColor: "var(--gold)" }} />
                          </td>
                          <td className="px-2 py-1">
                            <input value={row.description || ""} onChange={e => updateReviewRow(row.id, "description", e.target.value)}
                              className="w-full text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)", minWidth: 200 }} />
                          </td>
                          <td className="px-2 py-1">
                            <input value={row.partNumber || ""} onChange={e => updateReviewRow(row.id, "partNumber", e.target.value)}
                              className="w-full text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)", minWidth: 80 }} />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" value={row.qty || ""} onChange={e => updateReviewRow(row.id, "qty", e.target.value)}
                              className="w-16 text-xs px-1.5 py-0.5 rounded text-right" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}  onFocus={selectIfZero}/>
                          </td>
                          <td className="px-2 py-1">
                            <input value={row.unit || ""} onChange={e => updateReviewRow(row.id, "unit", e.target.value)}
                              className="w-14 text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }} />
                          </td>
                          <td className="px-2 py-1">
                            <MoneyInput
                              value={row.unitCost}
                              onChange={raw => updateReviewRow(row.id, "unitCost", raw)}
                              size="xs"
                              className="w-28"
                              style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}
                              ariaLabel="Unit cost in dollars"
                            />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" value={row.extendedCost || ""} onChange={e => updateReviewRow(row.id, "extendedCost", e.target.value)}
                              className="w-24 text-xs px-1.5 py-0.5 rounded text-right" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}  onFocus={selectIfZero}/>
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: `${confColor}15`, color: confColor, border: `1px solid ${confColor}30`, fontSize: "10px" }}>
                              {Math.round(conf * 100)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            {reviewRows.length > 0 && reviewQuote.status !== "approved" && (
              <div className="flex items-center justify-between px-5 py-3 border-t" style={{ borderColor: "var(--border-ds)" }}>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {reviewChecked.size} of {reviewRows.length} row(s) selected for approval
                </span>
                <div className="flex items-center gap-2">
                  <button onClick={() => setReviewQuote(null)} className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Cancel</button>
                  <button onClick={() => approveQuote(reviewQuote.id)} disabled={reviewApproving || reviewChecked.size === 0}
                    className="text-xs px-4 py-2 rounded font-semibold flex items-center gap-1.5"
                    style={{ background: "var(--gold)", color: "#000", opacity: reviewApproving || reviewChecked.size === 0 ? 0.6 : 1 }}>
                    {reviewApproving ? <><Loader2 className="w-3 h-3 animate-spin" />Approving…</> : <>✓ Approve {reviewChecked.size} Row(s) → Estimate</>}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── BULK ACTION MODALS ── */}

      {isTransferModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={e => { if (e.target === e.currentTarget) setIsTransferModalOpen(false); }}>
          <div className="rounded-xl p-6 w-full max-w-md shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
            <h3 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>Transfer to Scope</h3>
            <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>Move {selectedCount} line item(s) to a different scope.</p>
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>Target Scope</label>
            <select value={transferTargetScope} onChange={e => setTransferTargetScope(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded mb-4"
              style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}>
              <option value="">— Select scope —</option>
              {ALL_SCOPES.filter(s => s.id !== activeCat).map(s => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            {transferTargetScope && (
              <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>
                Transfer {selectedCount} item(s) to <strong style={{ color: "var(--text)" }}>{ALL_SCOPES.find(s => s.id === transferTargetScope)?.label}</strong>?
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setIsTransferModalOpen(false); setTransferTargetScope(""); }}
                className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Cancel</button>
              <button onClick={() => bulkTransfer(transferTargetScope, selectedLineItemIds)}
                disabled={!transferTargetScope || isBulkActionLoading}
                className="text-xs px-4 py-2 rounded font-semibold"
                style={{ background: "#06b6d4", color: "#fff", opacity: !transferTargetScope || isBulkActionLoading ? 0.5 : 1 }}>
                {isBulkActionLoading && activeBulkAction === "transfer" ? "Transferring…" : "Transfer"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={e => { if (e.target === e.currentTarget) setIsDeleteModalOpen(false); }}>
          <div className="rounded-xl p-6 w-full max-w-md shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid #ef444440" }}>
            <h3 className="text-base font-semibold mb-1" style={{ color: "#ef4444" }}>Delete Line Items</h3>
            <p className="text-sm mb-4" style={{ color: "var(--text-secondary)" }}>
              Delete <strong>{selectedCount} selected line item(s)</strong>? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setIsDeleteModalOpen(false)}
                className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Cancel</button>
              <button onClick={() => bulkDelete(selectedLineItemIds)}
                disabled={isBulkActionLoading}
                className="text-xs px-4 py-2 rounded font-semibold"
                style={{ background: "#ef4444", color: "#fff", opacity: isBulkActionLoading ? 0.5 : 1 }}>
                {isBulkActionLoading && activeBulkAction === "delete" ? "Deleting…" : `Delete ${selectedCount} Item(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {isVendorQuoteModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={e => { if (e.target === e.currentTarget) setIsVendorQuoteModalOpen(false); }}>
          <div className="rounded-xl p-6 w-full max-w-md shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
            <h3 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>Apply Vendor Quote</h3>
            <p className="text-xs mb-4" style={{ color: "var(--text-muted)" }}>Link {selectedCount} item(s) to a vendor quote.</p>
            <label className="block text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>Vendor Quote</label>
            <select value={applyQuoteId} onChange={e => setApplyQuoteId(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded mb-3"
              style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}>
              <option value="">— Select quote —</option>
              {quotes.map(q => (
                <option key={q.id} value={String(q.id)}>
                  {q.vendor}{q.note ? ` (${q.note})` : ""} — {ALL_SCOPES.find(s => s.id === q.category)?.label || q.category}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs cursor-pointer mb-4" style={{ color: "var(--text-secondary)" }}>
              <input type="checkbox" checked={applyQuoteOverrideCosts} onChange={e => setApplyQuoteOverrideCosts(e.target.checked)}
                style={{ accentColor: "var(--gold)" }} />
              Override existing unit costs (lump-sum quotes only)
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setIsVendorQuoteModalOpen(false); setApplyQuoteId(""); setApplyQuoteOverrideCosts(false); }}
                className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Cancel</button>
              <button onClick={() => bulkApplyVendorQuote(parseInt(applyQuoteId), applyQuoteOverrideCosts, selectedLineItemIds)}
                disabled={!applyQuoteId || isBulkActionLoading}
                className="text-xs px-4 py-2 rounded font-semibold"
                style={{ background: "#a855f7", color: "#fff", opacity: !applyQuoteId || isBulkActionLoading ? 0.5 : 1 }}>
                {isBulkActionLoading && activeBulkAction === "vendorQuote" ? "Applying…" : "Apply Quote"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Approved Manufacturer Modal ── */}
      {showAddMfrModal && rfqLookupEnabled && (() => {
        const term = mfrSearchTerm.trim().toLowerCase();
        const approvedIds = new Set(approvedMfrs.map(a => a.manufacturerId));
        const filtered = allManufacturers
          .filter(m => !approvedIds.has(m.id))
          .filter(m => !term || m.name.toLowerCase().includes(term))
          .slice(0, 50);
        const exactMatch = allManufacturers.find(m => m.name.toLowerCase() === term);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={e => { if (e.target === e.currentTarget) setShowAddMfrModal(false); }}>
            <div className="rounded-xl p-6 w-full max-w-md shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }} data-testid="modal-add-approved-mfr">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>Add Approved Manufacturer</h3>
                <button onClick={() => setShowAddMfrModal(false)} className="p-1 rounded hover:bg-[var(--bg3)]" data-testid="button-close-add-mfr">
                  <X className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                </button>
              </div>
              <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>Search the manufacturer database, or create a new one inline.</p>
              <input
                autoFocus
                value={mfrSearchTerm}
                onChange={e => setMfrSearchTerm(e.target.value)}
                placeholder="Search manufacturers…"
                className="w-full text-sm px-3 py-2 rounded mb-3"
                style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                data-testid="input-search-mfr"
              />
              <div className="max-h-64 overflow-y-auto rounded mb-3" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                {filtered.length === 0 ? (
                  <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>No matches.</div>
                ) : filtered.map(m => (
                  <button
                    key={m.id}
                    onClick={() => { if (!guardViewer(isViewer, toast)) { addApprovedMfrMutation.mutate(m.id); setShowAddMfrModal(false); } }}
                    disabled={addApprovedMfrMutation.isPending || isViewer}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-[var(--bg-card)]"
                    style={{ color: "var(--text)", borderBottom: "1px solid var(--border-ds)" }}
                    data-testid={`button-pick-mfr-${m.id}`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
              {!exactMatch && term.length > 0 && (
                <div className="p-3 rounded mb-2" style={{ background: "var(--bg3)", border: "1px dashed var(--gold)40" }}>
                  <div className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>Don't see it? Create a new manufacturer:</div>
                  <div className="flex gap-2">
                    <input
                      value={newMfrName || mfrSearchTerm}
                      onChange={e => setNewMfrName(e.target.value)}
                      placeholder="Manufacturer name"
                      className="flex-1 text-sm px-3 py-2 rounded"
                      style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                      data-testid="input-new-mfr-name"
                    />
                    <button
                      onClick={() => { if (!newMfrName) setNewMfrName(mfrSearchTerm); createMfrInline(); }}
                      disabled={creatingMfr || (!newMfrName && !mfrSearchTerm)}
                      className="text-xs px-3 py-2 rounded font-semibold flex items-center gap-1"
                      style={{ background: "var(--gold)", color: "#000", opacity: creatingMfr ? 0.6 : 1 }}
                      data-testid="button-create-mfr"
                    >
                      {creatingMfr ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />} Create & Add
                    </button>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 mt-2">
                <button onClick={() => setShowAddMfrModal(false)}
                  className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── RFQ Recipient Picker Modal ── */}
      {rfqPickerMfr && rfqLookupEnabled && (() => {
        const mfrName = rfqPickerMfr;
        const approved = approvedMfrs.find(a => a.manufacturerName === mfrName);
        // Build grouped recipient list, filtered by activeCat scope tag
        const groups: Array<{
          vendorId: number;
          vendorName: string;
          manufacturerDirect: boolean;
          contacts: Array<{ id: number; name: string; role?: string | null; email: string | null; isPrimary: boolean }>;
        }> = [];
        if (approved) {
          const mfrId = approved.manufacturerId;
          for (const v of approved.vendors) {
            // Vendor-level eligibility (untagged = covers everything)
            const scopesOk = !v.scopes || v.scopes.length === 0 || v.scopes.includes(activeCat);
            // Loosened: only the scope tag gates eligibility.
            if (!scopesOk) continue;
            if (v.contacts.length > 0) groups.push({ vendorId: v.vendorId, vendorName: v.vendorName, manufacturerDirect: !!v.manufacturerDirect, contacts: v.contacts });
          }
        }
        groups.sort((a, b) => {
          if (a.manufacturerDirect !== b.manufacturerDirect) return a.manufacturerDirect ? -1 : 1;
          return a.vendorName.localeCompare(b.vendorName);
        });
        const allEligibleIds = groups.flatMap(g => g.contacts.map(c => c.id));
        const allChecked = allEligibleIds.length > 0 && allEligibleIds.every(id => rfqSelectedContactIds.has(id));
        const someChecked = allEligibleIds.some(id => rfqSelectedContactIds.has(id));
        const toggleAll = () => {
          if (allChecked) setRfqSelectedContactIds(new Set());
          else setRfqSelectedContactIds(new Set(allEligibleIds));
        };
        const toggleOne = (id: number) => {
          setRfqSelectedContactIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          });
        };
        const toggleGroup = (g: typeof groups[number]) => {
          const ids = g.contacts.map(c => c.id);
          setRfqSelectedContactIds(prev => {
            const allOn = ids.every(id => prev.has(id));
            const next = new Set(prev);
            if (allOn) ids.forEach(id => next.delete(id));
            else ids.forEach(id => next.add(id));
            return next;
          });
        };
        const selectedEmails = groups
          .flatMap(g => g.contacts)
          .filter(c => rfqSelectedContactIds.has(c.id) && c.email)
          .map(c => c.email!) as string[];
        const sendNow = () => {
          if (selectedEmails.length === 0) {
            toast({ title: "No recipients selected", description: "Tick at least one contact to send the RFQ.", variant: "destructive" });
            return;
          }
          const rfq = generateRfqEmail(mfrName);
          const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
          const catItems = lineItems.filter(i => i.category === activeCat && i.mfr && namesMatch(i.mfr, mfrName));
          const estimatorName = user?.displayName || user?.username || user?.email || "NBS Estimating";
          const dueDate = effectiveDueDate(activeCat);
          const html = buildRfqHtmlBody({
            greeting: `Dear ${mfrName} Sales Team`,
            intro: "National Building Specialties is requesting pricing for the following Division 10 items on the project below.",
            projectName: proposalEntry?.projectName || "",
            gc: proposalEntry?.gcEstimateLead || "",
            dueDate,
            estimateNumber: estimateData?.estimateNumber || "",
            scope: catLabel,
            shipTo: buildShipToBlock(),
            itemsHtml: formatItemsTableHtml(catItems),
            estimatorName,
          });
          downloadRfqEml({
            to: selectedEmails,
            subject: rfq.subject,
            html,
            filename: `RFQ_${proposalEntry?.projectName || "Project"}_${mfrName}`,
          });
          logRfq(mfrName, "email", selectedEmails);
          toast({ title: "RFQ draft downloaded", description: "Open the .eml file to launch a formatted Outlook draft." });
          setRfqPickerMfr(null);
        };
        const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
        // Visual-only search filter: narrows which vendors/contacts are *displayed*.
        // Does NOT change `groups`, `allEligibleIds`, `allChecked`, `toggleAll`, `toggleGroup`,
        // or `selectedEmails` — pre-checked contacts and send behavior are unaffected.
        // The per-vendor "select all" checkbox always operates on the FULL group
        // (`original.contacts`), never on the search-filtered subset, so toggling
        // a vendor row during a search still reflects every contact for that vendor.
        const pickerSearchLower = rfqPickerSearch.trim().toLowerCase();
        const visibleGroups: { original: typeof groups[number]; visibleContacts: typeof groups[number]["contacts"] }[] = pickerSearchLower
          ? groups.flatMap(g => {
              if (g.vendorName.toLowerCase().includes(pickerSearchLower)) return [{ original: g, visibleContacts: g.contacts }];
              const matchingContacts = g.contacts.filter(c =>
                (c.name || "").toLowerCase().includes(pickerSearchLower) ||
                (c.email || "").toLowerCase().includes(pickerSearchLower)
              );
              return matchingContacts.length > 0 ? [{ original: g, visibleContacts: matchingContacts }] : [];
            })
          : groups.map(g => ({ original: g, visibleContacts: g.contacts }));
        const visibleContactCount = visibleGroups.reduce((n, vg) => n + vg.visibleContacts.length, 0);
        const totalContactCount = groups.reduce((n, g) => n + g.contacts.length, 0);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}
            onClick={e => { if (e.target === e.currentTarget) setRfqPickerMfr(null); }}>
            <div className="rounded-xl p-6 w-full max-w-2xl shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", maxHeight: "85vh", display: "flex", flexDirection: "column" }} data-testid="modal-rfq-recipients">
              <div className="flex items-center justify-between mb-1">
                <div>
                  <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>Pick RFQ Recipients</h3>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>{mfrName} · {catLabel}</p>
                </div>
                <button onClick={() => setRfqPickerMfr(null)} className="p-1 rounded hover:bg-[var(--bg3)]" data-testid="button-close-rfq-picker">
                  <X className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                </button>
              </div>
              {groups.length === 0 ? (
                <div className="mt-4 p-4 rounded text-xs" style={{ background: "var(--bg3)", color: "var(--text-muted)" }}>
                  No eligible contacts found. Make sure this manufacturer has at least one linked vendor with contacts in the Vendor Database, and that those contacts are tagged with the "{catLabel}" scope (or have no scope tags).
                </div>
              ) : (
                <>
                  <input
                    value={rfqPickerSearch}
                    onChange={e => setRfqPickerSearch(e.target.value)}
                    placeholder="Filter vendors or contacts by name/email…"
                    className="w-full text-xs p-2 rounded mt-3"
                    style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                    data-testid="input-rfq-picker-search"
                  />
                  <div className="flex items-center justify-between mt-2 mb-2">
                    <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                      <input type="checkbox" checked={allChecked} ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }} onChange={toggleAll} style={{ accentColor: "var(--gold)" }} />
                      Select all ({allEligibleIds.length})
                    </label>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {pickerSearchLower
                        ? <>Showing {visibleContactCount} of {totalContactCount} contact{totalContactCount === 1 ? "" : "s"} · {rfqSelectedContactIds.size} selected</>
                        : <>{rfqSelectedContactIds.size} selected</>}
                    </span>
                  </div>
                  <div className="overflow-y-auto rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", flex: 1 }}>
                    {visibleGroups.length === 0 && (
                      <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }} data-testid="text-rfq-picker-no-match">No vendors or contacts match.</div>
                    )}
                    {visibleGroups.map(({ original: g, visibleContacts }) => {
                      // Selection logic always uses the FULL group, not the search subset.
                      const groupIds = g.contacts.map(c => c.id);
                      const groupAll = groupIds.every(id => rfqSelectedContactIds.has(id));
                      const groupSome = groupIds.some(id => rfqSelectedContactIds.has(id));
                      return (
                        <div key={g.vendorId} style={{ borderBottom: "1px solid var(--border-ds)" }}>
                          <div className="flex items-center justify-between px-3 py-2" style={{ background: "var(--bg-card)" }}>
                            <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer" style={{ color: "var(--gold)" }}>
                              <input type="checkbox" checked={groupAll} ref={el => { if (el) el.indeterminate = groupSome && !groupAll; }} onChange={() => toggleGroup(g)} style={{ accentColor: "var(--gold)" }} />
                              {g.vendorName}
                              {g.manufacturerDirect && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(91,141,239,0.15)", color: "#5B8DEF" }} title="Manufacturer Direct" data-testid={`badge-direct-picker-${g.vendorId}`}>DIRECT</span>}
                            </label>
                            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{visibleContacts.length === g.contacts.length ? `${g.contacts.length} contact${g.contacts.length === 1 ? "" : "s"}` : `${visibleContacts.length} of ${g.contacts.length} shown`}</span>
                          </div>
                          {visibleContacts.map(c => (
                            <label key={c.id} className="flex items-center gap-3 px-5 py-2 cursor-pointer hover:bg-[var(--bg-card)]" style={{ borderTop: "1px solid var(--border-ds)20" }} data-testid={`row-rfq-contact-${c.id}`}>
                              <input type="checkbox" checked={rfqSelectedContactIds.has(c.id)} onChange={() => toggleOne(c.id)} style={{ accentColor: "var(--gold)" }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>{c.name || "(no name)"}</span>
                                  {c.isPrimary && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(201,168,76,0.2)", color: "var(--gold)" }}>PRIMARY</span>}
                                  {c.role && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{c.role}</span>}
                                </div>
                                <div className="text-[11px]" style={{ color: c.email ? "#5B8DEF" : "var(--text-muted)" }}>{c.email || "(no email — won't be included)"}</div>
                              </div>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <div className="flex justify-between items-center gap-2 mt-3">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{selectedEmails.length} email{selectedEmails.length === 1 ? "" : "s"} will be added to To:</span>
                <div className="flex gap-2">
                  <button onClick={() => setRfqPickerMfr(null)}
                    className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }}
                    data-testid="button-cancel-rfq-picker">Cancel</button>
                  <button onClick={sendNow}
                    disabled={selectedEmails.length === 0}
                    className="text-xs px-4 py-2 rounded flex items-center gap-1 font-semibold"
                    style={{ background: "var(--gold)", color: "#000", opacity: selectedEmails.length === 0 ? 0.5 : 1 }}
                    data-testid="button-send-rfq">
                    <Send className="w-3 h-3" /> Download RFQ Draft
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── RFQ Vendor-Group Recipient Picker Modal ── */}
      {rfqVendorPicker !== null && rfqLookupEnabled && (() => {
        // Rebuild the same vendor groupings the RFQ panel uses, then locate the active vendor.
        const lineItemMfrs = Array.from(new Set(catLineItems.map(i => i.mfr).filter(Boolean))) as string[];
        const approvedNamesLocal = approvedMfrs.map(a => a.manufacturerName);
        type CombinedLocal = { name: string; approved?: ApprovedMfr; discoveredMfrId?: number };
        const combinedLocal: CombinedLocal[] = [];
        for (const am of approvedMfrs) combinedLocal.push({ name: am.manufacturerName, approved: am });
        for (const li of lineItemMfrs) {
          if (approvedNamesLocal.some(an => namesMatch(an, li))) continue;
          const itemWithId = catLineItems.find(i => i.mfr === li && (i as any).manufacturerId);
          const fkId: number | undefined = (itemWithId as any)?.manufacturerId;
          const byName = allManufacturers.find(m => m.name.trim().toLowerCase() === li.trim().toLowerCase());
          combinedLocal.push({ name: li, discoveredMfrId: fkId ?? byName?.id });
        }
        type VG = {
          vendorId: number;
          vendorName: string;
          manufacturerDirect: boolean;
          contacts: Array<{ id: number; name: string; role?: string | null; email: string | null; isPrimary: boolean }>;
          manufacturers: Array<{ name: string; mfrId: number; items: typeof catLineItems }>;
        };
        const map = new Map<number, VG>();
        for (const entry of combinedLocal) {
          const src: { mfrId: number; vendors: ApprovedMfr["vendors"] } | null = entry.approved
            ? { mfrId: entry.approved.manufacturerId, vendors: entry.approved.vendors }
            : (entry.discoveredMfrId ? (() => { const d = discoveredMfrs.find(x => x.manufacturerId === entry.discoveredMfrId); return d ? { mfrId: d.manufacturerId, vendors: d.vendors } : null; })() : null);
          if (!src) continue;
          for (const v of src.vendors) {
            const scopesOk = !v.scopes || v.scopes.length === 0 || v.scopes.includes(activeCat);
            // Loosened: only the scope tag gates eligibility.
            if (!scopesOk) continue;
            let g = map.get(v.vendorId);
            if (!g) { g = { vendorId: v.vendorId, vendorName: v.vendorName, manufacturerDirect: !!v.manufacturerDirect, contacts: [], manufacturers: [] }; map.set(v.vendorId, g); }
            for (const c of v.contacts) { if (!g.contacts.find(x => x.id === c.id)) g.contacts.push(c); }
            if (!g.manufacturers.find(m => m.mfrId === src.mfrId)) g.manufacturers.push({ name: entry.name, mfrId: src.mfrId, items: catLineItems.filter(i => i.mfr && namesMatch(i.mfr, entry.name)) });
          }
        }
        const group = map.get(rfqVendorPicker);
        if (!group) return null;

        const allIds = group.contacts.map(c => c.id);
        const allChecked = allIds.length > 0 && allIds.every(id => rfqVendorPickerContactIds.has(id));
        const someChecked = allIds.some(id => rfqVendorPickerContactIds.has(id));
        const toggleAll = () => setRfqVendorPickerContactIds(allChecked ? new Set() : new Set(allIds));
        const toggleOne = (id: number) => setRfqVendorPickerContactIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

        const selectedEmails = group.contacts.filter(c => rfqVendorPickerContactIds.has(c.id) && c.email).map(c => c.email!) as string[];
        const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
        const estimatorName = user?.displayName || user?.username || user?.email || "NBS Estimating";

        // Build consolidated email body grouped by manufacturer
        const subject = `${proposalEntry?.projectName || ""} — ${catLabel} — ${group.manufacturers.map(m => m.name).join(", ")}`;
        const dueDate = effectiveDueDate(activeCat);
        const shipTo = buildShipToBlock();
        const mfrBlocks = group.manufacturers.map(m => {
          return `${m.name.toUpperCase()}:\n${formatItemsTable(m.items)}`;
        }).join("\n\n");
        const specRef = specSectionForScope(activeCat);
        let specBlock = "";
        if (specRef) {
          const sl: string[] = [];
          if (specRef.csiCode || specRef.specSectionTitle) sl.push(`SPECIFICATION REFERENCE: ${[specRef.csiCode, specRef.specSectionTitle].filter(Boolean).join(" — ")}`);
          if (specRef.substitutionPolicy) sl.push(`SUBSTITUTION POLICY: "${specRef.substitutionPolicy}"`);
          if (sl.length > 0) specBlock = `\n\nSPECIFICATION REQUIREMENTS:\n${sl.join("\n")}`;
        }
        const body = `Dear ${group.vendorName} Team,\n\nNational Building Specialties is requesting pricing for the following Division 10 items on the project below. We understand you can quote multiple manufacturer lines we need on this job, so we've consolidated them into a single request.\n\nPROJECT: ${proposalEntry?.projectName || ""}\nGC: ${proposalEntry?.gcEstimateLead || ""}\nBID DUE: ${dueDate}\nNBS ESTIMATE #: ${estimateData?.estimateNumber || ""}\n\n${shipTo}${specBlock}\n\nITEMS REQUESTED (grouped by manufacturer):\n\n${mfrBlocks}\n\nPlease provide:\n  1. MATERIAL ONLY unit pricing (NO labor or installation)\n  2. Freight cost to jobsite\n  3. Lead time / availability\n  4. Indicate if pricing includes or excludes sales tax\n\nPricing Needed By: ${dueDate || "bid due date"}\n\nThank you,\n${estimatorName}\nNational Building Specialties`;

        const sendNow = () => {
          if (selectedEmails.length === 0) { toast({ title: "No recipients selected", description: "Tick at least one contact.", variant: "destructive" }); return; }
          // Build grouped HTML: one items table per manufacturer
          const itemsHtml = group.manufacturers.map(m => {
            return `<p style="margin: 12px 0 4px 0;"><strong>${escapeHtml(m.name.toUpperCase())}</strong></p>${formatItemsTableHtml(m.items)}`;
          }).join("");
          const html = buildRfqHtmlBody({
            greeting: `Dear ${group.vendorName} Team`,
            intro: "National Building Specialties is requesting pricing for the following Division 10 items on the project below. We understand you can quote multiple manufacturer lines we need on this job, so we've consolidated them into a single request.",
            projectName: proposalEntry?.projectName || "",
            gc: proposalEntry?.gcEstimateLead || "",
            dueDate,
            estimateNumber: estimateData?.estimateNumber || "",
            scope: catLabel,
            shipTo,
            itemsHtml,
            estimatorName,
          });
          downloadRfqEml({
            to: selectedEmails,
            subject,
            html,
            filename: `RFQ_${proposalEntry?.projectName || "Project"}_${group.vendorName}`,
          });
          group.manufacturers.forEach(m => logRfq(m.name, "email", selectedEmails));
          toast({ title: "RFQ draft downloaded", description: "Open the .eml file to launch a formatted Outlook draft." });
          setRfqVendorPicker(null);
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={e => { if (e.target === e.currentTarget) setRfqVendorPicker(null); }}>
            <div className="rounded-xl p-6 w-full max-w-2xl shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", maxHeight: "85vh", display: "flex", flexDirection: "column" }} data-testid="modal-rfq-vendor-recipients">
              <div className="flex items-center justify-between mb-1">
                <div>
                  <h3 className="text-base font-semibold flex items-center gap-2" style={{ color: "var(--text)" }}>Send Consolidated RFQ — {group.vendorName}{group.manufacturerDirect && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 3, background: "rgba(91,141,239,0.15)", color: "#5B8DEF" }} title="Manufacturer Direct" data-testid={`badge-direct-vendor-picker-${group.vendorId}`}>DIRECT</span>}</h3>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>{catLabel} · {group.manufacturers.map(m => m.name).join(", ")}</p>
                </div>
                <button onClick={() => setRfqVendorPicker(null)} className="p-1 rounded hover:bg-[var(--bg3)]" data-testid="button-close-rfq-vendor-picker">
                  <X className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                </button>
              </div>
              <div className="flex items-center justify-between mt-3 mb-2">
                <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "var(--text-secondary)" }}>
                  <input type="checkbox" checked={allChecked} ref={el => { if (el) el.indeterminate = someChecked && !allChecked; }} onChange={toggleAll} style={{ accentColor: "var(--gold)" }} />
                  Select all ({allIds.length})
                </label>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{rfqVendorPickerContactIds.size} selected</span>
              </div>
              <div className="overflow-y-auto rounded mb-3" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                {group.contacts.map(c => (
                  <label key={c.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-[var(--bg-card)]" style={{ borderBottom: "1px solid var(--border-ds)40" }} data-testid={`row-vendor-rfq-contact-${c.id}`}>
                    <input type="checkbox" checked={rfqVendorPickerContactIds.has(c.id)} onChange={() => toggleOne(c.id)} style={{ accentColor: "var(--gold)" }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>{c.name || "(no name)"}</span>
                        {c.isPrimary && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: "rgba(201,168,76,0.2)", color: "var(--gold)" }}>PRIMARY</span>}
                        {c.role && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{c.role}</span>}
                      </div>
                      <div className="text-[11px]" style={{ color: c.email ? "#5B8DEF" : "var(--text-muted)" }}>{c.email || "(no email — won't be included)"}</div>
                    </div>
                  </label>
                ))}
              </div>
              <details className="mb-2 text-xs" style={{ color: "var(--text-muted)" }}>
                <summary className="cursor-pointer">Preview email body</summary>
                <pre className="text-xs whitespace-pre-wrap mt-2 p-2 rounded" style={{ background: "var(--bg3)", maxHeight: 240, overflow: "auto" }}>{body}</pre>
              </details>
              <div className="flex justify-between items-center gap-2 mt-1">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>{selectedEmails.length} email{selectedEmails.length === 1 ? "" : "s"} will be added to To:</span>
                <div className="flex gap-2">
                  <button onClick={() => setRfqVendorPicker(null)} className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }} data-testid="button-cancel-rfq-vendor-picker">Cancel</button>
                  <button onClick={sendNow} disabled={selectedEmails.length === 0} className="text-xs px-4 py-2 rounded flex items-center gap-1 font-semibold" style={{ background: "var(--gold)", color: "#000", opacity: selectedEmails.length === 0 ? 0.5 : 1 }} data-testid="button-send-rfq-vendor">
                    <Send className="w-3 h-3" /> Download RFQ Draft
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Open RFQ Modal (ad-hoc line items + any vendor) ── */}
      {showOpenRfq && (() => {
        const catLabel = ALL_SCOPES.find(s => s.id === activeCat)?.label || activeCat;
        const estimatorName = user?.displayName || user?.username || user?.email || "NBS Estimating";

        const allItemIds = catLineItems.map(i => String(i.id));
        const allItemsChecked = allItemIds.length > 0 && allItemIds.every(id => openRfqSelectedItemIds.has(id));
        const someItemsChecked = allItemIds.some(id => openRfqSelectedItemIds.has(id));
        const toggleAllItems = () => setOpenRfqSelectedItemIds(allItemsChecked ? new Set() : new Set(allItemIds));
        const toggleItem = (id: string) => setOpenRfqSelectedItemIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
        const selectedItems = catLineItems.filter(i => openRfqSelectedItemIds.has(String(i.id)));

        // Helper: pick recipient emails for a given vendor record
        const pickRecipientEmails = (vendor: any): string[] => {
          const contacts = (vendor?.contacts || []) as Array<{ name?: string; email?: string | null; isPrimary?: boolean }>;
          const primary = contacts.find(c => c.isPrimary && c.email);
          return primary ? [primary.email!] : contacts.filter(c => c.email).map(c => c.email!);
        };

        // Resolve recipients per send target (1 entry = 1 email that will be opened)
        type SendTarget = { vendorName: string; emails: string[] };
        let sendTargets: SendTarget[] = [];
        if (openRfqVendorMode === "existing") {
          sendTargets = openRfqSelectedVendors.map(v => ({
            vendorName: v.name || "",
            emails: pickRecipientEmails(v),
          })).filter(t => t.vendorName);
        } else {
          const oneTimeName = openRfqNewVendorName.trim();
          const oneTimeEmail = openRfqNewVendorEmail.trim();
          if (oneTimeName) sendTargets = [{ vendorName: oneTimeName, emails: oneTimeEmail ? [oneTimeEmail] : [] }];
        }

        // ── Vendor relevance ranking for the existing-vendor picker ──
        // A) RFQ-used for this estimate+scope, B) tagged for active scope,
        // C) tagged to a manufacturer that appears on the user's selected line items
        // (or all line items in this scope if nothing is checked yet), D) other.
        // Default view shows only A/B/C; "Show all vendors" reveals D.
        const rfqUsedVendorIdsSet = new Set<number>(rfqUsedVendorIdsList);
        const mfrIdSource = selectedItems.length > 0 ? selectedItems : catLineItems;
        const relevantMfrIds = new Set<number>(
          mfrIdSource
            .map((i: any) => i?.manufacturerId)
            .filter((id: any): id is number => typeof id === "number" && id > 0)
        );
        const rankVendor = (v: VendorListItem): 1 | 2 | 3 | 4 =>
          rankVendorByScope(v, { rfqUsedSet: rfqUsedVendorIdsSet, scope: activeCat, relevantMfrSet: relevantMfrIds });

        const vendorSearchLower = openRfqVendorSearch.trim().toLowerCase();
        const baseVendors = openRfqOnlyDirect
          ? allVendorsForRfq.filter(v => !!v.manufacturerDirect)
          : allVendorsForRfq;
        const ranked = baseVendors.map(v => ({ v, rank: rankVendor(v) }));
        const visibleByRank = openRfqShowAll ? ranked : ranked.filter(r => r.rank <= 3);
        const sortedRanked = [...visibleByRank].sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank;
          if (!!a.v.manufacturerDirect !== !!b.v.manufacturerDirect) return a.v.manufacturerDirect ? -1 : 1;
          return a.v.name.localeCompare(b.v.name);
        });
        const searchedRanked = vendorSearchLower
          ? sortedRanked.filter(r => r.v.name.toLowerCase().includes(vendorSearchLower))
          : sortedRanked;
        const filteredVendors = searchedRanked.slice(0, 50).map(r => r.v);
        const hiddenByRank = openRfqShowAll ? 0 : ranked.filter(r => r.rank === 4).length;
        const rankCountsVisible = {
          a: visibleByRank.filter(r => r.rank === 1).length,
          b: visibleByRank.filter(r => r.rank === 2).length,
          c: visibleByRank.filter(r => r.rank === 3).length,
        };

        const dueDate = effectiveDueDate(activeCat);
        const shipTo = buildShipToBlock();
        const itemsTable = formatItemsTable(selectedItems);
        const notesBlock = openRfqExtraNotes.trim() ? `\n\nADDITIONAL NOTES:\n${openRfqExtraNotes.trim()}` : "";
        const buildSubject = (vName: string) => `${proposalEntry?.projectName || ""} — ${catLabel}${vName ? ` — ${vName}` : ""}`;
        const buildBody = (vName: string) => {
          const greeting = vName ? `Dear ${vName} Team` : "Hello";
          return `${greeting},\n\nNational Building Specialties is requesting pricing for the following Division 10 items on the project below.\n\nPROJECT: ${proposalEntry?.projectName || ""}\nGC: ${proposalEntry?.gcEstimateLead || ""}\nBID DUE: ${dueDate}\nNBS ESTIMATE #: ${estimateData?.estimateNumber || ""}\nSCOPE: ${catLabel}\n\n${shipTo}\n\nITEMS REQUESTED:\n${itemsTable}${notesBlock}\n\nPlease provide:\n  1. MATERIAL ONLY unit pricing (NO labor or installation)\n  2. Freight cost to jobsite\n  3. Lead time / availability\n  4. Indicate if pricing includes or excludes sales tax\n\nPricing Needed By: ${dueDate || "bid due date"}\n\nThank you,\n${estimatorName}\nNational Building Specialties`;
        };
        // Preview the first sendable target (or first selected even if no email)
        const previewTarget: SendTarget = sendTargets[0] || { vendorName: "", emails: [] };
        const subject = buildSubject(previewTarget.vendorName);
        const body = buildBody(previewTarget.vendorName);

        const sendableTargets = sendTargets.filter(t => t.emails.length > 0);
        const canSend = sendableTargets.length > 0 && selectedItems.length > 0;
        const allSent = sendableTargets.length > 0 && sendableTargets.every(t => openRfqSentVendorKeys.has(t.vendorName));
        const sendOneVendor = (t: SendTarget) => {
          const subj = buildSubject(t.vendorName);
          const html = buildRfqHtmlBody({
            greeting: t.vendorName ? `Dear ${t.vendorName} Team` : "Hello",
            intro: "National Building Specialties is requesting pricing for the following Division 10 items on the project below.",
            projectName: proposalEntry?.projectName || "",
            gc: proposalEntry?.gcEstimateLead || "",
            dueDate,
            estimateNumber: estimateData?.estimateNumber || "",
            scope: catLabel,
            shipTo,
            itemsHtml: formatItemsTableHtml(selectedItems),
            notes: openRfqExtraNotes,
            estimatorName,
          });
          downloadRfqEml({
            to: t.emails,
            subject: subj,
            html,
            filename: `RFQ_${proposalEntry?.projectName || "Project"}_${t.vendorName || "Vendor"}`,
          });
          logRfq(t.vendorName, "email", t.emails);
          setOpenRfqSentVendorKeys(prev => { const n = new Set(prev); n.add(t.vendorName); return n; });
        };

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }} onClick={e => { if (e.target === e.currentTarget) setShowOpenRfq(false); }}>
            <div className="rounded-xl p-6 w-full max-w-3xl shadow-2xl" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", maxHeight: "90vh", display: "flex", flexDirection: "column" }} data-testid="modal-open-rfq">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-base font-semibold" style={{ color: "var(--text)" }}>Open RFQ</h3>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>Pick line items and send to any vendor — useful for accessories or one-off requests.</p>
                </div>
                <button onClick={() => setShowOpenRfq(false)} className="p-1 rounded hover:bg-[var(--bg3)]" data-testid="button-close-open-rfq">
                  <X className="w-4 h-4" style={{ color: "var(--text-muted)" }} />
                </button>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, flex: 1, minHeight: 0 }}>
                {/* Left: line items */}
                <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>Line items ({catLabel})</span>
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: "var(--text-muted)" }}>
                      <input type="checkbox" checked={allItemsChecked} ref={el => { if (el) el.indeterminate = someItemsChecked && !allItemsChecked; }} onChange={toggleAllItems} style={{ accentColor: "var(--gold)" }} data-testid="checkbox-open-rfq-all-items" />
                      All ({allItemIds.length})
                    </label>
                  </div>
                  <div className="overflow-y-auto rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", flex: 1 }}>
                    {catLineItems.length === 0 && <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>No line items in this scope yet.</div>}
                    {catLineItems.map(i => (
                      <label key={i.id} className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg-card)]" style={{ borderBottom: "1px solid var(--border-ds)40" }} data-testid={`row-open-rfq-item-${i.id}`}>
                        <input type="checkbox" checked={openRfqSelectedItemIds.has(String(i.id))} onChange={() => toggleItem(String(i.id))} style={{ accentColor: "var(--gold)", marginTop: 2 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="text-xs" style={{ color: "var(--text)" }}>{i.name}{i.model ? <span style={{ color: "var(--text-muted)" }}> ({i.model})</span> : null}</div>
                          <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>Qty {i.qty}{i.mfr ? ` · ${i.mfr}` : ""}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="mt-2">
                    <textarea
                      value={openRfqExtraNotes}
                      onChange={e => setOpenRfqExtraNotes(e.target.value)}
                      placeholder="Optional notes (accessory list, finish, special instructions…)"
                      className="w-full text-xs p-2 rounded"
                      style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)", minHeight: 60, resize: "vertical" }}
                      data-testid="textarea-open-rfq-notes"
                    />
                  </div>
                </div>

                {/* Right: vendor picker */}
                <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <span className="text-xs font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>Send to</span>
                  <div className="flex gap-2 mb-2">
                    <button
                      onClick={() => setOpenRfqVendorMode("existing")}
                      className="text-xs px-3 py-1.5 rounded flex-1 font-semibold transition-all"
                      style={openRfqVendorMode === "existing"
                        ? { background: "var(--gold)", border: "1px solid var(--gold)", color: "#1a1a1a", boxShadow: "0 2px 6px rgba(212,175,55,0.35)" }
                        : { background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-muted)" }}
                      data-testid="button-open-rfq-mode-existing">Existing vendor</button>
                    <button
                      onClick={() => setOpenRfqVendorMode("new")}
                      className="text-xs px-3 py-1.5 rounded flex-1 font-semibold transition-all"
                      style={openRfqVendorMode === "new"
                        ? { background: "var(--gold)", border: "1px solid var(--gold)", color: "#1a1a1a", boxShadow: "0 2px 6px rgba(212,175,55,0.35)" }
                        : { background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text-muted)" }}
                      data-testid="button-open-rfq-mode-new">One-time vendor</button>
                  </div>

                  {openRfqVendorMode === "existing" ? (
                    <>
                      <input
                        value={openRfqVendorSearch}
                        onChange={e => setOpenRfqVendorSearch(e.target.value)}
                        placeholder={openRfqShowAll ? "Search all vendors by name…" : "Search relevant vendors by name…"}
                        className="w-full text-xs p-2 rounded mb-2"
                        style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                        data-testid="input-open-rfq-vendor-search"
                      />
                      <p className="text-[10px] mb-2" style={{ color: "var(--text-muted)" }} data-testid="text-open-rfq-sort-help">
                        Sorted by: previously used → scope-tagged → manufacturer-tagged{openRfqShowAll ? " → other" : ""}.
                      </p>
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer mb-2" style={{ color: "var(--text-secondary)" }}>
                        <input
                          type="checkbox"
                          checked={openRfqShowAll}
                          onChange={() => setOpenRfqShowAll(v => !v)}
                          style={{ accentColor: "var(--gold)" }}
                          data-testid="toggle-open-rfq-show-all"
                        />
                        Show all vendors
                        {!openRfqShowAll && hiddenByRank > 0 && (
                          <span className="text-[10px]" style={{ color: "var(--text-muted)" }} data-testid="text-open-rfq-hidden-count">
                            ({hiddenByRank} hidden)
                          </span>
                        )}
                      </label>
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer mb-2" style={{ color: "var(--text-secondary)" }}>
                        <input
                          type="checkbox"
                          checked={openRfqOnlyDirect}
                          onChange={() => setOpenRfqOnlyDirect(v => !v)}
                          style={{ accentColor: "var(--gold)" }}
                          data-testid="toggle-open-rfq-only-direct"
                        />
                        Manufacturer Direct only
                        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                          ({allVendorsForRfq.filter(v => !!v.manufacturerDirect).length})
                        </span>
                      </label>
                      <div className="overflow-y-auto rounded" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", flex: 1, minHeight: 100 }}>
                        {filteredVendors.length === 0 && <div className="p-3 text-xs" style={{ color: "var(--text-muted)" }}>No vendors match.</div>}
                        {filteredVendors.map(v => {
                          const isChecked = openRfqExistingVendorIds.has(v.id);
                          return (
                            <label
                              key={v.id}
                              className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer"
                              style={{ background: isChecked ? "var(--gold)15" : "transparent", borderBottom: "1px solid var(--border-ds)40", color: isChecked ? "var(--gold)" : "var(--text)" }}
                              data-testid={`row-open-rfq-vendor-${v.id}`}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => setOpenRfqExistingVendorIds(prev => {
                                  const n = new Set(prev);
                                  n.has(v.id) ? n.delete(v.id) : n.add(v.id);
                                  return n;
                                })}
                                style={{ accentColor: "var(--gold)" }}
                                data-testid={`checkbox-open-rfq-vendor-${v.id}`}
                              />
                              <span className="inline-flex items-center gap-1.5">
                                {v.name}
                                {v.manufacturerDirect && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: "rgba(91,141,239,0.15)", color: "#5B8DEF" }} title="Manufacturer Direct" data-testid={`badge-direct-open-rfq-${v.id}`}>DIRECT</span>}
                                {v.category ? <span style={{ color: "var(--text-muted)" }}>· {v.category}</span> : null}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                      {openRfqExistingVendorIds.size > 0 && (
                        <div className="mt-2 p-2 rounded text-[11px] space-y-1" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }} data-testid="preview-open-rfq-targets">
                          <div style={{ color: "var(--text-secondary)", fontWeight: 600 }}>Will send {sendableTargets.length} email{sendableTargets.length === 1 ? "" : "s"}:</div>
                          {sendTargets.map((t, i) => (
                            <div key={i} style={{ color: "var(--text-muted)" }}>
                              <span style={{ color: "var(--text)" }}>{t.vendorName}</span>
                              {": "}
                              {t.emails.length > 0
                                ? <span style={{ color: "#5B8DEF" }}>{t.emails.join(", ")}</span>
                                : <span style={{ color: "#E05252" }}>no contact emails — will be skipped</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <input
                        value={openRfqNewVendorName}
                        onChange={e => setOpenRfqNewVendorName(e.target.value)}
                        placeholder="Vendor name (e.g. Rep Firm XYZ)"
                        className="w-full text-xs p-2 rounded"
                        style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                        data-testid="input-open-rfq-new-vendor-name"
                      />
                      <input
                        type="email"
                        value={openRfqNewVendorEmail}
                        onChange={e => setOpenRfqNewVendorEmail(e.target.value)}
                        placeholder="Email address"
                        className="w-full text-xs p-2 rounded"
                        style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", color: "var(--text)" }}
                        data-testid="input-open-rfq-new-vendor-email"
                      />
                      <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>One-time send — this vendor is not saved to your database.</p>
                    </div>
                  )}
                </div>
              </div>

              <details className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
                <summary className="cursor-pointer">Preview email</summary>
                <div className="mt-2 p-2 rounded text-[11px]" style={{ background: "var(--bg3)" }}>
                  <div className="mb-1"><span style={{ color: "var(--text-muted)" }}>Subject:</span> <span style={{ color: "var(--text)" }}>{subject}</span></div>
                  <pre className="whitespace-pre-wrap" style={{ maxHeight: 200, overflow: "auto" }}>{body}</pre>
                </div>
              </details>

              <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border-ds)" }}>
                {!canSend ? (
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {selectedItems.length} item{selectedItems.length === 1 ? "" : "s"} · pick at least one vendor with an email
                    </span>
                    <button onClick={() => setShowOpenRfq(false)} className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }} data-testid="button-cancel-open-rfq">Cancel</button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                        Click each vendor to download that RFQ draft ({openRfqSentVendorKeys.size}/{sendableTargets.length} sent)
                      </span>
                      <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>{selectedItems.length} item{selectedItems.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {sendableTargets.map((t) => {
                        const sent = openRfqSentVendorKeys.has(t.vendorName);
                        return (
                          <button
                            key={t.vendorName}
                            onClick={() => sendOneVendor(t)}
                            className="text-xs px-3 py-2 rounded flex items-center gap-1.5 font-semibold transition-all"
                            style={sent
                              ? { background: "var(--bg3)", border: "1px solid #2a7a3e", color: "#5fbd7c" }
                              : { background: "var(--gold)", border: "1px solid var(--gold)", color: "#1a1a1a", boxShadow: "0 2px 6px rgba(212,175,55,0.35)" }}
                            data-testid={`button-send-open-rfq-${t.vendorName}`}
                          >
                            {sent ? <span style={{ fontSize: 14 }}>✓</span> : <Send className="w-3 h-3" />}
                            {t.vendorName}
                            {sent && <span className="text-[10px] font-normal opacity-80">(sent — click again to resend)</span>}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] mb-2" style={{ color: "var(--text-muted)" }}>
                      Browsers only allow one email window per click. Click each vendor button to open its email — the page won't navigate away.
                    </p>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => { setOpenRfqSentVendorKeys(new Set()); setShowOpenRfq(false); }} className="text-xs px-4 py-2 rounded" style={{ background: "var(--bg3)", color: "var(--text-secondary)" }} data-testid="button-cancel-open-rfq">
                        {allSent ? "Done" : "Close"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ══════════════════════════════════════════════════
// FEATURE GATE — default export
// ══════════════════════════════════════════════════
export default function EstimatingModulePage() {
  const { hasFeature, isLoading: featuresLoading } = useFeatureAccess();
  const { user } = useAuth();
  const [, navigate] = useLocation();

  if (featuresLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!featuresLoading && !hasFeature("estimating-module")) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-6">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center"
          style={{ background: "var(--gold)15", border: "1px solid var(--gold)30" }}
        >
          <Lock className="w-6 h-6" style={{ color: "var(--gold)" }} />
        </div>
        <h2 className="text-xl font-heading font-semibold" style={{ color: "var(--text)" }}>
          Access Restricted
        </h2>
        <p className="text-sm max-w-xs" style={{ color: "var(--text-dim)" }}>
          You don't have access to the Estimating Module. Contact your administrator to request access.
        </p>
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          Return Home
        </Button>
      </div>
    );
  }

  return <EstimatingModuleInner />;
}
