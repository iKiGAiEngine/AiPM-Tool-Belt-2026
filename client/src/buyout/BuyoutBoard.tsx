// The board view for one loaded buyout project: a compact summary strip + the
// scope cards. Auto-saves on every change via useBuyoutBoard.

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Download, Loader2, CheckCircle2, CloudUpload, Cloud } from "lucide-react";
import { useBuyoutBoard } from "./useBuyoutBoard";
import { ScopeCard } from "./ScopeCard";
import { boardTotals, fmtMoney, fmtSignedMoney, parseJsonOrThrow, type BuyoutBoard as Board, type BuyoutScope } from "./helpers";

interface BuyoutProjectFull {
  id: number;
  name: string;
  boardData: Board;
  status: string;
}

export function BuyoutBoardView({ projectId, onBack }: { projectId: number; onBack: () => void }) {
  const { user } = useAuth();
  const { data, isLoading } = useQuery<BuyoutProjectFull>({
    queryKey: ["/api/buyout/projects", projectId],
    queryFn: async () => {
      const res = await fetch(`/api/buyout/projects/${projectId}`, { credentials: "include" });
      return parseJsonOrThrow(res, "Load project");
    },
  });

  if (isLoading || !data) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }
  return <LoadedBoard project={data} onBack={onBack} senderName={user?.displayName || undefined} senderEmail={user?.email || undefined} />;
}

function LoadedBoard({
  project, onBack, senderName, senderEmail,
}: {
  project: BuyoutProjectFull; onBack: () => void; senderName?: string; senderEmail?: string;
}) {
  const { board, update, saveState } = useBuyoutBoard(project.id, project.boardData);
  const totals = boardTotals(board);

  const updateScope = (scopeId: string, fn: (s: BuyoutScope) => BuyoutScope) =>
    update((b) => ({ ...b, scopes: b.scopes.map((s) => (s.id === scopeId ? fn(s) : s)) }));

  return (
    <div>
      {/* Top bar */}
      <div className="border-b border-border bg-card/60 sticky top-0 z-10 backdrop-blur">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={onBack} style={{ color: "var(--text-dim)" }} data-testid="button-back-projects">
            <ArrowLeft className="w-4 h-4" /> Projects
          </Button>
          <div className="flex-1 min-w-0">
            <div className="font-heading font-semibold text-foreground truncate flex items-center gap-2">
              {project.name}
              {totals.complete && <CheckCircle2 className="w-4 h-4" style={{ color: "var(--win)" }} />}
            </div>
          </div>
          <SaveIndicator state={saveState} />
          <Button size="sm" variant="outline" className="gap-1.5" asChild>
            <a href={`/api/buyout/projects/${project.id}/export`} data-testid="button-export">
              <Download className="w-4 h-4" /> Export
            </a>
          </Button>
        </div>
      </div>

      {/* Summary strip */}
      <div className="border-b border-border bg-card">
        <div className="max-w-4xl mx-auto px-4 py-3 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-center">
          <Metric label="Scopes" value={`${totals.boughtOut}/${totals.scopeCount} bought out`} />
          <Metric label="Budget" value={fmtMoney(totals.budgetTotal)} />
          <Metric label="Awarded" value={fmtMoney(totals.awardedTotal)} accent="var(--gold)" />
          {totals.awardedScopeCount > 0 && (
            <Metric label="Variance" value={fmtSignedMoney(totals.variance)} accent={totals.variance <= 0 ? "var(--win)" : "var(--loss)"} />
          )}
          {totals.complete && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "var(--success-bg)", color: "var(--win)" }}>
              <CheckCircle2 className="w-3.5 h-3.5" /> Buyout Complete
            </span>
          )}
        </div>
      </div>

      {/* Scopes */}
      <div className="max-w-4xl mx-auto px-4 py-5 space-y-3">
        {board.scopes.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">No priced scopes in this estimate.</p>
        ) : (
          board.scopes.map((s) => (
            <ScopeCard
              key={s.id}
              scope={s}
              projectId={project.id}
              projectName={project.name}
              senderName={senderName}
              senderEmail={senderEmail}
              updateScope={(fn) => updateScope(s.id, fn)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="font-heading font-semibold tabular-nums" style={accent ? { color: accent } : undefined}>{value}</span>
    </div>
  );
}

function SaveIndicator({ state }: { state: string }) {
  if (state === "saving") return <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><CloudUpload className="w-3.5 h-3.5 animate-pulse" />Saving…</span>;
  if (state === "saved") return <span className="text-xs inline-flex items-center gap-1" style={{ color: "var(--win)" }}><Cloud className="w-3.5 h-3.5" />Saved</span>;
  if (state === "error") return <span className="text-xs" style={{ color: "var(--loss)" }}>Save failed</span>;
  return null;
}
