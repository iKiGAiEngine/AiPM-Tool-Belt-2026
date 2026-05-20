import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { loadProject, saveProject } from "./storage";
import { parseEstimateWorkbook } from "./estimateParser";
import { computePagination } from "./pagination";
import { uid, now, pct, btnGhost } from "./helpers";
import ScheduleEditor from "./ScheduleEditor";
import ProductDataPanel from "./ProductDataPanel";
import CoverPageEditor from "./CoverPageEditor";
import ValidationPanel from "./ValidationPanel";
import PreviewExport from "./PreviewExport";
import type { SubmittalProject } from "./types";

interface Props {
  projectId: string;
  onHome: () => void;
  flash: (msg: string, type?: string) => void;
  refreshProjects: () => void;
}

export default function Workspace({ projectId, onHome, flash, refreshProjects }: Props) {
  const { isViewer } = useAuth();
  const [project, setProject] = useState<SubmittalProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"saved" | "saving" | "unsaved">("saved");
  const [activeTab, setActiveTab] = useState("schedule");
  const [activeScopeIdx, setActiveScopeIdx] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadProject(projectId).then((p) => {
      if (p) {
        setProject(p);
        setActiveTab(p.lastActiveTab || "schedule");
        if (p.lastActiveScopeId && p.scopes) {
          const idx = p.scopes.findIndex((s) => s.id === p.lastActiveScopeId);
          if (idx >= 0) setActiveScopeIdx(idx);
        }
      }
      setLoading(false);
    });
  }, [projectId]);

  const triggerSave = useCallback((updated: SubmittalProject) => {
    if (isViewer) { setSaving("saved"); return; }
    setSaving("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSaving("saving");
      const scope = updated.scopes && updated.scopes[activeScopeIdx] ? updated.scopes[activeScopeIdx] : null;
      const toSave = { ...updated, lastActiveScopeId: scope ? scope.id : null, lastActiveTab: activeTab, lastOpenedAt: now() };
      let totalLines = 0, attachedLines = 0;
      if (toSave.scopes) {
        toSave.scopes.forEach((s) => {
          if (s.lines) {
            totalLines += s.lines.length;
            s.lines.forEach((l) => { if (l.attachments && l.attachments.length > 0) attachedLines++; });
          }
        });
      }
      toSave.completionPercent = totalLines > 0 ? pct(attachedLines, totalLines) : 0;
      if (!toSave.scopes || toSave.scopes.length === 0) toSave.submittalStatus = "not_started";
      else if (attachedLines === 0) toSave.submittalStatus = "in_progress";
      else if (attachedLines < totalLines) toSave.submittalStatus = "waiting_product_data";
      else toSave.submittalStatus = "ready_for_review";
      saveProject(toSave).then(() => setSaving("saved"));
    }, 800);
  }, [activeScopeIdx, activeTab]);

  const update = (fn: (p: SubmittalProject) => SubmittalProject) => {
    setProject((prev) => {
      const next = fn(JSON.parse(JSON.stringify(prev)));
      triggerSave(next);
      return next;
    });
  };

  const handleEstimateDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer ? e.dataTransfer.files : []);
    if (files.length === 0) return;
    const file = files[0] as File;
    if (!file || typeof file.arrayBuffer !== "function") {
      flash("Could not read file — please drop a real .xlsm or .xlsx file.", "error");
      return;
    }
    flash("Parsing estimate workbook...", "info");
    parseEstimateWorkbook(file).then((parsed) => {
      update((p) => {
        p.scopes = parsed.scopes.map((s, i) => ({
          id: uid(), tabName: s.tab, csi: s.csi, specTitle: s.specTitle, sortOrder: i, scopeStatus: "in_progress",
          lines: s.lines.map((l, j) => ({ id: uid(), callout: l.callout, desc: l.desc, model: l.model, qty: l.qty, lineStatus: "missing", sortOrder: j, attachments: [] })),
          coverLines: [{ id: uid(), spec: s.csi, desc: s.tab, type: "Schedule", comment: "Page 2" }],
        }));
        p.submittalStatus = "in_progress";
        return p;
      });
      const lineTotal = parsed.scopes.reduce((a, s) => a + s.lines.length, 0);
      flash("Parsed " + parsed.scopes.length + " scopes, " + lineTotal + " line items", "success");
    });
  };

  if (loading) return <div style={{ padding: 60, textAlign: "center", color: "#64748b" }}>Loading project...</div>;
  if (!project) return <div style={{ padding: 60, textAlign: "center", color: "#ef4444" }}>Project not found.</div>;

  const hasScopes = project.scopes && project.scopes.length > 0;
  const scope = hasScopes ? project.scopes[Math.min(activeScopeIdx, project.scopes.length - 1)] : null;
  const pageInfo = computePagination(scope);

  const tabs = [
    { key: "schedule", label: "Schedule" },
    { key: "productdata", label: "Product Data" },
    { key: "cover", label: "Cover Page" },
    { key: "validation", label: "Validation" },
    { key: "preview", label: "Preview / Export" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 57px)", background: "var(--bg-page)" }}>
      <ReadOnlyBanner />
      <div style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", padding: "0 16px", display: "flex", alignItems: "center", height: 48, gap: 10, flexShrink: 0 }}>
        <button onClick={onHome} style={btnGhost}>&larr;</button>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 4, height: 18, background: "var(--gold)", borderRadius: 1 }} />
          <span style={{ fontWeight: 800, fontSize: 13, color: "var(--text-primary)", fontFamily: "'Rajdhani', sans-serif" }}>AiPM</span>
        </div>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{project.projectName}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{project.gc}</span>
        {project.estimateNumber && <span style={{ fontSize: 11, color: "var(--gold)", fontFamily: "monospace" }}>{project.estimateNumber}</span>}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: saving === "saved" ? "var(--success)" : saving === "saving" ? "var(--warning)" : "var(--text-secondary)" }}>
          {saving === "saved" ? "✓ Saved" : saving === "saving" ? "Saving..." : "● Unsaved"}
        </span>
        <button onClick={() => { triggerSave(project); flash("Saved", "success"); }} style={{ ...btnGhost, fontSize: 12 }}>Save Draft</button>
      </div>

      {!hasScopes && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }} onDragOver={(e) => e.preventDefault()} onDrop={handleEstimateDrop}>
          <div style={{ width: 480, textAlign: "center", padding: 40, border: "2px dashed var(--border-ds)", borderRadius: 16, background: "var(--bg-card)" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>Drop Estimate Workbook to Begin</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              Drag your .xlsm or .xlsx estimate file here.<br />
              The system will auto-detect scope tabs, CSI sections, and line items.
            </div>
          </div>
        </div>
      )}

      {hasScopes && (
        <>
          <div style={{ background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)", padding: "0 12px", display: "flex", gap: 0, overflowX: "auto", flexShrink: 0 }}>
            {project.scopes.map((s, i) => {
              const att = s.lines ? s.lines.filter((l) => l.attachments && l.attachments.length > 0).length : 0;
              const tot = s.lines ? s.lines.length : 0;
              const isActive = i === activeScopeIdx;
              return (
                <button key={s.id} onClick={() => setActiveScopeIdx(i)} style={{ padding: "8px 14px", fontSize: 12, fontWeight: isActive ? 700 : 400, color: isActive ? "var(--gold)" : "var(--text-secondary)", background: "none", border: "none", cursor: "pointer", borderBottom: isActive ? "2px solid var(--gold)" : "2px solid transparent", whiteSpace: "nowrap" }}>
                  {s.tabName}<span style={{ marginLeft: 6, fontSize: 10, color: att === tot ? "var(--success)" : "var(--text-muted)" }}>{att}/{tot}</span>
                </button>
              );
            })}
          </div>

          <div style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", padding: "0 12px", display: "flex", gap: 0, flexShrink: 0 }}>
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ padding: "7px 14px", fontSize: 12, fontWeight: activeTab === t.key ? 600 : 400, color: activeTab === t.key ? "var(--text-primary)" : "var(--text-muted)", background: "none", border: "none", cursor: "pointer", borderBottom: activeTab === t.key ? "2px solid var(--text-primary)" : "2px solid transparent" }}>{t.label}</button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {activeTab === "schedule" && scope && <ScheduleEditor scope={scope} update={update} scopeIdx={activeScopeIdx} />}
            {activeTab === "productdata" && scope && <ProductDataPanel scope={scope} update={update} scopeIdx={activeScopeIdx} pageInfo={pageInfo} flash={flash} />}
            {activeTab === "cover" && scope && <CoverPageEditor scope={scope} project={project} update={update} scopeIdx={activeScopeIdx} pageInfo={pageInfo} />}
            {activeTab === "validation" && <ValidationPanel project={project} />}
            {activeTab === "preview" && scope && <PreviewExport scope={scope} project={project} pageInfo={pageInfo} update={update} flash={flash} />}
          </div>
        </>
      )}
    </div>
  );
}
