import { useQuery, useMutation } from "@tanstack/react-query";
import { CloudUpload, CheckCircle2, AlertTriangle, XCircle, Loader2, PlugZap, ExternalLink, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface RunRecord {
  backupId: string;
  startedAt: string;
  finishedAt: string;
  result: "success" | "local_only" | "failed";
  trigger: string;
  durationSec: number;
  totalBytes?: number;
  totalRows?: number;
  tableCount?: number;
  fileCount?: number;
  webUrl?: string;
  error?: string;
}

interface DrStatus {
  configured: boolean;
  destination: string;
  scheduleHourUtc: number;
  everyHours: number;
  scheduleDisabled: boolean;
  retainDaily: number;
  retainMonthly: number;
  externalTriggerEnabled: boolean;
  pickupEnabled: boolean;
  running: { startedAt: string; trigger: string; step: string } | null;
  lastSuccess: RunRecord | null;
  lastAttempt: RunRecord | null;
  history: RunRecord[];
}

const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");
const fmtMb = (n?: number) => (n ? `${(n / 1024 / 1024).toFixed(1)} MB` : "—");

function ResultBadge({ r }: { r: RunRecord["result"] }) {
  if (r === "success") return <Badge className="bg-emerald-600/15 text-emerald-600 border-emerald-600/30">Saved to Microsoft 365</Badge>;
  if (r === "local_only") return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">Built on server</Badge>;
  return <Badge className="bg-red-600/15 text-red-600 border-red-600/30">Failed</Badge>;
}

/** Admin card: status and controls for the full disaster-recovery backup to Swinerton SharePoint/OneDrive. */
export function DisasterRecoveryCard() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<DrStatus>({
    queryKey: ["/api/admin/dr-backup/status"],
    refetchInterval: (q) => (q.state.data?.running ? 4000 : 60000),
  });

  const run = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/dr-backup/run"),
    onSuccess: () => {
      toast({ title: "Backup started", description: "A full backup is being built and uploaded. This usually takes a few minutes." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/dr-backup/status"] });
    },
    onError: (e: Error) => toast({ title: "Could not start backup", description: e.message, variant: "destructive" }),
  });

  const test = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/dr-backup/test-connection")).json(),
    onSuccess: (r: { message: string }) => toast({ title: "Connection OK", description: r.message }),
    onError: (e: Error) => toast({ title: "Connection failed", description: e.message.replace(/^\d+: /, ""), variant: "destructive" }),
  });

  const last = data?.lastSuccess;
  const lastAttempt = data?.lastAttempt;
  const ageHours = last ? (Date.now() - new Date(last.startedAt).getTime()) / 3_600_000 : Infinity;
  const connected = !!data?.configured || !!data?.pickupEnabled;
  const healthy = connected && ageHours < (data?.everyHours ?? 24) + 6 && lastAttempt?.result !== "failed";

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="card-dr-backup">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" style={{ color: "var(--gold)" }} />
            Disaster Recovery — Swinerton SharePoint / OneDrive
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Every night, AiPM uploads a complete, self-contained backup to Swinerton's Microsoft 365: every database table,
            stored files, the application code, and step-by-step restore instructions. Any single backup can rebuild AiPM from nothing.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending || !data?.configured} data-testid="button-dr-test">
            {test.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <PlugZap className="w-4 h-4 mr-2" />}
            Test connection
          </Button>
          <Button
            onClick={() => run.mutate()}
            disabled={run.isPending || !!data?.running}
            className="bg-gradient-to-r from-[var(--gold)] to-[var(--gold-light)] text-black font-medium"
            data-testid="button-dr-run"
          >
            {data?.running || run.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CloudUpload className="w-4 h-4 mr-2" />}
            {data?.running ? "Backing up..." : "Back up now"}
          </Button>
        </div>
      </div>

      {isLoading || !data ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> Loading backup status...</div>
      ) : (
        <div className="mt-4 space-y-4">
          <div
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              healthy ? "border-emerald-600/30 bg-emerald-600/10" : connected ? "border-red-600/30 bg-red-600/10" : "border-amber-500/30 bg-amber-500/10"
            }`}
            data-testid="text-dr-health"
          >
            {healthy ? <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" /> : connected ? <XCircle className="w-4 h-4 mt-0.5 text-red-600 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />}
            <div className="min-w-0">
              {!connected && <>Not connected to OneDrive/SharePoint yet. Backups are being kept on the AiPM server only. Setup steps (no IT needed) are in <code>docs/DR_SETUP_POWER_AUTOMATE.md</code>.</>}
              {connected && healthy && <>Protected. Last complete backup {fmtTime(last?.startedAt)} ({last?.totalRows?.toLocaleString()} rows, {fmtMb(last?.totalBytes)}).</>}
              {connected && !healthy && (
                <>
                  Attention needed. {lastAttempt?.result === "failed" ? `Last attempt failed: ${lastAttempt.error}` : `No successful backup since ${fmtTime(last?.startedAt)}.`}
                </>
              )}
              {data.running && <div className="text-muted-foreground mt-1">In progress: {data.running.step}</div>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <div><span className="text-foreground font-medium">Destination:</span> <span className="break-all">{data.configured ? data.destination : data.pickupEnabled ? "Your OneDrive, via your nightly Power Automate flow" : data.destination}</span></div>
            <div>
              <span className="text-foreground font-medium">Schedule:</span>{" "}
              {!data.configured && data.pickupEnabled ? "Nightly, by your Power Automate flow" : data.scheduleDisabled ? "Automatic schedule off" : data.everyHours === 24 ? `Daily at ${String(data.scheduleHourUtc).padStart(2, "0")}:00 UTC` : `Every ${data.everyHours} hours (from ${String(data.scheduleHourUtc).padStart(2, "0")}:00 UTC)`}
              {data.configured && data.externalTriggerEnabled ? " · plus Power Automate" : ""}
            </div>
            <div><span className="text-foreground font-medium">Kept:</span> {!data.configured && data.pickupEnabled ? "7 daily + 12 monthly backups in OneDrive" : `all from last 48 h · 1 per day for ${data.retainDaily} days · 1 per month for ${data.retainMonthly} months`}</div>
            {last?.webUrl && (
              <div>
                <a href={last.webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline" style={{ color: "var(--gold)" }}>
                  Open latest backup in SharePoint <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>

          {data.history.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="table-dr-history">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-3 font-medium">Started</th>
                    <th className="py-1.5 pr-3 font-medium">Result</th>
                    <th className="py-1.5 pr-3 font-medium">Rows</th>
                    <th className="py-1.5 pr-3 font-medium">Size</th>
                    <th className="py-1.5 pr-3 font-medium">Time</th>
                    <th className="py-1.5 pr-3 font-medium">Started by</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.startedAt} className="border-b border-border/50 align-top">
                      <td className="py-1.5 pr-3 whitespace-nowrap">{fmtTime(h.startedAt)}</td>
                      <td className="py-1.5 pr-3"><ResultBadge r={h.result} />{h.result === "failed" && <div className="text-red-600 mt-1 max-w-xs break-words">{h.error}</div>}</td>
                      <td className="py-1.5 pr-3">{h.totalRows?.toLocaleString() ?? "—"}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{fmtMb(h.totalBytes)}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{h.durationSec}s</td>
                      <td className="py-1.5 pr-3">{h.trigger}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
