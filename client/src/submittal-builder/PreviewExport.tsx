// Step 4 — preview and export.
//
// "Generate Final Package" now generates a package. It used to flip a status
// field and flash "PDF generation is a Phase 2 feature" — and even the status
// did not stick, because the auto-save recomputed it a moment later.

import { useState } from "react";
import { LINES_PER_SCHEDULE_PAGE, type PageInfo } from "@shared/submittal/pagination";
import type { ValidationResult } from "@shared/submittal/validation";
import type { Scope, SubmittalProject, ScheduleLine } from "@shared/submittal/types";
import { exportPackage, downloadBlob, readableError } from "./api";
import { btnPrimary, btnGhost, cardStyle, disabledStyle } from "./helpers";

const thS: React.CSSProperties = { border: "1px solid #999", padding: "3px 4px", fontSize: 8, fontWeight: 700, textAlign: "center", background: "#e8e8e8", color: "#000" };
const tdS: React.CSSProperties = { border: "1px solid #bbb", padding: "3px 4px", fontSize: 8, textAlign: "center", verticalAlign: "top", color: "#000" };

function PageFrame({ num, total, label, children }: { num: number; total: number; label: string; children: React.ReactNode }) {
  return (
    <div style={{ width: 520, background: "#fff", borderRadius: 3, boxShadow: "0 2px 16px rgba(0,0,0,.25)", overflow: "hidden", position: "relative", minHeight: 600 }}>
      <div style={{ position: "absolute", top: 4, left: 6, fontSize: 8, fontWeight: 700, color: "#fff", background: "#1A2E44", padding: "1px 6px", borderRadius: 2, opacity: 0.7 }}>{label}</div>
      {children}
      <div style={{ position: "absolute", bottom: 6, right: 12, fontSize: 9, color: "#999" }}>Page {num} of {total}</div>
    </div>
  );
}

interface Props {
  scope: Scope;
  project: SubmittalProject;
  pageInfo: PageInfo;
  validation: ValidationResult;
  flash: (msg: string, type?: string) => void;
  readOnly: boolean;
  /** Flush pending edits so the server exports what is on screen. */
  onBeforeExport: () => Promise<boolean>;
  onExported: () => void;
}

export default function PreviewExport({ scope, project, pageInfo, validation, flash, readOnly, onBeforeExport, onExported }: Props) {
  const [busy, setBusy] = useState<"scope" | "all" | null>(null);

  const runExport = async (mode: "scope" | "all") => {
    if (readOnly) return;
    setBusy(mode);
    try {
      // Export builds from the saved package, so any pending edit must land first.
      const saved = await onBeforeExport();
      if (!saved) {
        flash("Your latest changes could not be saved — export cancelled.", "error");
        return;
      }
      const result = await exportPackage(project.id, mode === "scope" ? scope.id : undefined);
      downloadBlob(result.blob, result.fileName);
      if (result.problems.length > 0) {
        flash(`Package generated, but ${result.problems.length} attachment${result.problems.length === 1 ? "" : "s"} could not be merged`, "error");
      } else {
        flash(mode === "all" ? "All scope packages generated" : "Package generated", "success");
      }
      onExported();
    } catch (err) {
      flash(readableError(err, "Could not generate the package"), "error");
    } finally {
      setBusy(null);
    }
  };

  const schedulePages: Array<{ pageNum: number; lines: ScheduleLine[] }> = [];
  for (let p = 0; p < pageInfo.schedulePages; p++) {
    const start = p * LINES_PER_SCHEDULE_PAGE;
    schedulePages.push({
      pageNum: 2 + p,
      lines: scope.lines.slice(start, Math.min(start + LINES_PER_SCHEDULE_PAGE, scope.lines.length)),
    });
  }

  const emptyCoverRows = Math.max(0, 5 - (scope.coverLines?.length ?? 0));
  const blocked = validation.blockers > 0;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>Preview — {scope.tabName}</span>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{pageInfo.total} pages</span>
        <div style={{ flex: 1 }} />
        {project.scopes.length > 1 && (
          <button
            onClick={() => void runExport("all")}
            disabled={readOnly || busy !== null}
            style={{ ...btnGhost, ...disabledStyle(readOnly || busy !== null) }}
            data-testid="button-export-all"
          >
            {busy === "all" ? "Generating…" : `Download all ${project.scopes.length} scopes (.zip)`}
          </button>
        )}
        <button
          onClick={() => void runExport("scope")}
          disabled={readOnly || busy !== null}
          style={{ ...btnPrimary, ...disabledStyle(readOnly || busy !== null) }}
          data-testid="button-generate-package"
        >
          {busy === "scope" ? "Generating…" : "Generate package PDF"}
        </button>
      </div>

      {blocked && (
        <div style={{ ...cardStyle, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "var(--text-primary)", background: "var(--warning-bg)" }}>
          Validation found {validation.blockers} thing{validation.blockers === 1 ? "" : "s"} to fix. You can still export, but the package will go out with them.
        </div>
      )}

      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 16 }}>
        This preview shows the layout. The generated PDF merges the real product data
        sheets and stamps each one with its callout.
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
        <PageFrame num={1} total={pageInfo.total} label="COVER">
          <div style={{ padding: "20px 24px", fontSize: 10, color: "#222", lineHeight: 1.8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
              <div style={{ width: 4, height: 16, background: "#BF9B30" }} />
              <b style={{ fontSize: 13 }}>NBS</b>
            </div>
            <div style={{ borderBottom: "2px solid #BF9B30", marginBottom: 10 }} />
            <b style={{ fontSize: 14 }}>Submittal Transmittal</b><br /><br />
            <b>DATE:</b> {project.coverDate}<br />
            <b>PROJECT:</b> {project.projectName}<br />
            <b>SPEC SECTION:</b> {[scope.csi, scope.specTitle].filter(Boolean).join(" — ")}<br /><br />
            <b>SUBMITTED BY:</b> National Building Specialties<br />
            &nbsp;&nbsp;&nbsp;&nbsp;4130 Flat Rock Drive, #110<br />
            &nbsp;&nbsp;&nbsp;&nbsp;Riverside, CA 92505<br /><br />
            <b>SUBMITTED TO:</b> {project.gc}<br /><br />
            <b>ATTENTION:</b> {project.attention}
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 9 }}>
              <thead>
                <tr style={{ background: "#f0f0f0" }}>
                  <th style={thS}>Spec Section</th><th style={thS}>Description</th><th style={thS}>Type</th><th style={thS}>Comments</th>
                </tr>
              </thead>
              <tbody>
                {(scope.coverLines ?? []).map((c) => (
                  <tr key={c.id}>
                    <td style={tdS}>{scope.csi}</td>
                    <td style={{ ...tdS, fontWeight: 600 }}>{scope.specTitle || scope.tabName}</td>
                    <td style={tdS}>{c.type}</td>
                    <td style={tdS}>{c.comment}</td>
                  </tr>
                ))}
                {Array.from({ length: emptyCoverRows }).map((_, i) => (
                  <tr key={"e" + i}><td style={tdS}>&nbsp;</td><td style={tdS} /><td style={tdS} /><td style={tdS} /></tr>
                ))}
              </tbody>
            </table>
          </div>
        </PageFrame>

        {schedulePages.map((sp, si) => (
          <PageFrame key={si} num={sp.pageNum} total={pageInfo.total} label={si === 0 ? "SCHEDULE" : "SCHEDULE (cont.)"}>
            <div style={{ padding: "16px 20px", textAlign: "center" }}>
              <b style={{ fontSize: 13, color: "#111" }}>{project.projectName}</b><br />
              <b style={{ fontSize: 11, color: "#111" }}>{scope.specTitle || scope.tabName} Schedule</b>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 8, marginTop: 10 }}>
                <thead>
                  <tr style={{ background: "#f0f0f0" }}>
                    <th style={thS}>SPEC No.</th><th style={thS}>SPEC TITLE</th><th style={thS}>CALLOUT</th>
                    <th style={thS}>DESCRIPTION</th><th style={thS}>MODEL</th><th style={thS}>QTY</th>
                  </tr>
                </thead>
                <tbody>
                  {sp.lines.map((l) => (
                    <tr key={l.id}>
                      <td style={tdS}>{scope.csi}</td>
                      <td style={tdS}>{scope.specTitle}</td>
                      <td style={tdS}>{l.callout}</td>
                      <td style={{ ...tdS, textAlign: "left", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }}>{l.desc}</td>
                      <td style={{ ...tdS, textAlign: "left", fontSize: 7 }}>{l.model}</td>
                      <td style={tdS}>{l.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageFrame>
        ))}

        {pageInfo.attachments.map((a) => (
          <PageFrame key={a.id} num={a.startPage} total={pageInfo.total} label={"PRODUCT DATA — " + a.callout}>
            <div style={{ padding: 20, textAlign: "center", position: "relative" }}>
              <div style={{ position: "absolute", top: 6, right: 10, padding: "2px 8px", borderRadius: 3, background: "#BF9B30", color: "#000", fontSize: 8, fontWeight: 800 }}>{a.calloutStamp || a.callout}</div>
              <div style={{ fontSize: 32, color: "#ccc", margin: "30px 0 10px" }}>📄</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#333" }}>{a.fileName}</div>
              <div style={{ fontSize: 9, color: "#888", marginTop: 3 }}>
                {a.pageCount} page{a.pageCount > 1 ? "s" : ""}{a.model ? ` · ${a.model}` : ""}
                {a.endPage > a.startPage ? ` · pages ${a.startPage}–${a.endPage}` : ""}
              </div>
            </div>
          </PageFrame>
        ))}
      </div>
    </div>
  );
}
