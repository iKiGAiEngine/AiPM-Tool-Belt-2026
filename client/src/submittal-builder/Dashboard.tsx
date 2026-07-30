import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { STATUS_META, statusMeta, formatTimestamp, inputStyle, btnPrimary, btnGhost, disabledStyle, monoFont } from "./helpers";
import type { SubmittalProject, SubmittalStatus } from "@shared/submittal/types";

interface Props {
  projects: SubmittalProject[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}

export default function Dashboard({ projects, loading, error, onOpen, onNew, onDelete, onBack }: Props) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const { isViewer } = useAuth();

  const filtered = projects.filter((p) => {
    if (statusFilter !== "all" && p.submittalStatus !== statusFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return [p.projectName, p.gc, p.estimateNumber, p.assignedPm]
      .some((field) => (field ?? "").toLowerCase().includes(q));
  });

  return (
    <div style={{ background: "var(--bg-page)", minHeight: "calc(100vh - 57px)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ReadOnlyBanner />
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
          <button onClick={onBack} style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 6 }} data-testid="button-home">
            ← AiPM Home
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 5, height: 24, background: "var(--gold)", borderRadius: 2 }} />
            <span style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'Rajdhani', sans-serif" }}>AiPM</span>
            <span style={{ fontSize: 16, color: "var(--text-secondary)" }}>Submittal Builder</span>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onNew} disabled={isViewer}
            style={{ ...btnPrimary, ...disabledStyle(isViewer) }}
            data-testid="button-new-submittal"
          >
            + New Submittal
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 24 }}>
          Turn a won estimate into a submittal package: import the workbook, attach product data, export one PDF per scope.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <input
            value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by project, GC, estimate # or PM…"
            aria-label="Search submittals"
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
            data-testid="input-search"
          />
          <select
            value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="Filter by status"
            style={{ ...inputStyle, width: 200 }}
            data-testid="select-status-filter"
          >
            <option value="all">All Statuses</option>
            {(Object.keys(STATUS_META) as SubmittalStatus[]).map((k) => (
              <option key={k} value={k}>{STATUS_META[k].label}</option>
            ))}
          </select>
        </div>

        {error ? (
          <div style={{ textAlign: "center", padding: 50, color: "var(--error)" }} data-testid="text-load-error">{error}</div>
        ) : loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Loading submittals…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-secondary)" }}>
            {projects.length === 0 ? (
              <div>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
                <div style={{ fontSize: 16, color: "var(--text-secondary)", marginBottom: 8 }}>No submittals yet</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
                  Start one from any Won or Awarded job in the Proposal Log.
                </div>
                <button onClick={onNew} disabled={isViewer} style={{ ...btnPrimary, ...disabledStyle(isViewer) }} data-testid="button-new-submittal-empty">
                  + New Submittal
                </button>
              </div>
            ) : "No submittals match your filters."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="list-submittals">
            {filtered.map((p) => {
              const sm = statusMeta(p.submittalStatus);
              // Counts come from the server's cached columns, computed by the
              // same helpers the workspace uses — no second opinion here.
              const complete = p.completionPercent >= 100;
              return (
                <div
                  key={p.id}
                  role="button" tabIndex={0}
                  onClick={() => onOpen(p.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.id); } }}
                  data-testid={`card-submittal-${p.id}`}
                  style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderRadius: 8, cursor: "pointer", transition: "border-color .15s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--gold)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-ds)"; }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--gold)"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-ds)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 3 }}>{p.projectName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {p.gc}{p.attention ? ` · ${p.attention}` : ""}{p.assignedPm ? ` · PM: ${p.assignedPm}` : ""}
                      {p.estimateNumber && <span style={{ marginLeft: 8, color: "var(--gold)", fontFamily: monoFont, fontSize: 11 }}>{p.estimateNumber}</span>}
                      {p.region && <span style={{ marginLeft: 8, color: "var(--text-muted)", fontSize: 11 }}>{p.region}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 110 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
                      {p.scopeCount ?? 0} scope{(p.scopeCount ?? 0) === 1 ? "" : "s"} · {p.resolvedCount ?? 0}/{p.lineCount ?? 0} lines
                    </div>
                    <div style={{ height: 4, width: 110, background: "var(--border-ds)", borderRadius: 2, overflow: "hidden" }}
                      role="progressbar" aria-valuenow={p.completionPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Lines resolved">
                      <div style={{ height: "100%", width: `${p.completionPercent}%`, background: complete ? "var(--success)" : "var(--gold)", borderRadius: 2 }} />
                    </div>
                  </div>
                  <span title={sm.meaning} style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg, whiteSpace: "nowrap" }}>
                    {sm.label}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 80, textAlign: "right" }}>{formatTimestamp(p.updatedAt)}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isViewer && window.confirm(`Delete the submittal for "${p.projectName}"? Its attached product data will be deleted too.`)) onDelete(p.id);
                    }}
                    disabled={isViewer}
                    aria-label={`Delete submittal for ${p.projectName}`}
                    title="Delete"
                    style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: isViewer ? "not-allowed" : "pointer", fontSize: 16, padding: 4, ...disabledStyle(isViewer) }}
                    data-testid={`button-delete-${p.id}`}
                  >&times;</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
