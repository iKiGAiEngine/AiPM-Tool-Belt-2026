import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Inbox, RefreshCw, Loader2, Link2, ShieldAlert } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PendingDraft {
  id: number;
  projectName: string;
  gc: string;
  region: string;
  market: string;
  dueDate: string;
  daysUntilDue: number | null;
  waitingHours: number;
  ndaRequired: boolean;
  regionNeedsReview: boolean;
  bcLink: string;
}

interface EstimatorWorkload {
  code: string;
  name: string;
  active: number;
  overdue: number;
  dueWithin3Days: number;
  dueWithin7Days: number;
  newLast7Days: number;
  nextDueDate: string | null;
  topRegions: string[];
  topMarkets: string[];
  loadScore: number;
  lightest: boolean;
}

interface BidIntakeSummary {
  generatedAt: string;
  pendingDrafts: number;
  oldestWaitingHours: number | null;
  drafts: PendingDraft[];
  lastProcessedAt: string | null;
  lastProcessedBy: string | null;
  workload: EstimatorWorkload[];
  bc: {
    status: "never_checked" | "ok" | "not_connected" | "error";
    checkedAt: string | null;
    waitingInBc: number | null;
    message: string | null;
    checking: boolean;
  };
}

const SUMMARY_KEY = ["/api/bid-intake/summary"];

function formatWaiting(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d}d ${h}h` : `${d}d`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${formatWaiting(Math.floor(mins / 60))} ago`;
}

function dueLabel(d: PendingDraft): string {
  if (d.daysUntilDue === null) return "no date";
  if (d.daysUntilDue < 0) return `${Math.abs(d.daysUntilDue)}d overdue`;
  if (d.daysUntilDue === 0) return "due today";
  return `due in ${d.daysUntilDue}d`;
}

const cell: React.CSSProperties = { padding: "4px 6px", textAlign: "right", whiteSpace: "nowrap" };
const cellLeft: React.CSSProperties = { ...cell, textAlign: "left", whiteSpace: "normal" };
const head: React.CSSProperties = {
  ...cell, color: "var(--text-dim)", fontSize: 10, fontWeight: 600,
  letterSpacing: ".06em", textTransform: "uppercase",
};

function Kpi({ label, value, sub, testId, hot }: {
  label: string; value: string; sub?: string; testId: string; hot?: boolean;
}) {
  return (
    <div style={{ flex: "1 1 110px", minWidth: 0, background: "var(--bg3)", border: "1px solid var(--border-ds)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-dim)" }}>{label}</div>
      <div data-testid={testId} style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.15, color: hot ? "#E5484D" : "var(--gold)" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
    </div>
  );
}

export function BidIntakePanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  // Reading the summary is cheap: the server answers from its saved copy of the
  // last BuildingConnected check and only re-checks BC every ~15 minutes.
  const { data, isLoading, isError } = useQuery<BidIntakeSummary>({
    queryKey: SUMMARY_KEY,
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  async function refreshFromBc() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/bid-intake/refresh", { method: "POST", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || `Server error (${res.status})`);
      queryClient.setQueryData(SUMMARY_KEY, await res.json());
    } catch (err: any) {
      toast({ title: "Couldn't refresh from BuildingConnected", description: err?.message, variant: "destructive" });
    } finally {
      setRefreshing(false);
    }
  }

  const bc = data?.bc;
  const bcKnown = bc?.status === "ok" && bc.waitingInBc !== null;
  const total = (data?.pendingDrafts ?? 0) + (bcKnown ? bc!.waitingInBc! : 0);
  const stuck = (data?.oldestWaitingHours ?? 0) >= 48;

  return (
    <div
      data-testid="card-bid-intake"
      style={{
        background: "var(--bg2)", border: "1px solid var(--border-ds)", borderRadius: 12,
        padding: "12px 14px", marginBottom: 10, maxHeight: "64%", overflowY: "auto", flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Inbox style={{ width: 16, height: 16, color: "var(--gold)" }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Bid Intake</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              BC invites not yet processed
              {bc?.checkedAt ? ` · BC checked ${timeAgo(bc.checkedAt)}` : ""}
            </div>
          </div>
        </div>
        <button
          onClick={refreshFromBc}
          disabled={refreshing}
          title="Check BuildingConnected now"
          data-testid="button-bid-intake-refresh"
          style={{
            display: "flex", alignItems: "center", gap: 6, fontSize: 11, padding: "4px 8px", borderRadius: 6,
            border: "1px solid var(--border-ds)", background: "var(--bg3)", color: "var(--text)", cursor: refreshing ? "default" : "pointer",
          }}
        >
          {refreshing ? <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> : <RefreshCw style={{ width: 12, height: 12 }} />}
          Refresh from BC
        </button>
      </div>

      {isLoading && <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "8px 0" }}>Loading…</div>}
      {isError && <div style={{ fontSize: 12, color: "#E5484D", padding: "8px 0" }}>Couldn't load bid intake numbers.</div>}

      {data && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            <Kpi label="Pending bids" value={String(total)} testId="text-pending-total"
              sub={bcKnown ? "in BC + awaiting review" : "awaiting review (BC count unavailable)"} hot={stuck} />
            <Kpi label="Waiting in BC" value={bcKnown ? String(bc!.waitingInBc) : "—"} testId="text-waiting-in-bc"
              sub="not pulled in yet" />
            <Kpi label="Awaiting review" value={String(data.pendingDrafts)} testId="text-pending-drafts"
              sub="pulled in, not approved" />
            <Kpi label="Oldest waiting" value={formatWaiting(data.oldestWaitingHours)} testId="text-oldest-waiting"
              sub={`Last processed ${timeAgo(data.lastProcessedAt)}`} hot={stuck} />
          </div>

          {bc && bc.status !== "ok" && bc.status !== "never_checked" && (
            <div data-testid="text-bc-warning" style={{ fontSize: 11, color: "#E5484D", display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <ShieldAlert style={{ width: 12, height: 12, flexShrink: 0 }} />
              {bc.message || "BuildingConnected check failed."} The "Awaiting review" number is still accurate.
            </div>
          )}

          {data.drafts.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-dim)", margin: "4px 0 2px" }}>
                Next up to assign{data.pendingDrafts > data.drafts.length ? ` (top ${data.drafts.length} of ${data.pendingDrafts})` : ""}
              </div>
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <tbody>
                  {data.drafts.map((d) => (
                    <tr key={d.id} data-testid={`row-pending-draft-${d.id}`} style={{ borderTop: "1px solid var(--border-ds)" }}>
                      <td style={cellLeft}>
                        <div style={{ fontWeight: 600 }}>{d.projectName}{d.ndaRequired ? " · NDA" : ""}</div>
                        <div style={{ color: "var(--text-dim)" }}>
                          {[d.gc, d.region || (d.regionNeedsReview ? "region?" : ""), d.market].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td style={{ ...cell, color: d.daysUntilDue !== null && d.daysUntilDue <= 3 ? "#E5484D" : "var(--text-dim)" }}>
                        {dueLabel(d)}
                      </td>
                      <td style={{ ...cell, color: "var(--text-dim)" }}>{formatWaiting(d.waitingHours)} waiting</td>
                      <td style={cell}>
                        {d.bcLink && (
                          <a href={d.bcLink} target="_blank" rel="noopener noreferrer" title="Open in BuildingConnected" onClick={(e) => e.stopPropagation()}>
                            <Link2 style={{ width: 12, height: 12 }} />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--text-dim)", margin: "4px 0 2px" }}>
            Estimator workload — lightest load first
          </div>
          {data.workload.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>No estimator assignments found yet.</div>
          ) : (
            <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }} data-testid="table-workload">
              <thead>
                <tr>
                  <th style={{ ...head, textAlign: "left" }}>Estimator</th>
                  <th style={head} title="Lead + Estimating + Revising">Active</th>
                  <th style={head} title="Due within 3 days">≤3d</th>
                  <th style={head} title="Past their due date and still active">Late</th>
                  <th style={head} title="Started in the last 7 days">New 7d</th>
                  <th style={{ ...head, textAlign: "left" }} title="Most common regions / markets from the last 120 days">Usually works</th>
                </tr>
              </thead>
              <tbody>
                {data.workload.map((w) => (
                  <tr key={w.code} data-testid={`row-workload-${w.code}`} style={{ borderTop: "1px solid var(--border-ds)" }}>
                    <td style={cellLeft} title={`Load score ${w.loadScore} = active + 2×(due ≤3d) + 2×late`}>
                      <span style={{ fontWeight: 600 }}>{w.name}</span>{" "}
                      <span style={{ color: "var(--text-dim)" }}>{w.code}</span>
                      {w.lightest && (
                        <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "var(--gold)", color: "#111" }}>
                          LIGHTEST
                        </span>
                      )}
                    </td>
                    <td style={cell}>{w.active}</td>
                    <td style={{ ...cell, color: w.dueWithin3Days ? "#E5A23C" : undefined }}>{w.dueWithin3Days}</td>
                    <td style={{ ...cell, color: w.overdue ? "#E5484D" : undefined }}>{w.overdue}</td>
                    <td style={cell}>{w.newLast7Days}</td>
                    <td style={{ ...cellLeft, color: "var(--text-dim)" }}>
                      {[...w.topRegions, ...w.topMarkets].join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
