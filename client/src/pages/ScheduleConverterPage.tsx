import { useState, useCallback, useRef, Fragment } from "react";
import { useMutation } from "@tanstack/react-query";
import { useToolUsage } from "@/lib/useToolUsage";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ImageIcon,
  Camera,
  Loader2,
  Copy,
  CheckCircle2,
  AlertTriangle,
  Check,
  RotateCcw,
  Download,
  ShieldCheck,
  Type,

  X,
  Plus,
  ClipboardPaste,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { guardViewer } from "@/lib/viewerGuard";
import { Link } from "wouter";
import { BackNav } from "@/components/BackNav";
import * as XLSX from "xlsx";
import { copyTsvWithFormatting } from "@/lib/clipboardUtils";

interface ScheduleItem {
  planCallout: string;
  description: string;
  manufacturer: string;
  rawModel: string;
  modelNumber: string;
  quantity: number;
  sourceSection: string;
  confidence: number;
  flags: string[];
  needsReview: boolean;
  sourceIndex?: number;
}

interface QueuedImage {
  file: File;
  preview: string;
}

interface ExtractionResult {
  items: ScheduleItem[];
  rawText: string;
  processingTimeMs: number;
  modelUsed?: string;
  retried?: boolean;
  continuationUsed?: boolean;
  possibleTruncation?: boolean;
  totalRowCount?: number;
  verified?: boolean;
}

export default function ScheduleConverterPage() {
  useToolUsage("scheduleconverter");
  const { toast } = useToast();
  const { isViewer } = useAuth();
  const [inputMode, setInputMode] = useState<"image" | "text">("image");
  const [imageQueue, setImageQueue] = useState<QueuedImage[]>([]);
  const [scheduleText, setScheduleText] = useState<string>("");
  const [pasteCount, setPasteCount] = useState(0);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [editedItems, setEditedItems] = useState<ScheduleItem[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; col: string } | null>(null);
  const [editDraft, setEditDraft] = useState<string>("");
  const [isFocused, setIsFocused] = useState(false);
  const [outputMode, setOutputMode] = useState<"nbs" | "excel">("nbs");
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);
  const [imageCount, setImageCount] = useState(0);

  const addImageFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    const readPromises = imageFiles.map((file) =>
      new Promise<QueuedImage>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve({ file, preview: e.target?.result as string });
        reader.readAsDataURL(file);
      })
    );
    Promise.all(readPromises).then((newEntries) => {
      setImageQueue(prev => [...prev, ...newEntries]);
    });
    setResult(null);
    setEditedItems([]);
    setEditingCell(null);
  }, []);

  const removeQueuedImage = useCallback((index: number) => {
    setImageQueue(prev => prev.filter((_, i) => i !== index));
  }, []);

  const extractSingleImage = async (file: File): Promise<ExtractionResult> => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.split(",")[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const response = await fetch("/api/toolbelt/schedule-to-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mimeType: file.type || "image/png" }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || "Failed to extract schedule");
    }
    return data as ExtractionResult;
  };

  const extractMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const allItems: ScheduleItem[] = [];
      let totalProcessingTime = 0;
      let anyTruncation = false;
      let anyContinuation = false;
      let anyVerified = false;
      let lastModel = "";
      let totalExpectedRows = 0;

      for (let i = 0; i < files.length; i++) {
        setBatchProgress({ current: i + 1, total: files.length });
        const data = await extractSingleImage(files[i]);
        const taggedItems = data.items.map(item => ({ ...item, sourceIndex: i }));
        allItems.push(...taggedItems);
        totalProcessingTime += data.processingTimeMs;
        if (data.possibleTruncation) anyTruncation = true;
        if (data.continuationUsed) anyContinuation = true;
        if (data.verified) anyVerified = true;
        if (data.modelUsed) lastModel = data.modelUsed;
        totalExpectedRows += data.totalRowCount || 0;
      }

      const imageTotal = files.length;
      return {
        items: allItems,
        rawText: "",
        processingTimeMs: totalProcessingTime,
        modelUsed: lastModel,
        retried: false,
        continuationUsed: anyContinuation,
        possibleTruncation: anyTruncation,
        totalRowCount: totalExpectedRows,
        verified: anyVerified,
        _imageCount: imageTotal,
      } as ExtractionResult & { _imageCount: number };
    },
    onSuccess: (data: ExtractionResult & { _imageCount?: number }) => {
      const imgTotal = data._imageCount || 1;
      setResult(data);
      setEditedItems(data.items.map(item => ({ ...item })));
      setImageCount(imgTotal);
      setBatchProgress(null);
      const imgCountStr = imgTotal > 1 ? ` from ${imgTotal} screenshots` : "";
      toast({
        title: data.possibleTruncation ? "Schedule Partially Extracted" : "Schedule Extracted",
        description: `Found ${data.items.length} line item${data.items.length !== 1 ? "s" : ""}${imgCountStr} in ${(data.processingTimeMs / 1000).toFixed(1)}s`,
        variant: data.possibleTruncation ? "destructive" : "default",
      });
    },
    onError: (error: Error) => {
      setBatchProgress(null);
      toast({
        title: "Extraction Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const textExtractMutation = useMutation({
    mutationFn: async (text: string) => {
      const response = await fetch("/api/toolbelt/schedule-text-to-estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to extract schedule from text");
      }
      return data as ExtractionResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setEditedItems(data.items.map(item => ({ ...item })));
      const modelInfo = data.modelUsed ? ` via ${data.modelUsed}` : "";
      toast({
        title: "Schedule Extracted",
        description: `Found ${data.items.length} line item${data.items.length !== 1 ? "s" : ""} in ${(data.processingTimeMs / 1000).toFixed(1)}s${modelInfo}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Extraction Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) addImageFiles(files);
  }, [addImageFiles]);

  const handleClickPaste = useCallback(async () => {
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find(t => t.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const file = new File([blob], "pasted-screenshot.png", { type: imageType });
          addImageFiles([file]);
          return;
        }
      }
      toast({ title: "No image found in clipboard", description: "Copy a screenshot first, then click here to paste it.", variant: "destructive" });
    } catch {
      toast({ title: "Could not read clipboard", description: "Use Ctrl+V to paste, or browse for a file instead.", variant: "destructive" });
    }
  }, [addImageFiles, toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsFocused(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length > 0) addImageFiles(files);
  }, [addImageFiles]);

  const startCellEdit = (row: number, col: string) => {
    const item = editedItems[row];
    const value = col === "quantity" ? String(item.quantity) : (item as any)[col] ?? "";
    setEditingCell({ row, col });
    setEditDraft(value);
  };

  const saveCellEdit = () => {
    if (!editingCell) return;
    const { row, col } = editingCell;
    setEditedItems(prev => {
      const updated = [...prev];
      if (col === "quantity") {
        updated[row] = { ...updated[row], quantity: parseInt(editDraft) || 0 };
      } else {
        updated[row] = { ...updated[row], [col]: editDraft };
      }
      return updated;
    });
    setEditingCell(null);
    setEditDraft("");
  };

  const cancelCellEdit = () => {
    setEditingCell(null);
    setEditDraft("");
  };

  const handleCellKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveCellEdit();
    } else if (e.key === "Escape") {
      cancelCellEdit();
    }
  };

  const toggleReview = (idx: number) => {
    setEditedItems(prev => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], needsReview: !updated[idx].needsReview };
      return updated;
    });
  };

  const allSelected = editedItems.length > 0 && editedItems.every(i => !i.needsReview);
  const noneSelected = editedItems.length > 0 && editedItems.every(i => i.needsReview);

  const toggleSelectAll = () => {
    const newVal = !allSelected;
    setEditedItems(prev => prev.map(i => ({ ...i, needsReview: !newVal })));
  };

  const copyTSV = useCallback(async () => {
    const headers = ["PLAN CALLOUT", "DESCRIPTION", "MODEL NUMBER", "ITEM QUANTITY"];
    const rows = editedItems.map(item =>
      [item.planCallout || "", item.description || "", item.modelNumber || "", item.quantity != null ? String(item.quantity) : ""]
    );
    await copyTsvWithFormatting(headers, rows);
    toast({ title: "Copied!", description: "Table copied to clipboard as TSV (NBS format)" });
  }, [editedItems, toast]);

  const copyApproved = useCallback(async () => {
    const approved = editedItems.filter(item => !item.needsReview);
    if (approved.length === 0) {
      toast({ title: "No rows approved", description: "All rows are flagged for review", variant: "destructive" });
      return;
    }
    const headers = ["PLAN CALLOUT", "DESCRIPTION", "MODEL NUMBER", "ITEM QUANTITY"];
    const rows = approved.map(item =>
      [item.planCallout || "", item.description || "", item.modelNumber || "", item.quantity != null ? String(item.quantity) : ""]
    );
    await copyTsvWithFormatting(headers, rows);
    toast({
      title: "Approved rows copied!",
      description: `${approved.length} row${approved.length !== 1 ? "s" : ""} copied to clipboard (NBS format)`,
    });
  }, [editedItems, toast]);

  const downloadExcel = useCallback(() => {
    const headers = ["Plan Callout", "Description", "Manufacturer", "Model", "Quantity", "Source Section"];
    const rows = editedItems.map(item => [
      item.planCallout || "",
      item.description || "",
      item.manufacturer || "",
      item.rawModel || "",
      item.quantity != null ? item.quantity : 0,
      item.sourceSection || "",
    ]);

    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    ws["!cols"] = [
      { wch: 14 },
      { wch: 55 },
      { wch: 18 },
      { wch: 22 },
      { wch: 10 },
      { wch: 28 },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Schedule");

    const today = new Date().toISOString().split("T")[0];
    XLSX.writeFile(wb, `Schedule_Extract_${today}.xlsx`);

    toast({
      title: "Excel downloaded!",
      description: `${editedItems.length} row${editedItems.length !== 1 ? "s" : ""} exported with all columns`,
    });
  }, [editedItems, toast]);

  const resetToOriginal = () => {
    if (result) {
      setEditedItems(result.items.map(item => ({ ...item })));
      setEditingCell(null);
      toast({ title: "Reset", description: "All edits reverted to original extraction" });
    }
  };

  const reviewCount = editedItems.filter(i => i.needsReview).length;
  const totalCount = editedItems.length;
  const expectedCount = result?.totalRowCount || 0;
  const countMismatch = expectedCount > 0 && totalCount !== expectedCount;

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 90) return <Badge variant="outline" className="text-green-600 border-green-600/30 bg-green-500/10 text-xs" data-testid="badge-confidence-high">{confidence}%</Badge>;
    if (confidence >= 60) return <Badge variant="outline" className="text-yellow-600 border-yellow-600/30 bg-yellow-500/10 text-xs" data-testid="badge-confidence-medium">{confidence}%</Badge>;
    return <Badge variant="outline" className="text-red-600 border-red-600/30 bg-red-500/10 text-xs" data-testid="badge-confidence-low">{confidence}%</Badge>;
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background animate-page-enter">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <ReadOnlyBanner />
        <div className="mb-8">
          <div className="flex items-center justify-between gap-4 flex-wrap mb-2">
            <div className="flex items-center gap-3">
              <BackNav href="/" label="Home" testId="button-back-home" />
              <h1 className="text-2xl font-semibold text-foreground font-heading">
                Schedule Converter
              </h1>
            </div>
          </div>
          <p className="text-muted-foreground ml-12">
            Upload a schedule screenshot or paste schedule text to extract line items into a copy/paste-ready estimate table.
          </p>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <div className="flex items-center rounded-md border border-border overflow-hidden" data-testid="toggle-input-mode">
            <button
              type="button"
              onClick={() => setInputMode("image")}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-heading font-semibold uppercase tracking-wide transition-colors"
              style={{
                background: inputMode === "image" ? "var(--gold)" : "transparent",
                color: inputMode === "image" ? "var(--bg)" : "var(--text-dim)",
              }}
              data-testid="toggle-input-image"
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Image
            </button>
            <button
              type="button"
              onClick={() => setInputMode("text")}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-heading font-semibold uppercase tracking-wide transition-colors border-l border-border"
              style={{
                background: inputMode === "text" ? "var(--gold)" : "transparent",
                color: inputMode === "text" ? "var(--bg)" : "var(--text-dim)",
              }}
              data-testid="toggle-input-text"
            >
              <Type className="w-3.5 h-3.5" />
              Text
            </button>
          </div>
        </div>

        {inputMode === "image" ? (
          <Card className="p-6 mb-8 card-accent-bar">
            <div className="flex items-center gap-2 mb-4">
              <ImageIcon className="w-5 h-5" style={{ color: "var(--gold)" }} />
              <h2 className="font-medium font-heading">Schedule Screenshots</h2>
              {imageQueue.length > 0 && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-queue-count">
                  {imageQueue.length} image{imageQueue.length !== 1 ? "s" : ""} queued
                </Badge>
              )}
            </div>

            {imageQueue.length > 0 && (
              <div className="mb-4">
                <div className="flex flex-wrap gap-3" data-testid="thumbnail-strip">
                  {imageQueue.map((qi, idx) => (
                    <div key={idx} className="relative group" data-testid={`thumbnail-${idx}`}>
                      <img
                        src={qi.preview}
                        alt={`Screenshot ${idx + 1}`}
                        className="h-24 w-auto rounded-md border border-border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeQueuedImage(idx)}
                        className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        data-testid={`button-remove-thumbnail-${idx}`}
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <div className="absolute bottom-1 left-1 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                        {idx + 1}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="h-24 w-20 rounded-md border-2 border-dashed border-border hover:border-[var(--gold)] flex flex-col items-center justify-center gap-1 transition-colors"
                    data-testid="button-add-more"
                  >
                    <Plus className="w-5 h-5 text-muted-foreground" />
                    <span className="text-[10px] text-muted-foreground">Add more</span>
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setImageQueue([]);
                      setResult(null);
                      setEditedItems([]);
                      setImageCount(0);
                    }}
                    data-testid="button-clear-all-images"
                  >
                    Clear all
                  </Button>
                </div>
              </div>
            )}

            <div
              tabIndex={0}
              onPaste={handlePaste}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onDragOver={(e) => { e.preventDefault(); setIsFocused(true); }}
              onDragLeave={() => setIsFocused(false)}
              onDrop={handleDrop}
              onClick={handleClickPaste}
              className={`border-2 border-dashed rounded-md p-8 text-center cursor-pointer transition-all duration-200 outline-none ${
                isFocused
                  ? "border-[var(--gold)] ring-2 ring-[rgba(200,164,78,0.3)]"
                  : imageQueue.length > 0
                  ? "border-green-500/30 bg-green-950/10"
                  : "border-border hover:border-[rgba(200,164,78,0.5)]"
              }`}
              style={isFocused ? { background: "rgba(200,164,78,0.1)" } : undefined}
              data-testid="dropzone-schedule"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length > 0) addImageFiles(files);
                  e.target.value = "";
                }}
                data-testid="input-schedule-file"
              />
              {imageQueue.length > 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle2 className="w-6 h-6 text-green-600" />
                  <p className="text-sm text-muted-foreground">
                    Drag more screenshots here, click to paste, press <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">Ctrl+V</kbd>, or use the + button above
                  </p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Camera className="w-10 h-10" style={{ color: "rgba(200,164,78,0.7)" }} />
                  <p className="font-medium text-foreground">
                    Click to paste from clipboard
                  </p>
                  <p className="text-sm text-muted-foreground">
                    or drag and drop one or more screenshots, or press <kbd className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">Ctrl+V</kbd>
                  </p>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    className="text-xs hover:underline mt-1"
                    style={{ color: "var(--gold)" }}
                    data-testid="button-browse-files"
                  >
                    Browse files instead
                  </button>
                </div>
              )}
            </div>
          </Card>
        ) : (
          <Card className="p-6 mb-8 card-accent-bar">
            <div className="flex items-center gap-2 mb-4">
              <Type className="w-5 h-5" style={{ color: "var(--gold)" }} />
              <h2 className="font-medium font-heading">Schedule Text</h2>
            </div>

            {/* Click-to-paste button row */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (!text.trim()) return;
                    setScheduleText(prev =>
                      prev.trim()
                        ? prev + "\n\n--- Paste #" + (pasteCount + 2) + " ---\n" + text
                        : text
                    );
                    setPasteCount(c => c + 1);
                  } catch {
                    toast({
                      title: "Paste blocked",
                      description: "Click inside the text area below and use Ctrl+V / Cmd+V instead.",
                      variant: "destructive",
                    });
                  }
                }}
                className="flex items-center gap-2"
                style={{ background: "var(--gold)", color: "#000" }}
                data-testid="button-click-to-paste"
              >
                <ClipboardPaste className="w-4 h-4" />
                Click to Paste from Clipboard
              </Button>

              {pasteCount > 0 && (
                <span
                  className="text-xs px-2 py-1 rounded-full"
                  style={{ background: "rgba(200,164,78,0.15)", color: "var(--gold)" }}
                  data-testid="badge-paste-count"
                >
                  {pasteCount} paste{pasteCount !== 1 ? "s" : ""} accumulated
                </span>
              )}

              {scheduleText.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setScheduleText(""); setPasteCount(0); setResult(null); setEditedItems([]); }}
                  className="ml-auto text-muted-foreground"
                  data-testid="button-clear-text"
                >
                  Clear All
                </Button>
              )}
            </div>

            <p className="text-xs text-muted-foreground mb-2">
              Each paste appends to the list below — paste from multiple pages to combine them, then extract.
            </p>

            <textarea
              value={scheduleText}
              onChange={(e) => setScheduleText(e.target.value)}
              placeholder={"Paste schedule text here, or use the button above. Supports tab-separated, comma-separated, or free-form text.\n\nExample:\nTA-01\tPaper Towel Dispenser\tBobrick\tB-2621\t12\nTA-02\tSoap Dispenser\tASI\t0361\t8"}
              className="w-full min-h-[200px] rounded-md border border-border p-4 text-sm font-mono resize-y transition-colors focus:border-[var(--gold)] focus:outline-none focus:ring-2 focus:ring-[rgba(200,164,78,0.3)]"
              style={{ background: "var(--bg-input)", color: "var(--text)" }}
              data-testid="textarea-schedule-text"
            />
            <div className="flex items-center justify-between mt-2">
              <p className="text-xs text-muted-foreground">
                {scheduleText.trim() ? `${scheduleText.trim().split('\n').length} line${scheduleText.trim().split('\n').length !== 1 ? 's' : ''}` : 'No text entered'}
              </p>
            </div>
          </Card>
        )}

        <div className="flex justify-center mb-8">
          {inputMode === "image" ? (
            <Button
              size="lg"
              onClick={() => { if (guardViewer(isViewer, toast)) return; imageQueue.length > 0 && extractMutation.mutate(imageQueue.map(q => q.file)); }}
              disabled={imageQueue.length === 0 || extractMutation.isPending || isViewer}
              data-testid="button-extract"
            >
              {extractMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {batchProgress && batchProgress.total > 1
                    ? `Processing ${batchProgress.current} of ${batchProgress.total}...`
                    : "Extracting..."}
                </>
              ) : (
                imageQueue.length > 1 ? `Extract All ${imageQueue.length} Screenshots` : "Extract Schedule"
              )}
            </Button>
          ) : (
            <Button
              size="lg"
              onClick={() => { if (guardViewer(isViewer, toast)) return; scheduleText.trim() && textExtractMutation.mutate(scheduleText); }}
              disabled={!scheduleText.trim() || textExtractMutation.isPending || isViewer}
              data-testid="button-extract-text"
            >
              {textExtractMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Extracting...
                </>
              ) : pasteCount > 1 ? (
                `Extract Schedule (${pasteCount} pages combined)`
              ) : (
                "Extract Schedule"
              )}
            </Button>
          )}
        </div>

        {editedItems.length > 0 && (
          <>
            {result?.possibleTruncation && (
              <Card className="mb-4 border-yellow-500/50 bg-yellow-500/5" data-testid="warning-truncation">
                <div className="p-4 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-yellow-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Some rows may be missing</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      The schedule had too many rows for a single extraction pass. Please compare the results below against your original image. If rows are missing, try uploading a cropped portion of the schedule.
                    </p>
                  </div>
                </div>
              </Card>
            )}
            {result?.continuationUsed && !result?.possibleTruncation && (
              <Card className="mb-4 border-blue-500/30 bg-blue-500/5" data-testid="info-continuation">
                <div className="p-4 flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">
                      This schedule required multiple extraction passes to capture all rows. All items were successfully extracted.
                    </p>
                  </div>
                </div>
              </Card>
            )}
            {countMismatch && (
              <Card className="mb-4 border-amber-500/50 bg-amber-500/5" data-testid="warning-count-mismatch">
                <div className="p-4 flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium text-sm">Row count mismatch</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      AI detected {expectedCount} row{expectedCount !== 1 ? "s" : ""} in the image but extracted {totalCount}. Please verify against your original image.
                    </p>
                  </div>
                </div>
              </Card>
            )}
            <Card className="mb-6">
              <div className="p-4 border-b flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  <h2 className="font-medium font-heading">Extracted Items</h2>
                  {expectedCount > 0 && !countMismatch ? (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-row-count">
                      {totalCount} of {expectedCount} rows
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs" data-testid="badge-total-count">
                      {totalCount} item{totalCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                  {countMismatch && (
                    <Badge variant="outline" className="text-amber-500 border-amber-500/30 bg-amber-500/10 text-xs" data-testid="badge-count-warning">
                      Expected {expectedCount}
                    </Badge>
                  )}
                  {result?.verified && (
                    <Badge variant="outline" className="text-green-600 border-green-600/30 bg-green-500/10 text-xs" data-testid="badge-verified">
                      <ShieldCheck className="w-3 h-3 mr-1" />
                      Verified
                    </Badge>
                  )}
                  {reviewCount > 0 && (
                    <Badge variant="outline" className="text-yellow-600 border-yellow-600/30 bg-yellow-500/10 text-xs" data-testid="badge-review-count">
                      {reviewCount} need{reviewCount !== 1 ? "" : "s"} review
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetToOriginal}
                    data-testid="button-reset"
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                    Reset
                  </Button>
                  <div className="flex items-center rounded-md border border-border overflow-hidden" data-testid="toggle-output-mode">
                    <button
                      type="button"
                      onClick={() => setOutputMode("nbs")}
                      className="px-3 py-1.5 text-xs font-heading font-semibold uppercase tracking-wide transition-colors"
                      style={{
                        background: outputMode === "nbs" ? "var(--gold)" : "transparent",
                        color: outputMode === "nbs" ? "var(--bg)" : "var(--text-dim)",
                      }}
                      data-testid="toggle-nbs"
                    >
                      NBS Template
                    </button>
                    <button
                      type="button"
                      onClick={() => setOutputMode("excel")}
                      className="px-3 py-1.5 text-xs font-heading font-semibold uppercase tracking-wide transition-colors border-l border-border"
                      style={{
                        background: outputMode === "excel" ? "var(--gold)" : "transparent",
                        color: outputMode === "excel" ? "var(--bg)" : "var(--text-dim)",
                      }}
                      data-testid="toggle-excel"
                    >
                      Standard Excel
                    </button>
                  </div>
                  {outputMode === "nbs" ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={copyTSV}
                        data-testid="button-copy-all"
                      >
                        <Copy className="w-3.5 h-3.5 mr-1.5" />
                        Copy All (TSV)
                      </Button>
                      <Button
                        size="sm"
                        onClick={copyApproved}
                        data-testid="button-approve-copy"
                      >
                        <Check className="w-3.5 h-3.5 mr-1.5" />
                        Approve & Copy
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      onClick={downloadExcel}
                      data-testid="button-download-excel"
                    >
                      <Download className="w-3.5 h-3.5 mr-1.5" />
                      Download Excel
                    </Button>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          ref={(el) => {
                            if (el) {
                              const input = el.querySelector("button");
                              if (input) (input as any).indeterminate = !allSelected && !noneSelected;
                            }
                          }}
                          onCheckedChange={toggleSelectAll}
                          data-testid="checkbox-select-all"
                        />
                      </TableHead>
                      <TableHead className="min-w-[90px]">PLAN CALLOUT</TableHead>
                      <TableHead className="min-w-[250px]">DESCRIPTION</TableHead>
                      <TableHead className="min-w-[180px]">MODEL NUMBER</TableHead>
                      <TableHead className="min-w-[60px] text-center">QTY</TableHead>
                      <TableHead className="min-w-[70px] text-center">CONFIDENCE</TableHead>
                      <TableHead className="min-w-[150px]">FLAGS</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {editedItems.map((item, idx) => {
                      const isEditing = (col: string) =>
                        editingCell?.row === idx && editingCell?.col === col;

                      const showSourceDivider = imageCount > 1 &&
                        item.sourceIndex !== undefined &&
                        (idx === 0 || editedItems[idx - 1]?.sourceIndex !== item.sourceIndex);

                      const renderEditableCell = (col: string, display: React.ReactNode, className?: string) => (
                        <TableCell
                          className={`cursor-pointer ${className ?? ""}`}
                          onDoubleClick={() => startCellEdit(idx, col)}
                          data-testid={`cell-${col}-${idx}`}
                        >
                          {isEditing(col) ? (
                            <Input
                              autoFocus
                              type={col === "quantity" ? "number" : "text"}
                              value={editDraft}
                              onChange={(e) => setEditDraft(e.target.value)}
                              onKeyDown={handleCellKeyDown}
                              onBlur={saveCellEdit}
                              className={`h-8 text-sm ${col === "quantity" ? "text-center w-16" : ""} ${col === "planCallout" || col === "modelNumber" ? "font-mono" : ""}`}
                              data-testid={`input-${col}-${idx}`}
                            />
                          ) : (
                            display
                          )}
                        </TableCell>
                      );

                      return (
                        <Fragment key={`item-${idx}`}>
                        {showSourceDivider && (
                          <TableRow key={`divider-${item.sourceIndex}`} className="bg-muted/30 border-t-2 border-[var(--gold)]/20">
                            <TableCell colSpan={7} className="py-1.5 px-4">
                              <span className="text-xs font-heading font-semibold uppercase tracking-wide" style={{ color: "var(--gold)" }}>
                                Screenshot {(item.sourceIndex || 0) + 1}
                              </span>
                            </TableCell>
                          </TableRow>
                        )}
                        <TableRow
                          key={idx}
                          className={item.needsReview ? "bg-yellow-500/5" : ""}
                          data-testid={`row-item-${idx}`}
                        >
                          <TableCell>
                            <Checkbox
                              checked={!item.needsReview}
                              onCheckedChange={() => toggleReview(idx)}
                              data-testid={`checkbox-review-${idx}`}
                            />
                          </TableCell>
                          {renderEditableCell(
                            "planCallout",
                            <span className="font-mono text-sm">{item.planCallout}</span>,
                            "font-mono text-sm"
                          )}
                          {renderEditableCell(
                            "description",
                            <span className="text-sm">{item.description}</span>,
                            "text-sm"
                          )}
                          {renderEditableCell(
                            "modelNumber",
                            <span className="font-mono text-sm font-medium">{item.modelNumber}</span>,
                            "font-mono text-sm"
                          )}
                          {renderEditableCell(
                            "quantity",
                            <span className="text-sm">{item.quantity}</span>,
                            "text-center text-sm"
                          )}
                          <TableCell className="text-center">
                            {getConfidenceBadge(item.confidence)}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-1">
                              {item.flags.map((flag, fi) => (
                                <Badge key={fi} variant="outline" className="text-xs text-muted-foreground">
                                  {flag}
                                </Badge>
                              ))}
                              {item.flags.length === 0 && (
                                <span className="text-xs text-muted-foreground/50">None</span>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                        </Fragment>
                      );
                    })}
                    {editedItems.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                          No items extracted
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </Card>

            {result && (
              <Card className="p-4">
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-muted-foreground" data-testid="toggle-raw-text">
                    Extraction Details
                  </summary>
                  <div className="mt-3 p-3 bg-muted/50 rounded-md text-xs font-mono space-y-1">
                    <p>Model: {result.modelUsed || "unknown"}</p>
                    <p>Items extracted: {result.items.length}</p>
                    {expectedCount > 0 && <p>Rows detected in image: {expectedCount}</p>}
                    <p>Processing time: {(result.processingTimeMs / 1000).toFixed(1)}s</p>
                    {result.verified && <p className="text-green-400">Verification pass completed</p>}
                    {result.retried && <p className="text-amber-400">Auto-upgraded model for better accuracy</p>}
                    {result.continuationUsed && <p className="text-blue-400">Multi-pass extraction used</p>}
                  </div>
                </details>
              </Card>
            )}
          </>
        )}

        {extractMutation.isPending && (
          <Card className="p-8 text-center">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4" style={{ color: "var(--gold)" }} />
            <p className="text-muted-foreground">
              {batchProgress && batchProgress.total > 1
                ? `Analyzing screenshot ${batchProgress.current} of ${batchProgress.total}...`
                : "Analyzing schedule with AI vision..."}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {batchProgress && batchProgress.total > 1
                ? `Each screenshot takes 10-30 seconds`
                : "This may take 10-30 seconds (includes verification pass)"}
            </p>
            {batchProgress && batchProgress.total > 1 && (
              <div className="mt-4 max-w-xs mx-auto">
                <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                      background: "var(--gold)",
                    }}
                  />
                </div>
              </div>
            )}
          </Card>
        )}

        {!result && !extractMutation.isPending && imageQueue.length === 0 && (
          <Card className="p-8 text-center border-dashed">
            <AlertTriangle className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-muted-foreground text-sm">
              Upload one or more schedule screenshots (Appliance Schedule, Accessory Schedule, Plumbing Fixtures, etc.) to get started.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Upload multiple screenshots at once for multi-page schedules — all results merge into a single output table you can copy directly into Excel.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
