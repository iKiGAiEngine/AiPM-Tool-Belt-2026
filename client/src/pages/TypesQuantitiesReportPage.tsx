import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Download, RefreshCw, Copy, Check, AlertTriangle, Loader2 } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

interface TqMetrics {
  bidCount: number;
  receivedCount: number;
  coveragePct: number;
  notReceivedCount: number;
  measurableCount: number;
  medianLeadBd: number | null;
  avgLeadBd: number | null;
  p90LeadBd: number | null;
  minLeadBd: number | null;
  crunchCount: number;
  lateCount: number;
}

interface TqGroup extends TqMetrics {
  key: string;
  label: string;
}

interface TqDetailRow {
  id: number;
  projectName: string | null;
  estimateNumber: string | null;
  region: string | null;
  primaryMarket: string | null;
  nbsEstimator: string | null;
  gcEstimateLead: string | null;
  estimateStatus: string | null;
  dueDate: string | null;
  tqReceivedDate: string | null;
  tqReceivedBy: string | null;
  received: boolean;
  leadBusinessDays: number | null;
  bucket: string;
  bucketLabel: string;
}

interface TqReport {
  type: string;
  generatedAt: string;
  periodLabel: string;
  overall: TqMetrics;
  buckets: Array<{ bucket: string; label: string; count: number; pct: number }>;
  groups: TqGroup[];
  rows: TqDetailRow[];
  tldr: string;
  watchItems: Array<{ kind: string; text: string; filter?: Record<string, string> }>;
}

interface FilterOptions {
  regions: string[];
  markets: string[];
  estimators: string[];
  statuses: string[];
}

const REPORT_TYPES = [
  { value: "summary", label: "Executive Summary" },
  { value: "by-region", label: "By Region" },
  { value: "by-market", label: "By Market" },
  { value: "by-gc", label: "By GC / Client" },
  { value: "by-estimator", label: "By Estimator" },
  { value: "by-month", label: "Monthly Trend" },
  { value: "detail", label: "Bid Detail" },
  { value: "exceptions", label: "Exceptions" },
];

const GROUPED_TYPES = new Set(["by-region", "by-market", "by-gc", "by-estimator", "by-month"]);
const ROW_TYPES = new Set(["detail", "exceptions"]);

// Green through red: more runway is better.
const BUCKET_COLORS: Record<string, string> = {
  ample: "bg-emerald-500",
  comfortable: "bg-green-500",
  tight: "bg-amber-500",
  crunch: "bg-orange-500",
  bid_day: "bg-orange-600",
  late: "bg-red-500",
  not_received: "bg-slate-500",
  unmeasurable: "bg-slate-400",
};

const BUCKET_BADGES: Record<string, string> = {
  ample: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  comfortable: "bg-green-500/15 text-green-400 border-green-500/30",
  tight: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  crunch: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  bid_day: "bg-orange-600/15 text-orange-500 border-orange-600/30",
  late: "bg-red-500/15 text-red-400 border-red-500/30",
  not_received: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  unmeasurable: "bg-slate-400/15 text-slate-400 border-slate-400/30",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function fmtNum(n: number | null, suffix = ""): string {
  if (n === null || n === undefined) return "—";
  return `${n}${suffix}`;
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <Card className="p-4" data-testid={`tile-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${tone || ""}`}>{value}</div>
      {sub ? <div className="text-xs text-muted-foreground mt-1">{sub}</div> : null}
    </Card>
  );
}

export default function TypesQuantitiesReportPage() {
  const [type, setType] = useState("summary");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [region, setRegion] = useState("all");
  const [market, setMarket] = useState("all");
  const [estimator, setEstimator] = useState("all");
  const [status, setStatus] = useState("all");
  const [includeTest, setIncludeTest] = useState(false);
  const [copied, setCopied] = useState(false);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set("type", type);
    if (fromDate) p.set("from", fromDate);
    if (toDate) p.set("to", toDate);
    if (region !== "all") p.set("region", region);
    if (market !== "all") p.set("market", market);
    if (estimator !== "all") p.set("estimator", estimator);
    if (status !== "all") p.set("status", status);
    if (includeTest) p.set("includeTest", "true");
    return p;
  }, [type, fromDate, toDate, region, market, estimator, status, includeTest]);

  const { data: options } = useQuery<FilterOptions>({
    queryKey: ["/api/reports/types-quantities/filters"],
    queryFn: async () => {
      const res = await fetch("/api/reports/types-quantities/filters", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load filter options");
      return res.json();
    },
  });

  const {
    data: report,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery<TqReport>({
    queryKey: ["/api/reports/types-quantities", params.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/reports/types-quantities?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Request failed (${res.status})`);
      }
      return res.json();
    },
  });

  function downloadCsv() {
    const p = new URLSearchParams(params);
    p.set("format", "csv");
    window.location.href = `/api/reports/types-quantities?${p.toString()}`;
  }

  async function copyTldr() {
    if (!report) return;
    const lines = [report.tldr, ...report.watchItems.map((w) => `• ${w.text}`)];
    try {
      await navigator.clipboard.writeText(lines.join("\n\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the text is on screen to copy by hand */
    }
  }

  const m = report?.overall;

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <BackNav href="/admin" label="Admin Dashboard" testId="link-back-admin" />

      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold" data-testid="heading-tq-report">
              T&amp;Q Lead Time Report
            </h1>
            <p className="text-sm text-muted-foreground">
              How far ahead of bid day the types &amp; quantities actually arrived.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh">
            <RefreshCw className={`w-4 h-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={downloadCsv} data-testid="button-export-csv">
            <Download className="w-4 h-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card className="p-4 mt-5 mb-5">
        <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-4">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Report</label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="mt-1" data-testid="select-report-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Bid Due From
            </label>
            <Input
              type="date"
              className="mt-1"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              data-testid="input-from-date"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Bid Due To
            </label>
            <Input
              type="date"
              className="mt-1"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              data-testid="input-to-date"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Region</label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger className="mt-1" data-testid="select-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All regions</SelectItem>
                {(options?.regions || []).map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Market</label>
            <Select value={market} onValueChange={setMarket}>
              <SelectTrigger className="mt-1" data-testid="select-market">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All markets</SelectItem>
                {(options?.markets || []).map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Estimator
            </label>
            <Select value={estimator} onValueChange={setEstimator}>
              <SelectTrigger className="mt-1" data-testid="select-estimator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All estimators</SelectItem>
                {(options?.estimators || []).map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Status</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="mt-1" data-testid="select-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {(options?.statuses || []).map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={includeTest}
                onChange={(e) => setIncludeTest(e.target.checked)}
                data-testid="checkbox-include-test"
              />
              Include test entries
            </label>
          </div>
        </div>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : isError ? (
        <Card className="p-6 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5" />
          <div>
            <div className="font-medium">Could not build the report</div>
            <div className="text-sm text-muted-foreground" data-testid="text-error">
              {(error as Error)?.message}
            </div>
          </div>
        </Card>
      ) : !report ? null : (
        <>
          {/* TL;DR */}
          <Card className="p-5 mb-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                TL;DR · {report.periodLabel}
              </div>
              <Button variant="ghost" size="sm" onClick={copyTldr} data-testid="button-copy-tldr">
                {copied ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-base leading-relaxed" data-testid="text-tldr">
              {report.tldr}
            </p>
            {report.watchItems.length > 0 && (
              <ul className="mt-4 space-y-2" data-testid="list-watch-items">
                {report.watchItems.map((w, i) => (
                  <li key={i} className="text-sm flex gap-2 text-muted-foreground">
                    <span className="text-primary">▸</span>
                    <span>{w.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* KPI tiles */}
          {m && (
            <div className="grid gap-3 grid-cols-2 md:grid-cols-5 mb-5">
              <StatTile
                label="Coverage"
                value={`${m.coveragePct}%`}
                sub={`${m.receivedCount} of ${m.bidCount} bids`}
              />
              <StatTile label="Median Lead" value={fmtNum(m.medianLeadBd, " BD")} sub="business days before bid day" />
              <StatTile
                label="Crunch"
                value={m.bidCount ? `${Math.round((m.crunchCount / m.bidCount) * 100)}%` : "—"}
                sub={`${m.crunchCount} bids inside 3 BD`}
                tone={m.crunchCount > 0 ? "text-orange-400" : ""}
              />
              <StatTile
                label="Late / Never"
                value={String(m.lateCount + m.notReceivedCount)}
                sub={`${m.lateCount} late · ${m.notReceivedCount} never`}
                tone={m.lateCount + m.notReceivedCount > 0 ? "text-red-400" : ""}
              />
              <StatTile label="P90 Lead" value={fmtNum(m.p90LeadBd, " BD")} sub="best-case tail" />
            </div>
          )}

          {/* Bucket distribution */}
          {report.buckets.length > 0 && (
            <Card className="p-5 mb-5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
                Runway Distribution
              </div>
              <div className="flex h-4 rounded overflow-hidden mb-3" data-testid="bar-buckets">
                {report.buckets.map((b) => (
                  <div
                    key={b.bucket}
                    className={BUCKET_COLORS[b.bucket] || "bg-slate-500"}
                    style={{ width: `${b.pct}%` }}
                    title={`${b.label}: ${b.count} (${b.pct}%)`}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                {report.buckets.map((b) => (
                  <div key={b.bucket} className="flex items-center gap-1.5 text-xs">
                    <span className={`w-2.5 h-2.5 rounded-sm ${BUCKET_COLORS[b.bucket] || "bg-slate-500"}`} />
                    <span className="text-muted-foreground">{b.label}</span>
                    <span className="font-medium">
                      {b.count} ({b.pct}%)
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Grouped table */}
          {GROUPED_TYPES.has(report.type) && (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-groups">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="px-4 py-2 font-semibold">
                        {REPORT_TYPES.find((t) => t.value === report.type)?.label}
                      </th>
                      <th className="px-4 py-2 font-semibold text-right">Bids</th>
                      <th className="px-4 py-2 font-semibold text-right">Received</th>
                      <th className="px-4 py-2 font-semibold text-right">Coverage</th>
                      <th className="px-4 py-2 font-semibold text-right">Median BD</th>
                      <th className="px-4 py-2 font-semibold text-right">Avg BD</th>
                      <th className="px-4 py-2 font-semibold text-right">Crunch</th>
                      <th className="px-4 py-2 font-semibold text-right">Late</th>
                      <th className="px-4 py-2 font-semibold text-right">Never</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.groups.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                          No bids match these filters.
                        </td>
                      </tr>
                    ) : (
                      report.groups.map((g) => (
                        <tr key={g.key} className="border-t border-border" data-testid={`row-group-${g.key}`}>
                          <td className="px-4 py-2">{g.label}</td>
                          <td className="px-4 py-2 text-right">{g.bidCount}</td>
                          <td className="px-4 py-2 text-right">{g.receivedCount}</td>
                          <td
                            className={`px-4 py-2 text-right font-medium ${
                              g.coveragePct < 50 ? "text-red-400" : g.coveragePct < 80 ? "text-amber-400" : ""
                            }`}
                          >
                            {g.coveragePct}%
                          </td>
                          <td className="px-4 py-2 text-right">{fmtNum(g.medianLeadBd)}</td>
                          <td className="px-4 py-2 text-right">{fmtNum(g.avgLeadBd)}</td>
                          <td className="px-4 py-2 text-right">{g.crunchCount}</td>
                          <td className="px-4 py-2 text-right">{g.lateCount}</td>
                          <td className="px-4 py-2 text-right">{g.notReceivedCount}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Detail / exceptions table */}
          {ROW_TYPES.has(report.type) && (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="table-rows">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="px-4 py-2 font-semibold">Project</th>
                      <th className="px-4 py-2 font-semibold">Est #</th>
                      <th className="px-4 py-2 font-semibold">Region</th>
                      <th className="px-4 py-2 font-semibold">Estimator</th>
                      <th className="px-4 py-2 font-semibold">GC Lead</th>
                      <th className="px-4 py-2 font-semibold">Due</th>
                      <th className="px-4 py-2 font-semibold">T&amp;Q Received</th>
                      <th className="px-4 py-2 font-semibold text-right">Lead (BD)</th>
                      <th className="px-4 py-2 font-semibold">Runway</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                          {report.type === "exceptions"
                            ? "No exceptions — every bid had types & quantities in hand with room to spare."
                            : "No bids match these filters."}
                        </td>
                      </tr>
                    ) : (
                      report.rows.map((r) => (
                        <tr key={r.id} className="border-t border-border" data-testid={`row-bid-${r.id}`}>
                          <td className="px-4 py-2 max-w-[240px] truncate" title={r.projectName || ""}>
                            {r.projectName || "—"}
                          </td>
                          <td className="px-4 py-2 text-muted-foreground">{r.estimateNumber || "—"}</td>
                          <td className="px-4 py-2 text-muted-foreground">{r.region || "—"}</td>
                          <td className="px-4 py-2 text-muted-foreground">{r.nbsEstimator || "—"}</td>
                          <td className="px-4 py-2 max-w-[160px] truncate" title={r.gcEstimateLead || ""}>
                            {r.gcEstimateLead || "—"}
                          </td>
                          <td className="px-4 py-2">{fmtDate(r.dueDate)}</td>
                          <td className="px-4 py-2">
                            {fmtDate(r.tqReceivedDate)}
                            {r.tqReceivedBy ? (
                              <span className="text-muted-foreground text-xs"> · {r.tqReceivedBy}</span>
                            ) : null}
                          </td>
                          <td className="px-4 py-2 text-right font-medium">{fmtNum(r.leadBusinessDays)}</td>
                          <td className="px-4 py-2">
                            <Badge variant="outline" className={BUCKET_BADGES[r.bucket] || ""}>
                              {r.bucketLabel}
                            </Badge>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="text-xs text-muted-foreground mt-4">
            Lead time is counted in business days (weekends excluded, holidays not modeled) between the T&amp;Q
            received date and the bid due date. Negative values mean the types &amp; quantities arrived after bid day.
          </p>
        </>
      )}
    </div>
  );
}
