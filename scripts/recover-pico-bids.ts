// ONE-TIME RECOVERY: restore the two BC invitations hidden by the Nov 6, 2026 merge incident.
//   Entry 2022 / 26-1870 / Loading Dock Equipment
//   Entry 2023 / 26-1871 / Specialties   (Pico & Beverwil Redevelopment)
//
// Run in the Replit Shell (DATABASE_URL must point at PRODUCTION):
//   npx tsx scripts/recover-pico-bids.ts           # DRY RUN: shows what it WOULD do, changes nothing
//   npx tsx scripts/recover-pico-bids.ts --apply   # actually does it (after a backup is written)
//
// Safety rules built in:
//  - Touches ONLY entries 2022 and 2023.
//  - Refuses to run if either row is not in exactly the expected "hidden by the incident" state.
//  - Writes a backup file first, and reads it back to prove it is valid.
//  - Everything happens in ONE transaction. Any problem = nothing is changed.
//  - Checks after the changes (still inside the transaction) that nothing else about the rows moved;
//    if anything unexpected changed, it rolls back.
//  - Does not touch estimate numbers, scopes, BC IDs, regions, projects, or any other entry.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const MERGE_ROUND_ADDED_AT = "2026-11-06T23:39:33.389Z";

const LDE = { id: 2022, estimate: "26-1870", scope: "Loading Dock Equipment" };
const SPEC = { id: 2023, estimate: "26-1871", scope: "Specialties" };

function fail(msg: string): never {
  console.error(`\nABORTED: ${msg}\nNothing was changed.`);
  process.exit(1);
}

function parseLog(v: string | null): string[] {
  if (!v) return [];
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return fail("bc_change_log on a row is not valid JSON; refusing to guess.");
  }
}

async function main() {
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set.");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const host = new URL(process.env.DATABASE_URL).host;
  console.log(`Mode: ${APPLY ? "APPLY (will change data)" : "DRY RUN (no changes)"}`);
  console.log(`Database host: ${host}\n`);

  try {
    await client.query("BEGIN");

    // Lock both rows so nothing else can change them while we work.
    const { rows } = await client.query(
      "SELECT * FROM proposal_log_entries WHERE id = ANY($1) ORDER BY id FOR UPDATE",
      [[LDE.id, SPEC.id]],
    );
    const lde = rows.find((r) => r.id === LDE.id);
    const spec = rows.find((r) => r.id === SPEC.id);
    if (!lde || !spec) fail("One or both entries (2022, 2023) were not found. Wrong database?");

    // ---- Expected-state checks (abort on any surprise) ----
    if (lde.estimate_number !== LDE.estimate) fail(`Entry 2022 estimate is ${lde.estimate_number}, expected ${LDE.estimate}.`);
    if (spec.estimate_number !== SPEC.estimate) fail(`Entry 2023 estimate is ${spec.estimate_number}, expected ${SPEC.estimate}.`);
    if (!lde.deleted_at) fail("Entry 2022 is not hidden (deleted_at is empty). Already recovered?");
    if (!spec.deleted_at) fail("Entry 2023 is not hidden (deleted_at is empty). Already recovered?");
    if (lde.estimate_status !== "No Bid") fail(`Entry 2022 status is "${lde.estimate_status}", expected "No Bid".`);
    if (spec.is_draft !== false) fail("Entry 2023 is_draft is not false as expected.");
    if (!String(spec.duplicate_override_note || "").startsWith("Merged into entry #2022")) {
      fail(`Entry 2023 duplicate_override_note is unexpected: ${spec.duplicate_override_note}`);
    }
    const rounds: any[] = Array.isArray(lde.bid_rounds) ? lde.bid_rounds : [];
    const badRound = rounds.filter(
      (r) => r?.addedAt === MERGE_ROUND_ADDED_AT && String(r?.notes || "").startsWith("Merged from BC draft"),
    );
    if (badRound.length !== 1) fail(`Expected exactly 1 incident bid round on entry 2022, found ${badRound.length}.`);
    if (rounds.length !== 1) fail(`Entry 2022 has ${rounds.length} bid rounds, expected only the 1 incident round. Needs a human look.`);
    if (Array.isArray(spec.bid_rounds) && spec.bid_rounds.length > 0) fail("Entry 2023 has bid rounds; unexpected.");

    // No other live entry or project may use these numbers.
    const clash = await client.query(
      "SELECT id, estimate_number FROM proposal_log_entries WHERE estimate_number = ANY($1) AND id <> ALL($2) AND deleted_at IS NULL",
      [[LDE.estimate, SPEC.estimate], [LDE.id, SPEC.id]],
    );
    if (clash.rows.length) fail(`Another live entry already uses one of these estimate numbers: ${JSON.stringify(clash.rows)}`);

    // ---- Backup ----
    const audit = await client.query(
      "SELECT * FROM audit_logs WHERE (entity_id = ANY($1)) ORDER BY id",
      [[String(LDE.id), String(SPEC.id)]],
    );
    const sync = await client.query("SELECT * FROM bc_sync_log WHERE entry_id = ANY($1) ORDER BY id", [[LDE.id, SPEC.id]]);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(process.cwd(), ".local", "recovery-exports");
    const backupPath = path.join(backupDir, `pico-2022-2023-before-${stamp}.json`);
    const backupBody = JSON.stringify({ takenAt: new Date().toISOString(), entries: rows, auditLogs: audit.rows, bcSyncLog: sync.rows }, null, 2);

    console.log("Current state:");
    for (const r of [lde, spec]) {
      console.log(`  #${r.id} ${r.estimate_number} | ${r.project_name} | status=${r.estimate_status} | is_draft=${r.is_draft} | deleted_at=${r.deleted_at?.toISOString?.() ?? r.deleted_at} | region=${r.region || "(blank)"}`);
    }
    console.log("\nPlanned changes:");
    console.log("  #2022: is_draft false->true, estimate_status No Bid->Draft, deleted_at cleared, remove the 1 incident bid round, append recovery note to bc_change_log");
    console.log("  #2023: is_draft false->true, deleted_at cleared, duplicate_override_note (merge note) cleared, append recovery note to bc_change_log");
    console.log("  + 2 audit_logs rows (action bc_draft_recovered)");
    console.log("  Nothing else changes. Estimate numbers, scopes, BC IDs, regions stay as they are.\n");

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("DRY RUN complete. Nothing was written (not even a backup). Run again with --apply to do it.");
      return;
    }

    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(backupPath, backupBody);
    const readBack = fs.readFileSync(backupPath, "utf8");
    JSON.parse(readBack);
    const sha = crypto.createHash("sha256").update(readBack).digest("hex");
    fs.writeFileSync(backupPath + ".sha256", sha + "\n");
    console.log(`Backup written and verified: ${backupPath}\n  sha256 ${sha}\n`);

    // ---- Apply ----
    const now = new Date().toISOString();
    const noteLde = `${now}: RECOVERY - Restored 26-1870 (${LDE.scope}) to unapproved BC draft review. Reversed erroneous duplicate rejection from the Nov 6 merge incident and removed the bid-round addition made when entry 2023 was merged into it. Estimate number, scope, due date and BC opportunity identity preserved.`;
    const noteSpec = `${now}: RECOVERY - Restored 26-1871 (${SPEC.scope}) to unapproved BC draft review. Reversed the Nov 6 merge into entry 2022. Estimate number, scope, region, due date and BC opportunity identity preserved.`;

    await client.query(
      `UPDATE proposal_log_entries
         SET is_draft = true, estimate_status = 'Draft', deleted_at = NULL, bid_rounds = '[]'::jsonb, bc_change_log = $2
       WHERE id = $1`,
      [LDE.id, JSON.stringify([...parseLog(lde.bc_change_log), noteLde])],
    );
    await client.query(
      `UPDATE proposal_log_entries
         SET is_draft = true, deleted_at = NULL, duplicate_override_note = NULL, bc_change_log = $2
       WHERE id = $1`,
      [SPEC.id, JSON.stringify([...parseLog(spec.bc_change_log), noteSpec])],
    );

    for (const [r, note] of [[lde, noteLde], [spec, noteSpec]] as const) {
      await client.query(
        `INSERT INTO audit_logs (action_type, entity_type, entity_id, summary, metadata, actor_email)
         VALUES ('bc_draft_recovered', 'bc_invite', $1, $2, $3, 'manual-recovery-script')`,
        [String(r.id), note, JSON.stringify({ backup: backupPath, backupSha256: sha, before: { is_draft: r.is_draft, estimate_status: r.estimate_status, deleted_at: r.deleted_at, duplicate_override_note: r.duplicate_override_note, bid_rounds: r.bid_rounds } })],
      );
    }

    // ---- Verify, still inside the transaction ----
    const after = await client.query("SELECT * FROM proposal_log_entries WHERE id = ANY($1) ORDER BY id", [[LDE.id, SPEC.id]]);
    const allowed = new Set(["is_draft", "estimate_status", "deleted_at", "bid_rounds", "bc_change_log", "duplicate_override_note"]);
    for (const a of after.rows) {
      const b = a.id === LDE.id ? lde : spec;
      for (const k of Object.keys(b)) {
        if (allowed.has(k)) continue;
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) fail(`Unexpected change to column "${k}" on entry ${a.id}. Rolled back.`);
      }
      if (a.deleted_at !== null || a.is_draft !== true) fail(`Entry ${a.id} did not end up as a visible draft. Rolled back.`);
    }
    const ok = after.rows.find((r) => r.id === LDE.id);
    if (ok.estimate_status !== "Draft" || (ok.bid_rounds || []).length !== 0) fail("Entry 2022 did not end in the expected state. Rolled back.");

    await client.query("COMMIT");
    console.log("DONE. Both entries are restored as unapproved drafts and will show in the BC Invites tab.");
    console.log("Next: reload BC Invites and confirm both appear. Do NOT accept them until the estimate-number fix is deployed.");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Failed (rolled back, nothing changed):", e?.message || e);
  process.exit(1);
});
