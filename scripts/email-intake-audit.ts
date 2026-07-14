// End-to-end audit of the email-intake pipeline: runs every fixture through
// processEmailIntake against a real Postgres (DATABASE_URL), diffs EVERY
// entry field + provenance against the fixture's expected JSON, and asserts
// the "no missed bids" invariants. Non-zero exit on any mismatch.
//
// Run: DATABASE_URL=postgres://... tsx scripts/email-intake-audit.ts
//
// BuildingConnected API calls are stubbed (recorded payloads); all other
// outbound network is blocked so the audit is deterministic. Field extraction
// runs the LLM tier when OPENAI_API_KEY is set, else the regex/floor tiers —
// expected files carry per-mode values (entry / entryNoLlm / entryLlm).
import fs from "fs";
import path from "path";
import { db } from "../server/db";
import { users, apsTokens, proposalLogEntries, emailIntakeLog, bcSyncLog, auditLogs, notifications, proposalChangeLog } from "@shared/schema";
import { eq, inArray, like } from "drizzle-orm";
import { processEmailIntake } from "../server/emailIntake/intakeService";

const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "server", "emailIntake", "fixtures");
const expectedDir = path.join(fixturesDir, "expected");

const OPP_A = "68b1c2d3e4f5a6b7c8d9e0f1"; // bc-invite.eml (GET-by-id hit)
const OPP_B = "68c4d5e6f7a8b9c0d1e2f3a4"; // bc-invite-forwarded.eml (list-fallback)
const OPP_D = "68e9f0a1b2c3d4e5f6a7b8c9"; // bc-invite-rtf.msg (NDA payload)
const OPP_C = "68d7e8f9a0b1c2d3e4f5a6b7"; // bc-invite.msg (no_connection user)

// ── Recorded BC payloads (live-API shape, same as bcSync.test.ts) ──
const PAYLOAD_A = {
  id: OPP_A,
  name: "Sunset Ridge Medical Office Building",
  projectId: "77aa11bb22cc33dd44ee55ff",
  client: {
    company: { id: "c1", name: "Swinerton Builders - Dallas" },
    lead: { firstName: "Michael", lastName: "Torres", email: "michael.torres@swinerton.com" },
  },
  dueAt: "2026-08-14T19:00:00.000Z",
  invitedAt: "2026-07-07T17:15:00.000Z",
  expectedStartAt: "2026-11-02T12:00:00.000Z",
  expectedFinishAt: "2027-09-30T12:00:00.000Z",
  squareFootage: "42000",
  tradeName: "Division 10 - Specialties",
  location: {
    streetNumber: "4800", streetName: "Sunset Ridge Dr", city: "Frisco", state: "TX", zip: "75034",
    country: "US", complete: "4800 Sunset Ridge Dr, Frisco, TX 75034",
  },
};
// The live GET-by-id endpoint returns a lean summary that omits the
// office/company expansion (region source), expected start/finish dates,
// square footage, trade, and location — the email-intake path must backfill
// those from the list fetch (the source BC Sync uses). PAYLOAD_A above is the
// full list-endpoint record; this is what GET-by-id actually answers with.
const PAYLOAD_A_LEAN = {
  id: OPP_A,
  name: PAYLOAD_A.name,
  dueAt: PAYLOAD_A.dueAt,
};
const PAYLOAD_B = {
  id: OPP_B,
  name: "Riverside Community College - Building C Renovation",
  projectId: "88bb22cc33dd44ee55ff66aa",
  client: {
    company: { name: "Turner Construction Company" },
    lead: { firstName: "Dana", lastName: "Whitfield", email: "dana.whitfield@tcco.com" },
  },
  dueAt: "2026-07-30T21:00:00.000Z",
  invitedAt: "2026-07-07T23:41:00.000Z",
  expectedStartAt: "2026-10-05T12:00:00.000Z",
  expectedFinishAt: "2027-08-20T12:00:00.000Z",
  tradeName: "Division 10 Specialties",
  location: {
    streetNumber: "4800", streetName: "Magnolia Ave", city: "Riverside", state: "CA", zip: "92506",
    complete: "4800 Magnolia Ave, Riverside, CA 92506",
  },
};
const PAYLOAD_D_NDA = {
  id: OPP_D,
  name: "Lakeline Transit Center Expansion",
  client: {
    company: { name: "Hensel Phelps - Austin" },
    lead: { firstName: "Marcus", lastName: "Webb", email: "marcus.webb@henselphelps.com" },
  },
  dueAt: "2026-08-27T19:00:00.000Z",
  invitedAt: "2026-07-14T14:20:00.000Z",
  tradeName: "Division 10 Specialties",
  // no location and no projectId → NDA-restricted per looksLikeNdaInvite
};

// ── Fetch stub: BC endpoints answered from recorded payloads, all other hosts blocked ──
const realFetch = globalThis.fetch;
function installFetchStub() {
  globalThis.fetch = (async (input: any, _init?: any) => {
    const url = String(input);
    if (!url.includes("developer.api.autodesk.com")) {
      throw new Error(`[audit] Outbound network blocked during audit: ${url.slice(0, 120)}`);
    }
    const json = (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    // GET-by-id — answers with the lean summary shape (regression: the full
    // record must come from the list backfill, not from GET-by-id)
    if (url.includes(`/opportunities/${OPP_A}`)) return json(PAYLOAD_A_LEAN);
    if (url.includes(`/opportunities/${OPP_D}`)) return json(PAYLOAD_D_NDA);
    if (url.includes(`/opportunities/${OPP_B}`)) return json({ message: "not found" }, 404); // force list-fallback
    // List endpoints — the expanded records (A's full payload lives ONLY here)
    if (url.includes("/opportunities?")) return json({ results: [PAYLOAD_A, PAYLOAD_B], pagination: { totalResults: 2 } });
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

interface Expected {
  user: "withBc" | "noBc";
  status: string;
  bcEnrichmentStatus?: string;
  sourceType?: string;
  extractionTierNoLlm?: string;
  entry?: Record<string, any>;
  entryNoLlm?: Record<string, any>;
  entryLlm?: Record<string, any>;
  provenance?: Record<string, string>;
}

interface Failure {
  fixture: string;
  field: string;
  expected: any;
  actual: any;
}

const failures: Failure[] = [];
const passes: { fixture: string; checks: number }[] = [];
const createdEntryIds: number[] = [];
const createdIntakeIds: number[] = [];

function check(fixture: string, field: string, expected: any, actual: any): boolean {
  const norm = (v: any) => (v === undefined ? null : v);
  if (JSON.stringify(norm(expected)) === JSON.stringify(norm(actual))) return true;
  failures.push({ fixture, field, expected, actual });
  return false;
}

async function ensureUser(email: string): Promise<number> {
  const [existing] = await db.select().from(users).where(eq(users.email, email));
  if (existing) return existing.id;
  const [row] = await db.insert(users).values({
    email,
    displayName: email.split("@")[0],
    role: "admin",
    isActive: true,
    status: "active",
  }).returning({ id: users.id });
  return row.id;
}

async function ensureBcToken(userId: number) {
  const [existing] = await db.select().from(apsTokens).where(eq(apsTokens.userId, userId));
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  if (existing) {
    await db.update(apsTokens).set({ accessToken: "audit-test-token", expiresAt }).where(eq(apsTokens.id, existing.id));
  } else {
    await db.insert(apsTokens).values({
      userId,
      accessToken: "audit-test-token",
      refreshToken: "audit-test-refresh",
      expiresAt,
    });
  }
}

async function runFixture(fixtureName: string, expected: Expected, userIds: { withBc: number; noBc: number }, llmMode: boolean) {
  const buf = fs.readFileSync(path.join(fixturesDir, fixtureName));
  const userId = expected.user === "noBc" ? userIds.noBc : userIds.withBc;
  const result = await processEmailIntake({ buffer: buf, originalname: fixtureName }, userId, { isTest: true });

  if (result.intakeId != null) createdIntakeIds.push(result.intakeId);
  if (result.entryId != null && result.status === "draft_created") createdEntryIds.push(result.entryId);

  let checks = 0;
  const c = (field: string, exp: any, act: any) => { checks++; check(fixtureName, field, exp, act); };

  c("result.status", expected.status, result.status);
  if (expected.bcEnrichmentStatus) c("result.bcEnrichment.status", expected.bcEnrichmentStatus, result.bcEnrichment.status);
  if (!llmMode && expected.extractionTierNoLlm && result.status === "draft_created") {
    c("result.extractionTier", expected.extractionTierNoLlm, result.extractionTier);
  }

  // Ledger row must exist and agree with the result
  if (result.intakeId != null) {
    const [ledger] = await db.select().from(emailIntakeLog).where(eq(emailIntakeLog.id, result.intakeId));
    c("ledger.exists", true, !!ledger);
    if (ledger) {
      c("ledger.status", result.status, ledger.status);
      if (result.entryId != null) c("ledger.entryId", result.entryId, ledger.entryId);
      c("ledger.rawEmail.byteLength", buf.length, ledger.rawEmail ? Buffer.from(ledger.rawEmail).length : null);
    }
  } else if (expected.status !== "failed") {
    check(fixtureName, "result.intakeId", "non-null", null);
  }

  // Entry field-by-field diff
  if (expected.status === "draft_created") {
    if (result.entryId == null) {
      check(fixtureName, "result.entryId", "non-null", null);
    } else {
      const [entry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, result.entryId));
      c("entry.exists", true, !!entry);
      if (entry) {
        const expectedEntry: Record<string, any> = {
          ...(expected.entry || {}),
          ...((llmMode ? expected.entryLlm : expected.entryNoLlm) || {}),
          ...(expected.sourceType ? { sourceType: expected.sourceType } : {}),
        };
        for (const [field, exp] of Object.entries(expectedEntry)) {
          c(`entry.${field}`, exp, (entry as any)[field]);
        }
        c("entry.isTest", true, entry.isTest);
        c("entry.sourceAttachmentUrl", `/api/email-intake/${result.intakeId}/raw`, entry.sourceAttachmentUrl);
      }
      for (const [field, exp] of Object.entries(expected.provenance || {})) {
        c(`provenance.${field}`, exp, result.provenance?.[field]);
      }
    }
  }

  passes.push({ fixture: fixtureName, checks });
  return result;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const llmMode = !!process.env.OPENAI_API_KEY;
  console.log(`\n=== Email Intake Audit === (extraction mode: ${llmMode ? "LLM (gpt-4o-mini)" : "regex/floor — no OPENAI_API_KEY"})\n`);

  const withBc = await ensureUser("email-intake-audit-bc@test.local");
  const noBc = await ensureUser("email-intake-audit-nobc@test.local");
  await ensureBcToken(withBc);
  await db.delete(apsTokens).where(eq(apsTokens.userId, noBc));
  const userIds = { withBc, noBc };

  // Clean any leftovers from a previous run so re-drops behave as first drops
  await cleanup(false);

  installFetchStub();
  try {
    const expectedFiles = fs.readdirSync(expectedDir).filter(f => f.endsWith(".json"));
    const firstResults: Record<string, Awaited<ReturnType<typeof processEmailIntake>>> = {};

    for (const ef of expectedFiles.sort()) {
      const fixtureName = ef.replace(/\.json$/, "");
      const expected = JSON.parse(fs.readFileSync(path.join(expectedDir, ef), "utf8")) as Expected;
      console.log(`→ ${fixtureName} (user: ${expected.user})`);
      firstResults[fixtureName] = await runFixture(fixtureName, expected, userIds, llmMode);
    }

    // ── Scenario: non-email file must fail visibly, with a ledger row ──
    console.log("→ not-an-email.pdf (must fail visibly)");
    const pdfBuf = fs.readFileSync(path.join(fixturesDir, "not-an-email.pdf"));
    const pdfResult = await processEmailIntake({ buffer: pdfBuf, originalname: "not-an-email.pdf" }, withBc, { isTest: true });
    if (pdfResult.intakeId != null) createdIntakeIds.push(pdfResult.intakeId);
    check("not-an-email.pdf", "result.status", "failed", pdfResult.status);
    check("not-an-email.pdf", "result.error mentions email", true, /not an email/i.test(pdfResult.error || ""));
    passes.push({ fixture: "not-an-email.pdf", checks: 2 });

    // ── Scenario: exact re-drop → duplicate_intake via content hash ──
    console.log("→ re-drop bc-invite.eml (idempotency)");
    const redrop = await processEmailIntake(
      { buffer: fs.readFileSync(path.join(fixturesDir, "bc-invite.eml")), originalname: "bc-invite.eml" },
      withBc, { isTest: true },
    );
    check("re-drop", "result.status", "duplicate_intake", redrop.status);
    check("re-drop", "points at original entry", firstResults["bc-invite.eml"]?.entryId ?? null, redrop.entryId);
    passes.push({ fixture: "re-drop bc-invite.eml", checks: 2 });

    // ── Scenario: different email, same BC opportunity → duplicate_intake via bcSyncLog ──
    console.log("→ same-opportunity different email (no double-create)");
    const variant = fs.readFileSync(path.join(fixturesDir, "bc-invite.eml"), "utf8")
      .replace("Message-ID: <bc-invite-fixture-001@buildingconnected.com>", "Message-ID: <bc-invite-fixture-001-resend@buildingconnected.com>");
    const sameOpp = await processEmailIntake({ buffer: Buffer.from(variant), originalname: "bc-invite-resend.eml" }, withBc, { isTest: true });
    if (sameOpp.intakeId != null) createdIntakeIds.push(sameOpp.intakeId);
    check("same-opportunity", "result.status", "duplicate_intake", sameOpp.status);
    check("same-opportunity", "points at original entry", firstResults["bc-invite.eml"]?.entryId ?? null, sameOpp.entryId);
    passes.push({ fixture: "same-opportunity resend", checks: 2 });

    // ── Scenario: re-bid (same project, no BC link) → draft + duplicate matches for round-merge ──
    console.log("→ re-bid email (fuzzy duplicate → bid-round candidates)");
    const rebidEml = [
      "From: \"Michael Torres\" <michael.torres@swinerton.com>",
      "To: estimating@nbsco.com",
      "Subject: RE: Sunset Ridge Medical Office Building - Round 2 Pricing",
      "Date: Mon, 20 Jul 2026 08:00:00 -0700",
      "Message-ID: <rebid-fixture@swinerton.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please requote with the updated drawings.",
      "",
    ].join("\r\n");
    const rebid = await processEmailIntake({ buffer: Buffer.from(rebidEml), originalname: "rebid.eml" }, withBc, { isTest: true });
    if (rebid.intakeId != null) createdIntakeIds.push(rebid.intakeId);
    if (rebid.entryId != null && rebid.status === "draft_created") createdEntryIds.push(rebid.entryId);
    check("re-bid", "result.status", "draft_created", rebid.status);
    check("re-bid", "duplicate matches found", true, rebid.duplicates.length > 0);
    check("re-bid", "original entry among matches", true, rebid.duplicates.some(d => d.id === firstResults["bc-invite.eml"]?.entryId));
    if (rebid.entryId != null) {
      const [rebidEntry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, rebid.entryId));
      check("re-bid", "__dup marker set on draft", true, !!rebidEntry?.duplicateOverrideNote?.startsWith("__dup:"));
    }
    passes.push({ fixture: "re-bid rebid.eml", checks: 4 });

    // ── Invariants across the whole run ──
    console.log("→ invariants");
    const stuck = await db.select({ id: emailIntakeLog.id }).from(emailIntakeLog).where(eq(emailIntakeLog.status, "processing"));
    check("invariants", "no ledger rows stuck in processing", 0, stuck.length);
    for (const [name, r] of Object.entries(firstResults)) {
      check("invariants", `${name} has deterministic outcome`, true, ["draft_created", "duplicate_intake", "failed"].includes(r.status));
    }
    // Audit-log coverage: every created draft has an email_intake audit row
    for (const entryId of createdEntryIds) {
      const rows = await db.select({ id: auditLogs.id }).from(auditLogs)
        .where(eq(auditLogs.entityId, String(entryId)));
      check("invariants", `audit log row exists for entry ${entryId}`, true, rows.length > 0);
    }
    passes.push({ fixture: "invariants", checks: 2 + Object.keys(firstResults).length + createdEntryIds.length });
  } finally {
    restoreFetch();
  }

  // ── Report ──
  const totalChecks = passes.reduce((s, p) => s + p.checks, 0);
  console.log("\n──────── AUDIT RESULTS ────────");
  for (const p of passes) {
    const fixtureFailures = failures.filter(f => f.fixture === p.fixture || f.fixture.startsWith(p.fixture.split(" ")[0]));
    const failCount = failures.filter(f => f.fixture === p.fixture).length;
    console.log(`${failCount === 0 ? "PASS" : "FAIL"}  ${p.fixture}  (${p.checks - failCount}/${p.checks} checks)`);
    void fixtureFailures;
  }
  if (failures.length > 0) {
    console.log("\nField mismatches:");
    for (const f of failures) {
      console.log(`  ✗ [${f.fixture}] ${f.field}\n      expected: ${JSON.stringify(f.expected)}\n      actual:   ${JSON.stringify(f.actual)}`);
    }
  }
  console.log(`\nTotal: ${totalChecks - failures.length}/${totalChecks} checks passed, ${failures.length} failed`);

  await cleanup(true);

  process.exit(failures.length > 0 ? 1 : 0);
}

/** Remove everything this audit created (also runs pre-flight to clear stale state). */
async function cleanup(verbose: boolean) {
  try {
    const testIntakes = await db.select({ id: emailIntakeLog.id, entryId: emailIntakeLog.entryId })
      .from(emailIntakeLog)
      .where(like(emailIntakeLog.fileName, "%.%"));
    // Only touch rows for our fixture hashes: identify by uploader test accounts
    const auditUsers = await db.select({ id: users.id }).from(users).where(like(users.email, "email-intake-audit-%@test.local"));
    const auditUserIds = auditUsers.map(u => u.id);
    if (auditUserIds.length === 0) return;

    const ourIntakes = await db.select({ id: emailIntakeLog.id, entryId: emailIntakeLog.entryId, bcOpportunityId: emailIntakeLog.bcOpportunityId })
      .from(emailIntakeLog)
      .where(inArray(emailIntakeLog.uploadedBy, auditUserIds));
    const intakeIds = ourIntakes.map(r => r.id);
    const entryIds = Array.from(new Set(ourIntakes.map(r => r.entryId).filter((v): v is number => v != null)));
    const oppIds = Array.from(new Set(ourIntakes.map(r => r.bcOpportunityId).filter((v): v is string => !!v)));

    // Delete the intake ledger rows FIRST — emailIntakeLog.entryId FKs to
    // proposalLogEntries, so the entries can't be removed while ledger rows
    // still reference them.
    if (intakeIds.length > 0) {
      await db.delete(emailIntakeLog).where(inArray(emailIntakeLog.id, intakeIds));
    }
    if (entryIds.length > 0) {
      await db.delete(bcSyncLog).where(inArray(bcSyncLog.entryId, entryIds));
      await db.delete(proposalChangeLog).where(inArray(proposalChangeLog.entryId, entryIds));
      await db.delete(proposalLogEntries).where(inArray(proposalLogEntries.id, entryIds));
    }
    if (oppIds.length > 0) {
      await db.delete(bcSyncLog).where(inArray(bcSyncLog.bcOpportunityId, oppIds));
    }
    await db.delete(notifications).where(like(notifications.title, "%Email%"));
    if (verbose) {
      console.log(`Cleanup: removed ${intakeIds.length} intake rows, ${entryIds.length} draft entries`);
    }
    void testIntakes;
  } catch (err: any) {
    console.warn("Cleanup warning:", err.message);
  }
}

main().catch(err => {
  console.error(err);
  restoreFetch();
  process.exit(1);
});
