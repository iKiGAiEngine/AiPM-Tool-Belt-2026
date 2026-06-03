import { useState, useMemo, useCallback, useRef } from "react";
import { BackNav } from "@/components/BackNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { handleAuthError } from "@/lib/handleAuthError";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown, ChevronRight, ChevronLeft, Plus, Trash2, Star,
  Upload, Download, Search, Shield, X, Check, AlertTriangle,
  ExternalLink, FolderOpen, FileText, Package, Tag, Building2,
  Phone, Mail, Globe, Clock, DollarSign, FileWarning, File,
} from "lucide-react";

// ---- Types ----
interface MfrContact { id: number; vendorId: number; name: string | null; role: string | null; email: string | null; phone: string | null; territory: string | null; isPrimary: boolean | null; notes: string | null; }
interface MfrManufacturerRow { id: number; name: string; legalName?: string | null; shortCode?: string | null; aliases?: string[] | null; website?: string | null; primaryContact?: string | null; contactEmail?: string | null; contactPhone?: string | null; address?: string | null; notes?: string | null; scopes?: string[] | null; }
interface MfrProduct { id: number; vendorId: number; model: string | null; description: string | null; csiCode: string | null; listPrice: string | null; unit: string | null; notes: string | null; }
interface MfrPricing { discountTier: string | null; paymentTerms: string | null; notes: string | null; }
interface MfrLogistics { avgLeadTimeDays: number | null; shipsFrom: string | null; freightNotes: string | null; }
interface MfrTaxInfo { ein: string | null; w9OnFile: boolean | null; w9ReceivedDate: string | null; is1099Eligible: boolean | null; taxExempt: boolean | null; exemptionType: string | null; exemptionCertNumber: string | null; nexusStates: string[] | null; taxNotes: string | null; }
interface MfrResaleCert { id: number; vendorId: number; vendorName?: string; state: string; certType: string | null; certNumber: string | null; issueDate: string | null; expirationDate: string | null; sent: boolean | null; dateSent: string | null; contactSentTo: string | null; vendorConfirmed: boolean | null; confirmationDate: string | null; blanket: boolean | null; projectName: string | null; notes: string | null; status: string; }
interface MfrFile { id: number; fileType: string | null; originalName: string | null; mimeType: string | null; sizeBytes: number | null; uploadedBy: string | null; uploadedAt: string; notes: string | null; }
interface MfrVendorSummary { id: number; name: string; legalName?: string | null; shortCode?: string | null; aliases?: string[] | null; website: string | null; tags: string[]; scopes: string[] | null; manufacturerIds: number[] | null; manufacturerDirect: boolean | null; contactCount: number; productCount: number; certCount: number; w9OnFile: boolean; hasExpiredCert: boolean; hasExpiringCert: boolean; }
interface MfrVendorFull extends MfrVendorSummary { notes: string | null; contacts: MfrContact[]; products: MfrProduct[]; pricing: MfrPricing | null; logistics: MfrLogistics | null; taxInfo: MfrTaxInfo | null; certs: MfrResaleCert[]; files: MfrFile[]; }
interface DashboardData { totalVendors: number; w9OnFile: number; w9Missing: number; certsTotal: number; certsSent: number; certsConfirmed: number; certsExpiring: number; certsExpired: number; certsNotSent: number; vendorsNoCerts: { id: number; name: string }[]; }


// Scope tags for contacts. Mirrors ALL_SCOPES in EstimatingModulePage so contacts
// can be tagged with the scope category they cover for RFQ recipient picking.
const CONTACT_SCOPE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "accessories",      label: "Toilet Accessories" },
  { id: "partitions",       label: "Toilet Compartments" },
  { id: "fire_ext",         label: "FEC" },
  { id: "corner_guards",    label: "Wall Protection" },
  { id: "appliances",       label: "Appliances" },
  { id: "lockers",          label: "Lockers" },
  { id: "display_boards",   label: "Visual Displays" },
  { id: "bike_racks",       label: "Bike Racks" },
  { id: "wire_mesh",        label: "Wire Mesh Partitions" },
  { id: "cubicle_curtains", label: "Cubicle Curtains" },
  { id: "med_equipment",    label: "Med Equipment" },
  { id: "expansion_joints", label: "Expansion Joints" },
  { id: "storage_units",    label: "Shelving" },
  { id: "equipment",        label: "Equipment" },
  { id: "entrance_mats",    label: "Entrance Mats" },
  { id: "mailboxes",        label: "Mailbox" },
  { id: "flagpoles",        label: "Flagpole" },
  { id: "knox_box",         label: "Knox Box" },
  { id: "site_furnishing",  label: "Site Furnishing" },
];
const CSI_CODES = ["10 21 00 - Compartments & Cubicles", "10 28 00 - Toilet Accessories", "10 44 00 - Fire Extinguisher Cabinets", "10 51 00 - Lockers", "10 55 00 - Postal Specialties", "10 56 00 - Storage Assemblies", "10 11 00 - Visual Display Units", "10 71 00 - Exterior Protection", "10 73 00 - Protective Covers", "10 75 00 - Flagpoles", "22 40 00 - Plumbing Fixtures", "08 10 00 - Doors & Frames", "Custom"];
const FILE_TYPES = ["W-9", "Resale Cert", "Exemption Cert", "Price Sheet", "Credit App", "Other"];
const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

function certStatusBadge(status: string) {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    not_sent: { label: "NOT SENT", color: "var(--text-dim)", bg: "rgba(93,96,104,0.18)" },
    sent: { label: "SENT", color: "#5B8DEF", bg: "rgba(91,141,239,0.12)" },
    confirmed: { label: "CONFIRMED", color: "#4CAF7D", bg: "rgba(76,175,125,0.12)" },
    expiring: { label: "EXPIRING", color: "var(--gold)", bg: "rgba(201,168,76,0.15)" },
    expired: { label: "EXPIRED", color: "#E05252", bg: "rgba(224,82,82,0.12)" },
  };
  const s = map[status] || map.not_sent;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", padding: "2px 7px", borderRadius: 4, color: s.color, background: s.bg, fontFamily: "monospace" }}>
      {s.label}
    </span>
  );
}

function daysUntil(dateStr: string | null) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((d.getTime() - now.getTime()) / 86400000);
}

function fmtSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ---- Collapsible Section ----
function Section({ title, icon: Icon, count, defaultOpen = true, children }: { title: string; icon?: any; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 16, border: "1px solid var(--border-ds)", borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "var(--bg-card)", cursor: "pointer", border: "none", textAlign: "left" }}
        data-testid={`section-toggle-${title.replace(/\s/g, "-").toLowerCase()}`}
      >
        {open ? <ChevronDown size={15} style={{ color: "var(--gold)", flexShrink: 0 }} /> : <ChevronRight size={15} style={{ color: "var(--text-dim)", flexShrink: 0 }} />}
        {Icon && <Icon size={15} style={{ color: open ? "var(--gold)" : "var(--text-dim)", flexShrink: 0 }} />}
        <span style={{ fontWeight: 600, fontSize: 13, color: open ? "var(--text-primary)" : "var(--text-dim)", flex: 1 }}>{title}</span>
        {count !== undefined && (
          <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "var(--bg-page)", color: "var(--text-dim)", border: "1px solid var(--border-ds)" }}>{count}</span>
        )}
      </button>
      {open && <div style={{ padding: 16, borderTop: "1px solid var(--border-ds)", background: "var(--bg-page)" }}>{children}</div>}
    </div>
  );
}

// ---- Field helpers ----
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)",
  color: "var(--text-primary)", fontSize: 13, width: "100%", boxSizing: "border-box",
};

const textareaStyle: React.CSSProperties = { ...inputStyle, resize: "vertical", minHeight: 72, fontFamily: "inherit" };

function InpText({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
}

function InpTextArea({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <textarea style={textareaStyle} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />;
}

function InpSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <select style={inputStyle} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function InpCheck({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text-primary)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ width: 15, height: 15, accentColor: "var(--gold)" }} />
      {label}
    </label>
  );
}

function Btn({ label, onClick, variant = "default", icon: Icon, disabled, size = "sm" }: { label?: string; onClick?: () => void; variant?: "default" | "gold" | "danger" | "ghost"; icon?: any; disabled?: boolean; size?: "sm" | "xs" }) {
  const colors: Record<string, React.CSSProperties> = {
    default: { background: "var(--bg-card)", border: "1px solid var(--border-ds)", color: "var(--text-primary)" },
    gold: { background: "var(--gold)", border: "1px solid var(--gold)", color: "#0F1114", fontWeight: 700 },
    danger: { background: "rgba(224,82,82,0.12)", border: "1px solid rgba(224,82,82,0.4)", color: "#E05252" },
    ghost: { background: "transparent", border: "none", color: "var(--text-dim)" },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...colors[variant], display: "inline-flex", alignItems: "center", gap: 5,
        padding: size === "xs" ? "3px 8px" : "6px 12px", borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
        fontSize: size === "xs" ? 11 : 12, fontWeight: 600, opacity: disabled ? 0.5 : 1, whiteSpace: "nowrap",
      }}
    >
      {Icon && <Icon size={size === "xs" ? 11 : 13} />}
      {label}
    </button>
  );
}

// ---- Vendor Avatar ----
function VendorAvatar({ name }: { name: string }) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(201,168,76,0.12)", border: "1px solid rgba(201,168,76,0.3)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--gold)" }}>{initials}</span>
    </div>
  );
}

// ---- Tag chip input ----
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [inputVal, setInputVal] = useState("");
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && inputVal.trim()) {
      onChange([...tags, inputVal.trim()]);
      setInputVal("");
    }
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)", minHeight: 38 }}>
      {tags.map((t, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 10, background: "rgba(91,141,239,0.15)", color: "#5B8DEF", fontSize: 12 }}>
          {t}
          <X size={10} style={{ cursor: "pointer" }} onClick={() => onChange(tags.filter((_, j) => j !== i))} />
        </span>
      ))}
      <input
        value={inputVal}
        onChange={(e) => setInputVal(e.target.value)}
        onKeyDown={handleKey}
        placeholder={tags.length === 0 ? "Type and press Enter to add tags" : ""}
        style={{ border: "none", background: "transparent", color: "var(--text-primary)", fontSize: 13, flex: 1, minWidth: 120, outline: "none" }}
      />
    </div>
  );
}

// ---- Scope Tag Picker (multi-select chips from CONTACT_SCOPE_OPTIONS) ----
function ScopeTagPicker({ selected, onChange }: { selected: string[]; onChange: (s: string[]) => void }) {
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter(x => x !== id));
    else onChange([...selected, id]);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)", minHeight: 38 }}>
      {CONTACT_SCOPE_OPTIONS.map(opt => {
        const on = selected.includes(opt.id);
        return (
          <button
            key={opt.id}
            onClick={() => toggle(opt.id)}
            type="button"
            style={{
              padding: "3px 9px", borderRadius: 12, fontSize: 11, cursor: "pointer", fontWeight: 600,
              background: on ? "rgba(91,141,239,0.18)" : "transparent",
              border: on ? "1px solid rgba(91,141,239,0.5)" : "1px solid var(--border-ds)",
              color: on ? "#5B8DEF" : "var(--text-dim)",
            }}
            data-testid={`scope-tag-${opt.id}`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- Manufacturer Tag Picker (searchable multi-select from manufacturers list) ----
function ManufacturerTagPicker({ manufacturers, selectedIds, onChange }: { manufacturers: MfrManufacturerRow[]; selectedIds: number[]; onChange: (ids: number[]) => void }) {
  const [search, setSearch] = useState("");
  const selectedSet = new Set(selectedIds);
  const selectedRows = manufacturers.filter(m => selectedSet.has(m.id));
  const matches = search.trim()
    ? manufacturers.filter(m => !selectedSet.has(m.id) && m.name.toLowerCase().includes(search.toLowerCase())).slice(0, 12)
    : [];
  return (
    <div style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: selectedRows.length > 0 ? 8 : 0 }}>
        {selectedRows.map(m => (
          <span key={m.id} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 10, background: "rgba(201,168,76,0.18)", color: "var(--gold)", fontSize: 12, fontWeight: 600 }}>
            {m.name}
            <X size={11} style={{ cursor: "pointer" }} onClick={() => onChange(selectedIds.filter(id => id !== m.id))} />
          </span>
        ))}
      </div>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search manufacturers to add…"
        style={{ width: "100%", border: "1px solid var(--border-ds)", background: "var(--bg)", color: "var(--text-primary)", fontSize: 12, padding: "6px 8px", borderRadius: 4, outline: "none" }}
        data-testid="input-mfr-tag-search"
      />
      {matches.length > 0 && (
        <div style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", border: "1px solid var(--border-ds)", borderRadius: 4 }}>
          {matches.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange([...selectedIds, m.id]); setSearch(""); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", border: "none", color: "var(--text-primary)", fontSize: 12, cursor: "pointer" }}
              data-testid={`mfr-tag-option-${m.id}`}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Suggested Manufacturers (for Add Vendor flow, based on scope-tag overlap) ----
function SuggestedManufacturersPanel({
  allMfrs,
  vendorScopes,
  selectedIds,
  onAdd,
  onRemove,
}: {
  allMfrs: MfrManufacturerRow[];
  vendorScopes: string[];
  selectedIds: number[];
  onAdd: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  const suggestions = useMemo(() => {
    if (vendorScopes.length === 0) return [];
    const scopeSet = new Set(vendorScopes);
    return allMfrs
      .map(m => {
        const mScopes = m.scopes || [];
        const overlap = mScopes.filter(s => scopeSet.has(s));
        return { mfr: m, overlap };
      })
      .filter(x => x.overlap.length > 0)
      .sort((a, b) => b.overlap.length - a.overlap.length || a.mfr.name.localeCompare(b.mfr.name));
  }, [allMfrs, vendorScopes]);

  if (vendorScopes.length === 0) {
    return (
      <div style={{ padding: 12, borderRadius: 6, border: "1px dashed var(--border-ds)", background: "var(--bg-card)", fontSize: 12, color: "var(--text-dim)", marginBottom: 12 }} data-testid="panel-suggested-mfrs-empty">
        Pick scope tags above to see suggested manufacturers for this vendor.
      </div>
    );
  }

  return (
    <div style={{ padding: 12, borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)", marginBottom: 12 }} data-testid="panel-suggested-mfrs">
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Suggested Manufacturers</span>
        <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim)" }}>{suggestions.length} match{suggestions.length === 1 ? "" : "es"}</span>
      </div>
      {suggestions.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          No manufacturers tagged with these scopes yet. Tag manufacturers in the Manufacturers tab to see them here.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {suggestions.map(({ mfr, overlap }) => {
            const isSelected = selectedIds.includes(mfr.id);
            return (
              <button
                key={mfr.id}
                type="button"
                onClick={() => isSelected ? onRemove(mfr.id) : onAdd(mfr.id)}
                title={`Matches: ${overlap.join(", ")}`}
                style={{
                  padding: "4px 10px",
                  borderRadius: 14,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  background: isSelected ? "rgba(76,175,125,0.15)" : "transparent",
                  border: isSelected ? "1px solid rgba(76,175,125,0.5)" : "1px solid var(--border-ds)",
                  color: isSelected ? "#4CAF7D" : "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                data-testid={`suggested-mfr-${mfr.id}`}
              >
                {isSelected ? "✓ " : "+ "}{mfr.name}
                <span style={{ fontSize: 10, opacity: 0.7 }}>({overlap.length})</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Naming Fields Info Panel (collapsible quick-guide for legal name / short code / aliases) ----
function NamingFieldsInfoPanel({ storageKey, kind }: { storageKey: string; kind: "vendor" | "manufacturer" }) {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    const seen = window.localStorage.getItem(storageKey);
    return seen !== "1"; // default open the first time, collapsed thereafter
  });
  const toggle = () => {
    setOpen(o => {
      const next = !o;
      try { window.localStorage.setItem(storageKey, "1"); } catch {}
      return next;
    });
  };
  const subject = kind === "vendor" ? "vendor" : "manufacturer";
  return (
    <div style={{ border: "1px solid var(--gold)", borderRadius: 8, background: "rgba(201,168,76,0.06)", marginBottom: 12 }} data-testid={`info-naming-${kind}`}>
      <button
        type="button"
        onClick={toggle}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left" }}
        data-testid={`button-toggle-naming-info-${kind}`}
      >
        <span style={{ fontSize: 16 }}>📘</span>
        <span style={{ flex: 1, fontFamily: "var(--font-heading)", fontSize: 13, fontWeight: 700, color: "var(--gold)", letterSpacing: "0.02em" }}>Naming Fields — Quick Guide</span>
        {open ? <ChevronDown size={14} color="var(--gold)" /> : <ChevronRight size={14} color="var(--gold)" />}
      </button>
      {open && (
        <div style={{ padding: "0 14px 14px 14px", fontFamily: "var(--font-body)", fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          <p style={{ margin: "0 0 10px 0" }}>Each {subject} has three name fields. They serve different jobs, so fill all three out:</p>
          <p style={{ margin: "0 0 6px 0" }}><strong style={{ color: "var(--text-primary)" }}>Legal Name</strong> — The full official company name.<br/>Example: <em>Pacific Building Specialties, Inc.</em><br/>Used on formal documents like proposals, contracts, and POs.</p>
          <p style={{ margin: "10px 0 6px 0" }}><strong style={{ color: "var(--text-primary)" }}>Short Code</strong> — The abbreviation your team uses day-to-day. Pick one and stick with it.<br/>Example: <em>PBS</em><br/>Used automatically in RFQ subject lines, file names, dashboards, and dropdowns.</p>
          <p style={{ margin: "10px 0 6px 0" }}><strong style={{ color: "var(--text-primary)" }}>Aliases</strong> — Every other way this {subject} might show up in emails, bid invites, or quotes. Add as many as you need.<br/>Example: <em>Pacific Bldg Specialties, Pac Building, PacBuilding Spec</em><br/>Used behind the scenes to match incoming emails and bid invites back to the right {subject} — even when the sender spells the name differently.</p>
          <p style={{ margin: "10px 0 4px 0", color: "var(--text-primary)", fontWeight: 600 }}>Rule of thumb:</p>
          <ul style={{ margin: "0 0 8px 18px", padding: 0 }}>
            <li>Short Code = what <em>we</em> write</li>
            <li>Aliases = what <em>they</em> might write</li>
          </ul>
          <p style={{ margin: 0, fontStyle: "italic", color: "var(--text-dim)" }}>Always include the legal name and short code in the aliases list too, so matching catches every variation.</p>
        </div>
      )}
    </div>
  );
}

// ---- Alias Chip Input (free-form text → chips on Enter/comma; click × to remove) ----
function AliasChipInput({ aliases, onChange, testId }: { aliases: string[]; onChange: (a: string[]) => void; testId?: string }) {
  const [draft, setDraft] = useState("");
  const commit = (raw: string) => {
    const cleaned = raw.split(",").map(s => s.trim()).filter(s => s.length > 0);
    if (cleaned.length === 0) return;
    const next = [...aliases];
    for (const a of cleaned) {
      if (!next.some(x => x.toLowerCase() === a.toLowerCase())) next.push(a);
    }
    onChange(next);
    setDraft("");
  };
  const removeAt = (idx: number) => {
    const next = aliases.slice();
    next.splice(idx, 1);
    onChange(next);
  };
  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 8px", border: "1px solid var(--border-ds)", borderRadius: 6, background: "var(--bg-card)", minHeight: 36, alignItems: "center" }}
      onClick={(e) => {
        const input = (e.currentTarget.querySelector("input") as HTMLInputElement | null);
        input?.focus();
      }}
      data-testid={testId || "alias-chip-input"}
    >
      {aliases.map((a, i) => (
        <span key={`${a}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 12, background: "rgba(201,168,76,0.14)", border: "1px solid var(--gold)", color: "var(--text-primary)", fontSize: 11, fontFamily: "var(--font-body)" }} data-testid={`chip-alias-${i}`}>
          {a}
          <button type="button" onClick={(e) => { e.stopPropagation(); removeAt(i); }} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", padding: 0, display: "flex" }} data-testid={`button-remove-alias-${i}`} aria-label={`Remove ${a}`}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) {
            commit(v.slice(0, -1));
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (draft.trim()) commit(draft);
          } else if (e.key === "Backspace" && draft === "" && aliases.length > 0) {
            removeAt(aliases.length - 1);
          }
        }}
        onBlur={() => { if (draft.trim()) commit(draft); }}
        placeholder={aliases.length === 0 ? "Type an alias and press Enter or comma…" : ""}
        style={{ flex: 1, minWidth: 140, border: "none", outline: "none", background: "transparent", color: "var(--text-primary)", fontSize: 12, fontFamily: "var(--font-body)", padding: "2px 0" }}
        data-testid="input-alias-draft"
      />
    </div>
  );
}

// ---- Excel Upload Modal ----
type UploadType = "manufacturers" | "vendors";

const UPLOAD_CONFIG: Record<UploadType, {
  title: string;
  description: string;
  endpoint: string;
  sheetHint: string;
}> = {
  manufacturers: {
    title: "Upload NBS Manufacturer List",
    description: 'Upload your NBS Manufacturer List (.xlsx). Expected sheet: "Manufacturers" with columns: short_code, name, legal_name, aliases, scopes, website, primary_contact, contact_email, contact_phone, address, notes. Existing records are updated by short_code.',
    endpoint: "/api/mfr/upload-manufacturers-excel",
    sheetHint: 'Sheet: "Manufacturers"',
  },
  vendors: {
    title: "Upload NBS Vendor List",
    description: 'Upload your NBS Vendor List (.xlsx). Expected sheets: "Vendors" (main data), "Additional Contacts" (extra contacts), and "Logistics & Pricing" (lead times, discount tiers). Existing records are updated by short_code.',
    endpoint: "/api/mfr/upload-vendors-excel",
    sheetHint: 'Sheets: "Vendors", "Additional Contacts", "Logistics & Pricing"',
  },
};

function ResultStat({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || "var(--gold)" }}>{value}</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</div>
    </div>
  );
}

function ExcelUploadModal({ type, onClose, onSuccess }: { type: UploadType; onClose: () => void; onSuccess: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const cfg = UPLOAD_CONFIG[type];

  const handleFile = (f: File) => {
    if (f.name.match(/\.(xlsx|xls)$/i)) setFile(f);
    else toast({ title: "Invalid file", description: "Please upload an .xlsx or .xls file", variant: "destructive" });
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(cfg.endpoint, { method: "POST", body: form, credentials: "include" });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        console.error("Non-JSON response from upload:", text.slice(0, 500));
        throw new Error(`Server returned unexpected response (status ${res.status}). Check console for details.`);
      }
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setResult(data);
      onSuccess();
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderRadius: 12, padding: 28, width: 500, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>{cfg.title}</h2>
          <X size={18} style={{ cursor: "pointer", color: "var(--text-dim)" }} onClick={onClose} />
        </div>
        <p style={{ fontSize: 12, color: "var(--text-dim)", marginBottom: 4, lineHeight: 1.5 }}>{cfg.description}</p>
        <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 12, fontStyle: "italic" }}>{cfg.sheetHint}</p>

        {!result ? (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              onClick={() => fileRef.current?.click()}
              style={{ border: `2px dashed ${dragging ? "var(--gold)" : "var(--border-ds)"}`, borderRadius: 8, padding: "32px 20px", textAlign: "center", cursor: "pointer", marginBottom: 16, transition: "border-color 0.2s", background: dragging ? "rgba(201,168,76,0.05)" : "transparent" }}
            >
              <Upload size={28} style={{ color: "var(--text-dim)", marginBottom: 8 }} />
              <p style={{ fontSize: 13, color: "var(--text-dim)" }}>{file ? file.name : "Drag & drop or click to select .xlsx / .xls"}</p>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Btn label="Cancel" onClick={onClose} />
              <Btn label={loading ? "Uploading…" : "Upload & Import"} variant="gold" onClick={handleUpload} disabled={!file || loading} icon={Upload} />
            </div>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <Check size={40} style={{ color: "#4CAF7D", margin: "0 auto 12px" }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 16 }}>Import Complete</p>
            <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap", marginBottom: 20 }}>
              {type === "manufacturers" ? (
                <>
                  <ResultStat value={result.manufacturersCreated ?? 0} label="Created" color="var(--gold)" />
                  <ResultStat value={result.manufacturersUpdated ?? 0} label="Updated" color="#4CAF7D" />
                </>
              ) : (
                <>
                  <ResultStat value={result.vendorsCreated ?? 0} label="Vendors Created" color="var(--gold)" />
                  <ResultStat value={result.vendorsUpdated ?? 0} label="Vendors Updated" color="#4CAF7D" />
                  <ResultStat value={result.contactsCreated ?? 0} label="Contacts Added" color="#5B8DEF" />
                  <ResultStat value={result.manufacturerLinksCreated ?? 0} label="Mfr Links" color="var(--text-dim)" />
                </>
              )}
            </div>
            <Btn label="Close" variant="gold" onClick={onClose} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Vendor Detail ----
function VendorDetail({ vendorId, onBack, qc }: { vendorId: number; onBack: () => void; qc: any }) {
  const { toast } = useToast();
  const { data: vendor, isLoading } = useQuery<MfrVendorFull>({
    queryKey: ["/api/mfr/vendors", vendorId],
    queryFn: async () => {
      const r = await fetch(`/api/mfr/vendors/${vendorId}`, { credentials: "include" });
      if (!r.ok) throw new Error(r.status === 401 ? "Session expired — please log in again." : `Failed to load vendor (${r.status})`);
      const v = await r.json();
      if (!v || typeof v !== "object" || !v.id) throw new Error("Vendor not found");
      // Coerce nested collections to arrays so downstream rendering is safe
      return {
        ...v,
        contacts: Array.isArray(v.contacts) ? v.contacts : [],
        products: Array.isArray(v.products) ? v.products : [],
        certs: Array.isArray(v.certs) ? v.certs : [],
        files: Array.isArray(v.files) ? v.files : [],
        tags: Array.isArray(v.tags) ? v.tags : [],
      };
    },
  });

  const [form, setForm] = useState({ name: "", legalName: "", shortCode: "", aliases: [] as string[], website: "", notes: "", tags: [] as string[], scopes: [] as string[], manufacturerIds: [] as number[], manufacturerDirect: false });
  const [pricingForm, setPricingForm] = useState({ discountTier: "", paymentTerms: "", notes: "" });
  const [logisticsForm, setLogisticsForm] = useState({ avgLeadTimeDays: "", shipsFrom: "", freightNotes: "" });
  const [taxForm, setTaxForm] = useState({ ein: "", w9OnFile: false, w9ReceivedDate: "", is1099Eligible: false, taxExempt: false, exemptionType: "", exemptionCertNumber: "", nexusStates: [] as string[], taxNotes: "" });
  const [initialized, setInitialized] = useState(false);
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);
  const [productForms, setProductForms] = useState<Record<number, MfrProduct>>({});
  const [newContact, setNewContact] = useState<{ name: string; role: string; email: string; phone: string; territory: string; isPrimary: boolean; notes: string }>({ name: "", role: "", email: "", phone: "", territory: "", isPrimary: false, notes: "" });
  const [showAddContact, setShowAddContact] = useState(false);
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [editContact, setEditContact] = useState<{ name: string; role: string; email: string; phone: string; territory: string; isPrimary: boolean; notes: string }>({ name: "", role: "", email: "", phone: "", territory: "", isPrimary: false, notes: "" });
  const { data: allMfrs = [] } = useQuery<MfrManufacturerRow[]>({ queryKey: ["/api/mfr/manufacturers"] });
  const [newProduct, setNewProduct] = useState({ model: "", description: "", csiCode: "", listPrice: "", unit: "", notes: "" });
  const [showAddProduct, setShowAddProduct] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileType, setFileType] = useState("Other");
  const [uploadingFile, setUploadingFile] = useState(false);

  useMemo(() => {
    if (vendor && !initialized) {
      setForm({ name: vendor.name, legalName: vendor.legalName || vendor.name || "", shortCode: vendor.shortCode || "", aliases: vendor.aliases || [], website: vendor.website || "", notes: vendor.notes || "", tags: vendor.tags || [], scopes: vendor.scopes || [], manufacturerIds: vendor.manufacturerIds || [], manufacturerDirect: !!vendor.manufacturerDirect });
      setPricingForm({ discountTier: vendor.pricing?.discountTier || "", paymentTerms: vendor.pricing?.paymentTerms || "", notes: vendor.pricing?.notes || "" });
      setLogisticsForm({ avgLeadTimeDays: String(vendor.logistics?.avgLeadTimeDays || ""), shipsFrom: vendor.logistics?.shipsFrom || "", freightNotes: vendor.logistics?.freightNotes || "" });
      setTaxForm({ ein: vendor.taxInfo?.ein || "", w9OnFile: !!vendor.taxInfo?.w9OnFile, w9ReceivedDate: vendor.taxInfo?.w9ReceivedDate || "", is1099Eligible: !!vendor.taxInfo?.is1099Eligible, taxExempt: !!vendor.taxInfo?.taxExempt, exemptionType: vendor.taxInfo?.exemptionType || "", exemptionCertNumber: vendor.taxInfo?.exemptionCertNumber || "", nexusStates: vendor.taxInfo?.nexusStates || [], taxNotes: vendor.taxInfo?.taxNotes || "" });
      setInitialized(true);
    }
  }, [vendor, initialized]);

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["/api/mfr/vendors"] }); qc.invalidateQueries({ queryKey: ["/api/mfr/vendors", vendorId] }); };

  const saveGeneral = async () => {
    try {
      await apiRequest("PUT", `/api/mfr/vendors/${vendorId}`, form);
      invalidate();
      toast({ title: "Saved", description: "Vendor info updated" });
    } catch { toast({ title: "Save failed", variant: "destructive" }); }
  };

  const savePricing = async () => {
    try { await apiRequest("PUT", `/api/mfr/vendors/${vendorId}/pricing`, pricingForm); invalidate(); toast({ title: "Pricing saved" }); } catch { toast({ title: "Save failed", variant: "destructive" }); }
  };
  const saveLogistics = async () => {
    const payload = { ...logisticsForm, avgLeadTimeDays: logisticsForm.avgLeadTimeDays ? Number(logisticsForm.avgLeadTimeDays) : null };
    try { await apiRequest("PUT", `/api/mfr/vendors/${vendorId}/logistics`, payload); invalidate(); toast({ title: "Logistics saved" }); } catch { toast({ title: "Save failed", variant: "destructive" }); }
  };
  const saveTax = async () => {
    try { await apiRequest("PUT", `/api/mfr/vendors/${vendorId}/tax`, taxForm); invalidate(); toast({ title: "Tax info saved" }); } catch { toast({ title: "Save failed", variant: "destructive" }); }
  };

  const [savingAll, setSavingAll] = useState(false);
  const saveAll = async () => {
    setSavingAll(true);
    try {
      const logisticsPayload = { ...logisticsForm, avgLeadTimeDays: logisticsForm.avgLeadTimeDays ? Number(logisticsForm.avgLeadTimeDays) : null };
      await Promise.all([
        apiRequest("PUT", `/api/mfr/vendors/${vendorId}`, form),
        apiRequest("PUT", `/api/mfr/vendors/${vendorId}/pricing`, pricingForm),
        apiRequest("PUT", `/api/mfr/vendors/${vendorId}/logistics`, logisticsPayload),
        apiRequest("PUT", `/api/mfr/vendors/${vendorId}/tax`, taxForm),
      ]);
      invalidate();
      toast({ title: "All changes saved", description: "General info, pricing, logistics, and tax info updated" });
    } catch {
      toast({ title: "Save failed", description: "Some sections may not have saved — please try again", variant: "destructive" });
    } finally {
      setSavingAll(false);
    }
  };

  const addContact = async () => {
    try { await apiRequest("POST", `/api/mfr/vendors/${vendorId}/contacts`, newContact); invalidate(); setShowAddContact(false); setNewContact({ name: "", role: "", email: "", phone: "", territory: "", isPrimary: false, notes: "" }); toast({ title: "Contact added" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };
  const deleteContact = async (cid: number) => {
    if (!confirm("Delete this contact?")) return;
    try { await apiRequest("DELETE", `/api/mfr/vendors/${vendorId}/contacts/${cid}`, undefined); invalidate(); toast({ title: "Contact deleted" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };
  const togglePrimary = async (contact: MfrContact) => {
    try { await apiRequest("PUT", `/api/mfr/vendors/${vendorId}/contacts/${contact.id}`, { ...contact, isPrimary: true }); invalidate(); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };
  const startEditContact = (c: MfrContact) => {
    setEditingContactId(c.id);
    setEditContact({
      name: c.name || "", role: c.role || "", email: c.email || "", phone: c.phone || "",
      territory: c.territory || "", isPrimary: !!c.isPrimary, notes: c.notes || "",
    });
  };
  const saveEditContact = async () => {
    if (editingContactId == null) return;
    try {
      await apiRequest("PUT", `/api/mfr/vendors/${vendorId}/contacts/${editingContactId}`, editContact);
      invalidate();
      setEditingContactId(null);
      toast({ title: "Contact updated" });
    } catch { toast({ title: "Save failed", variant: "destructive" }); }
  };

  const addProduct = async () => {
    try { await apiRequest("POST", `/api/mfr/vendors/${vendorId}/products`, newProduct); invalidate(); setShowAddProduct(false); setNewProduct({ model: "", description: "", csiCode: "", listPrice: "", unit: "", notes: "" }); toast({ title: "Product added" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };
  const saveProduct = async (p: MfrProduct) => {
    const updated = productForms[p.id] || p;
    try { await apiRequest("PUT", `/api/mfr/vendors/${vendorId}/products/${p.id}`, updated); invalidate(); setExpandedProduct(null); toast({ title: "Product saved" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };
  const deleteProduct = async (pid: number) => {
    if (!confirm("Delete this product?")) return;
    try { await apiRequest("DELETE", `/api/mfr/vendors/${vendorId}/products/${pid}`, undefined); invalidate(); toast({ title: "Product deleted" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const uploadFile = async (f: File) => {
    setUploadingFile(true);
    try {
      const form = new FormData();
      form.append("file", f);
      form.append("fileType", fileType);
      const res = await fetch(`/api/mfr/vendors/${vendorId}/files`, { method: "POST", body: form, credentials: "include" });
      if (!res.ok) throw new Error("Upload failed");
      invalidate();
      toast({ title: "File uploaded" });
    } catch { toast({ title: "Upload failed", variant: "destructive" }); }
    finally { setUploadingFile(false); }
  };

  const deleteFile = async (fid: number) => {
    if (!confirm("Delete this file?")) return;
    try { await apiRequest("DELETE", `/api/mfr/files/${fid}`, undefined); invalidate(); toast({ title: "File deleted" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const deleteVendor = async () => {
    if (!confirm(`Delete "${vendor?.name}"? This cannot be undone.`)) return;
    try { await apiRequest("DELETE", `/api/mfr/vendors/${vendorId}`, undefined); qc.invalidateQueries({ queryKey: ["/api/mfr/vendors"] }); onBack(); toast({ title: "Vendor deleted" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  if (isLoading) return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)" }}>Loading…</div>;
  if (!vendor) return <div style={{ padding: 40, textAlign: "center", color: "#E05252" }}>Vendor not found.</div>;

  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
  const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 0 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)", color: "var(--text-dim)", cursor: "pointer", fontSize: 12 }} data-testid="button-back-vendor">
          <ChevronLeft size={14} /> Back
        </button>
        <div style={{ flex: 1, fontSize: 18, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-heading)" }}>{vendor.name}</div>
        <Btn label={savingAll ? "Saving…" : "Save All Changes"} variant="gold" onClick={saveAll} />
        <Btn label="Delete Vendor" variant="danger" icon={Trash2} onClick={deleteVendor} />
      </div>

      {/* General Info */}
      <Section title="General Info" icon={Building2}>
        <NamingFieldsInfoPanel storageKey="aipm.naming-info-seen.vendor-edit" kind="vendor" />
        <div style={grid2}>
          <Field label="Display Name"><InpText value={form.name} onChange={(v) => setForm({ ...form, name: v })} /></Field>
          <Field label="Legal Name"><InpText value={form.legalName} onChange={(v) => setForm({ ...form, legalName: v })} placeholder="Pacific Building Specialties, Inc." /></Field>
          <Field label="Short Code"><InpText value={form.shortCode} onChange={(v) => setForm({ ...form, shortCode: v.toUpperCase().slice(0, 10) })} placeholder="e.g. PBS" /></Field>
          <Field label="Website"><InpText value={form.website} onChange={(v) => setForm({ ...form, website: v })} placeholder="https://" /></Field>
          <Field label="Tags"><TagInput tags={form.tags} onChange={(t) => setForm({ ...form, tags: t })} /></Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Aliases (alternate names this vendor may appear as in incoming emails or bid invites)">
            <AliasChipInput aliases={form.aliases} onChange={(a) => setForm({ ...form, aliases: a })} testId="input-vendor-aliases" />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Scope Tags (which scope categories this vendor covers)">
            <ScopeTagPicker selected={form.scopes} onChange={(s) => setForm({ ...form, scopes: s })} />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Manufacturer Tags (which manufacturers this vendor reps — beyond their own brand)">
            <ManufacturerTagPicker manufacturers={allMfrs} selectedIds={form.manufacturerIds} onChange={(ids) => setForm({ ...form, manufacturerIds: ids })} />
          </Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label=""><InpCheck label="Manufacturer Direct (vendor sells direct from manufacturer)" checked={form.manufacturerDirect} onChange={(v) => setForm({ ...form, manufacturerDirect: v })} /></Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Notes"><InpTextArea value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} /></Field>
        </div>
      </Section>

      {/* Contacts */}
      <Section title="Contacts" icon={Phone} count={(vendor.contacts ?? []).length}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(vendor.contacts ?? []).map((c) => editingContactId === c.id ? (
            <div key={c.id} style={{ padding: 14, borderRadius: 8, border: "1px solid var(--gold)", background: "var(--bg-card)" }} data-testid={`edit-contact-${c.id}`}>
              <div style={grid2}>
                <Field label="Name"><InpText value={editContact.name} onChange={(v) => setEditContact({ ...editContact, name: v })} /></Field>
                <Field label="Role / Title"><InpText value={editContact.role} onChange={(v) => setEditContact({ ...editContact, role: v })} /></Field>
                <Field label="Email"><InpText value={editContact.email} onChange={(v) => setEditContact({ ...editContact, email: v })} /></Field>
                <Field label="Phone"><InpText value={editContact.phone} onChange={(v) => setEditContact({ ...editContact, phone: v })} /></Field>
                <Field label="Territory"><InpText value={editContact.territory} onChange={(v) => setEditContact({ ...editContact, territory: v })} /></Field>
                <Field label=""><InpCheck label="Primary contact" checked={editContact.isPrimary} onChange={(v) => setEditContact({ ...editContact, isPrimary: v })} /></Field>
              </div>
              <div style={{ marginTop: 10 }}><Field label="Notes"><InpText value={editContact.notes} onChange={(v) => setEditContact({ ...editContact, notes: v })} /></Field></div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <Btn label="Cancel" onClick={() => setEditingContactId(null)} />
                <Btn label="Save Contact" variant="gold" onClick={saveEditContact} />
              </div>
            </div>
          ) : (
            <div key={c.id} style={{ padding: "12px 14px", borderRadius: 8, border: `1px solid ${c.isPrimary ? "rgba(201,168,76,0.4)" : "var(--border-ds)"}`, background: c.isPrimary ? "rgba(201,168,76,0.05)" : "var(--bg-card)", display: "flex", gap: 12, alignItems: "flex-start" }} data-testid={`card-contact-${c.id}`}>
              <button onClick={() => togglePrimary(c)} title="Set as primary" style={{ background: "none", border: "none", cursor: "pointer", padding: 0, flexShrink: 0 }}>
                <Star size={15} style={{ color: c.isPrimary ? "var(--gold)" : "var(--border-ds)", fill: c.isPrimary ? "var(--gold)" : "none" }} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>{c.name}</span>
                  {c.isPrimary && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 4, background: "rgba(201,168,76,0.2)", color: "var(--gold)" }}>PRIMARY</span>}
                  {c.role && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.role}</span>}
                </div>
                <div style={{ display: "flex", gap: 14, marginTop: 4, flexWrap: "wrap" }}>
                  {c.email && <span style={{ fontSize: 12, color: "#5B8DEF", display: "flex", alignItems: "center", gap: 4 }}><Mail size={11} />{c.email}</span>}
                  {c.phone && <span style={{ fontSize: 12, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4 }}><Phone size={11} />{c.phone}</span>}
                  {c.territory && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Territory: {c.territory}</span>}
                </div>
                {c.notes && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>{c.notes}</div>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <Btn variant="ghost" label="Edit" onClick={() => startEditContact(c)} size="xs" />
                <Btn variant="danger" icon={Trash2} onClick={() => deleteContact(c.id)} size="xs" />
              </div>
            </div>
          ))}
          {showAddContact ? (
            <div style={{ padding: 14, borderRadius: 8, border: "1px solid var(--border-ds)", background: "var(--bg-card)" }}>
              <div style={grid2}>
                <Field label="Name"><InpText value={newContact.name} onChange={(v) => setNewContact({ ...newContact, name: v })} /></Field>
                <Field label="Role / Title"><InpText value={newContact.role} onChange={(v) => setNewContact({ ...newContact, role: v })} /></Field>
                <Field label="Email"><InpText value={newContact.email} onChange={(v) => setNewContact({ ...newContact, email: v })} /></Field>
                <Field label="Phone"><InpText value={newContact.phone} onChange={(v) => setNewContact({ ...newContact, phone: v })} /></Field>
                <Field label="Territory"><InpText value={newContact.territory} onChange={(v) => setNewContact({ ...newContact, territory: v })} /></Field>
                <Field label=""><InpCheck label="Primary contact" checked={newContact.isPrimary} onChange={(v) => setNewContact({ ...newContact, isPrimary: v })} /></Field>
              </div>
              <div style={{ marginTop: 10 }}><Field label="Notes"><InpText value={newContact.notes} onChange={(v) => setNewContact({ ...newContact, notes: v })} /></Field></div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <Btn label="Cancel" onClick={() => setShowAddContact(false)} />
                <Btn label="Add Contact" variant="gold" onClick={addContact} />
              </div>
            </div>
          ) : (
            <Btn label="Add Contact" icon={Plus} onClick={() => setShowAddContact(true)} />
          )}
        </div>
      </Section>

      {/* Products */}
      <Section title="Products & Models" icon={Package} count={(vendor.products ?? []).length}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(vendor.products ?? []).map((p) => {
            const isExpanded = expandedProduct === p.id;
            const pf = productForms[p.id] || p;
            const setpf = (v: Partial<MfrProduct>) => setProductForms({ ...productForms, [p.id]: { ...pf, ...v } as MfrProduct });
            return (
              <div key={p.id} style={{ borderRadius: 8, border: "1px solid var(--border-ds)", overflow: "hidden" }} data-testid={`card-product-${p.id}`}>
                <div onClick={() => setExpandedProduct(isExpanded ? null : p.id)} style={{ padding: "10px 14px", display: "flex", gap: 12, alignItems: "center", cursor: "pointer", background: "var(--bg-card)" }}>
                  {isExpanded ? <ChevronDown size={13} style={{ color: "var(--gold)" }} /> : <ChevronRight size={13} style={{ color: "var(--text-dim)" }} />}
                  <span style={{ fontFamily: "monospace", fontSize: 13, color: "var(--gold)", fontWeight: 700, minWidth: 100 }}>{p.model || "—"}</span>
                  <span style={{ fontSize: 12, color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description || ""}</span>
                  {p.csiCode && <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(91,141,239,0.12)", color: "#5B8DEF", fontFamily: "monospace", whiteSpace: "nowrap" }}>{p.csiCode}</span>}
                  {p.listPrice && <span style={{ fontSize: 12, color: "#4CAF7D", fontFamily: "monospace", whiteSpace: "nowrap" }}>{p.listPrice}</span>}
                </div>
                {isExpanded && (
                  <div style={{ padding: 14, borderTop: "1px solid var(--border-ds)", background: "var(--bg-page)" }}>
                    <div style={grid2}>
                      <Field label="Model #"><InpText value={pf.model || ""} onChange={(v) => setpf({ model: v })} /></Field>
                      <Field label="CSI Code"><InpSelect value={pf.csiCode || ""} onChange={(v) => setpf({ csiCode: v })} options={CSI_CODES} /></Field>
                      <Field label="List Price"><InpText value={pf.listPrice || ""} onChange={(v) => setpf({ listPrice: v })} placeholder="$0.00" /></Field>
                      <Field label="Unit"><InpText value={pf.unit || ""} onChange={(v) => setpf({ unit: v })} placeholder="EA, LF, SF…" /></Field>
                    </div>
                    <div style={{ marginTop: 10 }}><Field label="Description"><InpText value={pf.description || ""} onChange={(v) => setpf({ description: v })} /></Field></div>
                    <div style={{ marginTop: 10 }}><Field label="Notes"><InpText value={pf.notes || ""} onChange={(v) => setpf({ notes: v })} /></Field></div>
                    <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                      <Btn label="Delete" variant="danger" icon={Trash2} onClick={() => deleteProduct(p.id)} size="xs" />
                      <Btn label="Save" variant="gold" onClick={() => saveProduct(p)} size="xs" />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {showAddProduct ? (
            <div style={{ padding: 14, borderRadius: 8, border: "1px solid var(--border-ds)", background: "var(--bg-card)" }}>
              <div style={grid2}>
                <Field label="Model #"><InpText value={newProduct.model} onChange={(v) => setNewProduct({ ...newProduct, model: v })} /></Field>
                <Field label="CSI Code"><InpSelect value={newProduct.csiCode} onChange={(v) => setNewProduct({ ...newProduct, csiCode: v })} options={CSI_CODES} /></Field>
                <Field label="List Price"><InpText value={newProduct.listPrice} onChange={(v) => setNewProduct({ ...newProduct, listPrice: v })} placeholder="$0.00" /></Field>
                <Field label="Unit"><InpText value={newProduct.unit} onChange={(v) => setNewProduct({ ...newProduct, unit: v })} placeholder="EA, LF, SF…" /></Field>
              </div>
              <div style={{ marginTop: 10 }}><Field label="Description"><InpText value={newProduct.description} onChange={(v) => setNewProduct({ ...newProduct, description: v })} /></Field></div>
              <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                <Btn label="Cancel" onClick={() => setShowAddProduct(false)} />
                <Btn label="Add Product" variant="gold" onClick={addProduct} />
              </div>
            </div>
          ) : (
            <Btn label="Add Product" icon={Plus} onClick={() => setShowAddProduct(true)} />
          )}
        </div>
      </Section>

      {/* Pricing */}
      <Section title="Pricing & Terms" icon={DollarSign}>
        <div style={grid2}>
          <Field label="Discount Tier / Multiplier"><InpText value={pricingForm.discountTier} onChange={(v) => setPricingForm({ ...pricingForm, discountTier: v })} placeholder="e.g. 40% off list" /></Field>
          <Field label="Payment Terms"><InpText value={pricingForm.paymentTerms} onChange={(v) => setPricingForm({ ...pricingForm, paymentTerms: v })} placeholder="Net 30, COD…" /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Field label="Pricing Notes"><InpTextArea value={pricingForm.notes} onChange={(v) => setPricingForm({ ...pricingForm, notes: v })} /></Field></div>
      </Section>

      {/* Logistics */}
      <Section title="Lead Times & Shipping" icon={Clock}>
        <div style={grid3}>
          <Field label="Avg Lead Time (days)"><InpText value={logisticsForm.avgLeadTimeDays} onChange={(v) => setLogisticsForm({ ...logisticsForm, avgLeadTimeDays: v })} placeholder="21" /></Field>
          <Field label="Ships From"><InpText value={logisticsForm.shipsFrom} onChange={(v) => setLogisticsForm({ ...logisticsForm, shipsFrom: v })} placeholder="City, ST" /></Field>
        </div>
        <div style={{ marginTop: 12 }}><Field label="Freight / Shipping Notes"><InpTextArea value={logisticsForm.freightNotes} onChange={(v) => setLogisticsForm({ ...logisticsForm, freightNotes: v })} /></Field></div>
      </Section>

      {/* Tax */}
      <Section title="Tax & Compliance (Summary)" icon={FileWarning} defaultOpen={false}>
        <div style={grid3}>
          <Field label="EIN"><InpText value={taxForm.ein} onChange={(v) => setTaxForm({ ...taxForm, ein: v })} placeholder="XX-XXXXXXX" /></Field>
          <Field label="W-9 On File"><InpCheck label="W-9 on file" checked={taxForm.w9OnFile} onChange={(v) => setTaxForm({ ...taxForm, w9OnFile: v })} /></Field>
          <Field label="W-9 Received Date"><InpText value={taxForm.w9ReceivedDate} onChange={(v) => setTaxForm({ ...taxForm, w9ReceivedDate: v })} placeholder="YYYY-MM-DD" /></Field>
          <Field label=""><InpCheck label="1099 Eligible" checked={taxForm.is1099Eligible} onChange={(v) => setTaxForm({ ...taxForm, is1099Eligible: v })} /></Field>
          <Field label=""><InpCheck label="Tax Exempt" checked={taxForm.taxExempt} onChange={(v) => setTaxForm({ ...taxForm, taxExempt: v })} /></Field>
        </div>
        {taxForm.taxExempt && (
          <div style={{ ...grid2, marginTop: 12 }}>
            <Field label="Exemption Type"><InpText value={taxForm.exemptionType} onChange={(v) => setTaxForm({ ...taxForm, exemptionType: v })} /></Field>
            <Field label="Cert Number"><InpText value={taxForm.exemptionCertNumber} onChange={(v) => setTaxForm({ ...taxForm, exemptionCertNumber: v })} /></Field>
          </div>
        )}
        <div style={{ marginTop: 12 }}><Field label="Tax Notes"><InpTextArea value={taxForm.taxNotes} onChange={(v) => setTaxForm({ ...taxForm, taxNotes: v })} /></Field></div>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)" }}>
          {(vendor.certs ?? []).length} resale cert{(vendor.certs ?? []).length !== 1 ? "s" : ""} on file. Use the <span style={{ color: "var(--gold)", cursor: "pointer" }}>Certificate Tracker</span> tab for full cert management.
        </div>
      </Section>

      {/* Files */}
      <Section title="Files & Documents" icon={FileText} count={(vendor.files ?? []).length}>
        <div style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center" }}>
          <select style={{ ...inputStyle, width: "auto" }} value={fileType} onChange={(e) => setFileType(e.target.value)}>
            {FILE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <Btn label={uploadingFile ? "Uploading…" : "Upload File"} icon={Upload} onClick={() => fileInputRef.current?.click()} disabled={uploadingFile} />
          <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }} />
        </div>
        {(vendor.files ?? []).length === 0 ? (
          <div style={{ textAlign: "center", padding: "20px 0", color: "var(--text-dim)", fontSize: 13 }}>No files uploaded yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(vendor.files ?? []).map((f) => (
              <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-ds)", background: "var(--bg-card)" }} data-testid={`file-row-${f.id}`}>
                <File size={14} style={{ color: "var(--gold)", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.originalName}</div>
                  <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{f.fileType} · {fmtSize(f.sizeBytes)} · {f.uploadedBy}</div>
                </div>
                <a href={`/api/mfr/files/${f.id}/download`} target="_blank" rel="noreferrer">
                  <Btn variant="ghost" icon={Download} size="xs" />
                </a>
                <Btn variant="danger" icon={Trash2} onClick={() => deleteFile(f.id)} size="xs" />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---- Certificate Tracker Tab ----
function CertificateTracker({ onVendorClick }: { onVendorClick: (id: number) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: allCerts = [], isLoading } = useQuery<MfrResaleCert[]>({ queryKey: ["/api/mfr/certs/all"], queryFn: () => fetch("/api/mfr/certs/all", { credentials: "include" }).then((r) => r.json()) });
  const { data: dash } = useQuery<DashboardData>({ queryKey: ["/api/mfr/dashboard"], queryFn: () => fetch("/api/mfr/dashboard", { credentials: "include" }).then((r) => r.json()) });

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("");
  const [expandedCert, setExpandedCert] = useState<number | null>(null);
  const [editForms, setEditForms] = useState<Record<number, Partial<MfrResaleCert>>>({});

  const invalidate = () => { qc.invalidateQueries({ queryKey: ["/api/mfr/certs/all"] }); qc.invalidateQueries({ queryKey: ["/api/mfr/dashboard"] }); qc.invalidateQueries({ queryKey: ["/api/mfr/vendors"] }); };

  const states = useMemo(() => [...new Set(allCerts.map((c) => c.state))].sort(), [allCerts]);

  const filtered = useMemo(() => {
    let list = allCerts;
    if (search) { const s = search.toLowerCase(); list = list.filter((c) => (c.vendorName || "").toLowerCase().includes(s) || c.state.toLowerCase().includes(s) || (c.certNumber || "").toLowerCase().includes(s)); }
    if (statusFilter !== "all") list = list.filter((c) => c.status === statusFilter);
    if (stateFilter) list = list.filter((c) => c.state === stateFilter);
    return list.sort((a, b) => (a.vendorName || "").localeCompare(b.vendorName || ""));
  }, [allCerts, search, statusFilter, stateFilter]);

  const startEdit = (cert: MfrResaleCert) => {
    setEditForms((prev) => ({ ...prev, [cert.id]: { ...cert } }));
    setExpandedCert(cert.id);
  };

  const saveCert = async (cert: MfrResaleCert) => {
    const form = editForms[cert.id] || cert;
    try {
      await apiRequest("PUT", `/api/mfr/vendors/${cert.vendorId}/certs/${cert.id}`, form);
      invalidate();
      setExpandedCert(null);
      toast({ title: "Certificate saved" });
    } catch { toast({ title: "Save failed", variant: "destructive" }); }
  };

  const deleteCert = async (cert: MfrResaleCert) => {
    if (!confirm("Delete this certificate?")) return;
    try { await apiRequest("DELETE", `/api/mfr/vendors/${cert.vendorId}/certs/${cert.id}`, undefined); invalidate(); toast({ title: "Certificate deleted" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const addCertForVendor = async (vendorId: number) => {
    try { await apiRequest("POST", `/api/mfr/vendors/${vendorId}/certs`, { state: "CA", certType: "Resale" }); invalidate(); toast({ title: "Blank certificate created", description: "Open Certificate Tracker to fill in details" }); } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const kpiCard = (label: string, value: number | string, sub?: string, color?: string) => (
    <div style={{ flex: 1, minWidth: 130, padding: "14px 16px", borderRadius: 10, border: "1px solid var(--border-ds)", background: "var(--bg-card)" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color || "var(--text-primary)", fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  const setEF = (id: number, k: keyof MfrResaleCert, v: any) => setEditForms((prev) => ({ ...prev, [id]: { ...prev[id], [k]: v } }));

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {dash && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
          {kpiCard("Total Vendors", dash.totalVendors)}
          {kpiCard("Total Certs", dash.certsTotal)}
          {kpiCard("Certs Sent", `${dash.certsSent} of ${dash.certsTotal}`)}
          {kpiCard("Confirmed", dash.certsConfirmed, undefined, "#4CAF7D")}
          {kpiCard("Expiring <90d", dash.certsExpiring, undefined, "var(--gold)")}
          {kpiCard("Not Sent / Expired", dash.certsNotSent + dash.certsExpired, undefined, "#E05252")}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }} />
          <input style={{ ...inputStyle, paddingLeft: 30 }} placeholder="Search vendor, state, cert #…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select style={{ ...inputStyle, width: "auto" }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All Statuses</option>
          <option value="not_sent">Not Sent</option>
          <option value="sent">Sent</option>
          <option value="confirmed">Confirmed</option>
          <option value="expiring">Expiring</option>
          <option value="expired">Expired</option>
        </select>
        <select style={{ ...inputStyle, width: "auto" }} value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
          <option value="">All States</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {isLoading ? <div style={{ textAlign: "center", padding: 40, color: "var(--text-dim)" }}>Loading…</div> : (
        <div style={{ border: "1px solid var(--border-ds)", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 50px 80px 120px 60px 80px 120px 90px 60px", gap: 0, padding: "8px 14px", background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            <span>Vendor</span><span>State</span><span>Type</span><span>Cert #</span><span>Sent</span><span>Confirmed</span><span>Expiration</span><span>Status</span><span></span>
          </div>
          {filtered.length === 0 && <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>No certificates found.</div>}
          {filtered.map((cert) => {
            const isExp = cert.status === "expanded";
            const isEditing = expandedCert === cert.id;
            const ef = editForms[cert.id] || cert;
            const days = daysUntil(cert.expirationDate);
            const rowBg = cert.status === "expired" ? "rgba(224,82,82,0.04)" : "var(--bg-page)";
            return (
              <div key={cert.id} style={{ borderBottom: "1px solid var(--border-ds)", background: rowBg }}>
                <div
                  onClick={() => isEditing ? setExpandedCert(null) : startEdit(cert)}
                  style={{ display: "grid", gridTemplateColumns: "2fr 50px 80px 120px 60px 80px 120px 90px 60px", gap: 0, padding: "9px 14px", cursor: "pointer", alignItems: "center" }}
                  data-testid={`cert-row-${cert.id}`}
                >
                  <span style={{ fontWeight: 600, fontSize: 12, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cert.vendorName}</span>
                  <span style={{ fontSize: 11, padding: "2px 6px", borderRadius: 4, background: "var(--bg-card)", color: "var(--text-dim)", textAlign: "center", fontFamily: "monospace", border: "1px solid var(--border-ds)" }}>{cert.state}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{cert.certType}</span>
                  <span style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cert.certNumber || "—"}</span>
                  <span>{cert.sent ? <Check size={13} style={{ color: "#4CAF7D" }} /> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No</span>}</span>
                  <span>{cert.vendorConfirmed ? <Check size={13} style={{ color: "#4CAF7D" }} /> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No</span>}</span>
                  <span style={{ fontSize: 11 }}>
                    {cert.expirationDate ? (
                      <span style={{ color: days !== null && days < 0 ? "#E05252" : days !== null && days <= 90 ? "var(--gold)" : "var(--text-primary)" }}>
                        {cert.expirationDate}{days !== null && ` (${days < 0 ? `${Math.abs(days)}d ago` : `${days}d`})`}
                      </span>
                    ) : "—"}
                  </span>
                  <span>{certStatusBadge(cert.status)}</span>
                  <span style={{ fontSize: 11, color: "var(--gold)", textDecoration: "underline" }}>Edit</span>
                </div>
                {isEditing && (
                  <div style={{ padding: "14px 16px", borderTop: "1px solid var(--border-ds)", background: "var(--bg-card)" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 10 }}>
                      <Field label="State">
                        <select style={inputStyle} value={ef.state || ""} onChange={(e) => setEF(cert.id, "state", e.target.value)}>
                          {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </Field>
                      <Field label="Cert Type">
                        <select style={inputStyle} value={ef.certType || "Resale"} onChange={(e) => setEF(cert.id, "certType", e.target.value)}>
                          <option value="Resale">Resale</option>
                          <option value="Exempt">Exempt</option>
                        </select>
                      </Field>
                      <Field label="Cert #"><input style={inputStyle} value={ef.certNumber || ""} onChange={(e) => setEF(cert.id, "certNumber", e.target.value)} /></Field>
                      <Field label="Contact Sent To"><input style={inputStyle} value={ef.contactSentTo || ""} onChange={(e) => setEF(cert.id, "contactSentTo", e.target.value)} /></Field>
                      <Field label="Sent?"><InpCheck label="Sent" checked={!!ef.sent} onChange={(v) => setEF(cert.id, "sent", v)} /></Field>
                      <Field label="Date Sent"><input style={inputStyle} type="date" value={ef.dateSent || ""} onChange={(e) => setEF(cert.id, "dateSent", e.target.value)} /></Field>
                      <Field label="Confirmed?"><InpCheck label="Vendor Confirmed" checked={!!ef.vendorConfirmed} onChange={(v) => setEF(cert.id, "vendorConfirmed", v)} /></Field>
                      <Field label="Confirmation Date"><input style={inputStyle} type="date" value={ef.confirmationDate || ""} onChange={(e) => setEF(cert.id, "confirmationDate", e.target.value)} /></Field>
                      <Field label="Issue Date"><input style={inputStyle} type="date" value={ef.issueDate || ""} onChange={(e) => setEF(cert.id, "issueDate", e.target.value)} /></Field>
                      <Field label="Expiration Date"><input style={inputStyle} type="date" value={ef.expirationDate || ""} onChange={(e) => setEF(cert.id, "expirationDate", e.target.value)} /></Field>
                      <Field label="Notes"><input style={inputStyle} value={ef.notes || ""} onChange={(e) => setEF(cert.id, "notes", e.target.value)} /></Field>
                    </div>
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <Btn label="Delete" variant="danger" icon={Trash2} onClick={() => deleteCert(cert)} />
                      <Btn label="Cancel" onClick={() => setExpandedCert(null)} />
                      <Btn label="Save" variant="gold" onClick={() => saveCert(cert)} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {dash && (dash.vendorsNoCerts ?? []).length > 0 && (
        <div style={{ marginTop: 24, padding: "16px 18px", borderRadius: 10, border: "1px solid rgba(224,82,82,0.3)", background: "rgba(224,82,82,0.04)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 13, fontWeight: 700, color: "#E05252" }}>
            <AlertTriangle size={15} />
            Vendors Without Any Certificates ({dash.vendorsNoCerts.length})
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {dash.vendorsNoCerts.map((v) => (
              <button
                key={v.id}
                onClick={() => addCertForVendor(v.id)}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 16, background: "rgba(224,82,82,0.1)", border: "1px solid rgba(224,82,82,0.3)", color: "#E05252", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                title={`Add certificate for ${v.name}`}
                data-testid={`chip-no-cert-${v.id}`}
              >
                <Plus size={11} />
                {v.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Main Page ----
export default function VendorDatabasePage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"vendors" | "certs" | "manufacturers">("vendors");
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("");
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showExcelUpload, setShowExcelUpload] = useState<UploadType | null>(null);
  const [newVendor, setNewVendor] = useState({ name: "", legalName: "", shortCode: "", aliases: [] as string[], website: "", notes: "", scopes: [] as string[], manufacturerIds: [] as number[] });

  const { data: allMfrs = [] } = useQuery<MfrManufacturerRow[]>({ queryKey: ["/api/mfr/manufacturers"] });

  const { data: scopeTagsRaw } = useQuery<string[]>({
    queryKey: ["/api/mfr/vendors/scope-tags"],
    queryFn: () => fetch("/api/mfr/vendors/scope-tags", { credentials: "include" }).then((r) => r.ok ? r.json() : []),
  });
  const scopeTags: string[] = Array.isArray(scopeTagsRaw) ? scopeTagsRaw : [];

  const { data: vendorsRaw, isLoading } = useQuery<MfrVendorSummary[]>({
    queryKey: ["/api/mfr/vendors", search, scopeFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (scopeFilter) params.set("scope", scopeFilter);
      const r = await fetch(`/api/mfr/vendors?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error(`Failed to load vendors (${r.status})`);
      const json = await r.json();
      return Array.isArray(json) ? json : [];
    },
  });
  const vendors: MfrVendorSummary[] = Array.isArray(vendorsRaw) ? vendorsRaw : [];

  const { data: dash } = useQuery<DashboardData>({ queryKey: ["/api/mfr/dashboard"], queryFn: () => fetch("/api/mfr/dashboard", { credentials: "include" }).then((r) => r.json()) });

  const alertCount = (dash?.certsNotSent || 0) + (dash?.certsExpired || 0);

  const createVendor = async () => {
    if (!newVendor.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    try {
      const r = await fetch("/api/mfr/vendors", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(newVendor) });
      if (r.status === 401) {
        handleAuthError();
        return;
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        toast({ title: "Failed to create vendor", description: err?.error || err?.message || `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      const v = await r.json();
      if (!v?.id) {
        toast({ title: "Failed to create vendor", description: "Unexpected server response", variant: "destructive" });
        return;
      }
      qc.invalidateQueries({ queryKey: ["/api/mfr/vendors"] });
      setShowAddVendor(false);
      setNewVendor({ name: "", legalName: "", shortCode: "", aliases: [], website: "", notes: "", scopes: [], manufacturerIds: [] });
      setSelectedVendorId(v.id);
      toast({ title: "Vendor created" });
    } catch (e: any) {
      toast({ title: "Failed to create vendor", description: e?.message || "Network error", variant: "destructive" });
    }
  };

  const exportAll = async () => {
    const data = await fetch("/api/mfr/export", { credentials: "include" }).then((r) => r.json());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "nbs-vendors-export.json"; a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Export downloaded" });
  };

  const deleteAll = async () => {
    if (!confirm("Are you sure? This will delete ALL manufacturers, vendors, contacts, products, and certificates. This cannot be undone.")) return;
    try {
      const res = await fetch("/api/mfr/all", { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Delete failed");
      qc.invalidateQueries({ queryKey: ["/api/mfr/vendors"] });
      qc.invalidateQueries({ queryKey: ["/api/mfr/dashboard"] });
      toast({ title: "All manufacturer data deleted" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    }
  };

  if (selectedVendorId !== null) {
    return (
      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        <VendorDetail vendorId={selectedVendorId} onBack={() => setSelectedVendorId(null)} qc={qc} />
      </div>
    );
  }

  return (
    <div style={{ padding: "0 32px 40px", maxWidth: 1100, margin: "0 auto" }}>
      {showExcelUpload && (
        <ExcelUploadModal
          type={showExcelUpload}
          onClose={() => setShowExcelUpload(null)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["/api/mfr/vendors"] });
            qc.invalidateQueries({ queryKey: ["/api/mfr/manufacturers"] });
            qc.invalidateQueries({ queryKey: ["/api/mfr/manufacturers/with-stats"] });
            qc.invalidateQueries({ queryKey: ["/api/mfr/dashboard"] });
          }}
        />
      )}

      {/* Header */}
      <div style={{ padding: "24px 0 20px" }}>
        <div style={{ marginBottom: 8 }}>
          <BackNav href="/" label="Home" testId="button-back-home" />
        </div>
        <div style={{ fontSize: 11, fontFamily: "monospace", letterSpacing: "0.1em", color: "var(--gold)", marginBottom: 6 }}>
          AIPM TOOLBELT › <span style={{ color: "var(--text-dim)" }}>VENDOR DATABASE</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, fontFamily: "var(--font-heading)", color: "var(--text-primary)", margin: 0 }}>Manufacturers & Vendors</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn
              label={tab === "manufacturers" ? "Upload Manufacturers" : tab === "vendors" ? "Upload Vendors" : "Upload Excel"}
              icon={Upload}
              onClick={() => setShowExcelUpload(tab === "manufacturers" ? "manufacturers" : "vendors")}
            />
            <Btn label="Export JSON" icon={Download} onClick={exportAll} />
            <Btn label="Delete All" icon={Trash2} onClick={deleteAll} variant="ghost" />
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, marginTop: 20, borderBottom: "1px solid var(--border-ds)" }}>
          {[
            { id: "vendors" as const, label: "Vendors", icon: Building2 },
            { id: "manufacturers" as const, label: "Manufacturers", icon: Tag },
            { id: "certs" as const, label: `Certificate Tracker${alertCount > 0 ? ` (${alertCount})` : ""}`, icon: Shield, alert: alertCount > 0 },
          ].map((t) => {
            const active = tab === t.id;
            const TIcon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 18px", background: "none", border: "none", borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent", cursor: "pointer", fontSize: 13, fontWeight: active ? 700 : 500, color: active ? "var(--gold)" : "var(--text-dim)", marginBottom: -1 }}
                data-testid={`tab-${t.id}`}
              >
                <TIcon size={14} />
                {t.label}
                {t.alert && !active && (
                  <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "#E05252", color: "#fff", fontWeight: 700 }}>{alertCount}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Vendors Tab */}
      {tab === "vendors" && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 200 }}>
              <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }} />
              <input style={{ ...inputStyle, paddingLeft: 30 }} placeholder="Search vendors, contacts, products…" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-vendor-search" />
            </div>
            <select style={{ ...inputStyle, width: "auto" }} value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} data-testid="select-category-filter">
              <option value="">All Scopes</option>
              {scopeTags.map((tag) => {
                const found = CONTACT_SCOPE_OPTIONS.find((o) => o.id === tag);
                const label = found ? found.label : tag.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                return <option key={tag} value={tag}>{label}</option>;
              })}
            </select>
            <Btn label="Add Vendor" variant="gold" icon={Plus} onClick={() => setShowAddVendor(true)} />
          </div>

          {showAddVendor && (
            <div style={{ padding: 16, borderRadius: 10, border: "1px solid var(--gold)", background: "rgba(201,168,76,0.05)", marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 }}>New Vendor</div>
              <NamingFieldsInfoPanel storageKey="aipm.naming-info-seen.vendor" kind="vendor" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
                <Field label="Display Name *"><InpText value={newVendor.name} onChange={(v) => setNewVendor({ ...newVendor, name: v })} placeholder="e.g. PBS" /></Field>
                <Field label="Legal Name"><InpText value={newVendor.legalName} onChange={(v) => setNewVendor({ ...newVendor, legalName: v })} placeholder="Pacific Building Specialties, Inc." /></Field>
                <Field label="Short Code *"><InpText value={newVendor.shortCode} onChange={(v) => setNewVendor({ ...newVendor, shortCode: v.toUpperCase().slice(0, 10) })} placeholder="e.g. PBS" /></Field>
              </div>
              <div style={{ marginBottom: 12 }}>
                <Field label="Aliases (alternate names this vendor may appear as in incoming emails or bid invites)">
                  <AliasChipInput aliases={newVendor.aliases} onChange={(a) => setNewVendor({ ...newVendor, aliases: a })} testId="input-newvendor-aliases" />
                </Field>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 12 }}>
                <Field label="Website"><InpText value={newVendor.website} onChange={(v) => setNewVendor({ ...newVendor, website: v })} placeholder="https://" /></Field>
              </div>
              <div style={{ marginBottom: 12 }}>
                <Field label="Scope Tags (which scope categories this vendor covers)">
                  <ScopeTagPicker selected={newVendor.scopes} onChange={(s) => setNewVendor({ ...newVendor, scopes: s })} />
                </Field>
              </div>
              <SuggestedManufacturersPanel
                allMfrs={allMfrs}
                vendorScopes={newVendor.scopes}
                selectedIds={newVendor.manufacturerIds}
                onAdd={(id) => setNewVendor({ ...newVendor, manufacturerIds: [...newVendor.manufacturerIds, id] })}
                onRemove={(id) => setNewVendor({ ...newVendor, manufacturerIds: newVendor.manufacturerIds.filter(x => x !== id) })}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <Btn label="Cancel" onClick={() => setShowAddVendor(false)} />
                <Btn label="Create Vendor" variant="gold" onClick={createVendor} />
              </div>
            </div>
          )}

          {isLoading ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--text-dim)" }}>Loading vendors…</div>
          ) : vendors.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "var(--text-dim)" }}>
              <Building2 size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
              <p style={{ fontSize: 14 }}>No vendors yet. Upload your manufacturer list or add vendors manually.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {vendors.map((v) => (
                <div
                  key={v.id}
                  onClick={() => setSelectedVendorId(v.id)}
                  style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", borderRadius: 8, border: "1px solid var(--border-ds)", background: "var(--bg-card)", cursor: "pointer", transition: "background 0.15s, border-color 0.15s" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--gold)"; (e.currentTarget as HTMLDivElement).style.background = "rgba(201,168,76,0.03)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "var(--border-ds)"; (e.currentTarget as HTMLDivElement).style.background = "var(--bg-card)"; }}
                  data-testid={`card-vendor-${v.id}`}
                >
                  <VendorAvatar name={v.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "var(--text-primary)" }}>{v.name}</span>
                      {(v.tags as string[]).map((t, i) => <span key={i} style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: "rgba(91,141,239,0.12)", color: "#5B8DEF" }}>{t}</span>)}
                    </div>
                    <div style={{ display: "flex", gap: 14, marginTop: 3 }}>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{v.contactCount} contact{v.contactCount !== 1 ? "s" : ""}</span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{v.productCount} product{v.productCount !== 1 ? "s" : ""}</span>
                      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{v.certCount} cert{v.certCount !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {v.hasExpiredCert && <AlertTriangle size={14} style={{ color: "#E05252" }} title="Expired certificate" />}
                    {v.hasExpiringCert && !v.hasExpiredCert && <AlertTriangle size={14} style={{ color: "var(--gold)" }} title="Certificate expiring soon" />}
                    {v.w9OnFile && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(76,175,125,0.12)", color: "#4CAF7D" }}>W-9</span>}
                    {v.manufacturerDirect && <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: "rgba(91,141,239,0.12)", color: "#5B8DEF" }} title="Manufacturer Direct">DIRECT</span>}
                  </div>
                  <ChevronRight size={15} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Manufacturers Tab */}
      {tab === "manufacturers" && (
        <ManufacturersTab />
      )}

      {/* Certificate Tracker Tab */}
      {tab === "certs" && (
        <CertificateTracker onVendorClick={(id) => { setTab("vendors"); setSelectedVendorId(id); }} />
      )}
    </div>
  );
}

// ---- Manufacturers Tab ----
interface MfrStatRow { id: number; name: string; legalName: string | null; shortCode: string | null; aliases: string[] | null; website: string | null; primaryContact: string | null; contactEmail: string | null; contactPhone: string | null; address: string | null; notes: string | null; scopes: string[] | null; vendorCount: number; lineItemCount: number; approvedCount: number; }

const EMPTY_MFR_FORM = { name: "", legalName: "", shortCode: "", aliases: [] as string[], website: "", primaryContact: "", contactEmail: "", contactPhone: "", address: "", notes: "", scopes: [] as string[] };

function ManufacturersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [mergingId, setMergingId] = useState<number | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const [mergeSearch, setMergeSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "edit">("add");
  const [modalId, setModalId] = useState<number | null>(null);
  const [mfrForm, setMfrForm] = useState(EMPTY_MFR_FORM);

  const { data: mfrs = [], isLoading } = useQuery<MfrStatRow[]>({
    queryKey: ["/api/mfr/manufacturers/with-stats"],
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mfrs;
    return mfrs.filter(m => m.name.toLowerCase().includes(q));
  }, [mfrs, search]);

  const invalidateMfrs = () => {
    qc.invalidateQueries({ queryKey: ["/api/mfr/manufacturers/with-stats"] });
    qc.invalidateQueries({ queryKey: ["/api/mfr/manufacturers"] });
  };

  const createMutation = useMutation({
    mutationFn: async (data: typeof EMPTY_MFR_FORM): Promise<{ row: MfrStatRow; isDuplicate: boolean }> => {
      const res = await fetch("/api/mfr/manufacturers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      const body = await res.json();
      if (res.status === 401) {
        throw new Error(`401: ${body?.message || "Unauthorized"}`);
      }
      if (!res.ok) {
        throw new Error(body?.message || "Failed to create manufacturer");
      }
      return { row: body as MfrStatRow, isDuplicate: res.status === 200 };
    },
    onSuccess: ({ row, isDuplicate }) => {
      invalidateMfrs();
      setModalOpen(false);
      setMfrForm(EMPTY_MFR_FORM);
      if (isDuplicate) {
        toast({ title: "Already exists", description: `"${row.name}" is already in your manufacturer list.` });
      } else {
        toast({ title: "Manufacturer added" });
      }
    },
    onError: (e: any) => { if (!handleAuthError(e)) toast({ title: "Failed to add", description: e?.message, variant: "destructive" }); },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof EMPTY_MFR_FORM }) => apiRequest("PATCH", `/api/mfr/manufacturers/${id}`, data),
    onSuccess: () => { invalidateMfrs(); setModalOpen(false); setMfrForm(EMPTY_MFR_FORM); toast({ title: "Manufacturer updated" }); },
    onError: (e: any) => { if (!handleAuthError(e)) toast({ title: "Update failed", description: e?.message, variant: "destructive" }); },
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ sourceId, targetId }: { sourceId: number; targetId: number }) => apiRequest("POST", `/api/mfr/manufacturers/${sourceId}/merge`, { targetId }),
    onSuccess: (_d, vars) => {
      invalidateMfrs();
      setMergingId(null);
      setMergeTargetId(null);
      setMergeSearch("");
      const target = mfrs.find(m => m.id === vars.targetId);
      toast({ title: "Merged", description: target ? `Merged into ${target.name}` : undefined });
    },
    onError: (e: any) => { if (!handleAuthError(e)) toast({ title: "Merge failed", description: e?.message, variant: "destructive" }); },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/mfr/manufacturers/${id}`),
    onSuccess: () => { invalidateMfrs(); toast({ title: "Manufacturer deleted" }); },
    onError: (e: any) => { if (!handleAuthError(e)) toast({ title: "Delete failed", description: e?.message, variant: "destructive" }); },
  });

  const openAdd = () => { setModalMode("add"); setModalId(null); setMfrForm(EMPTY_MFR_FORM); setModalOpen(true); };
  const openEdit = (m: MfrStatRow) => {
    setModalMode("edit");
    setModalId(m.id);
    setMfrForm({ name: m.name, legalName: m.legalName || m.name || "", shortCode: m.shortCode || "", aliases: m.aliases || [], website: m.website || "", primaryContact: m.primaryContact || "", contactEmail: m.contactEmail || "", contactPhone: m.contactPhone || "", address: m.address || "", notes: m.notes || "", scopes: m.scopes || [] });
    setModalOpen(true);
  };

  const submitModal = () => {
    if (!mfrForm.name.trim()) return;
    if (modalMode === "add") createMutation.mutate(mfrForm);
    else if (modalId) updateMutation.mutate({ id: modalId, data: mfrForm });
  };

  const inputStyleLocal: React.CSSProperties = { padding: "8px 12px", fontSize: 13, background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderRadius: 6, color: "var(--text-primary)", outline: "none", width: "100%" };

  const mergingMfr = mergingId ? mfrs.find(m => m.id === mergingId) : null;
  const mergeCandidates = useMemo(() => {
    if (!mergingMfr) return [];
    const q = mergeSearch.trim().toLowerCase();
    return mfrs.filter(m => m.id !== mergingMfr.id && (q === "" || m.name.toLowerCase().includes(q)));
  }, [mfrs, mergingMfr, mergeSearch]);

  const isPending = createMutation.isPending || updateMutation.isPending;

  return (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1 }}>
          <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)" }} />
          <input
            style={{ ...inputStyleLocal, paddingLeft: 30 }}
            placeholder="Search manufacturers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-manufacturer-search"
          />
        </div>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{filtered.length} of {mfrs.length}</span>
        <button onClick={openAdd} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", fontSize: 12, fontWeight: 700, background: "var(--gold)", color: "#000", border: "none", borderRadius: 6, cursor: "pointer" }} data-testid="button-add-manufacturer">
          <Plus size={13} /> Add Manufacturer
        </button>
      </div>

      {isLoading ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--text-dim)" }}>Loading manufacturers…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--text-dim)" }}>
          <Tag size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
          <p style={{ fontSize: 14 }}>No manufacturers found.</p>
        </div>
      ) : (
        <div style={{ border: "1px solid var(--border-ds)", borderRadius: 8, overflow: "hidden", background: "var(--bg-card)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 100px 100px 180px", padding: "10px 14px", background: "var(--bg2)", fontSize: 11, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid var(--border-ds)" }}>
            <div>Name</div>
            <div style={{ textAlign: "right" }}>Vendors</div>
            <div style={{ textAlign: "right" }}>Line Items</div>
            <div style={{ textAlign: "right" }}>Approved</div>
            <div style={{ textAlign: "right" }}>Actions</div>
          </div>
          {filtered.map((m) => {
            const inUse = m.lineItemCount > 0 || m.approvedCount > 0 || m.vendorCount > 0;
            return (
              <div key={m.id} style={{ display: "grid", gridTemplateColumns: "1fr 100px 100px 100px 180px", padding: "10px 14px", borderBottom: "1px solid var(--border-ds)", alignItems: "center", fontSize: 13 }} data-testid={`row-mfr-${m.id}`}>
                <div>
                  <div style={{ color: "var(--text-primary)", fontWeight: 500 }} data-testid={`text-mfr-name-${m.id}`}>{m.name}</div>
                  {m.website && <div style={{ fontSize: 11, color: "#5B8DEF", marginTop: 2 }}>{m.website}</div>}
                </div>
                <div style={{ textAlign: "right", color: m.vendorCount > 0 ? "var(--text-primary)" : "var(--text-dim)" }} data-testid={`text-mfr-vendor-count-${m.id}`}>{m.vendorCount}</div>
                <div style={{ textAlign: "right", color: m.lineItemCount > 0 ? "var(--text-primary)" : "var(--text-dim)" }} data-testid={`text-mfr-line-item-count-${m.id}`}>{m.lineItemCount}</div>
                <div style={{ textAlign: "right", color: m.approvedCount > 0 ? "var(--text-primary)" : "var(--text-dim)" }}>{m.approvedCount}</div>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                  <button onClick={() => openEdit(m)} style={{ padding: "4px 10px", fontSize: 11, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-ds)", borderRadius: 4, cursor: "pointer" }} data-testid={`button-edit-mfr-${m.id}`}>Edit</button>
                  <button onClick={() => { setMergingId(m.id); setMergeTargetId(null); setMergeSearch(""); }} style={{ padding: "4px 10px", fontSize: 11, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-ds)", borderRadius: 4, cursor: "pointer" }} data-testid={`button-merge-mfr-${m.id}`}>Merge</button>
                  <button
                    onClick={() => {
                      const msg = inUse
                        ? `Delete "${m.name}"? It is referenced by ${m.lineItemCount} line item(s), ${m.approvedCount} approved scope entries, and ${m.vendorCount} vendor(s). Line items will lose their manufacturer link. This cannot be undone.`
                        : `Delete "${m.name}"? This cannot be undone.`;
                      if (window.confirm(msg)) deleteMutation.mutate(m.id);
                    }}
                    style={{ padding: "4px 10px", fontSize: 11, background: "transparent", color: "#E05252", border: "1px solid #E0525240", borderRadius: 4, cursor: "pointer" }}
                    data-testid={`button-delete-mfr-${m.id}`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Manufacturer Modal */}
      {modalOpen && (
        <div onClick={() => setModalOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderRadius: 10, padding: 24, width: "100%", maxWidth: 560, maxHeight: "90vh", display: "flex", flexDirection: "column" }} data-testid="modal-mfr-form">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexShrink: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{modalMode === "add" ? "Add Manufacturer" : "Edit Manufacturer"}</div>
              <button onClick={() => setModalOpen(false)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", flex: 1, minHeight: 0, paddingRight: 4 }}>
              <NamingFieldsInfoPanel storageKey="aipm.naming-info-seen.mfr" kind="manufacturer" />
              <Field label="Display Name *">
                <input style={inputStyleLocal} value={mfrForm.name} onChange={(e) => setMfrForm({ ...mfrForm, name: e.target.value })} placeholder="e.g. Bobrick Washroom Equipment" autoFocus data-testid="input-mfr-name" />
              </Field>
              <Field label="Legal Name">
                <input style={inputStyleLocal} value={mfrForm.legalName} onChange={(e) => setMfrForm({ ...mfrForm, legalName: e.target.value })} placeholder="Full official name (e.g. Bobrick Washroom Equipment, Inc.)" data-testid="input-mfr-legal-name" />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 12 }}>
                <Field label={`Short Code${modalMode === "add" ? " *" : ""}`}>
                  <input style={{ ...inputStyleLocal, textTransform: "uppercase" }} value={mfrForm.shortCode} onChange={(e) => setMfrForm({ ...mfrForm, shortCode: e.target.value.toUpperCase().slice(0, 10) })} placeholder="e.g. BOB" maxLength={10} data-testid="input-mfr-short-code" />
                </Field>
                <Field label="Aliases">
                  <AliasChipInput aliases={mfrForm.aliases} onChange={(a) => setMfrForm({ ...mfrForm, aliases: a })} testId="input-mfr-aliases" />
                </Field>
              </div>
              <Field label="Website">
                <input style={inputStyleLocal} value={mfrForm.website} onChange={(e) => setMfrForm({ ...mfrForm, website: e.target.value })} placeholder="https://" data-testid="input-mfr-website" />
              </Field>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Primary Contact Name">
                  <input style={inputStyleLocal} value={mfrForm.primaryContact} onChange={(e) => setMfrForm({ ...mfrForm, primaryContact: e.target.value })} placeholder="Jane Smith" data-testid="input-mfr-primary-contact" />
                </Field>
                <Field label="Contact Phone">
                  <input style={inputStyleLocal} value={mfrForm.contactPhone} onChange={(e) => setMfrForm({ ...mfrForm, contactPhone: e.target.value })} placeholder="(555) 555-5555" data-testid="input-mfr-contact-phone" />
                </Field>
              </div>
              <Field label="Contact Email">
                <input style={inputStyleLocal} value={mfrForm.contactEmail} onChange={(e) => setMfrForm({ ...mfrForm, contactEmail: e.target.value })} placeholder="contact@manufacturer.com" data-testid="input-mfr-contact-email" />
              </Field>
              <Field label="Address">
                <input style={inputStyleLocal} value={mfrForm.address} onChange={(e) => setMfrForm({ ...mfrForm, address: e.target.value })} placeholder="123 Main St, City, ST 12345" data-testid="input-mfr-address" />
              </Field>
              <Field label="Notes">
                <textarea style={{ ...inputStyleLocal, minHeight: 72, resize: "vertical" }} value={mfrForm.notes} onChange={(e) => setMfrForm({ ...mfrForm, notes: e.target.value })} placeholder="Internal notes…" data-testid="input-mfr-notes" />
              </Field>
              <Field label="Scope Tags (which scope categories this manufacturer makes products for)">
                <ScopeTagPicker selected={mfrForm.scopes} onChange={(s) => setMfrForm({ ...mfrForm, scopes: s })} />
              </Field>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
              <button onClick={() => setModalOpen(false)} style={{ padding: "8px 16px", fontSize: 13, background: "transparent", border: "1px solid var(--border-ds)", color: "var(--text-secondary)", borderRadius: 6, cursor: "pointer" }} data-testid="button-cancel-mfr-modal">Cancel</button>
              <button onClick={submitModal} disabled={isPending || !mfrForm.name.trim()} style={{ padding: "8px 16px", fontSize: 13, fontWeight: 700, background: mfrForm.name.trim() ? "var(--gold)" : "var(--bg2)", color: mfrForm.name.trim() ? "#000" : "var(--text-dim)", border: "none", borderRadius: 6, cursor: mfrForm.name.trim() ? "pointer" : "not-allowed" }} data-testid="button-submit-mfr-modal">
                {isPending ? "Saving…" : modalMode === "add" ? "Add Manufacturer" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Merge modal */}
      {mergingMfr && (
        <div onClick={() => setMergingId(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--bg-elev)", border: "1px solid var(--border-ds)", borderRadius: 10, padding: 20, width: "100%", maxWidth: 520, maxHeight: "80vh", display: "flex", flexDirection: "column" }} data-testid="modal-merge-mfr">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Merge "{mergingMfr.name}" into…</div>
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>All line items, vendor tags, and approved scope entries will be re-pointed to the target. This cannot be undone.</div>
              </div>
              <button onClick={() => setMergingId(null)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}><X size={16} /></button>
            </div>
            <input
              style={inputStyleLocal}
              placeholder="Search target manufacturer…"
              value={mergeSearch}
              onChange={(e) => setMergeSearch(e.target.value)}
              data-testid="input-merge-search"
            />
            <div style={{ marginTop: 10, overflowY: "auto", flex: 1, border: "1px solid var(--border-ds)", borderRadius: 6 }}>
              {mergeCandidates.length === 0 ? (
                <div style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>No matches.</div>
              ) : mergeCandidates.map(c => (
                <div
                  key={c.id}
                  onClick={() => setMergeTargetId(c.id)}
                  style={{ padding: "10px 12px", fontSize: 13, cursor: "pointer", background: mergeTargetId === c.id ? "rgba(201,168,76,0.12)" : "transparent", borderBottom: "1px solid var(--border-ds)", color: "var(--text-primary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  data-testid={`row-merge-target-${c.id}`}
                >
                  <span>{c.name}</span>
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.vendorCount}v · {c.lineItemCount}li</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button onClick={() => setMergingId(null)} style={{ padding: "8px 14px", fontSize: 12, background: "transparent", border: "1px solid var(--border-ds)", color: "var(--text-secondary)", borderRadius: 6, cursor: "pointer" }}>Cancel</button>
              <button
                onClick={() => mergeTargetId && mergeMutation.mutate({ sourceId: mergingMfr.id, targetId: mergeTargetId })}
                disabled={!mergeTargetId || mergeMutation.isPending}
                style={{ padding: "8px 14px", fontSize: 12, background: mergeTargetId ? "var(--gold)" : "var(--bg2)", color: mergeTargetId ? "#000" : "var(--text-dim)", border: "none", borderRadius: 6, cursor: mergeTargetId ? "pointer" : "not-allowed", fontWeight: 600 }}
                data-testid="button-confirm-merge"
              >
                {mergeMutation.isPending ? "Merging…" : "Merge"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
