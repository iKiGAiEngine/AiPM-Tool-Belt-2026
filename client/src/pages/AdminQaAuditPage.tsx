import { useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BackNav } from "@/components/BackNav";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, RefreshCw, ExternalLink, TrendingUp, DollarSign } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

// ---- shapes returned by /api/admin/qa-audit/* -------------------------------
interface HistoryRow {
  id: number;
  ranAt: string;
  status: "GREEN" | "YELLOW" | "RED";
  headline: string;
  environment: string | null;
  durationMs: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  skipCount: number;
  costLast24hUsd: number;
  projectedMonthlyUsd: number;
}
interface CostLine {
  driver: string;
  measured: boolean;
  usage: string;
  last24hUsd: number;
  last30dUsd: number;
  basis: string;
}
interface CostSummary {
  currency: string;
  hasMeasuredAi: boolean;
  lines: CostLine[];
  total24hUsd: number;
  total30dUsd: number;
  projectedMonthlyUsd: number;
  note: string;
}
interface LatestRow {
  ranAt: string;
  status: string;
  report: { cost?: CostSummary };
}

const STATUS_COLOR: Record<string, string> = { GREEN: "#1a9e55", YELLOW: "#c98a1a", RED: "#d23b3b" };

function usd(n: number | null | undefined): string {
  const v = typeof n === "number" ? n : 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function shortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}
function fullDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function AdminQaAuditPage() {
  const { toast } = useToast();

  const history = useQuery<HistoryRow[]>({ queryKey: ["/api/admin/qa-audit/history?limit=90"] });
  const latest = useQuery<LatestRow>({ queryKey: ["/api/admin/qa-audit/latest"], retry: false });

  const runNow = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/qa-audit/run");
      return res.json();
    },
    onSuccess: (report: any) => {
      toast({ title: `Audit complete — ${report?.status ?? "done"}`, description: report?.headline });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/qa-audit/history?limit=90"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/qa-audit/latest"] });
    },
    onError: (err: any) => {
      toast({ title: "Audit failed", description: err?.message || "See server logs.", variant: "destructive" });
    },
  });

  const rows = history.data ?? [];
  const chartData = useMemo(
    () =>
      rows.map((r) => ({
        label: shortDate(r.ranAt),
        ranAt: r.ranAt,
        status: r.status,
        projected: Number(r.projectedMonthlyUsd.toFixed(2)),
        daily: Number(r.costLast24hUsd.toFixed(2)),
      })),
    [rows],
  );

  const current = rows.length > 0 ? rows[rows.length - 1] : undefined;
  const previous = rows.length > 1 ? rows[rows.length - 2] : undefined;
  const cost: CostSummary | undefined = latest.data?.report?.cost;

  const trend =
    current && previous
      ? current.projectedMonthlyUsd - previous.projectedMonthlyUsd
      : 0;

  return (
    <div className="min-h-screen p-4 md:p-8 max-w-6xl mx-auto" data-testid="page-admin-qa-audit">
      <BackNav href="/admin" label="Admin" testId="button-back-admin" />

      <div className="flex items-start justify-between flex-wrap gap-3 mt-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <DollarSign className="w-6 h-6" /> Cost &amp; Health Trend
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Estimated cost of running the site over time, from the twice-daily QA audit.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => window.open("/api/admin/qa-audit/report.html", "_blank")}
            data-testid="button-open-report"
          >
            <ExternalLink className="w-4 h-4 mr-1.5" /> Full report
          </Button>
          <Button onClick={() => runNow.mutate()} disabled={runNow.isPending} data-testid="button-run-audit">
            {runNow.isPending ? (
              <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-1.5" />
            )}
            Run audit now
          </Button>
        </div>
      </div>

      {/* Headline stat tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatTile
          label="Projected / month"
          value={usd(current?.projectedMonthlyUsd)}
          accent="#c9a84c"
          sub={
            trend !== 0
              ? `${trend > 0 ? "▲" : "▼"} ${usd(Math.abs(trend))} vs last run`
              : "run-rate ×30 + fixed"
          }
        />
        <StatTile label="Last 24h" value={usd(current?.costLast24hUsd)} accent="#e8e8ea" sub="most recent audit" />
        <StatTile label="Last 30d" value={usd(cost?.total30dUsd)} accent="#e8e8ea" sub="measured window" />
        <StatTile
          label="Latest status"
          value={current?.status ?? "—"}
          accent={current ? STATUS_COLOR[current.status] : "#8a8d94"}
          sub={current ? fullDate(current.ranAt) : "no runs yet"}
        />
      </div>

      {/* Trend chart */}
      <Card className="p-4 mb-6">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold">
          <TrendingUp className="w-4 h-4" /> Projected monthly run-rate
        </div>
        {history.isLoading ? (
          <div className="h-72 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-72 flex flex-col items-center justify-center text-muted-foreground gap-2">
            <p>No audit runs recorded yet.</p>
            <Button size="sm" variant="outline" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
              Run the first audit
            </Button>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gProjected" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#c9a84c" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#c9a84c" stopOpacity={0.03} />
                </linearGradient>
                <linearGradient id="gDaily" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#4c8fc9" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#4c8fc9" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={20} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} width={64} />
              <Tooltip
                formatter={(v: any, name: any) => [usd(Number(v)), name === "projected" ? "Projected / mo" : "Last 24h"]}
                labelFormatter={(_l, p: any) => (p && p[0] ? fullDate(p[0].payload.ranAt) : "")}
                contentStyle={{ background: "#111216", border: "1px solid #2a2c33", borderRadius: 8, color: "#e8e8ea" }}
              />
              <Legend formatter={(v) => (v === "projected" ? "Projected / mo" : "Last 24h")} />
              <Area type="monotone" dataKey="projected" stroke="#c9a84c" strokeWidth={2} fill="url(#gProjected)" />
              <Area type="monotone" dataKey="daily" stroke="#4c8fc9" strokeWidth={1.5} fill="url(#gDaily)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      {/* Latest cost breakdown */}
      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Latest cost breakdown</div>
          {cost && (
            <span className={`text-xs ${cost.hasMeasuredAi ? "text-green-500" : "text-yellow-500"}`}>
              {cost.hasMeasuredAi ? "AI measured from token ledger" : "AI estimated (ledger warming up)"}
            </span>
          )}
        </div>
        {latest.isLoading ? (
          <div className="py-8 flex justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : !cost ? (
          <p className="text-sm text-muted-foreground py-4">
            No cost data yet. Run an audit (needs the database) to populate this.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase text-muted-foreground text-left">
                  <th className="py-2 pr-3">Driver</th>
                  <th className="py-2 px-3 text-right">Last 24h</th>
                  <th className="py-2 px-3 text-right">Last 30d</th>
                  <th className="py-2 pl-3 text-center">Source</th>
                </tr>
              </thead>
              <tbody>
                {cost.lines.map((l) => (
                  <tr key={l.driver} className="border-t border-border/50">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{l.driver}</div>
                      <div className="text-xs text-muted-foreground">{l.usage}</div>
                    </td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">{usd(l.last24hUsd)}</td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">{usd(l.last30dUsd)}</td>
                    <td className="py-2 pl-3 text-center">
                      <span className={`text-xs ${l.measured ? "text-green-500" : "text-yellow-500"}`}>
                        {l.measured ? "measured" : "estimated"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-3">{cost.note}</p>
          </div>
        )}
      </Card>

      {/* Recent runs */}
      <Card className="p-4">
        <div className="text-sm font-semibold mb-3">Recent audits</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-muted-foreground text-left">
                <th className="py-2 pr-3">When</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3 text-right">Projected / mo</th>
                <th className="py-2 px-3 text-right">Last 24h</th>
                <th className="py-2 pl-3">Checks</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().slice(0, 20).map((r) => (
                <tr key={r.id} className="border-t border-border/50">
                  <td className="py-2 pr-3 whitespace-nowrap">{fullDate(r.ranAt)}</td>
                  <td className="py-2 px-3">
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-semibold"
                      style={{ background: `${STATUS_COLOR[r.status]}22`, color: STATUS_COLOR[r.status] }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">{usd(r.projectedMonthlyUsd)}</td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">{usd(r.costLast24hUsd)}</td>
                  <td className="py-2 pl-3 whitespace-nowrap text-xs text-muted-foreground">
                    ✅ {r.passCount} · ⚠️ {r.warnCount} · ❌ {r.failCount}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground">
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase text-muted-foreground tracking-wide">{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </Card>
  );
}
