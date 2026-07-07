// Generates the binary Outlook .msg fixtures used by the email-intake tests.
// Run once (and re-run after editing): tsx server/emailIntake/fixtures/generateMsgFixtures.ts
// Uses msgreader's own CFB burner so the fixtures are real, parseable .msg files.
import { burn, Entry } from "@kenjiuno/msgreader/lib/Burner";
import { TypeEnum } from "@kenjiuno/msgreader/lib/Reader";
import fs from "fs";
import path from "path";

const utf16 = (s: string) => new Uint8Array(Buffer.from(s, "utf16le"));

function buildMsg(streams: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const entries: Entry[] = [
    { name: "Root Entry", type: TypeEnum.ROOT, children: [], length: 0 },
  ];
  for (const s of streams) {
    entries[0].children!.push(entries.length);
    entries.push({ name: s.name, type: TypeEnum.DOCUMENT, binaryProvider: () => s.data, length: s.data.length });
  }
  return burn(entries);
}

/** Wrap raw RTF bytes in an uncompressed ("MELA") PidTagRtfCompressed envelope. */
function melaWrap(rtf: string): Uint8Array {
  const raw = Buffer.from(rtf, "latin1");
  const out = Buffer.alloc(16 + raw.length);
  out.writeUInt32LE(12 + raw.length, 0); // compSize: bytes after this field
  out.writeUInt32LE(raw.length, 4);      // rawSize
  out.writeUInt32LE(0x414c454d, 8);      // compType "MELA" = uncompressed
  out.writeUInt32LE(0, 12);              // crc (ignored for MELA)
  raw.copy(out, 16);
  return new Uint8Array(out);
}

const TAG = {
  subject: "__substg1.0_0037001F",
  senderName: "__substg1.0_0C1A001F",
  senderEmail: "__substg1.0_0C1F001F",
  senderSmtp: "__substg1.0_5D01001F",
  body: "__substg1.0_1000001F",
  headers: "__substg1.0_007D001F",
  rtfCompressed: "__substg1.0_10090102",
};

const outDir = path.dirname(new URL(import.meta.url).pathname);

// ── Fixture 1: plain-text body with a direct BC opportunity link ──
const bcInviteMsg = buildMsg([
  { name: TAG.subject, data: utf16("Invitation to Bid: Harbor Point Logistics Center - Phase 1") },
  { name: TAG.senderName, data: utf16("Swinerton Builders via BuildingConnected") },
  { name: TAG.senderEmail, data: utf16("notifications@buildingconnected.com") },
  { name: TAG.senderSmtp, data: utf16("notifications@buildingconnected.com") },
  {
    name: TAG.body,
    data: utf16(
      [
        "Alicia Nguyen with Swinerton Builders - Portland has invited you to bid on Harbor Point Logistics Center - Phase 1.",
        "",
        "Project: Harbor Point Logistics Center - Phase 1",
        "Client: Swinerton Builders - Portland",
        "Location: 2200 N Harbor Dr, Portland, OR 97217",
        "Trade: Division 10 - Specialties",
        "Date Due: Sep 3, 2026 at 2:00 PM PDT",
        "",
        "View the project in BuildingConnected:",
        "https://app.buildingconnected.com/opportunities/68d7e8f9a0b1c2d3e4f5a6b7",
        "",
        "Contact Alicia Nguyen: alicia.nguyen@swinerton.com",
      ].join("\r\n")
    ),
  },
  {
    name: TAG.headers,
    data: utf16(
      "Date: Mon, 13 Jul 2026 11:45:00 -0700\r\nMessage-ID: <msg-fixture-005@buildingconnected.com>\r\nFrom: Swinerton Builders via BuildingConnected <notifications@buildingconnected.com>\r\n"
    ),
  },
]);
fs.writeFileSync(path.join(outDir, "bc-invite.msg"), Buffer.from(bcInviteMsg));

// ── Fixture 2: body stored ONLY as compressed RTF (classic Outlook behavior) ──
const rtfBody = [
  "{\\rtf1\\ansi\\ansicpg1252\\deff0",
  "{\\fonttbl{\\f0 Arial;}}",
  "\\f0\\fs20 Marcus Webb with Hensel Phelps - Austin has invited you to bid on Lakeline Transit Center Expansion.\\par",
  "Project: Lakeline Transit Center Expansion\\par",
  "Client: Hensel Phelps - Austin\\par",
  "Location: 13701 Lyndhurst Blvd, Austin, TX 78717\\par",
  "Date Due: Aug 27, 2026\\par",
  "View the project: https://app.buildingconnected.com/opportunities/68e9f0a1b2c3d4e5f6a7b8c9\\par",
  "}",
].join("\r\n");
const bcInviteRtfMsg = buildMsg([
  { name: TAG.subject, data: utf16("Invitation to Bid: Lakeline Transit Center Expansion") },
  { name: TAG.senderName, data: utf16("Hensel Phelps via BuildingConnected") },
  { name: TAG.senderSmtp, data: utf16("notifications@buildingconnected.com") },
  { name: TAG.rtfCompressed, data: melaWrap(rtfBody) },
  {
    name: TAG.headers,
    data: utf16(
      "Date: Tue, 14 Jul 2026 09:20:00 -0500\r\nMessage-ID: <msg-fixture-006@buildingconnected.com>\r\nFrom: \"Hensel Phelps via BuildingConnected\" <notifications@buildingconnected.com>\r\n"
    ),
  },
]);
fs.writeFileSync(path.join(outDir, "bc-invite-rtf.msg"), Buffer.from(bcInviteRtfMsg));

console.log("Wrote bc-invite.msg and bc-invite-rtf.msg");
