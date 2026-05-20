import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ArrowLeft, Loader2, CheckCircle, AlertCircle, Clock,
  FileText, ScanSearch, FolderOpen, ToggleLeft, ToggleRight,
  Play, Factory, Hash, Layers, ChevronDown, ChevronRight, Download,
  BookOpen, FileDown, TrendingUp, TrendingDown, Minus, RefreshCw, ExternalLink
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Project, ProjectScope } from "@shared/schema";

interface PlanPage {
  id: string;
  jobId: string;
  originalFilename: string;
  pageNumber: number;
  isRelevant: boolean;
  tags: string[];
  confidence: number;
  whyFlagged: string;
  signageOverrideApplied: boolean;
  ocrSnippet: string;
  userModified: boolean;
  hasOcrText: boolean;
}

const STATUS_MAP: Record<string, { label: string; color: string; icon: typeof Loader2 }> = {
  created: { label: "Created", color: "text-blue-500", icon: Clock },
  plans_uploaded: { label: "Plans Uploaded", color: "text-blue-500", icon: Clock },
  specs_uploaded: { label: "Specs Uploaded", color: "text-blue-500", icon: Clock },
  specsift_running: { label: "Spec Extractor Running", color: "text-yellow-500", icon: Loader2 },
  specsift_complete: { label: "Spec Extractor Complete", color: "text-green-500", icon: CheckCircle },
  specsift_error: { label: "Spec Extractor Error", color: "text-red-500", icon: AlertCircle },
  planparser_baseline_running: { label: "Plan Parser Running", color: "text-yellow-500", icon: Loader2 },
  planparser_baseline_complete: { label: "Plan Parser Complete", color: "text-green-500", icon: CheckCircle },
  planparser_baseline_error: { label: "Plan Parser Error", color: "text-red-500", icon: AlertCircle },
  scopes_selected: { label: "Scopes Selected", color: "text-green-500", icon: CheckCircle },
  planparser_specpass_running: { label: "Spec-Pass Running", color: "text-yellow-500", icon: Loader2 },
  planparser_specpass_complete: { label: "Spec-Pass Complete", color: "text-green-500", icon: CheckCircle },
  planparser_specpass_error: { label: "Spec-Pass Error", color: "text-red-500", icon: AlertCircle },
  outputs_ready: { label: "Outputs Ready", color: "text-green-600", icon: CheckCircle },
  folder_only: { label: "Folder Only", color: "text-green-500", icon: FolderOpen },
};

function isProcessingStatus(status: string | null | undefined): boolean {
  return !!status && (status.includes("running") || status === "created");
}

function canRunSpecPass(status: string | null | undefined): boolean {
  return !!status && (
    status === "planparser_baseline_complete" ||
    status === "outputs_ready" ||
    status === "planparser_specpass_error"
  );
}

function hasPlanResults(status: string | null | undefined): boolean {
  return !!status && [
    "planparser_baseline_complete", "outputs_ready",
    "planparser_specpass_running", "planparser_specpass_complete",
    "planparser_specpass_error", "scopes_selected"
  ].includes(status);
}

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = parseInt(params.id || "0");
  const { toast } = useToast();
  const { isViewer } = useAuth();
  const [expandedScopes, setExpandedScopes] = useState<Set<number>>(new Set());
  const [expandedPlanScopes, setExpandedPlanScopes] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [isBookmarkExporting, setIsBookmarkExporting] = useState(false);
  const [scopeDownloading, setScopeDownloading] = useState<string | null>(null);

  const { data: project, isLoading: projectLoading } = useQuery<Project>({
    queryKey: ["/api/projects", projectId],
    enabled: projectId > 0,
    refetchInterval: (query) => {
      const data = query.state.data as Project | undefined;
      return data && isProcessingStatus(data.status) ? 3000 : false;
    },
  });

  const { data: scopes = [], isLoading: scopesLoading } = useQuery<ProjectScope[]>({
    queryKey: ["/api/projects", projectId, "scopes"],
    enabled: projectId > 0,
    refetchInterval: (query) => {
      return project && isProcessingStatus(project.status) ? 5000 : false;
    },
  });

  const { data: planPages = [] } = useQuery<PlanPage[]>({
    queryKey: ["/api/projects", projectId, "plan-pages"],
    enabled: projectId > 0 && !!project && hasPlanResults(project.status),
  });

  const { data: specExtractorConfig } = useQuery<{ url: string | null; configured: boolean }>({
    queryKey: ["/api/config/spec-extractor"],
  });
  const specExtractorUrl = specExtractorConfig?.url || null;

  useEffect(() => {
    if (project && !isProcessingStatus(project.status)) {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "scopes"] });
      if (hasPlanResults(project.status)) {
        queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "plan-pages"] });
      }
    }
  }, [project?.status]);

  const toggleScopeMutation = useMutation({
    mutationFn: async ({ scopeId, isSelected }: { scopeId: number; isSelected: boolean }) => {
      await apiRequest("PATCH", `/api/projects/${projectId}/scopes/${scopeId}/select`, { isSelected });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "scopes"] });
    },
    onError: () => {
      toast({ title: "Failed to update scope selection", variant: "destructive" });
    },
  });

  const specPassMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/spec-pass`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      toast({ title: "Spec-informed second pass started" });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to start second pass",
        description: err.message || "Please try again",
        variant: "destructive"
      });
    },
  });

  const retryMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/projects/${projectId}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId] });
      toast({ title: "Retry started" });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to retry",
        description: err.message || "Please try again",
        variant: "destructive"
      });
    },
  });

  const selectAllMutation = useMutation({
    mutationFn: async (selectAll: boolean) => {
      for (const scope of scopes) {
        if (scope.isSelected !== selectAll) {
          await apiRequest("PATCH", `/api/projects/${projectId}/scopes/${scope.id}/select`, { isSelected: selectAll });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "scopes"] });
    },
  });

  const toggleExpanded = (scopeId: number) => {
    setExpandedScopes(prev => {
      const next = new Set(prev);
      if (next.has(scopeId)) next.delete(scopeId);
      else next.add(scopeId);
      return next;
    });
  };

  const togglePlanScope = (scope: string) => {
    setExpandedPlanScopes(prev => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  if (projectLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="container max-w-3xl mx-auto py-8 px-4 text-center">
        <p className="text-muted-foreground">Project not found</p>
        <Link href="/">
          <Button variant="outline" className="mt-4">Back to Home</Button>
        </Link>
      </div>
    );
  }

  const downloadFile = async (url: string, fallbackName: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: "Download failed" }));
      throw new Error(err.message || "Download failed");
    }
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    const disposition = response.headers.get("Content-Disposition");
    const filenameMatch = disposition?.match(/filename="(.+)"/);
    a.download = filenameMatch?.[1] || fallbackName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(blobUrl);
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      await downloadFile(`/api/projects/${projectId}/export`, `${project?.projectId}_Export.zip`);
      toast({ title: "Export downloaded" });
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  const handleBookmarkedPdf = async () => {
    setIsBookmarkExporting(true);
    try {
      await downloadFile(`/api/projects/${projectId}/bookmarked-pdf`, `${project?.projectId}_Plans_Bookmarked.pdf`);
      toast({ title: "Bookmarked PDF downloaded" });
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setIsBookmarkExporting(false);
    }
  };

  const handleScopePdf = async (scopeName: string) => {
    setScopeDownloading(scopeName);
    try {
      await downloadFile(
        `/api/projects/${projectId}/scope-pdf/${encodeURIComponent(scopeName)}`,
        `${scopeName.replace(/\s+/g, "_")}.pdf`
      );
      toast({ title: `${scopeName} PDF downloaded` });
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setScopeDownloading(null);
    }
  };

  const statusInfo = STATUS_MAP[project.status || "created"] || STATUS_MAP.created;
  const StatusIcon = statusInfo.icon;
  const isProcessing = isProcessingStatus(project.status);
  const isError = !!project.status && project.status.includes("error");
  const selectedCount = scopes.filter(s => s.isSelected).length;
  const showSpecPassButton = canRunSpecPass(project.status) && scopes.length > 0;
  const showPlanResults = hasPlanResults(project.status);
  const canExport = !!project.status && [
    "outputs_ready", "planparser_baseline_complete", "planparser_specpass_error",
    "specsift_complete"
  ].includes(project.status);

  const relevantPages = planPages.filter(p => p.isRelevant);
  const scopePageMap: Record<string, PlanPage[]> = {};
  for (const page of relevantPages) {
    for (const tag of page.tags) {
      if (!scopePageMap[tag]) scopePageMap[tag] = [];
      scopePageMap[tag].push(page);
    }
  }
  const sortedPlanScopes = Object.keys(scopePageMap).sort();

  const baselineScopeCounts = (project.baselineScopeCounts || {}) as Record<string, number>;
  const baselineFlaggedPages = project.baselineFlaggedPages ?? null;
  const isSpecPassComplete = project.status === "outputs_ready" || project.status === "planparser_specpass_complete";
  const hasBaselineData = baselineFlaggedPages !== null && Object.keys(baselineScopeCounts).length > 0;
  const showComparison = isSpecPassComplete && hasBaselineData;

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4">
      <ReadOnlyBanner />
      <div className="flex items-center gap-4 mb-8">
        <Link href="/">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-heading font-semibold text-foreground" data-testid="text-project-name">
              {project.projectName}
            </h1>
            <Badge variant="outline" className="font-mono" data-testid="text-project-id">
              {project.projectId}
            </Badge>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <StatusIcon className={`w-4 h-4 ${statusInfo.color} ${isProcessing ? "animate-spin" : ""}`} />
            <span className={`text-sm ${statusInfo.color}`} data-testid="text-project-status">
              {statusInfo.label}
            </span>
            {project.regionCode && (
              <Badge variant="secondary" className="text-xs">{project.regionCode}</Badge>
            )}
            {project.dueDate && (
              <span className="text-xs text-muted-foreground">Due: {project.dueDate}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            asChild
            data-testid="button-download-folder"
          >
            <a href={`/api/projects/${projectId}/download-folder`} download>
              <FolderOpen className="w-4 h-4 mr-2" />
              Download Folder
            </a>
          </Button>
          {canExport && (
            <Button
              onClick={handleExport}
              disabled={isExporting}
              variant="outline"
              data-testid="button-export-project"
            >
              {isExporting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              Export ZIP
            </Button>
          )}
        </div>
      </div>

      {isProcessing && (
        <Card className="mb-6 border-yellow-500/30">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-yellow-500" />
              <div className="flex-1">
                <p className="text-sm font-medium">Processing in progress</p>
                <p className="text-xs text-muted-foreground">This page refreshes automatically. Results will appear when ready.</p>
              </div>
              <Badge variant="outline" className="text-xs">
                {statusInfo.label}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {isError && (
        <Card className="mb-6 border-red-500/30">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-400">
                  {statusInfo.label}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {project.status === "specsift_error"
                    ? "The specification extraction failed. You can retry the process."
                    : project.status === "planparser_baseline_error"
                      ? "Plan classification failed during the baseline pass. You can retry."
                      : "The spec-informed second pass failed. You can retry the process."}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { if (!guardViewer(isViewer, toast)) retryMutation.mutate(); }}
                disabled={retryMutation.isPending || isViewer}
                data-testid="button-retry"
              >
                {retryMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4 mr-2" />
                )}
                Retry
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <Card className="card-accent-bar">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5" style={{ color: "var(--gold)" }} />
              <CardTitle className="text-base font-heading">Spec Extractor</CardTitle>
            </div>
            <CardDescription className="text-xs eyebrow">Spec extraction results</CardDescription>
          </CardHeader>
          <CardContent>
            {project.specsFilename && (
              <div className="text-sm text-muted-foreground mb-2" data-testid="text-specs-filename">
                {project.specsFilename}
              </div>
            )}
            {project.specsiftSessionId ? (
              <div className="flex items-center gap-2 flex-wrap">
                <Link href={`/spec-extractor`}>
                  <Button variant="outline" size="sm" data-testid="button-view-spec-extractor">
                    View Spec Extractor
                  </Button>
                </Link>
                {specExtractorUrl && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const url = new URL(specExtractorUrl);
                      url.searchParams.set("project", project.projectName || "");
                      window.open(url.toString(), "_blank", "noopener,noreferrer");
                    }}
                    data-testid="button-open-spec-extractor-detail"
                  >
                    <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                    Spec Extractor
                  </Button>
                )}
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">Not started</span>
            )}
          </CardContent>
        </Card>

        <Card className="card-accent-bar">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <ScanSearch className="w-5 h-5" style={{ color: "var(--gold)" }} />
              <CardTitle className="text-base font-heading">Plan Parser</CardTitle>
            </div>
            <CardDescription className="text-xs eyebrow">Plan classification results</CardDescription>
          </CardHeader>
          <CardContent>
            {project.plansFilename && (
              <div className="text-sm text-muted-foreground mb-2" data-testid="text-plans-filename">
                {project.plansFilename}
              </div>
            )}
            {project.planparserJobId ? (
              <Link href={`/planparser?job=${project.planparserJobId}`}>
                <Button variant="outline" size="sm" data-testid="button-view-planparser">
                  View Plan Parser Results
                </Button>
              </Link>
            ) : (
              <span className="text-sm text-muted-foreground">Not started</span>
            )}
          </CardContent>
        </Card>
      </div>

      {project.folderPath && (
        <Card className="mb-6 card-accent-bar">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-5 h-5" style={{ color: "var(--gold)" }} />
              <CardTitle className="text-base font-heading">Project Folder</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-sm text-muted-foreground break-all" data-testid="text-folder-path">
              {project.folderPath}
            </div>
          </CardContent>
        </Card>
      )}

      {showPlanResults && (
        <Card className="mb-6 card-accent-bar">
          <CardHeader>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2">
                  <ScanSearch className="w-5 h-5" style={{ color: "var(--gold)" }} />
                  <CardTitle className="text-base font-heading">Plan Parser Results</CardTitle>
                  {showComparison && (
                    <Badge variant="secondary" className="text-xs">Spec-Pass Complete</Badge>
                  )}
                </div>
                <CardDescription className="mt-1">
                  {relevantPages.length} relevant page{relevantPages.length !== 1 ? "s" : ""} found
                  {planPages.length > 0 && ` out of ${planPages.length} total`}
                  {showComparison && baselineFlaggedPages !== null && (
                    <span className="ml-1">
                      (baseline: {baselineFlaggedPages})
                    </span>
                  )}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                {relevantPages.length > 0 && canExport && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBookmarkedPdf}
                    disabled={isBookmarkExporting}
                    data-testid="button-bookmarked-pdf"
                  >
                    {isBookmarkExporting ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <BookOpen className="w-4 h-4 mr-2" />
                    )}
                    Bookmarked PDF
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {sortedPlanScopes.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground" data-testid="text-no-plan-results">
                No relevant pages found
              </div>
            ) : (
              <div className="space-y-2">
                {sortedPlanScopes.map(scope => {
                  const pages = scopePageMap[scope];
                  const isExpanded = expandedPlanScopes.has(scope);
                  const avgConfidence = Math.round(
                    pages.reduce((sum, p) => sum + p.confidence, 0) / pages.length
                  );
                  const baselineCount = baselineScopeCounts[scope] ?? 0;
                  const currentCount = pages.length;
                  const diff = showComparison ? currentCount - baselineCount : 0;

                  return (
                    <div
                      key={scope}
                      className="rounded-lg border"
                      data-testid={`plan-scope-${scope.replace(/\s+/g, "-").toLowerCase()}`}
                    >
                      <div
                        className="flex items-center gap-3 p-3 cursor-pointer"
                        onClick={() => togglePlanScope(scope)}
                      >
                        <span className="text-muted-foreground">
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{scope}</span>
                            <Badge variant="secondary" className="text-xs">
                              {currentCount} page{currentCount !== 1 ? "s" : ""}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              avg {avgConfidence}% confidence
                            </span>
                            {showComparison && diff !== 0 && (
                              <Badge
                                variant="outline"
                                className={`text-xs ${diff > 0 ? "text-green-600 border-green-300" : "text-orange-600 border-orange-300"}`}
                              >
                                {diff > 0 ? (
                                  <TrendingUp className="w-3 h-3 mr-1" />
                                ) : (
                                  <TrendingDown className="w-3 h-3 mr-1" />
                                )}
                                {diff > 0 ? "+" : ""}{diff} vs baseline
                              </Badge>
                            )}
                            {showComparison && diff === 0 && baselineCount > 0 && (
                              <Badge variant="outline" className="text-xs text-muted-foreground">
                                <Minus className="w-3 h-3 mr-1" />
                                no change
                              </Badge>
                            )}
                          </div>
                        </div>
                        {canExport && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleScopePdf(scope);
                            }}
                            disabled={scopeDownloading === scope}
                            data-testid={`button-download-scope-${scope.replace(/\s+/g, "-").toLowerCase()}`}
                          >
                            {scopeDownloading === scope ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <FileDown className="w-4 h-4" />
                            )}
                          </Button>
                        )}
                      </div>

                      {isExpanded && (
                        <div className="border-t px-3 pb-3 pt-2">
                          <div className="space-y-1.5">
                            {pages
                              .sort((a, b) => a.pageNumber - b.pageNumber)
                              .map(page => (
                                <div
                                  key={page.id}
                                  className="flex items-start gap-2 text-sm"
                                  data-testid={`plan-page-${page.id}`}
                                >
                                  <span className="font-mono text-xs text-muted-foreground w-16 shrink-0 pt-0.5">
                                    pg {page.pageNumber}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <Badge
                                        variant={page.confidence >= 75 ? "default" : page.confidence >= 40 ? "secondary" : "outline"}
                                        className="text-xs"
                                      >
                                        {page.confidence}%
                                      </Badge>
                                      {page.userModified && (
                                        <Badge variant="outline" className="text-xs">edited</Badge>
                                      )}
                                    </div>
                                    {page.whyFlagged && (
                                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                        {page.whyFlagged}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {showComparison && hasBaselineData && (
                  <div className="mt-4 p-3 rounded-lg bg-muted/50">
                    <p className="eyebrow mb-2">Spec-Pass Comparison</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-2xl font-heading font-bold" style={{ color: "var(--gold)" }} data-testid="text-current-flagged">{relevantPages.length}</p>
                        <p className="text-xs text-muted-foreground">Current flagged pages</p>
                      </div>
                      <div>
                        <p className="text-2xl font-heading font-bold text-muted-foreground" data-testid="text-baseline-flagged">{baselineFlaggedPages}</p>
                        <p className="text-xs text-muted-foreground">Baseline flagged pages</p>
                      </div>
                    </div>
                    {(() => {
                      const allScopesArr = Array.from(new Set(
                        Object.keys(baselineScopeCounts).concat(Object.keys(scopePageMap))
                      ));
                      const newScopes = allScopesArr.filter(
                        s => !baselineScopeCounts[s] && scopePageMap[s]?.length > 0
                      );
                      const removedScopes = allScopesArr.filter(
                        s => baselineScopeCounts[s] && (!scopePageMap[s] || scopePageMap[s].length === 0)
                      );
                      if (newScopes.length === 0 && removedScopes.length === 0) return null;
                      return (
                        <div className="mt-3 space-y-1">
                          {newScopes.length > 0 && (
                            <p className="text-xs text-green-600">
                              New scopes found: {newScopes.join(", ")}
                            </p>
                          )}
                          {removedScopes.length > 0 && (
                            <p className="text-xs text-orange-600">
                              Scopes removed: {removedScopes.join(", ")}
                            </p>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="card-accent-bar">
        <CardHeader>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-base font-heading">Detected Scopes</CardTitle>
              <CardDescription>
                Spec sections extracted by Spec Extractor. Toggle scopes on/off, then run the spec-informed second pass to boost Plan Parser accuracy.
              </CardDescription>
            </div>
            {scopes.length > 0 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { if (!guardViewer(isViewer, toast)) selectAllMutation.mutate(true); }}
                  disabled={selectAllMutation.isPending || scopes.every(s => s.isSelected) || isViewer}
                  data-testid="button-select-all"
                >
                  Select All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { if (!guardViewer(isViewer, toast)) selectAllMutation.mutate(false); }}
                  disabled={selectAllMutation.isPending || scopes.every(s => !s.isSelected) || isViewer}
                  data-testid="button-deselect-all"
                >
                  Deselect All
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {scopesLoading ? (
            <div className="text-center py-4 text-muted-foreground">Loading scopes...</div>
          ) : scopes.length === 0 ? (
            <div className="text-center py-4 text-muted-foreground" data-testid="text-no-scopes">
              {isProcessing
                ? "Scopes will appear after Spec Extractor completes"
                : "No scopes detected"}
            </div>
          ) : (
            <div className="space-y-3">
              {scopes.map((scope) => {
                const mfrs = (scope.manufacturers as string[]) || [];
                const models = (scope.modelNumbers as string[]) || [];
                const mats = (scope.materials as string[]) || [];
                const hasDetails = mfrs.length > 0 || models.length > 0 || mats.length > 0;
                const isExpanded = expandedScopes.has(scope.id);

                return (
                  <div
                    key={scope.id}
                    className={`rounded-lg border transition-colors`}
                    style={scope.isSelected ? { borderColor: "var(--border-gold)", background: "rgba(200,164,78,0.06)" } : undefined}
                    data-testid={`scope-row-${scope.id}`}
                  >
                    <div className="flex items-center gap-3 p-3">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => { if (guardViewer(isViewer, toast)) return; toggleScopeMutation.mutate({
                          scopeId: scope.id,
                          isSelected: !scope.isSelected,
                        }); }}
                        disabled={toggleScopeMutation.isPending || isViewer}
                        data-testid={`button-toggle-scope-${scope.id}`}
                      >
                        {scope.isSelected ? (
                          <ToggleRight className="w-6 h-6 text-green-500" />
                        ) : (
                          <ToggleLeft className="w-6 h-6 text-muted-foreground" />
                        )}
                      </Button>

                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => hasDetails && toggleExpanded(scope.id)}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-sm font-medium">{scope.specSectionNumber}</span>
                          <span className="text-sm">{scope.specSectionTitle || scope.scopeType}</span>
                          {hasDetails && (
                            <span className="text-muted-foreground">
                              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {mfrs.length > 0 && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Factory className="w-3 h-3" /> {mfrs.length} manufacturer{mfrs.length !== 1 ? "s" : ""}
                            </span>
                          )}
                          {models.length > 0 && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Hash className="w-3 h-3" /> {models.length} model{models.length !== 1 ? "s" : ""}
                            </span>
                          )}
                          {mats.length > 0 && (
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Layers className="w-3 h-3" /> {mats.length} material{mats.length !== 1 ? "s" : ""}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isExpanded && hasDetails && (
                      <div className="px-3 pb-3 pl-14 space-y-2 border-t pt-2">
                        {mfrs.length > 0 && (
                          <div>
                            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-1">
                              <Factory className="w-3 h-3" /> Manufacturers
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {mfrs.map((m, i) => (
                                <Badge key={i} variant="outline" className="text-xs font-normal">{m}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {models.length > 0 && (
                          <div>
                            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-1">
                              <Hash className="w-3 h-3" /> Model Numbers
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {models.map((m, i) => (
                                <Badge key={i} variant="secondary" className="text-xs font-mono">{m}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {mats.length > 0 && (
                          <div>
                            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1 mb-1">
                              <Layers className="w-3 h-3" /> Materials
                            </span>
                            <div className="flex flex-wrap gap-1">
                              {mats.map((m, i) => (
                                <Badge key={i} variant="outline" className="text-xs font-normal">{m}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {showSpecPassButton && (
                <div className="pt-4 border-t">
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div>
                      <p className="text-sm font-medium">
                        {selectedCount} scope{selectedCount !== 1 ? "s" : ""} selected
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Manufacturer names, model numbers, and materials from selected scopes will be used to boost Plan Parser accuracy.
                      </p>
                    </div>
                    <Button
                      onClick={() => { if (!guardViewer(isViewer, toast)) specPassMutation.mutate(); }}
                      disabled={specPassMutation.isPending || selectedCount === 0 || isViewer}
                      data-testid="button-run-spec-pass"
                    >
                      {specPassMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Play className="w-4 h-4 mr-2" />
                      )}
                      Run Spec-Informed Pass
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
