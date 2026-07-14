// Run: tsx server/emailIntake/bcReferencePull.test.ts
//
// DB-free unit tests for the lean-GET-by-id backfill: a 200 GET-by-id response
// that omits the office/company expansion (region source) and expected
// start/finish dates must be completed from the list fetch — the same source
// BC Sync uses. The full pipeline (pullBcOpportunity → draft) is exercised by
// scripts/email-intake-audit.ts against a real Postgres.
import assert from "assert";

// bcReferencePull → tokenManager → db throws at import time without a
// DATABASE_URL; the pool never connects in these tests.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://placeholder:placeholder@localhost:5432/placeholder";

const OPP_ID = "68b1c2d3e4f5a6b7c8d9e0f1";
const PROJECT_ID = "77aa11bb22cc33dd44ee55ff";

// Full list-endpoint record (live-API shape, same as the audit script)
const LIST_PAYLOAD = {
  id: OPP_ID,
  name: "Sunset Ridge Medical Office Building",
  projectId: PROJECT_ID,
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

// Lean GET-by-id summary: id + name + due date only
const LEAN_PAYLOAD = {
  id: OPP_ID,
  name: "Sunset Ridge Medical Office Building",
  dueAt: "2026-08-14T19:00:00.000Z",
};

const realFetch = globalThis.fetch;
let listCalls = 0;

function stubListFetch(handler: () => Response | Promise<Response>) {
  listCalls = 0;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("/opportunities?")) {
      listCalls++;
      return handler();
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function run() {
  const { missingOpportunityFields, opportunityIsComplete, mergeOpportunities, backfillFromListFetch } =
    await import("./bcReferencePull");
  const { normalizeOpportunity } = await import("../autodesk/bcSync");

  // ── missingOpportunityFields / opportunityIsComplete ──
  const fullOpp = normalizeOpportunity(LIST_PAYLOAD);
  assert.deepStrictEqual(missingOpportunityFields(fullOpp), [], "full list record has no missing fields");
  assert.strictEqual(opportunityIsComplete(fullOpp), true);

  const leanOpp = normalizeOpportunity(LEAN_PAYLOAD);
  const missing = missingOpportunityFields(leanOpp);
  assert.strictEqual(opportunityIsComplete(leanOpp), false, "lean GET-by-id record is incomplete");
  for (const f of ["gcCompanyName/gcOfficeHint", "expectedStart", "expectedFinish", "location", "projectId"]) {
    assert.ok(missing.includes(f), `lean record reports "${f}" missing (got: ${missing.join(", ")})`);
  }
  assert.ok(!missing.includes("bidDueDate"), "present field (bidDueDate) not reported missing");

  // ── mergeOpportunities ──
  const merged = mergeOpportunities(leanOpp, fullOpp);
  assert.strictEqual(merged.id, OPP_ID);
  assert.strictEqual(merged.projectName, "Sunset Ridge Medical Office Building");
  assert.strictEqual(merged.gcCompanyName, "Swinerton Builders - Dallas", "region source backfilled");
  assert.strictEqual(merged.expectedStart, "2026-11-02T12:00:00.000Z", "start date backfilled");
  assert.strictEqual(merged.expectedFinish, "2027-09-30T12:00:00.000Z", "finish date backfilled");
  assert.strictEqual(merged.projectId, PROJECT_ID, "projectId backfilled");
  assert.strictEqual(merged.squareFeet, "42000", "square feet backfilled");
  assert.strictEqual(merged.gcContactName, "Michael Torres", "GC contact backfilled");
  assert.strictEqual(merged.location?.city, "Frisco", "location backfilled");
  assert.strictEqual(merged.location?.formattedAddress, "4800 Sunset Ridge Dr, Frisco, TX 75034");
  assert.deepStrictEqual(merged.scopes, ["Division 10 - Specialties"], "scopes backfilled");
  assert.strictEqual(merged.bidDueDate, "2026-08-14T19:00:00.000Z", "primary value kept when present");
  assert.strictEqual(opportunityIsComplete(merged), true, "merged record is complete");

  // Primary values win over backfill values
  const conflicting = mergeOpportunities(fullOpp, {
    ...fullOpp,
    gcCompanyName: "Other GC",
    expectedStart: "1999-01-01",
    location: { city: "Elsewhere", state: "ZZ", formattedAddress: "nowhere" },
  });
  assert.strictEqual(conflicting.gcCompanyName, "Swinerton Builders - Dallas", "primary gcCompanyName wins");
  assert.strictEqual(conflicting.expectedStart, "2026-11-02T12:00:00.000Z", "primary start wins");
  assert.strictEqual(conflicting.location?.city, "Frisco", "primary location wins");

  // ── backfillFromListFetch: list hit ──
  stubListFetch(() => json({ results: [LIST_PAYLOAD], pagination: { totalResults: 1 } }));
  let result = await backfillFromListFetch("test-token", leanOpp, LEAN_PAYLOAD as Record<string, any>);
  assert.strictEqual(result.status, "enriched");
  assert.strictEqual(result.opportunity?.gcCompanyName, "Swinerton Builders - Dallas", "list hit: region source filled");
  assert.strictEqual(result.opportunity?.expectedStart, "2026-11-02T12:00:00.000Z", "list hit: start filled");
  assert.strictEqual(result.opportunity?.expectedFinish, "2027-09-30T12:00:00.000Z", "list hit: finish filled");
  assert.ok((result.raw as any)?._listBackfill, "list hit: raw carries _listBackfill diagnostics");
  assert.ok(listCalls > 0, "list endpoint was called");

  // ── backfillFromListFetch: match by projectId when list id differs ──
  const leanWithProject = { ...leanOpp, id: "aaaaaaaaaaaaaaaaaaaaaaaa", projectId: PROJECT_ID };
  stubListFetch(() => json({ results: [LIST_PAYLOAD], pagination: { totalResults: 1 } }));
  result = await backfillFromListFetch("test-token", leanWithProject, LEAN_PAYLOAD as Record<string, any>);
  assert.strictEqual(result.opportunity?.gcCompanyName, "Swinerton Builders - Dallas", "projectId match backfills");

  // ── backfillFromListFetch: list miss keeps partial data, still enriched ──
  stubListFetch(() => json({ results: [], pagination: { totalResults: 0 } }));
  result = await backfillFromListFetch("test-token", leanOpp, LEAN_PAYLOAD as Record<string, any>);
  assert.strictEqual(result.status, "enriched", "list miss: still enriched");
  assert.strictEqual(result.opportunity?.projectName, "Sunset Ridge Medical Office Building", "list miss: partial data kept");
  assert.strictEqual((result.raw as any)?._listBackfill, undefined, "list miss: no backfill diagnostics");

  // ── backfillFromListFetch: list error keeps partial data, never downgrades ──
  stubListFetch(() => json({ message: "boom" }, 500));
  result = await backfillFromListFetch("test-token", leanOpp, LEAN_PAYLOAD as Record<string, any>);
  assert.strictEqual(result.status, "enriched", "list error: still enriched");
  assert.strictEqual(result.opportunity, leanOpp, "list error: partial data kept");

  // ── backfillFromListFetch: fetch throw keeps partial data ──
  stubListFetch(() => { throw new Error("network down"); });
  result = await backfillFromListFetch("test-token", leanOpp, LEAN_PAYLOAD as Record<string, any>);
  assert.strictEqual(result.status, "enriched", "fetch throw: still enriched");

  globalThis.fetch = realFetch;
  console.log("bcReferencePull.test.ts: all assertions passed");
}

run().catch(err => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
