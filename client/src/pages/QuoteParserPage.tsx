import { useState, useCallback, useRef, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import { useToolUsage } from "@/lib/useToolUsage";
import { copyTsvWithFormatting } from "@/lib/clipboardUtils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Upload, FileText, Loader2, Copy, Download, CheckCircle2,
  AlertCircle, ClipboardPaste, Image, X, ThumbsUp, ThumbsDown,
  ChevronDown, ChevronUp, ShieldCheck, ShieldX, AlertTriangle,
  BookOpen, ListChecks, BadgeCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BackNav } from "@/components/BackNav";

interface ParsedRow {
  planCallout: string;
  description: string;
  modelNumber: string;
  qty: string;
  material: string;
  freight: string;
  unitPrice?: number | null;
  extendedPrice?: number | null;
  confidence?: number;
  confidenceNote?: string;
  lineType?: string;
  defaultChecked?: boolean;
  calloutConfidence?: number;
}

interface SpecCheck {
  status: "pass" | "fail" | "warn";
  message: string;
}

interface ScheduleCheck {
  scheduledCount: number;
  matchedCount: number;
  missing: Array<{ callout: string; description: string; modelNumber: string; qty: string }>;
  qtyMismatches: Array<{ callout: string; description: string; scheduledQty: string; quotedQty: string }>;
  extras: string[];
}

interface Verdict {
  status: "verified" | "needs_review";
  confirmations: string[];
  reviewItems: string[];
}

interface ParseResult {
  rows: ParsedRow[];
  errors: Array<{ type: string; message: string }>;
  warnings: string[];
  verdict: Verdict | null;
  specCheck: { checks: SpecCheck[] } | null;
  scheduleCheck: ScheduleCheck | null;
  vendorName: string | null;
  quoteNumber: string | null;
  taxTotal?: number;
  runId: number | null;
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined
    ? ""
    : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function EditableCell({
  value,
  onCommit,
  mono,
  center,
  placeholder,
  testId,
}: {
  value: string;
  onCommit: (next: string) => void;
  mono?: boolean;
  center?: boolean;
  placeholder?: string;
  testId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <div
        className={`cursor-text rounded px-1 -mx-1 min-h-[1.4rem] hover:bg-muted/50 ${mono ? "font-mono" : ""} ${center ? "text-center" : ""}`}
        title="Click to edit"
        onClick={() => { setDraft(value); setEditing(true); }}
        data-testid={testId}
      >
        {value || <span className="text-muted-foreground/40">{placeholder || "—"}</span>}
      </div>
    );
  }
  const commit = () => { setEditing(false); if (draft !== value) onCommit(draft); };
  return (
    <Input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      className={`h-7 px-1 text-sm ${mono ? "font-mono" : ""} ${center ? "text-center" : ""}`}
    />
  );
}

export default function QuoteParserPage() {
  useToolUsage("quoteparser");
  const { toast } = useToast();

  // Quote inputs — file, screenshot, and text can all be provided together;
  // the server combines them into one parse.
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteText, setQuoteText] = useState("");
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [pastedPreview, setPastedPreview] = useState<string | null>(null);
  const [pasteZoneFocused, setPasteZoneFocused] = useState(false);
  const pasteZoneRef = useRef<HTMLDivElement>(null);

  // Spec inputs (optional — Gate 2)
  const [specFile, setSpecFile] = useState<File | null>(null);
  const [specText, setSpecText] = useState("");

  // Schedule inputs (optional — Gate 3)
  const [scheduleFile, setScheduleFile] = useState<File | null>(null);
  const [scheduleText, setScheduleText] = useState("");

  // Result — rows live in their own state so cells can be edited before export.
  const [result, setResult] = useState<ParseResult | null>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [checkedRows, setCheckedRows] = useState<Set<number>>(new Set());
  const [specExpanded, setSpecExpanded] = useState(true);
  const [scheduleExpanded, setScheduleExpanded] = useState(true);
  const [verdictExpanded, setVerdictExpanded] = useState(true);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [thumbsUpSent, setThumbsUpSent] = useState(false);

  // Screenshot paste
  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (!pasteZoneFocused) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const blob = items[i].getAsFile();
        if (blob) {
          const file = new File([blob], `screenshot-${Date.now()}.png`, { type: blob.type });
          setPastedImage(file);
          setPastedPreview(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob); });
          toast({ title: "Screenshot Pasted", description: "Image ready to parse" });
        }
        return;
      }
    }
  }, [pasteZoneFocused, toast]);

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handlePaste]);

  const clearPastedImage = useCallback(() => {
    if (pastedPreview) URL.revokeObjectURL(pastedPreview);
    setPastedImage(null);
    setPastedPreview(null);
  }, [pastedPreview]);

  const quoteDropzone = useDropzone({
    accept: { "application/pdf": [".pdf"], "image/*": [".png", ".jpg", ".jpeg", ".heic"], "text/plain": [".txt"] },
    maxFiles: 1,
    onDrop: (files: File[]) => { if (files.length > 0) setQuoteFile(files[0]); },
  });

  const specDropzone = useDropzone({
    accept: { "application/pdf": [".pdf"], "image/*": [".png", ".jpg", ".jpeg", ".heic"], "text/plain": [".txt"] },
    maxFiles: 1,
    onDrop: (files: File[]) => { if (files.length > 0) setSpecFile(files[0]); },
  });

  const scheduleDropzone = useDropzone({
    accept: { "application/pdf": [".pdf"], "image/*": [".png", ".jpg", ".jpeg", ".heic"], "text/plain": [".txt"] },
    maxFiles: 1,
    onDrop: (files: File[]) => { if (files.length > 0) setScheduleFile(files[0]); },
  });

  // Parse mutation
  const parseMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      if (quoteFile) formData.append("quoteFile", quoteFile);
      if (pastedImage) formData.append("quoteImage", pastedImage);
      if (quoteText) formData.append("quoteText", quoteText);
      if (specFile) formData.append("specFile", specFile);
      if (specText) formData.append("specText", specText);
      if (scheduleFile) formData.append("scheduleFile", scheduleFile);
      if (scheduleText) formData.append("scheduleText", scheduleText);

      const response = await fetch("/api/quoteparser/parse", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.errors?.[0]?.message || "Failed to parse quote");
      return data as ParseResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setRows(data.rows);
      // Pre-select main material pieces (defaultChecked); leave accessories unchecked.
      // The summary row is always included on copy/download, so it is excluded here.
      const initial = new Set<number>();
      data.rows.forEach((row, idx) => {
        if (row.lineType !== "summary" && row.defaultChecked !== false) initial.add(idx);
      });
      setCheckedRows(initial);
      setFeedbackOpen(false);
      setFeedbackText("");
      setThumbsUpSent(false);
      toast({ title: "Quote Parsed", description: "Review results below" });
    },
    onError: (error: Error) => {
      toast({ title: "Parse Error", description: error.message, variant: "destructive" });
    },
  });

  // Feedback mutations
  const feedbackMutation = useMutation({
    mutationFn: async (text: string) => {
      const response = await fetch("/api/quoteparser/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: result?.runId,
          vendorName: result?.vendorName,
          quoteNumber: result?.quoteNumber,
          issueDescription: text,
        }),
      });
      if (!response.ok) throw new Error("Failed to submit feedback");
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Feedback submitted", description: "The complaint and the quote text were filed together for review." });
      setFeedbackOpen(false);
      setFeedbackText("");
    },
  });

  const thumbsUpMutation = useMutation({
    mutationFn: async () => {
      if (!result?.runId) return null;
      const response = await fetch(`/api/quoteparser/runs/${result.runId}/thumbs-up`, { method: "POST" });
      if (!response.ok) throw new Error("Failed to record");
      return response.json();
    },
    onSuccess: () => {
      setThumbsUpSent(true);
      toast({ title: "Thanks!", description: "Recorded — this parse joins the accuracy scorecard." });
    },
  });

  const canParse = quoteFile !== null || pastedImage !== null || quoteText.trim() !== "";
  const quoteSourceCount = [quoteFile, pastedImage, quoteText.trim() ? 1 : null].filter(Boolean).length;

  const updateRow = useCallback((idx: number, field: keyof ParsedRow, value: string) => {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  }, []);

  // Build the rows to export: checked line items + the always-included summary row.
  const exportRows = useCallback(() => {
    return rows.filter((r, idx) => r.lineType === "summary" || checkedRows.has(idx));
  }, [rows, checkedRows]);

  const toggleRow = useCallback((idx: number) => {
    setCheckedRows(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  }, []);

  // Indexes of all selectable (non-summary) rows
  const selectableIdxs = rows.map((r, i) => ({ r, i })).filter(x => x.r.lineType !== "summary").map(x => x.i);
  const allChecked = selectableIdxs.length > 0 && selectableIdxs.every(i => checkedRows.has(i));
  const someChecked = selectableIdxs.some(i => checkedRows.has(i));

  const toggleAll = useCallback(() => {
    setCheckedRows(allChecked ? new Set() : new Set(selectableIdxs));
  }, [allChecked, selectableIdxs]);

  // Copy to clipboard — format unchanged: 6 columns, $0.00 per line, totals on summary row.
  const copyToClipboard = useCallback(() => {
    const headers = ["PLAN CALLOUT", "DESCRIPTION", "MODEL NUMBER", "ITEM QUANTITY", "MATERIAL", "FREIGHT"];
    const out = exportRows().map(r => [r.planCallout || "", r.description || "", r.modelNumber || "", r.qty || "", r.material || "", r.freight || ""]);
    copyTsvWithFormatting(headers, out);
    toast({ title: "Copied!", description: `${out.length} ${out.length === 1 ? "row" : "rows"} copied to clipboard` });
  }, [exportRows, toast]);

  // Download CSV
  const downloadCSV = useCallback(() => {
    const headers = ["PLAN CALLOUT", "DESCRIPTION", "MODEL NUMBER", "ITEM QUANTITY", "MATERIAL", "FREIGHT"];
    const esc = (v: string) => v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = [headers.join(","), ...exportRows().map(r => [r.planCallout || "", r.description || "", r.modelNumber || "", r.qty || "", r.material || "", r.freight || ""].map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "quote_estimate.csv"; a.click();
    URL.revokeObjectURL(url);
  }, [exportRows]);

  const confidenceBadge = (confidence: number | undefined, note: string | undefined) => {
    if (!confidence || confidence >= 95) return null;
    const color = confidence >= 80 ? "bg-yellow-500/20 text-yellow-600 border-yellow-500/30" : "bg-red-500/20 text-red-600 border-red-500/30";
    return (
      <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border ${color} ml-2`} title={note || ""}>
        <AlertCircle className="w-3 h-3" />
        {confidence}%
      </span>
    );
  };

  const specStatusIcon = (status: string) => {
    if (status === "pass") return <ShieldCheck className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />;
    if (status === "fail") return <ShieldX className="w-4 h-4 text-destructive shrink-0 mt-0.5" />;
    return <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />;
  };

  const verdict = result?.verdict;
  const hasSpecResults = result?.specCheck && result.specCheck.checks.length > 0;
  const specFailCount = result?.specCheck?.checks.filter(c => c.status === "fail").length ?? 0;
  const specWarnCount = result?.specCheck?.checks.filter(c => c.status === "warn").length ?? 0;
  const schedule = result?.scheduleCheck;
  const scheduleIssueCount = schedule ? schedule.missing.length + schedule.qtyMismatches.length + schedule.extras.length : 0;
  const hasPrices = rows.some(r => r.lineType !== "summary" && (r.unitPrice !== null && r.unitPrice !== undefined));

  const dropzoneClasses = (isDragActive: boolean, hasFile: boolean) =>
    `border-2 border-dashed rounded-lg text-center cursor-pointer transition-colors ${isDragActive ? "border-primary bg-primary/5" : hasFile ? "border-green-500 bg-green-950" : "border-border hover:border-muted-foreground/50"}`;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background animate-page-enter">
      <div className="max-w-4xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-heading font-semibold text-foreground">Quote Parser</h1>
            <div className="flex items-center gap-2">
              <a href="/settings?tab=quote-parser" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5" />
                Handbook & Vendor Memory
              </a>
              <BackNav href="/" label="Home" testId="button-back-home" />
            </div>
          </div>
          <p className="text-muted-foreground">
            Drop a vendor quote (PDF, image, or paste text — or several of them together). Optionally add the spec section and the plan schedule, and every line gets checked against the math, the spec, and the schedule.
          </p>
        </div>

        {/* Quote Input */}
        <Card className="p-6 mb-4 card-accent-bar">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <FileText className="w-5 h-5" style={{ color: "var(--gold)" }} />
              <h2 className="font-heading font-medium">Vendor Quote</h2>
            </div>
            {quoteSourceCount > 1 && (
              <Badge variant="outline" className="text-xs">{quoteSourceCount} sources will be combined</Badge>
            )}
          </div>

          {/* File drop */}
          <div
            {...quoteDropzone.getRootProps()}
            className={`${dropzoneClasses(quoteDropzone.isDragActive, !!quoteFile)} p-8`}
            data-testid="dropzone-quote"
          >
            <input {...quoteDropzone.getInputProps()} />
            {quoteFile ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
                <p className="font-medium text-foreground">{quoteFile.name}</p>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setQuoteFile(null); }} data-testid="button-remove-quote">Remove</Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="w-8 h-8 text-muted-foreground" />
                <p className="text-muted-foreground">Drop quote file or click to upload</p>
                <p className="text-xs text-muted-foreground">PDF, PNG, JPG, HEIC, or TXT — scanned PDFs are read visually</p>
              </div>
            )}
          </div>

          {/* Screenshot paste */}
          <div className="mt-4">
            <Label className="text-sm text-muted-foreground flex items-center gap-1.5 mb-2">
              <ClipboardPaste className="w-3.5 h-3.5" />
              Or paste a screenshot:
            </Label>
            <div
              ref={pasteZoneRef}
              tabIndex={0}
              onFocus={() => setPasteZoneFocused(true)}
              onBlur={() => setPasteZoneFocused(false)}
              className={`${dropzoneClasses(false, !!pastedPreview)} p-6 outline-none ${pasteZoneFocused && !pastedPreview ? "border-primary bg-primary/5" : ""}`}
              onClick={() => pasteZoneRef.current?.focus()}
              data-testid="paste-zone-screenshot"
            >
              {pastedPreview ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="relative inline-block">
                    <img src={pastedPreview} alt="Pasted screenshot" className="max-h-48 rounded-md border" style={{ borderColor: "var(--border)" }} />
                    <button className="absolute -top-2 -right-2 rounded-full flex items-center justify-center w-5 h-5" style={{ background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text-dim)", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); clearPastedImage(); }}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-sm font-medium text-foreground">Screenshot ready to parse</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Image className="w-8 h-8 text-muted-foreground" />
                  <p className="text-muted-foreground text-sm">{pasteZoneFocused ? "Now press Ctrl+V (or Cmd+V) to paste" : "Click here, then paste a screenshot (Ctrl+V)"}</p>
                  <p className="text-xs text-muted-foreground">Works with screenshots of quotes from PDFs or emails</p>
                </div>
              )}
            </div>
          </div>

          {/* Text paste */}
          <div className="mt-4">
            <Label htmlFor="quote-text" className="text-sm text-muted-foreground">Or paste quote text:</Label>
            <Textarea id="quote-text" placeholder="Paste email quote or raw text here..." value={quoteText} onChange={(e) => setQuoteText(e.target.value)} className="mt-2 min-h-[120px]" data-testid="textarea-quote-text" />
          </div>
        </Card>

        {/* Spec Requirements (optional — Gate 2) */}
        <Card className="p-6 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-5 h-5 text-muted-foreground" />
            <h2 className="font-heading font-medium">Spec Requirements <span className="text-muted-foreground font-normal text-sm">(optional)</span></h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">Drop the spec section (PDF, image, or TXT) or paste spec text. Every quoted product gets checked against the requirements.</p>

          <div
            {...specDropzone.getRootProps()}
            className={`${dropzoneClasses(specDropzone.isDragActive, !!specFile)} p-5`}
            data-testid="dropzone-spec"
          >
            <input {...specDropzone.getInputProps()} />
            {specFile ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
                <p className="font-medium text-foreground text-sm">{specFile.name}</p>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setSpecFile(null); }}>Remove</Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1">
                <Upload className="w-6 h-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Drop spec PDF, image, or TXT</p>
              </div>
            )}
          </div>

          <div className="mt-3">
            <Label htmlFor="spec-text" className="text-sm text-muted-foreground">Or paste spec text:</Label>
            <Textarea id="spec-text" placeholder="Paste spec section requirements here..." value={specText} onChange={(e) => setSpecText(e.target.value)} className="mt-2 min-h-[80px]" data-testid="textarea-spec-text" />
          </div>
        </Card>

        {/* Plan Schedule (optional — Gate 3) */}
        <Card className="p-6 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <ListChecks className="w-5 h-5 text-muted-foreground" />
            <h2 className="font-heading font-medium">Plan Schedule <span className="text-muted-foreground font-normal text-sm">(optional)</span></h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">Drop the plan schedule (PDF, image, or TXT) or paste it. The parser fills in each line's PLAN CALLOUT and flags anything the quote is missing, anything extra, and quantity mismatches.</p>

          <div
            {...scheduleDropzone.getRootProps()}
            className={`${dropzoneClasses(scheduleDropzone.isDragActive, !!scheduleFile)} p-5`}
            data-testid="dropzone-schedule"
          >
            <input {...scheduleDropzone.getInputProps()} />
            {scheduleFile ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle2 className="w-6 h-6 text-green-600" />
                <p className="font-medium text-foreground text-sm">{scheduleFile.name}</p>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setScheduleFile(null); }}>Remove</Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1">
                <Upload className="w-6 h-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Drop schedule PDF, image, or TXT</p>
              </div>
            )}
          </div>

          <div className="mt-3">
            <Label htmlFor="schedule-text" className="text-sm text-muted-foreground">Or paste schedule text:</Label>
            <Textarea id="schedule-text" placeholder="Paste the plan schedule here (callout, description, model, qty)..." value={scheduleText} onChange={(e) => setScheduleText(e.target.value)} className="mt-2 min-h-[80px]" data-testid="textarea-schedule-text" />
          </div>
        </Card>

        {/* Parse button */}
        <div className="flex justify-center mb-8">
          <Button size="lg" onClick={() => parseMutation.mutate()} disabled={!canParse || parseMutation.isPending} data-testid="button-parse">
            {parseMutation.isPending ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Parsing & verifying…</>) : "Parse Quote"}
          </Button>
        </div>

        {/* Results */}
        {result && (
          <>
            {/* Verdict banner */}
            {verdict && (
              <Card className={`mb-4 border ${verdict.status === "verified" ? "border-green-500/40 bg-green-500/5" : "border-yellow-500/40 bg-yellow-500/5"}`}>
                <div
                  className="p-4 flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setVerdictExpanded(v => !v)}
                  data-testid="verdict-banner"
                >
                  <div className="flex items-center gap-3">
                    {verdict.status === "verified" ? (
                      <BadgeCheck className="w-6 h-6 text-green-500" />
                    ) : (
                      <AlertTriangle className="w-6 h-6 text-yellow-500" />
                    )}
                    <div>
                      <h2 className="font-heading font-semibold">
                        {verdict.status === "verified" ? "VERIFIED" : `NEEDS REVIEW: ${verdict.reviewItems.length} item${verdict.reviewItems.length === 1 ? "" : "s"}`}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {verdict.status === "verified"
                          ? "Math balances and every line was read with high confidence."
                          : "Every flagged item below needs your eyes before this goes in the estimate."}
                      </p>
                    </div>
                  </div>
                  {verdictExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
                {verdictExpanded && (verdict.confirmations.length > 0 || verdict.reviewItems.length > 0) && (
                  <CardContent className="pt-0 pb-4 space-y-1.5">
                    {verdict.confirmations.map((c, i) => (
                      <div key={`c${i}`} className="flex items-start gap-2 text-sm">
                        <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                        <span>{c}</span>
                      </div>
                    ))}
                    {verdict.reviewItems.map((item, i) => (
                      <div key={`r${i}`} className="flex items-start gap-2 text-sm">
                        <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                        <span>{item}</span>
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            )}

            {/* Warnings */}
            {result.warnings.length > 0 && (
              <div className="mb-4 p-3 rounded-lg bg-muted/50 border border-border space-y-1">
                {result.warnings.map((w, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {w}
                  </div>
                ))}
              </div>
            )}

            {/* Output table */}
            <Card className="mb-4">
              <div className="p-4 border-b flex items-center justify-between flex-wrap gap-4">
                <div>
                  <h2 className="font-heading font-medium">Result</h2>
                  <p className="text-xs text-muted-foreground">Click any callout, description, model, or qty cell to correct it before copying.</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={copyToClipboard} data-testid="button-copy-tsv">
                    <Copy className="w-4 h-4 mr-2" />Copy Table (TSV)
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadCSV} data-testid="button-download-csv">
                    <Download className="w-4 h-4 mr-2" />Download CSV
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[44px]">
                        <Checkbox
                          checked={allChecked ? true : someChecked ? "indeterminate" : false}
                          onCheckedChange={toggleAll}
                          aria-label="Select all line items"
                          data-testid="checkbox-select-all"
                        />
                      </TableHead>
                      <TableHead className="min-w-[100px]">PLAN CALLOUT</TableHead>
                      <TableHead className="min-w-[200px]">DESCRIPTION</TableHead>
                      <TableHead className="min-w-[160px]">MODEL NUMBER</TableHead>
                      <TableHead className="min-w-[70px]">QTY</TableHead>
                      {hasPrices && <TableHead className="min-w-[90px] text-right">UNIT $</TableHead>}
                      {hasPrices && <TableHead className="min-w-[90px] text-right">EXT $</TableHead>}
                      <TableHead className="min-w-[110px]">MATERIAL</TableHead>
                      <TableHead className="min-w-[100px]">FREIGHT</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, idx) => {
                      const isSummary = row.lineType === "summary";
                      const isLowConfidence = row.confidence !== undefined && row.confidence < 95;
                      return (
                        <TableRow
                          key={idx}
                          className={`${isSummary ? "font-semibold border-t-2 border-border bg-muted/20" : ""} ${isLowConfidence ? "bg-yellow-500/5" : ""}`}
                          data-testid={`row-result-${idx}`}
                        >
                          <TableCell>
                            {!isSummary && (
                              <Checkbox
                                checked={checkedRows.has(idx)}
                                onCheckedChange={() => toggleRow(idx)}
                                aria-label="Include line item"
                                data-testid={`checkbox-row-${idx}`}
                              />
                            )}
                          </TableCell>
                          <TableCell className="font-mono">
                            {isSummary ? "" : (
                              <EditableCell
                                value={row.planCallout || ""}
                                onCommit={(v) => updateRow(idx, "planCallout", v)}
                                mono
                                placeholder="—"
                                testId={`cell-callout-${idx}`}
                              />
                            )}
                          </TableCell>
                          <TableCell>
                            {isSummary ? row.description : (
                              <div className="flex items-center">
                                <div className="flex-1">
                                  <EditableCell
                                    value={row.description || ""}
                                    onCommit={(v) => updateRow(idx, "description", v)}
                                    testId={`cell-description-${idx}`}
                                  />
                                </div>
                                {confidenceBadge(row.confidence, row.confidenceNote)}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="font-mono font-medium">
                            {isSummary ? row.modelNumber : (
                              <EditableCell
                                value={row.modelNumber || ""}
                                onCommit={(v) => updateRow(idx, "modelNumber", v)}
                                mono
                                testId={`cell-model-${idx}`}
                              />
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {isSummary ? row.qty : (
                              <EditableCell
                                value={row.qty || ""}
                                onCommit={(v) => updateRow(idx, "qty", v)}
                                center
                                testId={`cell-qty-${idx}`}
                              />
                            )}
                          </TableCell>
                          {hasPrices && (
                            <TableCell className="text-right font-mono text-muted-foreground">
                              {isSummary ? "" : money(row.unitPrice)}
                            </TableCell>
                          )}
                          {hasPrices && (
                            <TableCell className="text-right font-mono text-muted-foreground">
                              {isSummary ? "" : money(row.extendedPrice)}
                            </TableCell>
                          )}
                          <TableCell className="text-right font-mono font-medium">{row.material}</TableCell>
                          <TableCell className="text-right font-mono font-medium">{row.freight}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {typeof result.taxTotal === "number" && result.taxTotal > 0 && (
                <p className="px-4 py-2 text-xs text-muted-foreground border-t">
                  Tax shown on quote: {money(result.taxTotal)} (not included in the material total).
                </p>
              )}
            </Card>

            {/* Schedule Coverage Report */}
            {schedule && (
              <Card className="mb-4">
                <div
                  className="p-4 border-b flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setScheduleExpanded(v => !v)}
                >
                  <div className="flex items-center gap-3">
                    <h2 className="font-heading font-medium">Schedule Coverage</h2>
                    <Badge variant="outline">{schedule.matchedCount} / {schedule.scheduledCount} matched</Badge>
                    {scheduleIssueCount > 0
                      ? <Badge className="bg-yellow-500/20 text-yellow-700 border-yellow-500/30">{scheduleIssueCount} {scheduleIssueCount === 1 ? "flag" : "flags"}</Badge>
                      : <Badge className="bg-green-500/20 text-green-700 border-green-500/30">Full coverage</Badge>}
                  </div>
                  {scheduleExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
                {scheduleExpanded && (
                  <CardContent className="pt-4 space-y-2">
                    {schedule.missing.map((m, i) => (
                      <div key={`m${i}`} className="flex items-start gap-2.5 text-sm p-2.5 rounded-md bg-destructive/10">
                        <ShieldX className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                        <span>Missing from quote: <strong>{[m.callout, m.description || m.modelNumber].filter(Boolean).join(" — ")}</strong>{m.qty ? ` (schedule calls for ${m.qty})` : ""}</span>
                      </div>
                    ))}
                    {schedule.qtyMismatches.map((q, i) => (
                      <div key={`q${i}`} className="flex items-start gap-2.5 text-sm p-2.5 rounded-md bg-yellow-500/10">
                        <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                        <span>Quantity mismatch on <strong>{q.callout || q.description}</strong>: schedule calls for {q.scheduledQty}, quote has {q.quotedQty}.</span>
                      </div>
                    ))}
                    {schedule.extras.length > 0 && (
                      <div className="flex items-start gap-2.5 text-sm p-2.5 rounded-md bg-yellow-500/10">
                        <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />
                        <span>On the quote but not on the schedule: <strong>{schedule.extras.join(", ")}</strong> — confirm they belong on this project.</span>
                      </div>
                    )}
                    {scheduleIssueCount === 0 && (
                      <div className="flex items-start gap-2.5 text-sm p-2.5 rounded-md bg-green-500/10">
                        <ShieldCheck className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
                        <span>Every scheduled item was found on the quote with matching quantities.</span>
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            )}

            {/* Spec Compliance Report */}
            {hasSpecResults && (
              <Card className="mb-4">
                <div
                  className="p-4 border-b flex items-center justify-between cursor-pointer select-none"
                  onClick={() => setSpecExpanded(v => !v)}
                >
                  <div className="flex items-center gap-3">
                    <h2 className="font-heading font-medium">Spec Compliance Check</h2>
                    {specFailCount > 0 && <Badge variant="destructive">{specFailCount} {specFailCount === 1 ? "issue" : "issues"}</Badge>}
                    {specWarnCount > 0 && <Badge className="bg-yellow-500/20 text-yellow-700 border-yellow-500/30">{specWarnCount} {specWarnCount === 1 ? "warning" : "warnings"}</Badge>}
                    {specFailCount === 0 && specWarnCount === 0 && <Badge className="bg-green-500/20 text-green-700 border-green-500/30">All clear</Badge>}
                  </div>
                  {specExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
                {specExpanded && (
                  <CardContent className="pt-4 space-y-2">
                    {result.specCheck!.checks.map((check, i) => (
                      <div key={i} className={`flex items-start gap-2.5 text-sm p-2.5 rounded-md ${check.status === "fail" ? "bg-destructive/10" : check.status === "warn" ? "bg-yellow-500/10" : "bg-green-500/10"}`}>
                        {specStatusIcon(check.status)}
                        <span>{check.message}</span>
                      </div>
                    ))}
                  </CardContent>
                )}
              </Card>
            )}

            {/* Errors */}
            {result.errors.length > 0 && (
              <Card className="mb-4 p-4 border-destructive bg-destructive/10">
                <h3 className="font-heading font-medium text-destructive mb-2">Errors</h3>
                {result.errors.map((e, i) => <p key={i} className="text-sm text-destructive">{e.message}</p>)}
              </Card>
            )}

            {/* Feedback */}
            <div className="flex items-center gap-3 mb-8">
              <p className="text-sm text-muted-foreground">How did this parse?</p>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-green-600 border-green-600/30 hover:bg-green-500/10"
                disabled={thumbsUpSent || thumbsUpMutation.isPending}
                onClick={() => thumbsUpMutation.mutate()}
                data-testid="button-thumbs-up"
              >
                <ThumbsUp className="w-3.5 h-3.5" />{thumbsUpSent ? "Recorded" : "Looks correct"}
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setFeedbackOpen(v => !v)} data-testid="button-thumbs-down">
                <ThumbsDown className="w-3.5 h-3.5" />Something's wrong
              </Button>
            </div>

            {feedbackOpen && (
              <Card className="mb-8 p-4">
                <Label className="mb-2 block text-sm font-medium">Describe the issue</Label>
                <Textarea
                  placeholder="e.g. Wrong total — should be $1,842 not $1,713. Or: missed a line item for model FEA10."
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  className="mb-3 min-h-[80px]"
                />
                <p className="text-xs text-muted-foreground mb-3">The quote text from this parse is attached automatically, so the issue can be reproduced and turned into a vendor rule.</p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => feedbackMutation.mutate(feedbackText)} disabled={!feedbackText.trim() || feedbackMutation.isPending}>
                    {feedbackMutation.isPending ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Submitting…</> : "Submit Feedback"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setFeedbackOpen(false)}>Cancel</Button>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
