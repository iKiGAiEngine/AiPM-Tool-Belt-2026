// Run: tsx server/emailIntake/emailParser.test.ts
import assert from "assert";
import fs from "fs";
import path from "path";
import { parseEmailFile, sniffEmailType, htmlToText, extractHrefs, rtfToText } from "./emailParser";

const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
const read = (name: string) => fs.readFileSync(path.join(fixturesDir, name));

async function run() {
  // ── sniffEmailType ──
  assert.strictEqual(sniffEmailType(read("bc-invite.eml")), "eml", "bc-invite.eml sniffs as eml");
  assert.strictEqual(sniffEmailType(read("bc-invite.msg")), "msg", "bc-invite.msg sniffs as msg");
  assert.strictEqual(sniffEmailType(read("bc-invite-rtf.msg")), "msg", "rtf msg sniffs as msg");
  assert.strictEqual(sniffEmailType(read("not-an-email.pdf")), "unknown", "pdf sniffs as unknown");
  assert.strictEqual(sniffEmailType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "unknown", "png sniffs as unknown");

  // ── .eml: BC invite (HTML multipart, quoted-printable, wrapped link) ──
  const bcInvite = await parseEmailFile(read("bc-invite.eml"), "bc-invite.eml");
  assert.strictEqual(bcInvite.fileType, "eml");
  assert.strictEqual(bcInvite.subject, "Invitation to Bid: Sunset Ridge Medical Office Building");
  assert.strictEqual(bcInvite.fromEmail, "notifications@buildingconnected.com");
  assert.ok(bcInvite.fromName.includes("Swinerton"), `fromName has GC: ${bcInvite.fromName}`);
  assert.ok(bcInvite.messageId?.includes("bc-invite-fixture-001"), "messageId parsed");
  assert.ok(bcInvite.date?.startsWith("2026-07-07"), `date parsed: ${bcInvite.date}`);
  assert.ok(bcInvite.text.includes("Sunset Ridge Medical Office Building"), "text has project name");
  assert.ok(bcInvite.html && bcInvite.html.includes("<table>"), "html preserved");
  // quoted-printable soft line breaks must be decoded so the wrapped link is whole
  const loginHref = bcInvite.hrefs.find(h => h.includes("app.buildingconnected.com/login"));
  assert.ok(loginHref, `hrefs include login-wrapped BC link: ${JSON.stringify(bcInvite.hrefs)}`);
  assert.ok(loginHref!.includes("continueUrl="), "wrapped link keeps continueUrl param");
  assert.ok(!bcInvite.hrefs.some(h => h.startsWith("mailto:")), "mailto hrefs excluded");

  // ── .eml: forwarded plain-text invite ──
  const fwd = await parseEmailFile(read("bc-invite-forwarded.eml"), "bc-invite-forwarded.eml");
  assert.strictEqual(fwd.fromEmail, "hkruse@nbsco.com", "wrapper sender (not GC contact)");
  assert.ok(fwd.subject.startsWith("FW:"), "FW subject kept raw at parse layer");
  assert.ok(fwd.text.includes("Forwarded message"), "forwarded block present");
  assert.ok(fwd.text.includes("app.buildingconnected.com/opportunities/68c4d5e6f7a8b9c0d1e2f3a4"), "direct BC link in text");
  assert.strictEqual(fwd.hrefs.length, 0, "plain text email has no hrefs");

  // ── .eml: GC direct (no BC link) ──
  const gc = await parseEmailFile(read("gc-direct.eml"), "gc-direct.eml");
  assert.strictEqual(gc.fromEmail, "rcastellanos@hprconstruction.com");
  assert.ok(gc.text.includes("Mesa Verde Elementary School Modernization"));
  assert.ok(!gc.text.includes("buildingconnected.com"), "no BC link");

  // ── .eml: minimal ──
  const min = await parseEmailFile(read("partial-minimal.eml"), "partial-minimal.eml");
  assert.strictEqual(min.subject, "FW: Bid Invitation - Cedar Flats Apartments Phase 2");
  assert.strictEqual(min.fromEmail, "bids@genericgc.com");

  // ── .msg: plain body ──
  const msg = await parseEmailFile(read("bc-invite.msg"), "bc-invite.msg");
  assert.strictEqual(msg.fileType, "msg");
  assert.strictEqual(msg.subject, "Invitation to Bid: Harbor Point Logistics Center - Phase 1");
  assert.strictEqual(msg.fromEmail, "notifications@buildingconnected.com");
  assert.ok(msg.text.includes("Harbor Point Logistics Center"), "msg body parsed");
  assert.ok(msg.text.includes("app.buildingconnected.com/opportunities/68d7e8f9a0b1c2d3e4f5a6b7"), "BC link in msg body");
  assert.ok(msg.date?.startsWith("2026-07-13"), `msg date from transport headers: ${msg.date}`);
  assert.ok(msg.messageId?.includes("msg-fixture-005"), "msg messageId from headers");

  // ── .msg: compressed-RTF-only body ──
  const rtfMsg = await parseEmailFile(read("bc-invite-rtf.msg"), "bc-invite-rtf.msg");
  assert.strictEqual(rtfMsg.subject, "Invitation to Bid: Lakeline Transit Center Expansion");
  assert.ok(rtfMsg.text.includes("Lakeline Transit Center Expansion"), `rtf body decoded: ${rtfMsg.text.slice(0, 120)}`);
  assert.ok(rtfMsg.text.includes("app.buildingconnected.com/opportunities/68e9f0a1b2c3d4e5f6a7b8c9"), "BC link survives RTF strip");
  assert.ok(rtfMsg.text.includes("Hensel Phelps"), "client name survives RTF strip");

  // ── non-email files throw with a readable message ──
  await assert.rejects(
    () => parseEmailFile(read("not-an-email.pdf"), "not-an-email.pdf"),
    /Not an email file/,
    "pdf rejected"
  );
  await assert.rejects(() => parseEmailFile(Buffer.alloc(0), "empty.eml"), /empty/i, "empty file rejected");

  // ── helpers ──
  assert.strictEqual(htmlToText("<p>Hello&nbsp;<b>world</b></p>"), "Hello world");
  assert.deepStrictEqual(
    extractHrefs('<a href="https://x.com/a">a</a> <a href=\'#top\'>t</a> <a href="mailto:z@z.com">z</a>'),
    ["https://x.com/a"]
  );
  const rtfOut = rtfToText("{\\rtf1\\ansi Hello\\par World \\'e9}");
  assert.ok(rtfOut.includes("Hello") && rtfOut.includes("World"), `rtfToText basic: ${rtfOut}`);

  console.log("All emailParser tests passed!");
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
