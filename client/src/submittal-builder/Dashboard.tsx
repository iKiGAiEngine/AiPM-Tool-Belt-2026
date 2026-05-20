import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { STATUS_META, formatTimestamp, pct, inputStyle, btnPrimary, btnGhost } from "./helpers";
import type { SubmittalProject } from "./types";

interface Props {
  projects: SubmittalProject[];
  loading: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onBack: () => void;
}

export default function Dashboard({ projects, loading, onOpen, onNew, onDelete, onBack }: Props) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const { isViewer } = useAuth();

  const filtered = projects.filter((p) => {
    if (statusFilter !== "all" && p.submittalStatus !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!p.projectName.toLowerCase().includes(q) && !(p.gc || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });

  return (
    <div style={{ background: "var(--bg-page)", minHeight: "calc(100vh - 57px)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <ReadOnlyBanner />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <button onClick={onBack} style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 6 }}>
            ← AiPM Home
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 5, height: 24, background: "var(--gold)", borderRadius: 2 }} />
            <span style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary)", fontFamily: "'Rajdhani', sans-serif" }}>AiPM</span>
            <span style={{ fontSize: 16, color: "var(--text-secondary)" }}>Submittal Builder</span>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={isViewer ? undefined : onNew} style={{ ...btnPrimary, opacity: isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }} disabled={isViewer}>+ New Submittal</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects..." style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...inputStyle, width: 180 }}>
            <option value="all">All Statuses</option>
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-muted)" }}>Loading projects...</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 60, color: "var(--text-secondary)" }}>
            {projects.length === 0 ? (
              <div>
                <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
                <div style={{ fontSize: 16, color: "var(--text-secondary)", marginBottom: 8 }}>No submittal projects yet</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>Start by selecting a Won project from the Proposal Log Dashboard</div>
                <button onClick={isViewer ? undefined : onNew} style={{ ...btnPrimary, opacity: isViewer ? 0.5 : 1, cursor: isViewer ? "not-allowed" : "pointer" }} disabled={isViewer}>+ New Submittal</button>
              </div>
            ) : "No projects match your filters."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((p) => {
              const sm = STATUS_META[p.submittalStatus] || STATUS_META.not_started;
              const scopeCount = p.scopes ? p.scopes.length : 0;
              const lineCount = p.scopes ? p.scopes.reduce((a, s) => a + (s.lines ? s.lines.length : 0), 0) : 0;
              const attachedCount = p.scopes ? p.scopes.reduce((a, s) => a + (s.lines ? s.lines.filter((l) => l.attachments && l.attachments.length > 0).length : 0), 0) : 0;
              const comp = lineCount > 0 ? pct(attachedCount, lineCount) : 0;

              return (
                <div key={p.id} onClick={() => onOpen(p.id)} style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderRadius: 8, cursor: "pointer", transition: "border-color .15s" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--gold)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-ds)"; }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)", marginBottom: 3 }}>{p.projectName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {p.gc}{p.attention ? " · " + p.attention : ""}{p.assignedPm ? " · PM: " + p.assignedPm : ""}
                      {p.estimateNumber && <span style={{ marginLeft: 8, color: "var(--gold)", fontFamily: "monospace", fontSize: 11 }}>{p.estimateNumber}</span>}
                      {p.region && <span style={{ marginLeft: 8, color: "var(--text-muted)", fontSize: 11 }}>{p.region}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", minWidth: 100 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{scopeCount} scopes · {lineCount} lines</div>
                    <div style={{ height: 4, width: 100, background: "var(--border-ds)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: comp + "%", background: comp === 100 ? "var(--success)" : "var(--gold)", borderRadius: 2 }} />
                    </div>
                  </div>
                  <span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg, whiteSpace: "nowrap" }}>{sm.label}</span>
                  <span style={{ fontSize: 11, color: "var(--text-secondary)", minWidth: 80, textAlign: "right" }}>{formatTimestamp(p.updatedAt)}</span>
                  <button onClick={(e) => { e.stopPropagation(); if (!isViewer && window.confirm("Delete this project?")) onDelete(p.id); }} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: isViewer ? "not-allowed" : "pointer", fontSize: 16, padding: 4, opacity: isViewer ? 0.4 : 1 }} title="Delete" disabled={isViewer}>&times;</button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
