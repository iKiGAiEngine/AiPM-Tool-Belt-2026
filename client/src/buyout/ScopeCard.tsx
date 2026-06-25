// One BuyoutScope: budget, buyout clock, line items, vendor selection, quotes
// (typed or AI-read+verify), multi-vendor line-level awards + coverage, RFQ
// send, and the PO step. All edits flow through `updateScope` → board autosave.

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ChevronDown, ChevronRight, Star, Clock, AlertTriangle, CheckCircle2, Send,
  Sparkles, Loader2, FileUp, ShieldCheck, Mail, MailWarning, Trophy, ListChecks,
} from "lucide-react";
import {
  type BuyoutScope, type QuoteResponse, type LineItem,
  combinedAwardedTotal, awardedVariance, coverageReport, computeReleaseBy,
  clockUrgency, isQuoteStale, canAward, fmtMoney, fmtSignedMoney, genId,
  SCOPE_STATUS_LABEL, DEFAULT_VALIDITY_DAYS,
} from "./helpers";
import type { AiQuoteExtraction } from "@shared/buyout/types";

interface VendorForScope {
  id: number;
  name: string;
  scopes: string[];
  preferredForTrades: string[];
  email: string | null;
  contactName: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

export function ScopeCard({
  scope, projectId, projectName, senderName, senderEmail, updateScope,
}: {
  scope: BuyoutScope;
  projectId: number;
  projectName: string;
  senderName?: string;
  senderEmail?: string;
  updateScope: (fn: (s: BuyoutScope) => BuyoutScope) => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [selectedVendorIds, setSelectedVendorIds] = useState<Set<number>>(new Set());
  const [sendingRfq, setSendingRfq] = useState(false);
  const [confirmRfq, setConfirmRfq] = useState(false);
  const [readingFor, setReadingFor] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestions, setSuggestions] = useState<{ name: string; note: string }[] | null>(null);
  const aiFileRef = useRef<HTMLInputElement>(null);
  const aiVendorRef = useRef<VendorForScope | null>(null);

  const { data: vendors, refetch: refetchVendors } = useQuery<VendorForScope[]>({
    queryKey: ["/api/mfr/vendors/by-scope", scope.name],
    queryFn: async () => {
      const res = await fetch(`/api/mfr/vendors/by-scope?scope=${encodeURIComponent(scope.name)}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load vendors");
      return res.json();
    },
    enabled: expanded,
  });

  const awarded = combinedAwardedTotal(scope);
  const variance = awardedVariance(scope);
  const cov = coverageReport(scope);
  const clock = computeReleaseBy(scope);
  const urgency = clockUrgency(scope);
  const allowanceCount = scope.items.filter((i) => i.isAllowance).length;

  // Awarded vendors sort to the top, marked ★.
  const sortedVendors = useMemo(() => {
    if (!vendors) return [];
    const preferredVendorIds = new Set(
      vendors.filter((v) => (v.preferredForTrades || []).includes(scope.name)).map((v) => v.id)
    );
    return [...vendors].sort((a, b) => {
      const aw = scope.awardedVendorIds.includes(String(a.id)) ? 0 : 1;
      const bw = scope.awardedVendorIds.includes(String(b.id)) ? 0 : 1;
      if (aw !== bw) return aw - bw;
      const ap = preferredVendorIds.has(a.id) ? 0 : 1;
      const bp = preferredVendorIds.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.name.localeCompare(b.name);
    });
  }, [vendors, scope.awardedVendorIds, scope.name]);

  // Pre-check preferred vendors once vendors load.
  useMemo(() => {
    if (!vendors) return;
    setSelectedVendorIds((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set<number>();
      for (const v of vendors) {
        if ((v.preferredForTrades || []).includes(scope.name) && v.email) next.add(v.id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendors]);

  const getQuote = (vendorId: number) => scope.quotes.find((q) => q.vendorId === String(vendorId));

  function recomputeStatus(s: BuyoutScope): BuyoutScope {
    if (s.status === "po") return s;
    let status = s.status;
    if (s.awardedVendorIds.length > 0) status = "awarded";
    else if (s.quotes.length > 0) status = s.status === "rfq_sent" ? "quotes_in" : (s.status === "not_started" ? "quotes_in" : s.status);
    return { ...s, status };
  }

  // ---- Quote logging (typed = verified; AI = unverified) -------------------
  function upsertQuote(vendor: VendorForScope, patch: Partial<QuoteResponse>, fromAi = false) {
    updateScope((s) => {
      const existing = s.quotes.find((q) => q.vendorId === String(vendor.id));
      let quotes: QuoteResponse[];
      if (existing) {
        quotes = s.quotes.map((q) => (q.vendorId === String(vendor.id) ? { ...q, ...patch } : q));
      } else {
        const q: QuoteResponse = {
          id: genId("q"),
          vendorId: String(vendor.id),
          vendorName: vendor.name,
          quoteAmount: 0,
          note: "",
          coveredLineIds: null,
          leadTimeWeeks: 0,
          quoteDate: patch.quoteAmount != null && patch.quoteAmount > 0 ? today() : null,
          validityDays: DEFAULT_VALIDITY_DAYS,
          attachments: [],
          aiSuggested: fromAi,
          verified: !fromAi,
          ...patch,
        };
        quotes = [...s.quotes, q];
      }
      return recomputeStatus({ ...s, quotes });
    });
  }

  function verifyQuote(vendorId: string) {
    updateScope((s) => ({
      ...s,
      quotes: s.quotes.map((q) => (q.vendorId === vendorId ? { ...q, verified: true, aiSuggested: false } : q)),
    }));
  }

  function toggleAward(vendorId: string) {
    updateScope((s) => {
      const isAwarded = s.awardedVendorIds.includes(vendorId);
      const awardedVendorIds = isAwarded
        ? s.awardedVendorIds.filter((id) => id !== vendorId)
        : [...s.awardedVendorIds, vendorId];
      return recomputeStatus({ ...s, awardedVendorIds });
    });
  }

  function setCoveredLines(vendorId: string, coveredLineIds: string[] | null) {
    updateScope((s) => ({
      ...s,
      quotes: s.quotes.map((q) => (q.vendorId === vendorId ? { ...q, coveredLineIds } : q)),
    }));
  }

  function togglePreferred(vendor: VendorForScope) {
    const isPref = (vendor.preferredForTrades || []).includes(scope.name);
    const next = isPref
      ? (vendor.preferredForTrades || []).filter((t) => t !== scope.name)
      : [...(vendor.preferredForTrades || []), scope.name];
    // Optimistic: persist to the vendor record (single source of truth).
    apiRequest("PUT", `/api/mfr/vendors/${vendor.id}`, {
      name: vendor.name, scopes: vendor.scopes, preferredForTrades: next,
    }).then(() => {
      vendor.preferredForTrades = next; // mutate cached object for immediate UI
      toast({ title: isPref ? "Removed preferred" : "Marked preferred", description: `${vendor.name} · ${scope.name}` });
    }).catch((e) => toast({ title: "Couldn't update vendor", description: e?.message, variant: "destructive" }));
  }

  // ---- RFQ send (one email per vendor, confirmation-gated) -----------------
  const rfqRecipients = useMemo(
    () => sortedVendors.filter((v) => selectedVendorIds.has(v.id) && v.email),
    [sortedVendors, selectedVendorIds]
  );

  async function doSendRfq() {
    setConfirmRfq(false);
    setSendingRfq(true);
    try {
      const res = await apiRequest("POST", `/api/buyout/projects/${projectId}/rfq`, {
        scopeId: scope.id,
        senderName, senderEmail,
        recipients: rfqRecipients.map((v) => ({ vendorId: v.id, vendorName: v.name, email: v.email, contactName: v.contactName })),
      });
      const data = await res.json();
      // Reflect rfq_sent locally + create placeholder quote rows for solicited vendors.
      updateScope((s) => {
        const quotes = [...s.quotes];
        for (const v of rfqRecipients) {
          if (!quotes.find((q) => q.vendorId === String(v.id))) {
            quotes.push({
              id: genId("q"), vendorId: String(v.id), vendorName: v.name, quoteAmount: 0, note: "",
              coveredLineIds: null, leadTimeWeeks: 0, quoteDate: null, validityDays: DEFAULT_VALIDITY_DAYS,
              attachments: [], aiSuggested: false, verified: false,
            });
          }
        }
        return { ...s, quotes, status: s.status === "not_started" ? "rfq_sent" : s.status };
      });
      toast({
        title: `RFQ sent to ${data.sent} vendor(s)`,
        description: data.failed > 0 ? `${data.failed} failed — check vendor emails.` : "One individual email per vendor.",
        variant: data.failed > 0 ? "destructive" : undefined,
      });
    } catch (err: any) {
      toast({ title: "RFQ send failed", description: err?.message, variant: "destructive" });
    } finally {
      setSendingRfq(false);
    }
  }

  // ---- AI quote reading ----------------------------------------------------
  function openAiRead(vendor: VendorForScope) {
    aiVendorRef.current = vendor;
    aiFileRef.current?.click();
  }
  async function handleAiFile(file: File) {
    const vendor = aiVendorRef.current;
    if (!vendor) return;
    setReadingFor(vendor.id);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/buyout/read-quote", { method: "POST", body: fd, credentials: "include" });
      if (!res.ok) throw new Error((await res.text()) || "AI read failed");
      const { extraction } = (await res.json()) as { extraction: AiQuoteExtraction };
      upsertQuote(vendor, {
        quoteAmount: extraction.quoteAmount ?? 0,
        leadTimeWeeks: extraction.leadTimeWeeks ?? 0,
        note: [extraction.note, extraction.exclusions.length ? `Excl: ${extraction.exclusions.join("; ")}` : ""].filter(Boolean).join(" · "),
        quoteDate: extraction.quoteAmount ? today() : null,
        attachments: [{ name: file.name, date: new Date().toISOString() }],
        aiSuggested: true,
        verified: false,
      }, true);
      toast({ title: "Quote read by AI — verify before awarding", description: `${vendor.name}: ${extraction.quoteAmount ? fmtMoney(extraction.quoteAmount) : "no total found"}` });
    } catch (err: any) {
      toast({ title: "Couldn't read quote", description: err?.message, variant: "destructive" });
    } finally {
      setReadingFor(null);
      aiVendorRef.current = null;
    }
  }

  // AI vendor gap-fill — only when a scope has zero tagged vendors.
  async function suggestVendors() {
    setSuggesting(true);
    try {
      const res = await apiRequest("POST", "/api/buyout/suggest-vendors", {
        scopeName: scope.name,
        sampleItems: scope.items.slice(0, 6).map((i) => `${i.description} (${i.model})`),
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
      if (!data.suggestions?.length) toast({ title: "No suggestions", description: "AI returned no vendors. Add one in the Vendor Database." });
    } catch (err: any) {
      toast({ title: "Suggestion failed", description: err?.message, variant: "destructive" });
    } finally {
      setSuggesting(false);
    }
  }
  async function addSuggested(name: string) {
    try {
      await apiRequest("POST", "/api/buyout/add-vendor", { name, scopeName: scope.name });
      toast({ title: "Vendor added", description: `${name} tagged to ${scope.name}` });
      setSuggestions((prev) => (prev ? prev.filter((s) => s.name !== name) : prev));
      refetchVendors();
    } catch (err: any) {
      toast({ title: "Couldn't add vendor", description: err?.message, variant: "destructive" });
    }
  }

  const urgencyColor = urgency === "red" ? "var(--loss)" : urgency === "amber" ? "var(--warning)" : "var(--text-dim)";

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden" data-testid={`scope-card-${scope.id}`}>
      {/* Header */}
      <button
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded((e) => !e)}
        data-testid={`scope-toggle-${scope.id}`}
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground">{scope.name}</span>
            <StatusPill status={scope.status} />
            {allowanceCount > 0 && (
              <Badge variant="outline" className="text-xs gap-1" style={{ color: "var(--warning)", borderColor: "var(--warning-border)" }}>
                <AlertTriangle className="w-3 h-3" />{allowanceCount} allowance
              </Badge>
            )}
            {clock && (
              <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: urgencyColor }}>
                <Clock className="w-3 h-3" />release by {clock.releaseBy}{urgency === "red" ? " ⚠" : ""}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Budget {fmtMoney(scope.budget.total)} · {scope.items.length} line items
            {scope.awardedVendorIds.length > 0 && (
              <> · Awarded {fmtMoney(awarded)} (<span style={{ color: variance <= 0 ? "var(--win)" : "var(--loss)" }}>{fmtSignedMoney(variance)}</span>)</>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border p-4 space-y-5">
          <input ref={aiFileRef} type="file" accept="application/pdf,image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleAiFile(f); e.target.value = ""; }} />

          {/* Buyout clock + budget */}
          <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-md border border-border p-3 bg-background/50">
              <div className="text-xs font-semibold text-muted-foreground mb-2">Budget (raw cost)</div>
              <div className="grid grid-cols-3 gap-2 text-sm">
                <Stat label="Material" value={fmtMoney(scope.budget.material)} />
                <Stat label="Freight" value={fmtMoney(scope.budget.freight)} />
                <Stat label="Labor" value={fmtMoney(scope.budget.labor)} />
              </div>
              <div className="mt-2 pt-2 border-t border-border flex justify-between text-sm">
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold tabular-nums">{fmtMoney(scope.budget.total, true)}</span>
              </div>
            </div>
            <div className="rounded-md border border-border p-3 bg-background/50">
              <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1"><Clock className="w-3 h-3" />Buyout Clock</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-muted-foreground">Required on site
                  <Input type="date" value={scope.rosDate || ""} className="mt-1 h-8"
                    onChange={(e) => updateScope((s) => ({ ...s, rosDate: e.target.value || null }))}
                    data-testid={`ros-${scope.id}`} />
                </label>
                <label className="text-xs text-muted-foreground">Submittal (weeks)
                  <Input type="number" min={0} value={scope.submittalWeeks} className="mt-1 h-8"
                    onChange={(e) => updateScope((s) => ({ ...s, submittalWeeks: Math.max(0, Number(e.target.value) || 0) }))} />
                </label>
              </div>
              <div className="mt-2 text-sm" style={{ color: urgencyColor }}>
                {clock ? (
                  <span className="font-medium">Release by {clock.releaseBy} · {clock.daysUntil}d ({clock.leadWeeks}wk lead)</span>
                ) : (
                  <span className="text-muted-foreground">Set ROS to compute release-by</span>
                )}
              </div>
            </div>
          </section>

          {/* Line items */}
          <section>
            <div className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1"><ListChecks className="w-3 h-3" />Line Items</div>
            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 text-xs text-muted-foreground">
                    <th className="text-left px-3 py-1.5 font-medium">Callout</th>
                    <th className="text-left px-3 py-1.5 font-medium">Description</th>
                    <th className="text-left px-3 py-1.5 font-medium">Model</th>
                    <th className="text-right px-3 py-1.5 font-medium">Qty</th>
                    <th className="text-right px-3 py-1.5 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {scope.items.map((it) => (
                    <tr key={it.id} className="border-t border-border">
                      <td className="px-3 py-1.5 text-muted-foreground">{it.callout}</td>
                      <td className="px-3 py-1.5">
                        {it.description}
                        {it.isAllowance && <Badge variant="outline" className="ml-2 text-[10px] py-0" style={{ color: "var(--warning)", borderColor: "var(--warning-border)" }}>ALLOWANCE</Badge>}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{it.model}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{it.qty || ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(it.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Vendors, quotes & awards */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-muted-foreground">Vendors tagged to {scope.name}</div>
              <Button
                size="sm" className="h-8 gap-1.5"
                disabled={rfqRecipients.length === 0 || sendingRfq || scope.status === "po"}
                onClick={() => setConfirmRfq(true)}
                data-testid={`send-rfq-${scope.id}`}
              >
                {sendingRfq ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                Send RFQ ({rfqRecipients.length})
              </Button>
            </div>

            {!vendors ? (
              <div className="text-sm text-muted-foreground py-4 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading vendors…</div>
            ) : sortedVendors.length === 0 ? (
              <div className="text-sm py-4 rounded-md border border-dashed border-border px-3 space-y-3">
                <p className="text-muted-foreground">No vendors are tagged to <strong>{scope.name}</strong>. Tag vendors in the Vendor Database, or let AI suggest Division 10 vendors for this scope.</p>
                <Button size="sm" variant="outline" className="gap-1.5" disabled={suggesting} onClick={suggestVendors} data-testid={`suggest-vendors-${scope.id}`}>
                  {suggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Suggest vendors
                </Button>
                {suggestions && suggestions.length > 0 && (
                  <div className="space-y-2 pt-1">
                    {suggestions.map((s) => (
                      <div key={s.name} className="flex items-center gap-2 text-sm">
                        <span className="font-medium text-foreground">{s.name}</span>
                        {s.note && <span className="text-xs text-muted-foreground truncate">{s.note}</span>}
                        <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => addSuggested(s.name)} data-testid={`add-suggested-${scope.id}`}>+ Add to Vendor DB</Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {sortedVendors.map((v) => {
                  const quote = getQuote(v.id);
                  const isAwarded = scope.awardedVendorIds.includes(String(v.id));
                  const isPreferred = (v.preferredForTrades || []).includes(scope.name);
                  const stale = quote && isQuoteStale(quote);
                  return (
                    <div
                      key={v.id}
                      className="rounded-md border border-border p-3"
                      style={isAwarded ? { borderColor: "var(--win)", background: "var(--success-bg)" } : undefined}
                      onDragOver={(e) => { e.preventDefault(); }}
                      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { aiVendorRef.current = v; void handleAiFile(f); } }}
                      data-testid={`vendor-${scope.id}-${v.id}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <Checkbox
                          checked={selectedVendorIds.has(v.id)}
                          disabled={!v.email}
                          onCheckedChange={(c) => setSelectedVendorIds((prev) => { const n = new Set(prev); if (c) n.add(v.id); else n.delete(v.id); return n; })}
                          data-testid={`select-vendor-${scope.id}-${v.id}`}
                        />
                        {isAwarded && <Star className="w-4 h-4 shrink-0" style={{ color: "var(--gold)", fill: "var(--gold)" }} />}
                        <span className="font-medium text-foreground">{v.name}</span>
                        <button onClick={() => togglePreferred(v)} title="Toggle preferred for this trade" className="shrink-0">
                          <Star className="w-3.5 h-3.5" style={{ color: isPreferred ? "var(--gold)" : "var(--text-dim)", fill: isPreferred ? "var(--gold)" : "none" }} />
                        </button>
                        {v.email ? (
                          <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Mail className="w-3 h-3" />{v.email}</span>
                        ) : (
                          <span className="text-xs inline-flex items-center gap-1" style={{ color: "var(--loss)" }}><MailWarning className="w-3 h-3" />no email — can't send RFQ</span>
                        )}
                        <div className="ml-auto flex items-center gap-1.5">
                          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" disabled={readingFor === v.id} onClick={() => openAiRead(v)} data-testid={`ai-read-${scope.id}-${v.id}`}>
                            {readingFor === v.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Read quote
                          </Button>
                        </div>
                      </div>

                      {/* Quote editor */}
                      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
                        <label className="text-[11px] text-muted-foreground">Quote $
                          <Input type="number" min={0} className="mt-0.5 h-8" value={quote?.quoteAmount || ""}
                            onChange={(e) => upsertQuote(v, { quoteAmount: Number(e.target.value) || 0, quoteDate: Number(e.target.value) ? (quote?.quoteDate || today()) : quote?.quoteDate ?? null })}
                            data-testid={`quote-amount-${scope.id}-${v.id}`} />
                        </label>
                        <label className="text-[11px] text-muted-foreground">Lead (wk)
                          <Input type="number" min={0} className="mt-0.5 h-8" value={quote?.leadTimeWeeks || ""}
                            onChange={(e) => upsertQuote(v, { leadTimeWeeks: Number(e.target.value) || 0 })} />
                        </label>
                        <label className="text-[11px] text-muted-foreground">Valid (days)
                          <Input type="number" min={0} className="mt-0.5 h-8" value={quote?.validityDays ?? DEFAULT_VALIDITY_DAYS}
                            onChange={(e) => upsertQuote(v, { validityDays: Number(e.target.value) || DEFAULT_VALIDITY_DAYS })} />
                        </label>
                        <label className="text-[11px] text-muted-foreground">Note
                          <Input className="mt-0.5 h-8" value={quote?.note || ""} onChange={(e) => upsertQuote(v, { note: e.target.value })} />
                        </label>
                      </div>

                      {quote && (quote.quoteAmount > 0 || quote.aiSuggested) && (
                        <div className="mt-2 flex items-center gap-2 flex-wrap text-xs">
                          {quote.aiSuggested && !quote.verified && (
                            <Badge variant="outline" className="gap-1" style={{ color: "var(--info)", borderColor: "var(--info-border)" }}><Sparkles className="w-3 h-3" />AI · unverified</Badge>
                          )}
                          {quote.verified && <Badge variant="outline" className="gap-1" style={{ color: "var(--win)", borderColor: "var(--success-border)" }}><ShieldCheck className="w-3 h-3" />verified</Badge>}
                          {quote.quoteDate && <span className="text-muted-foreground">quoted {quote.quoteDate}</span>}
                          {stale && <Badge variant="outline" className="gap-1" style={{ color: "var(--loss)", borderColor: "var(--error-border)" }}><AlertTriangle className="w-3 h-3" />stale (past {quote.validityDays}d)</Badge>}
                          {quote.attachments.map((a, i) => <span key={i} className="text-muted-foreground inline-flex items-center gap-1"><FileUp className="w-3 h-3" />{a.name}</span>)}

                          <div className="ml-auto flex items-center gap-1.5">
                            {!quote.verified && (
                              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => verifyQuote(quote.vendorId)} data-testid={`verify-${scope.id}-${v.id}`}>
                                <ShieldCheck className="w-3 h-3" />Verify
                              </Button>
                            )}
                            <CoveredLinesPopover items={scope.items} quote={quote} disabled={!isAwarded} onChange={(ids) => setCoveredLines(quote.vendorId, ids)} />
                            <Button
                              size="sm" className="h-7 text-xs gap-1"
                              variant={isAwarded ? "default" : "outline"}
                              disabled={!canAward(quote) || scope.status === "po"}
                              title={!canAward(quote) ? "Verify the quote before awarding" : ""}
                              onClick={() => toggleAward(quote.vendorId)}
                              data-testid={`award-${scope.id}-${v.id}`}
                            >
                              <Trophy className="w-3 h-3" />{isAwarded ? "Awarded" : "Award"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Award summary + coverage + PO */}
          {scope.awardedVendorIds.length > 0 && (
            <section className="rounded-md border p-3" style={{ borderColor: "var(--border-gold)", background: "var(--warning-bg)" }}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="text-sm">
                  <span className="font-semibold">Awarded {fmtMoney(awarded, true)}</span>
                  <span className="text-muted-foreground"> of {fmtMoney(scope.budget.total, true)} budget · </span>
                  <span style={{ color: variance <= 0 ? "var(--win)" : "var(--loss)", fontWeight: 600 }}>{fmtSignedMoney(variance)}</span>
                </div>
                {scope.status === "po" ? (
                  <Badge className="gap-1" style={{ background: "var(--win)", color: "#fff" }}><CheckCircle2 className="w-3.5 h-3.5" />PO Executed</Badge>
                ) : (
                  <Button size="sm" className="h-8 gap-1.5" onClick={() => updateScope((s) => ({ ...s, status: "po" }))} data-testid={`mark-po-${scope.id}`}>
                    <CheckCircle2 className="w-4 h-4" />Mark PO Executed
                  </Button>
                )}
              </div>
              <div className="mt-2 text-xs">
                {cov.allCovered && cov.doubleCovered.length === 0 ? (
                  <span className="inline-flex items-center gap-1" style={{ color: "var(--win)" }}><CheckCircle2 className="w-3 h-3" />All line items covered</span>
                ) : (
                  <span className="inline-flex items-center gap-2 flex-wrap">
                    {cov.uncovered.length > 0 && <span className="inline-flex items-center gap-1" style={{ color: "var(--loss)" }}><AlertTriangle className="w-3 h-3" />{cov.uncovered.length} uncovered line(s)</span>}
                    {cov.doubleCovered.length > 0 && <span className="inline-flex items-center gap-1" style={{ color: "var(--warning)" }}><AlertTriangle className="w-3 h-3" />{cov.doubleCovered.length} double-covered (possible double-count)</span>}
                  </span>
                )}
              </div>
              {scope.status === "po" && (
                <div className="mt-2">
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => updateScope((s) => ({ ...s, status: "awarded" }))}>Reopen (undo PO)</Button>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* RFQ confirmation — never send without explicit confirmation */}
      <AlertDialog open={confirmRfq} onOpenChange={setConfirmRfq}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send RFQ for {scope.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              One individual email will be sent to each of the {rfqRecipients.length} selected vendor(s):
              <span className="block mt-2 text-foreground">{rfqRecipients.map((v) => v.name).join(", ")}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doSendRfq} data-testid={`confirm-rfq-${scope.id}`}>Send {rfqRecipients.length} email(s)</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="tabular-nums">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    not_started: { bg: "var(--bg3)", fg: "var(--text-dim)" },
    rfq_sent: { bg: "var(--info-bg)", fg: "var(--info)" },
    quotes_in: { bg: "var(--info-bg)", fg: "var(--info)" },
    awarded: { bg: "var(--warning-bg)", fg: "var(--warning)" },
    po: { bg: "var(--success-bg)", fg: "var(--win)" },
  };
  const c = map[status] || map.not_started;
  return <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: c.bg, color: c.fg }}>{SCOPE_STATUS_LABEL[status] || status}</span>;
}

function CoveredLinesPopover({ items, quote, disabled, onChange }: {
  items: LineItem[]; quote: QuoteResponse; disabled: boolean; onChange: (ids: string[] | null) => void;
}) {
  const full = quote.coveredLineIds == null;
  const covered = new Set(quote.coveredLineIds ?? items.map((i) => i.id));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={disabled} title="Set which lines this award covers">
          {full ? "Covers: Full scope" : `Covers: ${quote.coveredLineIds?.length ?? 0} line(s)`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="end">
        <div className="flex items-center gap-2 mb-2">
          <Checkbox checked={full} onCheckedChange={(c) => onChange(c ? null : items.map((i) => i.id))} id={`full-${quote.id}`} />
          <label htmlFor={`full-${quote.id}`} className="text-sm font-medium">Full scope</label>
        </div>
        {!full && (
          <div className="max-h-48 overflow-y-auto space-y-1 border-t border-border pt-2">
            {items.map((it) => (
              <label key={it.id} className="flex items-start gap-2 text-xs cursor-pointer">
                <Checkbox
                  checked={covered.has(it.id)}
                  onCheckedChange={(c) => {
                    const next = new Set(covered);
                    if (c) next.add(it.id); else next.delete(it.id);
                    onChange(Array.from(next));
                  }}
                />
                <span><span className="text-muted-foreground">{it.callout}</span> {it.description}</span>
              </label>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
