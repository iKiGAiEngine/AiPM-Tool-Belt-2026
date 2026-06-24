import { useState, useCallback, useRef, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToolUsage } from "@/lib/useToolUsage";
import { copyTsvWithFormatting } from "@/lib/clipboardUtils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Upload, FileText, Loader2, Copy, Download, CheckCircle2,
  AlertCircle, ClipboardPaste, Image, X, ThumbsUp, ThumbsDown,
  ChevronDown, ChevronUp, ShieldCheck, ShieldX, AlertTriangle,
  BookOpen,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BackNav } from "@/components/BackNav";
import { queryClient } from "@/lib/queryClient";

interface ParsedRow {
  planCallout: string;
  description: string;
  modelNumber: string;
  qty: string;
  material: string;
  freight: string;
  confidence?: number;
  confidenceNote?: string;
  lineType?: string;
}

interface SpecCheck {
  status: "pass" | "fail" | "warn";
  message: string;
}

interface ParseResult {
  rows: ParsedRow[];
  errors: Array<{ type: string; message: string }>;
  warnings: string[];
  specCheck: { checks: SpecCheck[] } | null;
  vendorName: string | null;
  quoteNumber: string | null;
}

export default function QuoteParserPage() {
  useToolUsage("quoteparser");
  const { toast } = useToast();

  // Quote inputs
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteText, setQuoteText] = useState("");
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [pastedPreview, setPastedPreview] = useState<string | null>(null);
  const [pasteZoneFocused, setPasteZoneFocused] = useState(false);
  const pasteZoneRef = useRef<HTMLDivElement>(null);

  // Spec inputs
  const [specFile, setSpecFile] = useState<File | null>(null);
  const [specText, setSpecText] = useState("");

  // Result
  const [result, setResult] = useState<ParseResult | null>(null);
  const [specExpanded, setSpecExpanded] = useState(true);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

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

  // Quote dropzone
  const quoteDropzone = useDropzone({
    accept: { "application/pdf": [".pdf"], "image/*": [".png", ".jpg", ".jpeg", ".heic"], "text/plain": [".txt"] },
    maxFiles: 1,
    onDrop: (files: File[]) => { if (files.length > 0) setQuoteFile(files[0]); },
  });

  // Spec dropzone
  const specDropzone = useDropzone({
    accept: { "application/pdf": [".pdf"], "text/plain": [".txt"] },
    maxFiles: 1,
    onDrop: (files: File[]) => { if (files.length > 0) setSpecFile(files[0]); },
  });

  // Parse mutation
  const parseMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      if (pastedImage) formData.append("quoteFile", pastedImage);
      else if (quoteFile) formData.append("quoteFile", quoteFile);
      if (quoteText) formData.append("quoteText", quoteText);
      if (specFile) formData.append("specFile", specFile);
      if (specText) formData.append("specText", specText);

      const response = await fetch("/api/quoteparser/parse", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.errors?.[0]?.message || "Failed to parse quote");
      return data as ParseResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setFeedbackOpen(false);
      setFeedbackText("");
      toast({ title: "Quote Parsed", description: "Review results below" });
    },
    onError: (error: Error) => {
      toast({ title: "Parse Error", description: error.message, variant: "destructive" });
    },
  });

  // Feedback mutation
  const feedbackMutation = useMutation({
    mutationFn: async (text: string) => {
      const response = await fetch("/api/quoteparser/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorName: result?.vendorName,
          quoteNumber: result?.quoteNumber,
          issueDescription: text,
        }),
      });
      if (!response.ok) throw new Error("Failed to submit feedback");
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Feedback submitted", description: "We'll review and improve the parser." });
      setFeedbackOpen(false);
      setFeedbackText("");
    },
  });

  const canParse = quoteFile !== null || pastedImage !== null || quoteText.trim() !== "";

  // Copy to clipboard
  const copyToClipboard = useCallback(() => {
    if (!result) return;
    const headers = ["PLAN CALLOUT", "DESCRIPTION", "MODEL NUMBER", "ITEM QUANTITY", "MATERIAL", "FREIGHT"];
    const rows = result.rows.map(r => [r.planCallout || "", r.description || "", r.modelNumber || "", r.qty || "", r.material || "", r.freight || ""]);
    copyTsvWithFormatting(headers, rows);
    toast({ title: "Copied!", description: "Table copied to clipboard as TSV" });
  }, [result, toast]);

  // Download CSV
  const downloadCSV = useCallback(() => {
    if (!result) return;
    const headers = ["PLAN CALLOUT", "DESCRIPTION", "MODEL NUMBER", "ITEM QUANTITY", "MATERIAL", "FREIGHT"];
    const esc = (v: string) => v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
    const csv = [headers.join(","), ...result.rows.map(r => [r.planCallout || "", r.description || "", r.modelNumber || "", r.qty || "", r.material || "", r.freight || ""].map(esc).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "quote_estimate.csv"; a.click();
    URL.revokeObjectURL(url);
  }, [result]);

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

  const hasSpecResults = result?.specCheck && result.specCheck.checks.length > 0;
  const specFailCount = result?.specCheck?.checks.filter(c => c.status === "fail").length ?? 0;
  const specWarnCount = result?.specCheck?.checks.filter(c => c.status === "warn").length ?? 0;

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
            Drop a vendor quote (PDF, image, or paste text) to extract line items and totals. Optionally attach spec requirements to verify compliance.
          </p>
        </div>

        {/* Quote Input */}
        <Card className="p-6 mb-4 card-accent-bar">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-5 h-5" style={{ color: "var(--gold)" }} />
            <h2 className="font-heading font-medium">Vendor Quote</h2>
          </div>

          {/* File drop */}
          <div
            {...quoteDropzone.getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${quoteDropzone.isDragActive ? "border-primary bg-primary/5" : quoteFile ? "border-green-500 bg-green-950" : "border-border hover:border-muted-foreground/50"}`}
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
                <p className="text-xs text-muted-foreground">PDF, PNG, JPG, HEIC, or TXT</p>
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
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors outline-none ${pastedPreview ? "border-green-500 bg-green-950" : pasteZoneFocused ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground/50"}`}
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

        {/* Spec Requirements (optional) */}
        <Card className="p-6 mb-6">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-5 h-5 text-muted-foreground" />
            <h2 className="font-heading font-medium">Spec Requirements <span className="text-muted-foreground font-normal text-sm">(optional)</span></h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">Drop a spec section PDF or paste spec text. The parser will check each line item against the requirements and generate a compliance report.</p>

          <div
            {...specDropzone.getRootProps()}
            className={`border-2 border-dashed rounded-lg p-5 text-center cursor-pointer transition-colors ${specDropzone.isDragActive ? "border-primary bg-primary/5" : specFile ? "border-green-500 bg-green-950" : "border-border hover:border-muted-foreground/50"}`}
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
                <p className="text-sm text-muted-foreground">Drop spec PDF or TXT</p>
              </div>
            )}
          </div>

          <div className="mt-3">
            <Label htmlFor="spec-text" className="text-sm text-muted-foreground">Or paste spec text:</Label>
            <Textarea id="spec-text" placeholder="Paste spec section requirements here..." value={specText} onChange={(e) => setSpecText(e.target.value)} className="mt-2 min-h-[80px]" data-testid="textarea-spec-text" />
          </div>
        </Card>

        {/* Parse button */}
        <div className="flex justify-center mb-8">
          <Button size="lg" onClick={() => parseMutation.mutate()} disabled={!canParse || parseMutation.isPending} data-testid="button-parse">
            {parseMutation.isPending ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Parsing with AI…</>) : "Parse Quote"}
          </Button>
        </div>

        {/* Results */}
        {result && (
          <>
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
                <h2 className="font-heading font-medium">Result</h2>
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
                      <TableHead className="min-w-[100px]">PLAN CALLOUT</TableHead>
                      <TableHead className="min-w-[100px]">DESCRIPTION</TableHead>
                      <TableHead className="min-w-[200px]">MODEL NUMBER</TableHead>
                      <TableHead className="min-w-[80px]">QTY</TableHead>
                      <TableHead className="min-w-[120px]">MATERIAL</TableHead>
                      <TableHead className="min-w-[120px]">FREIGHT</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((row, idx) => {
                      const isSummary = row.lineType === "summary";
                      const isLowConfidence = row.confidence !== undefined && row.confidence < 95;
                      return (
                        <TableRow
                          key={idx}
                          className={`${isSummary ? "font-semibold border-t-2 border-border bg-muted/20" : ""} ${isLowConfidence ? "bg-yellow-500/5" : ""}`}
                          data-testid={`row-result-${idx}`}
                        >
                          <TableCell className="font-mono">{row.planCallout || ""}</TableCell>
                          <TableCell>
                            {row.description}
                            {!isSummary && confidenceBadge(row.confidence, row.confidenceNote)}
                          </TableCell>
                          <TableCell className="font-mono font-medium">{row.modelNumber}</TableCell>
                          <TableCell className="text-center">{row.qty}</TableCell>
                          <TableCell className="text-right font-mono font-medium">{row.material}</TableCell>
                          <TableCell className="text-right font-mono font-medium">{row.freight}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </Card>

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
              <Button variant="outline" size="sm" className="gap-1.5 text-green-600 border-green-600/30 hover:bg-green-500/10" onClick={() => toast({ title: "Thanks!", description: "Glad it worked correctly." })}>
                <ThumbsUp className="w-3.5 h-3.5" />Looks correct
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => setFeedbackOpen(v => !v)}>
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
