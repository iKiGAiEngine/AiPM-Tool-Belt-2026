// Run: tsx server/emailIntake/bcLinkResolver.test.ts
import assert from "assert";
import fs from "fs";
import path from "path";
import { findBcLink, unwrapToBcLink, extractOpportunityIdFromLink, followTrackerRedirects } from "./bcLinkResolver";
import { parseEmailFile } from "./emailParser";

const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const read = (name: string) => fs.readFileSync(path.join(fixturesDir, name));

const OPP_A = "68b1c2d3e4f5a6b7c8d9e0f1";
const OPP_B = "68c4d5e6f7a8b9c0d1e2f3a4";

async function run() {
  // ── unwrapToBcLink ──
  assert.strictEqual(
    unwrapToBcLink(`https://app.buildingconnected.com/opportunities/${OPP_A}`),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "direct link passes through"
  );
  assert.strictEqual(
    unwrapToBcLink(`https://app.buildingconnected.com/login?continueUrl=%2Fopportunities%2F${OPP_A}`),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "login continueUrl (path form) unwrapped"
  );
  assert.strictEqual(
    unwrapToBcLink(
      `https://app.buildingconnected.com/login?continueUrl=${encodeURIComponent(`https://app.buildingconnected.com/opportunities/${OPP_A}`)}`
    ),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "login continueUrl (full URL form) unwrapped"
  );
  const b64 = Buffer.from(`https://app.buildingconnected.com/opportunities/${OPP_A}`).toString("base64url");
  assert.strictEqual(
    unwrapToBcLink(`https://links.buildingconnected.com/ls/click?upn=${b64}`),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "base64 tracker payload unwrapped"
  );
  assert.strictEqual(unwrapToBcLink("https://www.example.com/nothing"), null, "non-BC link yields null");
  // A bare login link with no target must NOT count as a BC link
  assert.strictEqual(unwrapToBcLink("https://app.buildingconnected.com/login"), null, "bare login link rejected");

  // ── extractOpportunityIdFromLink ──
  assert.deepStrictEqual(
    extractOpportunityIdFromLink(`https://app.buildingconnected.com/opportunities/${OPP_A}`),
    { opportunityId: OPP_A, projectId: null }
  );
  assert.deepStrictEqual(
    extractOpportunityIdFromLink(`https://app.buildingconnected.com/projects/${OPP_B}`),
    { opportunityId: null, projectId: OPP_B }
  );
  assert.deepStrictEqual(
    extractOpportunityIdFromLink(`https://app.buildingconnected.com/projects/${OPP_B}/opportunities/${OPP_A}/files`),
    { opportunityId: OPP_A, projectId: OPP_B }
  );
  assert.deepStrictEqual(extractOpportunityIdFromLink(""), { opportunityId: null, projectId: null });
  // Uppercase hex + urlencoded input
  assert.strictEqual(
    extractOpportunityIdFromLink(`https://app.buildingconnected.com/opportunities/${OPP_A.toUpperCase()}`).opportunityId,
    OPP_A,
    "id lowercased"
  );

  // ── findBcLink on fixtures ──
  const bcInvite = await parseEmailFile(read("bc-invite.eml"), "bc-invite.eml");
  assert.strictEqual(
    await findBcLink(bcInvite),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "HTML invite: wrapped href resolved"
  );

  const fwd = await parseEmailFile(read("bc-invite-forwarded.eml"), "bc-invite-forwarded.eml");
  assert.strictEqual(
    await findBcLink(fwd),
    `https://app.buildingconnected.com/opportunities/${OPP_B}`,
    "forwarded plain-text invite: direct link found in text"
  );

  const gc = await parseEmailFile(read("gc-direct.eml"), "gc-direct.eml");
  assert.strictEqual(await findBcLink(gc), null, "GC direct invite has no BC link");

  const msg = await parseEmailFile(read("bc-invite.msg"), "bc-invite.msg");
  assert.strictEqual(
    await findBcLink(msg),
    "https://app.buildingconnected.com/opportunities/68d7e8f9a0b1c2d3e4f5a6b7",
    ".msg body link found"
  );

  const rtfMsg = await parseEmailFile(read("bc-invite-rtf.msg"), "bc-invite-rtf.msg");
  assert.strictEqual(
    await findBcLink(rtfMsg),
    "https://app.buildingconnected.com/opportunities/68e9f0a1b2c3d4e5f6a7b8c9",
    "RTF .msg body link found"
  );

  // ── followTrackerRedirects with injected fetch (no real network) ──
  const fakeFetch = (async (url: any, _init?: any) => {
    const u = String(url);
    if (u === "https://ct.sendgrid.net/x/abc") {
      return { headers: new Headers({ location: `https://app.buildingconnected.com/login?continueUrl=%2Fopportunities%2F${OPP_A}` }) } as Response;
    }
    return { headers: new Headers() } as Response;
  }) as typeof fetch;
  assert.strictEqual(
    await followTrackerRedirects("https://ct.sendgrid.net/x/abc", fakeFetch),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "tracker redirect followed and unwrapped"
  );
  const failFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  assert.strictEqual(await followTrackerRedirects("https://ct.sendgrid.net/x/abc", failFetch), null, "network failure is non-fatal");

  // ── BuildingConnected's own /goto/ short-links ──
  // Newer BC invite templates ("View this RFP" / "Bidding" buttons) link to
  // app.buildingconnected.com/goto/<code>, which looks like a direct BC link
  // by host but carries no opportunity/project id until its redirect is
  // followed. Regression for the DPS Gateway E-5 intake, where this caused
  // BC enrichment (and therefore Region) to silently never run.
  const gotoLink = "https://app.buildingconnected.com/goto/6a5fcfbf8d492f0032f55f3e19f864383a3itb";
  const gotoFetch = (async (url: any) => {
    if (String(url) === gotoLink) {
      return { headers: new Headers({ location: `https://app.buildingconnected.com/opportunities/${OPP_A}` }) } as Response;
    }
    return { headers: new Headers() } as Response;
  }) as typeof fetch;
  const gotoEmail = {
    subject: "Bid Invite", fromName: "", fromEmail: "", date: null,
    text: `View this RFP <${gotoLink}>`, html: null, messageId: null,
    hrefs: [gotoLink], fileType: "eml" as const,
  };
  assert.strictEqual(
    await findBcLink(gotoEmail, gotoFetch),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "/goto/ short-link followed to the real opportunity link"
  );
  // Redirect fails (no network, e.g. this sandbox) — falls back to the /goto/
  // link itself rather than null, so "View on BC" still has somewhere to point.
  const gotoFailFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  assert.strictEqual(
    await findBcLink(gotoEmail, gotoFailFetch),
    gotoLink,
    "/goto/ link with unresolvable redirect falls back to itself, not null"
  );

  // Regression: the actual DPS Gateway E-5 .msg is a plain-text-only forward
  // (Outlook forward of an RTF-converted body) with ZERO hrefs and no HTML
  // part — the /goto/ link only exists as inline text. Pass 2 must still
  // find and follow it; it must not only look at email.hrefs.
  const textOnlyGotoEmail = {
    subject: "FW: Bid Invite", fromName: "", fromEmail: "", date: null,
    text: `View this RFP <${gotoLink}>  View Bid Form <${gotoLink}>`, html: null, messageId: null,
    hrefs: [], fileType: "msg" as const,
  };
  assert.strictEqual(
    await findBcLink(textOnlyGotoEmail, gotoFetch),
    `https://app.buildingconnected.com/opportunities/${OPP_A}`,
    "text-only .msg with zero hrefs: /goto/ link found in body text and followed"
  );

  console.log("All bcLinkResolver tests passed!");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
