import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Loader2, Download, ExternalLink } from "lucide-react";
import { BackNav } from "@/components/BackNav";

const STAGE_LABELS: Record<string, string> = {
  intake: "Project Info",
  lineItems: "Line Items",
  calculations: "Markups",
  output: "Proposal",
};

function fmtMs(ms: number | string | null | undefined): string {
  const n = typeof ms === "string" ? parseInt(ms) : (ms || 0);
  if (!n || n < 1000) return "—";
  const sec = Math.floor(n / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Convert ms to "Nd Hh" using an 8-hour workday. Returns null if under 1 hour.
const WORKDAY_HOURS = 8;
function fmtWorkdays(ms: number | string | null | undefined): string | null {
  const n = typeof ms === "string" ? parseInt(ms) : (ms || 0);
  if (!n || n < 3600 * 1000) return null; // only show for >= 1 hour
  const totalHours = n / (1000 * 3600);
  const days = Math.floor(totalHours / WORKDAY_HOURS);
  const remH = Math.round(totalHours - days * WORKDAY_HOURS);
  if (days === 0) return `${remH}h`;
  if (remH === 0) return `${days}d`;
  return `${days}d ${remH}h`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleString(); } catch { return d; }
}

function csvDownload(filename: string, rows: Array<Record<string, any>>) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

interface OverviewResp {
  perEstimator: Array<{ user_id: number; name: string; bid_count: string; total_active_ms: string; avg_active_ms_per_bid: string }>;
  cycles: Array<{
    estimate_id: number; proposal_log_id: number | null; review_status: string | null;
    project_name: string | null; estimate_number: string | null;
    first_at: string; last_at: string; version_count: string;
    submitted_at: string | null; submitted_by: string | null; cycle_ms: string;
    total_active_ms: string; estimator_count: string;
  }>;
}

interface BottlenecksResp {
  perStage: Array<{ stage: string; bid_count: string; total_ms: string; avg_ms_per_bid: string }>;
  perScope: Array<{ scope: string; bid_count: string; total_ms: string; avg_ms_per_bid: string }>;
}

interface DetailResp {
  estimate: { id: number; proposalLogId: number | null; reviewStatus: string | null; createdAt: string; projectName: string | null; estimateNumber: string | null };
  perUser: Array<{ user_id: number; name: string; total_ms: string; first_at: string; last_at: string }>;
  perStage: Array<{ stage: string; total_ms: string }>;
  perScope: Array<{ scope: string; total_ms: string }>;
  versions: Array<{ id: number; version: number; savedBy: string | null; notes: string | null; grandTotal: string | null; savedAt: string }>;
}

export default function AdminEstimatorAnalyticsPage() {
  const [tab, setTab] = useState("leaderboard");
  const [searchEstimateId, setSearchEstimateId] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "submitted" | "in_progress">("all");
  const [activeDetailId, setActiveDetailId] = useState<number | null>(null);

  const overview = useQuery<OverviewResp>({ queryKey: ["/api/admin/analytics/overview"] });
  const bottlenecks = useQuery<BottlenecksResp>({ queryKey: ["/api/admin/analytics/bottlenecks"] });
  const detail = useQuery<DetailResp>({
    queryKey: ["/api/admin/analytics/estimate", activeDetailId],
    enabled: !!activeDetailId,
  });

  const filteredCycles = useMemo(() => {
    if (!overview.data) return [];
    let rows = overview.data.cycles;
    if (statusFilter === "submitted") {
      rows = rows.filter(c => !!c.submitted_at || (c.review_status || "").toLowerCase() === "submitted");
    } else if (statusFilter === "in_progress") {
      rows = rows.filter(c => !c.submitted_at && (c.review_status || "").toLowerCase() !== "submitted");
    }
    const q = searchEstimateId.trim().toLowerCase();
    if (q) {
      rows = rows.filter(c =>
        String(c.estimate_id).includes(q) ||
        (c.proposal_log_id && String(c.proposal_log_id).includes(q)) ||
        (c.estimate_number || "").toLowerCase().includes(q) ||
        (c.project_name || "").toLowerCase().includes(q) ||
        (c.submitted_by || "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [overview.data, searchEstimateId, statusFilter]);

  const projectTimeTotals = useMemo(() => {
    const total = filteredCycles.reduce((s, c) => s + (parseInt(c.total_active_ms) || 0), 0);
    const done = filteredCycles.filter(c => !!c.submitted_at);
    const doneTotal = done.reduce((s, c) => s + (parseInt(c.total_active_ms) || 0), 0);
    return {
      projectCount: filteredCycles.length,
      totalMs: total,
      doneCount: done.length,
      doneTotalMs: doneTotal,
      doneAvgMs: done.length ? Math.round(doneTotal / done.length) : 0,
    };
  }, [filteredCycles]);

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl" data-testid="page-estimator-analytics">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <BackNav href="/admin" label="Admin Dashboard" testId="link-back-admin" />
          <h1 className="font-heading text-2xl">Estimator Analytics</h1>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="leaderboard" data-testid="tab-leaderboard">Leaderboard</TabsTrigger>
          <TabsTrigger value="bids" data-testid="tab-bids">Project Time</TabsTrigger>
          <TabsTrigger value="bottlenecks" data-testid="tab-bottlenecks">Bottlenecks</TabsTrigger>
        </TabsList>

        {/* ── LEADERBOARD ── */}
        <TabsContent value="leaderboard">
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-heading text-base">Per-Estimator Activity</h2>
              <Button size="sm" variant="outline" onClick={() => overview.data && csvDownload("estimator-leaderboard.csv", overview.data.perEstimator)}>
                <Download className="w-3.5 h-3.5 mr-1.5" /> CSV
              </Button>
            </div>
            {overview.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr><th className="text-left py-2">Estimator</th><th className="text-right">Bids worked</th><th className="text-right">Total active time</th><th className="text-right">Avg per bid</th></tr>
                </thead>
                <tbody>
                  {(overview.data?.perEstimator || []).map(r => (
                    <tr key={r.user_id} className="border-b last:border-0" data-testid={`row-estimator-${r.user_id}`}>
                      <td className="py-2">{r.name || `User ${r.user_id}`}</td>
                      <td className="text-right">{r.bid_count}</td>
                      <td className="text-right">{fmtMs(r.total_active_ms)}</td>
                      <td className="text-right">{fmtMs(r.avg_active_ms_per_bid)}</td>
                    </tr>
                  ))}
                  {(overview.data?.perEstimator || []).length === 0 && (
                    <tr><td colSpan={4} className="text-center py-8 text-muted-foreground">No activity recorded yet. Data starts collecting as estimators use the Estimating Module.</td></tr>
                  )}
                </tbody>
              </table>
            )}
          </Card>
        </TabsContent>

        {/* ── PER-BID DETAIL ── */}
        <TabsContent value="bids">
          {/* Rollup cards — answer "how much time was spent on it?" at a glance */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Card className="p-3" data-testid="card-rollup-projects">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Projects shown</div>
              <div className="font-heading text-2xl mt-1">{projectTimeTotals.projectCount}</div>
            </Card>
            <Card className="p-3" data-testid="card-rollup-total-time">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total active time</div>
              <div className="font-heading text-2xl mt-1">{fmtMs(projectTimeTotals.totalMs)}</div>
              {fmtWorkdays(projectTimeTotals.totalMs) && (
                <div className="text-xs text-muted-foreground mt-0.5">≈ {fmtWorkdays(projectTimeTotals.totalMs)} <span className="opacity-70">(8h day)</span></div>
              )}
            </Card>
            <Card className="p-3" data-testid="card-rollup-done-count">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Submitted projects</div>
              <div className="font-heading text-2xl mt-1">{projectTimeTotals.doneCount}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {fmtMs(projectTimeTotals.doneTotalMs)} total
                {fmtWorkdays(projectTimeTotals.doneTotalMs) && ` · ≈ ${fmtWorkdays(projectTimeTotals.doneTotalMs)}`}
              </div>
            </Card>
            <Card className="p-3" data-testid="card-rollup-done-avg">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Avg per submitted project</div>
              <div className="font-heading text-2xl mt-1">{fmtMs(projectTimeTotals.doneAvgMs)}</div>
              {fmtWorkdays(projectTimeTotals.doneAvgMs) && (
                <div className="text-xs text-muted-foreground mt-0.5">≈ {fmtWorkdays(projectTimeTotals.doneAvgMs)} <span className="opacity-70">(8h day)</span></div>
              )}
            </Card>
          </div>

          <Card className="p-4">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div>
                <h2 className="font-heading text-base">Time Spent per Project</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Total active engagement time (idle/inactive periods excluded). Use the status filter to isolate completed projects.
                  <span className="ml-1 italic">Workday conversions (e.g. "2d 3h") are based on an 8-hour workday.</span>
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex rounded-md border overflow-hidden text-xs" role="tablist">
                  {([
                    ["all", "All"],
                    ["submitted", "Submitted"],
                    ["in_progress", "In progress"],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => setStatusFilter(val)}
                      className={`px-3 py-1.5 transition-colors ${statusFilter === val ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
                      data-testid={`button-status-${val}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <Input
                  className="h-8 w-56"
                  placeholder="Filter by project / estimate # / user…"
                  value={searchEstimateId}
                  onChange={e => setSearchEstimateId(e.target.value)}
                  data-testid="input-bid-filter"
                />
                <Button size="sm" variant="outline" onClick={() => csvDownload("project-time.csv", filteredCycles)}>
                  <Download className="w-3.5 h-3.5 mr-1.5" /> CSV
                </Button>
              </div>
            </div>
            {overview.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr>
                      <th className="text-left py-2">Project</th>
                      <th className="text-left">Status</th>
                      <th className="text-right" title="Total active engagement time across all estimators. Idle and inactive periods are excluded — this is real hands-on-keyboard time.">Active time</th>
                      <th className="text-right" title="How many distinct estimators logged activity on this project.">Estimators</th>
                      <th className="text-left" title="Date and time the estimate was first saved.">First save</th>
                      <th className="text-left" title="Date and time the estimate was marked Submitted.">Submitted</th>
                      <th className="text-right" title="Calendar (wall-clock) time from first save to submit. Includes nights, weekends, and idle days — NOT the same as actual time spent. Use 'Active time' for that.">Calendar span</th>
                      <th className="text-right" title="How many times the estimate was saved. More versions usually means more pricing rounds or revisions.">Saves</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCycles.map(c => {
                      const isDone = !!c.submitted_at || (c.review_status || "").toLowerCase() === "submitted";
                      return (
                        <tr key={c.estimate_id} className="border-b last:border-0 hover:bg-muted/30" data-testid={`row-cycle-${c.estimate_id}`}>
                          <td className="py-2">
                            <div className="font-medium">{c.project_name || `Estimate #${c.estimate_id}`}</div>
                            <div className="text-xs text-muted-foreground">
                              {c.estimate_number ? `${c.estimate_number} · ` : ""}#{c.estimate_id}
                              {c.proposal_log_id ? ` · log ${c.proposal_log_id}` : ""}
                            </div>
                          </td>
                          <td>
                            <span className={`inline-block px-2 py-0.5 rounded text-xs ${isDone ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"}`}>
                              {isDone ? "Submitted" : (c.review_status || "In progress")}
                            </span>
                          </td>
                          <td className="text-right font-medium" data-testid={`cell-active-time-${c.estimate_id}`}>
                            <div>{fmtMs(c.total_active_ms)}</div>
                            {fmtWorkdays(c.total_active_ms) && (
                              <div className="text-[10px] font-normal text-muted-foreground">≈ {fmtWorkdays(c.total_active_ms)}</div>
                            )}
                          </td>
                          <td className="text-right">{c.estimator_count || "—"}</td>
                          <td className="text-xs">{fmtDate(c.first_at)}</td>
                          <td className="text-xs">{fmtDate(c.submitted_at)}</td>
                          <td className="text-right text-muted-foreground">{fmtMs(c.cycle_ms)}</td>
                          <td className="text-right">{c.version_count}</td>
                          <td className="text-right">
                            <Button size="sm" variant="ghost" onClick={() => setActiveDetailId(c.estimate_id)} data-testid={`button-detail-${c.estimate_id}`}>
                              Details
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                    {filteredCycles.length === 0 && (
                      <tr><td colSpan={9} className="text-center py-8 text-muted-foreground">No projects match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {activeDetailId && (
            <Card className="p-4 mt-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-heading text-base">
                  Bid #{activeDetailId}{detail.data?.estimate?.estimateNumber ? ` · ${detail.data.estimate.estimateNumber}` : ""}
                  {detail.data?.estimate?.projectName ? ` — ${detail.data.estimate.projectName}` : ""}
                </h2>
                <div className="flex items-center gap-2">
                  <Link href={`/estimates/${activeDetailId}`}>
                    <Button size="sm" variant="outline"><ExternalLink className="w-3.5 h-3.5 mr-1.5" /> Open Estimate</Button>
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => setActiveDetailId(null)}>Close</Button>
                </div>
              </div>
              {detail.isLoading || !detail.data ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Active time by estimator</h3>
                    <table className="w-full text-sm">
                      <tbody>
                        {detail.data.perUser.map(u => (
                          <tr key={u.user_id} className="border-b last:border-0">
                            <td className="py-1.5">{u.name || `User ${u.user_id}`}</td>
                            <td className="text-right">{fmtMs(u.total_ms)}</td>
                          </tr>
                        ))}
                        {detail.data.perUser.length === 0 && <tr><td className="text-muted-foreground py-2">No tracked activity.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Time per stage</h3>
                    <StageBars rows={detail.data.perStage} labelMap={STAGE_LABELS} />
                  </div>
                  <div className="md:col-span-2">
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Time per scope (Line Items stage)</h3>
                    <StageBars rows={detail.data.perScope.map(s => ({ stage: s.scope, total_ms: s.total_ms }))} />
                  </div>
                  <div className="md:col-span-2">
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-2">Version timeline ({detail.data.versions.length})</h3>
                    <div className="max-h-64 overflow-auto border rounded">
                      <table className="w-full text-xs">
                        <thead className="text-muted-foreground border-b sticky top-0 bg-background">
                          <tr><th className="text-left p-2">v</th><th className="text-left">When</th><th className="text-left">By</th><th className="text-left">Note</th><th className="text-right p-2">Total</th></tr>
                        </thead>
                        <tbody>
                          {detail.data.versions.slice().reverse().map(v => (
                            <tr key={v.id} className="border-b last:border-0">
                              <td className="p-2">v{v.version}</td>
                              <td>{fmtDate(v.savedAt)}</td>
                              <td>{v.savedBy || "—"}</td>
                              <td className="truncate max-w-md">{v.notes || "—"}</td>
                              <td className="text-right p-2">{v.grandTotal ? `$${Number(v.grandTotal).toLocaleString()}` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          )}
        </TabsContent>

        {/* ── BOTTLENECKS ── */}
        <TabsContent value="bottlenecks">
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="p-4">
              <h2 className="font-heading text-base mb-3">Avg time per stage (across bids)</h2>
              {bottlenecks.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr><th className="text-left py-2">Stage</th><th className="text-right">Bids</th><th className="text-right">Avg/bid</th><th className="text-right">Total</th></tr>
                  </thead>
                  <tbody>
                    {(bottlenecks.data?.perStage || []).map(r => (
                      <tr key={r.stage} className="border-b last:border-0">
                        <td className="py-2">{STAGE_LABELS[r.stage] || r.stage}</td>
                        <td className="text-right">{r.bid_count}</td>
                        <td className="text-right">{fmtMs(r.avg_ms_per_bid)}</td>
                        <td className="text-right">{fmtMs(r.total_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card className="p-4">
              <h2 className="font-heading text-base mb-3">Avg time per scope (across bids)</h2>
              {bottlenecks.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr><th className="text-left py-2">Scope</th><th className="text-right">Bids</th><th className="text-right">Avg/bid</th><th className="text-right">Total</th></tr>
                  </thead>
                  <tbody>
                    {(bottlenecks.data?.perScope || []).map(r => (
                      <tr key={r.scope} className="border-b last:border-0">
                        <td className="py-2">{r.scope}</td>
                        <td className="text-right">{r.bid_count}</td>
                        <td className="text-right">{fmtMs(r.avg_ms_per_bid)}</td>
                        <td className="text-right">{fmtMs(r.total_ms)}</td>
                      </tr>
                    ))}
                    {(bottlenecks.data?.perScope || []).length === 0 && (
                      <tr><td colSpan={4} className="text-center py-8 text-muted-foreground">No scope-level activity yet.</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StageBars({ rows, labelMap }: { rows: Array<{ stage: string | null; total_ms: string }>; labelMap?: Record<string, string> }) {
  const total = rows.reduce((s, r) => s + Number(r.total_ms || 0), 0);
  if (!rows.length || total === 0) return <div className="text-muted-foreground text-sm">No tracked time.</div>;
  return (
    <div className="space-y-1.5">
      {rows.map(r => {
        const ms = Number(r.total_ms || 0);
        const pct = total > 0 ? (ms / total) * 100 : 0;
        return (
          <div key={r.stage || "—"} className="text-xs">
            <div className="flex justify-between mb-0.5">
              <span>{r.stage ? (labelMap?.[r.stage] || r.stage) : "—"}</span>
              <span className="text-muted-foreground">{fmtMs(ms)} · {pct.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded bg-muted">
              <div className="h-full rounded" style={{ width: `${pct}%`, background: "var(--gold)" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
