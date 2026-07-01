import { useState, useEffect, useRef, useCallback } from "react";
import { BackNav } from "@/components/BackNav";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Upload, FileText, X, AlertCircle, CheckCircle2, Loader2,
  Download, ArrowLeft, Building2, FolderOpen, FileStack, Trash2,
  Eye, EyeOff, Sparkles, Check, Minus, SquareCheck, Pencil,
  Package, Tag, Ban, ClipboardList, AlertTriangle,
} from "lucide-react";
import { useToolUsage } from "@/lib/useToolUsage";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import ProjectNameComboBox from "@/components/ProjectNameComboBox";
import type { SpecExtractorSession, SpecExtractorSection } from "@shared/schema";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, UPLOAD_CHUNK_BYTES } from "@shared/uploadLimits";

type ViewState = "upload" | "processing" | "results";

interface PreviewData {
  sectionNumber: string;
  title: string;
  startPage: number;
  endPage: number;
  pageCount: number;
  previewPages: { pageNumber: number; text: string }[];
}

interface AiReview {
  id: string;
  status: "correct" | "suggested_change" | "warning" | "not_div10";
  suggestedTitle: string;
  notes: string;
}

export default function SpecExtractorPage() {
  useToolUsage("specextractor");
  const { toast } = useToast();
  const { isViewer } = useAuth();
  const queryClient = useQueryClient();
  const [viewState, setViewState] = useState<ViewState>("upload");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [resultsProjectName, setResultsProjectName] = useState("");
  const [isEditingProjectName, setIsEditingProjectName] = useState(false);
  const [suggestedProjectName, setSuggestedProjectName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sessionData, setSessionData] = useState<{ status: string; progress: number; message: string } | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const [selectedSections, setSelectedSections] = useState<Set<string>>(new Set());
  const [previewSectionId, setPreviewSectionId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [aiReviews, setAiReviews] = useState<Map<string, AiReview>>(new Map());
  const [isReviewing, setIsReviewing] = useState(false);

  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderValue, setEditingFolderValue] = useState("");
  const folderInputRef = useRef<HTMLInputElement>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);

  const [selectedAccessories, setSelectedAccessories] = useState<Set<string>>(new Set());
  const [tocHints, setTocHints] = useState("");

  const { data: accessoryScopes = [] } = useQuery<{ name: string; keywords: string[]; sectionHint: string }[]>({
    queryKey: ["/api/spec-extractor/accessory-scopes"],
  });

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const { data: sections = [] } = useQuery<SpecExtractorSection[]>({
    queryKey: ["/api/spec-extractor/sessions", sessionId, "sections"],
    queryFn: async () => {
      if (!sessionId) return [];
      const res = await fetch(`/api/spec-extractor/sessions/${sessionId}/sections`);
      if (!res.ok) throw new Error("Failed to fetch sections");
      return res.json();
    },
    enabled: viewState === "results" && !!sessionId,
  });

  const hasInitializedSelection = useRef(false);

  useEffect(() => {
    if (sections.length > 0 && !hasInitializedSelection.current) {
      hasInitializedSelection.current = true;
      // Pre-check Division 10 only. Division 11/12 (and accessories) are listed
      // for the user to opt into, but start unchecked.
      setSelectedSections(new Set(
        sections
          .filter(s => s.sectionType === "div10" && !s.isSignage && s.aiReviewStatus !== "not_div10")
          .map(s => s.id)
      ));
    }

    if (sections.length > 0) {
      const reviewMap = new Map<string, AiReview>();
      for (const s of sections) {
        if (s.aiReviewStatus) {
          reviewMap.set(s.id, {
            id: s.id,
            status: s.aiReviewStatus as AiReview["status"],
            suggestedTitle: s.title,
            notes: s.aiReviewNotes || "",
          });
        }
      }
      if (reviewMap.size > 0) {
        setAiReviews(reviewMap);
      }
    }
  }, [sections]);

  const loadSessionData = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/spec-extractor/sessions/${sid}`);
      if (!res.ok) return;
      const session = await res.json();
      if (session.projectName) {
        setResultsProjectName(session.projectName);
      }
      if (session.suggestedProjectName) {
        setSuggestedProjectName(session.suggestedProjectName);
        if (!session.projectName) {
          setResultsProjectName(session.suggestedProjectName);
        }
      }
    } catch {}
  }, []);

  const pollStatus = useCallback((sid: string) => {
    const check = async () => {
      try {
        const res = await fetch(`/api/spec-extractor/sessions/${sid}/status`);
        if (!res.ok) throw new Error("Status check failed");
        const data = await res.json();
        setSessionData(data);

        if (data.status === "processing" || data.status === "reviewing") {
          pollRef.current = setTimeout(check, 500);
        } else if (data.status === "complete") {
          pollRef.current = null;
          setViewState("results");
          loadSessionData(sid);
          toast({ title: "Extraction Complete", description: data.message });
        } else if (data.status === "error") {
          pollRef.current = null;
          toast({ title: "Processing Error", description: data.message, variant: "destructive" });
        }
      } catch {
        pollRef.current = null;
      }
    };
    if (pollRef.current) clearTimeout(pollRef.current);
    check();
  }, [toast, loadSessionData]);

  const validateFile = (file: File): boolean => {
    setFileError(null);
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setFileError("Please upload a PDF file");
      return false;
    }
    if (file.size === 0) {
      setFileError("This file appears to be empty");
      return false;
    }
    // No hard cap any more — large files are uploaded in chunks. Keep only a
    // generous sanity ceiling to catch obviously-wrong selections.
    if (file.size > MAX_UPLOAD_BYTES) {
      setFileError(`File is unusually large (over ${MAX_UPLOAD_LABEL}). Please confirm it's the right PDF.`);
      return false;
    }
    return true;
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
    const file = e.dataTransfer.files[0];
    if (file && validateFile(file)) {
      setSelectedFile(file);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && validateFile(file)) {
      setSelectedFile(file);
    }
  };

  // Small files go in a single request; larger files are split into chunks so
  // each request stays under the production proxy's ~32 MiB body limit.
  const uploadSingleShot = async (file: File): Promise<any> => {
    const formData = new FormData();
    formData.append("file", file);
    if (projectName.trim()) formData.append("projectName", projectName.trim());
    if (selectedAccessories.size > 0) formData.append("selectedAccessories", JSON.stringify(Array.from(selectedAccessories)));
    if (tocHints.trim()) formData.append("tocHints", tocHints.trim());

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600000);
    try {
      const response = await fetch("/api/spec-extractor/upload", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      if (!response.ok) {
        let msg = "Upload failed";
        try { const err = await response.json(); msg = err.message || msg; } catch {}
        throw new Error(msg);
      }
      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const uploadChunked = async (file: File): Promise<any> => {
    const totalChunks = Math.ceil(file.size / UPLOAD_CHUNK_BYTES);

    // 1. init
    setUploadProgress("Preparing upload…");
    const initRes = await fetch("/api/spec-extractor/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        projectName: projectName.trim(),
        selectedAccessories: JSON.stringify(Array.from(selectedAccessories)),
        tocHints: tocHints.trim(),
        totalSize: file.size,
        totalChunks,
      }),
    });
    if (!initRes.ok) {
      let msg = "Upload failed to start";
      try { const err = await initRes.json(); msg = err.message || msg; } catch {}
      throw new Error(msg);
    }
    const { sessionId: uploadSessionId } = await initRes.json();

    // 2. chunks (sequential keeps server-side reassembly simple and ordered)
    for (let i = 0; i < totalChunks; i++) {
      const start = i * UPLOAD_CHUNK_BYTES;
      const blob = file.slice(start, Math.min(start + UPLOAD_CHUNK_BYTES, file.size));
      const fd = new FormData();
      fd.append("sessionId", uploadSessionId);
      fd.append("chunkIndex", String(i));
      fd.append("chunk", blob);

      let lastErr: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch("/api/spec-extractor/upload/chunk", { method: "POST", body: fd });
          if (!r.ok) {
            let msg = "Chunk upload failed";
            try { const err = await r.json(); msg = err.message || msg; } catch {}
            throw new Error(msg);
          }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise(res => setTimeout(res, 1000 * (attempt + 1)));
        }
      }
      if (lastErr) throw lastErr;
      setUploadProgress(`Uploading… ${Math.round(((i + 1) / totalChunks) * 100)}% (part ${i + 1}/${totalChunks})`);
    }

    // 3. complete -> assemble + start extraction
    setUploadProgress("Assembling file…");
    const completeRes = await fetch("/api/spec-extractor/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: uploadSessionId }),
    });
    if (!completeRes.ok) {
      let msg = "Upload completion failed";
      try { const err = await completeRes.json(); msg = err.message || msg; } catch {}
      throw new Error(msg);
    }
    return await completeRes.json();
  };

  const handleUpload = async () => {
    if (guardViewer(isViewer, toast)) return;
    if (!selectedFile) return;

    setIsUploading(true);
    setUploadProgress(null);

    try {
      const session = selectedFile.size <= UPLOAD_CHUNK_BYTES
        ? await uploadSingleShot(selectedFile)
        : await uploadChunked(selectedFile);

      setSessionId(session.id);
      setResultsProjectName(projectName.trim());
      setSessionData({ status: "processing", progress: 0, message: "Starting extraction..." });
      setViewState("processing");
      setSelectedSections(new Set());
      setAiReviews(new Map());
      setPreviewSectionId(null);
      setPreviewData(null);
      setSuggestedProjectName(null);
      pollStatus(session.id);
    } catch (err: any) {
      if (err instanceof DOMException && err.name === "AbortError") {
        toast({ title: "Upload Timeout", description: "The upload timed out. Try opening in a new tab.", variant: "destructive" });
      } else {
        toast({ title: err?.title || "Upload Failed", description: err.message, variant: "destructive" });
      }
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  const handleExport = async () => {
    if (!sessionId) return;
    setIsExporting(true);
    try {
      const sectionIds = Array.from(selectedSections);
      const res = await fetch(`/api/spec-extractor/sessions/${sessionId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        throw new Error(err.message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const exportName = resultsProjectName || suggestedProjectName || "Project";
      a.download = `${exportName} - Spec Extract.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Export Complete", description: `Downloaded ${sectionIds.length} sections as ZIP.` });
    } catch (err: any) {
      toast({ title: "Export Failed", description: err.message, variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  };

  const handleReset = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setViewState("upload");
    setSessionId(null);
    setSelectedFile(null);
    setProjectName("");
    setResultsProjectName("");
    setSuggestedProjectName(null);
    setSessionData(null);
    setFileError(null);
    setSelectedSections(new Set());
    setPreviewSectionId(null);
    setPreviewData(null);
    setAiReviews(new Map());
    hasInitializedSelection.current = false;
    setEditingFolderId(null);
    setIsEditingProjectName(false);
    setSelectedAccessories(new Set());
    setTocHints("");
  };

  const toggleAccessory = (name: string) => {
    setSelectedAccessories(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const toggleSection = (id: string) => {
    setSelectedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    const selectableSections = sections.filter(s => !s.isSignage && s.aiReviewStatus !== "not_div10");
    const allSelectableSelected = selectableSections.every(s => selectedSections.has(s.id));
    if (allSelectableSelected) {
      setSelectedSections(new Set());
    } else {
      setSelectedSections(new Set(selectableSections.map(s => s.id)));
    }
  };

  const handlePreview = async (sectionId: string) => {
    if (previewSectionId === sectionId) {
      setPreviewSectionId(null);
      setPreviewData(null);
      return;
    }

    setPreviewSectionId(sectionId);
    setIsLoadingPreview(true);
    setPreviewData(null);

    try {
      const res = await fetch(`/api/spec-extractor/sessions/${sessionId}/preview/${sectionId}`);
      if (!res.ok) throw new Error("Failed to load preview");
      const data = await res.json();
      setPreviewData(data);
    } catch (err: any) {
      toast({ title: "Preview Failed", description: err.message, variant: "destructive" });
      setPreviewSectionId(null);
    } finally {
      setIsLoadingPreview(false);
    }
  };

  const handleAiReview = async () => {
    if (guardViewer(isViewer, toast)) return;
    if (!sessionId) return;
    setIsReviewing(true);

    try {
      const res = await fetch(`/api/spec-extractor/sessions/${sessionId}/ai-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "AI review failed" }));
        throw new Error(err.message);
      }
      const data = await res.json();
      const reviewMap = new Map<string, AiReview>();
      for (const r of data.reviews) {
        reviewMap.set(r.id, r);
      }
      setAiReviews(reviewMap);

      queryClient.invalidateQueries({ queryKey: ["/api/spec-extractor/sessions", sessionId, "sections"] });

      const changes = data.reviews.filter((r: AiReview) => r.status === "suggested_change").length;
      const warnings = data.reviews.filter((r: AiReview) => r.status === "warning").length;
      const notDiv10 = data.reviews.filter((r: AiReview) => r.status === "not_div10").length;

      if (notDiv10 > 0) {
        const notDiv10Ids = data.reviews
          .filter((r: AiReview) => r.status === "not_div10")
          .map((r: AiReview) => r.id);
        setSelectedSections(prev => {
          const next = new Set(prev);
          for (const id of notDiv10Ids) {
            next.delete(id);
          }
          return next;
        });
      }

      const parts: string[] = [];
      if (notDiv10 > 0) parts.push(`${notDiv10} flagged as not Div 10`);
      if (changes > 0) parts.push(`${changes} suggested changes`);
      if (warnings > 0) parts.push(`${warnings} warnings`);
      if (parts.length > 0) {
        toast({ title: "AI Review Complete", description: parts.join(", ") });
      } else {
        toast({ title: "AI Review Complete", description: "All sections confirmed as legitimate Division 10" });
      }
    } catch (err: any) {
      toast({ title: "AI Review Failed", description: err.message, variant: "destructive" });
    } finally {
      setIsReviewing(false);
    }
  };

  const applyAiSuggestion = async (sectionId: string, suggestedTitle: string) => {
    if (guardViewer(isViewer, toast)) return;
    try {
      const res = await fetch(`/api/spec-extractor/sections/${sectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: suggestedTitle }),
      });
      if (!res.ok) throw new Error("Failed to update title");

      queryClient.invalidateQueries({ queryKey: ["/api/spec-extractor/sessions", sessionId, "sections"] });

      setAiReviews(prev => {
        const next = new Map(prev);
        const review = next.get(sectionId);
        if (review) {
          next.set(sectionId, { ...review, status: "correct", notes: "Applied" });
        }
        return next;
      });

      toast({ title: "Title Updated", description: `Updated to "${suggestedTitle}"` });
    } catch (err: any) {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    }
  };

  const startEditingFolder = (sectionId: string, currentFolderName: string) => {
    setEditingFolderId(sectionId);
    setEditingFolderValue(currentFolderName);
    setTimeout(() => folderInputRef.current?.focus(), 50);
  };

  const saveFolder = async (sectionId: string) => {
    if (guardViewer(isViewer, toast)) return;
    const trimmed = editingFolderValue.trim();
    if (!trimmed) {
      setEditingFolderId(null);
      return;
    }

    try {
      const res = await fetch(`/api/spec-extractor/sections/${sectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderName: trimmed }),
      });
      if (!res.ok) throw new Error("Failed to update folder name");
      queryClient.invalidateQueries({ queryKey: ["/api/spec-extractor/sessions", sessionId, "sections"] });
      toast({ title: "Folder Name Updated" });
    } catch (err: any) {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    } finally {
      setEditingFolderId(null);
    }
  };

  const handleFolderKeyDown = (e: React.KeyboardEvent, sectionId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveFolder(sectionId);
    } else if (e.key === "Escape") {
      setEditingFolderId(null);
    }
  };

  const startEditingProjectName = () => {
    setIsEditingProjectName(true);
    setTimeout(() => projectNameInputRef.current?.focus(), 50);
  };

  const saveProjectName = async () => {
    if (guardViewer(isViewer, toast)) return;
    const trimmed = resultsProjectName.trim();
    setIsEditingProjectName(false);

    if (!sessionId || !trimmed) return;

    try {
      const res = await fetch(`/api/spec-extractor/sessions/${sessionId}/project-name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: trimmed }),
      });
      if (!res.ok) throw new Error("Failed to update project name");
      setResultsProjectName(trimmed);
      toast({ title: "Project Name Updated" });
    } catch (err: any) {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    }
  };

  const applySuggestedProjectName = async () => {
    if (!suggestedProjectName) return;
    setResultsProjectName(suggestedProjectName);

    if (!sessionId) return;
    try {
      await fetch(`/api/spec-extractor/sessions/${sessionId}/project-name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectName: suggestedProjectName }),
      });
      toast({ title: "Project Name Applied", description: `Set to "${suggestedProjectName}"` });
    } catch {}
  };

  const handleProjectNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveProjectName();
    } else if (e.key === "Escape") {
      setIsEditingProjectName(false);
    }
  };

  const byNumber = (a: SpecExtractorSection, b: SpecExtractorSection) => a.sectionNumber.localeCompare(b.sectionNumber);
  const div10Sections = sections.filter(s => s.sectionType === "div10");
  const div11Sections = sections.filter(s => s.sectionType === "div11");
  const div12Sections = sections.filter(s => s.sectionType === "div12");
  const accessorySections = sections.filter(s => s.sectionType === "accessory");
  const sortedDiv10 = [...div10Sections].sort(byNumber);
  const sortedDiv11 = [...div11Sections].sort(byNumber);
  const sortedDiv12 = [...div12Sections].sort(byNumber);
  const sortedAccessory = [...accessorySections].sort(byNumber);
  const sortedSections = [...sortedDiv10, ...sortedDiv11, ...sortedDiv12, ...sortedAccessory];
  const sectionGroupLabels: Record<string, string> = {
    div10: "Division 10 Sections",
    div11: "Division 11 Sections",
    div12: "Division 12 Sections",
    accessory: "Accessory Sections",
  };
  const presentGroupCount = [div10Sections, div11Sections, div12Sections, accessorySections].filter(g => g.length > 0).length;
  const totalPages = sections.reduce((sum, s) => sum + s.pageCount, 0);
  const selectedCount = selectedSections.size;
  const selectableCount = sections.filter(s => !s.isSignage && s.aiReviewStatus !== "not_div10").length;
  const allSelected = selectableCount > 0 && selectedCount === selectableCount;
  const someSelected = selectedCount > 0 && selectedCount < selectableCount;
  const signageCount = sections.filter(s => s.isSignage).length;

  return (
    <div className="min-h-[calc(100vh-4rem)] animate-page-enter">
      <ReadOnlyBanner />
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-8 lg:py-20">
        <div className="mb-4">
          <BackNav href="/" label="Home" testId="button-back-home" />
        </div>
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl font-heading" data-testid="text-tool-name">
            Spec Extractor
          </h1>
          <p className="mt-2 text-xl text-muted-foreground sm:text-2xl" data-testid="text-page-subtitle">
            Division 10 Specification Extractor
          </p>
          <p className="mt-4 text-base text-muted-foreground">
            Upload a construction spec PDF to automatically detect and extract Division 10 sections into organized folders. Pure regex-based detection for fast, reliable results.
          </p>
        </div>

        <div className="mt-12">
          {viewState === "upload" && (
            <div className="space-y-6">
              <div
                onDragOver={isViewer ? undefined : handleDragOver}
                onDragLeave={isViewer ? undefined : handleDragLeave}
                onDrop={isViewer ? undefined : handleDrop}
                className={cn(
                  "mx-auto max-w-2xl rounded-lg border-2 border-dashed p-12 text-center transition-all",
                  isViewer
                    ? "opacity-50 cursor-not-allowed"
                    : "cursor-pointer",
                  !isViewer && isDragging
                    ? "border-[var(--gold)]"
                    : "border-border hover:border-muted-foreground/50",
                  isUploading && "pointer-events-none opacity-60"
                )}
                onClick={() => {
                  if (isViewer || isUploading) return;
                  document.getElementById("se-file-input")?.click();
                }}
                style={{
                  background: isDragging ? "rgba(200,164,78,0.10)" : undefined,
                  transform: isDragging ? "scale(1.01)" : "scale(1)",
                }}
                data-testid="dropzone-spec-extractor"
              >
                <input
                  id="se-file-input"
                  type="file"
                  accept=".pdf"
                  onChange={handleFileSelect}
                  className="hidden"
                  data-testid="input-se-file"
                />

                {selectedFile ? (
                  <div className="space-y-4">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "rgba(200,164,78,0.1)" }}>
                      <FileText className="h-6 w-6" style={{ color: "var(--gold)" }} />
                    </div>
                    <div>
                      <p className="font-medium text-foreground" data-testid="text-se-filename">{selectedFile.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                      </p>
                    </div>
                    <div className="flex items-center justify-center gap-3">
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleUpload();
                        }}
                        disabled={isUploading || isViewer}
                        data-testid="button-se-upload"
                      >
                        {isUploading ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {uploadProgress || "Uploading..."}
                          </>
                        ) : (
                          <>
                            <Upload className="mr-2 h-4 w-4" />
                            Extract Sections
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedFile(null);
                          setFileError(null);
                        }}
                        data-testid="button-se-clear-file"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted" style={{ background: isDragging ? "rgba(200,164,78,0.15)" : undefined }}>
                      <Upload className="h-6 w-6 text-muted-foreground" style={{ color: isDragging ? "var(--gold)" : undefined }} />
                    </div>
                    <div>
                      <p className="font-medium text-foreground" style={{ color: isDragging ? "var(--gold)" : undefined }}>
                        {isDragging ? "Drop your spec PDF here" : "Drop your specification PDF here"}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {isDragging ? "Release to begin extraction" : "or click to browse (PDF — any size)"}
                      </p>
                    </div>
                  </div>
                )}

                {fileError && (
                  <div className="mt-4 flex items-center justify-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    {fileError}
                  </div>
                )}
              </div>

              <div className="mx-auto max-w-md">
                <Label htmlFor="se-project-name" className="flex items-center gap-2 text-sm font-medium text-foreground mb-2">
                  <Building2 className="h-4 w-4" />
                  Project Name
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                </Label>
                <ProjectNameComboBox
                  value={projectName}
                  onChange={setProjectName}
                  placeholder="Select from estimating bids or type a name"
                  className="w-full"
                  data-testid="input-se-project-name"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Pick from active bids or type a custom name. AI will suggest if left blank.
                </p>
              </div>

              <div className="mx-auto max-w-2xl">
                <Label htmlFor="se-toc-hints" className="flex items-center gap-2 text-sm font-medium text-foreground mb-2">
                  <ClipboardList className="h-4 w-4" />
                  Table of Contents Section Hints
                  <span className="text-xs font-semibold" style={{ color: '#C9A84C' }}>Recommended for Best Results</span>
                </Label>
                <div className="rounded-md border-l-4 px-3 py-2.5 mb-2 text-sm" style={{ borderColor: '#C9A84C', background: 'rgba(201,168,76,0.08)' }}>
                  <p className="font-medium" style={{ color: '#C9A84C' }}>
                    Copy and paste the Division 10 section list from your spec's Table of Contents here. This significantly improves accuracy and ensures no sections are missed.
                  </p>
                </div>
                <Textarea
                  id="se-toc-hints"
                  placeholder={"Paste a snippet from the Table of Contents to guide extraction.\nExample:\n10 21 13 - TOILET COMPARTMENTS\n10 22 13 - WIRE MESH PARTITIONS\n10 28 00 - TOILET ACCESSORIES"}
                  value={tocHints}
                  onChange={(e) => setTocHints(e.target.value)}
                  className="w-full min-h-[100px] font-mono text-sm"
                  data-testid="textarea-toc-hints"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Paste the Division 10 section numbers and names from your spec's Table of Contents. This helps the extractor find every relevant section.
                </p>
                {tocHints.trim() && (
                  <div className="mt-2 flex items-center gap-2">
                    <Badge variant="secondary">
                      {tocHints.trim().split(/[\n\r]+/).filter(l => l.trim()).length} lines
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setTocHints("")}
                      data-testid="button-clear-toc-hints"
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </div>

              {accessoryScopes.length > 0 && (
                <div className="mx-auto max-w-2xl">
                  <Label className="flex items-center gap-2 text-sm font-medium text-foreground mb-3">
                    <Package className="h-4 w-4" />
                    Accessory Scopes
                    <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <p className="text-xs text-muted-foreground mb-3">
                    Select accessory types to search for in the spec. Matched sections will be suggested alongside Division 10 sections for your review.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {accessoryScopes.map((scope) => {
                      const isActive = selectedAccessories.has(scope.name);
                      return (
                        <div
                          key={scope.name}
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleAccessory(scope.name)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleAccessory(scope.name); } }}
                          className={cn(
                            "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors cursor-pointer",
                            isActive
                              ? "border-[var(--gold)] text-foreground"
                              : "border-border text-muted-foreground hover-elevate"
                          )}
                          style={isActive ? { background: "rgba(200,164,78,0.06)" } : undefined}
                          data-testid={`button-accessory-${scope.name.replace(/[\s\/]/g, "-").toLowerCase()}`}
                        >
                          <Checkbox
                            checked={isActive}
                            onCheckedChange={() => toggleAccessory(scope.name)}
                            className="pointer-events-none"
                            data-testid={`checkbox-accessory-${scope.name.replace(/[\s\/]/g, "-").toLowerCase()}`}
                          />
                          <span className="block truncate font-medium text-xs">{scope.name}</span>
                        </div>
                      );
                    })}
                  </div>
                  {selectedAccessories.size > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <Badge variant="secondary">{selectedAccessories.size} selected</Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedAccessories(new Set())}
                        data-testid="button-clear-accessories"
                      >
                        Clear
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-16">
                <div className="grid gap-8 md:grid-cols-3">
                  {[
                    { icon: FileText, title: "Division 10 Detection", description: "Regex-based scanning identifies all Division 10 specification sections" },
                    { icon: FolderOpen, title: "Organized Export", description: "Each section exported as a separate PDF in its own named folder" },
                    { icon: FileStack, title: "Accurate Boundaries", description: "End-of-section markers and header detection prevent page bleeding" },
                  ].map((f) => (
                    <div key={f.title} className="flex flex-col items-center text-center">
                      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg" style={{ background: "rgba(200,164,78,0.1)" }}>
                        <f.icon className="h-6 w-6" style={{ color: "var(--gold)" }} />
                      </div>
                      <h3 className="text-base font-semibold text-foreground font-heading">{f.title}</h3>
                      <p className="mt-2 text-sm text-muted-foreground">{f.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {viewState === "processing" && sessionData && (
            <div className="mx-auto max-w-2xl">
              <Card>
                <CardContent className="p-6">
                  <div className="flex items-start gap-4">
                    <div className={cn(
                      "rounded-full p-3",
                      sessionData.status === "error" ? "bg-destructive/10" : sessionData.status !== "processing" ? "bg-green-900/30" : ""
                    )} style={sessionData.status === "processing" ? { background: "rgba(200,164,78,0.1)" } : undefined}>
                      {sessionData.status === "processing" ? (
                        <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--gold)" }} />
                      ) : sessionData.status === "error" ? (
                        <AlertCircle className="h-6 w-6 text-destructive" />
                      ) : (
                        <CheckCircle2 className="h-6 w-6 text-green-500" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-foreground font-heading">
                          {sessionData.status === "processing" ? "Processing" : sessionData.status === "error" ? "Error" : "Complete"}
                        </h3>
                        <Badge variant="secondary" data-testid="badge-se-status">{sessionData.status}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground" data-testid="text-se-message">{sessionData.message}</p>
                      {sessionData.status === "processing" && (
                        <div className="mt-3">
                          <Progress value={sessionData.progress} className="h-2" data-testid="progress-se" />
                          <p className="mt-1 text-xs text-muted-foreground">{sessionData.progress}%</p>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {sessionData.status === "error" && (
                <div className="flex justify-center mt-6">
                  <Button variant="outline" onClick={handleReset} data-testid="button-se-try-again">
                    Try Another File
                  </Button>
                </div>
              )}
            </div>
          )}

          {viewState === "results" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <Button variant="ghost" onClick={handleReset} data-testid="button-se-back">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    New Extraction
                  </Button>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" data-testid="badge-se-section-count">{div10Sections.length} Div 10</Badge>
                    {div11Sections.length > 0 && (
                      <Badge variant="secondary" data-testid="badge-se-div11-count">{div11Sections.length} Div 11</Badge>
                    )}
                    {div12Sections.length > 0 && (
                      <Badge variant="secondary" data-testid="badge-se-div12-count">{div12Sections.length} Div 12</Badge>
                    )}
                    {accessorySections.length > 0 && (
                      <Badge variant="secondary" data-testid="badge-se-accessory-count">{accessorySections.length} Accessory</Badge>
                    )}
                    <Badge variant="secondary" data-testid="badge-se-page-count">{totalPages} pages</Badge>
                    {signageCount > 0 && (
                      <Badge variant="outline" data-testid="badge-se-signage-excluded">
                        <Ban className="mr-1 h-3 w-3" />
                        {signageCount} signage excluded
                      </Badge>
                    )}
                    {selectedCount < sections.length && (
                      <Badge variant="outline" data-testid="badge-se-selected-count">{selectedCount} selected</Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    onClick={handleAiReview}
                    disabled={isReviewing || sections.length === 0 || isViewer}
                    data-testid="button-se-ai-review"
                  >
                    {isReviewing ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Reviewing...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" />
                        AI Review Labels
                      </>
                    )}
                  </Button>
                  <Button
                    onClick={handleExport}
                    disabled={isExporting || selectedCount === 0 || isViewer}
                    data-testid="button-se-export"
                  >
                    {isExporting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Exporting...
                      </>
                    ) : (
                      <>
                        <Download className="mr-2 h-4 w-4" />
                        Download ZIP ({selectedCount})
                      </>
                    )}
                  </Button>
                </div>
              </div>

              <Card>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-medium text-muted-foreground shrink-0">Project Name:</span>
                    {isEditingProjectName ? (
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <ProjectNameComboBox
                          inputRef={projectNameInputRef}
                          value={resultsProjectName}
                          onChange={setResultsProjectName}
                          onBlur={saveProjectName}
                          onKeyDown={handleProjectNameKeyDown}
                          className="flex-1 min-w-0"
                          placeholder="Select or type project name"
                          data-testid="input-se-results-project-name"
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "text-sm font-semibold truncate",
                            resultsProjectName ? "text-foreground" : "text-muted-foreground italic"
                          )}
                          data-testid="text-se-results-project-name"
                        >
                          {resultsProjectName || "No project name set"}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={startEditingProjectName}
                          disabled={isViewer}
                          data-testid="button-se-edit-project-name"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                    {suggestedProjectName && suggestedProjectName !== resultsProjectName && (
                      <div className="flex items-center gap-2 ml-auto">
                        <Badge variant="outline" className="shrink-0">
                          <Sparkles className="mr-1 h-3 w-3" />
                          AI Suggested
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={applySuggestedProjectName}
                          disabled={isViewer}
                          data-testid="button-se-apply-suggested-name"
                        >
                          Use: "{suggestedProjectName}"
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {sections.length === 0 ? (
                <Card>
                  <CardContent className="p-8 text-center">
                    <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
                    <p className="text-muted-foreground">No Division 10 sections were found in this document.</p>
                    <Button variant="outline" onClick={handleReset} className="mt-4" data-testid="button-se-try-another">
                      Try Another File
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-3">
                  <div className="flex items-center gap-3 px-1">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={toggleAll}
                      data-testid="checkbox-se-select-all"
                    />
                    <span className="text-sm text-muted-foreground">
                      {allSelected ? "Deselect all" : "Select all"}
                    </span>
                  </div>

                  {sortedSections.map((section, idx) => {
                    const isSelected = selectedSections.has(section.id);
                    const isPreviewing = previewSectionId === section.id;
                    const review = aiReviews.get(section.id);
                    const isEditingThisFolder = editingFolderId === section.id;
                    const isFirstOfGroup = idx === 0 || sortedSections[idx - 1]?.sectionType !== section.sectionType;
                    const showGroupHeader = presentGroupCount > 1 && isFirstOfGroup;
                    const groupLabel = sectionGroupLabels[section.sectionType] || `${section.sectionType} Sections`;
                    const GroupIcon = section.sectionType === "accessory" ? Package : FileText;

                    return (
                      <div key={section.id}>
                        {showGroupHeader && (
                          <div className="flex items-center gap-2 px-1 pt-4 pb-1">
                            <GroupIcon className="h-4 w-4 text-muted-foreground" />
                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{groupLabel}</span>
                          </div>
                        )}
                        <Card
                          className={cn(
                            "transition-colors",
                            !isSelected && "opacity-60"
                          )}
                          data-testid={`card-se-section-${section.sectionNumber.replace(/\s/g, "")}`}
                        >
                          <CardContent className="p-4">
                            <div className="flex items-start gap-3">
                              <div className="flex items-center pt-0.5">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={() => toggleSection(section.id)}
                                  data-testid={`checkbox-se-section-${section.sectionNumber.replace(/\s/g, "")}`}
                                />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                  <div className="flex items-center gap-3 min-w-0">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-md shrink-0" style={{ background: "rgba(200,164,78,0.1)" }}>
                                      <FileText className="h-4 w-4" style={{ color: "var(--gold)" }} />
                                    </div>
                                    <div className="min-w-0">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-mono text-sm font-semibold text-foreground" data-testid={`text-se-secnum-${section.sectionNumber.replace(/\s/g, "")}`}>
                                          {section.sectionNumber}
                                        </span>
                                        <span className="text-sm text-foreground truncate" data-testid={`text-se-title-${section.sectionNumber.replace(/\s/g, "")}`}>
                                          {section.title}
                                        </span>
                                      </div>
                                      <p className="text-xs text-muted-foreground mt-0.5">
                                        Pages {section.startPage + 1}–{section.endPage + 1} ({section.pageCount} {section.pageCount === 1 ? "page" : "pages"})
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {section.isSignage && (
                                      <Badge variant="outline" className="shrink-0 text-muted-foreground">
                                        <Ban className="mr-1 h-3 w-3" />
                                        Signage
                                      </Badge>
                                    )}
                                    {section.sectionType === "accessory" && (
                                      <Badge variant="secondary" className="shrink-0">
                                        <Package className="mr-1 h-3 w-3" />
                                        Accessory
                                      </Badge>
                                    )}
                                    {section.matchedKeywords && section.matchedKeywords.length > 0 && (
                                      <Badge variant="outline" className="shrink-0">
                                        <Tag className="mr-1 h-3 w-3" />
                                        {section.matchedKeywords.join(", ")}
                                      </Badge>
                                    )}
                                    {review && review.status === "not_div10" && (
                                      <Badge variant="destructive" className="shrink-0">
                                        <AlertTriangle className="mr-1 h-3 w-3" />
                                        Not Div 10
                                      </Badge>
                                    )}
                                    {review && review.status !== "correct" && review.status !== "not_div10" && (
                                      <Badge
                                        variant={review.status === "suggested_change" ? "default" : "secondary"}
                                        className="shrink-0"
                                      >
                                        {review.status === "suggested_change" ? "Suggestion" : "Warning"}
                                      </Badge>
                                    )}
                                    {review && review.status === "correct" && (
                                      <Badge variant="outline" className="shrink-0">
                                        <Check className="mr-1 h-3 w-3" />
                                        Verified
                                      </Badge>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => handlePreview(section.id)}
                                      data-testid={`button-se-preview-${section.sectionNumber.replace(/\s/g, "")}`}
                                    >
                                      {isPreviewing ? (
                                        <EyeOff className="h-4 w-4" />
                                      ) : (
                                        <Eye className="h-4 w-4" />
                                      )}
                                    </Button>
                                  </div>
                                </div>

                                <div className="mt-2 flex items-center gap-2">
                                  <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  {isEditingThisFolder ? (
                                    <Input
                                      ref={folderInputRef}
                                      value={editingFolderValue}
                                      onChange={(e) => setEditingFolderValue(e.target.value)}
                                      onBlur={() => saveFolder(section.id)}
                                      onKeyDown={(e) => handleFolderKeyDown(e, section.id)}
                                      className="flex-1 text-xs"
                                      data-testid={`input-se-folder-${section.sectionNumber.replace(/\s/g, "")}`}
                                    />
                                  ) : (
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="text-xs text-muted-foreground truncate" data-testid={`text-se-folder-${section.sectionNumber.replace(/\s/g, "")}`}>
                                        {section.folderName}
                                      </span>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => startEditingFolder(section.id, section.folderName)}
                                        disabled={isViewer}
                                        data-testid={`button-se-edit-folder-${section.sectionNumber.replace(/\s/g, "")}`}
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  )}
                                </div>

                                {review && review.status === "suggested_change" && (
                                  <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm flex-wrap">
                                    <Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-muted-foreground">{review.notes}</span>
                                    {review.suggestedTitle !== section.title && (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => applyAiSuggestion(section.id, review.suggestedTitle)}
                                        disabled={isViewer}
                                        data-testid={`button-se-apply-${section.sectionNumber.replace(/\s/g, "")}`}
                                      >
                                        Apply: "{review.suggestedTitle}"
                                      </Button>
                                    )}
                                  </div>
                                )}

                                {review && review.status === "warning" && (
                                  <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm">
                                    <AlertCircle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                    <span className="text-muted-foreground">{review.notes}</span>
                                  </div>
                                )}

                                {review && review.status === "not_div10" && (
                                  <div className="mt-2 flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm">
                                    <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                                    <span className="text-muted-foreground">{review.notes || "AI determined this is not a Division 10 specification section"}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>

                        {isPreviewing && (
                          <Card className="ml-10 mt-1 mb-2">
                            <CardContent className="p-4">
                              {isLoadingPreview ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  Loading preview...
                                </div>
                              ) : previewData ? (
                                <div className="space-y-3">
                                  <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <p className="text-xs font-medium text-muted-foreground">
                                      Preview: Pages {previewData.startPage}–{previewData.endPage} ({previewData.pageCount} total)
                                    </p>
                                  </div>
                                  {previewData.previewPages.map((pp) => (
                                    <div key={pp.pageNumber} className="space-y-1">
                                      <p className="text-xs font-semibold text-muted-foreground">
                                        Page {pp.pageNumber}
                                      </p>
                                      <pre
                                        className="rounded-md bg-muted/50 p-3 text-xs text-foreground overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto font-mono leading-relaxed"
                                        data-testid={`text-se-preview-page-${pp.pageNumber}`}
                                      >
                                        {pp.text || "(No text content on this page)"}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-sm text-muted-foreground">No preview available</p>
                              )}
                            </CardContent>
                          </Card>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
