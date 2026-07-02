import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Link2, CheckCircle2, RefreshCw, Check, X, FileEdit, FolderOpen, Download,
  Loader2, History, ChevronDown, ChevronUp, Plus, Merge, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useFeatureAccess } from "@/hooks/use-feature-access";
import { queryClient, apiRequest } from "@/lib/queryClient";

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
  owner: string | null;
  bcLink: string | null;
  sourceType: string | null;
  ndaRequired: boolean | null;
  bcAccessStatus: string | null;
  regionNeedsReview: boolean | null;
  isDraft: boolean | null;
  bcProjectId: string | null;
  bcOpportunityIds: string | null;
  scopeList: string | null;
  notes: string | null;
  deletedAt: string | null;
  createdAt: string;
  duplicateOverrideNote: string | null;
  projectAddress: string | null;
  squareFeet: string | null;
  anticipatedStart: string | null;
  anticipatedFinish: string | null;
}

interface DuplicateMatch {
  id: number;
  projectName: string;
  estimateNumber: string | null;
  region: string | null;
  gcEstimateLead: string | null;
  estimateStatus: string | null;
  proposalTotal: string | null;
  score: number;
}

interface PreviewEntry {
  opportunityId: string;
  action: "create" | "merge" | "update";
  projectName: string;
  region: string;
  dueDate: string;
  inviteDate: string;
  gcEstimateLead: string;
  gcCompanyName: string;
  location: string;
  bcLink: string;
  anticipatedStart?: string;
  anticipatedFinish?: string;
  projectAddress?: string;
  squareFeet?: string;
  scopeChanges?: string[];
  fieldChanges?: string[];
  regionNotConfident?: boolean;
}

interface SyncPreviewResponse {
  totalFound: number;
  totalAvailable: number;
  moreExist: boolean;
  afterFilter: number;
  newEntries: number;
  mergeEntries: number;
  updateEntries: number;
  alreadySynced: number;
  preview: PreviewEntry[];
  wasCapped: boolean;
  cappedAt: number | null;
  sinceDateUsed: string | null;
}

interface ChangeLogRecord {
  id: number;
  entryId: number;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string | null;
  changedAt: string;
  projectName: string;
  estimateNumber: string | null;
}

interface EditableFields {
  projectName: string;
  region: string;
  dueDate: string;
  nbsEstimator: string;
  gcEstimateLead: string;
  owner: string;
  primaryMarket: string;
  notes: string;
  scopeList: string;
  projectAddress: string;
  squareFeet: string;
  anticipatedStart: string;
  anticipatedFinish: string;
}

const ACTION_LABELS: Record<string, { label: string; color: string; icon: typeof Plus }> = {
  create: { label: "New", color: "text-green-500 bg-green-500/10 border-green-500/30", icon: Plus },
  merge: { label: "Merge", color: "text-blue-500 bg-blue-500/10 border-blue-500/30", icon: Merge },
  update: { label: "Update", color: "text-amber-500 bg-amber-500/10 border-amber-500/30", icon: RefreshCw },
};

function normalizeRegionForDropdown(raw: string, dbRegions: { code: string; name: string | null }[]) {
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
  return raw;
}

function formToEntry(entry: ProposalLogEntry, dbRegions: { code: string; name: string | null }[]): EditableFields {
  return {
    projectName: entry.projectName || "",
    region: normalizeRegionForDropdown(entry.region || "", dbRegions),
    dueDate: entry.dueDate || "",
    nbsEstimator: entry.nbsEstimator || "",
    gcEstimateLead: entry.gcEstimateLead || "",
    owner: entry.owner || "",
    primaryMarket: entry.primaryMarket || "",
    notes: entry.notes || "",
    scopeList: entry.scopeList || "[]",
    projectAddress: entry.projectAddress || "",
    squareFeet: entry.squareFeet || "",
    anticipatedStart: entry.anticipatedStart || "",
    anticipatedFinish: entry.anticipatedFinish || "",
  };
}

function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  const parts = d.split("-");
  if (parts.length !== 3) return d;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

function parseDupNote(note: string | null): DuplicateMatch[] {
  if (!note || !note.startsWith("__dup:")) return [];
  try {
    return JSON.parse(note.slice("__dup:".length));
  } catch {
    return [];
  }
}

export function NewBidsTab() {
  const { toast } = useToast();
  const { isAdmin, isViewer, user } = useAuth();
  const { hasFeature } = useFeatureAccess();
  const canReview = isAdmin || hasFeature("draft-review");
  const canSync = isAdmin || hasFeature("bc-sync") || hasFeature("draft-review");

  const [previewItems, setPreviewItems] = useState<PreviewEntry[] | null>(null);
  const [previewMeta, setPreviewMeta] = useState<Omit<SyncPreviewResponse, "preview"> | null>(null);
  const [previewSelected, setPreviewSelected] = useState<Set<string>>(new Set());
  const [rowForm, setRowForm] = useState<Record<number, EditableFields>>({});
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [mergeOpenId, setMergeOpenId] = useState<number | null>(null);
  const [dupSelectedMatchId, setDupSelectedMatchId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [createVendorFolder, setCreateVendorFolder] = useState(true);
  const [showChangeHistory, setShowChangeHistory] = useState(false);
  const [changeHistorySearch, setChangeHistorySearch] = useState("");

  const { data: entries = [] } = useQuery<ProposalLogEntry[]>({
    queryKey: ["/api/proposal-log/all-entries"],
    queryFn: async () => {
      const res = await fetch("/api/proposal-log/all-entries", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch project log entries");
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const { data: dbRegions = [] } = useQuery<{ id: number; code: string; name: string | null; isActive: boolean }[]>({
    queryKey: ["/api/regions", "active"],
    queryFn: async () => {
      const res = await fetch("/api/regions?active=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load regions");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
  const regionDisplayOptions = useMemo(() => dbRegions.map(r => `${r.code} - ${r.name}`), [dbRegions]);

  const { data: bcStatus } = useQuery<{ connected: boolean }>({
    queryKey: ["/api/autodesk/status"],
    staleTime: 5 * 60 * 1000,
  });

  const { data: syncStatus } = useQuery<{ lastSyncAt: string | null }>({
    queryKey: ["/api/bc/sync-status"],
    staleTime: 60 * 1000,
  });

  const bcDrafts = useMemo(
    () => entries.filter(e => e.isDraft && !e.deletedAt).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [entries],
  );

  const getForm = (entry: ProposalLogEntry): EditableFields =>
    rowForm[entry.id] ?? formToEntry(entry, dbRegions);

  const setField = (entry: ProposalLogEntry, field: keyof EditableFields, value: string) => {
    setRowForm(prev => ({ ...prev, [entry.id]: { ...getForm(entry), [field]: value } }));
  };

  const handleBcConnect = () => {
    window.location.href = "/api/autodesk/login";
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bc/sync/preview");
      return res.json() as Promise<SyncPreviewResponse>;
    },
    onSuccess: (data) => {
      setPreviewItems(data.preview);
      setPreviewMeta(data);
      setPreviewSelected(new Set(data.preview.map(p => p.opportunityId)));
    },
    onError: () => {
      toast({ title: "Sync check failed", description: "Could not fetch opportunities from BuildingConnected.", variant: "destructive" });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (opportunityIds: string[]) => {
      const res = await apiRequest("POST", "/api/bc/sync/confirm", {
        opportunityIds,
        sinceDateUsed: previewMeta?.sinceDateUsed || null,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bc/sync-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      const parts: string[] = [];
      if (data.created > 0) parts.push(`${data.created} pulled in`);
      if (data.merged > 0) parts.push(`${data.merged} scope-merged`);
      if (data.updated > 0) parts.push(`${data.updated} field-updated`);
      toast({ title: "BC Sync Complete", description: parts.join(", ") || "No changes made." });
      setPreviewItems(null);
      setPreviewMeta(null);
      setPreviewSelected(new Set());
    },
    onError: () => {
      toast({ title: "Sync Failed", description: "Could not complete the BC sync.", variant: "destructive" });
    },
  });

  const editDraftMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, string> }) => {
      await apiRequest("PATCH", `/api/bc/drafts/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save edit.", variant: "destructive" });
    },
  });

  const rejectDraftMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      await apiRequest("POST", `/api/bc/drafts/${id}/reject`, { reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      toast({ title: "Draft rejected", description: "The draft has been rejected." });
      setRejectingId(null);
      setRejectReason("");
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to reject draft.", variant: "destructive" });
    },
  });

  const approveAndCreateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const res = await fetch(`/api/bc/drafts/${id}/approve-and-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (res.status === 409) {
        const body = await res.json();
        const err: any = new Error("duplicate_detected");
        err.matches = body.matches || [];
        err.draftId = id;
        throw err;
      }
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      toast({ title: "Project created", description: `${result.project.projectName} — Estimate #${result.project.projectId}. ` });
      setMergeOpenId(null);
      setExpandedId(null);
    },
    onError: (error: any, variables) => {
      if (error?.message === "duplicate_detected") {
        setMergeOpenId(variables.id);
        const matches: DuplicateMatch[] = error.matches || [];
        setDupSelectedMatchId(matches.length > 0 ? matches[0].id : null);
        (approveAndCreateMutation as any)._liveMatches = matches;
        return;
      }
      toast({ title: "Error", description: error?.message || "Failed to create project from draft.", variant: "destructive" });
    },
  });

  const forceApproveMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const res = await fetch(`/api/bc/drafts/${id}/approve-and-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...data, force: true }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      setMergeOpenId(null);
      toast({ title: "Project created", description: `Project ${result.project.projectId} created with folder structure.` });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create project from draft.", variant: "destructive" });
    },
  });

  const mergeAsBidRoundMutation = useMutation({
    mutationFn: async ({ draftId, targetId, data }: { draftId: number; targetId: number; data: Record<string, unknown> }) => {
      const res = await fetch(`/api/bc/drafts/${draftId}/approve-and-create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ...data, mergeIntoId: targetId }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      setMergeOpenId(null);
      toast({ title: "Bid round added", description: "Draft merged as a new bid round on the existing project." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to merge draft as bid round.", variant: "destructive" });
    },
  });

  const changeQueryParams = useMemo(() => new URLSearchParams().toString(), []);
  const { data: changeHistory = [], isLoading: isLoadingChanges } = useQuery<ChangeLogRecord[]>({
    queryKey: ["/api/proposal-log/change-history", changeQueryParams],
    queryFn: async () => {
      const res = await fetch("/api/proposal-log/change-history", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load change history");
      return res.json();
    },
    enabled: showChangeHistory,
    staleTime: 30 * 1000,
  });

  const filteredChangeHistory = useMemo(() => {
    if (!changeHistorySearch.trim()) return changeHistory;
    const q = changeHistorySearch.toLowerCase();
    return changeHistory.filter(c =>
      (c.projectName || "").toLowerCase().includes(q) ||
      (c.fieldName || "").toLowerCase().includes(q) ||
      (c.changedBy || "").toLowerCase().includes(q),
    );
  }, [changeHistory, changeHistorySearch]);

  const runSync = () => {
    setPreviewItems(null);
    setPreviewMeta(null);
    previewMutation.mutate();
  };

  const togglePreviewSelect = (id: string) => {
    setPreviewSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const pullSelected = () => {
    if (previewSelected.size === 0) return;
    confirmMutation.mutate(Array.from(previewSelected));
  };

  const saveField = (entry: ProposalLogEntry, field: keyof EditableFields, value: string) => {
    setField(entry, field, value);
    const original = formToEntry(entry, dbRegions);
    if (original[field] === value) return;
    const data: Record<string, string> = { [field]: value };
    if (field === "region") data.regionNeedsReview = "false" as any;
    editDraftMutation.mutate({ id: entry.id, data });
  };

  const accept = (entry: ProposalLogEntry) => {
    const form = getForm(entry);
    if (!form.projectName || !form.region) {
      toast({ title: "Missing required field", description: "Project name and region are required to accept a bid.", variant: "destructive" });
      return;
    }
    approveAndCreateMutation.mutate({ id: entry.id, data: { ...form, createVendorFolder } });
  };

  const openMerge = (entry: ProposalLogEntry) => {
    const precomputed = parseDupNote(entry.duplicateOverrideNote);
    if (precomputed.length === 0) {
      accept(entry);
      return;
    }
    (approveAndCreateMutation as any)._liveMatches = precomputed;
    setDupSelectedMatchId(precomputed[0]?.id ?? null);
    setMergeOpenId(entry.id);
  };

  const confirmReject = () => {
    if (rejectingId !== null) {
      rejectDraftMutation.mutate({ id: rejectingId, reason: rejectReason });
    }
  };

  const liveMatches: DuplicateMatch[] = (approveAndCreateMutation as any)._liveMatches || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {bcStatus?.connected ? (
            <Badge variant="outline" className="text-xs border-green-500/50 text-green-500 gap-1 py-1.5 px-3" data-testid="badge-bc-connected">
              <CheckCircle2 className="w-3.5 h-3.5" />
              BC Connected
            </Badge>
          ) : (
            <Button variant="outline" size="sm" onClick={handleBcConnect} className="gap-1.5 border-amber-500/50 text-amber-600 hover:bg-amber-500/10" data-testid="button-bc-connect">
              <Link2 className="w-4 h-4" />
              Connect to BuildingConnected
            </Button>
          )}
          {canSync && bcStatus?.connected && (
            <Button
              variant="outline"
              size="sm"
              onClick={runSync}
              disabled={previewMutation.isPending}
              className="gap-1.5 border-blue-500/50 text-blue-600 hover:bg-blue-500/10"
              data-testid="button-bc-sync"
            >
              {previewMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Sync from BC
            </Button>
          )}
        </div>
        {syncStatus?.lastSyncAt && (
          <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
            Last BC sync: {new Date(syncStatus.lastSyncAt).toLocaleString()}
          </span>
        )}
      </div>

      {previewItems && (
        <div className="mb-6 rounded-lg overflow-hidden" style={{ border: "1px solid var(--border-ds)" }}>
          <div className="flex items-center justify-between p-3 flex-wrap gap-2" style={{ background: "var(--bg-input)" }}>
            <div className="flex items-center gap-2 flex-wrap text-xs" style={{ color: "var(--text-dim)" }}>
              {previewMeta && `${previewMeta.totalFound} found, ${previewMeta.afterFilter} from approved GCs`}
              {previewMeta && previewMeta.newEntries > 0 && <Badge className="text-[10px] bg-green-500/10 text-green-500 border-green-500/30">{previewMeta.newEntries} new</Badge>}
              {previewMeta && previewMeta.mergeEntries > 0 && <Badge className="text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/30">{previewMeta.mergeEntries} merge</Badge>}
              {previewMeta && previewMeta.updateEntries > 0 && <Badge className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/30">{previewMeta.updateEntries} update</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setPreviewItems(null); setPreviewMeta(null); }} data-testid="button-dismiss-preview">
                Dismiss
              </Button>
              <Button
                size="sm"
                onClick={pullSelected}
                disabled={previewSelected.size === 0 || confirmMutation.isPending}
                style={{ background: "linear-gradient(135deg, var(--gold), var(--gold-dim))", color: "var(--bg)" }}
                data-testid="button-pull-selected"
              >
                {confirmMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                Pull {previewSelected.size} Selected Into Log
              </Button>
            </div>
          </div>
          {previewItems.length === 0 ? (
            <p className="text-sm py-6 text-center" style={{ color: "var(--text-dim)" }}>No new opportunities found. Everything is up to date.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ color: "var(--text)" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-ds)" }}>
                    <th className="py-2 px-2 w-8"></th>
                    <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Action</th>
                    <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Project</th>
                    <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>GC</th>
                    <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Region</th>
                    <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Due Date</th>
                  </tr>
                </thead>
                <tbody>
                  {previewItems.map(item => {
                    const info = ACTION_LABELS[item.action];
                    const Icon = info.icon;
                    return (
                      <tr key={item.opportunityId} style={{ borderBottom: "1px solid var(--border-ds)" }} data-testid={`row-preview-${item.opportunityId}`}>
                        <td className="py-2 px-2">
                          <input type="checkbox" checked={previewSelected.has(item.opportunityId)} onChange={() => togglePreviewSelect(item.opportunityId)} className="rounded" />
                        </td>
                        <td className="py-2 px-2">
                          <Badge className={`text-[10px] gap-1 ${info.color}`}>
                            <Icon className="h-2.5 w-2.5" />
                            {info.label}
                          </Badge>
                        </td>
                        <td className="py-2 px-2 text-xs font-medium">{item.projectName}</td>
                        <td className="py-2 px-2 text-xs" style={{ color: "var(--text-dim)" }}>{item.gcCompanyName || item.gcEstimateLead || "—"}</td>
                        <td className="py-2 px-2">
                          {item.region ? (
                            <Badge variant="secondary" className="text-xs">{item.region}</Badge>
                          ) : (
                            <span style={{ color: "#e67e22", fontSize: "11px" }}>⚠ No region</span>
                          )}
                          {item.regionNotConfident && item.region && (
                            <span style={{ color: "#e67e22", fontSize: "10px", marginLeft: 4 }} title="Region needs review">⚠</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs" style={{ color: "var(--text-dim)" }}>{fmtDate(item.dueDate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <h3 className="text-sm font-heading font-semibold mb-3" style={{ color: "var(--text)" }}>
        Drafts Awaiting Review ({bcDrafts.length})
      </h3>

      {bcDrafts.length === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: "var(--text-dim)" }}>No drafts awaiting review.</p>
      ) : (
        <div className="space-y-2">
          {bcDrafts.map(entry => {
            const form = getForm(entry);
            const isExpanded = expandedId === entry.id;
            const isMergeOpen = mergeOpenId === entry.id;
            const isNda = entry.ndaRequired || entry.bcAccessStatus === "nda_required";
            const hasDupFlag = !!entry.duplicateOverrideNote?.startsWith("__dup:");
            const needsRegionReview = !!entry.regionNeedsReview;
            const bidCount = entry.bcOpportunityIds ? (JSON.parse(entry.bcOpportunityIds) as string[]).length : 0;

            return (
              <div key={entry.id} className="rounded-lg" style={{ border: "1px solid var(--border-ds)", background: "var(--bg-card)" }} data-testid={`row-draft-${entry.id}`}>
                <div className="p-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-[220px] space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Input
                          value={form.projectName}
                          onChange={(e) => setField(entry, "projectName", e.target.value)}
                          onBlur={(e) => saveField(entry, "projectName", e.target.value)}
                          disabled={!canReview}
                          className="text-sm font-medium h-8 max-w-xs"
                          data-testid={`input-draft-name-${entry.id}`}
                        />
                        <Badge className="text-xs bg-amber-500/20 text-amber-500 border-amber-500/30">
                          <FileEdit className="w-3 h-3 mr-1" />
                          DRAFT
                        </Badge>
                        {isNda && (
                          <Badge
                            className="text-[10px] bg-purple-500/20 text-purple-300 border-purple-500/30 cursor-default"
                            title="This BuildingConnected invite is NDA-protected. Some project details are hidden until the NDA is accepted."
                            data-testid={`badge-nda-${entry.id}`}
                          >
                            🔒 NDA Required
                          </Badge>
                        )}
                        {hasDupFlag && (
                          <Badge className="text-[10px] bg-orange-500/20 text-orange-400 border-orange-500/30 cursor-default" title="Possible duplicate detected — resolve via Merge" data-testid={`badge-dup-warning-${entry.id}`}>
                            ⚠ May Be Duplicate
                          </Badge>
                        )}
                        {needsRegionReview && (
                          <Badge className="text-[10px] bg-orange-500/20 text-orange-400 border-orange-500/30 cursor-default" title="Region was guessed with low confidence — please confirm" data-testid={`badge-region-review-${entry.id}`}>
                            ⚠ Confirm region
                          </Badge>
                        )}
                        {bidCount > 1 && (
                          <Badge className="text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/30" data-testid={`badge-bid-packages-${entry.id}`}>
                            {bidCount} bid packages
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <select
                          value={form.region}
                          onChange={(e) => saveField(entry, "region", e.target.value)}
                          disabled={!canReview}
                          className="text-xs h-8 rounded-md px-2 border"
                          style={{ background: "var(--bg-input)", borderColor: needsRegionReview ? "#e67e22" : "var(--border-ds)", color: "var(--text)" }}
                          data-testid={`select-draft-region-${entry.id}`}
                        >
                          <option value="">— Select Region —</option>
                          {regionDisplayOptions.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <Input
                          type="date"
                          value={form.dueDate}
                          onChange={(e) => setField(entry, "dueDate", e.target.value)}
                          onBlur={(e) => saveField(entry, "dueDate", e.target.value)}
                          disabled={!canReview}
                          className="text-xs h-8 w-36"
                          data-testid={`input-draft-due-date-${entry.id}`}
                        />
                        <Input
                          value={form.gcEstimateLead}
                          onChange={(e) => setField(entry, "gcEstimateLead", e.target.value)}
                          onBlur={(e) => saveField(entry, "gcEstimateLead", e.target.value)}
                          disabled={!canReview}
                          placeholder="GC Lead"
                          className="text-xs h-8 w-40"
                          data-testid={`input-draft-gc-lead-${entry.id}`}
                        />
                        {entry.bcLink && (
                          <a href={entry.bcLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] hover:opacity-80" style={{ color: "var(--info, #60a5fa)" }} data-testid={`link-draft-bc-${entry.id}`}>
                            <Link2 className="w-3 h-3" />
                            BuildingConnected
                          </a>
                        )}
                      </div>
                    </div>
                    {canReview && (
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          onClick={() => accept(entry)}
                          disabled={approveAndCreateMutation.isPending}
                          style={{ background: "linear-gradient(135deg, var(--gold), var(--gold-dim))", color: "var(--bg)" }}
                          data-testid={`button-accept-${entry.id}`}
                        >
                          {approveAndCreateMutation.isPending && approveAndCreateMutation.variables?.id === entry.id ? (
                            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                          ) : (
                            <FolderOpen className="w-3.5 h-3.5 mr-1" />
                          )}
                          Accept
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => openMerge(entry)} data-testid={`button-merge-${entry.id}`}>
                          <Merge className="w-3.5 h-3.5 mr-1" />
                          Merge
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          onClick={() => { setRejectingId(entry.id); setRejectReason(""); }}
                          data-testid={`button-reject-${entry.id}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setExpandedId(isExpanded ? null : entry.id)} data-testid={`button-expand-${entry.id}`}>
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </Button>
                      </div>
                    )}
                  </div>

                  {isExpanded && (
                    <div className="mt-3 pt-3 grid grid-cols-2 gap-3" style={{ borderTop: "1px solid var(--border-ds)" }}>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Project Address</label>
                        <Input value={form.projectAddress} onChange={(e) => setField(entry, "projectAddress", e.target.value)} onBlur={(e) => saveField(entry, "projectAddress", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-address-${entry.id}`} />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Square Feet</label>
                        <Input value={form.squareFeet} onChange={(e) => setField(entry, "squareFeet", e.target.value)} onBlur={(e) => saveField(entry, "squareFeet", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-sqft-${entry.id}`} />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Anticipated Start</label>
                        <Input type="date" value={form.anticipatedStart} onChange={(e) => setField(entry, "anticipatedStart", e.target.value)} onBlur={(e) => saveField(entry, "anticipatedStart", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-start-${entry.id}`} />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Anticipated Finish</label>
                        <Input type="date" value={form.anticipatedFinish} onChange={(e) => setField(entry, "anticipatedFinish", e.target.value)} onBlur={(e) => saveField(entry, "anticipatedFinish", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-finish-${entry.id}`} />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>NBS Estimator</label>
                        <Input value={form.nbsEstimator} onChange={(e) => setField(entry, "nbsEstimator", e.target.value)} onBlur={(e) => saveField(entry, "nbsEstimator", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-estimator-${entry.id}`} />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Market</label>
                        <Input value={form.primaryMarket} onChange={(e) => setField(entry, "primaryMarket", e.target.value)} onBlur={(e) => saveField(entry, "primaryMarket", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-market-${entry.id}`} />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Scopes / Trades</label>
                        <Input
                          value={(() => { try { return JSON.parse(form.scopeList).join(", "); } catch { return form.scopeList; } })()}
                          onChange={(e) => {
                            const arr = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                            setField(entry, "scopeList", JSON.stringify(arr));
                          }}
                          onBlur={(e) => {
                            const arr = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                            saveField(entry, "scopeList", JSON.stringify(arr));
                          }}
                          disabled={!canReview}
                          className="text-xs h-8"
                          data-testid={`input-draft-scopes-${entry.id}`}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>GC Company</label>
                        <Input value={form.owner} onChange={(e) => setField(entry, "owner", e.target.value)} onBlur={(e) => saveField(entry, "owner", e.target.value)} disabled={!canReview} className="text-xs h-8" data-testid={`input-draft-owner-${entry.id}`} />
                      </div>
                      <div className="col-span-2">
                        <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Notes</label>
                        <Textarea value={form.notes} onChange={(e) => setField(entry, "notes", e.target.value)} onBlur={(e) => saveField(entry, "notes", e.target.value)} disabled={!canReview} className="text-xs min-h-[50px]" data-testid={`input-draft-notes-${entry.id}`} />
                      </div>
                      <div className="col-span-2">
                        <label className="flex items-center gap-2 text-xs select-none cursor-pointer" style={{ color: "var(--text-dim)" }}>
                          <input type="checkbox" checked={createVendorFolder} onChange={(e) => setCreateVendorFolder(e.target.checked)} className="h-3.5 w-3.5 cursor-pointer" data-testid={`checkbox-vendor-folder-${entry.id}`} />
                          Create vendor folder on accept
                        </label>
                      </div>
                    </div>
                  )}

                  {isMergeOpen && (
                    <div className="mt-3 pt-3 space-y-2" style={{ borderTop: "1px solid var(--border-ds)" }}>
                      <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--gold)" }}>Possible duplicate entries</p>
                      {liveMatches.map(match => (
                        <label
                          key={match.id}
                          className={`flex items-start gap-3 p-2 rounded-lg cursor-pointer transition-colors ${dupSelectedMatchId === match.id ? "ring-1 ring-orange-500/50" : ""}`}
                          style={{ background: dupSelectedMatchId === match.id ? "var(--bg-input)" : "var(--bg)" }}
                          onClick={() => setDupSelectedMatchId(match.id)}
                          data-testid={`dup-match-${match.id}`}
                        >
                          <input type="radio" name={`dup-match-${entry.id}`} checked={dupSelectedMatchId === match.id} onChange={() => setDupSelectedMatchId(match.id)} className="mt-0.5 accent-orange-400" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate" style={{ color: "var(--text)" }}>{match.projectName}</div>
                            <div className="flex items-center gap-3 mt-0.5 text-[10px]" style={{ color: "var(--text-dim)" }}>
                              {match.estimateNumber && <span>#{match.estimateNumber}</span>}
                              {match.region && <span>{match.region}</span>}
                              {match.estimateStatus && <span>{match.estimateStatus}</span>}
                              <span className="text-orange-400 font-semibold">{Math.round(match.score * 100)}% match</span>
                            </div>
                          </div>
                        </label>
                      ))}
                      <div className="flex flex-col gap-1.5 pt-1">
                        <Button
                          size="sm"
                          className="justify-start text-left h-auto py-2"
                          style={{ background: "var(--bg-input)", color: "var(--text)" }}
                          onClick={() => {
                            if (!dupSelectedMatchId) return;
                            mergeAsBidRoundMutation.mutate({ draftId: entry.id, targetId: dupSelectedMatchId, data: { ...getForm(entry), createVendorFolder } });
                          }}
                          disabled={!dupSelectedMatchId || mergeAsBidRoundMutation.isPending || forceApproveMutation.isPending}
                          data-testid="button-dup-add-bid-round"
                        >
                          {mergeAsBidRoundMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <History className="w-3.5 h-3.5 mr-2 text-blue-400" />}
                          <span>
                            <span className="font-semibold">Add as Bid Round</span>
                            <span className="block text-[10px] mt-0.5" style={{ color: "var(--text-dim)" }}>Record this as a new bid round on the selected existing entry. The draft will be closed.</span>
                          </span>
                        </Button>
                        <Button
                          size="sm"
                          className="justify-start text-left h-auto py-2"
                          style={{ background: "var(--bg-input)", color: "var(--text)" }}
                          onClick={() => forceApproveMutation.mutate({ id: entry.id, data: { ...getForm(entry), createVendorFolder } })}
                          disabled={forceApproveMutation.isPending || mergeAsBidRoundMutation.isPending}
                          data-testid="button-dup-force-create"
                        >
                          {forceApproveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5 mr-2 text-green-400" />}
                          <span>
                            <span className="font-semibold">Create as Separate Project</span>
                            <span className="block text-[10px] mt-0.5" style={{ color: "var(--text-dim)" }}>This is a different project — create it independently.</span>
                          </span>
                        </Button>
                        <Button variant="ghost" size="sm" className="justify-start text-left h-auto py-2" style={{ color: "var(--text-dim)" }} onClick={() => setMergeOpenId(null)} data-testid="button-dup-cancel">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}

                  {rejectingId === entry.id && (
                    <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border-ds)" }}>
                      <label className="text-[10px] font-medium mb-1 block" style={{ color: "var(--text-dim)" }}>Reason for rejection (optional)</label>
                      <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Enter rejection reason..." className="text-xs min-h-[50px]" data-testid="input-reject-reason" />
                      <div className="flex justify-end gap-2 mt-2">
                        <Button variant="outline" size="sm" onClick={() => setRejectingId(null)} data-testid="button-cancel-reject">Cancel</Button>
                        <Button size="sm" variant="destructive" onClick={confirmReject} disabled={rejectDraftMutation.isPending} data-testid="button-confirm-reject">Reject Draft</Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6">
        <button
          onClick={() => setShowChangeHistory(v => !v)}
          className="flex items-center gap-1.5 text-xs font-medium px-2 py-1.5 rounded hover:bg-white/5"
          style={{ color: "var(--text-dim)" }}
          data-testid="button-toggle-change-history"
        >
          <History className="w-3.5 h-3.5" />
          BC Sync Change History
          {showChangeHistory ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {showChangeHistory && (
          <div className="mt-2">
            <div className="relative max-w-xs mb-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--text-dim)" }} />
              <Input
                placeholder="Search changes..."
                value={changeHistorySearch}
                onChange={(e) => setChangeHistorySearch(e.target.value)}
                className="pl-10 text-xs h-8"
                data-testid="input-search-changes"
              />
            </div>
            {isLoadingChanges ? (
              <p className="text-sm py-6 text-center" style={{ color: "var(--text-dim)" }}>Loading change history...</p>
            ) : filteredChangeHistory.length === 0 ? (
              <p className="text-sm py-6 text-center" style={{ color: "var(--text-dim)" }}>No changes recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ color: "var(--text)" }} data-testid="table-change-history">
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--border-ds)" }}>
                      <th className="text-left py-2 px-3 font-medium text-xs" style={{ color: "var(--text-dim)" }}>Date</th>
                      <th className="text-left py-2 px-3 font-medium text-xs" style={{ color: "var(--text-dim)" }}>Project</th>
                      <th className="text-left py-2 px-3 font-medium text-xs" style={{ color: "var(--text-dim)" }}>Field</th>
                      <th className="text-left py-2 px-3 font-medium text-xs" style={{ color: "var(--text-dim)" }}>Old Value</th>
                      <th className="text-left py-2 px-3 font-medium text-xs" style={{ color: "var(--text-dim)" }}>New Value</th>
                      <th className="text-left py-2 px-3 font-medium text-xs" style={{ color: "var(--text-dim)" }}>Changed By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredChangeHistory.map(ch => (
                      <tr key={ch.id} style={{ borderBottom: "1px solid var(--border-ds)" }} data-testid={`row-change-${ch.id}`}>
                        <td className="py-2 px-3 text-xs whitespace-nowrap" style={{ color: "var(--text-dim)" }}>{new Date(ch.changedAt).toLocaleString()}</td>
                        <td className="py-2 px-3 text-xs">{ch.projectName}{ch.estimateNumber && <span className="ml-1.5" style={{ color: "var(--text-dim)" }}>#{ch.estimateNumber}</span>}</td>
                        <td className="py-2 px-3"><Badge variant="outline" className="text-[10px]">{ch.fieldName.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim()}</Badge></td>
                        <td className="py-2 px-3 text-xs" style={{ color: "var(--text-dim)" }}>{ch.oldValue || "—"}</td>
                        <td className="py-2 px-3 text-xs">{ch.newValue || "—"}</td>
                        <td className="py-2 px-3 text-xs" style={{ color: "var(--text-dim)" }}>{ch.changedBy || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
