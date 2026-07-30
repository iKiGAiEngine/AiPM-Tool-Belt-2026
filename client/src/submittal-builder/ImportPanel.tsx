// Step 1 — import the estimate workbook.
//
// Two things this fixes. Drag-and-drop used to be the ONLY way in, which locks
// out anyone who cannot drag a file into a browser window; there is now a file
// picker too. And the parse result used to be applied blind — if the parser
// misread the workbook the PM's only recovery was deleting the whole project.
// Now the parse is shown for confirmation first, including every sheet that was
// skipped and why.

import { useRef, useState } from "react";
import { parseEstimateWorkbook, type ParsedSubmittalWorkbook } from "@shared/submittal/estimateParser";
import { readableError } from "./api";
import { btnPrimary, btnGhost, cardStyle, monoFont, disabledStyle } from "./helpers";

interface Props {
  /** Existing scope count — non-zero means this is a re-import. */
  existingScopes: number;
  disabled: boolean;
  onImport: (parsed: ParsedSubmittalWorkbook, fileName: string) => void;
  onCancel?: () => void;
}

export default function ImportPanel({ existingScopes, disabled, onImport, onCancel }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ parsed: ParsedSubmittalWorkbook; fileName: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const readFile = async (file: File | undefined) => {
    if (!file || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = await parseEstimateWorkbook(file);
      setPreview({ parsed, fileName: file.name });
    } catch (err) {
      setError(readableError(err, "That workbook could not be read."));
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void readFile(e.dataTransfer?.files?.[0]);
  };

  // ---- Confirmation view --------------------------------------------------
  if (preview) {
    const { parsed, fileName } = preview;
    const lineTotal = parsed.scopes.reduce((sum, s) => sum + s.lines.length, 0);
    const nothingFound = parsed.scopes.length === 0;

    return (
      <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }} data-testid="submittal-import-review">
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", marginBottom: 4 }}>
          {nothingFound ? "No scopes found in this workbook" : "Check what was found"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, fontFamily: monoFont }}>{fileName}</div>

        {nothingFound ? (
          <div style={{ ...cardStyle, padding: 16, marginBottom: 16, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Nothing in this file looked like a schedule. A scope tab needs a description column
            plus at least one of callout, model or quantity. The sheets below were skipped.
          </div>
        ) : (
          <div style={{ ...cardStyle, marginBottom: 16, overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", background: "var(--bg3)", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: ".5px" }}>
              {parsed.scopes.length} scope{parsed.scopes.length === 1 ? "" : "s"} · {lineTotal} line item{lineTotal === 1 ? "" : "s"}
            </div>
            {parsed.scopes.map((s) => (
              <div key={s.tab} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderTop: "1px solid var(--border-ds)" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}>{s.tab}</span>
                {s.csi && <span style={{ fontSize: 11, color: "var(--gold)", fontFamily: monoFont }}>{s.csi}</span>}
                <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 62, textAlign: "right" }}>
                  {s.lines.length} line{s.lines.length === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        )}

        {parsed.skipped.length > 0 && (
          <details style={{ ...cardStyle, padding: "10px 14px", marginBottom: 16 }} open={nothingFound}>
            <summary style={{ fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
              {parsed.skipped.length} sheet{parsed.skipped.length === 1 ? "" : "s"} skipped
            </summary>
            <div style={{ marginTop: 8 }}>
              {parsed.skipped.map((s) => (
                <div key={s.tab} style={{ display: "flex", gap: 10, fontSize: 11, padding: "3px 0", color: "var(--text-muted)" }}>
                  <span style={{ minWidth: 190, color: "var(--text-secondary)" }}>{s.tab}</span>
                  <span>{s.reason}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        {existingScopes > 0 && !nothingFound && (
          <div style={{ padding: "10px 14px", borderRadius: 6, background: "var(--warning-bg)", border: "1px solid var(--border-ds)", fontSize: 12, color: "var(--text-primary)", marginBottom: 16 }}>
            This replaces the {existingScopes} scope{existingScopes === 1 ? "" : "s"} already in this package,
            along with any product data attached to them.
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          {!nothingFound && (
            <button
              onClick={() => onImport(parsed, fileName)}
              style={btnPrimary}
              data-testid="button-confirm-import"
            >
              {existingScopes > 0 ? "Replace scopes" : `Import ${parsed.scopes.length} scope${parsed.scopes.length === 1 ? "" : "s"}`}
            </button>
          )}
          <button onClick={() => setPreview(null)} style={btnGhost} data-testid="button-choose-different-file">
            Choose a different file
          </button>
          {onCancel && (
            <button onClick={onCancel} style={btnGhost} data-testid="button-cancel-import">Cancel</button>
          )}
        </div>
      </div>
    );
  }

  // ---- Drop zone ----------------------------------------------------------
  return (
    <div style={{ padding: 24, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 320 }}>
      <div
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          width: 480, textAlign: "center", padding: 36,
          border: `2px dashed ${dragging ? "var(--gold)" : "var(--border-ds)"}`,
          borderRadius: 16,
          background: dragging ? "var(--warning-bg)" : "var(--bg-card)",
          transition: "border-color .15s, background .15s",
        }}
        data-testid="submittal-import-dropzone"
      >
        <div style={{ fontSize: 34, marginBottom: 10 }}>📋</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 6 }}>
          {existingScopes > 0 ? "Replace the estimate workbook" : "Start with your estimate workbook"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6, marginBottom: 16 }}>
          Drop an .xlsx or .xlsm file here, or choose one below.<br />
          Scope tabs, CSI sections and line items are detected for you — you can
          check them before anything is imported.
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".xlsx,.xlsm,.xls"
          style={{ display: "none" }}
          onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }}
          data-testid="input-estimate-file"
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={disabled || busy}
          style={{ ...btnPrimary, ...disabledStyle(disabled || busy) }}
          data-testid="button-choose-estimate"
        >
          {busy ? "Reading workbook…" : "Choose estimate file"}
        </button>

        {onCancel && (
          <div style={{ marginTop: 12 }}>
            <button onClick={onCancel} style={btnGhost} data-testid="button-cancel-import">Cancel</button>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 14, fontSize: 12, color: "var(--error)" }} data-testid="text-import-error">{error}</div>
        )}
      </div>
    </div>
  );
}
