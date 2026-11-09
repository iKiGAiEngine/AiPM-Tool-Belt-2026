// End-to-end test of the same-project endpoints against a REAL (scratch) Postgres.
// It replays the Nov 6 Pico incident and proves nothing disappears.
// Run (never against production!):
//   DATABASE_URL=postgres://tester:pw@localhost:5432/bctest npx tsx scripts/test-bc-bundle-routes.ts
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { eq } from "drizzle-orm";
import { db, pool } from "../server/db";
import { users, proposalLogEntries, bcSyncLog, auditLogs } from "@shared/schema";
import { registerBcSyncRoutes } from "../server/autodesk/bcSync";

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "")) {
  console.error("Refusing to run: DATABASE_URL is not a local scratch database."); process.exit(1);
}

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log("ok -", name); };

async function main() {
  await db.execute("TRUNCATE proposal_log_entries, bc_sync_log, audit_logs, users RESTART IDENTITY CASCADE" as any);
  const [admin] = await db.insert(users).values({ email: "a@test.dev", displayName: "Tester", role: "admin", isActive: true, status: "active" } as any).returning();
  const [viewer] = await db.insert(users).values({ email: "v@test.dev", displayName: "Viewer", role: "user", isActive: true, status: "active" } as any).returning();

  let currentUser = admin.id;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).session = { userId: currentUser }; next(); });
  registerBcSyncRoutes(app);
  const server = http.createServer(app).listen(0);
  const port = (server.address() as any).port;
  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };

  const base = { projectName: "Pico & Beverwil Redevelopment", projectAddress: "9600 West Pico Boulevard, Los Angeles, CA 90035", dueDate: "2026-11-25", isDraft: true, sourceType: "bc" };
  const seed = async () => {
    await db.execute("TRUNCATE proposal_log_entries, bc_sync_log, audit_logs RESTART IDENTITY CASCADE" as any);
    const [a] = await db.insert(proposalLogEntries).values({ ...base, estimateNumber: "26-1870", scopeList: JSON.stringify(["Loading Dock Equipment"]), bcOpportunityIds: JSON.stringify(["oppA"]), region: "" } as any).returning();
    const [b] = await db.insert(proposalLogEntries).values({ ...base, estimateNumber: "26-1871", scopeList: JSON.stringify(["Specialties"]), bcOpportunityIds: JSON.stringify(["oppB"]), region: "LAX - SPD" } as any).returning();
    await db.insert(bcSyncLog).values([{ bcOpportunityId: "oppA", entryId: a.id, rawData: {} }, { bcOpportunityId: "oppB", entryId: b.id, rawData: {} }] as any);
    return { a, b };
  };
  const row = async (id: number) => (await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, id)))[0];

  await t("groups endpoint shows the two Pico invites as one 'same project' group", async () => {
    const { a, b } = await seed();
    const r = await call("GET", "/api/bc/draft-groups");
    assert.equal(r.status, 200);
    assert.equal(r.body.groups.length, 1);
    assert.equal(r.body.groups[0].strength, "same");
    assert.deepEqual(r.body.groups[0].draftIds.sort(), [a.id, b.id]);
    assert.equal(r.body.groups[0].suggestedPrimaryId, b.id); // the one with a region
  });

  await t("combine keeps BOTH scopes and BOTH BC IDs on ONE live record", async () => {
    const { a, b } = await seed();
    const r = await call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await row(b.id); const o = await row(a.id);
    assert.deepEqual(JSON.parse(p.scopeList!), ["Specialties", "Loading Dock Equipment"]);
    assert.deepEqual(JSON.parse(p.bcOpportunityIds!), ["oppB", "oppA"]);
    assert.equal(p.isDraft, true); assert.equal(p.deletedAt, null);
    assert.equal(p.estimateNumber, "26-1871");
    assert.equal(p.region, "LAX - SPD");
    assert.ok(o.deletedAt); assert.match(o.duplicateOverrideNote || "", new RegExp(`Combined into entry #${b.id}`));
    assert.ok(p.bcChangeLog!.includes("Loading Dock Equipment"));
    // future BC updates for the absorbed invite now land on the surviving record
    const logs = await db.select().from(bcSyncLog);
    assert.ok(logs.every((l) => l.entryId === b.id));
    // audit trail
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.actionType, "bc_drafts_bundled"));
    assert.equal(audit.length, 1);
  });

  await t("after combining, the group disappears (one bid left)", async () => {
    const { a, b } = await seed();
    await call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] });
    const r = await call("GET", "/api/bc/draft-groups");
    assert.equal(r.body.groups.length, 0);
  });

  await t("the old 'reject as Duplicate' is blocked: it can no longer hide a scope", async () => {
    const { a } = await seed();
    const r = await call("POST", `/api/bc/drafts/${a.id}/reject`, { reason: "Duplicate" });
    assert.equal(r.status, 400); assert.equal(r.body.code, "use_combine");
    assert.equal((await row(a.id)).deletedAt, null);
  });

  await t("rejecting a bid that holds combined invites needs explicit confirmation", async () => {
    const { a, b } = await seed();
    await call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] });
    const r1 = await call("POST", `/api/bc/drafts/${b.id}/reject`, { reason: "Not bidding" });
    assert.equal(r1.status, 409); assert.equal(r1.body.code, "bundle_holder");
    assert.equal((await row(b.id)).deletedAt, null);
    const r2 = await call("POST", `/api/bc/drafts/${b.id}/reject`, { reason: "Not bidding", confirmLoseBundle: true });
    assert.equal(r2.status, 200);
  });

  await t("plain reject of a single invite still works", async () => {
    const { a } = await seed();
    const r = await call("POST", `/api/bc/drafts/${a.id}/reject`, { reason: "Not our trade" });
    assert.equal(r.status, 200);
    assert.ok((await row(a.id)).deletedAt);
  });

  await t("bad requests change nothing: self, missing, unrelated, already-combined", async () => {
    const { a, b } = await seed();
    const [x] = await db.insert(proposalLogEntries).values({ ...base, projectName: "Totally Different Tower", estimateNumber: "26-1999", scopeList: "[]", bcOpportunityIds: "[]" } as any).returning();
    for (const body of [
      { primaryId: b.id, otherIds: [b.id] }, { primaryId: b.id, otherIds: [] }, { primaryId: b.id, otherIds: [99999] },
      { primaryId: b.id, otherIds: [x.id] }, { primaryId: 99999, otherIds: [a.id] }, { primaryId: b.id },
    ]) {
      const r = await call("POST", "/api/bc/drafts/bundle", body);
      assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
    }
    assert.deepEqual(JSON.parse((await row(b.id)).scopeList!), ["Specialties"]);
    assert.equal((await row(a.id)).deletedAt, null);
    await call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] });
    const again = await call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] });
    assert.equal(again.status, 409); // a.id is already absorbed
  });

  await t("a pending invite can be added to an ALREADY APPROVED bid; the approved bid keeps its number", async () => {
    await seed();
    const [appr] = await db.insert(proposalLogEntries).values({ ...base, isDraft: false, estimateNumber: "26-1500", estimateStatus: "Estimating", scopeList: JSON.stringify(["Lockers"]), bcOpportunityIds: JSON.stringify(["oppZ"]), region: "LAX" } as any).returning();
    const draft = (await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.estimateNumber, "26-1871")))[0];
    const g = (await call("GET", "/api/bc/draft-groups")).body.groups[0];
    assert.equal(g.suggestedPrimaryId, appr.id);
    const r = await call("POST", "/api/bc/drafts/bundle", { primaryId: appr.id, otherIds: [draft.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = await row(appr.id);
    assert.equal(p.estimateNumber, "26-1500"); assert.equal(p.isDraft, false);
    assert.ok(JSON.parse(p.scopeList!).includes("Specialties"));
    assert.equal(p.bcUpdateFlag, true); // team sees the "updated" badge
  });

  await t("only admins / draft reviewers can combine", async () => {
    const { a, b } = await seed();
    currentUser = viewer.id;
    const r = await call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] });
    currentUser = admin.id;
    assert.equal(r.status, 403);
    assert.equal((await row(a.id)).deletedAt, null);
  });

  await t("old merge request (mergeIntoId) is still refused before any write", async () => {
    const { a, b } = await seed();
    const r = await call("POST", `/api/bc/drafts/${a.id}/approve-and-create`, { mergeIntoId: b.id, projectName: "x", region: "LAX" });
    assert.equal(r.status, 403); assert.equal(r.body.code, "merge_disabled");
    assert.equal((await row(a.id)).deletedAt, null);
  });

  await t("two people clicking Combine at once: exactly one wins, nothing lost", async () => {
    const { a, b } = await seed();
    const [r1, r2] = await Promise.all([
      call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] }),
      call("POST", "/api/bc/drafts/bundle", { primaryId: b.id, otherIds: [a.id] }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.deepEqual(JSON.parse((await row(b.id)).scopeList!), ["Specialties", "Loading Dock Equipment"]);
  });

  server.close(); await pool.end();
  console.log(`\n${n} end-to-end tests passed`);
}
main().catch(async (e) => { console.error("FAILED:", e); try { await pool.end(); } catch {} process.exit(1); });
