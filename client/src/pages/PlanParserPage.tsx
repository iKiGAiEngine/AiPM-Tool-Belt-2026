import { useState, useCallback } from "react";
import { BackNav } from "@/components/BackNav";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToolUsage } from "@/lib/useToolUsage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { 
  Upload, 
  FileText, 
  Trash2, 
  Download,
  Eye,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import type { PlanParserJob, ParsedPage } from "@shared/schema";
import { PLAN_PARSER_SCOPES } from "@shared/schema";

interface ParsedPageWithoutText extends Omit<ParsedPage, "ocrText"> {
  hasOcrText: boolean;
}

export default function PlanParserPage() {
  const { isAdmin } = useAuth();
  const [, navigate] = useLocation();
  useToolUsage("planparser");

  if (!isAdmin) {
    navigate("/home");
    return null;
  }
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);

  const { data: activeJob, refetch: refetchJob } = useQuery<PlanParserJob>({
    queryKey: ["/api/planparser/jobs", activeJobId],
    enabled: !!activeJobId,
    refetchInterval: (query) => {
      const job = query.state.data;
      if (job?.status === "processing") return 1000;
      return false;
    },
  });

  const { data: pages = [], isLoading: pagesLoading } = useQuery<ParsedPageWithoutText[]>({
    queryKey: ["/api/planparser/jobs", activeJobId, "pages"],
    enabled: !!activeJobId && activeJob?.status === "complete",
  });

  const createJobMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/planparser/jobs");
      return response.json() as Promise<PlanParserJob>;
    },
    onSuccess: (job) => {
      setActiveJobId(job.id);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create job",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const uploadWithProgress = async (jobId: string, files: File[]): Promise<void> => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      files.forEach(file => formData.append("files", file));
      
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(percent);
        }
      });
      
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          try {
            const error = JSON.parse(xhr.responseText);
            reject(new Error(error.message || "Upload failed"));
          } catch {
            reject(new Error("Upload failed"));
          }
        }
      });
      
      xhr.addEventListener("error", () => {
        reject(new Error("Network error during upload"));
      });
      
      xhr.open("POST", `/api/planparser/jobs/${jobId}/upload`);
      xhr.send(formData);
    });
  };

  const uploadMutation = useMutation({
    mutationFn: async ({ jobId, files }: { jobId: string; files: File[] }) => {
      setIsUploading(true);
      setUploadProgress(0);
      await uploadWithProgress(jobId, files);
    },
    onSuccess: () => {
      setSelectedFiles([]);
      setIsUploading(false);
      setUploadProgress(0);
      refetchJob();
    },
    onError: (error: Error) => {
      setIsUploading(false);
      setUploadProgress(0);
      toast({
        title: "Upload failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteJobMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await apiRequest("DELETE", `/api/planparser/jobs/${jobId}`);
    },
    onSuccess: () => {
      setActiveJobId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/planparser/jobs"] });
      toast({ title: "Job deleted" });
    },
  });

  const demoMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/planparser/demo");
      return response.json() as Promise<PlanParserJob>;
    },
    onSuccess: (job) => {
      setActiveJobId(job.id);
      toast({ title: "Demo loaded", description: "Showing sample classification results" });
    },
    onError: (error: Error) => {
      toast({
        title: "Demo failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    if (!activeJobId) return;
    
    setIsExporting(true);
    try {
      const response = await fetch(`/api/planparser/jobs/${activeJobId}/export`);
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Export failed");
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = response.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || "scope_exports.zip";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast({ title: "Export complete", description: "Scope PDFs downloaded" });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to generate export",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.type === "application/pdf"
    );
    
    if (files.length > 0) {
      setSelectedFiles(prev => [...prev, ...files]);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      setSelectedFiles(prev => [...prev, ...files]);
    }
  };

  const handleStartProcessing = async () => {
    if (selectedFiles.length === 0) return;
    
    try {
      const job = await createJobMutation.mutateAsync();
      uploadMutation.mutate({ jobId: job.id, files: selectedFiles });
    } catch (error) {
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pending":
        return <Clock className="h-5 w-5 text-muted-foreground" />;
      case "processing":
        return <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--gold)" }} />;
      case "complete":
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case "error":
        return <AlertTriangle className="h-5 w-5 text-destructive" />;
      default:
        return null;
    }
  };

  const relevantPages = pages.filter(p => p.isRelevant);
  const progressPercent = activeJob 
    ? activeJob.totalPages > 0 
      ? Math.round((activeJob.processedPages / activeJob.totalPages) * 100)
      : 0
    : 0;

  return (
    <div className="min-h-[calc(100vh-4rem)] animate-page-enter">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8">
        <div className="mb-4">
          <BackNav href="/" label="Home" testId="button-back-home" />
        </div>
        <div className="mx-auto max-w-3xl text-center mb-12">
          <h1 className="text-4xl font-heading font-semibold tracking-tight text-foreground sm:text-5xl" data-testid="text-tool-name">
            Plan Parser
          </h1>
          <p className="mt-2 text-xl text-muted-foreground sm:text-2xl" data-testid="text-page-title">
            Division 10 Page Classifier
          </p>
          <p className="mt-4 text-base text-muted-foreground">
            Upload construction plan PDFs to automatically identify and classify Division 10 specialty pages. 
            Excludes signage and filters by scope category.
          </p>
        </div>

        {!activeJobId || activeJob?.status === "complete" || activeJob?.status === "error" ? (
          <div className="space-y-6">
            <div
              className={`relative mx-auto max-w-xl border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer ${
                isDragging 
                  ? "" 
                  : "border-border hover:border-muted-foreground/50"
              }`}
              style={isDragging ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.06)" } : undefined}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => document.getElementById("file-input")?.click()}
              data-testid="upload-dropzone"
            >
              <input
                id="file-input"
                type="file"
                accept=".pdf,application/pdf"
                multiple
                onChange={handleFileSelect}
                className="hidden"
                data-testid="file-input"
              />
              <Upload className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-4 text-lg font-medium">
                Drag & drop PDF files here
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                or click to browse
              </p>
              <div className="flex gap-3 mt-4 justify-center">
                <Button
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    document.getElementById("file-input")?.click();
                  }}
                  data-testid="button-browse-files"
                >
                  Browse Files
                </Button>
                <Button
                  variant="secondary"
                  onClick={(e) => {
                    e.stopPropagation();
                    demoMutation.mutate();
                  }}
                  disabled={demoMutation.isPending}
                  data-testid="button-try-demo"
                >
                  {demoMutation.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    "Try Demo"
                  )}
                </Button>
              </div>
            </div>

            {selectedFiles.length > 0 && (
              <div className="mx-auto max-w-xl">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-heading">Selected Files ({selectedFiles.length})</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {selectedFiles.map((file, index) => (
                      <div 
                        key={index}
                        className="flex items-center justify-between p-2 bg-muted/50 rounded"
                      >
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm truncate max-w-[300px]">{file.name}</span>
                          <Badge variant="secondary" className="text-xs">
                            {(file.size / 1024 / 1024).toFixed(1)} MB
                          </Badge>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeFile(index)}
                          data-testid={`button-remove-file-${index}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      onClick={handleStartProcessing}
                      disabled={createJobMutation.isPending || uploadMutation.isPending}
                      className="w-full mt-4"
                      data-testid="button-start-processing"
                    >
                      {createJobMutation.isPending || uploadMutation.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          <Eye className="mr-2 h-4 w-4" />
                          Start Processing
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        ) : null}

        {isUploading && (
          <div className="mx-auto max-w-xl">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Upload className="h-5 w-5 animate-pulse" style={{ color: "var(--gold)" }} />
                  <CardTitle className="font-heading">Uploading Files</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span>Uploading {selectedFiles.length} file{selectedFiles.length > 1 ? "s" : ""} to server...</span>
                    <span className="font-heading font-bold" style={{ color: "var(--gold)" }}>{uploadProgress}%</span>
                  </div>
                  <Progress value={uploadProgress} className="h-3" data-testid="progress-upload" />
                </div>
                <div className="text-sm text-muted-foreground">
                  {uploadProgress < 100 
                    ? `${(selectedFiles.reduce((acc, f) => acc + f.size, 0) * uploadProgress / 100 / 1024 / 1024).toFixed(1)} MB of ${(selectedFiles.reduce((acc, f) => acc + f.size, 0) / 1024 / 1024).toFixed(1)} MB uploaded`
                    : "Upload complete, starting processing..."}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {activeJob && activeJob.status === "processing" && !isUploading && (
          <div className="mx-auto max-w-xl">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  {getStatusIcon(activeJob.status)}
                  <CardTitle className="font-heading">Processing PDFs</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="font-medium">
                      {activeJob.processedPages > 0 
                        ? `Analyzing page ${activeJob.processedPages} of ${activeJob.totalPages}...`
                        : "Extracting pages from PDF..."}
                    </span>
                    <span className="font-heading font-bold" style={{ color: "var(--gold)" }}>{progressPercent}%</span>
                  </div>
                  <Progress value={progressPercent} className="h-3" data-testid="progress-processing" />
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Pages processed:</span>
                    <span className="ml-2 font-heading font-bold" style={{ color: "var(--gold)" }}>
                      {activeJob.processedPages} / {activeJob.totalPages}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Flagged so far:</span>
                    <span className="ml-2 font-heading font-bold" style={{ color: "var(--gold)" }}>
                      {activeJob.flaggedPages}
                    </span>
                  </div>
                </div>
                {activeJob.filenames.length > 0 && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Files:</span>
                    <span className="ml-2">{activeJob.filenames.join(", ")}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeJob && activeJob.status === "complete" && (
          <div className="space-y-6">
            <div className="mx-auto max-w-4xl">
              <Card className="card-accent-bar">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {getStatusIcon(activeJob.status)}
                      <CardTitle className="font-heading">Results</CardTitle>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={handleExport}
                        disabled={isExporting || relevantPages.length === 0}
                        data-testid="button-export-pdfs"
                      >
                        {isExporting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Exporting...
                          </>
                        ) : (
                          <>
                            <Download className="mr-2 h-4 w-4" />
                            Export Scope PDFs
                          </>
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => deleteJobMutation.mutate(activeJob.id)}
                        disabled={deleteJobMutation.isPending}
                        data-testid="button-delete-job"
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Job
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setActiveJobId(null);
                          setSelectedFiles([]);
                        }}
                        data-testid="button-new-job"
                      >
                        New Job
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div className="text-center p-4 bg-muted/50 rounded-lg">
                      <div className="text-2xl font-heading font-bold" style={{ color: "var(--gold)" }}>{activeJob.totalPages}</div>
                      <div className="text-sm text-muted-foreground eyebrow">Total Pages</div>
                    </div>
                    <div className="text-center p-4 bg-green-500/10 rounded-lg">
                      <div className="text-2xl font-heading font-bold" style={{ color: "var(--gold)" }}>{activeJob.flaggedPages}</div>
                      <div className="text-sm text-muted-foreground eyebrow">Flagged</div>
                    </div>
                    <div className="text-center p-4 bg-muted/50 rounded-lg">
                      <div className="text-2xl font-heading font-bold" style={{ color: "var(--gold)" }}>{activeJob.filenames.length}</div>
                      <div className="text-sm text-muted-foreground eyebrow">Files</div>
                    </div>
                    <div className="text-center p-4 bg-muted/50 rounded-lg">
                      <div className="text-2xl font-heading font-bold" style={{ color: "var(--gold)" }}>
                        {Object.keys(activeJob.scopeCounts).filter(k => activeJob.scopeCounts[k] > 0).length}
                      </div>
                      <div className="text-sm text-muted-foreground eyebrow">Scopes Found</div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-heading font-medium mb-3 eyebrow">Pages by Scope</h3>
                    <div className="flex flex-wrap gap-2">
                      {PLAN_PARSER_SCOPES.map(scope => {
                        const count = activeJob.scopeCounts[scope] || 0;
                        if (count === 0) return null;
                        return (
                          <Badge key={scope} variant="secondary" className="text-sm">
                            {scope}: {count}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>

                  {pagesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      <span className="ml-2 text-muted-foreground">Loading results...</span>
                    </div>
                  ) : relevantPages.length > 0 ? (
                    <div>
                      <h3 className="text-sm font-heading font-medium mb-3 eyebrow">Flagged Pages ({relevantPages.length})</h3>
                      <div className="border rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/50">
                            <tr>
                              <th className="text-left p-3">File / Page</th>
                              <th className="text-left p-3">Tags</th>
                              <th className="text-left p-3">Confidence</th>
                              <th className="text-left p-3">Why Flagged</th>
                            </tr>
                          </thead>
                          <tbody>
                            {relevantPages.slice(0, 50).map((page) => (
                              <tr key={page.id} className="border-t">
                                <td className="p-3">
                                  <div className="font-medium">{page.originalFilename}</div>
                                  <div className="text-muted-foreground">Page {page.pageNumber}</div>
                                </td>
                                <td className="p-3">
                                  <div className="flex flex-wrap gap-1">
                                    {page.tags.map(tag => (
                                      <Badge key={tag} variant="outline" className="text-xs">
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                </td>
                                <td className="p-3">
                                  <Badge 
                                    variant={page.confidence >= 70 ? "default" : "secondary"}
                                    className="text-xs"
                                  >
                                    {page.confidence}%
                                  </Badge>
                                </td>
                                <td className="p-3 max-w-xs">
                                  <span className="text-muted-foreground text-xs line-clamp-2">
                                    {page.whyFlagged}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {relevantPages.length > 50 && (
                          <div className="p-3 text-center text-sm text-muted-foreground border-t">
                            Showing first 50 of {relevantPages.length} pages
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {activeJob && activeJob.status === "error" && (
          <div className="mx-auto max-w-xl">
            <Card className="border-destructive">
              <CardHeader>
                <div className="flex items-center gap-3">
                  {getStatusIcon(activeJob.status)}
                  <CardTitle className="font-heading text-destructive">Processing Failed</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-muted-foreground">{activeJob.message}</p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setActiveJobId(null);
                    setSelectedFiles([]);
                  }}
                  data-testid="button-try-again"
                >
                  Try Again
                </Button>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
