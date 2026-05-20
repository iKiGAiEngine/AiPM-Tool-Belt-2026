import { useState, useCallback, useRef, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import { useToolUsage } from "@/lib/useToolUsage";
import { copyTsvWithFormatting } from "@/lib/clipboardUtils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Upload,
  FileText,
  Loader2,
  Copy,
  Download,
  CheckCircle2,
  AlertCircle,
  ClipboardPaste,
  Image,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { BackNav } from "@/components/BackNav";

interface ParsedRow {
  planCallout: string;
  description: string;
  modelNumber: string;
  qty: string;
  material: string;
  freight: string;
}

interface ParseError {
  type: string;
  message: string;
}

interface ParseResult {
  rows: ParsedRow[];
  errors: ParseError[];
  warnings: string[];
}

export default function QuoteParserPage() {
  useToolUsage("quoteparser");
  const { toast } = useToast();
  const [quoteFile, setQuoteFile] = useState<File | null>(null);
  const [quoteText, setQuoteText] = useState("");
  const [pastedImage, setPastedImage] = useState<File | null>(null);
  const [pastedPreview, setPastedPreview] = useState<string | null>(null);
  const [pasteZoneFocused, setPasteZoneFocused] = useState(false);
  const pasteZoneRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<ParseResult | null>(null);

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
          setPastedPreview((prev) => {
            if (prev) URL.revokeObjectURL(prev);
            return URL.createObjectURL(blob);
          });
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

  const parseMutation = useMutation({
    mutationFn: async () => {
      const formData = new FormData();
      if (pastedImage) formData.append("quoteFile", pastedImage);
      else if (quoteFile) formData.append("quoteFile", quoteFile);
      if (quoteText) formData.append("quoteText", quoteText);

      const response = await fetch("/api/quoteparser/parse", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      
      if (!response.ok) {
        const errorMsg = data.errors?.[0]?.message || data.message || "Failed to parse quote";
        throw new Error(errorMsg);
      }

      return data as ParseResult;
    },
    onSuccess: (data) => {
      setResult(data);
      toast({
        title: "Quote Parsed",
        description: "Summary row created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Parse Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const quoteDropzone = useDropzone({
    accept: {
      "application/pdf": [".pdf"],
      "image/*": [".png", ".jpg", ".jpeg", ".heic"],
      "text/plain": [".txt"],
    },
    maxFiles: 1,
    onDrop: (files: File[]) => {
      if (files.length > 0) setQuoteFile(files[0]);
    },
  });

  const canParse = quoteFile !== null || pastedImage !== null || quoteText.trim() !== "";

  const copyToClipboard = useCallback(() => {
    if (!result) return;
    const headers = [
      "PLAN CALLOUT",
      "DESCRIPTION",
      "MODEL NUMBER",
      "ITEM QUANTITY",
      "MATERIAL",
      "FREIGHT",
    ];
    const rows = result.rows.map((row) =>
      [
        row.planCallout || "",
        row.description || "",
        row.modelNumber || "",
        row.qty || "",
        row.material || "",
        row.freight || "",
      ]
    );

    copyTsvWithFormatting(headers, rows);
    toast({ title: "Copied!", description: "Table copied to clipboard as TSV" });
  }, [result, toast]);

  const downloadCSV = useCallback(() => {
    if (!result) return;
    const headers = [
      "PLAN CALLOUT",
      "DESCRIPTION",
      "MODEL NUMBER",
      "ITEM QUANTITY",
      "MATERIAL",
      "FREIGHT",
    ];
    const escapeCSV = (val: string) => {
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    };
    const csv = [
      headers.join(","),
      ...result.rows.map((row) =>
        [
          escapeCSV(row.planCallout || ""),
          escapeCSV(row.description || ""),
          escapeCSV(row.modelNumber || ""),
          escapeCSV(row.qty || ""),
          escapeCSV(row.material || ""),
          escapeCSV(row.freight || ""),
        ].join(",")
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "quote_estimate.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [result]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background animate-page-enter">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-heading font-semibold text-foreground">
              Quote Parser
            </h1>
            <BackNav href="/" label="Home" testId="button-back-home" />
          </div>
          <p className="text-muted-foreground">
            Parse vendor quotes into a summary row with manufacturer, quote number, material total, and freight.
          </p>
        </div>

        <Card className="p-6 mb-8 card-accent-bar">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-5 h-5" style={{ color: "var(--gold)" }} />
            <h2 className="font-heading font-medium">Vendor Quote</h2>
          </div>
          <div
            {...quoteDropzone.getRootProps()}
            className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
              quoteDropzone.isDragActive
                ? "bg-green-950"
                : quoteFile
                ? "border-green-500 bg-green-950"
                : "border-border hover:border-muted-foreground/50"
            }`}
            style={quoteDropzone.isDragActive ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.06)" } : undefined}
            data-testid="dropzone-quote"
          >
            <input {...quoteDropzone.getInputProps()} />
            {quoteFile ? (
              <div className="flex flex-col items-center gap-2">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
                <p className="font-medium text-foreground">{quoteFile.name}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setQuoteFile(null);
                  }}
                  data-testid="button-remove-quote"
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="w-8 h-8 text-muted-foreground" />
                <p className="text-muted-foreground">
                  Drop quote file or click to upload
                </p>
                <p className="text-xs text-muted-foreground">
                  PDF, PNG, JPG, HEIC, or TXT
                </p>
              </div>
            )}
          </div>
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
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors outline-none ${
                pastedPreview
                  ? "border-green-500 bg-green-950"
                  : pasteZoneFocused
                  ? "border-border"
                  : "border-border hover:border-muted-foreground/50"
              }`}
              style={pasteZoneFocused && !pastedPreview ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.06)" } : undefined}
              onClick={() => pasteZoneRef.current?.focus()}
              data-testid="paste-zone-screenshot"
            >
              {pastedPreview ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="relative inline-block">
                    <img
                      src={pastedPreview}
                      alt="Pasted screenshot"
                      className="max-h-48 rounded-md border"
                      style={{ borderColor: "var(--border)" }}
                      data-testid="img-pasted-preview"
                    />
                    <button
                      className="absolute -top-2 -right-2 rounded-full flex items-center justify-center w-5 h-5"
                      style={{ background: "var(--bg3)", border: "1px solid var(--border)", color: "var(--text-dim)", cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        clearPastedImage();
                      }}
                      data-testid="button-remove-pasted"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-sm font-medium text-foreground">Screenshot ready to parse</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Image className="w-8 h-8 text-muted-foreground" />
                  <p className="text-muted-foreground text-sm">
                    {pasteZoneFocused
                      ? "Now press Ctrl+V (or Cmd+V) to paste your screenshot"
                      : "Click here, then paste a screenshot (Ctrl+V)"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Works with screenshots of quote sections from PDFs or emails
                  </p>
                </div>
              )}
            </div>
          </div>
          <div className="mt-4">
            <Label htmlFor="quote-text" className="text-sm text-muted-foreground">
              Or paste quote text:
            </Label>
            <Textarea
              id="quote-text"
              placeholder="Paste email quote or raw text here..."
              value={quoteText}
              onChange={(e) => setQuoteText(e.target.value)}
              className="mt-2 min-h-[150px]"
              data-testid="textarea-quote-text"
            />
          </div>
        </Card>

        <div className="flex justify-center mb-8">
          <Button
            size="lg"
            onClick={() => parseMutation.mutate()}
            disabled={!canParse || parseMutation.isPending}
            data-testid="button-parse"
          >
            {parseMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Parsing...
              </>
            ) : (
              "Parse Quote"
            )}
          </Button>
        </div>

        {result && (
          <Card className="mb-6">
            <div className="p-4 border-b flex items-center justify-between flex-wrap gap-4">
              <h2 className="font-heading font-medium">Result</h2>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyToClipboard}
                  data-testid="button-copy-tsv"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Table (TSV)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadCSV}
                  data-testid="button-download-csv"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download CSV
                </Button>
              </div>
            </div>
            
            {result.warnings.length > 0 && (
              <div className="p-4 bg-muted/50 border-b">
                {result.warnings.map((warning, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="w-4 h-4" />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}
            
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[100px]">PLAN CALLOUT</TableHead>
                    <TableHead className="min-w-[100px]">DESCRIPTION</TableHead>
                    <TableHead className="min-w-[200px]">MODEL NUMBER</TableHead>
                    <TableHead className="min-w-[100px]">ITEM QUANTITY</TableHead>
                    <TableHead className="min-w-[120px]">MATERIAL</TableHead>
                    <TableHead className="min-w-[120px]">FREIGHT</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, idx) => (
                    <TableRow key={idx} data-testid={`row-result-${idx}`}>
                      <TableCell className="font-mono">{row.planCallout || ""}</TableCell>
                      <TableCell>{row.description}</TableCell>
                      <TableCell className="font-mono font-medium">{row.modelNumber}</TableCell>
                      <TableCell className="text-center">{row.qty}</TableCell>
                      <TableCell className="text-right font-mono font-medium">{row.material}</TableCell>
                      <TableCell className="text-right font-mono font-medium">{row.freight}</TableCell>
                    </TableRow>
                  ))}
                  {result.rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        No data extracted
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        )}

        {result && result.errors.length > 0 && (
          <Card className="p-4 border-destructive bg-destructive/10">
            <h3 className="font-heading font-medium text-destructive mb-2">Errors</h3>
            {result.errors.map((error, idx) => (
              <p key={idx} className="text-sm text-destructive">
                {error.message}
              </p>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
