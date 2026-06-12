import { useState, useCallback, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Upload, FileText, Loader2, CheckCircle, AlertCircle, FolderOpen, CalendarIcon, X, Download, ExternalLink, ImageIcon, Camera, GitMerge, AlertTriangle } from "lucide-react";
import { BackNav } from "@/components/BackNav";
import { format } from "date-fns";
import { useTestMode } from "@/lib/testMode";
import { useToolUsage } from "@/lib/useToolUsage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { Region, Project } from "@shared/schema";

type UploadState = {
  file: File | null;
  isDragging: boolean;
};

type CreationPhase =
  | "idle"
  | "uploading"
  | "creating"
  | "specsift_running"
  | "planparser_running"
  | "complete"
  | "error";

interface ProgressData {
  projectId: number;
  projectStatus: string;
  specsift: { status: string; progress: number; message: string } | null;
  planparser: { status: string; totalPages: number; processedPages: number; message: string } | null;
  hasSpecs?: boolean;
  hasPlans?: boolean;
  specExtractorUrl?: string | null;
}

interface CreatedProjectResponse extends Project {
  hasPlans?: boolean;
  hasSpecs?: boolean;
}

interface DuplicateMatch {
  id: number;
  projectName: string;
  estimateNumber: string | null;
  region: string | null;
  gcEstimateLead: string | null;
  estimateStatus: string | null;
  proposalTotal: string | null;
  createdAt: string;
  score: number;
}

export default function ProjectStartPage() {
  useToolUsage("projectstart");
  const { toast } = useToast();
  const { isViewer } = useAuth();
  const [, navigate] = useLocation();
  const { isTestMode } = useTestMode();
  const [projectName, setProjectName] = useState("");
  const [regionCode, setRegionCode] = useState("");
  const [selectedRegionId, setSelectedRegionId] = useState("");
  const [dueDate, setDueDate] = useState<Date | undefined>(undefined);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [yearCheckOpen, setYearCheckOpen] = useState(false);
  const [pendingDate, setPendingDate] = useState<Date | undefined>(undefined);
  const [plans, setPlans] = useState<UploadState>({ file: null, isDragging: false });
  const [specs, setSpecs] = useState<UploadState>({ file: null, isDragging: false });

  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionResult, setExtractionResult] = useState<{
    projectName: string | null;
    dueDate: string | null;
    location: string | null;
    tradeName: string | null;
    matchedRegionCode: string | null;
    matchedRegionLabel: string | null;
    inviteDate: string | null;
    expectedStart: string | null;
    expectedFinish: string | null;
    clientName: string | null;
    clientLocation: string | null;
    gcContactName: string | null;
    gcContactEmail: string | null;
    primaryMarket: string | null;
    bcLink: string | null;
    rawText: string | null;
  } | null>(null);
  const [screenshotDragging, setScreenshotDragging] = useState(false);
  const screenshotInputRef = useRef<HTMLInputElement>(null);

  const [primaryMarket, setPrimaryMarket] = useState("");
  const [inviteDate, setInviteDate] = useState("");
  const [anticipatedStart, setAnticipatedStart] = useState("");
  const [anticipatedFinish, setAnticipatedFinish] = useState("");
  const [bcLink, setBcLink] = useState("");
  const [estimateStatus, setEstimateStatus] = useState("Estimating");
  const [regionNotConfident, setRegionNotConfident] = useState(false);

  const [phase, setPhase] = useState<CreationPhase>("idle");
  const [uploadPercent, setUploadPercent] = useState(0);
  const [createdProject, setCreatedProject] = useState<CreatedProjectResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const pollingStartTime = useRef<number>(0);
  const [progressData, setProgressData] = useState<ProgressData | null>(null);

  const [dupModal, setDupModal] = useState<{ open: boolean; matches: DuplicateMatch[] }>({ open: false, matches: [] });
  const [dupCheckLoading, setDupCheckLoading] = useState(false);

  const hasPlans = createdProject?.hasPlans ?? !!plans.file;
  const hasSpecs = createdProject?.hasSpecs ?? !!specs.file;
  const hasFiles = hasPlans || hasSpecs;

  const { data: regions = [] } = useQuery<Region[]>({
    queryKey: ["/api/regions"],
  });

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      if (xhrRef.current) {
        xhrRef.current.abort();
        xhrRef.current = null;
      }
    };
  }, []);

  const handleScreenshotFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Only image files are accepted", variant: "destructive" });
      return;
    }

    setScreenshotFile(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      setScreenshotPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    setIsExtracting(true);
    setExtractionResult(null);

    try {
      const formData = new FormData();
      formData.append("screenshot", file);

      const res = await fetch("/api/extract-project-details", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        const msg = errorData?.message || "Server error during extraction";
        console.error("[ProjectStart] Screenshot extraction failed:", res.status, msg);
        throw new Error(msg);
      }

      const data = await res.json();
      setExtractionResult(data);

      if (data.projectName && !projectName) {
        setProjectName(data.projectName);
      }
      if (data.dueDate && !dueDate) {
        const [year, month, day] = data.dueDate.split("-").map(Number);
        setDueDate(new Date(year, month - 1, day));
      }
      if (data.matchedRegionCode && !regionCode) {
        setRegionCode(data.matchedRegionCode);
        // Use the full label (e.g. "LAX - TM") to select the exact sub-region, not just the first
        // region with a matching code (which could be SPD, OCLA, etc.)
        let matched = null;
        if (data.matchedRegionLabel) {
          const parts = data.matchedRegionLabel.split(" - ");
          const labelCode = parts[0]?.trim();
          const labelName = parts.slice(1).join(" - ").trim() || null;
          matched = regions.find((r) =>
            r.code === labelCode && (labelName ? r.name === labelName : !r.name)
          ) ?? regions.find((r) => r.code === data.matchedRegionCode) ?? null;
        } else {
          matched = regions.find((r) => r.code === data.matchedRegionCode) ?? null;
        }
        if (matched) setSelectedRegionId(String(matched.id));
        setRegionNotConfident(false);
      } else if (!data.matchedRegionCode && !regionCode) {
        setRegionNotConfident(true);
      }

      if (data.primaryMarket && !primaryMarket) {
        setPrimaryMarket(data.primaryMarket);
      }
      if (data.inviteDate && !inviteDate) {
        setInviteDate(data.inviteDate);
      }
      if (data.expectedStart && !anticipatedStart) {
        setAnticipatedStart(data.expectedStart);
      }
      if (data.expectedFinish && !anticipatedFinish) {
        setAnticipatedFinish(data.expectedFinish);
      }
      if (data.bcLink && !bcLink) {
        setBcLink(data.bcLink);
      }

      if (data.extractionFailed) {
        toast({
          title: "Extraction had trouble reading this screenshot",
          description: "Some fields may be missing. Please review and fill in details manually.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Details extracted from screenshot",
          description: data.projectName
            ? `Found: ${data.projectName}`
            : "Some fields were extracted. Please review and fill in any missing details.",
        });
      }
    } catch (err: any) {
      console.error("[ProjectStart] Screenshot extraction error:", err);
      toast({
        title: "Could not extract details",
        description: err.message || "Processing failed. Please fill in the fields manually.",
        variant: "destructive",
      });
    } finally {
      setIsExtracting(false);
    }
  }, [projectName, dueDate, regionCode, primaryMarket, inviteDate, anticipatedStart, anticipatedFinish, bcLink, toast, regions]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            handleScreenshotFile(file);
          }
          return;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handleScreenshotFile]);

  const clearScreenshot = useCallback(() => {
    setScreenshotPreview(null);
    setScreenshotFile(null);
    setExtractionResult(null);
    if (screenshotInputRef.current) {
      screenshotInputRef.current.value = "";
    }
  }, []);

  const handleClickPaste = useCallback(async () => {
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find(t => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const file = new File([blob], "pasted-screenshot.png", { type: imageType });
          handleScreenshotFile(file);
          return;
        }
      }
      toast({ title: "No image found in clipboard", description: "Copy a screenshot first, then click here to paste it.", variant: "destructive" });
    } catch {
      toast({ title: "Could not read clipboard", description: "Use Ctrl+V to paste, or browse for a file instead.", variant: "destructive" });
    }
  }, [handleScreenshotFile, toast]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startProgressPolling = useCallback((projectId: number) => {
    stopPolling();
    pollingStartTime.current = Date.now();
    const MAX_POLL_MS = 30 * 60 * 1000;

    pollingRef.current = setInterval(async () => {
      if (Date.now() - pollingStartTime.current > MAX_POLL_MS) {
        stopPolling();
        setPhase("error");
        setErrorMessage("Processing is taking longer than expected. Check the project detail page for status.");
        return;
      }

      try {
        const res = await fetch(`/api/projects/${projectId}/progress`);
        if (!res.ok) return;
        const data: ProgressData = await res.json();
        setProgressData(data);

        const status = data.projectStatus;
        if (!status) return;

        if (status === "folder_only") {
          setPhase("complete");
          stopPolling();
        } else if (status === "created" || status === "plans_uploaded" || status === "specs_uploaded") {
          setPhase("creating");
        } else if (status === "specsift_running") {
          setPhase("specsift_running");
        } else if (status === "specsift_complete") {
          if (data.hasPlans) {
            setPhase("planparser_running");
          } else {
            setPhase("complete");
            stopPolling();
          }
        } else if (status === "planparser_baseline_running") {
          setPhase("planparser_running");
        } else if (
          status === "planparser_baseline_complete" ||
          status === "outputs_ready" ||
          status === "planparser_specpass_complete" ||
          status === "scopes_selected"
        ) {
          setPhase("complete");
          stopPolling();
        } else if (status.includes("error")) {
          setPhase("error");
          const stageName = status.replace(/_/g, " ").replace("error", "").trim();
          setErrorMessage(`Processing failed during ${stageName}. You can view the project for details.`);
          stopPolling();
        }
      } catch {}
    }, 2000);
  }, [stopPolling]);

  const handleSubmit = useCallback((opts?: { mergeIntoProposalLogId?: number; duplicateOverrideNote?: string }) => {
    if (guardViewer(isViewer, toast)) return;
    if (!projectName || !regionCode || !dueDate) return;

    const formData = new FormData();
    formData.append("projectName", projectName);
    formData.append("regionCode", regionCode);
    formData.append("dueDate", format(dueDate, "yyyy-MM-dd"));
    if (plans.file) {
      formData.append("plans", plans.file);
    }
    if (specs.file) {
      formData.append("specs", specs.file);
    }
    if (isTestMode) {
      formData.append("isTest", "true");
    }

    if (primaryMarket) formData.append("primaryMarket", primaryMarket);
    if (inviteDate) formData.append("inviteDate", inviteDate);
    if (anticipatedStart) formData.append("anticipatedStart", anticipatedStart);
    if (anticipatedFinish) formData.append("anticipatedFinish", anticipatedFinish);
    if (estimateStatus) formData.append("estimateStatus", estimateStatus);
    if (bcLink) formData.append("bcLink", bcLink);

    if (opts?.mergeIntoProposalLogId) formData.append("mergeIntoProposalLogId", String(opts.mergeIntoProposalLogId));
    if (opts?.duplicateOverrideNote) formData.append("duplicateOverrideNote", opts.duplicateOverrideNote);

    if (screenshotFile) {
      formData.append("screenshot", screenshotFile);
    }

    if (extractionResult?.location) {
      formData.append("screenshotLocation", extractionResult.location);
    }
    if (extractionResult?.rawText) {
      formData.append("screenshotRawText", extractionResult.rawText);
    }
    if (extractionResult?.matchedRegionLabel) {
      formData.append("screenshotRegionLabel", extractionResult.matchedRegionLabel);
    }

    const isFolderOnly = !plans.file && !specs.file;

    setPhase(isFolderOnly ? "creating" : "uploading");
    setUploadPercent(0);
    setErrorMessage("");
    setProgressData(null);

    if (xhrRef.current) {
      xhrRef.current.abort();
    }

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/projects");

    if (!isFolderOnly) {
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setUploadPercent(pct);
          if (pct >= 100) {
            setPhase("creating");
          }
        }
      });
    }

    xhr.addEventListener("load", () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const project: CreatedProjectResponse = JSON.parse(xhr.responseText);
          setCreatedProject(project);
          queryClient.invalidateQueries({ queryKey: ["/api/projects"] });

          if (isFolderOnly) {
            setPhase("complete");
          } else {
            setPhase("creating");
            startProgressPolling(project.id);
          }
        } catch {
          setPhase("error");
          setErrorMessage("Unexpected response from server");
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText);
          setPhase("error");
          setErrorMessage(err.message || "Failed to create project");
        } catch {
          setPhase("error");
          setErrorMessage("Failed to create project");
        }
      }
    });

    xhr.addEventListener("error", () => {
      xhrRef.current = null;
      setPhase("error");
      setErrorMessage("Network error — check your connection and try again");
    });

    xhr.addEventListener("timeout", () => {
      xhrRef.current = null;
      setPhase("error");
      setErrorMessage("Upload timed out — the files may be too large for the connection speed");
    });

    xhr.timeout = 600000;
    xhr.send(formData);
  }, [projectName, regionCode, dueDate, plans.file, specs.file, isTestMode, startProgressPolling, screenshotPreview, extractionResult, primaryMarket, inviteDate, anticipatedStart, anticipatedFinish, estimateStatus, bcLink]);

  const checkDuplicatesThenSubmit = useCallback(async () => {
    if (!projectName || !regionCode || !dueDate) return;
    setDupCheckLoading(true);
    try {
      const res = await fetch("/api/bc-sync-table/check-duplicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ projectName }),
      });
      if (res.ok) {
        const json = await res.json();
        const matches: DuplicateMatch[] = json.matches || [];
        if (matches.length > 0) {
          setDupModal({ open: true, matches });
          setDupCheckLoading(false);
          return;
        }
      }
    } catch {
      // fail open — proceed with submission
    }
    setDupCheckLoading(false);
    handleSubmit();
  }, [projectName, regionCode, dueDate, handleSubmit]);

  const handleGoToProject = () => {
    if (createdProject) {
      navigate(`/projects/${createdProject.id}`);
    }
  };

  const handleRetry = () => {
    stopPolling();
    if (xhrRef.current) {
      xhrRef.current.abort();
      xhrRef.current = null;
    }
    setPhase("idle");
    setUploadPercent(0);
    setCreatedProject(null);
    setErrorMessage("");
    setProgressData(null);
  };

  const handleDateSelect = useCallback((selectedDate: Date | undefined) => {
    if (!selectedDate) return;

    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const selectedYear = selectedDate.getFullYear();

    if (currentMonth === 10 && selectedYear === currentYear) {
      setPendingDate(selectedDate);
      setYearCheckOpen(true);
    } else {
      setDueDate(selectedDate);
      setCalendarOpen(false);
    }
  }, []);

  const handleYearCheckConfirm = useCallback(() => {
    if (pendingDate) {
      setDueDate(pendingDate);
      setPendingDate(undefined);
    }
    setYearCheckOpen(false);
    setCalendarOpen(false);
  }, [pendingDate]);

  const handleYearCheckNextYear = useCallback(() => {
    if (pendingDate) {
      const nextYearDate = new Date(pendingDate);
      nextYearDate.setFullYear(nextYearDate.getFullYear() + 1);
      setDueDate(nextYearDate);
      setPendingDate(undefined);
    }
    setYearCheckOpen(false);
    setCalendarOpen(false);
  }, [pendingDate]);

  const createDropHandlers = useCallback(
    (setter: React.Dispatch<React.SetStateAction<UploadState>>) => ({
      onDragOver: (e: React.DragEvent) => {
        e.preventDefault();
        setter((prev) => ({ ...prev, isDragging: true }));
      },
      onDragLeave: (e: React.DragEvent) => {
        e.preventDefault();
        setter((prev) => ({ ...prev, isDragging: false }));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.type === "application/pdf") {
          setter({ file, isDragging: false });
        } else {
          toast({ title: "Only PDF files are accepted", variant: "destructive" });
          setter((prev) => ({ ...prev, isDragging: false }));
        }
      },
    }),
    [toast]
  );

  const plansHandlers = createDropHandlers(setPlans);
  const specsHandlers = createDropHandlers(setSpecs);

  const isReady = projectName && regionCode && dueDate;
  const isProcessing = phase !== "idle" && phase !== "complete" && phase !== "error";

  if (phase !== "idle") {
    const showUploadStep = hasFiles;
    const showSpecExtractorStep = hasSpecs;
    const showPlanParserStep = hasPlans;

    const getProgressTitle = () => {
      if (phase === "complete") return "Project Created Successfully";
      if (phase === "error") {
        return createdProject ? "Processing Error" : "Something Went Wrong";
      }
      return "Creating Project";
    };

    const getProgressSubtitle = () => {
      if (phase === "complete") {
        if (!hasFiles) return "Project folder has been created and is ready.";
        return "All processing stages are complete. Your project is ready.";
      }
      if (phase === "error") return errorMessage;
      return hasFiles
        ? "Large files may take several minutes to upload and process."
        : "Setting up project folder...";
    };

    let stepNumber = 0;

    return (
      <div className="container max-w-2xl mx-auto py-8 px-4 animate-page-enter">
        <div className="flex items-center gap-4 mb-8">
          <BackNav href="/" label="Home" testId="button-back" disabled={isProcessing} />
          <div>
            <h1 className="text-2xl font-heading font-semibold text-foreground">Project Start</h1>
            <p className="text-muted-foreground">
              {createdProject ? `Creating ${createdProject.projectId}` : "Creating project..."}
            </p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-heading" data-testid="text-progress-title">
              {getProgressTitle()}
            </CardTitle>
            <CardDescription>
              {getProgressSubtitle()}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {showUploadStep && (
              <ProgressStep
                step={++stepNumber}
                label="Uploading Files"
                description={
                  phase === "uploading"
                    ? `Sending ${plans.file ? formatSize(plans.file.size) + " plans" : ""}${plans.file && specs.file ? " + " : ""}${specs.file ? formatSize(specs.file.size) + " specs" : ""}...`
                    : "Files sent to server"
                }
                status={phase === "uploading" ? "active" : "done"}
                progress={phase === "uploading" ? uploadPercent : 100}
                showProgress={phase === "uploading"}
                testId="progress-upload"
              />
            )}

            <ProgressStep
              step={++stepNumber}
              label="Setting Up Project"
              description={
                phase === "creating"
                  ? "Creating project folders and stamping estimate..."
                  : "Folder structure and estimate template ready"
              }
              status={
                phase === "creating" ? "active" :
                phase === "uploading" ? "pending" : "done"
              }
              testId="progress-setup"
            />

            {showSpecExtractorStep && (
              <>
                <ProgressStep
                  step={++stepNumber}
                  label="Analyzing Specifications"
                  description={getSpecExtractorDescription(phase, progressData)}
                  status={
                    phase === "specsift_running" ? "active" :
                    (phase === "uploading" || phase === "creating") ? "pending" : "done"
                  }
                  progress={progressData?.specsift?.progress ?? 0}
                  showProgress={phase === "specsift_running"}
                  testId="progress-spec-extractor"
                />
                {progressData?.specExtractorUrl && (phase === "specsift_running" || phase === "planparser_running" || phase === "complete") && (
                  <div className="ml-9 -mt-3 space-y-2" data-testid="spec-extractor-link-section">
                    <div className="flex items-start gap-2 p-3 rounded-md bg-muted/50 border border-border">
                      <ExternalLink className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0 space-y-2">
                        <p className="text-xs text-muted-foreground">
                          For a full interactive review of your specifications — including section selection and ZIP export — open the Spec Extractor tool.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const url = new URL(progressData.specExtractorUrl!);
                            url.searchParams.set("project", projectName);
                            window.open(url.toString(), "_blank", "noopener,noreferrer");
                          }}
                          data-testid="button-open-spec-extractor"
                        >
                          <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                          Open Spec Extractor
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {showPlanParserStep && (
              <ProgressStep
                step={++stepNumber}
                label="Plan Parser — Classifying Pages"
                description={getPlanParserDescription(phase, progressData, hasSpecs)}
                status={
                  phase === "planparser_running" ? "active" :
                  (phase === "uploading" || phase === "creating" || phase === "specsift_running") ? "pending" :
                  phase === "complete" ? "done" : "pending"
                }
                progress={
                  progressData?.planparser && progressData.planparser.totalPages > 0
                    ? Math.round((progressData.planparser.processedPages / progressData.planparser.totalPages) * 100)
                    : 0
                }
                showProgress={phase === "planparser_running"}
                testId="progress-planparser"
              />
            )}

            {phase === "error" && (
              <div className="flex items-center gap-3 p-3 rounded-md bg-destructive/10 text-destructive text-sm" data-testid="text-error-message">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap pt-2">
              {phase === "complete" && createdProject && (
                <>
                  <Button
                    asChild
                    data-testid="button-download-folder"
                  >
                    <a href={`/api/projects/${createdProject.id}/download-folder`} download>
                      <Download className="w-4 h-4 mr-2" />
                      Download Project Folder
                    </a>
                  </Button>
                  <Button onClick={handleGoToProject} variant="outline" data-testid="button-go-to-project">
                    View Project
                  </Button>
                </>
              )}
              {phase === "error" && !createdProject && (
                <Button onClick={handleRetry} variant="outline" data-testid="button-retry">
                  Try Again
                </Button>
              )}
              {phase === "error" && createdProject && (
                <>
                  <Button
                    asChild
                    variant="outline"
                    data-testid="button-download-folder-error"
                  >
                    <a href={`/api/projects/${createdProject.id}/download-folder`} download>
                      <Download className="w-4 h-4 mr-2" />
                      Download Folder
                    </a>
                  </Button>
                  <Button onClick={handleGoToProject} variant="outline" data-testid="button-go-to-project-error">
                    View Project
                  </Button>
                  <Button onClick={handleRetry} variant="ghost" data-testid="button-retry">
                    Try Again
                  </Button>
                </>
              )}
              {isProcessing && (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  This may take several minutes for large files. You can leave this page safely.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto py-8 px-4 animate-page-enter">
      <ReadOnlyBanner />
      <div className="flex items-center gap-4 mb-8">
        <BackNav href="/" label="Home" testId="button-back" />
        <div>
          <h1 className="text-2xl font-heading font-semibold text-foreground">Project Start</h1>
          <p className="text-muted-foreground">Create a new project folder, optionally with plans and specs</p>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-lg font-heading">Quick Fill from Screenshot</CardTitle>
              <CardDescription>
                Paste a BuildingConnected screenshot to auto-fill project details
              </CardDescription>
            </div>
            {screenshotPreview && (
              <Button
                variant="ghost"
                size="icon"
                onClick={clearScreenshot}
                data-testid="button-clear-screenshot"
              >
                <X className="w-4 h-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!screenshotPreview ? (
              <div
                tabIndex={0}
                className={cn(
                  "border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition-all duration-200 outline-none",
                  screenshotDragging
                    ? "ring-2"
                    : "border-border hover:border-muted-foreground/50"
                )}
                style={screenshotDragging ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.1)", boxShadow: "0 0 0 2px rgba(201,168,76,0.3)" } : undefined}
                onDragOver={(e) => {
                  e.preventDefault();
                  setScreenshotDragging(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setScreenshotDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setScreenshotDragging(false);
                  const file = e.dataTransfer.files[0];
                  if (file) handleScreenshotFile(file);
                }}
                onClick={handleClickPaste}
                data-testid="dropzone-screenshot"
              >
                <input
                  ref={screenshotInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleScreenshotFile(file);
                  }}
                  data-testid="input-screenshot-file"
                />
                <Camera className="w-10 h-10 mx-auto mb-2" style={{ color: "var(--gold)", opacity: 0.7 }} />
                <p className="font-medium text-foreground">
                  Click to paste from clipboard
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  or drag and drop, or press <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">Ctrl+V</kbd>
                </p>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); screenshotInputRef.current?.click(); }}
                  className="text-xs hover:underline mt-2"
                  style={{ color: "var(--gold)" }}
                  data-testid="button-browse-screenshot"
                >
                  Browse files instead
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="relative rounded-md overflow-hidden border border-border bg-muted/30">
                  <img
                    src={screenshotPreview}
                    alt="Uploaded screenshot"
                    className="w-full max-h-48 object-contain"
                    data-testid="img-screenshot-preview"
                  />
                  {isExtracting && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/70">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Reading screenshot...
                      </div>
                    </div>
                  )}
                </div>
                {extractionResult && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm" data-testid="extraction-results">
                    <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                      <span className="text-muted-foreground whitespace-nowrap">Name:</span>
                      <span className={cn("font-medium", extractionResult.projectName ? "text-foreground" : "text-muted-foreground")}>
                        {extractionResult.projectName || "Not found"}
                      </span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                      <span className="text-muted-foreground whitespace-nowrap">Due:</span>
                      <span className={cn("font-medium", extractionResult.dueDate ? "text-foreground" : "text-muted-foreground")}>
                        {extractionResult.dueDate || "Not found"}
                      </span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                      <span className="text-muted-foreground whitespace-nowrap">Client:</span>
                      <span className={cn("font-medium", extractionResult.clientName ? "text-foreground" : "text-muted-foreground")}>
                        {extractionResult.clientName ? `${extractionResult.clientName}${extractionResult.clientLocation ? ` — ${extractionResult.clientLocation}` : ""}` : "Not found"}
                      </span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                      <span className="text-muted-foreground whitespace-nowrap">Location:</span>
                      <span className={cn("font-medium", extractionResult.location ? "text-foreground" : "text-muted-foreground")}>
                        {extractionResult.location || "Not found"}
                      </span>
                    </div>
                    {extractionResult.inviteDate && (
                      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                        <span className="text-muted-foreground whitespace-nowrap">Invited:</span>
                        <span className="font-medium text-foreground">{extractionResult.inviteDate}</span>
                      </div>
                    )}
                    {extractionResult.primaryMarket && (
                      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                        <span className="text-muted-foreground whitespace-nowrap">Market:</span>
                        <span className="font-medium text-foreground">{extractionResult.primaryMarket}</span>
                      </div>
                    )}
                    {extractionResult.gcContactName && (
                      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                        <span className="text-muted-foreground whitespace-nowrap">GC Contact:</span>
                        <span className="font-medium text-foreground">{extractionResult.gcContactName}{extractionResult.gcContactEmail ? ` (${extractionResult.gcContactEmail})` : ""}</span>
                      </div>
                    )}
                    {!extractionResult.gcContactName && extractionResult.gcContactEmail && (
                      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                        <span className="text-muted-foreground whitespace-nowrap">GC Email:</span>
                        <span className="font-medium text-foreground">{extractionResult.gcContactEmail}</span>
                      </div>
                    )}
                    {extractionResult.expectedStart && (
                      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                        <span className="text-muted-foreground whitespace-nowrap">Est. Start:</span>
                        <span className="font-medium text-foreground">{extractionResult.expectedStart}</span>
                      </div>
                    )}
                    {extractionResult.expectedFinish && (
                      <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50">
                        <span className="text-muted-foreground whitespace-nowrap">Est. End:</span>
                        <span className="font-medium text-foreground">{extractionResult.expectedFinish}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="card-accent-bar">
          <CardHeader>
            <CardTitle className="text-lg font-heading">Project Details</CardTitle>
            <CardDescription>Basic information about the project</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="regionCode">Region *</Label>
                <Select value={selectedRegionId} onValueChange={(val) => {
                  const selected = regions.find((r) => String(r.id) === val);
                  setRegionCode(selected ? selected.code : val);
                  setSelectedRegionId(val);
                  setRegionNotConfident(false);
                }}>
                  <SelectTrigger data-testid="select-region" className={cn(regionNotConfident && !regionCode && "border-amber-500 ring-1 ring-amber-500/30")}>
                    <SelectValue placeholder="Select region">
                      {selectedRegionId ? (() => {
                        const sel = regions.find((r) => String(r.id) === selectedRegionId);
                        return sel ? `${sel.code}${sel.name ? ` - ${sel.name}` : ""}` : regionCode;
                      })() : null}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {regions.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No regions - add in Settings
                      </SelectItem>
                    ) : (
                      [...regions]
                        .sort((a, b) => {
                          const aExt = a.code === "EXT" ? 1 : 0;
                          const bExt = b.code === "EXT" ? 1 : 0;
                          if (aExt !== bExt) return aExt - bExt;
                          const codeCompare = a.code.localeCompare(b.code);
                          if (codeCompare !== 0) return codeCompare;
                          return (a.name ?? "").localeCompare(b.name ?? "");
                        })
                        .map((r) => (
                          <SelectItem key={r.id} value={String(r.id)}>
                            {r.code}{r.name ? ` - ${r.name}` : ""}
                          </SelectItem>
                        ))
                    )}
                  </SelectContent>
                </Select>
                {regionNotConfident && !regionCode && (
                  <p className="text-xs text-amber-500 flex items-center gap-1" data-testid="text-region-warning">
                    <AlertCircle className="w-3 h-3" />
                    Could not determine region — please select manually
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Due Date *</Label>
                <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !dueDate && "text-muted-foreground"
                      )}
                      data-testid="input-due-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {dueDate ? formatDueDate(dueDate) : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={dueDate}
                      onSelect={handleDateSelect}
                      defaultMonth={dueDate || new Date()}
                      data-testid="calendar-due-date"
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="projectName">Project Name *</Label>
              <Input
                id="projectName"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Terminal B Renovation"
                data-testid="input-project-name"
              />
            </div>
            {projectName && regionCode && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FolderOpen className="w-4 h-4" />
                Folder: <span className="font-mono">{regionCode} - {projectName}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-heading">Proposal Intake Details</CardTitle>
            <CardDescription>
              These fields will be added to the Proposal Log Dashboard. Auto-filled from screenshot when available.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="primaryMarket">Primary Market</Label>
                <Select value={primaryMarket} onValueChange={setPrimaryMarket}>
                  <SelectTrigger data-testid="select-primary-market">
                    <SelectValue placeholder="Select market" />
                  </SelectTrigger>
                  <SelectContent>
                    {["Education", "Healthcare", "Aviation", "Hospitality", "Residential", "Retail", "Office", "Entertainment", "Parking Structure", "Public Facility", "Special Projects"].map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="estimateStatus">Estimate Status</Label>
                <Select value={estimateStatus} onValueChange={setEstimateStatus}>
                  <SelectTrigger data-testid="select-estimate-status">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {["Estimating", "Submitted", "Won", "Lost - Note Why in Comments"].map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="inviteDate">Invite Date</Label>
                <Input
                  id="inviteDate"
                  type="date"
                  value={inviteDate}
                  onChange={(e) => setInviteDate(e.target.value)}
                  data-testid="input-invite-date"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="anticipatedStart">Est. Start</Label>
                <Input
                  id="anticipatedStart"
                  type="date"
                  value={anticipatedStart}
                  onChange={(e) => setAnticipatedStart(e.target.value)}
                  data-testid="input-anticipated-start"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="anticipatedFinish">Est. End</Label>
                <Input
                  id="anticipatedFinish"
                  type="date"
                  value={anticipatedFinish}
                  onChange={(e) => setAnticipatedFinish(e.target.value)}
                  data-testid="input-anticipated-finish"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bcLink">Building Connected Link</Label>
              <div className="flex gap-2">
                <Input
                  id="bcLink"
                  type="url"
                  placeholder="https://app.buildingconnected.com/..."
                  value={bcLink}
                  onChange={(e) => setBcLink(e.target.value)}
                  data-testid="input-bc-link"
                />
                {bcLink && (
                  <a href={bcLink} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 px-3 py-1 text-xs font-medium border rounded-md whitespace-nowrap hover:bg-accent" data-testid="link-bc-open">
                    <ExternalLink className="w-3 h-3" /> Open
                  </a>
                )}
              </div>
            </div>
            {extractionResult && (
              <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="text-extraction-source">
                <div className="flex items-center gap-2">
                  <ImageIcon className="w-3 h-3" />
                  {extractionResult.clientName && (
                    <span>Client: <span className="font-medium text-foreground">{extractionResult.clientName}{extractionResult.clientLocation ? ` — ${extractionResult.clientLocation}` : ""}</span></span>
                  )}
                </div>
                {extractionResult.gcContactName && (
                  <div className="flex items-center gap-2 ml-5">
                    <span>GC Contact: <span className="font-medium text-foreground">{extractionResult.gcContactName}{extractionResult.gcContactEmail ? ` (${extractionResult.gcContactEmail})` : ""}</span></span>
                  </div>
                )}
                {!extractionResult.gcContactName && extractionResult.gcContactEmail && (
                  <div className="flex items-center gap-2 ml-5">
                    <span>GC Email: <span className="font-medium text-foreground">{extractionResult.gcContactEmail}</span></span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg font-heading">Documents</CardTitle>
            <CardDescription>
              Upload plans and/or specs to process. Leave both empty to create just the project folder.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <UploadZone
                label="Plans PDF"
                description="Construction plan drawings"
                file={plans.file}
                isDragging={plans.isDragging}
                onFileChange={(file) => setPlans({ file, isDragging: false })}
                dropHandlers={plansHandlers}
                testId="upload-plans"
                optional
              />
              <UploadZone
                label="Specs PDF"
                description="Specification documents"
                file={specs.file}
                isDragging={specs.isDragging}
                onFileChange={(file) => setSpecs({ file, isDragging: false })}
                dropHandlers={specsHandlers}
                testId="upload-specs"
                optional
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground">
            {isReady ? (
              <span className="flex items-center gap-1 text-green-400">
                <CheckCircle className="w-4 h-4" />
                {plans.file || specs.file
                  ? `Ready — will process ${[plans.file && "plans", specs.file && "specs"].filter(Boolean).join(" & ")}`
                  : "Ready — folder only (no documents to process)"
                }
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <AlertCircle className="w-4 h-4" />
                Fill in region, due date, and project name
              </span>
            )}
          </div>
          <Button
            onClick={checkDuplicatesThenSubmit}
            disabled={!isReady || dupCheckLoading || isViewer}
            data-testid="button-create-project"
          >
            {dupCheckLoading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Checking…</>
            ) : "Create Project"}
          </Button>
        </div>
      </div>

      {/* Duplicate Resolution Modal */}
      <AlertDialog open={dupModal.open} onOpenChange={(open) => !open && setDupModal({ open: false, matches: [] })}>
        <AlertDialogContent className="max-w-2xl" data-testid="dialog-duplicate-check">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              Possible Duplicate Detected
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="mb-3 text-sm">
                  The project name <span className="font-semibold text-foreground">"{projectName}"</span> is similar to {dupModal.matches.length === 1 ? "an existing project" : `${dupModal.matches.length} existing projects`} in the Proposal Log. How would you like to proceed?
                </p>
                <div className="space-y-2 mb-4 max-h-56 overflow-y-auto">
                  {dupModal.matches.map((m) => (
                    <div key={m.id} className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-foreground text-sm">{m.projectName}</div>
                          <div className="text-muted-foreground mt-0.5">
                            {[m.estimateNumber, m.region, m.gcEstimateLead].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {m.estimateStatus && (
                            <span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-primary/20 text-primary">{m.estimateStatus}</span>
                          )}
                          <span className="text-muted-foreground text-[10px]">{Math.round(m.score * 100)}% match</span>
                        </div>
                      </div>
                      {m.proposalTotal && (
                        <div className="mt-1 text-muted-foreground">Total: {m.proposalTotal}</div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    data-testid="button-dup-cancel"
                    onClick={() => setDupModal({ open: false, matches: [] })}
                  >
                    <X className="w-4 h-4 mr-1" /> Cancel
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 border-yellow-600/50 text-yellow-400 hover:bg-yellow-900/20"
                    data-testid="button-dup-create-anyway"
                    onClick={() => {
                      setDupModal({ open: false, matches: [] });
                      handleSubmit({ duplicateOverrideNote: "User confirmed not a duplicate" });
                    }}
                  >
                    <AlertCircle className="w-4 h-4 mr-1" /> Create Anyway
                  </Button>
                  {dupModal.matches.length === 1 && (
                    <Button
                      size="sm"
                      className="flex-1"
                      data-testid="button-dup-merge"
                      onClick={() => {
                        const match = dupModal.matches[0];
                        setDupModal({ open: false, matches: [] });
                        handleSubmit({ mergeIntoProposalLogId: match.id });
                      }}
                    >
                      <GitMerge className="w-4 h-4 mr-1" /> Add as Re-Bid to "{dupModal.matches[0]?.projectName?.substring(0, 30)}{(dupModal.matches[0]?.projectName?.length ?? 0) > 30 ? "…" : ""}"
                    </Button>
                  )}
                </div>
                {dupModal.matches.length > 1 && (
                  <div className="mt-3 space-y-1">
                    <p className="text-xs text-muted-foreground font-medium">Or add as a re-bid to one of these:</p>
                    {dupModal.matches.map((m) => (
                      <Button
                        key={m.id}
                        variant="outline"
                        size="sm"
                        className="w-full justify-start text-xs"
                        data-testid={`button-dup-merge-${m.id}`}
                        onClick={() => {
                          setDupModal({ open: false, matches: [] });
                          handleSubmit({ mergeIntoProposalLogId: m.id });
                        }}
                      >
                        <GitMerge className="w-3 h-3 mr-1.5 shrink-0" />
                        Re-bid on: {m.projectName} {m.estimateNumber ? `(${m.estimateNumber})` : ""}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={yearCheckOpen} onOpenChange={setYearCheckOpen}>
        <AlertDialogContent data-testid="dialog-year-check">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Due Date Year</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDate && (
                <>
                  You selected <span className="font-semibold">{format(pendingDate, "MMM d, ''yy")}</span>.
                  Since it's November, is this due date for the current year or next year?
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setYearCheckOpen(false); setPendingDate(undefined); }} data-testid="button-year-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleYearCheckNextYear}
              className="bg-secondary text-secondary-foreground"
              data-testid="button-year-next"
            >
              Next Year '{String(new Date().getFullYear() + 1).slice(-2)}
            </AlertDialogAction>
            <AlertDialogAction onClick={handleYearCheckConfirm} data-testid="button-year-current">
              This Year '{String(new Date().getFullYear()).slice(-2)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDueDate(date: Date): string {
  const month = format(date, "MMM d");
  const year = format(date, "yy");
  return `${month}, '${year}`;
}

function formatSize(bytes: number | undefined): string {
  if (!bytes) return "0 MB";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getSpecExtractorDescription(phase: CreationPhase, data: ProgressData | null): string {
  if (phase === "specsift_running" && data?.specsift) {
    const msg = data.specsift.message || "Processing specifications...";
    const pct = data.specsift.progress;
    return pct > 0 ? `${msg} (${pct}%)` : msg;
  }
  if (phase === "planparser_running" || phase === "complete") {
    return "Specification extraction complete";
  }
  return "Waiting to start...";
}

function getPlanParserDescription(phase: CreationPhase, data: ProgressData | null, hasSpecs: boolean): string {
  if (phase === "planparser_running" && data?.planparser) {
    const { processedPages, totalPages, message } = data.planparser;
    if (totalPages > 0) {
      return `Page ${processedPages} of ${totalPages} — ${message || "Classifying..."}`;
    }
    return message || "Initializing...";
  }
  if (phase === "complete") {
    return "Page classification complete";
  }
  if (hasSpecs) {
    return "Waiting for Spec Extractor to finish...";
  }
  return "Waiting to start...";
}

interface ProgressStepProps {
  step: number;
  label: string;
  description: string;
  status: "pending" | "active" | "done";
  progress?: number;
  showProgress?: boolean;
  testId: string;
}

function ProgressStep({ step, label, description, status, progress = 0, showProgress = false, testId }: ProgressStepProps) {
  const icon =
    status === "done" ? (
      <CheckCircle className="w-5 h-5 text-green-500" />
    ) : status === "active" ? (
      <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--gold)" }} />
    ) : (
      <div className="w-5 h-5 rounded-full border-2 border-muted-foreground/30 flex items-center justify-center">
        <span className="text-[10px] text-muted-foreground/50 font-medium">{step}</span>
      </div>
    );

  return (
    <div
      className={`flex gap-4 items-start transition-opacity ${status === "pending" ? "opacity-40" : "opacity-100"}`}
      data-testid={testId}
    >
      <div className="flex-shrink-0 pt-0.5">{icon}</div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-medium ${status === "active" ? "text-foreground" : status === "done" ? "text-foreground" : "text-muted-foreground"}`}>
            {label}
          </span>
          {status === "active" && showProgress && progress > 0 && (
            <Badge variant="secondary" className="text-xs" data-testid={`${testId}-percent`}>
              {progress}%
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground" data-testid={`${testId}-description`}>{description}</p>
        {status === "active" && showProgress && (
          <Progress value={progress} className="h-1.5" data-testid={`${testId}-bar`} />
        )}
      </div>
    </div>
  );
}

interface UploadZoneProps {
  label: string;
  description: string;
  file: File | null;
  isDragging: boolean;
  onFileChange: (file: File | null) => void;
  dropHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  testId: string;
  optional?: boolean;
}

function UploadZone({ label, description, file, isDragging, onFileChange, dropHandlers, testId, optional }: UploadZoneProps) {
  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f && f.type === "application/pdf") {
      onFileChange(f);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">{label}</span>
        {optional && <Badge variant="secondary" className="text-xs">Optional</Badge>}
      </div>
      <p className="text-xs text-muted-foreground mb-2">{description}</p>
      <div
        className={`relative flex flex-col items-center justify-center p-6 rounded-lg border-2 border-dashed transition-colors cursor-pointer ${
          isDragging
            ? ""
            : file
            ? "border-green-500 bg-green-950/20"
            : "border-border hover:border-muted-foreground/50"
        }`}
        style={isDragging ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.06)" } : undefined}
        {...dropHandlers}
        onClick={() => document.getElementById(`file-${testId}`)?.click()}
        data-testid={testId}
      >
        <input
          id={`file-${testId}`}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={handleFileInput}
          data-testid={`input-${testId}`}
        />
        {file ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <FileText className="w-8 h-8 text-green-400" />
            <span className="text-sm font-medium truncate max-w-full" data-testid={`text-filename-${testId}`}>
              {file.name}
            </span>
            <Badge variant="secondary" className="text-xs">
              {(file.size / (1024 * 1024)).toFixed(1)} MB
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onFileChange(null);
              }}
              data-testid={`button-remove-${testId}`}
            >
              Remove
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center">
            <Upload className="w-8 h-8 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Drop PDF here or click to browse
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
