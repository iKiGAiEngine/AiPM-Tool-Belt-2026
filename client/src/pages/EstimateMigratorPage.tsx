import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { useMutation } from "@tanstack/react-query";
import { useToolUsage } from "@/lib/useToolUsage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  FileSpreadsheet,
  Loader2,
  Download,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  RefreshCw,
  Info,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BackNav } from "@/components/BackNav";

// ── Types (mirrors server types) ─────────────────────────────────────────────

interface MigratedProjectInfo {
  projectName: string;
  projectId: string;
  regionCode: string;
  dueDate: string;
  projectAddress: string | null;
  gcContact: string | null;
  estimator: string | null;
  anticipatedStart: string | null;
  anticipatedFinish: string | null;
  taxRate: number | null;
  defaultOh: number | null;
  defaultEsc: number | null;
  oldFee: number | null;
  oldBondRate: number | null;
}

interface MigratedLineItem {
  callout: string;
  description: string;
  model: string;
  manufacturer: string;
  qty: number;
  unitCost: number;
  extendedCost: number;
  note: string;
  sourceRow: number;
}

interface MigratedScope {
  sheetName: string;
  csiCode: string;
  specTitle: string;
  lineItems: MigratedLineItem[];
  preMarkupSubtotal: number;
  inclusions: string[];
  exclusions: string[];
  qualifications: string[];
  rawQualText: string | null;
}

interface MigratedScopeMapping {
  oldSheetName: string;
  newSheetName: string | null;
  csiCode: string;
  matchBasis: "exact" | "csi" | "fuzzy" | "unmapped";
  warning: string | null;
}

interface ParsedOldEstimate {
  projectInfo: MigratedProjectInfo;
  scopes: MigratedScope[];
  catOverrides: Array<{ scopeKey: string; ohOverride: number | null; escOverride: number | null }>;
  scopeMappings: MigratedScopeMapping[];
  warnings: string[];
  parseErrors: string[];
  parsedAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCurrency(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function matchBadge(basis: MigratedScopeMapping["matchBasis"]) {
  if (basis === "exact") return <Badge className="bg-green-600 text-white text-xs">Exact Match</Badge>;
  if (basis === "csi") return <Badge className="bg-blue-600 text-white text-xs">CSI Match</Badge>;
  if (basis === "fuzzy") return <Badge className="bg-amber-500 text-white text-xs">Fuzzy Match</Badge>;
  return <Badge variant="destructive" className="text-xs">Unmapped</Badge>;
}

type WizardStep = "upload" | "preview" | "download";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function EstimateMigratorPage() {
  useToolUsage("estimatemigrator");
  const { toast } = useToast();

  const [step, setStep] = useState<WizardStep>("upload");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsedData, setParsedData] = useState<ParsedOldEstimate | null>(null);
  const [migrationWarnings, setMigrationWarnings] = useState<string[]>([]);
  const [migrationMappings, setMigrationMappings] = useState<MigratedScopeMapping[]>([]);

  // ── Drop zone ───────────────────────────────────────────────────────────────
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel.sheet.macroEnabled.12": [".xlsm"],
    },
    maxFiles: 1,
    maxSize: 100 * 1024 * 1024,
    onDrop: (files, rejected) => {
      if (rejected.length > 0) {
        toast({ title: "Invalid file", description: "Only .xlsx or .xlsm files up to 100 MB are accepted", variant: "destructive" });
        return;
      }
      if (files[0]) {
        setSelectedFile(files[0]);
        setParsedData(null);
        setStep("upload");
      }
    },
  });

  // ── Parse mutation ──────────────────────────────────────────────────────────
  const parseMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("No file selected");
      const fd = new FormData();
      fd.append("oldEstimate", selectedFile);
      const res = await fetch("/api/estimates/migrate/parse", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Parse failed");
      }
      return res.json() as Promise<ParsedOldEstimate>;
    },
    onSuccess: (data) => {
      setParsedData(data);
      setStep("preview");
      if (data.parseErrors.length > 0) {
        toast({ title: "Parse completed with errors", description: data.parseErrors[0], variant: "destructive" });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Parse failed", description: err.message, variant: "destructive" });
    },
  });

  // ── Download mutation ───────────────────────────────────────────────────────
  const downloadMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("No file selected");
      const fd = new FormData();
      fd.append("oldEstimate", selectedFile);
      const res = await fetch("/api/estimates/migrate", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Migration failed");
      }

      const warnHeader = res.headers.get("X-Migration-Warnings");
      const mappingsHeader = res.headers.get("X-Migration-Mappings");
      if (warnHeader) {
        try { setMigrationWarnings(JSON.parse(warnHeader)); } catch {}
      }
      if (mappingsHeader) {
        try { setMigrationMappings(JSON.parse(mappingsHeader)); } catch {}
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = (parsedData?.projectInfo.projectName || "Estimate").replace(/[^a-zA-Z0-9\s\-_]/g, "").trim().slice(0, 40);
      a.download = `Migrated_Estimate_${safeName}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      setStep("download");
      toast({ title: "Migration complete", description: "Your populated template has been downloaded." });
    },
    onError: (err: Error) => {
      toast({ title: "Migration failed", description: err.message, variant: "destructive" });
    },
  });

  const reset = () => {
    setSelectedFile(null);
    setParsedData(null);
    setMigrationWarnings([]);
    setMigrationMappings([]);
    setStep("upload");
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const info = parsedData?.projectInfo;
  const totalItems = parsedData?.scopes.reduce((s, sc) => s + sc.lineItems.length, 0) ?? 0;
  const totalSubtotal = parsedData?.scopes.reduce((s, sc) => s + sc.preMarkupSubtotal, 0) ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-6">
        <BackNav href="/" label="Home" />

        <div className="mt-4 mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Estimate Template Migrator</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Drop in an older estimate XLSM/XLSX and transfer all data into the current active template.
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6 text-sm">
          {(["upload", "preview", "download"] as WizardStep[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              <span className={step === s ? "text-primary font-medium" : step === "download" || (step === "preview" && i === 0) ? "text-muted-foreground line-through" : "text-muted-foreground"}>
                {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
              </span>
            </div>
          ))}
        </div>

        {/* ── Step 1: Upload ─────────────────────────────────────────────── */}
        {(step === "upload" || step === "preview" || step === "download") && (
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">1. Select Old Estimate File</CardTitle>
            </CardHeader>
            <CardContent>
              <div
                {...getRootProps()}
                className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
              >
                <input {...getInputProps()} />
                <FileSpreadsheet className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
                {selectedFile ? (
                  <div>
                    <p className="font-medium text-sm">{selectedFile.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{(selectedFile.size / 1024).toFixed(0)} KB — click or drag to replace</p>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm font-medium">Drop your old estimate here</p>
                    <p className="text-xs text-muted-foreground mt-1">Supports .xlsx and .xlsm up to 100 MB</p>
                  </div>
                )}
              </div>

              {selectedFile && step === "upload" && (
                <Button
                  className="mt-4 w-full"
                  onClick={() => parseMutation.mutate()}
                  disabled={parseMutation.isPending}
                >
                  {parseMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Parsing…</>
                  ) : (
                    <><Upload className="w-4 h-4 mr-2" />Parse Estimate</>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Step 2: Preview ────────────────────────────────────────────── */}
        {(step === "preview" || step === "download") && parsedData && (
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">2. Review Extracted Data</CardTitle>
              <p className="text-sm text-muted-foreground">
                {parsedData.scopes.length} scope{parsedData.scopes.length !== 1 ? "s" : ""} found &middot; {totalItems} line items &middot; {fmtCurrency(totalSubtotal)} pre-markup total
              </p>
            </CardHeader>
            <CardContent>
              <Accordion type="multiple" defaultValue={["project", "scopes"]} className="space-y-2">

                {/* Project Info */}
                <AccordionItem value="project" className="border rounded-lg px-3">
                  <AccordionTrigger className="text-sm font-medium py-3">Project Information</AccordionTrigger>
                  <AccordionContent>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm py-2">
                      {[
                        ["Project Name", info?.projectName],
                        ["Project ID", info?.projectId],
                        ["Region", info?.regionCode],
                        ["Due Date", info?.dueDate],
                        ["Address", info?.projectAddress],
                        ["GC / Client", info?.gcContact],
                        ["Estimator", info?.estimator],
                        ["Anticipated Start", info?.anticipatedStart],
                        ["Anticipated Finish", info?.anticipatedFinish],
                      ].map(([label, val]) => (
                        <div key={label} className="flex items-start gap-2">
                          <span className="text-muted-foreground w-36 shrink-0">{label}</span>
                          {val ? (
                            <span className="font-medium">{val}</span>
                          ) : (
                            <span className="text-muted-foreground italic">not found</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Rates */}
                <AccordionItem value="rates" className="border rounded-lg px-3">
                  <AccordionTrigger className="text-sm font-medium py-3">Markup Rates</AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-2 py-2 text-sm">
                      {[
                        { label: "Overhead (OH%)", val: info?.defaultOh, carry: true },
                        { label: "Escalation (Esc%)", val: info?.defaultEsc, carry: true },
                        { label: "Tax Rate", val: info?.taxRate, carry: true },
                        { label: "Fee%", val: info?.oldFee, carry: false },
                        { label: "Bond Rate", val: info?.oldBondRate, carry: false },
                      ].map(({ label, val, carry }) => (
                        <div key={label} className="flex items-center gap-3">
                          <span className="w-40 text-muted-foreground">{label}</span>
                          <span className="font-medium w-16">{fmtPct(val ?? null)}</span>
                          {carry ? (
                            <Badge className="bg-green-600 text-white text-xs">Will be applied</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Not carried over</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                    {parsedData.catOverrides.length > 0 && (
                      <div className="mt-3 border-t pt-3">
                        <p className="text-xs font-medium text-muted-foreground mb-2">Per-scope overrides detected</p>
                        <div className="space-y-1">
                          {parsedData.catOverrides.map(co => (
                            <div key={co.scopeKey} className="text-xs flex gap-4">
                              <span className="font-medium w-32 truncate">{co.scopeKey}</span>
                              {co.ohOverride !== null && <span>OH: {fmtPct(co.ohOverride)}</span>}
                              {co.escOverride !== null && <span>Esc: {fmtPct(co.escOverride)}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>

                {/* Scopes Found */}
                <AccordionItem value="scopes" className="border rounded-lg px-3">
                  <AccordionTrigger className="text-sm font-medium py-3">
                    Scopes Found ({parsedData.scopes.length})
                  </AccordionTrigger>
                  <AccordionContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Sheet</TableHead>
                          <TableHead>CSI Code</TableHead>
                          <TableHead className="text-right">Items</TableHead>
                          <TableHead className="text-right">Pre-Markup Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {parsedData.scopes.map(sc => (
                          <TableRow key={sc.sheetName}>
                            <TableCell className="font-medium text-xs">{sc.sheetName}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{sc.csiCode || "—"}</TableCell>
                            <TableCell className="text-right text-xs">{sc.lineItems.length}</TableCell>
                            <TableCell className="text-right text-xs">{fmtCurrency(sc.preMarkupSubtotal)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </AccordionContent>
                </AccordionItem>

                {/* Line Items */}
                <AccordionItem value="lineitems" className="border rounded-lg px-3">
                  <AccordionTrigger className="text-sm font-medium py-3">
                    Line Items ({totalItems})
                  </AccordionTrigger>
                  <AccordionContent>
                    <div className="space-y-4">
                      {parsedData.scopes.map(sc => (
                        <div key={sc.sheetName}>
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">{sc.sheetName}</p>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="text-xs">Description</TableHead>
                                <TableHead className="text-xs">Model</TableHead>
                                <TableHead className="text-xs">MFR</TableHead>
                                <TableHead className="text-right text-xs">Qty</TableHead>
                                <TableHead className="text-right text-xs">Unit Cost</TableHead>
                                <TableHead className="text-right text-xs">Extended</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {sc.lineItems.slice(0, 50).map((item, i) => (
                                <TableRow key={i}>
                                  <TableCell className="text-xs max-w-[200px] truncate">{item.description}</TableCell>
                                  <TableCell className="text-xs">{item.model || "—"}</TableCell>
                                  <TableCell className="text-xs">{item.manufacturer || "—"}</TableCell>
                                  <TableCell className="text-right text-xs">{item.qty || "—"}</TableCell>
                                  <TableCell className="text-right text-xs">{item.unitCost ? fmtCurrency(item.unitCost) : "—"}</TableCell>
                                  <TableCell className="text-right text-xs">{item.extendedCost ? fmtCurrency(item.extendedCost) : "—"}</TableCell>
                                </TableRow>
                              ))}
                              {sc.lineItems.length > 50 && (
                                <TableRow>
                                  <TableCell colSpan={6} className="text-xs text-muted-foreground text-center italic">
                                    …{sc.lineItems.length - 50} more items
                                  </TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>

                {/* Quals & Exclusions */}
                {parsedData.scopes.some(sc => sc.inclusions.length + sc.exclusions.length + sc.qualifications.length > 0 || sc.rawQualText) && (
                  <AccordionItem value="quals" className="border rounded-lg px-3">
                    <AccordionTrigger className="text-sm font-medium py-3">Quals & Exclusions</AccordionTrigger>
                    <AccordionContent>
                      <div className="space-y-4 text-sm">
                        {parsedData.scopes.map(sc => {
                          const hasContent = sc.inclusions.length + sc.exclusions.length + sc.qualifications.length > 0 || sc.rawQualText;
                          if (!hasContent) return null;
                          return (
                            <div key={sc.sheetName}>
                              <p className="font-semibold text-xs text-muted-foreground uppercase tracking-wide mb-1">{sc.sheetName}</p>
                              {sc.inclusions.length > 0 && (
                                <div className="mb-1">
                                  <span className="text-xs font-medium text-green-700 dark:text-green-400">Inclusions</span>
                                  <ul className="list-disc list-inside text-xs text-muted-foreground ml-2">
                                    {sc.inclusions.map((l, i) => <li key={i}>{l}</li>)}
                                  </ul>
                                </div>
                              )}
                              {sc.exclusions.length > 0 && (
                                <div className="mb-1">
                                  <span className="text-xs font-medium text-red-700 dark:text-red-400">Exclusions</span>
                                  <ul className="list-disc list-inside text-xs text-muted-foreground ml-2">
                                    {sc.exclusions.map((l, i) => <li key={i}>{l}</li>)}
                                  </ul>
                                </div>
                              )}
                              {sc.qualifications.length > 0 && (
                                <div className="mb-1">
                                  <span className="text-xs font-medium text-blue-700 dark:text-blue-400">Qualifications</span>
                                  <ul className="list-disc list-inside text-xs text-muted-foreground ml-2">
                                    {sc.qualifications.map((l, i) => <li key={i}>{l}</li>)}
                                  </ul>
                                </div>
                              )}
                              {sc.rawQualText && (
                                <pre className="text-xs text-muted-foreground whitespace-pre-wrap bg-muted/40 rounded p-2 mt-1">{sc.rawQualText}</pre>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                )}

                {/* Warnings */}
                {parsedData.warnings.length > 0 && (
                  <AccordionItem value="warnings" className="border rounded-lg px-3">
                    <AccordionTrigger className="text-sm font-medium py-3 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="w-4 h-4 mr-2" />
                      Parse Warnings ({parsedData.warnings.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      <ul className="space-y-1 py-1">
                        {parsedData.warnings.map((w, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                            <Info className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
                            {w}
                          </li>
                        ))}
                      </ul>
                    </AccordionContent>
                  </AccordionItem>
                )}
              </Accordion>

              {/* XLSX macro notice */}
              <Alert className="mt-4">
                <Info className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  Output will be <strong>.xlsx</strong> format. VBA macros in the original template are not preserved — open in Excel and enable any needed functionality after download.
                </AlertDescription>
              </Alert>

              {step === "preview" && (
                <Button
                  className="mt-4 w-full"
                  onClick={() => downloadMutation.mutate()}
                  disabled={downloadMutation.isPending}
                >
                  {downloadMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating…</>
                  ) : (
                    <><Download className="w-4 h-4 mr-2" />Generate Migrated Template</>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Step 3: Download ───────────────────────────────────────────── */}
        {step === "download" && (
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-green-500" />
                Migration Complete
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {migrationMappings.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Scope Mapping Results</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Old Sheet</TableHead>
                        <TableHead className="text-xs">New Sheet</TableHead>
                        <TableHead className="text-xs">Match</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {migrationMappings.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{m.oldSheetName}</TableCell>
                          <TableCell className="text-xs">{m.newSheetName ?? <span className="italic text-muted-foreground">Migrated Data sheet</span>}</TableCell>
                          <TableCell>{matchBadge(m.matchBasis)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {migrationWarnings.length > 0 && (
                <Accordion type="single" collapsible>
                  <AccordionItem value="mw" className="border rounded-lg px-3">
                    <AccordionTrigger className="text-sm font-medium py-3 text-amber-600 dark:text-amber-400">
                      <AlertCircle className="w-4 h-4 mr-2" />
                      Migration Warnings ({migrationWarnings.length})
                    </AccordionTrigger>
                    <AccordionContent>
                      <ul className="space-y-1 py-1">
                        {migrationWarnings.map((w, i) => (
                          <li key={i} className="text-xs text-muted-foreground">{w}</li>
                        ))}
                      </ul>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => downloadMutation.mutate()}
                  disabled={downloadMutation.isPending}
                >
                  {downloadMutation.isPending ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Downloading…</>
                  ) : (
                    <><Download className="w-4 h-4 mr-2" />Download Again</>
                  )}
                </Button>
                <Button variant="outline" className="flex-1" onClick={reset}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Start Over
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
