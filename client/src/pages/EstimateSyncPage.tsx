import { useQuery } from "@tanstack/react-query";
import { Link, useRoute } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, ChevronRight, FileSpreadsheet, Loader2 } from "lucide-react";
import { BackNav } from "@/components/BackNav";

// Read-only view of estimate workbooks synced from the shared folder.
// All editing happens in the Excel estimate; nothing here writes back.

interface WorkbookListItem {
  id: number;
  projectName: string;
  estimateNumber: string | null;
  proposalTotal: string;
  syncedAt: string;
  scopeCount: number;
  bidDueDate: string | null;
  nbsEstimator: string | null;
  proposalLogEntryId: number | null;
}

interface LineItem {
  specNo: string; planCallout: string; description: string; model: string; qty: number;
  totalMaterial: number; totalFreight: number; totalSub: number; total: number; remarks: string;
}
interface Scope { sheetName: string; label: string; material: number; freight: number; sub: number; total: number; lineItems: LineItem[] }
interface SummaryRow { scope: string; escalation: number; overhead: number; fee: number; material: number; freight: number; tax: number; total: number }
interface WorkbookDetail {
  id: number; fileName: string; projectName: string; proposalTotal: string; syncedAt: string; warnings: string[];
  project: { estimateNumber?: string; bidDueDate?: string | null; planVersion?: string; nbsEstimator?: string; gcEstimator?: string; taxRate?: number | null; overheadRate?: number | null };
  summaryRows: SummaryRow[];
  scopes: Scope[];
}

const usd = (n: number | string) =>
  Number(n).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = (n: number) =>
  n ? n.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "—";
const pct = (n?: number | null) => (n == null ? "—" : `${+(n * 100).toFixed(2)}%`);
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function List() {
  const { data, isLoading } = useQuery<WorkbookListItem[]>({ queryKey: ["/api/estimate-sync/workbooks"] });

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 md:px-8">
      <BackNav href="/" label="Home" />
      <div className="mb-6 mt-4">
        <h1 className="text-2xl font-semibold tracking-tight">Synced Estimates</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Live view of the estimate workbooks. Edit the Excel sheet; AiPM updates when it is saved.
        </p>
      </div>
      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : !data?.length ? (
        <Card className="flex flex-col items-center gap-2 p-12 text-center">
          <FileSpreadsheet className="h-10 w-10 text-muted-foreground" />
          <div className="font-medium">No estimates synced yet</div>
          <p className="max-w-md text-sm text-muted-foreground">
            Once the shared folder connection is running, saved estimate workbooks appear here automatically.
          </p>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Est. #</TableHead>
                <TableHead>Estimator</TableHead>
                <TableHead>Bid due</TableHead>
                <TableHead className="text-right">Scopes</TableHead>
                <TableHead className="text-right">Proposal total</TableHead>
                <TableHead>Last synced</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((w) => (
                <TableRow key={w.id} className="cursor-pointer hover:bg-muted/50">
                  <TableCell className="font-medium">
                    <Link href={`/estimate-sync/${w.id}`}>{w.projectName}</Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{w.estimateNumber || "—"}</TableCell>
                  <TableCell>{w.nbsEstimator || "—"}</TableCell>
                  <TableCell>{w.bidDueDate || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{w.scopeCount}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{usd(w.proposalTotal)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{when(w.syncedAt)}</TableCell>
                  <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const { data, isLoading } = useQuery<WorkbookDetail>({ queryKey: [`/api/estimate-sync/workbooks/${id}`] });
  if (isLoading || !data) {
    return <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const p = data.project;
  const scopeTotal = data.scopes.reduce((s, x) => s + x.total, 0);

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 md:px-8">
      <BackNav href="/estimate-sync" label="Synced Estimates" />
      <div className="mb-6 mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{data.projectName}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {p.estimateNumber && p.estimateNumber !== "TBD" ? `Estimate ${p.estimateNumber} · ` : ""}
            {p.nbsEstimator || "No estimator"} · Bid due {p.bidDueDate || "—"}
          </p>
        </div>
        <Badge variant="secondary" className="gap-1.5">
          <FileSpreadsheet className="h-3.5 w-3.5" />
          Synced from {data.fileName} · {when(data.syncedAt)}
        </Badge>
      </div>

      {data.warnings.length > 0 && (
        <Alert className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{data.warnings.join(" ")}</AlertDescription>
        </Alert>
      )}

      <Card className="mb-8 grid grid-cols-2 divide-x divide-y md:grid-cols-4 md:divide-y-0">
        <Stat label="Proposal total" value={usd(data.proposalTotal)} />
        <Stat label="Scope subtotal" value={usd(scopeTotal)} />
        <Stat label="Priced scopes" value={String(data.scopes.length)} />
        <Stat label="Tax / overhead" value={`${pct(p.taxRate)} / ${pct(p.overheadRate)}`} />
      </Card>

      <h2 className="mb-4 text-lg font-semibold">Scopes</h2>
      {data.scopes.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">No scope has line items yet.</Card>
      ) : (
        <Accordion type="multiple" className="rounded-lg border">
          {data.scopes.map((s) => (
            <AccordionItem key={s.sheetName} value={s.sheetName} className="px-6">
              <AccordionTrigger className="hover:no-underline">
                <div className="grid w-full grid-cols-[1fr_auto] items-center gap-4 pr-4 text-left md:grid-cols-[1fr_repeat(4,8rem)]">
                  <div>
                    <div className="font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.lineItems.length} line items</div>
                  </div>
                  <div className="hidden text-right text-sm tabular-nums text-muted-foreground md:block">{usd(s.material)}<div className="text-xs">Material</div></div>
                  <div className="hidden text-right text-sm tabular-nums text-muted-foreground md:block">{usd(s.freight)}<div className="text-xs">Freight</div></div>
                  <div className="hidden text-right text-sm tabular-nums text-muted-foreground md:block">{usd(s.sub)}<div className="text-xs">Sub</div></div>
                  <div className="text-right font-semibold tabular-nums">{usd(s.total)}</div>
                </div>
              </AccordionTrigger>
              <AccordionContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Callout</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Material</TableHead>
                        <TableHead className="text-right">Freight</TableHead>
                        <TableHead className="text-right">Sub</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                        <TableHead>Remarks</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.lineItems.map((li, i) => (
                        <TableRow key={i}>
                          <TableCell className="font-mono text-sm">{li.planCallout || "—"}</TableCell>
                          <TableCell>{li.description}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{li.model || "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{li.qty}</TableCell>
                          <TableCell className="text-right tabular-nums">{usd2(li.totalMaterial)}</TableCell>
                          <TableCell className="text-right tabular-nums">{usd2(li.totalFreight)}</TableCell>
                          <TableCell className="text-right tabular-nums">{usd2(li.totalSub)}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{usd2(li.total)}</TableCell>
                          <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{li.remarks}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
    </div>
  );
}

export default function EstimateSyncPage() {
  const [match, params] = useRoute("/estimate-sync/:id");
  return match && params ? <Detail id={params.id} /> : <List />;
}
