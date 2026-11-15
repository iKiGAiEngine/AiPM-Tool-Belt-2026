// ─────────────────────────────────────────────────────────────────────────────
// Vendor Directory reconciliation  (read-only — changes nothing)
//
//   npx tsx scripts/vendorDirectoryReconcile.ts
//
// Before the Vendor Directory tab is generated from AiPM instead of maintained
// by hand, every vendor currently on the hand-built tab needs to exist in AiPM
// AND be tagged for the scope it appears under. Otherwise the first generated
// bid folder quietly ships with FEWER vendors than the spreadsheet it replaced.
//
// The totals hide this. The hand-built tab holds 130 rows and AiPM would produce
// 136 — but that nets out 32 rows gained in some scopes against 26 lost in
// others. This report names the 26.
//
// For every row in the snapshot it answers one of three things:
//
//   OK           vendor exists in AiPM and is tagged for this scope
//   MIS-TAGGED   vendor exists in AiPM but is NOT tagged for this scope
//                -> fix: tick the scope in Vendor Database > the vendor > Scopes
//   MISSING      no vendor in AiPM matches this name at all
//                -> fix: create the vendor record, then tag it
//
// The MIS-TAGGED list is the valuable half: those are one-click fixes, not
// data entry.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { join } from "path";
import { db } from "../server/db";
import { mfrVendors } from "../shared/schema";
import {
  VENDOR_DIRECTORY_SCOPES,
  SCOPE_TAG_IDS,
  scopeLabelsForVendorTags,
  type VendorDirectoryScope,
} from "../shared/vendorDirectoryScopes";

interface SnapshotRow {
  scope: string;
  vendor: string;
  manufacturer: string;
  contact: string;
  email: string;
}

/** Loose key for matching a spreadsheet vendor name to an AiPM record. */
function norm(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(inc|llc|ltd|co|corp|company|incorporated)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Values in the Vendor column that name a posture, not a company. */
const NON_COMPANY_VENDOR_VALUES = new Set(["manufacturer direct", "multiple", ""]);

async function main() {
  const snapshotPath = join(__dirname, "fixtures", "vendorDirectorySnapshot.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    capturedFrom: string;
    capturedAt: string;
    rows: SnapshotRow[];
  };

  const vendors = await db.select().from(mfrVendors);

  // Index every AiPM vendor under every name it is known by.
  const vendorByName = new Map<string, (typeof vendors)[number]>();
  for (const v of vendors) {
    for (const candidate of [v.name, v.legalName, v.shortCode, ...(v.aliases ?? [])]) {
      const k = norm(candidate);
      if (k && !vendorByName.has(k)) vendorByName.set(k, v);
    }
  }

  const scopesByVendorId = new Map<number, VendorDirectoryScope[]>();
  for (const v of vendors) scopesByVendorId.set(v.id, scopeLabelsForVendorTags(v.scopes));

  type Finding = { scope: string; vendor: string; manufacturer: string; aipmName?: string; taggedFor?: string[] };
  const misTagged: Finding[] = [];
  const missing: Finding[] = [];
  let ok = 0;
  let skipped = 0;

  // De-duplicate to one check per (scope, vendor) — the snapshot has a row per
  // manufacturer/contact, but tagging is a vendor-level property.
  const checked = new Set<string>();

  for (const row of snapshot.rows) {
    const vendorRaw = (row.vendor ?? "").trim();
    const key = norm(vendorRaw);

    // "Manufacturer Direct" / "Multiple" aren't companies — the Manufacturer
    // column carries the real identity there, so there's nothing to reconcile.
    if (NON_COMPANY_VENDOR_VALUES.has(key)) {
      skipped++;
      continue;
    }

    const dedupe = `${row.scope}|${key}`;
    if (checked.has(dedupe)) continue;
    checked.add(dedupe);

    const hit = vendorByName.get(key);
    if (!hit) {
      missing.push({ scope: row.scope, vendor: vendorRaw, manufacturer: row.manufacturer });
      continue;
    }
    const tagged = scopesByVendorId.get(hit.id) ?? [];
    if (tagged.includes(row.scope as VendorDirectoryScope)) {
      ok++;
    } else {
      misTagged.push({
        scope: row.scope,
        vendor: vendorRaw,
        manufacturer: row.manufacturer,
        aipmName: hit.legalName || hit.name,
        taggedFor: tagged,
      });
    }
  }

  console.log("\nVENDOR DIRECTORY — RECONCILIATION");
  console.log(`snapshot: ${snapshot.capturedFrom} (${snapshot.capturedAt}), ${snapshot.rows.length} rows`);
  console.log(`AiPM vendors: ${vendors.length}`);
  console.log(
    `\nchecked ${checked.size} distinct scope+vendor pairs:  ${ok} ok,  ${misTagged.length} mis-tagged,  ${missing.length} missing` +
      `   (${skipped} rows skipped as "Manufacturer Direct"/"Multiple")\n`,
  );

  if (misTagged.length) {
    console.log("─".repeat(78));
    console.log("MIS-TAGGED — vendor is in AiPM, just not tagged for this scope.");
    console.log("Fix: Vendor Database > open the vendor > tick the scope. One click each.");
    console.log("─".repeat(78));
    const byScope = new Map<string, Finding[]>();
    for (const f of misTagged) {
      if (!byScope.has(f.scope)) byScope.set(f.scope, []);
      byScope.get(f.scope)!.push(f);
    }
    for (const scope of VENDOR_DIRECTORY_SCOPES) {
      const items = byScope.get(scope);
      if (!items) continue;
      const tagToAdd = SCOPE_TAG_IDS[scope][0];
      console.log(`\n  ${scope}   (add tag "${tagToAdd}")`);
      for (const f of items) {
        const cur = f.taggedFor && f.taggedFor.length ? f.taggedFor.join(", ") : "no scopes at all";
        console.log(`     ${f.vendor.padEnd(34)} currently tagged: ${cur}`);
      }
    }
    console.log("");
  }

  if (missing.length) {
    console.log("─".repeat(78));
    console.log("MISSING — no AiPM vendor matches this name. Needs a vendor record created.");
    console.log("─".repeat(78));
    const byScope = new Map<string, Finding[]>();
    for (const f of missing) {
      if (!byScope.has(f.scope)) byScope.set(f.scope, []);
      byScope.get(f.scope)!.push(f);
    }
    for (const scope of VENDOR_DIRECTORY_SCOPES) {
      const items = byScope.get(scope);
      if (!items) continue;
      console.log(`\n  ${scope}`);
      for (const f of items) {
        console.log(`     ${f.vendor.padEnd(34)} (quotes: ${f.manufacturer || "—"})`);
      }
    }
    console.log("");
  }

  if (!misTagged.length && !missing.length) {
    console.log("Nothing to reconcile — every vendor on the hand-built tab exists in AiPM");
    console.log("and is tagged for the scope it appears under. Safe to generate.\n");
  } else {
    console.log("─".repeat(78));
    console.log(
      `Until these are resolved, a generated Vendor Directory will be missing ` +
        `${misTagged.length + missing.length} scope+vendor pairings that the hand-built tab has today.`,
    );
    console.log("─".repeat(78) + "\n");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("vendorDirectoryReconcile failed:", err);
  process.exit(1);
});
