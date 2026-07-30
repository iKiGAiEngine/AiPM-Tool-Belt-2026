// Step 2 — attach product data.
//
// Attachments are now real. Dropped files used to be discarded (only the file
// name was kept), every attachment was recorded as exactly 2 pages, and the
// match badge always read a confident green EXACT regardless of what the file
// was. Files now upload to the server, their true page count comes back from
// pdf-lib, and the badge reflects an actual filename-to-model comparison.

import { useRef, useState } from "react";
import { lineStatusMeta, uid, monoFont, btnGhost, disabledStyle, formatBytes } from "./helpers";
import { uploadAttachment, deleteAttachment, attachmentUrl, readableError } from "./api";
import { isLineExcluded, type Scope, type SubmittalProject, type MatchStatus } from "@shared/submittal/types";
import type { PageInfo } from "@shared/submittal/pagination";

interface Props {
  scope: Scope;
  update: (fn: (p: SubmittalProject) => SubmittalProject) => void;
  scopeIdx: number;
  pageInfo: PageInfo;
  flash: (msg: string, type?: string) => void;
  projectId: string;
  readOnly: boolean;
}

const MATCH_META: Record<MatchStatus, { label: string; color: string; bg: string; title: string }> = {
  exact: { label: "MATCH", color: "var(--success)", bg: "var(--success-bg)", title: "The file name contains this line's model number." },
  partial: { label: "PARTIAL", color: "var(--gold)", bg: "var(--warning-bg)", title: "The file name only partly matches this line's model number — worth a look." },
  manual: { label: "MANUAL", color: "var(--text-secondary)", bg: "var(--bg3)", title: "The file name does not reference this line's model number." },
};

/** Compare the uploaded file name against the line's model number. */
export function deriveMatchStatus(fileName: string, model: string): MatchStatus {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const file = norm(fileName);
  const target = norm(model);
  if (!target || target.length < 3) return "manual";
  if (file.includes(target)) return "exact";
  // Vendor sheets are often named for the base model ("B-6806" for B-6806x36).
  const base = target.slice(0, Math.max(4, Math.floor(target.length * 0.6)));
  if (base.length >= 4 && file.includes(base)) return "partial";
  return "manual";
}

export default function ProductDataPanel({ scope, update, scopeIdx, pageInfo, flash, projectId, readOnly }: Props) {
  const [dragLineId, setDragLineId] = useState<string | null>(null);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const pickerRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const attachFiles = async (lineId: string, files: File[]) => {
    if (readOnly || files.length === 0) return;
    const line = scope.lines.find((l) => l.id === lineId);
    if (!line) return;

    setBusyLineId(lineId);
    setErrors((prev) => ({ ...prev, [lineId]: "" }));

    let attached = 0;
    for (const file of files) {
      const attachmentId = uid();
      try {
        const uploaded = await uploadAttachment(projectId, attachmentId, file);
        update((p) => {
          const target = p.scopes[scopeIdx].lines.find((x) => x.id === lineId);
          if (!target) return p;
          target.attachments.push({
            id: attachmentId,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType ?? "application/pdf",
            pageCount: uploaded.pageCount,
            calloutStamp: target.callout,
            matchStatus: deriveMatchStatus(uploaded.fileName, target.model),
            sortOrder: target.attachments.length,
            stored: true,
          });
          if (target.lineStatus === "missing" || target.lineStatus === "pending") target.lineStatus = "attached";
          return p;
        });
        attached++;
      } catch (err) {
        setErrors((prev) => ({ ...prev, [lineId]: readableError(err, `Could not attach ${file.name}`) }));
      }
    }

    setBusyLineId(null);
    if (attached > 0) {
      flash(`${attached} file${attached === 1 ? "" : "s"} attached to ${line.callout || "line"}`, "success");
    }
  };

  const removeAttachment = async (lineId: string, attId: string) => {
    if (readOnly) return;
    try {
      await deleteAttachment(projectId, attId);
    } catch (err) {
      // The metadata is what drives the package, so drop it either way and say so.
      flash(readableError(err, "The file could not be removed from storage"), "error");
    }
    update((p) => {
      const line = p.scopes[scopeIdx].lines.find((x) => x.id === lineId);
      if (!line) return p;
      line.attachments = line.attachments.filter((a) => a.id !== attId);
      if (line.attachments.length === 0 && line.lineStatus === "attached") line.lineStatus = "missing";
      return p;
    });
  };

  const setStatus = (lineId: string, status: "not_required" | "by_others" | "missing") => {
    update((p) => {
      const line = p.scopes[scopeIdx].lines.find((x) => x.id === lineId);
      if (line) line.lineStatus = status;
      return p;
    });
  };

  const outstanding = scope.lines.filter((l) => !isLineExcluded(l) && (l.attachments?.length ?? 0) === 0).length;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
        Product Data — {scope.tabName}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 16 }}>
        {pageInfo.attachments.length} file{pageInfo.attachments.length === 1 ? "" : "s"} attached ·
        {" "}{pageInfo.total} page{pageInfo.total === 1 ? "" : "s"} in this package ·
        {" "}{outstanding === 0 ? "nothing outstanding" : `${outstanding} line${outstanding === 1 ? "" : "s"} still to resolve`}
      </div>

      {scope.lines.map((l) => {
        const ls = lineStatusMeta(l.lineStatus);
        const excluded = isLineExcluded(l);
        const busy = busyLineId === l.id;
        const error = errors[l.id];

        return (
          <div key={l.id} style={{ marginBottom: 10 }} data-testid={`product-data-line-${l.callout || l.id}`}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg3)", borderRadius: l.attachments?.length ? "6px 6px 0 0" : 6, border: "1px solid var(--border-ds)" }}>
              <span title={`${ls.label} — ${ls.meaning}`} role="img" aria-label={ls.label}
                style={{ width: 8, height: 8, borderRadius: 4, background: ls.color, flexShrink: 0, display: "inline-block" }} />
              <span style={{ fontFamily: monoFont, fontSize: 11, fontWeight: 700, color: "var(--gold)", width: 60, flexShrink: 0 }}>{l.callout}</span>
              <span style={{ fontSize: 12, color: "var(--text-primary)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.desc}</span>
              <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: monoFont }}>{l.model}</span>
              {excluded && (
                <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 3, background: "var(--bg-card)", color: "var(--text-secondary)", border: "1px solid var(--border-ds)" }}>
                  {ls.label}
                </span>
              )}
            </div>

            {(l.attachments ?? []).map((a) => {
              const pi = pageInfo.attachments.find((x) => x.id === a.id);
              const match = MATCH_META[a.matchStatus] ?? MATCH_META.manual;
              return (
                <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px 6px 42px", background: "var(--bg-card)", borderLeft: "1px solid var(--border-ds)", borderRight: "1px solid var(--border-ds)", borderBottom: "1px solid var(--border-ds)" }}>
                  <span aria-hidden="true" style={{ fontSize: 13 }}>📄</span>
                  <a
                    href={attachmentUrl(projectId, a.id)} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: "var(--text-primary)", flex: 1, textDecoration: "none" }}
                    title="Open this PDF"
                    data-testid={`link-attachment-${a.id}`}
                  >
                    {a.fileName}
                  </a>
                  <span title={match.title} style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: match.bg, color: match.color }}>
                    {match.label}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: monoFont }}>{a.pageCount}pg</span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    {pi ? `Pg ${pi.startPage}${pi.endPage > pi.startPage ? `–${pi.endPage}` : ""}` : ""}
                  </span>
                  <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "var(--warning-bg)", color: "var(--gold)" }}>
                    Stamp: {a.calloutStamp || "—"}
                  </span>
                  <button
                    onClick={() => void removeAttachment(l.id, a.id)} disabled={readOnly}
                    aria-label={`Remove ${a.fileName}`} title="Remove this file"
                    style={{ background: "none", border: "none", color: "var(--text-secondary)", cursor: readOnly ? "not-allowed" : "pointer", fontSize: 13, ...disabledStyle(readOnly) }}
                    data-testid={`button-remove-attachment-${a.id}`}
                  >&times;</button>
                </div>
              );
            })}

            <div
              onDragOver={(e) => { e.preventDefault(); if (!readOnly) setDragLineId(l.id); }}
              onDragLeave={() => setDragLineId(null)}
              onDrop={(e) => { e.preventDefault(); setDragLineId(null); void attachFiles(l.id, Array.from(e.dataTransfer?.files ?? [])); }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 12px 6px 42px",
                background: dragLineId === l.id ? "var(--warning-bg)" : "transparent",
                borderLeft: "1px solid var(--border-ds)", borderRight: "1px solid var(--border-ds)",
                borderBottom: "1px solid var(--border-ds)", borderRadius: "0 0 6px 6px",
                transition: "background .15s",
              }}
            >
              <input
                ref={(el) => { pickerRefs.current[l.id] = el; }}
                type="file" accept="application/pdf,.pdf" multiple style={{ display: "none" }}
                onChange={(e) => { void attachFiles(l.id, Array.from(e.target.files ?? [])); e.target.value = ""; }}
                data-testid={`input-attach-${l.callout || l.id}`}
              />
              <button
                onClick={() => pickerRefs.current[l.id]?.click()} disabled={readOnly || busy}
                style={{ ...btnGhost, fontSize: 11, padding: "3px 10px", ...disabledStyle(readOnly || busy) }}
                data-testid={`button-attach-${l.callout || l.id}`}
              >
                {busy ? "Uploading…" : "Attach PDF"}
              </button>
              <span style={{ fontSize: 11, color: dragLineId === l.id ? "var(--gold)" : "var(--text-muted)" }}>
                {dragLineId === l.id ? "Drop the PDF here" : "or drop a file here"}
              </span>

              {!excluded && (l.attachments?.length ?? 0) === 0 && !readOnly && (
                <>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: "var(--text-muted)" }}>No product data needed?</span>
                  <button onClick={() => setStatus(l.id, "by_others")} style={{ ...btnGhost, fontSize: 10, padding: "2px 8px" }} data-testid={`button-by-others-${l.callout || l.id}`}>By Others</button>
                  <button onClick={() => setStatus(l.id, "not_required")} style={{ ...btnGhost, fontSize: 10, padding: "2px 8px" }} data-testid={`button-not-required-${l.callout || l.id}`}>Not Required</button>
                </>
              )}
              {excluded && !readOnly && (
                <>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setStatus(l.id, "missing")} style={{ ...btnGhost, fontSize: 10, padding: "2px 8px" }}>Undo</button>
                </>
              )}
            </div>

            {error && (
              <div style={{ padding: "4px 12px 4px 42px", fontSize: 11, color: "var(--error)" }} data-testid={`text-attach-error-${l.id}`}>
                {error}
              </div>
            )}
          </div>
        );
      })}

      {scope.lines.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)", border: "1px dashed var(--border-ds)", borderRadius: 8 }}>
          This scope has no line items to attach product data to.
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 10, color: "var(--text-muted)" }}>
        Product data must be a PDF, up to {formatBytes(60 * 1024 * 1024)} each.
      </div>
    </div>
  );
}
