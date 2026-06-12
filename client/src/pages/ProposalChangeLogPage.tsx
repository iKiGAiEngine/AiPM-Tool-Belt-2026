import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { History, Search, X, Download, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

interface ChangeRecord {
  id: number;
  entryId: number;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string | null;
  changedAt: string;
  projectName: string | null;
  estimateNumber: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  entry_created: "Entry Created",
  entry_deleted: "Entry Deleted",
  deletion_requested: "Deletion Requested",
  deletion_rejected: "Deletion Rejected",
  deletion_cancelled: "Request Cancelled",
  nbsEstimator: "Estimator",
  estimateStatus: "Status",
  proposalTotal: "Proposal Total",
  gcEstimateLead: "GC Lead",
  selfPerformEstimator: "Self Perform",
  anticipatedStart: "Anticipated Start",
  anticipatedFinish: "Anticipated Finish",
  dueDate: "Due Date",
  notes: "Notes",
  bcLink: "BC Link",
  nbsSelectedScopes: "Scopes",
  finalReviewer: "Final Reviewer",
  swinertonProject: "Swinerton Project",
  region: "Region",
  primaryMarket: "Market",
  inviteDate: "Invite Date",
  estimateNumber: "Estimate #",
  filePath: "File Path",
  projectName: "Project Name",
  owner: "Owner",
  scopeList: "Scope List",
};

const FIELD_OPTIONS = Object.entries(FIELD_LABELS).map(([value, label]) => ({ value, label }));

function fieldLabel(f: string) {
  return FIELD_LABELS[f] || f;
}

function formatValue(val: string | null, fieldName: string): string {
  if (val == null || val === "") return "—";
  if (fieldName === "nbsSelectedScopes" || fieldName === "scopeList") {
    try {
      const arr = JSON.parse(val);
      if (Array.isArray(arr)) return arr.join(", ");
    } catch {}
  }
  if (fieldName === "proposalTotal") {
    const num = parseFloat(val.replace(/[^0-9.]/g, ""));
    if (!isNaN(num)) return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  }
  return val;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function fieldBadgeColor(fieldName: string): string {
  if (fieldName === "entry_created") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (fieldName === "entry_deleted") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (fieldName === "deletion_requested") return "bg-orange-500/15 text-orange-400 border-orange-500/30";
  if (fieldName === "deletion_rejected") return "bg-sky-500/15 text-sky-400 border-sky-500/30";
  if (fieldName === "deletion_cancelled") return "bg-slate-500/15 text-slate-400 border-slate-500/30";
  if (fieldName === "estimateStatus") return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  if (fieldName === "proposalTotal") return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  if (fieldName === "nbsEstimator") return "bg-purple-500/15 text-purple-400 border-purple-500/30";
  return "bg-muted text-muted-foreground border-border";
}

export default function ProposalChangeLogPage() {
  const [search, setSearch] = useState("");
  const [filterUser, setFilterUser] = useState("all");
  const [filterField, setFilterField] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [limit, setLimit] = useState(100);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const params = new URLSearchParams();
  if (search) params.set("projectName", search);
  if (filterUser && filterUser !== "all") params.set("changedBy", filterUser);
  if (filterField && filterField !== "all") params.set("fieldName", filterField);
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);
  params.set("limit", String(limit));

  const { data: rows = [], isLoading, refetch } = useQuery<ChangeRecord[]>({
    queryKey: ["/api/proposal-log/change-history", search, filterUser, filterField, fromDate, toDate, limit],
    queryFn: async () => {
      const res = await fetch(`/api/proposal-log/change-history?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const uniqueUsers = Array.from(new Set(rows.map(r => r.changedBy).filter(Boolean))) as string[];

  const clearFilters = useCallback(() => {
    setSearch("");
    setFilterUser("all");
    setFilterField("all");
    setFromDate("");
    setToDate("");
  }, []);

  const hasFilters = search || (filterUser && filterUser !== "all") || (filterField && filterField !== "all") || fromDate || toDate;

  const toggleExpand = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  function exportCSV() {
    const headers = ["Date/Time", "Project", "Estimate #", "Field", "Changed By", "Old Value", "New Value"];
    const csvRows = [
      headers.join(","),
      ...rows.map(r => [
        `"${formatDate(r.changedAt)}"`,
        `"${(r.projectName || "").replace(/"/g, '""')}"`,
        `"${r.estimateNumber || ""}"`,
        `"${fieldLabel(r.fieldName)}"`,
        `"${r.changedBy || ""}"`,
        `"${(formatValue(r.oldValue, r.fieldName)).replace(/"/g, '""')}"`,
        `"${(formatValue(r.newValue, r.fieldName)).replace(/"/g, '""')}"`,
      ].join(","))
    ];
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `proposal-change-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <BackNav href="/admin" label="Admin Dashboard" testId="link-back-admin" />
          <div className="w-px h-5 bg-border" />
          <History className="w-5 h-5" style={{ color: "var(--gold)" }} />
          <div>
            <h1 className="font-heading font-semibold text-xl leading-none">Proposal Change History</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Full audit trail of all additions and edits to proposal records</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-changelog">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={exportCSV} disabled={rows.length === 0} data-testid="button-export-changelog">
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Filters */}
        <Card className="p-4 mb-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-48">
              <label className="text-xs text-muted-foreground mb-1 block">Search Project</label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Project name…"
                  className="pl-8 h-8 text-sm"
                  data-testid="input-search-project"
                />
              </div>
            </div>

            <div className="min-w-36">
              <label className="text-xs text-muted-foreground mb-1 block">Changed By</label>
              <Select value={filterUser} onValueChange={setFilterUser}>
                <SelectTrigger className="h-8 text-sm" data-testid="select-filter-user">
                  <SelectValue placeholder="All users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {uniqueUsers.map(u => (
                    <SelectItem key={u} value={u}>{u}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-44">
              <label className="text-xs text-muted-foreground mb-1 block">Field</label>
              <Select value={filterField} onValueChange={setFilterField}>
                <SelectTrigger className="h-8 text-sm" data-testid="select-filter-field">
                  <SelectValue placeholder="All fields" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All fields</SelectItem>
                  {FIELD_OPTIONS.map(f => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-36">
              <label className="text-xs text-muted-foreground mb-1 block">From</label>
              <Input
                type="date"
                value={fromDate}
                onChange={e => setFromDate(e.target.value)}
                className="h-8 text-sm"
                data-testid="input-from-date"
              />
            </div>

            <div className="min-w-36">
              <label className="text-xs text-muted-foreground mb-1 block">To</label>
              <Input
                type="date"
                value={toDate}
                onChange={e => setToDate(e.target.value)}
                className="h-8 text-sm"
                data-testid="input-to-date"
              />
            </div>

            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters} className="h-8 gap-1.5" data-testid="button-clear-filters">
                <X className="w-3.5 h-3.5" />
                Clear
              </Button>
            )}
          </div>
        </Card>

        {/* Summary row */}
        <div className="flex items-center justify-between mb-3 text-xs text-muted-foreground">
          <span data-testid="text-row-count">
            {isLoading ? "Loading…" : `${rows.length} record${rows.length !== 1 ? "s" : ""}${rows.length === limit ? ` (showing first ${limit})` : ""}`}
          </span>
          {rows.length === limit && (
            <Button variant="ghost" size="sm" className="h-6 text-xs gap-1" onClick={() => setLimit(l => l + 100)} data-testid="button-load-more">
              Load more
            </Button>
          )}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <Card className="py-16 text-center text-muted-foreground text-sm">
            No change records found.
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground whitespace-nowrap">Date / Time</th>
                    <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">Project</th>
                    <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground whitespace-nowrap">Field</th>
                    <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground whitespace-nowrap">Changed By</th>
                    <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">Before</th>
                    <th className="text-left px-4 py-2.5 font-medium text-xs text-muted-foreground">After</th>
                    <th className="px-2 py-2.5 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const isCreate = row.fieldName === "entry_created";
                    const isDelete = row.fieldName === "entry_deleted";
                    const isDeletionReq = row.fieldName === "deletion_requested";
                    const isDeletionRej = row.fieldName === "deletion_rejected";
                    const isDeletionCan = row.fieldName === "deletion_cancelled";
                    const isSpecial = isCreate || isDelete || isDeletionReq || isDeletionRej || isDeletionCan;
                    const isLong = (row.oldValue?.length ?? 0) > 60 || (row.newValue?.length ?? 0) > 60;
                    const isExp = expanded.has(row.id);
                    let rowBg = i % 2 === 0 ? "" : "bg-muted/20";
                    if (isCreate) rowBg = "bg-emerald-500/5";
                    else if (isDelete) rowBg = "bg-red-500/5";
                    else if (isDeletionReq) rowBg = "bg-orange-500/5";
                    else if (isDeletionRej) rowBg = "bg-sky-500/5";
                    else if (isDeletionCan) rowBg = "bg-slate-500/5";
                    return (
                      <tr
                        key={row.id}
                        className={`border-b last:border-0 transition-colors ${rowBg} hover:bg-muted/30`}
                        data-testid={`row-change-${row.id}`}
                      >
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap align-top">
                          {formatDate(row.changedAt)}
                        </td>
                        <td className="px-4 py-2.5 align-top">
                          <div className="font-medium text-xs leading-snug">{row.projectName || "—"}</div>
                          {row.estimateNumber && (
                            <div className="text-xs text-muted-foreground">{row.estimateNumber}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 align-top whitespace-nowrap">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${fieldBadgeColor(row.fieldName)}`}>
                            {fieldLabel(row.fieldName)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 align-top text-xs text-muted-foreground whitespace-nowrap">
                          {row.changedBy || "—"}
                        </td>
                        {isCreate ? (
                          <td colSpan={2} className="px-4 py-2.5 align-top text-xs text-emerald-400 font-medium">
                            {row.newValue || "New entry added"}
                          </td>
                        ) : isDelete ? (
                          <td colSpan={2} className="px-4 py-2.5 align-top text-xs text-red-400 font-medium">
                            {row.oldValue || "Entry removed"}
                          </td>
                        ) : isDeletionReq ? (
                          <td colSpan={2} className="px-4 py-2.5 align-top text-xs text-orange-400 font-medium">
                            Requested by {row.newValue || row.changedBy || "—"}
                          </td>
                        ) : isDeletionRej ? (
                          <td colSpan={2} className="px-4 py-2.5 align-top text-xs text-sky-400 font-medium">
                            Rejected by {row.newValue || row.changedBy || "—"}
                          </td>
                        ) : isDeletionCan ? (
                          <td colSpan={2} className="px-4 py-2.5 align-top text-xs text-slate-400 font-medium">
                            Cancelled by {row.newValue || row.changedBy || "—"}
                          </td>
                        ) : (
                          <>
                            <td className="px-4 py-2.5 align-top max-w-xs">
                              <span className={`text-xs text-muted-foreground ${!isExp && isLong ? "line-clamp-2" : ""}`}>
                                {formatValue(row.oldValue, row.fieldName)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 align-top max-w-xs">
                              <span className={`text-xs ${!isExp && isLong ? "line-clamp-2" : ""}`}>
                                {formatValue(row.newValue, row.fieldName)}
                              </span>
                            </td>
                          </>
                        )}
                        <td className="px-2 py-2.5 align-top">
                          {!isSpecial && isLong && (
                            <button
                              onClick={() => toggleExpand(row.id)}
                              className="text-muted-foreground hover:text-foreground"
                              data-testid={`button-expand-${row.id}`}
                            >
                              {isExp ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {rows.length === limit && (
          <div className="mt-3 text-center">
            <Button variant="outline" size="sm" onClick={() => setLimit(l => l + 100)} data-testid="button-load-more-bottom">
              Load {Math.min(100, limit)} more records
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
