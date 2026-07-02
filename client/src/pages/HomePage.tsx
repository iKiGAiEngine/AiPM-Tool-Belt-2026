import { useMemo, useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ScanSearch, Receipt, FolderPlus, ClipboardList,
  Loader2, FlaskConical,
  TableProperties, Sparkles, Users, Activity, FileBarChart,
  FolderOpenDot, Check, PackageCheck, Shield, Calculator, Link2, Mail, Paperclip,
  BookOpen, LifeBuoy, MapPin, Settings as SettingsIcon
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useTestMode } from "@/lib/testMode";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { useFeatureAccess } from "@/hooks/use-feature-access";

interface ToolTile {
  id: string;
  title: string;
  description: string;
  icon: typeof FolderPlus;
  href: string;
  available: boolean;
  comingSoon?: boolean;
  adminOnly?: boolean;
  isExternal?: boolean;
  feature?: string;
}

const tools: ToolTile[] = [
  {
    id: "proposallog",
    title: "Proposal Log Dashboard",
    description: "NBS bid tracking, pipeline analytics & estimating workflow",
    icon: FileBarChart,
    href: "/tools/proposal-log",
    available: true,
    isExternal: true,
    feature: "proposal-log",
  },
  {
    id: "bcsynctable",
    title: "BC Sync Table",
    description: "BuildingConnected draft review, approval & change history",
    icon: Link2,
    href: "/tools/bc-sync-table",
    available: true,
    adminOnly: true,
    feature: "bc-sync",
  },
  {
    id: "projectstart",
    title: "Project Start",
    description: "Create a new project with plans and specs",
    icon: FolderPlus,
    href: "/project-start",
    available: true,
    feature: "project-start",
  },
  {
    id: "specextractor",
    title: "Spec Extractor",
    description: "Division 10 spec extraction with folder export",
    icon: ClipboardList,
    href: "/spec-extractor",
    available: true,
    feature: "spec-extractor",
  },
  {
    id: "quoteparser",
    title: "Quote Parser",
    description: "Parse vendor quotes into structured estimate tables",
    icon: Receipt,
    href: "/quoteparser",
    available: true,
    feature: "quote-parser",
  },
  {
    id: "scheduleconverter",
    title: "Schedule Converter",
    description: "Extract schedule screenshots into estimate tables",
    icon: TableProperties,
    href: "/schedule-converter",
    available: true,
    feature: "schedule-converter",
  },
  {
    id: "vendordatabase",
    title: "Vendor Database",
    description: "Manufacturers, contacts, products, tax & compliance",
    icon: Shield,
    href: "/vendor-database",
    available: true,
    feature: "vendor-database",
  },
  {
    id: "buyoutbot",
    title: "Buyout Tracker",
    description: "Parse an NBS estimate into a trackable buyout: RFQs, quotes, awards & POs",
    icon: PackageCheck,
    href: "/buyout-bot",
    available: true,
  },
  {
    id: "procurementprocess",
    title: "Procurement Process",
    description: "Reference docs: how it works, how it's organized, reporting",
    icon: BookOpen,
    href: "/tools/procurement-process/",
    available: true,
    isExternal: true,
    feature: "procurement-process",
  },
  {
    id: "settings",
    title: "Regional Contacts",
    description: "Manage Self Perform Champions, Estimators, and GC Contacts by Region",
    icon: SettingsIcon,
    href: "/settings",
    available: true,
    feature: "central-settings",
  },
  {
    id: "regions",
    title: "Regional Profiles",
    description: "Manage regional codes, names, aliases & self-perform estimators",
    icon: MapPin,
    href: "/settings",
    available: true,
    feature: "settings-regions",
  },
  {
    id: "taxratelookup",
    title: "Tax Rate Lookup",
    description: "Look up Avalara use tax rates by zip code",
    icon: Calculator,
    href: "/tools/tax-rate-lookup",
    available: true,
    feature: "tax-rate-lookup",
  },
  {
    id: "helpcenter",
    title: "Help Center",
    description: "Step-by-step SOPs for the team — how to use each tool",
    icon: LifeBuoy,
    href: "/help-center",
    available: true,
  },
  {
    id: "planparser",
    title: "Plan Parser",
    description: "OCR and classify construction plan pages by scope",
    icon: ScanSearch,
    href: "/planparser",
    available: true,
    comingSoon: true,
    adminOnly: true,
    feature: "plan-parser",
  },
  {
    id: "submittalbuilder",
    title: "Submittal Builder",
    description: "Assemble and export Division 10 submittal packages",
    icon: PackageCheck,
    href: "/submittal-builder",
    available: true,
    feature: "submittal-builder",
  },
  {
    id: "comingsoon",
    title: "Coming Soon",
    description: "New tools and features are on the way.",
    icon: Sparkles,
    href: "#",
    available: false,
  },
];

interface UsageSummary {
  [toolId: string]: { totalUses: number; uniqueUsers: number };
}

interface UsageDetail {
  toolId: string;
  userBreakdown: Array<{
    userId: number;
    email: string;
    displayName: string | null;
    useCount: number;
    lastUsed: string;
  }>;
  recentEvents: Array<{
    id: number;
    userId: number;
    email: string;
    displayName: string | null;
    usedAt: string;
  }>;
}

interface ProposalRow {
  projectName: string;
  dueDate?: string;
  estimateStatus?: string;
  nbsEstimator?: string;
  filePath?: string;
  bcLink?: string;
  sourceType?: string;
  sourceEmail?: string;
  sourceEmailSubject?: string;
  sourceAttachmentUrl?: string;
  estimateNumber?: string;
  region?: string;
  primaryMarket?: string;
  inviteDate?: string;
  gcEstimateLead?: string;
  proposalTotal?: string;
  anticipatedStart?: string;
  anticipatedFinish?: string;
  owner?: string;
  comments?: string;
  _bizDays?: number;
  _isTest?: boolean;
  _screenshotId?: string;
  _serverDbId?: number;
}

function bizDaysUntil(dateStr: string): number {
  const target = new Date(dateStr + "T00:00:00");
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (target < start) {
    let count = 0;
    const cur = new Date(target);
    while (cur < start) {
      cur.setDate(cur.getDate() + 1);
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return -count;
  }
  let count = 0;
  const cur = new Date(start);
  while (cur < target) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

function formatDueLabel(bd: number, dateStr: string): string {
  if (bd < 0) return `${Math.abs(bd)}BD overdue`;
  if (bd === 0) return "Due today";
  if (bd === 1) return "Tomorrow - 1BD";
  const d = new Date(dateStr + "T00:00:00");
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const day = days[d.getDay()];
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${day}, ${mm}/${dd} - ${bd}BD`;
}

function getDueClass(bd: number, section: string): string {
  if (bd < 0) return "d-hot";
  if (section === "new" || section === "pipeline") return "d-dim";
  if (bd <= 2) return "d-hot";
  if (bd <= 4) return "d-warm";
  return "d-dim";
}

function getUserInitials(user: { displayName?: string | null; email?: string; username?: string | null }): string {
  if (user.displayName) {
    const parts = user.displayName.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].substring(0, 2).toUpperCase();
  }
  if (user.username) return user.username.substring(0, 2).toUpperCase();
  if (user.email) return user.email.substring(0, 2).toUpperCase();
  return "HK";
}

function BidSourceLink({
  bcLink, filePath, sourceEmail, sourceEmailSubject, sourceAttachmentUrl, onClick
}: {
  bcLink?: string;
  filePath?: string;
  sourceEmail?: string;
  sourceEmailSubject?: string;
  sourceAttachmentUrl?: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const bc = bcLink && bcLink.trim();
  const email = sourceEmail && sourceEmail.trim();
  const attachment = sourceAttachmentUrl && sourceAttachmentUrl.trim();
  const fp = filePath && filePath.trim();

  if (bc) {
    return (
      <a
        className="bid-folder"
        href={bc}
        target="_blank"
        rel="noopener noreferrer"
        title="Open BuildingConnected"
        onClick={onClick}
        data-testid="button-bid-source-bc"
      >
        <Link2 style={{ width: 11, height: 11 }} />
      </a>
    );
  }

  if (email) {
    const subject = sourceEmailSubject && sourceEmailSubject.trim();
    const tooltip = subject ? `Open source email · ${subject}` : "Open source email";
    return (
      <a
        className="bid-folder"
        href={`mailto:${email}`}
        title={tooltip}
        onClick={onClick}
        data-testid="button-bid-source-email"
      >
        <Mail style={{ width: 11, height: 11 }} />
      </a>
    );
  }

  if (attachment) {
    return (
      <a
        className="bid-folder"
        href={attachment}
        target="_blank"
        rel="noopener noreferrer"
        title="Open source attachment"
        onClick={onClick}
        data-testid="button-bid-source-attachment"
      >
        <Paperclip style={{ width: 11, height: 11 }} />
      </a>
    );
  }

  if (fp) {
    return (
      <a
        className="bid-folder"
        href={fp}
        target="_blank"
        rel="noopener noreferrer"
        title="Open project folder"
        onClick={onClick}
        data-testid="button-bid-source-folder"
      >
        <FolderOpenDot style={{ width: 11, height: 11 }} />
      </a>
    );
  }

  return (
    <span
      className="bid-folder"
      title="No source link available"
      style={{ opacity: 0.3, cursor: "not-allowed" }}
      data-testid="button-bid-source-none"
    >
      <FolderOpenDot style={{ width: 11, height: 11 }} />
    </span>
  );
}

export default function HomePage() {
  const { isTestMode } = useTestMode();
  const { isAdmin, isViewer, user } = useAuth();
  const { toast } = useToast();
  const { hasFeature } = useFeatureAccess();
  const queryClient = useQueryClient();
  const [selectedToolForStats, setSelectedToolForStats] = useState<string | null>(null);
  const effectiveTestMode = isAdmin && !isViewer && isTestMode;

  const { data: usageSummary } = useQuery<UsageSummary>({
    queryKey: ["/api/tool-usage/summary"],
    enabled: isAdmin,
  });

  const { data: usageDetail } = useQuery<UsageDetail>({
    queryKey: ["/api/tool-usage", selectedToolForStats],
    queryFn: async () => {
      const res = await fetch(`/api/tool-usage/${selectedToolForStats}`);
      if (!res.ok) throw new Error("Failed to fetch usage details");
      return res.json();
    },
    enabled: !!selectedToolForStats && isAdmin,
  });

  // Use TanStack Query so the proposals list and acknowledgements are cached across
  // page navigations within the React app. staleTime: Infinity matches the global
  // default — data stays fresh until invalidated; a 2-min background interval keeps
  // the HUD current without re-fetching on every focus/route change.
  const { data: rawProposals, isLoading: proposalsLoading } = useQuery<any[]>({
    queryKey: ["/api/proposal-log/entries"],
    staleTime: Infinity,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const { data: ackData } = useQuery<{ entryIds: number[] }>({
    queryKey: ["/api/proposal-log/acknowledgements"],
    staleTime: Infinity,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const proposals: ProposalRow[] = useMemo(() => {
    if (!Array.isArray(rawProposals)) return [];
    return rawProposals.map((e: any) => ({
      projectName: e.projectName || "",
      estimateNumber: e.estimateNumber || "",
      region: e.region || "",
      primaryMarket: e.primaryMarket || "",
      inviteDate: e.inviteDate || "",
      dueDate: e.dueDate || "",
      nbsEstimator: e.nbsEstimator || "",
      gcEstimateLead: e.gcEstimateLead || "",
      proposalTotal: e.proposalTotal || "",
      estimateStatus: e.estimateStatus || "Estimating",
      anticipatedStart: e.anticipatedStart || "",
      anticipatedFinish: e.anticipatedFinish || "",
      owner: e.owner || "",
      filePath: e.filePath || "",
      bcLink: e.bcLink || "",
      sourceType: e.sourceType || "",
      sourceEmail: e.sourceEmail || "",
      sourceEmailSubject: e.sourceEmailSubject || "",
      sourceAttachmentUrl: e.sourceAttachmentUrl || "",
      comments: "",
      _screenshotId: e.estimateNumber || "",
      _isTest: e.isTest || false,
      _serverDbId: e.id,
    }));
  }, [rawProposals]);

  // Derived from query cache — updated optimistically via queryClient.setQueryData
  // in handleAcknowledge so the UI responds immediately without a re-fetch.
  const acknowledgedIds: Set<number> = useMemo(
    () => new Set(ackData?.entryIds ?? []),
    [ackData]
  );

  const userInitials = user?.initials || (user ? getUserInitials(user) : "HK");
  const userEstimatorCode = userInitials.toUpperCase();

  const activeStatuses = ["Lead", "Estimating"];

  const activeBids = useMemo(() => {
    return proposals
      .filter((p) => {
        if (!p.dueDate || !activeStatuses.includes(p.estimateStatus || "")) return false;
        if (p._isTest && !effectiveTestMode) return false;
        if (!p._isTest && effectiveTestMode) return false;
        if (!p.nbsEstimator || p.nbsEstimator.trim().toUpperCase() !== userEstimatorCode) return false;
        return true;
      })
      .map((p) => ({ ...p, _bizDays: bizDaysUntil(p.dueDate!) }))
      .sort((a, b) => a._bizDays - b._bizDays);
  }, [proposals, userEstimatorCode, effectiveTestMode]);

  const { newlyAssigned, dueThisWeek, activePipeline } = useMemo(() => {
    const na: typeof activeBids = [];
    const dtw: typeof activeBids = [];
    const ap: typeof activeBids = [];
    const placed = new Set<number>();

    for (const p of activeBids) {
      if (!p._serverDbId) continue;
      if (!acknowledgedIds.has(p._serverDbId) && p.estimateStatus === "Estimating" && na.length < 5) {
        na.push(p);
        placed.add(p._serverDbId);
      }
    }

    for (const p of activeBids) {
      if (!p._serverDbId || placed.has(p._serverDbId)) continue;
      if (p._bizDays! <= 7) {
        dtw.push(p);
        placed.add(p._serverDbId);
      }
    }

    for (const p of activeBids) {
      if (!p._serverDbId || placed.has(p._serverDbId)) continue;
      if (p._bizDays! > 7) {
        ap.push(p);
      }
    }

    return { newlyAssigned: na, dueThisWeek: dtw, activePipeline: ap };
  }, [activeBids, acknowledgedIds]);

  const [animatingOutIds, setAnimatingOutIds] = useState<Set<number>>(new Set());

  // Optimistically update the ack cache so the UI responds immediately
  // without waiting for a refetch.
  const patchAckCache = useCallback((entryId: number, add: boolean) => {
    queryClient.setQueryData<{ entryIds: number[] }>(
      ["/api/proposal-log/acknowledgements"],
      (old) => {
        const ids = old?.entryIds ?? [];
        return {
          entryIds: add
            ? ids.includes(entryId) ? ids : [...ids, entryId]
            : ids.filter((id) => id !== entryId),
        };
      }
    );
  }, []);

  const handleAcknowledge = useCallback(async (p: ProposalRow) => {
    if (guardViewer(isViewer, toast)) return;
    if (!p._serverDbId) return;
    const entryId = p._serverDbId;

    setAnimatingOutIds((prev) => {
      const next = new Set(prev);
      next.add(entryId);
      return next;
    });

    setTimeout(async () => {
      setAnimatingOutIds((prev) => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
      // Optimistic update — mark as acknowledged in the cache immediately
      patchAckCache(entryId, true);

      try {
        const res = await fetch(`/api/proposal-log/acknowledge/${entryId}`, {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) {
          patchAckCache(entryId, false);
          const body = await res.json().catch(() => ({}));
          toast({
            title: "Couldn't acknowledge bid",
            description: body?.message || `Server error (${res.status}) — please try again.`,
            variant: "destructive",
          });
        }
      } catch (err: any) {
        patchAckCache(entryId, false);
        toast({
          title: "Couldn't acknowledge bid",
          description: err?.message || "Network error — please check your connection and try again.",
          variant: "destructive",
        });
      }
    }, 700);
  }, [patchAckCache]);

  const selectedToolTitle = tools.find((t) => t.id === selectedToolForStats)?.title || "";

  return (
    <div className="hp-root" data-testid="homepage">
      <div className="page-hero">
        <h1 className="hp-title">
          <span style={{ color: "var(--gold)" }}>AiPM</span> Tool Belt
        </h1>
        <div className="hp-rule" />
        <p className="hp-eyebrow">YOUR AI ASSISTED DIGITAL PM</p>
      </div>
      <div className="main-layout">
        <ReadOnlyBanner />
        <div className="tools-col">
          {tools.map((tool, i) => {
            const Icon = tool.icon;
            const isDisabled = !tool.available;
            const isComingSoon = tool.comingSoon === true;
            const isAdminRestricted = tool.adminOnly === true && !isAdmin;

            // Hide tile entirely if the user lacks the required feature (admins always see everything)
            if (!isAdmin && tool.feature && !hasFeature(tool.feature)) return null;
            if (tool.id === "regions" && (isAdmin || hasFeature("central-settings"))) return null;

            if (isDisabled || (isComingSoon && isAdminRestricted)) {
              return (
                <div
                  key={tool.id}
                  className="tool-card disabled"
                  style={{ ["--i" as any]: i }}
                  data-testid={`tile-${tool.id}`}
                >
                  <div className="tool-icon">
                    <Icon style={{ width: 22, height: 22, color: "var(--text-dim)" }} />
                  </div>
                  <div className="tool-text">
                    {(isComingSoon || isDisabled) && <div className="csb">Coming Soon</div>}
                    <div className="tool-name">{tool.title}</div>
                    <div className="tool-desc">{tool.description}</div>
                  </div>
                </div>
              );
            }

            const Wrapper = tool.isExternal ? "a" : Link;
            const wrapperProps = tool.isExternal
              ? { href: tool.href }
              : { href: tool.href };

            return (
              <Wrapper
                key={tool.id}
                {...wrapperProps}
                className={`tool-card ${isComingSoon ? "tool-card-coming" : ""}`}
                style={{ ["--i" as any]: i }}
                data-testid={`tile-${tool.id}`}
              >
                <div className="tool-icon">
                  <Icon style={{ width: 22, height: 22, color: "var(--gold)" }} />
                </div>
                <div className="tool-text">
                  {isComingSoon && <div className="csb">Coming Soon</div>}
                  <div className="tool-name">{tool.title}</div>
                  <div className="tool-desc">{tool.description}</div>
                </div>
              </Wrapper>
            );
          })}
        </div>

        <div className="hud-col">
          <div
            className="pl-card"
            onClick={() => { window.location.href = "/tools/proposal-log"; }}
            data-testid="card-proposal-log-hud"
          >
            <div className="pl-glow" />

            <div className="pl-header">
              <div className="pl-header-left">
                <div className="pl-icon">
                  <FileBarChart style={{ width: 18, height: 18, color: "var(--gold)" }} />
                </div>
                <div>
                  <div className="pl-title">Active Estimating Queue</div>
                  <div className="pl-sub">Your Lead and Estimating bids only</div>
                </div>
              </div>
              <div className="pl-header-right">
                <div className="pl-badge" data-testid="badge-user-initials">{userInitials}</div>
                <div className="pl-open">Open &rarr;</div>
              </div>
            </div>

            <div className="pl-hud-wrap">
              {proposalsLoading && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 0", opacity: 0.5 }}>
                  {[1,2,3].map(n => (
                    <div key={n} style={{ height: 28, borderRadius: 6, background: "rgba(255,255,255,0.07)", animation: "pulse 1.4s ease-in-out infinite" }} />
                  ))}
                </div>
              )}
              <div className="pl-hud" style={proposalsLoading ? { visibility: "hidden", height: 0, overflow: "hidden" } : {}}>
                <HudSection
                  label="Newly Assigned"
                  labelClass="lbl-new"
                  count={newlyAssigned.length}
                  countId="cnt-new"
                >
                  {newlyAssigned.map((p, i) => {
                    const due = formatDueLabel(p._bizDays!, p.dueDate!);
                    const stableId = p._serverDbId || p.estimateNumber || `new-${i}`;
                    const isAnimating = p._serverDbId ? animatingOutIds.has(p._serverDbId) : false;
                    return (
                      <div
                        key={stableId}
                        className={`bid-row bid-row-ack-anim${isAnimating ? " bid-row-hiding" : ""}`}
                      >
                        <button
                          className={`ack-btn${isAnimating ? " ack-btn-done" : ""}`}
                          title="Acknowledge"
                          disabled={isAnimating || isViewer}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleAcknowledge(p);
                          }}
                          data-testid={`button-ack-${stableId}`}
                        >
                          <Check style={{ width: 11, height: 11 }} />
                        </button>
                        {p._serverDbId && hasFeature("estimating-module") ? (
                          <a className="bid-name bid-name-link" href={`/estimates/${p._serverDbId}`} title="Open Estimate" data-testid={`text-bid-name-new-${i}`}>{p.projectName}</a>
                        ) : (
                          <div className="bid-name" data-testid={`text-bid-name-new-${i}`}>{p.projectName}</div>
                        )}
                        {p._serverDbId && hasFeature("estimating-module") ? (
                          <a
                            className="bid-estimate"
                            href={`/estimates/${p._serverDbId}`}
                            title="Open in Estimating Module"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`button-estimate-hud-new-${stableId}`}
                          >
                            <Calculator style={{ width: 11, height: 11 }} />
                          </a>
                        ) : (
                          <span />
                        )}
                        <BidSourceLink
                          bcLink={p.bcLink}
                          filePath={p.filePath}
                          sourceEmail={p.sourceEmail}
                          sourceEmailSubject={p.sourceEmailSubject}
                          sourceAttachmentUrl={p.sourceAttachmentUrl}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className={`bid-due ${getDueClass(p._bizDays!, "new")}`}>{due}</div>
                      </div>
                    );
                  })}
                </HudSection>

                <HudSection
                  label="Due This Week"
                  labelClass="lbl-hot"
                  count={dueThisWeek.length}
                  countId="cnt-due"
                >
                  {dueThisWeek.map((p, i) => {
                    const due = formatDueLabel(p._bizDays!, p.dueDate!);
                    const stableId = p._serverDbId || p.estimateNumber || `due-${i}`;
                    return (
                      <div key={stableId} className="bid-row">
                        <span className="ack-btn-spacer" />
                        {p._serverDbId && hasFeature("estimating-module") ? (
                          <a className="bid-name bid-name-link" href={`/estimates/${p._serverDbId}`} title="Open Estimate" data-testid={`text-bid-name-due-${i}`}>{p.projectName}</a>
                        ) : (
                          <div className="bid-name" data-testid={`text-bid-name-due-${i}`}>{p.projectName}</div>
                        )}
                        {p._serverDbId && hasFeature("estimating-module") ? (
                          <a
                            className="bid-estimate"
                            href={`/estimates/${p._serverDbId}`}
                            title="Open in Estimating Module"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`button-estimate-hud-due-${stableId}`}
                          >
                            <Calculator style={{ width: 11, height: 11 }} />
                          </a>
                        ) : (
                          <span />
                        )}
                        <BidSourceLink
                          bcLink={p.bcLink}
                          filePath={p.filePath}
                          sourceEmail={p.sourceEmail}
                          sourceEmailSubject={p.sourceEmailSubject}
                          sourceAttachmentUrl={p.sourceAttachmentUrl}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className={`bid-due ${getDueClass(p._bizDays!, "due")}`}>{due}</div>
                      </div>
                    );
                  })}
                </HudSection>

                <HudSection
                  label="Remaining Active"
                  labelClass="lbl-pipe"
                  count={activePipeline.length}
                  countId="cnt-pipe"
                >
                  {activePipeline.map((p, i) => {
                    const due = formatDueLabel(p._bizDays!, p.dueDate!);
                    const stableId = p._serverDbId || p.estimateNumber || `pipe-${i}`;
                    return (
                      <div key={stableId} className="bid-row">
                        <span className="ack-btn-spacer" />
                        {p._serverDbId && hasFeature("estimating-module") ? (
                          <a className="bid-name bid-name-link" href={`/estimates/${p._serverDbId}`} title="Open Estimate" data-testid={`text-bid-name-pipe-${i}`}>{p.projectName}</a>
                        ) : (
                          <div className="bid-name" data-testid={`text-bid-name-pipe-${i}`}>{p.projectName}</div>
                        )}
                        {p._serverDbId && hasFeature("estimating-module") ? (
                          <a
                            className="bid-estimate"
                            href={`/estimates/${p._serverDbId}`}
                            title="Open in Estimating Module"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`button-estimate-hud-pipe-${stableId}`}
                          >
                            <Calculator style={{ width: 11, height: 11 }} />
                          </a>
                        ) : (
                          <span />
                        )}
                        <BidSourceLink
                          bcLink={p.bcLink}
                          filePath={p.filePath}
                          sourceEmail={p.sourceEmail}
                          sourceEmailSubject={p.sourceEmailSubject}
                          sourceAttachmentUrl={p.sourceAttachmentUrl}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className={`bid-due ${getDueClass(p._bizDays!, "pipeline")}`}>{due}</div>
                      </div>
                    );
                  })}
                </HudSection>
              </div>
            </div>

            <div className="pl-footer">
              <div className="pl-footer-note">Your Lead/Estimating queue &nbsp;&middot;&nbsp; opens BC or folder &nbsp;&middot;&nbsp; acknowledge when reviewed</div>
              <div className="pl-footer-cta">Open Proposal Log Dashboard <span>&rarr;</span></div>
            </div>
          </div>
        </div>
      </div>
      <Dialog open={!!selectedToolForStats} onOpenChange={(open) => { if (!open) setSelectedToolForStats(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2" data-testid="text-stats-dialog-title">
              <Activity className="w-5 h-5" style={{ color: "var(--gold)" }} />
              {selectedToolTitle} Usage
            </DialogTitle>
            <DialogDescription>Usage statistics and user breakdown for {selectedToolTitle}</DialogDescription>
          </DialogHeader>
          {usageDetail ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg p-4 text-center" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                  <p className="text-2xl font-bold font-heading" style={{ color: "var(--gold)" }} data-testid="text-stats-total-uses">
                    {usageSummary?.[selectedToolForStats || ""]?.totalUses || 0}
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-dim)" }}>Total Uses</p>
                </div>
                <div className="rounded-lg p-4 text-center" style={{ background: "var(--bg3)", border: "1px solid var(--border-ds)" }}>
                  <p className="text-2xl font-bold font-heading" style={{ color: "var(--gold)" }} data-testid="text-stats-unique-users">
                    {usageSummary?.[selectedToolForStats || ""]?.uniqueUsers || 0}
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-dim)" }}>Unique Users</p>
                </div>
              </div>
              {usageDetail.userBreakdown.length > 0 ? (
                <div>
                  <h3 className="text-sm font-medium text-foreground mb-3">User Breakdown</h3>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {usageDetail.userBreakdown.map((u) => (
                      <div key={u.userId} className="flex items-center justify-between gap-3 p-2 rounded-md border" data-testid={`row-user-${u.userId}`}>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{u.displayName || u.email}</p>
                          {u.displayName && <p className="text-xs text-muted-foreground truncate">{u.email}</p>}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <Badge variant="secondary" className="text-xs">{u.useCount} uses</Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(u.lastUsed).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No usage data yet</p>
              )}
              {usageDetail.recentEvents.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-foreground mb-3">Recent Activity</h3>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {usageDetail.recentEvents.slice(0, 10).map((evt) => (
                      <div key={evt.id} className="flex items-center justify-between gap-3 px-2 py-1.5 text-xs" data-testid={`row-event-${evt.id}`}>
                        <span className="text-muted-foreground truncate">{evt.displayName || evt.email}</span>
                        <span className="text-muted-foreground/70 shrink-0">
                          {new Date(evt.usedAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HudSection({
  label,
  labelClass,
  count,
  countId,
  children,
}: {
  label: string;
  labelClass: string;
  count: number;
  countId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="hud-block">
      <div className="hud-head">
        <div className={`hud-label ${labelClass}`}>
          <div className="lbl-dot" />
          {label}
        </div>
        <div className="hud-rule" />
        <div className="hud-count" id={countId} data-testid={`text-${countId}`}>
          {count} bid{count !== 1 ? "s" : ""}
        </div>
      </div>
      <div className="hud-rows">{children}</div>
    </div>
  );
}
