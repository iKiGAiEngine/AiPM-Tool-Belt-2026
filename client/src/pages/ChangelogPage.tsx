import { useEffect, useState } from "react";
import { BackNav } from "@/components/BackNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Copy, Check, Wand2, Save, RefreshCw, GitCommit } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  parseChangelog,
  formatEntryForClipboard,
  getExplanation,
} from "@/lib/changelogParser";
import type { ChangelogEntry } from "@/lib/changelogParser";

type BumpType = "patch" | "minor" | "major";

function bumpVersion(version: string, type: BumpType): string {
  const match = version.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return version;
  let [, maj, min, pat] = match.map(Number);
  if (type === "major") { maj++; min = 0; pat = 0; }
  else if (type === "minor") { min++; pat = 0; }
  else { pat++; }
  return `v${maj}.${min}.${pat}`;
}

function replaceDraftVersion(draft: string, oldVersion: string, newVersion: string): string {
  return draft.replace(oldVersion, newVersion);
}

export default function ChangelogPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [entries, setEntries] = useState<ChangelogEntry[]>([]);
  const [copied, setCopied] = useState(false);

  // Draft modal state
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [baseVersion, setBaseVersion] = useState("v0.1.1");
  const [bumpType, setBumpType] = useState<BumpType>("patch");
  const [commitCount, setCommitCount] = useState(0);
  const [sinceDate, setSinceDate] = useState("");

  // Fetch changelog content
  const { data, isLoading, error } = useQuery({
    queryKey: ["/api/changelog"],
    queryFn: async () => {
      const res = await fetch("/api/changelog");
      if (!res.ok) {
        if (res.status === 403) throw new Error("Only administrators can view the changelog");
        const errorData = await res.json().catch(() => null);
        throw new Error(errorData?.message || `Failed to fetch changelog (${res.status})`);
      }
      return res.json();
    },
  });

  useEffect(() => {
    if (data?.content) {
      const parsed = parseChangelog(data.content);
      setEntries(parsed);
    }
  }, [data]);

  // Generate draft mutation
  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/changelog/generate-draft");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to generate draft");
      }
      return res.json();
    },
    onSuccess: (result) => {
      setBaseVersion(result.nextVersion);
      setBumpType("patch");
      setDraftText(result.draft);
      setCommitCount(result.commitCount);
      setSinceDate(result.sinceDate || "");
      setDraftOpen(true);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Save draft mutation
  const saveMutation = useMutation({
    mutationFn: async (markdown: string) => {
      return apiRequest("POST", "/api/changelog/save", { markdown });
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Changelog entry saved successfully", duration: 3000 });
      setDraftOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/changelog"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  // When bump type changes, replace version in draft text
  const handleBumpChange = (newBump: BumpType) => {
    const newVersion = bumpVersion(baseVersion, newBump);
    const oldVersion = bumpType === "patch"
      ? baseVersion
      : bumpVersion(baseVersion, bumpType);
    setDraftText((prev) => replaceDraftVersion(prev, oldVersion, newVersion));
    setBumpType(newBump);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white dark:bg-zinc-950">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-600 dark:border-yellow-400 mx-auto mb-4"></div>
          <p className="text-gray-700 dark:text-gray-300">Loading changelog...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white dark:bg-zinc-950">
        <div className="text-center text-red-600 dark:text-red-400">
          <p className="text-lg font-semibold">Failed to load changelog</p>
          <p className="text-sm mt-2">Only administrators can view the changelog.</p>
        </div>
      </div>
    );
  }

  const handleCopyEntry = (entry: ChangelogEntry) => {
    const markdown = formatEntryForClipboard(entry);
    navigator.clipboard.writeText(markdown);
    setCopied(true);
    toast({ title: "Copied", description: "Changelog entry copied to clipboard", duration: 2000 });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      <div className="max-w-4xl mx-auto px-6 py-12">

        <div className="mb-4">
          <BackNav href="/admin" label="Admin Dashboard" testId="button-back-admin" />
        </div>
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2 font-rajdhani">
              Changelog
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              AiPM Tool Belt development history and updates
            </p>
          </div>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            data-testid="button-generate-draft"
            className="shrink-0"
            style={{ background: "var(--gold)", color: "#000" }}
          >
            {generateMutation.isPending ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Wand2 className="w-4 h-4 mr-2" />
            )}
            Generate Draft
          </Button>
        </div>

        {/* Copy Entry Dropdown */}
        {entries.length > 0 && (
          <div className="mb-8 bg-gray-50 dark:bg-zinc-900 p-4 rounded-lg border border-gray-200 dark:border-zinc-800">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Copy entry for AI session:
            </label>
            <div className="flex gap-2">
              <Select onValueChange={(idx) => handleCopyEntry(entries[parseInt(idx)])}>
                <SelectTrigger className="w-full max-w-xs bg-white dark:bg-zinc-800 border-gray-300 dark:border-zinc-700">
                  <SelectValue placeholder="Select an entry..." />
                </SelectTrigger>
                <SelectContent className="bg-white dark:bg-zinc-800">
                  {entries.map((entry, idx) => (
                    <SelectItem key={idx} value={idx.toString()}>
                      {entry.date} — {entry.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon"
                disabled={!copied}
                className="text-gray-700 dark:text-gray-300"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        )}

        {/* Changelog Entries */}
        <Accordion type="single" collapsible className="space-y-3">
          {entries.map((entry, idx) => (
            <AccordionItem
              key={idx}
              value={`entry-${idx}`}
              className="border border-gray-200 dark:border-zinc-800 rounded-lg overflow-hidden bg-white dark:bg-zinc-900 hover:shadow-md dark:hover:shadow-black transition-shadow"
            >
              <AccordionTrigger className="px-6 py-4 hover:bg-gray-50 dark:hover:bg-zinc-800 text-left">
                <div className="flex flex-col items-start gap-1">
                  <span className="text-sm font-mono text-gray-500 dark:text-gray-400">
                    {entry.date}
                  </span>
                  <span className="text-lg font-semibold text-gray-900 dark:text-white font-rajdhani">
                    {entry.version}
                  </span>
                </div>
              </AccordionTrigger>

              <AccordionContent className="px-6 py-4 border-t border-gray-200 dark:border-zinc-800">
                {entry.added.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white uppercase tracking-wider mb-3">Added</h3>
                    <ul className="space-y-2 ml-4">
                      {entry.added.map((item, i) => (
                        <li key={`added-${i}`} className="text-sm text-gray-700 dark:text-gray-300 list-disc">
                          {renderBulletWithTooltip(item)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {entry.changed.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white uppercase tracking-wider mb-3">Changed</h3>
                    <ul className="space-y-2 ml-4">
                      {entry.changed.map((item, i) => (
                        <li key={`changed-${i}`} className="text-sm text-gray-700 dark:text-gray-300 list-disc">
                          {renderBulletWithTooltip(item)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {entry.fixed.length > 0 && (
                  <div className="mb-6">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white uppercase tracking-wider mb-3">Fixed</h3>
                    <ul className="space-y-2 ml-4">
                      {entry.fixed.map((item, i) => (
                        <li key={`fixed-${i}`} className="text-sm text-gray-700 dark:text-gray-300 list-disc">
                          {renderBulletWithTooltip(item)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {entry.notes.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white uppercase tracking-wider mb-3">Notes</h3>
                    <ul className="space-y-2 ml-4">
                      {entry.notes.map((item, i) => (
                        <li key={`notes-${i}`} className="text-sm text-gray-700 dark:text-gray-300 list-disc">
                          {renderBulletWithTooltip(item)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        {entries.length === 0 && (
          <div className="text-center py-12 text-gray-500 dark:text-gray-400">
            <p>No changelog entries found</p>
          </div>
        )}
      </div>

      {/* Generate Draft Modal */}
      <Dialog open={draftOpen} onOpenChange={setDraftOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
            <DialogTitle className="font-heading text-lg flex items-center gap-2">
              <Wand2 className="w-4 h-4" style={{ color: "var(--gold)" }} />
              Generated Changelog Draft
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Review, edit, and save this entry to the changelog file.
            </DialogDescription>
          </DialogHeader>

          {/* Meta info bar */}
          <div className="px-6 py-3 border-b bg-muted/30 shrink-0 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <GitCommit className="w-3.5 h-3.5" />
              <span><strong className="text-foreground">{commitCount}</strong> commit{commitCount !== 1 ? "s" : ""} found</span>
            </div>
            {sinceDate && (
              <div className="text-xs text-muted-foreground">
                since <strong className="text-foreground">{sinceDate}</strong>
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Version bump:</span>
              <div className="flex gap-1">
                {(["patch", "minor", "major"] as BumpType[]).map((b) => (
                  <Button
                    key={b}
                    size="sm"
                    variant={bumpType === b ? "default" : "outline"}
                    className="h-6 px-2 text-xs"
                    onClick={() => handleBumpChange(b)}
                    data-testid={`button-bump-${b}`}
                  >
                    {b}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Editable draft area */}
          <div className="flex-1 overflow-auto px-6 py-4 min-h-0">
            <Textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              className="font-mono text-xs min-h-[320px] resize-none bg-muted/20 border-border"
              data-testid="textarea-draft"
              placeholder="Generating..."
            />
            <p className="text-xs text-muted-foreground mt-2">
              You can edit any line before saving. Commit messages are auto-categorized by keyword — move items between sections as needed.
            </p>
          </div>

          <DialogFooter className="px-6 py-4 border-t shrink-0 flex gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(draftText);
                toast({ title: "Copied", description: "Draft copied to clipboard", duration: 2000 });
              }}
              data-testid="button-copy-draft"
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Copy
            </Button>
            <Button
              onClick={() => saveMutation.mutate(draftText)}
              disabled={saveMutation.isPending || !draftText.trim()}
              data-testid="button-save-changelog"
              style={{ background: "var(--gold)", color: "#000" }}
            >
              {saveMutation.isPending ? (
                <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5 mr-1.5" />
              )}
              Save to Changelog
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Extract technical terms from text for tooltips
function renderBulletWithTooltip(bullet: string): JSX.Element | JSX.Element[] {
  const terms = extractTechnicalTerms(bullet);
  if (terms.length === 0) return <span>{bullet}</span>;

  let lastIndex = 0;
  const parts: JSX.Element[] = [];

  terms.forEach((term, idx) => {
    const startIdx = bullet.indexOf(term.text, lastIndex);
    if (startIdx > lastIndex) {
      parts.push(<span key={`text-${idx}`}>{bullet.substring(lastIndex, startIdx)}</span>);
    }
    const explanation = getExplanation(term.text);
    if (explanation) {
      parts.push(
        <TooltipProvider key={`tooltip-${idx}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="underline decoration-dotted decoration-yellow-600 dark:decoration-yellow-400 cursor-help">
                {term.text}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs bg-gray-900 dark:bg-white text-white dark:text-black">
              <p>{explanation}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    } else {
      parts.push(<span key={`text-plain-${idx}`}>{term.text}</span>);
    }
    lastIndex = startIdx + term.text.length;
  });

  if (lastIndex < bullet.length) {
    parts.push(<span key="text-end">{bullet.substring(lastIndex)}</span>);
  }
  return parts;
}

function extractTechnicalTerms(text: string): Array<{ text: string; startIdx: number }> {
  const terms = [
    "RBAC", "OTP", "UUID", "serial", "HTTP-only cookies", "ACID",
    "Drizzle ORM", "Zod validation", "Rate limiting", "Soft delete",
    "Hard delete", "Session store", "OAuth 2.0", "Bi-directional sync",
    "Proposal log", "Audit trail", "Ownership check", "Admin bypass",
    "Async", "GPT-4o", "OCR", "PDF parsing", "FK NOT NULL", "FK",
  ];
  const found: Array<{ text: string; startIdx: number }> = [];
  for (const term of terms) {
    let index = text.indexOf(term);
    while (index !== -1) {
      found.push({ text: term, startIdx: index });
      index = text.indexOf(term, index + 1);
    }
  }
  return found
    .sort((a, b) => a.startIdx - b.startIdx)
    .reduce((unique: typeof found, item) => {
      if (!unique.some((u) => u.startIdx === item.startIdx)) unique.push(item);
      return unique;
    }, []);
}
