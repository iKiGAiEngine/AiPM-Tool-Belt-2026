import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, ChevronUp, ChevronDown, FileSpreadsheet, FileText, FlaskConical, Archive, FileEdit, Check, X, FolderPlus, Loader2, MessageSquare, ListChecks, Calculator, Camera } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTestMode } from "@/lib/testMode";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { saveAs } from "file-saver";
import * as XLSX from "xlsx";
import { NewBidsTab } from "@/components/NewBidsTab";

interface ProposalLogEntry {
  id: number;
  projectName: string;
  estimateNumber: string | null;
  region: string | null;
  primaryMarket: string | null;
  inviteDate: string | null;
  dueDate: string | null;
  nbsEstimator: string | null;
  gcEstimateLead: string | null;
  proposalTotal: string | null;
  estimateStatus: string | null;
  owner: string | null;
  filePath: string | null;
  projectDbId: number | null;
  anticipatedStart: string | null;
  anticipatedFinish: string | null;
  projectAddress: string | null;
  squareFeet: string | null;
  bcLink: string | null;
  screenshotPath: string | null;
  sourceType: string | null;
  ndaRequired: boolean | null;
  bcAccessStatus: string | null;
  isTest: boolean | null;
  isDraft: boolean | null;
  bcProjectId: string | null;
  bcOpportunityIds: string | null;
  scopeList: string | null;
  nbsSelectedScopes: string | null;
  draftApprovedBy: string | null;
  notes: string | null;
  draftApprovedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  duplicateOverrideNote: string | null;
}

type SortField = "projectName" | "region" | "dueDate" | "estimateStatus" | "nbsEstimator" | "createdAt";
type SortDir = "asc" | "desc";
type ViewTab = "all" | "active" | "drafts" | "deleted" | "newbids";

export default function ProposalLogPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [viewTab, setViewTab] = useState<ViewTab>(() => {
    if (typeof window === "undefined") return "all";
    const params = new URLSearchParams(window.location.search);
    return params.get("tab") === "newbids" ? "newbids" : "all";
  });
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [scopePopupEntryId, setScopePopupEntryId] = useState<number | null>(null);
  const [notesPopupEntryId, setNotesPopupEntryId] = useState<number | null>(null);
  const [notesPopupText, setNotesPopupText] = useState("");
  const [noBidNotesEntryId, setNoBidNotesEntryId] = useState<number | null>(null);
  const [noBidNotesText, setNoBidNotesText] = useState("");
  const [noBidPendingStatus, setNoBidPendingStatus] = useState<string>("");
  const [draftScopes, setDraftScopes] = useState<string[]>([]);
  const [regionFilter, setRegionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>(["Estimating", "Revising", "Draft"]);
  const scopePopupRef = useRef<HTMLDivElement>(null);
  const notesPopupRef = useRef<HTMLDivElement>(null);
  const { isTestMode } = useTestMode();
  const { toast } = useToast();
  const { isAdmin, isViewer } = useAuth();
  const { hasFeature } = useFeatureAccess();
  const canSeeNewBids = isAdmin || hasFeature("bc-sync") || hasFeature("draft-review");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bc = params.get("bc");
    if (bc === "connected") {
      toast({ title: "BuildingConnected linked", description: "Your account is now connected." });
      queryClient.invalidateQueries({ queryKey: ["/api/autodesk/status"] });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (bc === "error") {
      toast({ title: "Connection failed", description: "Could not connect to BuildingConnected. Please try again.", variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const { data: dbRegions = [] } = useQuery<{ id: number; code: string; name: string | null; isActive: boolean }[]>({
    queryKey: ["/api/regions", "active"],
    queryFn: async () => {
      const res = await fetch("/api/regions?active=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load regions");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const regionDisplayOptions = useMemo(() => {
    return dbRegions.map(r => `${r.code} - ${r.name}`);
  }, [dbRegions]);

  const { data: entries = [], isLoading } = useQuery<ProposalLogEntry[]>({
    queryKey: ["/api/proposal-log/all-entries"],
    queryFn: async () => {
      const res = await fetch("/api/proposal-log/all-entries", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch project log entries");
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const recreateFolderMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/proposal-log/${id}/recreate-folder`);
      return res as unknown as { folderName: string; folderAlreadyExists: boolean; filesAdded: number; estimateStamped: boolean };
    },
    onSuccess: (data) => {
      const verb = data.folderAlreadyExists ? "Refreshed" : "Created";
      const detail = data.folderAlreadyExists
        ? `Filled in ${data.filesAdded} missing file${data.filesAdded === 1 ? "" : "s"}${data.estimateStamped ? " and stamped a fresh estimate workbook" : ""}.`
        : `Project folder created with template files${data.estimateStamped ? " and a stamped estimate workbook" : ""}.`;
      toast({ title: `${verb} bid folder`, description: `${data.folderName} — ${detail}` });
    },
    onError: (err: any) => {
      toast({ title: "Could not re-create folder", description: err?.message || "An error occurred", variant: "destructive" });
    },
  });

  const NBS_SCOPES = [
    "Toilet Accessories", "Toilet Compartments", "FEC", "Wall Protection",
    "Appliances", "Lockers", "Visual Displays", "Bike Racks",
    "Wire Mesh Partitions", "Cubicle Curtains", "Med Equipment", "Expansion Joints",
    "Shelving", "Equipment", "Entrance Mats",
    "Mailbox", "Flagpole", "Knox Box", "Site Furnishing",
  ];

  const inlineUpdateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, string> }) => {
      await apiRequest("PATCH", `/api/proposal-log/entry/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update entry.", variant: "destructive" });
    },
  });

  const toggleDraftScope = (scope: string) => {
    setDraftScopes(prev =>
      prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]
    );
  };

  const commitScopes = (entryId: number) => {
    if (guardViewer(isViewer, toast)) return;
    inlineUpdateMutation.mutate({ id: entryId, data: { nbsSelectedScopes: JSON.stringify(draftScopes) } });
    setScopePopupEntryId(null);
  };

  const openScopePopup = (entry: ProposalLogEntry) => {
    setScopePopupEntryId(entry.id);
    setDraftScopes(parseNbsScopes(entry.nbsSelectedScopes));
  };

  const parseNbsScopes = (raw: string | null): string[] => {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  };

  const saveNotes = (entryId: number, text: string) => {
    if (guardViewer(isViewer, toast)) return;
    inlineUpdateMutation.mutate({ id: entryId, data: { notes: text } });
    setNotesPopupEntryId(null);
  };

  const handleStatusChange = (entryId: number, newStatus: string) => {
    if (guardViewer(isViewer, toast)) return;
    if (newStatus === "No Bid" || newStatus === "Lost") {
      setNoBidNotesEntryId(entryId);
      setNoBidPendingStatus(newStatus);
      setNoBidNotesText("");
    } else {
      inlineUpdateMutation.mutate({ id: entryId, data: { estimateStatus: newStatus } });
    }
  };

  const confirmNoBidNotes = () => {
    if (noBidNotesEntryId !== null) {
      inlineUpdateMutation.mutate({
        id: noBidNotesEntryId,
        data: { estimateStatus: noBidPendingStatus, notes: noBidNotesText },
      });
      setNoBidNotesEntryId(null);
      setNoBidNotesText("");
      setNoBidPendingStatus("");
    }
  };

  const skipNoBidNotes = () => {
    if (noBidNotesEntryId !== null) {
      inlineUpdateMutation.mutate({
        id: noBidNotesEntryId,
        data: { estimateStatus: noBidPendingStatus },
      });
      setNoBidNotesEntryId(null);
      setNoBidNotesText("");
      setNoBidPendingStatus("");
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (scopePopupRef.current && !scopePopupRef.current.contains(e.target as Node)) {
        if (scopePopupEntryId !== null) commitScopes(scopePopupEntryId);
      }
      if (notesPopupRef.current && !notesPopupRef.current.contains(e.target as Node)) {
        if (notesPopupEntryId !== null) {
          const entry = entries.find(en => en.id === notesPopupEntryId);
          if (entry && notesPopupText !== (entry.notes || "")) {
            saveNotes(notesPopupEntryId, notesPopupText);
          } else {
            setNotesPopupEntryId(null);
          }
        }
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [notesPopupEntryId, notesPopupText, entries, scopePopupEntryId, draftScopes]);

  const normalizeRegionForDropdown = (raw: string) => {
    if (!raw) return "";
    const oldMatch = raw.match(/^(.+?)\s*\(([A-Z]{2,5})\)$/);
    if (oldMatch) {
      const code = oldMatch[2];
      const r = dbRegions.find(rg => rg.code.toUpperCase() === code);
      if (r) return `${r.code} - ${r.name}`;
      return `${code} - ${oldMatch[1].trim()}`;
    }
    if (/^[A-Z]{2,5}$/.test(raw.trim())) {
      const r = dbRegions.find(rg => rg.code.toUpperCase() === raw.trim().toUpperCase());
      if (r) return `${r.code} - ${r.name}`;
    }
    if (/^[A-Z]{2,5}\s*-\s*.+/.test(raw)) return raw;
    return raw;
  };

  const uniqueRegions = useMemo(() => {
    const regions = new Set<string>();
    entries.forEach(e => { if (e.region) regions.add(e.region); });
    return Array.from(regions).sort();
  }, [entries]);

  const filteredEntries = useMemo(() => {
    let filtered = [...entries];

    if (!isTestMode) {
      filtered = filtered.filter(e => !e.isTest);
    }

    if (regionFilter) {
      filtered = filtered.filter(e => e.region === regionFilter);
    }

    if (statusFilter.length > 0) {
      filtered = filtered.filter(e => {
        if ((e as any).isDraft) return statusFilter.includes("Draft");
        return statusFilter.includes(e.estimateStatus || "Estimating");
      });
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        (e.projectName || "").toLowerCase().includes(q) ||
        (e.estimateNumber || "").toLowerCase().includes(q) ||
        (e.region || "").toLowerCase().includes(q) ||
        (e.nbsEstimator || "").toLowerCase().includes(q) ||
        (e.gcEstimateLead || "").toLowerCase().includes(q)
      );
    }

    if (viewTab === "active") {
      filtered = filtered.filter(e => !e.deletedAt && !e.isDraft);
    } else if (viewTab === "drafts") {
      filtered = filtered.filter(e => e.isDraft && !e.deletedAt);
    } else if (viewTab === "deleted") {
      filtered = filtered.filter(e => !!e.deletedAt);
    }

    filtered.sort((a, b) => {
      let aVal: string | number = "";
      let bVal: string | number = "";

      switch (sortField) {
        case "projectName": aVal = (a.projectName || "").toLowerCase(); bVal = (b.projectName || "").toLowerCase(); break;
        case "region": aVal = a.region || ""; bVal = b.region || ""; break;
        case "dueDate": aVal = a.dueDate || ""; bVal = b.dueDate || ""; break;
        case "estimateStatus": aVal = a.deletedAt ? "Deleted" : (a.estimateStatus || ""); bVal = b.deletedAt ? "Deleted" : (b.estimateStatus || ""); break;
        case "nbsEstimator": aVal = a.nbsEstimator || ""; bVal = b.nbsEstimator || ""; break;
        case "createdAt": aVal = new Date(a.createdAt || 0).getTime(); bVal = new Date(b.createdAt || 0).getTime(); break;
      }

      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return filtered;
  }, [entries, searchQuery, viewTab, sortField, sortDir, isTestMode, regionFilter, statusFilter]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />;
  };

  const visibleEntries = entries.filter(e => !e.isTest || isTestMode);
  const activeCount = visibleEntries.filter(e => !e.deletedAt && !e.isDraft).length;
  const draftCount = visibleEntries.filter(e => e.isDraft && !e.deletedAt).length;
  const deletedCount = visibleEntries.filter(e => !!e.deletedAt).length;

  const exportToCSV = () => {
    const headers = ["Project Name", "Region", "Due Date", "Status", "Estimator", "GC Lead", "NBS Scopes", "Notes", "Market", "BC Link", "Created", "Deleted"];
    const rows = filteredEntries.map(e => [
      e.projectName,
      e.region || "",
      e.dueDate || "",
      e.deletedAt ? "DELETED" : e.isDraft ? "DRAFT" : (e.estimateStatus || ""),
      e.nbsEstimator || "",
      e.gcEstimateLead || "",
      parseNbsScopes(e.nbsSelectedScopes).join(", "),
      e.notes || "",
      e.primaryMarket || "",
      e.bcLink || "",
      e.createdAt ? new Date(e.createdAt).toLocaleString() : "",
      e.deletedAt ? new Date(e.deletedAt).toLocaleString() : "",
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${(cell || "").replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    saveAs(blob, `proposal_log_${new Date().toISOString().split("T")[0]}.csv`);
  };

  const exportToXLSX = () => {
    const headers = ["Project Name", "Region", "Due Date", "Status", "Estimator", "GC Lead", "NBS Scopes", "Notes", "Market", "BC Link", "Created", "Deleted"];
    const rows = filteredEntries.map(e => [
      e.projectName,
      e.region || "",
      e.dueDate || "",
      e.deletedAt ? "DELETED" : e.isDraft ? "DRAFT" : (e.estimateStatus || ""),
      e.nbsEstimator || "",
      e.gcEstimateLead || "",
      parseNbsScopes(e.nbsSelectedScopes).join(", "),
      e.notes || "",
      e.primaryMarket || "",
      e.bcLink || "",
      e.createdAt ? new Date(e.createdAt).toLocaleString() : "",
      e.deletedAt ? new Date(e.deletedAt).toLocaleString() : "",
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const colWidths = headers.map((_, i) => ({
      wch: Math.max(headers[i].length, ...rows.map(r => (r[i] || "").toString().length)) + 2,
    }));
    ws["!cols"] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Proposal Log");
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    saveAs(blob, `proposal_log_${new Date().toISOString().split("T")[0]}.xlsx`);
  };

  const fmtDate = (d: string | null) => {
    if (!d) return "\u2014";
    const [y, m, dy] = d.split("-");
    if (!y || !m || !dy) return d;
    return `${m}/${dy}/${y}`;
  };

  const parseScopeList = (scopeListStr: string | null): string[] => {
    if (!scopeListStr) return [];
    try {
      return JSON.parse(scopeListStr);
    } catch {
      return [];
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <div className="container max-w-7xl mx-auto py-8 px-4">
        <ReadOnlyBanner />
        <div className="flex items-center gap-4 mb-8">
          <BackNav href="/" label="Home" testId="button-back" />
          <div className="flex-1">
            <h1 className="text-2xl font-heading font-semibold" style={{ color: "var(--text)" }}>Proposal Log</h1>
            <p className="text-sm" style={{ color: "var(--text-dim)" }}>
              {viewTab === "newbids"
                ? "Review, accept, merge, or reject bids synced from BuildingConnected"
                : "Active bids, pipeline tracking & estimating workflow"}
            </p>
          </div>
          {viewTab !== "newbids" && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={exportToCSV} data-testid="button-export-csv">
                <FileText className="w-4 h-4 mr-2" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={exportToXLSX} data-testid="button-export-xlsx">
                <FileSpreadsheet className="w-4 h-4 mr-2" />
                XLSX
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-xl card-accent-bar" style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}>
          <div className="pb-4 p-6">
            {viewTab !== "newbids" && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <select
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
                className="text-xs h-8 rounded-md px-2 border"
                style={{ background: "var(--bg-input)", borderColor: "var(--border-ds)", color: "var(--text)" }}
                data-testid="select-region-filter"
              >
                <option value="">All Regions</option>
                {uniqueRegions.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <div className="flex items-center gap-1 flex-wrap" data-testid="status-filter-chips">
                {["Estimating", "Submitted", "Revising", "Won", "Lost", "No Bid", "Draft"].map(s => {
                  const active = statusFilter.includes(s);
                  return (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])}
                      className="text-xs h-7 px-2 rounded-md border transition-colors"
                      style={{
                        background: active ? "var(--gold)" : "var(--bg-input)",
                        borderColor: active ? "var(--gold)" : "var(--border-ds)",
                        color: active ? "#fff" : "var(--text-dim)",
                        fontWeight: active ? 600 : 400,
                      }}
                      data-testid={`filter-status-${s.toLowerCase().replace(/\s/g, "-")}`}
                    >
                      {s}
                    </button>
                  );
                })}
                {statusFilter.length > 0 && (
                  <button
                    onClick={() => setStatusFilter([])}
                    className="text-xs h-7 px-2 rounded-md border transition-colors"
                    style={{ background: "var(--bg-input)", borderColor: "var(--border-ds)", color: "var(--text-muted)" }}
                    data-testid="filter-status-clear"
                  >
                    All
                  </button>
                )}
              </div>
            </div>
            )}
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--text-dim)" }} />
                <Input
                  placeholder="Search by name, estimate #, region, estimator..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                  style={{ background: "var(--bg-input)", borderColor: "var(--border-ds)", color: "var(--text)" }}
                  data-testid="input-search-projects"
                />
              </div>
              <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: "var(--bg-input)" }}>
                {([
                  { key: "all" as ViewTab, label: "All", count: activeCount + draftCount + deletedCount },
                  { key: "active" as ViewTab, label: "Active", count: activeCount },
                  { key: "drafts" as ViewTab, label: "Drafts", count: draftCount },
                  { key: "deleted" as ViewTab, label: "Deleted", count: deletedCount },
                  ...(canSeeNewBids ? [{ key: "newbids" as ViewTab, label: "New Bids", count: draftCount }] : []),
                ]).map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setViewTab(tab.key)}
                    className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                    style={{
                      background: viewTab === tab.key ? "var(--bg-card)" : "transparent",
                      color: viewTab === tab.key ? "var(--text)" : "var(--text-dim)",
                      boxShadow: viewTab === tab.key ? "0 1px 2px rgba(0,0,0,0.1)" : "none",
                    }}
                    data-testid={`tab-${tab.key}`}
                  >
                    {tab.label} ({tab.count})
                  </button>
                ))}
              </div>
              {viewTab !== "newbids" && (
                <Badge variant="secondary" className="text-xs">
                  {filteredEntries.length} entr{filteredEntries.length !== 1 ? "ies" : "y"}
                </Badge>
              )}
            </div>
          </div>
          <div className="px-6 pb-6">
            {viewTab === "newbids" ? (
              <NewBidsTab />
            ) : isLoading && entries.length === 0 ? (
              <p className="text-sm py-8 text-center" style={{ color: "var(--text-dim)" }}>Loading proposal log...</p>
            ) : filteredEntries.length === 0 ? (
              <p className="text-sm py-8 text-center" style={{ color: "var(--text-dim)" }}>No entries found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ color: "var(--text)" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid var(--gold)40" }}>
                      <th
                        className="text-left py-3 px-3 font-semibold cursor-pointer select-none text-xs tracking-wide uppercase"
                        style={{ color: "var(--gold)" }}
                        onClick={() => toggleSort("projectName")}
                        data-testid="th-project-name"
                      >
                        <span className="flex items-center gap-1">Project Name <SortIcon field="projectName" /></span>
                      </th>
                      <th
                        className="text-left py-3 px-3 font-semibold cursor-pointer select-none text-xs tracking-wide uppercase"
                        style={{ color: "var(--gold)" }}
                        onClick={() => toggleSort("region")}
                        data-testid="th-region"
                      >
                        <span className="flex items-center gap-1">Region <SortIcon field="region" /></span>
                      </th>
                      <th
                        className="text-left py-3 px-3 font-semibold cursor-pointer select-none text-xs tracking-wide uppercase"
                        style={{ color: "var(--gold)" }}
                        onClick={() => toggleSort("dueDate")}
                        data-testid="th-due-date"
                      >
                        <span className="flex items-center gap-1">Due Date <SortIcon field="dueDate" /></span>
                      </th>
                      <th
                        className="text-left py-3 px-3 font-semibold cursor-pointer select-none text-xs tracking-wide uppercase"
                        style={{ color: "var(--gold)" }}
                        onClick={() => toggleSort("estimateStatus")}
                        data-testid="th-status"
                      >
                        <span className="flex items-center gap-1">Status <SortIcon field="estimateStatus" /></span>
                      </th>
                      <th
                        className="text-left py-3 px-3 font-semibold cursor-pointer select-none text-xs tracking-wide uppercase"
                        style={{ color: "var(--gold)" }}
                        onClick={() => toggleSort("nbsEstimator")}
                        data-testid="th-estimator"
                      >
                        <span className="flex items-center gap-1">NBS Estimator <SortIcon field="nbsEstimator" /></span>
                      </th>
                      <th className="text-left py-3 px-3 font-semibold text-xs tracking-wide uppercase" style={{ color: "var(--gold)" }}>GC Est. Lead</th>
                      <th className="text-left py-3 px-3 font-semibold text-xs tracking-wide uppercase" style={{ color: "var(--gold)" }} data-testid="th-nbs-scopes">NBS Scopes</th>
                      <th className="text-left py-3 px-3 font-semibold text-xs tracking-wide uppercase" style={{ color: "var(--gold)" }} data-testid="th-notes">Notes</th>
                      <th className="text-left py-3 px-3 font-semibold text-xs tracking-wide uppercase" style={{ color: "var(--gold)" }} data-testid="th-source">Source</th>
                      <th
                        className="text-left py-3 px-3 font-semibold cursor-pointer select-none text-xs tracking-wide uppercase"
                        style={{ color: "var(--gold)" }}
                        onClick={() => toggleSort("createdAt")}
                        data-testid="th-created-at"
                      >
                        <span className="flex items-center gap-1">Created <SortIcon field="createdAt" /></span>
                      </th>
                      <th className="text-center py-3 px-2 font-semibold text-xs tracking-wide uppercase" style={{ color: "var(--gold)" }} data-testid="th-folder">Folder</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry) => {
                      const isDeleted = !!entry.deletedAt;
                      const isDraft = !!entry.isDraft;
                      const scopes = parseScopeList(entry.scopeList);
                      return (
                        <tr
                          key={entry.id}
                          className={`${isDeleted ? "opacity-50" : "hover-elevate"}`}
                          style={{ borderBottom: "1px solid var(--border-ds)" }}
                          data-testid={`row-entry-${entry.id}`}
                        >
                          <td className="py-3 px-3" style={{ background: "var(--bg)" }}>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={isDeleted ? "line-through" : ""} style={{ color: isDeleted ? "var(--text-dim)" : "var(--text)" }} data-testid={`text-name-${entry.id}`}>
                                {entry.projectName}
                              </span>
                              {isDraft && !isDeleted && (
                                <Badge className="text-xs bg-amber-500/20 text-amber-500 border-amber-500/30" data-testid={`badge-draft-${entry.id}`}>
                                  <FileEdit className="w-3 h-3 mr-1" />
                                  DRAFT
                                </Badge>
                              )}
                              {entry.isTest && (
                                <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-500">
                                  <FlaskConical className="w-3 h-3 mr-1" />
                                  TEST
                                </Badge>
                              )}
                              {isDeleted && (
                                <Badge variant="destructive" className="text-xs">
                                  <Archive className="w-3 h-3 mr-1" />
                                  DELETED
                                </Badge>
                              )}
                              {!isDeleted && !isDraft && hasFeature("estimating-module") && (entry.estimateStatus === null || entry.estimateStatus === "Estimating") && (
                                <Link href={`/estimates/${entry.id}`}>
                                  <span
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer hover:opacity-80"
                                    style={{ background: "var(--gold)15", color: "var(--gold)", border: "1px solid var(--gold)30" }}
                                    onClick={(e) => e.stopPropagation()}
                                    data-testid={`button-estimate-${entry.id}`}
                                  >
                                    <Calculator className="w-2.5 h-2.5" />
                                    Estimate
                                  </span>
                                </Link>
                              )}
                            </div>
                            {isDraft && scopes.length > 0 && (
                              <div className="flex gap-1 mt-1 flex-wrap">
                                {scopes.slice(0, 4).map((scope, i) => (
                                  <span
                                    key={i}
                                    className="text-[10px] px-1.5 py-0.5 rounded"
                                    style={{ background: "var(--bg-input)", color: "var(--text-dim)" }}
                                  >
                                    {scope}
                                  </span>
                                ))}
                                {scopes.length > 4 && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: "var(--text-dim)" }}>
                                    +{scopes.length - 4} more
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3" style={{ background: "var(--bg)" }}>
                            <Badge variant="secondary" className="text-xs" data-testid={`text-region-${entry.id}`}>
                              {entry.region || "\u2014"}
                            </Badge>
                          </td>
                          <td className="py-3 px-3" style={{ color: "var(--text-dim)" }} data-testid={`text-due-date-${entry.id}`}>
                            {fmtDate(entry.dueDate)}
                          </td>
                          <td className="py-3 px-3">
                            {isDeleted ? (
                              <Badge variant="destructive" className="text-xs" data-testid={`text-status-${entry.id}`}>
                                Deleted
                              </Badge>
                            ) : isDraft ? (
                              <Badge className="text-xs bg-amber-500/20 text-amber-500 border-amber-500/30" data-testid={`text-status-${entry.id}`}>
                                Draft
                              </Badge>
                            ) : (
                              <Select
                                value={entry.estimateStatus || "Estimating"}
                                onValueChange={(val) => handleStatusChange(entry.id, val)}
                                disabled={isViewer}
                              >
                                <SelectTrigger
                                  className="h-7 text-xs border-none px-2 py-0 w-auto min-w-[100px]"
                                  style={{
                                    background: "transparent",
                                    color: entry.estimateStatus === "Won" ? "var(--gold)" :
                                      entry.estimateStatus?.includes("Lost") || entry.estimateStatus === "No Bid" ? "var(--error, #ef4444)" : "var(--text)",
                                  }}
                                  data-testid={`select-status-${entry.id}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {["Estimating", "Submitted", "Revising", "Won", "Lost", "No Bid"].map((s) => (
                                    <SelectItem key={s} value={s} data-testid={`option-status-${s.toLowerCase().replace(/\s/g, "-")}`}>{s}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            )}
                          </td>
                          <td className="py-3 px-3 text-sm" style={{ color: "var(--text)" }} data-testid={`text-estimator-${entry.id}`}>
                            {entry.nbsEstimator || "\u2014"}
                          </td>
                          <td className="py-3 px-3 text-xs" style={{ color: "var(--text-dim)" }}>
                            {entry.gcEstimateLead || "\u2014"}
                          </td>
                          <td className="py-3 px-3 relative">
                            {(() => {
                              const selected = parseNbsScopes(entry.nbsSelectedScopes);
                              return (
                                <div>
                                  <button
                                    className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
                                    style={{ color: selected.length > 0 ? "var(--gold)" : "var(--text-dim)" }}
                                    onClick={(e) => { e.stopPropagation(); if (scopePopupEntryId === entry.id) { commitScopes(entry.id); } else { openScopePopup(entry); } }}
                                    data-testid={`button-scopes-${entry.id}`}
                                  >
                                    <ListChecks className="w-3.5 h-3.5" />
                                    {selected.length > 0 ? `${selected.length} selected` : "Select"}
                                  </button>
                                  {selected.length > 0 && (
                                    <div className="flex gap-0.5 mt-0.5 flex-wrap max-w-[180px]">
                                      {selected.slice(0, 3).map((s, i) => (
                                        <span key={i} className="text-[9px] px-1 py-0.5 rounded" style={{ background: "var(--gold)", color: "var(--bg)", opacity: 0.85 }}>{s}</span>
                                      ))}
                                      {selected.length > 3 && <span className="text-[9px] px-1" style={{ color: "var(--text-dim)" }}>+{selected.length - 3}</span>}
                                    </div>
                                  )}
                                  {scopePopupEntryId === entry.id && (
                                    <div
                                      ref={scopePopupRef}
                                      className="absolute z-50 top-full left-0 mt-1 w-56 rounded-lg shadow-xl overflow-hidden"
                                      style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="p-2 text-xs font-medium" style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border-ds)" }}>
                                        Select NBS Scopes
                                      </div>
                                      <div className="max-h-60 overflow-y-auto p-1">
                                        {NBS_SCOPES.map((scope) => {
                                          const isChecked = draftScopes.includes(scope);
                                          return (
                                            <button
                                              key={scope}
                                              className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-xs rounded hover:bg-white/5 transition-colors"
                                              style={{ color: isChecked ? "var(--gold)" : "var(--text)" }}
                                              onClick={() => toggleDraftScope(scope)}
                                              data-testid={`scope-option-${scope.toLowerCase().replace(/\s/g, "-")}-${entry.id}`}
                                            >
                                              <div
                                                className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0"
                                                style={{
                                                  borderColor: isChecked ? "var(--gold)" : "var(--border-ds)",
                                                  background: isChecked ? "var(--gold)" : "transparent",
                                                }}
                                              >
                                                {isChecked && <Check className="w-3 h-3" style={{ color: "var(--bg)" }} />}
                                              </div>
                                              {scope}
                                            </button>
                                          );
                                        })}
                                      </div>
                                      <div className="p-2 flex justify-end" style={{ borderTop: "1px solid var(--border-ds)" }}>
                                        <button
                                          className="text-[10px] px-2 py-1 rounded"
                                          style={{ background: "var(--gold)", color: "var(--bg)" }}
                                          onClick={() => commitScopes(entry.id)}
                                          data-testid={`button-done-scopes-${entry.id}`}
                                        >
                                          Done
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="py-3 px-3 relative">
                            <button
                              className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
                              style={{ color: entry.notes ? "var(--text)" : "var(--text-dim)" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (notesPopupEntryId === entry.id) {
                                  saveNotes(entry.id, notesPopupText);
                                } else {
                                  setNotesPopupEntryId(entry.id);
                                  setNotesPopupText(entry.notes || "");
                                }
                              }}
                              data-testid={`button-notes-${entry.id}`}
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              {entry.notes ? (
                                <span className="max-w-[120px] truncate">{entry.notes}</span>
                              ) : (
                                "Add"
                              )}
                            </button>
                            {notesPopupEntryId === entry.id && (
                              <div
                                ref={notesPopupRef}
                                className="absolute z-50 top-full left-0 mt-1 w-64 rounded-lg shadow-xl overflow-hidden"
                                style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="p-2 text-xs font-medium" style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border-ds)" }}>
                                  Notes
                                </div>
                                <div className="p-2">
                                  <Textarea
                                    value={notesPopupText}
                                    onChange={(e) => setNotesPopupText(e.target.value)}
                                    placeholder="Add notes..."
                                    className="text-xs min-h-[80px]"
                                    autoFocus
                                    data-testid={`textarea-notes-${entry.id}`}
                                  />
                                </div>
                                <div className="p-2 flex justify-end gap-1" style={{ borderTop: "1px solid var(--border-ds)" }}>
                                  <button
                                    className="text-[10px] px-2 py-1 rounded"
                                    style={{ color: "var(--text-dim)" }}
                                    onClick={() => { setNotesPopupEntryId(null); }}
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    className="text-[10px] px-2 py-1 rounded"
                                    style={{ background: "var(--gold)", color: "var(--bg)" }}
                                    onClick={() => saveNotes(entry.id, notesPopupText)}
                                    data-testid={`button-save-notes-${entry.id}`}
                                  >
                                    Save
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3 text-xs" data-testid={`text-source-${entry.id}`}>
                            <div className="flex flex-col gap-1.5">
                              {entry.screenshotPath && entry.estimateNumber && (
                                <a
                                  href={`/api/proposal-log/screenshot/${entry.estimateNumber}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="View source screenshot"
                                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md font-medium w-fit whitespace-nowrap hover:opacity-80 transition-opacity"
                                  style={{ color: "var(--gold)", background: "color-mix(in srgb, var(--gold) 10%, transparent)" }}
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`link-screenshot-${entry.id}`}
                                >
                                  <Camera className="w-3 h-3 flex-shrink-0" />
                                  <span>Screenshot</span>
                                </a>
                              )}
                              {entry.bcLink && /^https?:\/\//i.test(entry.bcLink) && (
                                <a
                                  href={entry.bcLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="Open in BuildingConnected"
                                  className="inline-flex items-center px-2 py-0.5 rounded font-bold tracking-wide w-fit hover:opacity-80 transition-opacity"
                                  style={{ color: "var(--info, #60a5fa)", background: "color-mix(in srgb, #60a5fa 10%, transparent)", fontSize: "11px" }}
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`link-bc-${entry.id}`}
                                >
                                  BC
                                </a>
                              )}
                              {!entry.screenshotPath && !entry.bcLink && <span style={{ color: "var(--text-dim)" }}>—</span>}
                            </div>
                          </td>
                          <td className="py-3 px-3 text-xs" style={{ color: "var(--text-dim)" }} data-testid={`text-created-${entry.id}`}>
                            <div>
                              {entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : ""}
                            </div>
                            {isDeleted && entry.deletedAt && (
                              <div className="text-[10px]" style={{ color: "var(--error)" }}>
                                Del: {new Date(entry.deletedAt).toLocaleDateString()}
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-2 text-center" data-testid={`cell-folder-${entry.id}`}>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-[color-mix(in_srgb,var(--gold)_15%,transparent)]"
                              style={{ color: "var(--gold)" }}
                              title="Re-create project bid folder (fills in any missing template files; does not overwrite existing files)"
                              disabled={recreateFolderMutation.isPending && recreateFolderMutation.variables === entry.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!confirm(`Re-create the bid folder for "${entry.projectName}"?\n\nThis adds missing template folders/files. Existing files in the project folder will NOT be overwritten.`)) return;
                                recreateFolderMutation.mutate(entry.id);
                              }}
                              data-testid={`button-recreate-folder-${entry.id}`}
                            >
                              {recreateFolderMutation.isPending && recreateFolderMutation.variables === entry.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FolderPlus className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {noBidNotesEntryId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setNoBidNotesEntryId(null); }}>
          <div
            className="relative w-full max-w-sm rounded-xl overflow-hidden shadow-2xl"
            style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4" style={{ borderBottom: "1px solid var(--border-ds)" }}>
              <div>
                <h3 className="text-sm font-heading font-semibold" style={{ color: "var(--text)" }}>
                  {noBidPendingStatus || "No Bid"} — Add Notes
                </h3>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--text-dim)" }}>Please note why this bid was {noBidPendingStatus === "No Bid" ? "declined" : "lost"}</p>
              </div>
              <button onClick={() => setNoBidNotesEntryId(null)} className="p-1 rounded hover:bg-white/10" data-testid="button-close-nobid-notes">
                <X className="h-4 w-4" style={{ color: "var(--text-dim)" }} />
              </button>
            </div>
            <div className="p-4">
              <Textarea
                value={noBidNotesText}
                onChange={(e) => setNoBidNotesText(e.target.value)}
                placeholder="Enter reason..."
                className="text-sm min-h-[80px]"
                autoFocus
                data-testid="input-nobid-notes"
              />
            </div>
            <div className="flex items-center justify-end gap-2 p-4" style={{ borderTop: "1px solid var(--border-ds)" }}>
              <Button variant="outline" size="sm" onClick={skipNoBidNotes} data-testid="button-skip-nobid-notes">
                Skip
              </Button>
              <Button
                size="sm"
                onClick={confirmNoBidNotes}
                style={{ background: "linear-gradient(135deg, var(--gold), var(--gold-dim))", color: "var(--bg)" }}
                disabled={!noBidNotesText.trim()}
                data-testid="button-save-nobid-notes"
              >
                Save Notes
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
