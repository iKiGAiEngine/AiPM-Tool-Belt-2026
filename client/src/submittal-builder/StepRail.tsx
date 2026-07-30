// The four steps of building a submittal, with the single next action spelled
// out.
//
// A new user used to land on a flat five-tab bar with no indication of order,
// no sense of what "done" looked like, and nothing telling them that attaching
// product data is the actual work. The tabs are still there for people who know
// where they are going — this rail just makes the path obvious.

import { monoFont } from "./helpers";

export type StepKey = "import" | "attach" | "review" | "export";

export interface Step {
  key: StepKey;
  label: string;
  /** Short state line, e.g. "12 of 40 lines". */
  detail: string;
  done: boolean;
  /** Not reachable yet — earlier steps are unfinished. */
  locked: boolean;
}

interface Props {
  steps: Step[];
  current: StepKey;
  /** The one thing to do next, or null when the package is finished. */
  nextAction: { label: string; hint: string; step: StepKey } | null;
  onGo: (step: StepKey) => void;
}

export default function StepRail({ steps, current, nextAction, onGo }: Props) {
  return (
    <div style={{ borderBottom: "1px solid var(--border-ds)", background: "var(--bg-card)", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "stretch", padding: "0 12px", gap: 4, overflowX: "auto" }}>
        {steps.map((step, i) => {
          const active = step.key === current;
          const color = step.done ? "var(--success)" : active ? "var(--gold)" : "var(--text-muted)";
          return (
            <button
              key={step.key}
              onClick={() => !step.locked && onGo(step.key)}
              disabled={step.locked}
              title={step.locked ? "Finish the earlier steps first" : undefined}
              data-testid={`step-${step.key}`}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 14px", background: "none", border: "none",
                borderBottom: `2px solid ${active ? "var(--gold)" : "transparent"}`,
                cursor: step.locked ? "not-allowed" : "pointer",
                opacity: step.locked ? 0.45 : 1,
                whiteSpace: "nowrap",
              }}
            >
              <span
                style={{
                  width: 20, height: 20, borderRadius: 10, flexShrink: 0,
                  border: `1.5px solid ${color}`, color,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 10, fontWeight: 700, fontFamily: monoFont,
                }}
              >
                {step.done ? "✓" : i + 1}
              </span>
              <span style={{ textAlign: "left" }}>
                <span style={{ display: "block", fontSize: 12, fontWeight: active ? 700 : 500, color: active ? "var(--text-primary)" : "var(--text-secondary)" }}>
                  {step.label}
                </span>
                <span style={{ display: "block", fontSize: 10, color: "var(--text-muted)" }}>{step.detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      {nextAction && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 16px", background: "var(--warning-bg)",
            borderTop: "1px solid var(--border-ds)",
          }}
          data-testid="banner-next-action"
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-primary)" }}>Next:</span>
          <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{nextAction.hint}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => onGo(nextAction.step)}
            style={{
              padding: "4px 12px", borderRadius: 4, fontSize: 11, fontWeight: 700,
              background: "var(--gold)", color: "var(--text-inverse)", border: "none", cursor: "pointer",
            }}
            data-testid="button-next-action"
          >
            {nextAction.label}
          </button>
        </div>
      )}
    </div>
  );
}
