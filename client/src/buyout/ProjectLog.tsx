// Buyout Bot home screen: a log of saved buyout projects + the estimate ingest
// dropzone. Each dropped estimate becomes a saved project (named from the file).

import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Upload, Loader2, Trash2, CheckCircle2, FileSpreadsheet, PackageCheck } from "lucide-react";
import { boardFromParsed, fmtMoney } from "./helpers";
import type { ParsedEstimate } from "@shared/buyout/estimateParser";

interface BuyoutProjectRow {
  id: number;
  name: string;
  sourceFilename: string | null;
  status: string;
  scopeCount: number;
  boughtOutCount: number;
  budgetTotal: string;
  awardedTotal: string;
  awardedBudget: string;
  updatedAt: string;
}

export function ProjectLog({ onOpen }: { onOpen: (id: number) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: projects, isLoading } = useQuery<BuyoutProjectRow[]>({
    queryKey: ["/api/buyout/projects"],
  });

  const ingest = useCallback(
    async (file: File) => {
      const lower = file.name.toLowerCase();
      if (!lower.endsWith(".xlsx") && !lower.endsWith(".xlsm")) {
        toast({ title: "Wrong file type", description: "Drop an NBS estimate workbook (.xlsx or .xlsm).", variant: "destructive" });
        return;
      }
      setIngesting(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const parseRes = await fetch("/api/buyout/parse", { method: "POST", body: fd, credentials: "include" });
        if (!parseRes.ok) throw new Error((await parseRes.text()) || "Parse failed");
        const parsed: ParsedEstimate = await parseRes.json();
        if (!parsed.scopes || parsed.scopes.length === 0) {
          toast({ title: "No priced scopes found", description: "The parser found no scopes with a grand total. Check the workbook.", variant: "destructive" });
          setIngesting(false);
          return;
        }
        const board = boardFromParsed(parsed);
        const name = file.name.replace(/\.(xlsx|xlsm)$/i, "");
        const createRes = await apiRequest("POST", "/api/buyout/projects", {
          name,
          sourceFilename: file.name,
          board,
        });
        const created = await createRes.json();
        qc.invalidateQueries({ queryKey: ["/api/buyout/projects"] });
        toast({
          title: "Estimate parsed",
          description: `${parsed.scopes.length} scope(s), ${parsed.scopes.reduce((s, x) => s + x.items.length, 0)} line items. ${parsed.skipped.length} sheet(s) skipped.`,
        });
        onOpen(created.id);
      } catch (err: any) {
        toast({ title: "Couldn't parse estimate", description: err?.message || "Unknown error", variant: "destructive" });
      } finally {
        setIngesting(false);
      }
    },
    [toast, qc, onOpen]
  );

  const doDelete = useCallback(async () => {
    if (deleteId == null) return;
    try {
      await apiRequest("DELETE", `/api/buyout/projects/${deleteId}`);
      qc.invalidateQueries({ queryKey: ["/api/buyout/projects"] });
      toast({ title: "Project deleted" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: err?.message, variant: "destructive" });
    } finally {
      setDeleteId(null);
    }
  }, [deleteId, qc, toast]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* Ingest */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void ingest(f);
        }}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${dragging ? "border-primary bg-accent" : "border-border bg-card"}`}
        data-testid="buyout-dropzone"
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xlsm"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void ingest(f); e.target.value = ""; }}
        />
        {ingesting ? (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="w-8 h-8 animate-spin" style={{ color: "var(--gold)" }} />
            <p className="text-sm">Parsing estimate workbook…</p>
          </div>
        ) : (
          <>
            <FileSpreadsheet className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--gold)" }} />
            <p className="text-foreground font-medium mb-1">Drop an NBS estimate workbook to start a buyout</p>
            <p className="text-sm text-muted-foreground mb-4">.xlsx or .xlsm — every priced scope becomes a trackable buyout</p>
            <Button onClick={() => fileRef.current?.click()} data-testid="button-pick-estimate" className="gap-2">
              <Upload className="w-4 h-4" /> Choose file
            </Button>
          </>
        )}
      </div>

      {/* Project log */}
      <div className="mt-8">
        <h2 className="font-heading text-lg font-semibold text-foreground mb-3">Buyout Projects</h2>
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : !projects || projects.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No buyout projects yet. Drop an estimate above to begin.</p>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => {
              const budget = parseFloat(p.budgetTotal) || 0;
              const awarded = parseFloat(p.awardedTotal) || 0;
              const awardedBudget = parseFloat(p.awardedBudget) || 0;
              // Savings compares awarded $ against the budget of the awarded scopes
              // only (matches the prototype) — positive = under budget.
              const savings = awardedBudget - awarded;
              const complete = p.status === "complete";
              return (
                <div
                  key={p.id}
                  className="group flex items-center gap-4 rounded-lg border border-border bg-card p-4 hover:bg-accent/40 cursor-pointer transition-colors"
                  onClick={() => onOpen(p.id)}
                  data-testid={`buyout-project-${p.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground truncate">{p.name}</span>
                      {complete && (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: "var(--success-bg)", color: "var(--win)" }}>
                          <CheckCircle2 className="w-3 h-3" /> Buyout Complete
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className="inline-flex items-center gap-1"><PackageCheck className="w-3 h-3" />{p.boughtOutCount}/{p.scopeCount} bought out</span>
                      <span>Budget {fmtMoney(budget)}</span>
                      {awarded > 0 && <span>Awarded {fmtMoney(awarded)}</span>}
                    </div>
                  </div>
                  {awarded > 0 && (
                    <div className="text-right shrink-0">
                      <div className="text-xs text-muted-foreground">{savings >= 0 ? "Under budget" : "Over budget"}</div>
                      <div className="font-semibold tabular-nums" style={{ color: savings >= 0 ? "var(--win)" : "var(--loss)" }}>
                        {fmtMoney(Math.abs(savings))}
                      </div>
                    </div>
                  )}
                  <Button
                    variant="ghost" size="icon"
                    className="opacity-0 group-hover:opacity-100 shrink-0"
                    onClick={(e) => { e.stopPropagation(); setDeleteId(p.id); }}
                    data-testid={`button-delete-${p.id}`}
                  >
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog open={deleteId != null} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this buyout project?</AlertDialogTitle>
            <AlertDialogDescription>This removes the board and all logged quotes/awards. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
