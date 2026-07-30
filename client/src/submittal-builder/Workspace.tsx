import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { loadProject, saveProject, toPackage, readableError } from "./api";
import { computePagination, totalPackagePages } from "@shared/submittal/pagination";
import { validateProject } from "@shared/submittal/validation";
import { packageProgress, scopeProgress, type Scope, type SubmittalProject } from "@shared/submittal/types";
import type { ParsedSubmittalWorkbook } from "@shared/submittal/estimateParser";
import { uid, btnGhost, statusMeta, disabledStyle, monoFont } from "./helpers";
import StepRail, { type StepKey, type Step } from "./StepRail";
import ImportPanel from "./ImportPanel";
import ScheduleEditor from "./ScheduleEditor";
import ProductDataPanel from "./ProductDataPanel";
import CoverPageEditor from "./CoverPageEditor";
import ValidationPanel from "./ValidationPanel";
import PreviewExport from "./PreviewExport";

interface Props {
  projectId: string;
  onHome: () => void;
  flash: (msg: string, type?: string) => void;
  refreshProjects: () => void;
}

type SaveState = "saved" | "saving" | "unsaved" | "error";

const SAVE_DEBOUNCE_MS = 800;

const TABS: Array<{ key: string; label: string; step: StepKey }> = [
  { key: "schedule", label: "Schedule", step: "import" },
  { key: "productdata", label: "Product Data", step: "attach" },
  { key: "cover", label: "Cover Page", step: "review" },
  { key: "validation", label: "Validation", step: "review" },
  { key: "preview", label: "Preview / Export", step: "export" },
];

const STEP_TAB: Record<StepKey, string> = {
  import: "schedule",
  attach: "productdata",
  review: "validation",
  export: "preview",
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export default function Workspace({ projectId, onHome, flash, refreshProjects }: Props) {
  const { isViewer } = useAuth();
  const [project, setProject] = useState<SubmittalProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("schedule");
  const [activeScopeIdx, setActiveScopeIdx] = useState(0);
  const [reimporting, setReimporting] = useState(false);
  const [focusLineId, setFocusLineId] = useState<string | null>(null);

  // The debounce timer and the newest project both live in refs so a save can
  // be flushed from anywhere — including unmount, where edits used to be lost.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectRef = useRef<SubmittalProject | null>(null);
  const tabRef = useRef(activeTab);
  const scopeIdxRef = useRef(activeScopeIdx);

  useEffect(() => { projectRef.current = project; }, [project]);
  useEffect(() => { tabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { scopeIdxRef.current = activeScopeIdx; }, [activeScopeIdx]);

  useEffect(() => {
    let cancelled = false;
    loadProject(projectId)
      .then((p) => {
        if (cancelled) return;
        setProject(p);
        setActiveTab(p.lastActiveTab || "schedule");
        if (p.lastActiveScopeId && p.scopes) {
          const idx = p.scopes.findIndex((s) => s.id === p.lastActiveScopeId);
          if (idx >= 0) setActiveScopeIdx(idx);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(readableError(err, "Could not open this submittal."));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  // ---- Saving -------------------------------------------------------------

  const flush = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const current = projectRef.current;
    if (!current || isViewer) return true;

    setSaveState("saving");
    try {
      const scope = current.scopes?.[scopeIdxRef.current];
      const saved = await saveProject(current.id, {
        projectName: current.projectName,
        gc: current.gc,
        attention: current.attention,
        coverDate: current.coverDate,
        sourceFilename: current.sourceFilename ?? null,
        package: toPackage(current.scopes ?? [], {
          lastActiveScopeId: scope ? scope.id : null,
          lastActiveTab: tabRef.current,
          sourceFilename: current.sourceFilename ?? null,
        }),
      });
      setSaveState("saved");
      setSaveError(null);
      // Take the server's derived status/completion without touching scopes,
      // so an edit made while the request was in flight is not overwritten.
      setProject((prev) =>
        prev ? { ...prev, submittalStatus: saved.submittalStatus, completionPercent: saved.completionPercent, updatedAt: saved.updatedAt } : prev
      );
      refreshProjects();
      return true;
    } catch (err) {
      // A failed save must never look like a successful one.
      setSaveState("error");
      setSaveError(readableError(err, "Could not save — your changes are still on screen."));
      return false;
    }
  }, [isViewer, refreshProjects]);

  const scheduleSave = useCallback(() => {
    if (isViewer) return;
    setSaveState("unsaved");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush, isViewer]);

  /**
   * Apply an edit. The updater is pure — the old version called the save
   * routine from inside the setState updater, which set other state during
   * render and ran twice under StrictMode.
   */
  const update = useCallback((fn: (p: SubmittalProject) => SubmittalProject) => {
    if (isViewer) return;
    setProject((prev) => (prev ? fn(clone(prev)) : prev));
    scheduleSave();
  }, [isViewer, scheduleSave]);

  // Flush anything pending when leaving the workspace.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        void flush();
      }
    };
  }, [flush]);

  // ...and warn before the tab closes on top of an unsaved edit.
  useEffect(() => {
    if (saveState === "saved") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);

  const goHome = useCallback(async () => {
    await flush();
    onHome();
  }, [flush, onHome]);

  // ---- Import -------------------------------------------------------------

  const applyImport = useCallback((parsed: ParsedSubmittalWorkbook, fileName: string) => {
    update((p) => {
      p.scopes = parsed.scopes.map((s, i) => ({
        id: uid(),
        tabName: s.tab,
        scopeName: s.scopeName,
        csi: s.csi,
        specTitle: s.specTitle,
        sortOrder: i,
        scopeStatus: "in_progress",
        lines: s.lines.map((l, j) => ({
          id: uid(), callout: l.callout, desc: l.desc, model: l.model, qty: l.qty,
          lineStatus: "missing" as const, sortOrder: j, attachments: [],
        })),
        coverLines: [{ id: uid(), type: "Schedule", comment: "Page 2" }],
      }));
      p.sourceFilename = fileName;
      return p;
    });
    setActiveScopeIdx(0);
    setReimporting(false);
    setActiveTab("productdata");
    const lineTotal = parsed.scopes.reduce((sum, s) => sum + s.lines.length, 0);
    flash(`Imported ${parsed.scopes.length} scope${parsed.scopes.length === 1 ? "" : "s"} · ${lineTotal} line items`, "success");
  }, [update, flash]);

  // ---- Scope management ---------------------------------------------------

  const addScope = useCallback(() => {
    const name = window.prompt("Name for the new scope (e.g. Toilet Accessories)");
    if (!name || !name.trim()) return;
    update((p) => {
      p.scopes.push({
        id: uid(), tabName: name.trim(), csi: "", specTitle: name.trim(),
        sortOrder: p.scopes.length, scopeStatus: "in_progress",
        lines: [], coverLines: [{ id: uid(), type: "Schedule", comment: "Page 2" }],
      });
      return p;
    });
    setActiveScopeIdx((project?.scopes?.length ?? 0));
    setActiveTab("schedule");
  }, [update, project]);

  const renameScope = useCallback((scope: Scope) => {
    const name = window.prompt("Scope name", scope.tabName);
    if (!name || !name.trim()) return;
    update((p) => {
      const target = p.scopes.find((s) => s.id === scope.id);
      if (target) {
        target.tabName = name.trim();
        if (!target.specTitle) target.specTitle = name.trim();
      }
      return p;
    });
  }, [update]);

  const removeScope = useCallback((scope: Scope) => {
    const lineCount = scope.lines?.length ?? 0;
    if (!window.confirm(`Remove "${scope.tabName}" and its ${lineCount} line item${lineCount === 1 ? "" : "s"} from this package?`)) return;
    update((p) => {
      p.scopes = p.scopes.filter((s) => s.id !== scope.id);
      p.scopes.forEach((s, i) => { s.sortOrder = i; });
      return p;
    });
    setActiveScopeIdx((idx) => Math.max(0, idx - 1));
  }, [update]);

  // ---- Derived ------------------------------------------------------------

  const hasScopes = (project?.scopes?.length ?? 0) > 0;
  const scope: Scope | null = hasScopes && project
    ? project.scopes[Math.min(activeScopeIdx, project.scopes.length - 1)]
    : null;

  const pageInfo = useMemo(() => computePagination(scope), [scope]);
  const validation = useMemo(() => validateProject(project), [project]);
  const progress = useMemo(() => packageProgress(project?.scopes), [project]);

  const currentStep: StepKey = TABS.find((t) => t.key === activeTab)?.step ?? "import";

  const steps: Step[] = useMemo(() => {
    const exported = project?.submittalStatus === "exported";
    return [
      {
        key: "import", label: "Import estimate",
        detail: hasScopes ? `${project!.scopes.length} scope${project!.scopes.length === 1 ? "" : "s"} · ${progress.total} lines` : "No workbook yet",
        done: hasScopes, locked: false,
      },
      {
        key: "attach", label: "Attach product data",
        detail: hasScopes ? `${progress.resolved} of ${progress.total} resolved` : "—",
        done: hasScopes && progress.complete, locked: !hasScopes,
      },
      {
        key: "review", label: "Review & fix",
        detail: validation.blockers > 0
          ? `${validation.blockers} blocker${validation.blockers === 1 ? "" : "s"}`
          : validation.warnings.length > 0 ? `${validation.warnings.length} to check` : "Clean",
        done: hasScopes && progress.complete && validation.blockers === 0,
        locked: !hasScopes,
      },
      {
        key: "export", label: "Export package",
        detail: exported ? "Generated" : hasScopes ? `${totalPackagePages(project!.scopes)} pages` : "—",
        done: exported, locked: !hasScopes,
      },
    ];
  }, [hasScopes, project, progress, validation]);

  const nextAction = useMemo(() => {
    if (!hasScopes) {
      return { label: "Import", hint: "Import your estimate workbook to build the schedule.", step: "import" as StepKey };
    }
    if (validation.blockers > 0) {
      return { label: "Fix", hint: `${validation.blockers} thing${validation.blockers === 1 ? "" : "s"} must be fixed before this package can go out.`, step: "review" as StepKey };
    }
    if (!progress.complete) {
      const left = progress.outstanding;
      return { label: "Attach", hint: `${left} line${left === 1 ? "" : "s"} still need product data — attach a PDF, or mark them By Others / Not Required.`, step: "attach" as StepKey };
    }
    if (project?.submittalStatus !== "exported") {
      return { label: "Export", hint: "Everything is resolved. Generate the package PDF.", step: "export" as StepKey };
    }
    return null;
  }, [hasScopes, progress, validation.blockers, project?.submittalStatus]);

  const jumpToLine = useCallback((scopeId: string, lineId: string) => {
    const idx = project?.scopes?.findIndex((s) => s.id === scopeId) ?? -1;
    if (idx >= 0) setActiveScopeIdx(idx);
    setFocusLineId(lineId);
    setActiveTab("schedule");
  }, [project]);

  // ---- Render -------------------------------------------------------------

  if (loading) {
    return <div style={{ padding: 60, textAlign: "center", color: "var(--text-muted)" }}>Loading submittal…</div>;
  }
  if (loadError || !project) {
    return (
      <div style={{ padding: 60, textAlign: "center" }}>
        <div style={{ color: "var(--error)", marginBottom: 12 }}>{loadError || "Submittal not found."}</div>
        <button onClick={onHome} style={btnGhost}>← Back to submittals</button>
      </div>
    );
  }

  const sm = statusMeta(project.submittalStatus);
  const saveLabel =
    saveState === "saved" ? "✓ Saved"
    : saveState === "saving" ? "Saving…"
    : saveState === "error" ? "⚠ Not saved"
    : "● Unsaved";
  const saveColor =
    saveState === "saved" ? "var(--success)"
    : saveState === "error" ? "var(--error)"
    : saveState === "saving" ? "var(--gold)"
    : "var(--text-secondary)";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 57px)", background: "var(--bg-page)" }}>
      <ReadOnlyBanner />

      {/* Header */}
      <div style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", padding: "0 16px", display: "flex", alignItems: "center", height: 48, gap: 10, flexShrink: 0 }}>
        <button onClick={() => void goHome()} style={btnGhost} data-testid="button-back-to-list" aria-label="Back to submittals">←</button>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 4, height: 18, background: "var(--gold)", borderRadius: 1 }} />
          <span style={{ fontWeight: 800, fontSize: 13, color: "var(--text-primary)", fontFamily: "'Rajdhani', sans-serif" }}>AiPM</span>
        </div>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }} data-testid="text-project-name">{project.projectName}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{project.gc}</span>
        {project.estimateNumber && <span style={{ fontSize: 11, color: "var(--gold)", fontFamily: monoFont }}>{project.estimateNumber}</span>}
        <span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, color: sm.color, background: sm.bg, whiteSpace: "nowrap" }} title={sm.meaning} data-testid="badge-status">
          {sm.label}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: saveColor }} title={saveError ?? undefined} data-testid="text-save-state">{saveLabel}</span>
        <button
          onClick={() => { void flush().then((okSave) => flash(okSave ? "Saved" : "Could not save — check your connection", okSave ? "success" : "error")); }}
          disabled={isViewer}
          style={{ ...btnGhost, fontSize: 12, ...disabledStyle(isViewer) }}
          data-testid="button-save-draft"
        >
          Save Draft
        </button>
      </div>

      {saveError && (
        <div style={{ padding: "7px 16px", background: "var(--error-bg, rgba(192,57,43,.1))", borderBottom: "1px solid var(--error-border)", fontSize: 12, color: "var(--error)", flexShrink: 0 }} data-testid="text-save-error">
          {saveError} <button onClick={() => void flush()} style={{ ...btnGhost, fontSize: 11, marginLeft: 8 }}>Retry</button>
        </div>
      )}

      {/* Guided steps */}
      {hasScopes && !reimporting && (
        <StepRail steps={steps} current={currentStep} nextAction={nextAction} onGo={(s) => setActiveTab(STEP_TAB[s])} />
      )}

      {/* Step 1 — import */}
      {(!hasScopes || reimporting) && (
        <div style={{ flex: 1, overflowY: "auto" }}>
          <ImportPanel
            existingScopes={project.scopes?.length ?? 0}
            disabled={isViewer}
            onImport={applyImport}
            onCancel={reimporting ? () => setReimporting(false) : undefined}
          />
        </div>
      )}

      {hasScopes && !reimporting && (
        <>
          {/* Scope tabs */}
          <div style={{ background: "var(--bg3)", borderBottom: "1px solid var(--border-ds)", padding: "0 12px", display: "flex", alignItems: "center", gap: 0, overflowX: "auto", flexShrink: 0 }}>
            {project.scopes.map((s, i) => {
              const sp = scopeProgress(s);
              const isActive = i === activeScopeIdx;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveScopeIdx(i)}
                  data-testid={`tab-scope-${i}`}
                  style={{
                    padding: "8px 14px", fontSize: 12, fontWeight: isActive ? 700 : 400,
                    color: isActive ? "var(--gold)" : "var(--text-secondary)",
                    background: "none", border: "none", cursor: "pointer",
                    borderBottom: isActive ? "2px solid var(--gold)" : "2px solid transparent",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.tabName}
                  <span style={{ marginLeft: 6, fontSize: 10, color: sp.complete ? "var(--success)" : "var(--text-muted)" }}>
                    {sp.resolved}/{sp.total}
                  </span>
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            {!isViewer && (
              <>
                <button onClick={addScope} style={{ ...btnGhost, fontSize: 11, marginRight: 6 }} data-testid="button-add-scope">+ Scope</button>
                {scope && <button onClick={() => renameScope(scope)} style={{ ...btnGhost, fontSize: 11, marginRight: 6 }} data-testid="button-rename-scope">Rename</button>}
                {scope && <button onClick={() => removeScope(scope)} style={{ ...btnGhost, fontSize: 11, marginRight: 6 }} data-testid="button-remove-scope">Remove</button>}
                <button onClick={() => setReimporting(true)} style={{ ...btnGhost, fontSize: 11 }} data-testid="button-replace-workbook">Replace workbook</button>
              </>
            )}
          </div>

          {/* Detail tabs */}
          <div style={{ background: "var(--bg-card)", borderBottom: "1px solid var(--border-ds)", padding: "0 12px", display: "flex", gap: 0, flexShrink: 0 }}>
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                data-testid={`tab-${t.key}`}
                style={{
                  padding: "7px 14px", fontSize: 12, fontWeight: activeTab === t.key ? 600 : 400,
                  color: activeTab === t.key ? "var(--text-primary)" : "var(--text-muted)",
                  background: "none", border: "none", cursor: "pointer",
                  borderBottom: activeTab === t.key ? "2px solid var(--text-primary)" : "2px solid transparent",
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {activeTab === "schedule" && scope && (
              <ScheduleEditor
                scope={scope} update={update} scopeIdx={activeScopeIdx}
                readOnly={isViewer} focusLineId={focusLineId} onFocusHandled={() => setFocusLineId(null)}
              />
            )}
            {activeTab === "productdata" && scope && (
              <ProductDataPanel
                scope={scope} update={update} scopeIdx={activeScopeIdx} pageInfo={pageInfo}
                flash={flash} projectId={project.id} readOnly={isViewer}
              />
            )}
            {activeTab === "cover" && scope && (
              <CoverPageEditor
                scope={scope} project={project} update={update} scopeIdx={activeScopeIdx}
                pageInfo={pageInfo} readOnly={isViewer}
              />
            )}
            {activeTab === "validation" && (
              <ValidationPanel project={project} validation={validation} onJumpToLine={jumpToLine} />
            )}
            {activeTab === "preview" && scope && (
              <PreviewExport
                scope={scope} project={project} pageInfo={pageInfo} flash={flash}
                validation={validation} readOnly={isViewer}
                onBeforeExport={flush}
                onExported={() => { setProject((prev) => (prev ? { ...prev, submittalStatus: "exported" } : prev)); refreshProjects(); }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
