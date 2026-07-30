// Presentation helpers for the Submittal Builder.
//
// Colours come from the app's CSS variables, not hardcoded hex. The status
// chips used to carry dark-theme hex (#1e293b, #422006, #3b0764) while the rest
// of the module used variables, so on the app's default light theme they
// rendered as dark blocks with unreadable text.

import type { LineStatus, SubmittalStatus } from "@shared/submittal/types";

/** Collision-free id. The old module counter was seeded from Date.now() and
 *  restarted on every reload, so ids could repeat within a package. */
export function uid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function now(): number {
  return Date.now();
}

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

export function todayCoverDate(): string {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

export interface StatusMeta {
  label: string;
  color: string;
  bg: string;
  /** One line telling the PM what this status actually means. */
  meaning: string;
}

export const STATUS_META: Record<SubmittalStatus, StatusMeta> = {
  not_started: {
    label: "Not Started", color: "var(--text-secondary)", bg: "var(--bg3)",
    meaning: "No estimate imported yet.",
  },
  in_progress: {
    label: "In Progress", color: "var(--info, #2F6FB0)", bg: "var(--info-bg, rgba(47,111,176,.1))",
    meaning: "Scopes are imported. Product data has not started.",
  },
  waiting_product_data: {
    label: "Waiting on Product Data", color: "var(--gold)", bg: "var(--warning-bg)",
    meaning: "Some lines still need a PDF or a By Others / Not Required mark.",
  },
  ready_for_review: {
    label: "Ready for Review", color: "var(--info, #2F6FB0)", bg: "var(--info-bg, rgba(47,111,176,.1))",
    meaning: "Every line is resolved, but validation found something to fix.",
  },
  ready_for_export: {
    label: "Ready for Export", color: "var(--success)", bg: "var(--success-bg)",
    meaning: "Every line is resolved and validation is clean.",
  },
  exported: {
    label: "Exported", color: "var(--success)", bg: "var(--success-bg)",
    meaning: "The package PDF has been generated.",
  },
};

export function statusMeta(status: string | undefined): StatusMeta {
  return STATUS_META[(status as SubmittalStatus) ?? "not_started"] ?? STATUS_META.not_started;
}

export interface LineStatusMeta {
  label: string;
  color: string;
  /** What choosing this means for the package. */
  meaning: string;
}

export const LINE_STATUS: Record<LineStatus, LineStatusMeta> = {
  missing: { label: "Needs Product Data", color: "var(--error)", meaning: "Still waiting on a PDF." },
  pending: { label: "Pending", color: "var(--gold)", meaning: "Requested from the vendor." },
  attached: { label: "Attached", color: "var(--success)", meaning: "Product data is in the package." },
  not_required: { label: "Not Required", color: "var(--text-secondary)", meaning: "No submittal needed for this line." },
  by_others: { label: "By Others", color: "var(--text-secondary)", meaning: "Supplied by someone else." },
};

export function lineStatusMeta(status: string | undefined): LineStatusMeta {
  return LINE_STATUS[(status as LineStatus) ?? "missing"] ?? LINE_STATUS.missing;
}

// ---------------------------------------------------------------------------
// Shared inline styles
// ---------------------------------------------------------------------------

export const inputStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--border-ds)",
  borderRadius: 4,
  padding: "6px 10px",
  color: "var(--text-primary)",
  fontSize: 12,
  outline: "none",
  width: "100%",
};

export const btnPrimary: React.CSSProperties = {
  padding: "8px 18px",
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 700,
  background: "linear-gradient(135deg, var(--gold), var(--gold-light))",
  color: "var(--text-inverse)",
  border: "none",
  cursor: "pointer",
};

export const btnGhost: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 4,
  fontSize: 12,
  background: "none",
  border: "1px solid var(--border-ds)",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

export function disabledStyle(disabled: boolean): React.CSSProperties {
  return disabled ? { opacity: 0.5, cursor: "not-allowed" } : {};
}

export const cardStyle: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border-ds)",
  borderRadius: 8,
};

export const monoFont = "'JetBrains Mono', ui-monospace, monospace";

export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
