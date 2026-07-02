import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { X, Check, Loader2, Plus, Merge, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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
  existingEntryId?: number;
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
  lastSyncAt: string | null;
  sinceDateUsed: string | null;
}

interface BCSyncPreviewProps {
  onClose: () => void;
}

const ACTION_LABELS: Record<string, { label: string; color: string; icon: typeof Plus }> = {
  create: { label: "New", color: "text-green-500 bg-green-500/10 border-green-500/30", icon: Plus },
  merge: { label: "Merge", color: "text-blue-500 bg-blue-500/10 border-blue-500/30", icon: Merge },
  update: { label: "Update", color: "text-amber-500 bg-amber-500/10 border-amber-500/30", icon: RefreshCw },
};

export function BCSyncPreview({ onClose }: BCSyncPreviewProps) {
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data: preview, isLoading: previewLoading } = useQuery<SyncPreviewResponse>({
    queryKey: ["/api/bc/sync/preview"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/bc/sync/preview");
      return res.json();
    },
    staleTime: 0,
    gcTime: 30000,
    refetchOnMount: "always",
  });

  const confirmMutation = useMutation({
    mutationFn: async (opportunityIds: string[]) => {
      const res = await apiRequest("POST", "/api/bc/sync/confirm", {
        opportunityIds,
        sinceDateUsed: preview?.sinceDateUsed || null,
      });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bc/sync-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
      const parts: string[] = [];
      if (data.created > 0) parts.push(`${data.created} created`);
      if (data.merged > 0) parts.push(`${data.merged} merged`);
      if (data.updated > 0) parts.push(`${data.updated} updated`);
      toast({
        title: "BC Sync Complete",
        description: parts.join(", ") || "No changes made.",
      });
      onClose();
    },
    onError: () => {
      toast({ title: "Sync Failed", description: "Could not complete the BC sync.", variant: "destructive" });
    },
  });

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (preview?.preview) {
      setSelectedIds(new Set(preview.preview.map(e => e.opportunityId)));
    }
  };

  const deselectAll = () => setSelectedIds(new Set());

  const handleConfirm = () => {
    if (selectedIds.size === 0) return;
    confirmMutation.mutate(Array.from(selectedIds));
  };

  const fmtDate = (d: string | null) => {
    if (!d) return "\u2014";
    const parts = d.split("-");
    if (parts.length !== 3) return d;
    return `${parts[1]}/${parts[2]}/${parts[0]}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative w-full max-w-4xl max-h-[80vh] rounded-xl overflow-hidden shadow-2xl flex flex-col"
        style={{ background: "var(--bg-card)", border: "1px solid var(--border-ds)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4" style={{ borderBottom: "1px solid var(--border-ds)" }}>
          <div>
            <h2 className="text-lg font-heading font-semibold" style={{ color: "var(--text)" }}>
              BuildingConnected Sync Preview
            </h2>
            {preview && (
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                  {preview.totalFound} total, {preview.afterFilter} from approved GCs
                </span>
                {preview.newEntries > 0 && (
                  <Badge className="text-[10px] bg-green-500/10 text-green-500 border-green-500/30">{preview.newEntries} new</Badge>
                )}
                {preview.mergeEntries > 0 && (
                  <Badge className="text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/30">{preview.mergeEntries} merge</Badge>
                )}
                {preview.updateEntries > 0 && (
                  <Badge className="text-[10px] bg-amber-500/10 text-amber-500 border-amber-500/30">{preview.updateEntries} update</Badge>
                )}
                {preview.alreadySynced > 0 && (
                  <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>{preview.alreadySynced} already synced</span>
                )}
              </div>
            )}
            {preview?.wasCapped && (
              <div className="text-xs mt-1 text-amber-500">
                Results capped at {preview.cappedAt} entries. Run sync again for more.
              </div>
            )}
            {preview?.moreExist && (
              <div className="text-xs mt-1 text-amber-500">
                {preview.totalAvailable} total opportunities exist on BC ({preview.totalFound} fetched). Run sync again after confirming to process remaining.
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10" data-testid="button-close-bc-sync">
            <X className="h-5 w-5" style={{ color: "var(--text-dim)" }} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {previewLoading ? (
            <div className="flex items-center justify-center py-12 gap-2" style={{ color: "var(--text-dim)" }}>
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Fetching from BuildingConnected...</span>
            </div>
          ) : !preview?.preview?.length ? (
            <div className="text-center py-12 text-sm" style={{ color: "var(--text-dim)" }}>
              No new opportunities found. Everything is up to date.
            </div>
          ) : (
            <table className="w-full text-sm" style={{ color: "var(--text)" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-ds)" }}>
                  <th className="py-2 px-2 text-left w-8">
                    <input
                      type="checkbox"
                      checked={selectedIds.size === preview.preview.length && preview.preview.length > 0}
                      onChange={() => selectedIds.size === preview.preview.length ? deselectAll() : selectAll()}
                      className="rounded"
                      data-testid="checkbox-select-all"
                    />
                  </th>
                  <th className="py-2 px-2 text-left text-xs font-medium w-16" style={{ color: "var(--text-dim)" }}>Action</th>
                  <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Project</th>
                  <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>GC</th>
                  <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Region</th>
                  <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Due Date</th>
                  <th className="py-2 px-2 text-left text-xs font-medium" style={{ color: "var(--text-dim)" }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map(entry => {
                  const actionInfo = ACTION_LABELS[entry.action];
                  const ActionIcon = actionInfo.icon;
                  return (
                    <tr
                      key={entry.opportunityId}
                      className="hover-elevate"
                      style={{ borderBottom: "1px solid var(--border-ds)" }}
                      data-testid={`row-bc-${entry.opportunityId}`}
                    >
                      <td className="py-2 px-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(entry.opportunityId)}
                          onChange={() => toggleSelect(entry.opportunityId)}
                          className="rounded"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <Badge className={`text-[10px] gap-1 ${actionInfo.color}`}>
                          <ActionIcon className="h-2.5 w-2.5" />
                          {actionInfo.label}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-xs font-medium">{entry.projectName}</td>
                      <td className="py-2 px-2 text-xs" style={{ color: "var(--text-dim)" }}>{entry.gcCompanyName || entry.gcEstimateLead || "\u2014"}</td>
                      <td className="py-2 px-2">
                        {entry.region ? (
                          <Badge variant="secondary" className="text-xs">{entry.region}</Badge>
                        ) : (
                          <span style={{ color: "#e67e22", fontSize: "11px" }}>⚠ No region</span>
                        )}
                        {entry.regionNotConfident && entry.region && (
                          <span style={{ color: "#e67e22", fontSize: "10px", marginLeft: 4 }} title="Region needs review">⚠</span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-xs" style={{ color: "var(--text-dim)" }}>{fmtDate(entry.dueDate)}</td>
                      <td className="py-2 px-2 text-xs" style={{ color: "var(--text-dim)" }}>
                        {(entry.anticipatedStart || entry.anticipatedFinish) && (
                          <div className="text-[10px]" data-testid={`text-bc-dates-${entry.opportunityId}`}>
                            <span style={{ color: "var(--text-dim)" }}>Const: </span>
                            <span style={{ color: "var(--text)" }}>
                              {fmtDate(entry.anticipatedStart || "")} &rarr; {fmtDate(entry.anticipatedFinish || "")}
                            </span>
                          </div>
                        )}
                        {entry.projectAddress && (
                          <div className="text-[10px]" data-testid={`text-bc-address-${entry.opportunityId}`}>
                            <span style={{ color: "var(--text-dim)" }}>Addr: </span>
                            <span style={{ color: "var(--text)" }}>{entry.projectAddress}</span>
                          </div>
                        )}
                        {entry.squareFeet && (
                          <div className="text-[10px]" data-testid={`text-bc-sqft-${entry.opportunityId}`}>
                            <span style={{ color: "var(--text-dim)" }}>Size: </span>
                            <span style={{ color: "var(--text)" }}>{entry.squareFeet} SF</span>
                          </div>
                        )}
                        {entry.action === "update" && entry.fieldChanges?.map((c, i) => (
                          <div key={i} className="text-[10px] text-amber-500">{c}</div>
                        ))}
                        {entry.action === "merge" && entry.scopeChanges && entry.scopeChanges.length > 0 && (
                          <div className="text-[10px] text-blue-500">+{entry.scopeChanges.length} scopes</div>
                        )}
                        {entry.action === "create" && entry.location && !entry.projectAddress && (
                          <div className="text-[10px]">{entry.location}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between p-4" style={{ borderTop: "1px solid var(--border-ds)" }}>
          <div className="text-xs" style={{ color: "var(--text-dim)" }}>
            {selectedIds.size} of {preview?.preview?.length || 0} selected
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} data-testid="button-cancel-sync">
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={selectedIds.size === 0 || confirmMutation.isPending}
              className="gap-1.5"
              style={{ background: "linear-gradient(135deg, var(--gold), var(--gold-dim))", color: "var(--bg)" }}
              data-testid="button-confirm-sync"
            >
              {confirmMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Sync {selectedIds.size} Selected
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
