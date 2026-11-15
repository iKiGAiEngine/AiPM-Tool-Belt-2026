// ─────────────────────────────────────────────────────────────────────────────
// Build the Vendor Directory rows for an estimate workbook from the AiPM
// vendor database.
//
// The estimate workbook's "Vendor Directory" tab is the single source table for
// every scope tab's RFQ list (each scope tab FILTERs this table by scope), so
// this is the only vendor data the generator writes. See
// shared/vendorDirectoryScopes.ts for why the scope vocabulary is what it is.
//
// Row grain is one row per  scope x vendor x manufacturer x contact  — the same
// grain the hand-built tab uses, where one contact appears once per brand they
// can quote. A vendor with no manufacturers still produces a row (blank
// Manufacturer), and a vendor with no contacts still produces a row (blank
// Contact/Email) so it reads as visibly incomplete rather than silently absent.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from "./db";
import { mfrVendors, mfrContacts, mfrManufacturers } from "@shared/schema";
import {
  VENDOR_DIRECTORY_SCOPES,
  scopeLabelsForVendorTags,
  type VendorDirectoryScope,
} from "@shared/vendorDirectoryScopes";

/** One Vendor Directory row. Column A (Scope) is pre-filled in the template and
 *  never written, so it is carried here only to group rows into their block. */
export interface VendorDirectoryRow {
  scope: VendorDirectoryScope;
  contactName: string; // -> column B
  email: string;       // -> column C
  vendor: string;      // -> column D
  manufacturer: string; // -> column E
}

export type VendorDirectoryRowsByScope = Map<VendorDirectoryScope, VendorDirectoryRow[]>;

/** The label used in the Vendor column when the manufacturer sells direct —
 *  matches the convention already in the hand-built tab. */
const MANUFACTURER_DIRECT_LABEL = "Manufacturer Direct";

function clean(s: string | null | undefined): string {
  return (s ?? "").trim();
}

/** Loose compare for the soft preferred-vendor boost only. Deliberately not
 *  used for scope placement — that is exact-id matching in vendorDirectoryScopes. */
function looseEq(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return n(a) === n(b) && n(a) !== "";
}

/**
 * Read the vendor database and group rows by Vendor Directory scope block.
 *
 * Ordering within a block is deterministic so that regenerating a bid folder
 * produces a stable tab (an estimator's eye learns the order, and a stable
 * order keeps diffs between two generated workbooks meaningful):
 *   1. vendors flagged preferred for this scope
 *   2. manufacturer-direct vendors
 *   3. vendor name A-Z
 *   then within a vendor: manufacturer A-Z, primary contact first, contact A-Z.
 */
export async function buildVendorDirectoryRows(): Promise<VendorDirectoryRowsByScope> {
  const [vendors, contacts, manufacturers] = await Promise.all([
    db.select().from(mfrVendors),
    db.select().from(mfrContacts),
    db.select().from(mfrManufacturers),
  ]);

  const mfrNameById = new Map<number, string>();
  for (const m of manufacturers) {
    // Full manufacturer name, per the naming decision: the everyday `name`,
    // falling back to legalName only when name is empty.
    const nm = clean(m.name) || clean(m.legalName);
    if (nm) mfrNameById.set(m.id, nm);
  }

  const contactsByVendor = new Map<number, typeof contacts>();
  for (const c of contacts) {
    if (!contactsByVendor.has(c.vendorId)) contactsByVendor.set(c.vendorId, []);
    contactsByVendor.get(c.vendorId)!.push(c);
  }

  const byScope: VendorDirectoryRowsByScope = new Map();
  for (const s of VENDOR_DIRECTORY_SCOPES) byScope.set(s, []);

  // Sort vendors once per scope (the preferred-for-this-scope rank is
  // scope-dependent, so the comparator is built inside the scope loop).
  for (const scope of VENDOR_DIRECTORY_SCOPES) {
    const inScope = vendors.filter((v) => scopeLabelsForVendorTags(v.scopes).includes(scope));

    const rank = (v: (typeof vendors)[number]): number => {
      const preferred = (v.preferredForTrades ?? []).some((t) => looseEq(clean(t), scope));
      if (preferred) return 0;
      if (v.manufacturerDirect) return 1;
      return 2;
    };

    inScope.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const an = clean(a.name) || clean(a.legalName);
      const bn = clean(b.name) || clean(b.legalName);
      return an.localeCompare(bn);
    });

    const rows: VendorDirectoryRow[] = [];
    for (const v of inScope) {
      const vendorName = v.manufacturerDirect
        ? MANUFACTURER_DIRECT_LABEL
        : clean(v.name) || clean(v.legalName);

      // Manufacturer slots — the brands this vendor can quote. An unresolvable
      // id (deleted manufacturer) is dropped rather than printed as a number.
      const mfrNames = (v.manufacturerIds ?? [])
        .map((id) => mfrNameById.get(id))
        .filter((n): n is string => !!n)
        .sort((a, b) => a.localeCompare(b));
      const mfrSlots: string[] = mfrNames.length ? mfrNames : [""];

      // Contact slots — primary first, then by name.
      const vendorContacts = (contactsByVendor.get(v.id) ?? []).slice().sort((a, b) => {
        const ap = a.isPrimary ? 0 : 1;
        const bp = b.isPrimary ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return clean(a.name).localeCompare(clean(b.name));
      });
      const contactSlots = vendorContacts.length ? vendorContacts : [null];

      for (const mfr of mfrSlots) {
        for (const c of contactSlots) {
          rows.push({
            scope,
            contactName: c ? clean(c.name) : "",
            email: c ? clean(c.email) : "",
            vendor: vendorName,
            manufacturer: mfr,
          });
        }
      }
    }

    byScope.set(scope, rows);
  }

  return byScope;
}

/** Total rows across every scope — for logging. */
export function countVendorDirectoryRows(byScope: VendorDirectoryRowsByScope): number {
  let n = 0;
  // forEach rather than for..of: this project's tsconfig sets no `target`, so
  // iterating a Map iterator directly needs --downlevelIteration.
  byScope.forEach((rows) => { n += rows.length; });
  return n;
}
