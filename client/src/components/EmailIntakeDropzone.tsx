import { useState, useRef, useCallback } from "react";
import { Mail, Loader2, CheckCircle2, AlertTriangle, XCircle, Copy, ExternalLink, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface DuplicateMatch {
  id: number;
  projectName: string;
  estimateNumber: string | null;
  region: string | null;
  estimateStatus: string | null;
  score: number;
}

interface IntakeFileResult {
  fileName: string;
  status: "draft_created" | "duplicate_intake" | "failed";
  intakeId: number | null;
  entryId: number | null;
  fields: Record<string, any> | null;
  provenance: Record<string, "email" | "bc" | "fallback"> | null;
  bcEnrichment: { status: string; opportunityId: string | null; ndaRequired: boolean };
  duplicates: DuplicateMatch[];
  extractionTier: string | null;
  message: string;
  error: string | null;
}

const DISPLAY_FIELDS: Array<{ key: string; label: string }> = [
  { key: "projectName", label: "Project" },
  { key: "region", label: "Region" },
  { key: "dueDate", label: "Due" },
  { key: "inviteDate", label: "Invited" },
  { key: "anticipatedStart", label: "Start" },
  { key: "anticipatedFinish", label: "Finish" },
  { key: "gcEstimateLead", label: "GC Lead" },
  { key: "owner", label: "GC / Owner" },
  { key: "projectAddress", label: "Location" },
  { key: "primaryMarket", label: "Market" },
];

function isEmailFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".eml") || lower.endsWith(".msg");
}

export function EmailIntakeDropzone() {
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [results, setResults] = useState<IntakeFileResult[]>([]);
  const [mergedRounds, setMergedRounds] = useState<Record<number, number>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  const invalidateLog = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/all-entries"] });
    queryClient.invalidateQueries({ queryKey: ["/api/proposal-log/entries"] });
  };

  const uploadFiles = useCallback(async (files: File[]) => {
    const emailFiles = files.filter(f => isEmailFile(f.name));
    const rejected = files.filter(f => !isEmailFile(f.name));
    const rejectedResults: IntakeFileResult[] = rejected.map(f => ({
      fileName: f.name,
      status: "failed",
      intakeId: null,
      entryId: null,
      fields: null,
      provenance: null,
      bcEnrichment: { status: "no_link", opportunityId: null, ndaRequired: false },
      duplicates: [],
      extractionTier: null,
      message: "Not an email file — drop .eml or .msg files",
      error: "Not an email file",
    }));

    if (emailFiles.length === 0) {
      if (rejectedResults.length > 0) setResults(prev => [...rejectedResults, ...prev]);
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      for (const f of emailFiles.slice(0, 10)) formData.append("emails", f);

      const res = await fetch("/api/email-intake", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        throw new Error(errData?.message || `Upload failed (${res.status})`);
      }
      const data = (await res.json()) as { results: IntakeFileResult[] };
      setResults(prev => [...rejectedResults, ...data.results, ...prev]);

      const created = data.results.filter(r => r.status === "draft_created").length;
      const dups = data.results.filter(r => r.status === "duplicate_intake").length;
      const failed = data.results.filter(r => r.status === "failed").length;
      if (created > 0) invalidateLog();
      toast({
        title:
          created > 0
            ? `${created} draft${created === 1 ? "" : "s"} added to the proposal log`
            : failed > 0 && dups === 0
              ? "Email intake had problems"
              : "Emails processed",
        description: [
          created > 0 ? `${created} new draft${created === 1 ? "" : "s"} awaiting review` : null,
          dups > 0 ? `${dups} already in the log` : null,
          failed > 0 ? `${failed} failed — see details below` : null,
        ].filter(Boolean).join(" · "),
        variant: failed > 0 && created === 0 ? "destructive" : undefined,
      });
    } catch (err: any) {
      toast({
        title: "Email intake failed",
        description: err.message || "Could not upload email files",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  }, [toast]);

  const addAsRound = async (result: IntakeFileResult, target: DuplicateMatch) => {
    if (!result.entryId) return;
    try {
      await apiRequest("POST", `/api/bc/drafts/${result.entryId}/approve`, { mergeIntoId: target.id });
      setMergedRounds(prev => ({ ...prev, [result.entryId!]: target.id }));
      invalidateLog();
      toast({
        title: "Bid round added",
        description: `Added as a new bid round on "${target.projectName}"${target.estimateNumber ? ` (#${target.estimateNumber})` : ""}.`,
      });
    } catch (err: any) {
      toast({
        title: "Could not add bid round",
        description: err?.message || "You may need Draft Review access — an admin can merge it from the Drafts tab instead.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-3">
      <div
        tabIndex={0}
        className={cn(
          "border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition-all duration-200 outline-none",
          isDragging ? "ring-2" : "border-border hover:border-muted-foreground/50",
        )}
        style={isDragging ? { borderColor: "var(--gold)", background: "rgba(200,164,78,0.1)", boxShadow: "0 0 0 2px rgba(201,168,76,0.3)" } : undefined}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) uploadFiles(files);
        }}
        onClick={() => inputRef.current?.click()}
        data-testid="dropzone-email-intake"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".eml,.msg,message/rfc822,application/vnd.ms-outlook"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) uploadFiles(files);
            e.target.value = "";
          }}
          data-testid="input-email-intake"
        />
        {isUploading ? (
          <div className="flex flex-col items-center gap-2 py-2">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--gold)" }} />
            <p className="font-medium text-foreground">Reading email and pulling bid details…</p>
            <p className="text-sm text-muted-foreground">Parsing, checking BuildingConnected, and adding to the log</p>
          </div>
        ) : (
          <>
            <Mail className="w-10 h-10 mx-auto mb-2" style={{ color: "var(--gold)", opacity: 0.7 }} />
            <p className="font-medium text-foreground">Drop bid invite emails here (.eml / .msg)</p>
            <p className="text-sm text-muted-foreground mt-1">
              Each email becomes a draft in the proposal log for review — BuildingConnected invites are auto-enriched from the invite link
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Tip: Outlook can't drag straight into a browser — drag the email to your Desktop first (or File → Save As), then drop the file here
            </p>
          </>
        )}
      </div>

      {results.length > 0 && (
        <div className="space-y-2" data-testid="email-intake-results">
          {results.map((r, idx) => {
            const merged = r.entryId != null ? mergedRounds[r.entryId] : undefined;
            return (
              <div
                key={`${r.fileName}-${idx}`}
                className={cn(
                  "rounded-md border p-3 text-sm",
                  r.status === "draft_created" && "border-green-600/40 bg-green-500/5",
                  r.status === "duplicate_intake" && "border-border bg-muted/40",
                  r.status === "failed" && "border-destructive/40 bg-destructive/5",
                )}
                data-testid={`email-intake-result-${idx}`}
              >
                <div className="flex items-start gap-2">
                  {r.status === "draft_created" && <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-green-600" />}
                  {r.status === "duplicate_intake" && <Copy className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />}
                  {r.status === "failed" && <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground truncate">{r.fileName}</p>
                    <p className="text-muted-foreground">
                      {merged ? `Added as a bid round on entry #${merged}.` : r.message}
                    </p>

                    {r.status === "draft_created" && r.fields && !merged && (
                      <>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {DISPLAY_FIELDS.map(({ key, label }) => {
                            const value = r.fields?.[key];
                            if (!value) return null;
                            const source = r.provenance?.[key];
                            return (
                              <span
                                key={key}
                                className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-xs"
                                title={source === "bc" ? "Pulled from BuildingConnected" : source === "fallback" ? "Minimal extraction — verify" : "Extracted from the email"}
                              >
                                <span className="text-muted-foreground">{label}:</span>
                                <span className="font-medium text-foreground">{String(value).slice(0, 60)}</span>
                                {source && (
                                  <Badge variant="outline" className={cn("h-4 px-1 text-[10px]", source === "bc" && "border-blue-500/50 text-blue-600", source === "fallback" && "border-amber-500/50 text-amber-600")}>
                                    {source === "bc" ? "BC" : source === "fallback" ? "check" : "email"}
                                  </Badge>
                                )}
                              </span>
                            );
                          })}
                        </div>

                        {r.bcEnrichment.status === "no_connection" && (
                          <p className="mt-2 text-xs text-amber-600">
                            BuildingConnected not connected — imported from the email only.{" "}
                            <a href="/api/autodesk/login" className="underline">Connect BuildingConnected</a> to auto-pull full details next time.
                          </p>
                        )}
                        {r.bcEnrichment.ndaRequired && (
                          <p className="mt-2 text-xs text-amber-600">NDA-restricted invite — some details stay hidden until the NDA is accepted in BuildingConnected.</p>
                        )}
                        {r.extractionTier === "floor" && (
                          <p className="mt-2 text-xs text-amber-600">Minimal extraction (subject/sender only) — open the draft and fill in the details.</p>
                        )}

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {/* /tools/proposal-log is served by Express as a static page, not a
                              wouter route — use a real <a> navigation so it doesn't 404. */}
                          <a href="/tools/proposal-log?tab=newbids">
                            <Button size="sm" variant="outline" className="h-7 text-xs" data-testid={`button-review-draft-${idx}`}>
                              <ExternalLink className="w-3 h-3 mr-1" /> Review in BC Invites tab
                            </Button>
                          </a>
                          {r.intakeId != null && (
                            <a href={`/api/email-intake/${r.intakeId}/raw`} className="text-xs text-muted-foreground underline">
                              Original email
                            </a>
                          )}
                        </div>

                        {r.duplicates.length > 0 && (
                          <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
                            <p className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-500">
                              <AlertTriangle className="w-3 h-3" /> Possible re-bid of an existing project
                            </p>
                            <div className="mt-1 space-y-1">
                              {r.duplicates.slice(0, 3).map(d => (
                                <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                  <span className="min-w-0 truncate">
                                    {d.projectName}
                                    {d.estimateNumber ? ` (#${d.estimateNumber})` : ""} — {Math.round(d.score * 100)}% match
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-[11px]"
                                    onClick={() => addAsRound(r, d)}
                                    data-testid={`button-add-round-${idx}-${d.id}`}
                                  >
                                    <Layers className="w-3 h-3 mr-1" /> Add as bid round
                                  </Button>
                                </div>
                              ))}
                            </div>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Or keep it as its own draft — the duplicate warning stays on the draft for the reviewer.
                            </p>
                          </div>
                        )}
                      </>
                    )}

                    {r.status === "duplicate_intake" && r.entryId != null && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Existing entry #{r.entryId} —{" "}
                        <a href="/tools/proposal-log?tab=newbids" className="underline">open the log</a>
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
