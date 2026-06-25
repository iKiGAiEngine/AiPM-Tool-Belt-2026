// Client-side helpers for the Buyout Bot. Re-exports the shared derived logic so
// the UI and the server/export agree on every computed number.

import type { ParsedEstimate, ParsedScope } from "@shared/buyout/estimateParser";
import {
  type BuyoutBoard,
  type BuyoutScope,
  type LineItem,
  BUYOUT_BOARD_VERSION,
  DEFAULT_SUBMITTAL_WEEKS,
} from "@shared/buyout/types";

export * from "@shared/buyout/types";

let idCounter = 0;
export function genId(prefix = "id"): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const USD2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtMoney(n: number, cents = false): string {
  if (!isFinite(n)) return "$0";
  return (cents ? USD2 : USD).format(n);
}

export function fmtSignedMoney(n: number): string {
  const s = fmtMoney(Math.abs(n));
  return n < 0 ? `−${s}` : n > 0 ? `+${s}` : s;
}

/** Build a fresh board from a parsed estimate. */
export function boardFromParsed(parsed: ParsedEstimate): BuyoutBoard {
  return {
    version: BUYOUT_BOARD_VERSION,
    scopes: parsed.scopes.map(scopeFromParsed),
  };
}

function scopeFromParsed(p: ParsedScope): BuyoutScope {
  return {
    id: genId("scope"),
    name: p.name,
    sheetName: p.sheetName,
    status: "not_started",
    budget: { ...p.budget },
    items: p.items.map(
      (it): LineItem => ({
        id: genId("li"),
        specNo: it.specNo,
        callout: it.callout,
        description: it.description,
        model: it.model,
        qty: it.qty,
        material: it.material,
        freight: it.freight,
        labor: it.labor,
        total: it.total,
        isAllowance: it.isAllowance,
      })
    ),
    quotes: [],
    awardedVendorIds: [],
    rosDate: null,
    submittalWeeks: DEFAULT_SUBMITTAL_WEEKS,
  };
}

export const SCOPE_STATUS_LABEL: Record<string, string> = {
  not_started: "Not Started",
  rfq_sent: "RFQ Sent",
  quotes_in: "Quotes In",
  awarded: "Awarded",
  po: "PO Executed",
};

/** Vendor as returned by /api/mfr/vendors (subset we use). */
export interface VendorListItem {
  id: number;
  name: string;
  scopes: string[] | null;
  preferredForTrades: string[] | null;
  contactCount: number;
}

/** Full vendor with contacts (from /api/mfr/vendors/:id). */
export interface VendorFull extends VendorListItem {
  contacts: { id: number; name: string | null; email: string | null; isPrimary: boolean | null }[];
}

export function primaryEmail(v: VendorFull): string | null {
  const withEmail = v.contacts.filter((c) => c.email && c.email.trim());
  if (withEmail.length === 0) return null;
  const primary = withEmail.find((c) => c.isPrimary);
  return (primary || withEmail[0]).email!.trim();
}

export function primaryContactName(v: VendorFull): string | undefined {
  const withEmail = v.contacts.filter((c) => c.email && c.email.trim());
  const primary = withEmail.find((c) => c.isPrimary) || withEmail[0];
  return primary?.name || undefined;
}
