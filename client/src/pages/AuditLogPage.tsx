import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollText, Search, Loader2, Filter } from "lucide-react";
import { Link } from "wouter";
import { BackNav } from "@/components/BackNav";
import type { AuditLog } from "@shared/schema";

export default function AuditLogPage() {
  const [userFilter, setUserFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<Record<string, string>>({});

  const buildQueryParams = () => {
    const params = new URLSearchParams();
    if (appliedFilters.user) params.set("user", appliedFilters.user);
    if (appliedFilters.from) params.set("from", appliedFilters.from);
    if (appliedFilters.to) params.set("to", appliedFilters.to);
    if (appliedFilters.action && appliedFilters.action !== "all") params.set("action", appliedFilters.action);
    if (appliedFilters.search) params.set("search", appliedFilters.search);
    params.set("limit", "200");
    return params.toString();
  };

  const { data: logs = [], isLoading } = useQuery<AuditLog[]>({
    queryKey: ["/api/admin/audit", appliedFilters],
    queryFn: async () => {
      const qs = buildQueryParams();
      const res = await fetch(`/api/admin/audit?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch audit logs");
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const { data: actionTypes = [] } = useQuery<string[]>({
    queryKey: ["/api/admin/audit/action-types"],
  });

  const applyFilters = () => {
    setAppliedFilters({
      user: userFilter,
      from: fromDate,
      to: toDate,
      action: actionFilter,
      search: searchText,
    });
  };

  const clearFilters = () => {
    setUserFilter("");
    setFromDate("");
    setToDate("");
    setActionFilter("all");
    setSearchText("");
    setAppliedFilters({});
  };

  const getActionBadgeColor = (action: string) => {
    if (action.includes("login")) return "text-blue-600 border-blue-600/30 bg-blue-500/10";
    if (action.includes("logout")) return "text-gray-600 border-gray-600/30 bg-gray-500/10";
    if (action.includes("delete") || action.includes("deactivat")) return "text-red-600 border-red-600/30 bg-red-500/10";
    if (action.includes("create") || action.includes("activat")) return "text-green-600 border-green-600/30 bg-green-500/10";
    return "text-muted-foreground";
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <BackNav href="/admin" label="Admin Dashboard" testId="button-back-admin" />
            <ScrollText className="w-5 h-5" style={{ color: "var(--gold)" }} />
            <h1 className="text-2xl font-heading font-semibold text-foreground">Audit Log</h1>
          </div>
          <p className="text-muted-foreground ml-12">Activity history for all users.</p>
        </div>

        <Card className="p-4 mb-6 card-accent-bar">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-heading font-medium">Filters</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">User Email</Label>
              <Input
                placeholder="Filter by email..."
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                data-testid="input-filter-user"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">From Date</Label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                data-testid="input-filter-from"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To Date</Label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                data-testid="input-filter-to"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Action Type</Label>
              <Select value={actionFilter} onValueChange={setActionFilter}>
                <SelectTrigger data-testid="select-filter-action">
                  <SelectValue placeholder="All actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {actionTypes.map((at) => (
                    <SelectItem key={at} value={at}>{at}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Search</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="pl-8"
                  data-testid="input-filter-search"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" onClick={applyFilters} data-testid="button-apply-filters">
              Apply Filters
            </Button>
            <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="button-clear-filters">
              Clear
            </Button>
            <span className="text-xs text-muted-foreground ml-auto font-heading font-bold" style={{ color: "var(--gold)" }}>
              {logs.length} entries
            </span>
          </div>
        </Card>

        <Card className="card-accent-bar">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[140px]">Timestamp</TableHead>
                  <TableHead className="min-w-[180px]">User</TableHead>
                  <TableHead className="min-w-[120px]">Action</TableHead>
                  <TableHead className="min-w-[200px]">Summary</TableHead>
                  <TableHead className="min-w-[100px]">Path</TableHead>
                  <TableHead className="min-w-[60px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin mx-auto text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No audit log entries found
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id} data-testid={`row-audit-${log.id}`}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {log.timestamp ? new Date(log.timestamp).toLocaleString() : "-"}
                      </TableCell>
                      <TableCell className="text-sm">{log.actorEmail || "-"}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${getActionBadgeColor(log.actionType)}`}>
                          {log.actionType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[300px] truncate">
                        {log.summary || "-"}
                      </TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground">
                        {log.requestPath || "-"}
                      </TableCell>
                      <TableCell className="text-xs text-center">
                        {log.responseStatus ? (
                          <span className={log.responseStatus < 400 ? "text-green-600" : "text-red-600"}>
                            {log.responseStatus}
                          </span>
                        ) : "-"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>
    </div>
  );
}
