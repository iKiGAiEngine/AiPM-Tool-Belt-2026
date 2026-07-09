import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { UPLOAD_CHUNK_BYTES } from "@shared/uploadLimits";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  ArrowLeft, Building2, ExternalLink, UploadCloud, FileText, Layers,
  Play, Download, CheckCircle2, AlertTriangle, Loader2, Sparkles, Eye, EyeOff,
} from "lucide-react";

interface EstimatingProject {
  id: number;
  projectName: string;
  estimateNumber: string;
}

interface RunContext {
  entry: {
    id: number;
    projectName: string;
    estimateNumber: string | null;
    estimateStatus: string | null;
    region: string | null;
    dueDate: string | null;
    scopeList: string[];
  };
  buildingConnected: { opportunityId: string; filesUrl: string } | null;
  project: { id: number; folderPath: string | null; folderExists: boolean } | null;
  availableScopes: Array<{ name: string; preChecked: boolean }>;
}

interface RunFile {
  id: number;
  filename: string;
  sizeBytes: number;
  pageCount: number;
  classification: "plan" | "spec" | "other";
  classificationConfidence: number;
  classificationReason: string;
  userClassification: "plan" | "spec" | "other" | null;
  selected: boolean;
}

interface RunState {
  id: string;
  status: string;
  message: string;
  error: string | null;
  selectedScopes: string[];
  harvestedCallouts: Record<string, string[]>;
  scopeCoverageWarnings: string[];
  planparserJobId: string | null;
  files: RunFile[];
  planParserJob: {
    id: string;
    status: string;
    totalPages: number;
    processedPages: number;
    flaggedPages: number;
    scopeCounts: Record<string, number>;
    message: string;
  } | null;
}

interface ReviewPage {
  id: string;
  originalFilename: string;
  pageNumber: number;
  isRelevant: boolean;
  tags: string[];
  confidence: number;
  whyFlagged: string;
  matchType?: string;
  thumbnailPath?: string;
}

const PROCESSING_STATUSES = ["processing_plans", "processing_specs", "spec_pass", "callout_pass", "generating_report"];

function classBadge(cls: string) {
  switch (cls) {
    case "plan": return <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/30">Plan</Badge>;
    case "spec": return <Badge className="bg-blue-500/15 text-blue-400 border-blue-500/30">Spec</Badge>;
    default: return <Badge variant="secondary">Other</Badge>;
  }
}

function formatBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export default function BidDocsIntakePage() {
  const { toast } = useToast();
  const [selectedEntry, setSelectedEntry] = useState<EstimatingProject | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [checkedScopes, setCheckedScopes] = useState<Set<string>>(new Set());
  const [scopesInitialized, setScopesInitialized] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [includeHighlights, setIncludeHighlights] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Step 1: project picker -------------------------------------------
  const { data: projects = [] } = useQuery<EstimatingProject[]>({
    queryKey: ["/api/proposal-log/estimating-projects"],
  });

  const { data: context } = useQuery<RunContext>({
    queryKey: [`/api/bid-docs/context/${selectedEntry?.id}`],
    enabled: !!selectedEntry,
  });

  useEffect(() => {
    if (context && !scopesInitialized) {
      setCheckedScopes(new Set(context.availableScopes.filter(s => s.preChecked).map(s => s.name)));
      setScopesInitialized(true);
    }
  }, [context, scopesInitialized]);

  // ---- Run state (poll while processing) --------------------------------
  const { data: run } = useQuery<RunState>({
    queryKey: [`/api/bid-docs/runs/${runId}`],
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && PROCESSING_STATUSES.includes(status) ? 2500 : false;
    },
  });

  const isProcessing = !!run && PROCESSING_STATUSES.includes(run.status);

  // ---- Review pages ------------------------------------------------------
  const { data: reviewPages = [] } = useQuery<ReviewPage[]>({
    queryKey: [`/api/planparser/jobs/${run?.planparserJobId}/pages`],
    enabled: !!run?.planparserJobId && (run.status === "review" || run.status === "complete"),
  });

  // ---- Mutations ----------------------------------------------------------
  const createRun = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bid-docs/runs", {
        proposalLogEntryId: selectedEntry?.id,
      });
      return res.json();
    },
    onSuccess: (data) => setRunId(data.id),
    onError: (err: Error) => toast({ title: "Could not create run", description: err.message, variant: "destructive" }),
  });

  const patchFile = useMutation({
    mutationFn: async ({ fileId, data }: { fileId: number; data: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/bid-docs/files/${fileId}`, data);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/bid-docs/runs/${runId}`] }),
  });

  const startRun = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/bid-docs/runs/${runId}/start`, {
        selectedScopes: Array.from(checkedScopes),
      });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/bid-docs/runs/${runId}`] }),
    onError: (err: Error) => toast({ title: "Could not start", description: err.message, variant: "destructive" }),
  });

  const patchPage = useMutation({
    mutationFn: async ({ pageId, isRelevant }: { pageId: string; isRelevant: boolean }) => {
      const res = await apiRequest("PATCH", `/api/bid-docs/pages/${pageId}`, { isRelevant });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/planparser/jobs/${run?.planparserJobId}/pages`] });
      queryClient.invalidateQueries({ queryKey: [`/api/bid-docs/runs/${runId}`] });
    },
  });

  const finalizeRun = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/bid-docs/runs/${runId}/finalize`, { includeHighlights });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Finalizing", description: "Building scope PDFs and the Scope Short Order report..." });
      queryClient.invalidateQueries({ queryKey: [`/api/bid-docs/runs/${runId}`] });
    },
    onError: (err: Error) => toast({ title: "Could not finalize", description: err.message, variant: "destructive" }),
  });

  // ---- Upload (direct for small files, chunked for big ones) --------------
  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    if (!runId) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const all = Array.from(files);
      const small = all.filter(f => f.size <= UPLOAD_CHUNK_BYTES);
      const large = all.filter(f => f.size > UPLOAD_CHUNK_BYTES);
      let done = 0;
      const total = all.length;

      if (small.length > 0) {
        const form = new FormData();
        small.forEach(f => form.append("files", f));
        const res = await fetch(`/api/bid-docs/runs/${runId}/upload`, {
          method: "POST",
          body: form,
          credentials: "include",
        });
        if (!res.ok) throw new Error((await res.text()) || "Upload failed");
        done += small.length;
        setUploadProgress(Math.round((done / total) * 100));
      }

      for (const file of large) {
        const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);
        const initRes = await apiRequest("POST", `/api/bid-docs/runs/${runId}/upload/init`, {
          filename: file.name,
          totalChunks,
          totalSize: file.size,
        });
        const { uploadId } = await initRes.json();

        for (let i = 0; i < totalChunks; i++) {
          const chunk = file.slice(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES);
          const form = new FormData();
          form.append("uploadId", uploadId);
          form.append("chunkIndex", String(i));
          form.append("chunk", chunk, `${file.name}.part${i}`);
          const res = await fetch("/api/bid-docs/upload/chunk", {
            method: "POST",
            body: form,
            credentials: "include",
          });
          if (!res.ok) throw new Error(`Chunk ${i + 1}/${totalChunks} failed`);
          setUploadProgress(Math.round(((done + (i + 1) / totalChunks) / total) * 100));
        }

        const completeRes = await apiRequest("POST", "/api/bid-docs/upload/complete", { uploadId });
        await completeRes.json();
        done++;
        setUploadProgress(Math.round((done / total) * 100));
      }

      queryClient.invalidateQueries({ queryKey: [`/api/bid-docs/runs/${runId}`] });
      toast({ title: "Files inventoried", description: "Review what was found and pick what to process." });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }, [runId, toast]);

  // ---- Derived -------------------------------------------------------------
  const filteredProjects = projects.filter(p =>
    !projectFilter.trim() ||
    p.projectName.toLowerCase().includes(projectFilter.toLowerCase()) ||
    (p.estimateNumber || "").toLowerCase().includes(projectFilter.toLowerCase()),
  );

  const selectedPlanCount = run?.files.filter(f => f.selected && (f.userClassification || f.classification) === "plan").length ?? 0;
  const selectedSpecCount = run?.files.filter(f => f.selected && (f.userClassification || f.classification) === "spec").length ?? 0;
  const flaggedPages = reviewPages.filter(p => p.isRelevant);

  // =========================================================================
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon" data-testid="button-back-home">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold font-heading">Bid Docs Intake</h1>
            <p className="text-muted-foreground text-sm">
              BuildingConnected files → identified plans & specs → per-scope highlighted plan sets + Scope Short Order report
            </p>
          </div>
        </div>

        {/* ── Step 1: Pick an Estimating project ─────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Building2 className="h-5 w-5 text-primary" /> 1 · Select an Estimating project
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!selectedEntry ? (
              <>
                <input
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="Search projects in Estimating status..."
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  data-testid="input-project-search"
                />
                <div className="max-h-56 overflow-auto rounded-md border divide-y">
                  {filteredProjects.map(p => (
                    <button
                      key={p.id}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-accent/50 transition-colors"
                      onClick={() => setSelectedEntry(p)}
                      data-testid={`option-project-${p.id}`}
                    >
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{p.projectName}</span>
                      <span className="text-xs text-muted-foreground font-mono">{p.estimateNumber}</span>
                    </button>
                  ))}
                  {filteredProjects.length === 0 && (
                    <div className="px-3 py-4 text-sm text-muted-foreground">No Estimating projects match.</div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="outline" className="text-sm py-1 px-3">
                  {selectedEntry.projectName}
                  {selectedEntry.estimateNumber ? ` · ${selectedEntry.estimateNumber}` : ""}
                </Badge>
                {context?.project?.folderExists ? (
                  <Badge className="bg-emerald-500/15 text-emerald-500 border-emerald-500/30">Project folder linked</Badge>
                ) : (
                  <Badge variant="secondary">No project folder — outputs stay downloadable</Badge>
                )}
                {context?.buildingConnected && (
                  <a href={context.buildingConnected.filesUrl} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" data-testid="button-open-bc">
                      Open BuildingConnected files <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                    </Button>
                  </a>
                )}
                {!runId && (
                  <Button size="sm" onClick={() => createRun.mutate()} disabled={createRun.isPending} data-testid="button-start-run">
                    {createRun.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                    Start intake
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setSelectedEntry(null); setRunId(null); setScopesInitialized(false); }}
                >
                  Change project
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Step 2: Files in ────────────────────────────────────────── */}
        {runId && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <UploadCloud className="h-5 w-5 text-primary" /> 2 · Drop the BuildingConnected file set
              </CardTitle>
              <CardDescription>
                Download the files from BuildingConnected (link above), then drop the ZIP — or individual PDFs — here.
                Large files upload in chunks automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/60 transition-colors"
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
                }}
                data-testid="dropzone-files"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.zip"
                  className="hidden"
                  onChange={(e) => e.target.files && uploadFiles(e.target.files)}
                />
                <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm">Drop the BC ZIP or PDFs here, or click to browse</p>
              </div>
              {uploading && (
                <div className="space-y-1">
                  <Progress value={uploadProgress} />
                  <p className="text-xs text-muted-foreground">Uploading… {uploadProgress}%</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Inventory / findings ────────────────────────────── */}
        {run && run.files.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileText className="h-5 w-5 text-primary" /> 3 · Findings — confirm the project plans
              </CardTitle>
              <CardDescription>
                Auto-identified architectural plans are pre-checked. Re-badge anything that was guessed wrong; checked files get processed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-2 pr-2 w-10">Use</th>
                      <th className="py-2 pr-2">File</th>
                      <th className="py-2 pr-2 w-20">Pages</th>
                      <th className="py-2 pr-2 w-20">Size</th>
                      <th className="py-2 pr-2 w-24">Type</th>
                      <th className="py-2">Why</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {run.files.map(f => {
                      const cls = f.userClassification || f.classification;
                      return (
                        <tr key={f.id} data-testid={`row-file-${f.id}`}>
                          <td className="py-2 pr-2">
                            <Checkbox
                              checked={f.selected}
                              disabled={isProcessing}
                              onCheckedChange={(v) => patchFile.mutate({ fileId: f.id, data: { selected: v === true } })}
                              data-testid={`checkbox-file-${f.id}`}
                            />
                          </td>
                          <td className="py-2 pr-2 max-w-[280px] truncate" title={f.filename}>{f.filename}</td>
                          <td className="py-2 pr-2">{f.pageCount || "—"}</td>
                          <td className="py-2 pr-2">{formatBytes(f.sizeBytes)}</td>
                          <td className="py-2 pr-2">
                            <button
                              className="cursor-pointer"
                              disabled={isProcessing}
                              title="Click to cycle Plan → Spec → Other"
                              onClick={() => {
                                const next = cls === "plan" ? "spec" : cls === "spec" ? "other" : "plan";
                                patchFile.mutate({ fileId: f.id, data: { userClassification: next } });
                              }}
                              data-testid={`badge-class-${f.id}`}
                            >
                              {classBadge(cls)}
                            </button>
                          </td>
                          <td className="py-2 text-xs text-muted-foreground max-w-[300px] truncate" title={f.classificationReason}>
                            {f.classificationConfidence}% · {f.classificationReason}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Step 4: Scopes + run ────────────────────────────────────── */}
        {run && run.files.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Layers className="h-5 w-5 text-primary" /> 4 · Scopes to pick up
              </CardTitle>
              <CardDescription>
                The project's needed scopes are pre-checked. Every page matching these scopes' keywords — or schedule callouts like WP-1 — gets pulled into that scope's plan file.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {(context?.availableScopes || []).map(s => (
                  <label
                    key={s.name}
                    className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm cursor-pointer transition-colors ${checkedScopes.has(s.name) ? "border-primary bg-primary/10" : "hover:bg-accent/50"}`}
                  >
                    <Checkbox
                      checked={checkedScopes.has(s.name)}
                      disabled={isProcessing}
                      onCheckedChange={(v) => {
                        setCheckedScopes(prev => {
                          const next = new Set(prev);
                          if (v === true) next.add(s.name); else next.delete(s.name);
                          return next;
                        });
                      }}
                      data-testid={`checkbox-scope-${s.name.replace(/\s+/g, "-")}`}
                    />
                    {s.name}
                  </label>
                ))}
              </div>

              {run.scopeCoverageWarnings && run.scopeCoverageWarnings.length > 0 && (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500"
                  data-testid="banner-scope-coverage-warning"
                >
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    <strong>{run.scopeCoverageWarnings.join(", ")}</strong> — no keywords are configured for{" "}
                    {run.scopeCoverageWarnings.length === 1 ? "this scope" : "these scopes"} in Central Settings, so no
                    pages can match. Open <span className="underline">Central Settings → Scope Dictionaries</span> and
                    click "Seed Defaults" or add keywords, then re-run.
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => startRun.mutate()}
                  disabled={isProcessing || startRun.isPending || selectedPlanCount === 0}
                  data-testid="button-start-processing"
                >
                  {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
                  {isProcessing ? "Processing…" : `Process ${selectedPlanCount} plan file(s)${selectedSpecCount > 0 ? ` + ${selectedSpecCount} spec(s)` : ""}`}
                </Button>
                {run.status === "error" && (
                  <span className="flex items-center gap-1.5 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4" /> {run.error || run.message}
                  </span>
                )}
              </div>

              {(isProcessing || run.planParserJob) && (
                <div className="space-y-2">
                  {run.planParserJob && run.planParserJob.totalPages > 0 && (
                    <Progress value={(run.planParserJob.processedPages / run.planParserJob.totalPages) * 100} />
                  )}
                  <p className="text-sm text-muted-foreground flex items-center gap-2">
                    {isProcessing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {run.message}
                    {run.planParserJob && run.planParserJob.flaggedPages > 0 && (
                      <Badge variant="outline">{run.planParserJob.flaggedPages} pages flagged</Badge>
                    )}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Step 5: Review + finalize ───────────────────────────────── */}
        {run && (run.status === "review" || run.status === "generating_report" || run.status === "complete") && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="h-5 w-5 text-primary" /> 5 · Review & finalize
              </CardTitle>
              <CardDescription>
                Every flagged page shows why it's in (keywords or schedule callouts get highlighted in the output PDFs). Uncheck what doesn't belong — corrections teach the parser.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {Object.keys(run.harvestedCallouts || {}).length > 0 && (
                <div className="rounded-md border bg-accent/30 p-3 text-sm space-y-1">
                  <p className="font-medium">Schedule callouts harvested:</p>
                  {Object.entries(run.harvestedCallouts).map(([scope, marks]) => (
                    <p key={scope} className="text-muted-foreground">
                      <span className="text-foreground">{scope}:</span> {marks.join(", ")}
                    </p>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-[520px] overflow-auto pr-1">
                {flaggedPages.map(p => (
                  <div key={p.id} className="rounded-md border p-3 space-y-1.5" data-testid={`card-page-${p.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate" title={p.originalFilename}>
                        p.{p.pageNumber} · {p.originalFilename}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => patchPage.mutate({ pageId: p.id, isRelevant: false })}
                        data-testid={`button-remove-page-${p.id}`}
                      >
                        <EyeOff className="h-3.5 w-3.5 mr-1" /> Remove
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {p.tags.map(t => <Badge key={t} variant="outline" className="text-xs">{t}</Badge>)}
                      {p.matchType === "callout" && <Badge className="bg-purple-500/15 text-purple-400 border-purple-500/30 text-xs">Callout</Badge>}
                      {p.matchType === "both" && <Badge className="bg-purple-500/15 text-purple-400 border-purple-500/30 text-xs">KW + Callout</Badge>}
                      <Badge variant="secondary" className="text-xs">{p.confidence}%</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-3" title={p.whyFlagged}>{p.whyFlagged}</p>
                  </div>
                ))}
                {flaggedPages.length === 0 && (
                  <p className="text-sm text-muted-foreground col-span-full">No pages flagged. Loosen the scope selection or check the plans classification.</p>
                )}
              </div>

              {reviewPages.filter(p => !p.isRelevant).length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    Not flagged ({reviewPages.filter(p => !p.isRelevant).length} pages) — add any the parser missed
                  </summary>
                  <div className="mt-2 max-h-48 overflow-auto divide-y rounded-md border">
                    {reviewPages.filter(p => !p.isRelevant).map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="text-xs truncate">p.{p.pageNumber} · {p.originalFilename}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() => patchPage.mutate({ pageId: p.id, isRelevant: true })}
                          data-testid={`button-add-page-${p.id}`}
                        >
                          <Eye className="h-3 w-3 mr-1" /> Include
                        </Button>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              <div className="flex flex-wrap items-center gap-4 pt-2 border-t">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={includeHighlights} onCheckedChange={setIncludeHighlights} data-testid="switch-highlights" />
                  Highlight matched terms on output pages
                </label>
                <Button
                  onClick={() => finalizeRun.mutate()}
                  disabled={finalizeRun.isPending || run.status === "generating_report" || flaggedPages.length === 0}
                  data-testid="button-finalize"
                >
                  {run.status === "generating_report"
                    ? <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Building outputs…</>
                    : <><CheckCircle2 className="h-4 w-4 mr-1.5" /> Finalize: scope PDFs + Short Order report</>}
                </Button>
                {run.status === "complete" && (
                  <a href={`/api/bid-docs/runs/${run.id}/download`}>
                    <Button variant="outline" data-testid="button-download">
                      <Download className="h-4 w-4 mr-1.5" /> Download outputs
                    </Button>
                  </a>
                )}
                {run.status === "complete" && context?.project?.folderExists && (
                  <span className="text-sm text-muted-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Saved into the project folder
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
