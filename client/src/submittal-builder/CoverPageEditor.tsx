import { uid, inputStyle, btnGhost, cardStyle, disabledStyle, monoFont } from "./helpers";
import { computePagination, type PageInfo } from "@shared/submittal/pagination";
import type { Scope, SubmittalProject, CoverRowType } from "@shared/submittal/types";

interface Props {
  scope: Scope;
  project: SubmittalProject;
  update: (fn: (p: SubmittalProject) => SubmittalProject) => void;
  scopeIdx: number;
  pageInfo: PageInfo;
  readOnly: boolean;
}

const ROW_TYPES: CoverRowType[] = ["Schedule", "Product Data", "Color Chart", "Shop Drawings"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textAlign: "right" }}>{label}</label>
      {children}
    </>
  );
}

export default function CoverPageEditor({ scope, project, update, scopeIdx, pageInfo, readOnly }: Props) {
  const editProject = (field: "coverDate" | "projectName" | "gc" | "attention", value: string) => {
    update((p) => { p[field] = value; return p; });
  };

  const addRow = () => {
    update((p) => {
      p.scopes[scopeIdx].coverLines.push({ id: uid(), type: "Product Data", comment: "" });
      return p;
    });
  };

  const removeRow = (rowId: string) => {
    update((p) => {
      p.scopes[scopeIdx].coverLines = p.scopes[scopeIdx].coverLines.filter((c) => c.id !== rowId);
      return p;
    });
  };

  const editRow = (rowId: string, field: "type" | "comment", value: string) => {
    update((p) => {
      const row = p.scopes[scopeIdx].coverLines.find((x) => x.id === rowId);
      if (row) row[field] = value;
      return p;
    });
  };

  /** Rebuild the contents table from the package's real page numbers. */
  const autoGen = () => {
    update((p) => {
      const s = p.scopes[scopeIdx];
      const pi = computePagination(s);
      const rows = [{
        id: uid(), type: "Schedule" as CoverRowType,
        comment: pi.schedulePages > 1 ? `Pages 2–${pi.scheduleEnd}` : "Page 2",
      }];
      if (pi.attachments.length > 0) {
        const first = pi.attachments[0].startPage;
        const last = pi.attachments[pi.attachments.length - 1].endPage;
        rows.push({
          id: uid(), type: "Product Data" as CoverRowType,
          comment: first === last ? `Page ${first}` : `Pages ${first}–${last}`,
        });
      }
      s.coverLines = rows;
      return p;
    });
  };

  return (
    <div style={{ padding: 20, maxWidth: 700 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Cover Page — {scope.tabName}</span>
        <div style={{ flex: 1 }} />
        <button onClick={autoGen} disabled={readOnly} style={{ ...btnGhost, fontSize: 11, ...disabledStyle(readOnly) }} data-testid="button-autogen-cover">
          Auto-generate from pages
        </button>
      </div>

      <div style={{ ...cardStyle, padding: 14, marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: ".5px" }}>
          Project Info — appears on every scope's cover
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "8px 10px", alignItems: "center" }}>
          <Field label="DATE:">
            <input value={project.coverDate || ""} disabled={readOnly} onChange={(e) => editProject("coverDate", e.target.value)} style={inputStyle} data-testid="input-cover-date" />
          </Field>
          <Field label="PROJECT:">
            <input value={project.projectName} disabled={readOnly} onChange={(e) => editProject("projectName", e.target.value)} style={inputStyle} data-testid="input-cover-project" />
          </Field>
          <Field label="SUBMITTED TO:">
            <input value={project.gc} disabled={readOnly} onChange={(e) => editProject("gc", e.target.value)} style={inputStyle} data-testid="input-cover-gc" />
          </Field>
          <Field label="ATTENTION:">
            <input value={project.attention} disabled={readOnly} onChange={(e) => editProject("attention", e.target.value)} style={inputStyle} placeholder="Who at the GC is receiving this" data-testid="input-cover-attention" />
          </Field>
        </div>
      </div>

      <div style={{ ...cardStyle, padding: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: ".5px" }}>
          Contents table ({pageInfo.total} pages in this package)
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
          Spec section and description come from the scope. Auto-generate fills the
          page references from the real page count of every attached PDF.
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "70px 1fr 120px 110px 24px", gap: 6, padding: "4px 0", fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>
          <span>Spec</span><span>Description</span><span>Type</span><span>Comments</span><span aria-hidden="true" />
        </div>
        {(scope.coverLines ?? []).map((cl, i) => (
          <div key={cl.id} style={{ display: "grid", gridTemplateColumns: "70px 1fr 120px 110px 24px", gap: 6, padding: "3px 0", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: monoFont }}>{scope.csi || "—"}</span>
            <span style={{ fontSize: 11, color: "var(--text-primary)", fontWeight: 600 }}>{scope.specTitle || scope.tabName}</span>
            <select value={cl.type} disabled={readOnly} onChange={(e) => editRow(cl.id, "type", e.target.value)} style={{ ...inputStyle, fontSize: 10 }} aria-label={`Type for cover row ${i + 1}`} data-testid={`select-cover-type-${i}`}>
              {ROW_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={cl.comment || ""} disabled={readOnly} onChange={(e) => editRow(cl.id, "comment", e.target.value)} style={{ ...inputStyle, fontSize: 10 }} placeholder="Page X" aria-label={`Comment for cover row ${i + 1}`} data-testid={`input-cover-comment-${i}`} />
            <button onClick={() => removeRow(cl.id)} disabled={readOnly} aria-label={`Remove cover row ${i + 1}`} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 13, ...disabledStyle(readOnly) }}>&times;</button>
          </div>
        ))}
        <button onClick={addRow} disabled={readOnly} style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 11, marginTop: 8, ...disabledStyle(readOnly) }} data-testid="button-add-cover-row">
          + Add row
        </button>
      </div>
    </div>
  );
}
