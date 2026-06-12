import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { inputStyle, btnGhost } from "./helpers";
import type { ProposalLogEntry } from "./types";

interface Props {
  onBack: () => void;
  onCreate: (entry: ProposalLogEntry) => void;
}

export default function NewProject({ onBack, onCreate }: Props) {
  const [search, setSearch] = useState("");

  const { data: allEntries = [], isLoading } = useQuery<ProposalLogEntry[]>({
    queryKey: ["/api/proposal-log/entries"],
  });

  const wonEntries = (allEntries as any[])
    .filter((e: any) => e.estimateStatus === "Won" || e.estimateStatus === "Awarded")
    .map((e: any): ProposalLogEntry => ({
      id: e.id,
      projectName: e.projectName,
      gcEstimateLead: e.gcEstimateLead || "",
      estimateStatus: e.estimateStatus,
      estimateNumber: e.estimateNumber,
      region: e.region,
      nbsEstimator: e.nbsEstimator,
      proposalTotal: e.proposalTotal,
      anticipatedStart: e.anticipatedStart,
    }));

  const filtered = wonEntries.filter(
    (p) => !search || p.projectName.toLowerCase().includes(search.toLowerCase()) || (p.estimateNumber || "").toLowerCase().includes(search.toLowerCase()) || (p.region || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ background: "var(--bg-page)", minHeight: "calc(100vh - 57px)", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "32px 24px" }}>
        <button onClick={onBack} style={{ ...btnGhost, marginBottom: 20 }}>← Back to Projects</button>
        <h2 style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)", marginBottom: 4, fontFamily: "'Rajdhani', sans-serif" }}>Start New Submittal</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>Select a Won project from the AiPM Proposal Log Dashboard.</p>

        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by project name, estimate #, or region..." style={{ ...inputStyle, width: "100%", marginBottom: 16 }} />

        {isLoading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>Loading Proposal Log Dashboard...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-secondary)" }}>
            {wonEntries.length === 0 ? (
              <div>
                <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>No Won/Awarded projects found in the Proposal Log Dashboard.</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Change a project status to "Won" or "Awarded" in the Proposal Log Dashboard first.</div>
              </div>
            ) : "No projects match your search."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {filtered.map((p) => (
              <div key={p.id} onClick={() => onCreate(p)}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "var(--bg-card)", border: "1px solid var(--border-ds)", borderRadius: 8, cursor: "pointer", transition: "border-color .15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--gold)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border-ds)"; }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{p.projectName}</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                    {p.gcEstimateLead ? "GC: " + p.gcEstimateLead : ""}
                    {p.nbsEstimator ? " · Est: " + p.nbsEstimator : ""}
                    {p.region ? " · " + p.region : ""}
                  </div>
                </div>
                {p.estimateNumber && (
                  <span style={{ fontSize: 11, color: "var(--gold)", fontFamily: "monospace", minWidth: 70 }}>{p.estimateNumber}</span>
                )}
                <span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 600, color: "var(--success)", background: "var(--success-bg)" }}>{p.estimateStatus}</span>
                <span style={{ fontSize: 12, color: "var(--gold)" }}>→</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
