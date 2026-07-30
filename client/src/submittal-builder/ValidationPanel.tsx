// Step 3 — review.
//
// One verdict at the top, then grouped issues. The old panel emitted an issue
// per line (180 warnings for a routine 60-line scope), truncated the list at 20
// and left the PM with no idea whether the package was actually good to send.

import { useState } from "react";
import type { ValidationResult, ValidationIssue, Severity } from "@shared/submittal/validation";
import type { SubmittalProject } from "@shared/submittal/types";
import { cardStyle, monoFont } from "./helpers";

interface Props {
  project: SubmittalProject | null;
  validation: ValidationResult;
  onJumpToLine: (scopeId: string, lineId: string) => void;
}

const SEVERITY: Record<Severity, { label: string; color: string; bg: string }> = {
  error: { label: "Must fix", color: "var(--error)", bg: "var(--error-bg, rgba(192,57,43,.08))" },
  warning: { label: "Check", color: "var(--gold)", bg: "var(--warning-bg)" },
  info: { label: "For info", color: "var(--text-secondary)", bg: "var(--bg3)" },
};

function IssueRow({ issue, onJump }: { issue: ValidationIssue; onJump: (lineId: string) => void }) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY[issue.severity];
  const hasLines = issue.lineIds.length > 0;

  return (
    <div style={{ borderTop: "1px solid var(--border-ds)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px" }}>
        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 3, background: meta.bg, color: meta.color, minWidth: 58, textAlign: "center" }}>
          {meta.label}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--text-primary)" }}>{issue.msg}</div>
          {issue.hint && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{issue.hint}</div>}
        </div>
        {issue.scope && <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{issue.scope}</span>}
        {hasLines && (
          <button
            onClick={() => setOpen((v) => !v)}
            style={{ background: "none", border: "1px solid var(--border-ds)", borderRadius: 4, color: "var(--text-secondary)", fontSize: 11, padding: "2px 8px", cursor: "pointer" }}
            data-testid={`button-toggle-issue-${issue.kind}`}
          >
            {open ? "Hide" : `Show ${issue.count}`}
          </button>
        )}
      </div>
      {open && hasLines && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 14px 10px 82px" }}>
          {issue.lineIds.map((lineId) => (
            <button
              key={lineId}
              onClick={() => onJump(lineId)}
              style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)", borderRadius: 4, color: "var(--text-secondary)", fontSize: 10, fontFamily: monoFont, padding: "2px 8px", cursor: "pointer" }}
              title="Open this line in the Schedule"
            >
              Go to line
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ValidationPanel({ project, validation, onJumpToLine }: Props) {
  const s = validation.summary;
  const clean = validation.issues.length === 0;

  const verdict = validation.blockers > 0
    ? { text: `${validation.blockers} thing${validation.blockers === 1 ? "" : "s"} must be fixed before this package can go out`, color: "var(--error)", bg: "var(--error-bg, rgba(192,57,43,.08))" }
    : s.missing > 0
      ? { text: `${s.missing} line${s.missing === 1 ? "" : "s"} still waiting on product data`, color: "var(--gold)", bg: "var(--warning-bg)" }
      : { text: "Ready to export", color: "var(--success)", bg: "var(--success-bg)" };

  return (
    <div style={{ padding: 20, maxWidth: 820 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)", marginBottom: 12 }}>Package Validation</div>

      <div
        style={{ padding: "12px 16px", borderRadius: 8, background: verdict.bg, border: "1px solid var(--border-ds)", marginBottom: 16, fontSize: 14, fontWeight: 700, color: verdict.color }}
        data-testid="text-validation-verdict"
      >
        {verdict.text}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 20 }}>
        {[
          { label: "Scopes", value: s.totalScopes, color: "var(--text-primary)" },
          { label: "Lines", value: s.totalLines, color: "var(--text-primary)" },
          { label: "Attached", value: s.attached, color: "var(--success)" },
          { label: "By Others / N/A", value: s.excluded, color: "var(--text-secondary)" },
          { label: "Outstanding", value: s.missing, color: s.missing > 0 ? "var(--gold)" : "var(--success)" },
          { label: "Pages", value: s.projectedPages, color: "var(--text-primary)" },
        ].map((c) => (
          <div key={c.label} style={{ ...cardStyle, padding: 12 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c.color }} data-testid={`stat-${c.label.toLowerCase().replace(/\W+/g, "-")}`}>{c.value}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{c.label}</div>
          </div>
        ))}
      </div>

      {clean ? (
        <div style={{ ...cardStyle, padding: 28, textAlign: "center", color: "var(--success)", fontSize: 14, fontWeight: 600 }}>
          ✓ Nothing to fix
        </div>
      ) : (
        <div style={{ ...cardStyle, overflow: "hidden" }} data-testid="list-validation-issues">
          <div style={{ padding: "8px 14px", background: "var(--bg3)", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: ".5px" }}>
            {validation.issues.length} issue{validation.issues.length === 1 ? "" : "s"}
          </div>
          {validation.issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} onJump={(lineId) => onJumpToLine(issue.scopeId, lineId)} />
          ))}
        </div>
      )}

      {project && s.totalLines > 0 && (
        <div style={{ marginTop: 14, fontSize: 11, color: "var(--text-muted)" }}>
          Each scope exports as its own package, numbered from page 1.
        </div>
      )}
    </div>
  );
}
