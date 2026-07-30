import { useEffect, useRef } from "react";
import { LINE_STATUS, lineStatusMeta, inputStyle, btnGhost, uid, monoFont, disabledStyle } from "./helpers";
import type { Scope, SubmittalProject, LineStatus } from "@shared/submittal/types";

interface Props {
  scope: Scope;
  update: (fn: (p: SubmittalProject) => SubmittalProject) => void;
  scopeIdx: number;
  readOnly: boolean;
  /** Line to scroll to and highlight, set when jumping from validation. */
  focusLineId: string | null;
  onFocusHandled: () => void;
}

const GRID = "88px 18px 1fr 1fr 56px 150px 28px";

export default function ScheduleEditor({ scope, update, scopeIdx, readOnly, focusLineId, onFocusHandled }: Props) {
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusLineId) return;
    focusRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    const timer = setTimeout(onFocusHandled, 2500);
    return () => clearTimeout(timer);
  }, [focusLineId, onFocusHandled]);

  const editLine = (lineId: string, field: "callout" | "desc" | "model" | "qty" | "lineStatus", value: string) => {
    update((p) => {
      const line = p.scopes[scopeIdx].lines.find((x) => x.id === lineId);
      if (!line) return p;
      if (field === "lineStatus") line.lineStatus = value as LineStatus;
      else line[field] = value;
      return p;
    });
  };

  const addLine = () => {
    update((p) => {
      p.scopes[scopeIdx].lines.push({
        id: uid(), callout: "", desc: "", model: "", qty: "",
        lineStatus: "missing", sortOrder: p.scopes[scopeIdx].lines.length, attachments: [],
      });
      return p;
    });
  };

  const removeLine = (lineId: string) => {
    update((p) => {
      p.scopes[scopeIdx].lines = p.scopes[scopeIdx].lines.filter((l) => l.id !== lineId);
      p.scopes[scopeIdx].lines.forEach((l, i) => { l.sortOrder = i; });
      return p;
    });
  };

  const moveLine = (lineId: string, delta: number) => {
    update((p) => {
      const lines = p.scopes[scopeIdx].lines;
      const from = lines.findIndex((l) => l.id === lineId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= lines.length) return p;
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      lines.forEach((l, i) => { l.sortOrder = i; });
      return p;
    });
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{scope.tabName}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {scope.csi ? `CSI ${scope.csi} · ` : ""}{scope.lines.length} line{scope.lines.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={addLine} disabled={readOnly} style={{ ...btnGhost, fontSize: 12, ...disabledStyle(readOnly) }} data-testid="button-add-line">
          + Add Line
        </button>
      </div>

      {scope.lines.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", border: "1px dashed var(--border-ds)", borderRadius: 8, color: "var(--text-secondary)" }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>This scope has no line items yet.</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Add them by hand, or use Replace workbook to re-import the estimate.</div>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 2, padding: "6px 8px", background: "var(--bg3)", borderRadius: "6px 6px 0 0", fontSize: 10, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: ".5px" }}>
            <span>Callout</span><span aria-hidden="true" /><span>Description</span><span>Model Number</span><span>Qty</span><span>Status</span><span aria-hidden="true" />
          </div>

          {scope.lines.map((l, i) => {
            const ls = lineStatusMeta(l.lineStatus);
            const focused = l.id === focusLineId;
            return (
              <div
                key={l.id}
                ref={focused ? focusRef : undefined}
                data-testid={`row-line-${i}`}
                style={{
                  display: "grid", gridTemplateColumns: GRID, gap: 2, padding: "4px 8px",
                  background: focused ? "var(--warning-bg)" : i % 2 === 0 ? "var(--bg3)" : "var(--bg-card)",
                  borderLeft: focused ? "2px solid var(--gold)" : "1px solid var(--border-ds)",
                  borderRight: "1px solid var(--border-ds)",
                  borderBottom: "1px solid var(--border-ds)",
                  alignItems: "center",
                }}
              >
                <input
                  value={l.callout} disabled={readOnly} aria-label={`Callout for line ${i + 1}`}
                  onChange={(e) => editLine(l.id, "callout", e.target.value)}
                  style={{ ...inputStyle, fontSize: 11, fontFamily: monoFont, padding: "3px 6px" }}
                  data-testid={`input-callout-${i}`}
                />
                <span
                  title={`${ls.label} — ${ls.meaning}`}
                  style={{ width: 8, height: 8, borderRadius: 4, background: ls.color, display: "inline-block" }}
                  role="img" aria-label={ls.label}
                />
                <input
                  value={l.desc} disabled={readOnly} aria-label={`Description for line ${i + 1}`}
                  onChange={(e) => editLine(l.id, "desc", e.target.value)}
                  style={{ ...inputStyle, fontSize: 11, padding: "3px 6px" }}
                  data-testid={`input-desc-${i}`}
                />
                <input
                  value={l.model} disabled={readOnly} aria-label={`Model number for line ${i + 1}`}
                  onChange={(e) => editLine(l.id, "model", e.target.value)}
                  style={{ ...inputStyle, fontSize: 11, fontFamily: monoFont, padding: "3px 6px" }}
                  data-testid={`input-model-${i}`}
                />
                <input
                  value={String(l.qty ?? "")} disabled={readOnly} inputMode="decimal" aria-label={`Quantity for line ${i + 1}`}
                  onChange={(e) => editLine(l.id, "qty", e.target.value)}
                  style={{ ...inputStyle, fontSize: 11, padding: "3px 6px", textAlign: "center" }}
                  data-testid={`input-qty-${i}`}
                />
                <select
                  value={l.lineStatus} disabled={readOnly} aria-label={`Status for line ${i + 1}`}
                  onChange={(e) => editLine(l.id, "lineStatus", e.target.value)}
                  style={{ ...inputStyle, fontSize: 10, padding: "3px 4px" }}
                  data-testid={`select-status-${i}`}
                  title={ls.meaning}
                >
                  {Object.entries(LINE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                  <button
                    onClick={() => moveLine(l.id, -1)} disabled={readOnly || i === 0}
                    aria-label={`Move line ${i + 1} up`} title="Move up"
                    style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: readOnly || i === 0 ? "default" : "pointer", fontSize: 10, padding: 0, opacity: i === 0 ? 0.3 : 1 }}
                  >▲</button>
                  <button
                    onClick={() => removeLine(l.id)} disabled={readOnly}
                    aria-label={`Delete line ${i + 1}`} title="Delete line"
                    style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 14, padding: 0, ...disabledStyle(readOnly) }}
                    data-testid={`button-delete-line-${i}`}
                  >&times;</button>
                </div>
              </div>
            );
          })}

          <div style={{ padding: 8, background: "var(--bg3)", borderRadius: "0 0 6px 6px", border: "1px solid var(--border-ds)", borderTop: "none" }}>
            <button onClick={addLine} disabled={readOnly} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 11, ...disabledStyle(readOnly) }}>
              + Add line item
            </button>
          </div>
        </>
      )}
    </div>
  );
}
