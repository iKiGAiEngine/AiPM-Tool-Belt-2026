// ─────────────────────────────────────────────────────────────────────────────
// Vendor Directory block sizing report  (read-only — changes nothing)
//
//   npx tsx scripts/vendorDirectoryCounts.ts
//
// Counts how many rows each scope block on the estimate workbook's "Vendor
// Directory" tab would actually need, using the real AiPM vendor data and the
// agreed row grain:
//
//     one row per  scope x vendor x manufacturer x contact
//
// (the grain the hand-built tab already uses — the same contact appears once per
// manufacturer they can quote), then recommends a right-sized block with ~20%
// headroom so small scopes don't get 50 empty rows.
//
// Also surfaces the two data problems that would otherwise silently shrink the
// output: vendors carrying scope tags we don't place, and vendors with no tags
// at all (invisible to the directory entirely).
// ─────────────────────────────────────────────────────────────────────────────

import { db } from "../server/db";
import { mfrVendors, mfrContacts, mfrManufacturers } from "../shared/schema";
import {
  VENDOR_DIRECTORY_SCOPES,
  SCOPE_TAG_IDS,
  KNOWN_SCOPE_TAG_IDS,
  scopeLabelsForVendorTags,
  type VendorDirectoryScope,
} from "../shared/vendorDirectoryScopes";

/** Block size currently baked into the v60b template, for comparison. */
const CURRENT_BLOCK_SIZE = 25;
/** Headroom applied on top of the live count. */
const HEADROOM = 0.2;
/** Never size a block below this, so a 1-vendor scope still has room to grow. */
const MIN_BLOCK = 8;
/** Round up to a multiple of this, to keep the tab's row maths tidy. */
const ROUND_TO = 5;

function recommendBlock(needed: number): number {
  const withHeadroom = Math.ceil(needed * (1 + HEADROOM));
  const floored = Math.max(withHeadroom, MIN_BLOCK);
  return Math.ceil(floored / ROUND_TO) * ROUND_TO;
}

async function main() {
  const [vendors, contacts, manufacturers] = await Promise.all([
    db.select().from(mfrVendors),
    db.select().from(mfrContacts),
    db.select().from(mfrManufacturers),
  ]);

  const mfrNameById = new Map(manufacturers.map((m) => [m.id, m.legalName || m.name]));
  const contactsByVendor = new Map<number, typeof contacts>();
  for (const c of contacts) {
    if (!contactsByVendor.has(c.vendorId)) contactsByVendor.set(c.vendorId, []);
    contactsByVendor.get(c.vendorId)!.push(c);
  }

  const rowCount = new Map<VendorDirectoryScope, number>();
  const vendorCount = new Map<VendorDirectoryScope, number>();
  for (const s of VENDOR_DIRECTORY_SCOPES) {
    rowCount.set(s, 0);
    vendorCount.set(s, 0);
  }

  const untaggedVendors: string[] = [];
  const unplaceableTags = new Map<string, string[]>(); // tag id -> vendor names
  const noContactVendors: string[] = [];

  for (const v of vendors) {
    const tags = (v.scopes ?? []).filter(Boolean) as string[];
    const name = v.legalName || v.name;

    if (tags.length === 0) {
      untaggedVendors.push(name);
      continue;
    }
    for (const t of tags) {
      if (!KNOWN_SCOPE_TAG_IDS.has(t.trim())) {
        if (!unplaceableTags.has(t)) unplaceableTags.set(t, []);
        unplaceableTags.get(t)!.push(name);
      }
    }

    const labels = scopeLabelsForVendorTags(tags);
    if (labels.length === 0) continue;

    // Row grain: scope x vendor x manufacturer x contact.
    // A vendor with no manufacturers still gets one row per contact (the
    // Manufacturer cell is simply blank), and a vendor with no contacts still
    // gets one row so it is visibly present rather than silently absent.
    const mfrIds = (v.manufacturerIds ?? []).filter((id) => mfrNameById.has(id));
    const mfrSlots = Math.max(mfrIds.length, 1);
    const vendorContacts = contactsByVendor.get(v.id) ?? [];
    if (vendorContacts.length === 0) noContactVendors.push(name);
    const contactSlots = Math.max(vendorContacts.length, 1);
    const rowsPerScope = mfrSlots * contactSlots;

    for (const label of labels) {
      rowCount.set(label, rowCount.get(label)! + rowsPerScope);
      vendorCount.set(label, vendorCount.get(label)! + 1);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log("\nVENDOR DIRECTORY — BLOCK SIZING REPORT");
  console.log(`vendors: ${vendors.length}   contacts: ${contacts.length}   manufacturers: ${manufacturers.length}`);
  console.log(`grain: scope x vendor x manufacturer x contact   headroom: +${HEADROOM * 100}%   min: ${MIN_BLOCK}   rounded to: ${ROUND_TO}\n`);

  const head = `${"SCOPE BLOCK".padEnd(22)} ${"VENDORS".padStart(8)} ${"ROWS".padStart(6)} ${"NOW".padStart(5)} ${"FITS?".padStart(6)} ${"RECOMMEND".padStart(10)}`;
  console.log(head);
  console.log("-".repeat(head.length));

  let totalRows = 0;
  let totalRecommended = 0;
  let overflowing = 0;
  for (const s of VENDOR_DIRECTORY_SCOPES) {
    const rows = rowCount.get(s)!;
    const vends = vendorCount.get(s)!;
    const rec = recommendBlock(rows);
    const fits = rows <= CURRENT_BLOCK_SIZE;
    if (!fits) overflowing++;
    totalRows += rows;
    totalRecommended += rec;
    const flag = rows === 0 ? "empty" : fits ? "yes" : `NO +${rows - CURRENT_BLOCK_SIZE}`;
    console.log(
      `${s.padEnd(22)} ${String(vends).padStart(8)} ${String(rows).padStart(6)} ${String(CURRENT_BLOCK_SIZE).padStart(5)} ${flag.padStart(6)} ${String(rec).padStart(10)}`,
    );
  }
  console.log("-".repeat(head.length));
  console.log(
    `${"TOTAL".padEnd(22)} ${"".padStart(8)} ${String(totalRows).padStart(6)} ${String(CURRENT_BLOCK_SIZE * VENDOR_DIRECTORY_SCOPES.length).padStart(5)} ${"".padStart(6)} ${String(totalRecommended).padStart(10)}`,
  );
  console.log(
    `\n${overflowing} of ${VENDOR_DIRECTORY_SCOPES.length} scopes exceed the current ${CURRENT_BLOCK_SIZE}-row block.`,
  );
  console.log(
    `Right-sized tab would be ${totalRecommended} data rows vs ${CURRENT_BLOCK_SIZE * VENDOR_DIRECTORY_SCOPES.length} today (Alternate 1/2/3 excluded).`,
  );

  // ── Data problems that shrink the output ──────────────────────────────────
  if (rowCount.get("Window Shades") === 0) {
    console.log(
      `\n[gap] Window Shades: 0 rows. No vendor can carry the "window_shades" tag yet` +
        ` — it is missing from CONTACT_SCOPE_OPTIONS in client/src/pages/VendorDatabasePage.tsx.` +
        ` Add the tag, re-tag the vendors, then re-run this.`,
    );
  }
  const emptyScopes = VENDOR_DIRECTORY_SCOPES.filter((s) => rowCount.get(s) === 0 && s !== "Window Shades");
  if (emptyScopes.length) {
    console.log(`\n[gap] scopes with no tagged vendors at all: ${emptyScopes.join(", ")}`);
  }
  if (unplaceableTags.size) {
    console.log(`\n[gap] scope tags present on vendors that map to no block (vendors excluded from that scope):`);
    for (const [tag, names] of unplaceableTags) {
      const shown = names.slice(0, 6).join(", ");
      console.log(`   "${tag}" — ${names.length} vendor(s): ${shown}${names.length > 6 ? ", ..." : ""}`);
    }
  }
  if (untaggedVendors.length) {
    console.log(
      `\n[gap] ${untaggedVendors.length} vendor(s) have NO scope tags, so they appear nowhere in the directory:`,
    );
    console.log(`   ${untaggedVendors.slice(0, 15).join(", ")}${untaggedVendors.length > 15 ? ", ..." : ""}`);
  }
  if (noContactVendors.length) {
    console.log(
      `\n[note] ${noContactVendors.length} vendor(s) have no contact rows — they will appear with a blank` +
        ` Contact Name/Email so they are visibly incomplete rather than missing:`,
    );
    console.log(`   ${noContactVendors.slice(0, 15).join(", ")}${noContactVendors.length > 15 ? ", ..." : ""}`);
  }

  // Per-scope tag breakdown, so legacy-tag cleanup can be targeted.
  console.log(`\nTAG IDS MATCHED PER SCOPE (first id is current, rest are legacy):`);
  for (const s of VENDOR_DIRECTORY_SCOPES) {
    const ids = SCOPE_TAG_IDS[s];
    if (ids.length > 1) console.log(`   ${s.padEnd(22)} ${ids.join(", ")}`);
  }

  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("vendorDirectoryCounts failed:", err);
  process.exit(1);
});
