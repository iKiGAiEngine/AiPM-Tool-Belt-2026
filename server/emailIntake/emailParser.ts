import { simpleParser } from "mailparser";
import MsgReaderModule from "@kenjiuno/msgreader";
import { decompressRTF } from "@kenjiuno/decompressrtf";

// Interop: @kenjiuno/msgreader is CJS with a `default` export.
const MsgReader: any = (MsgReaderModule as any).default ?? MsgReaderModule;

export interface ParsedEmail {
  subject: string;
  fromName: string;
  fromEmail: string;
  /** ISO date string of when the email was sent, or null if unknown */
  date: string | null;
  /** Canonical plain text used for field extraction (HTML-stripped fallback) */
  text: string;
  html: string | null;
  messageId: string | null;
  /** All anchor hrefs found in the HTML body — BC links usually sit behind buttons */
  hrefs: string[];
  fileType: "eml" | "msg";
}

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Detect the email file type by content, never by mimetype — browsers report
 * .msg as application/octet-stream and .eml with a variety of types.
 * Known non-email magics return "unknown" so the caller can reject clearly.
 */
export function sniffEmailType(buf: Buffer): "eml" | "msg" | "unknown" {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(CFB_MAGIC)) return "msg";
  if (buf.length >= 4) {
    const head4 = buf.subarray(0, 4).toString("latin1");
    if (head4 === "%PDF") return "unknown";
    if (head4.startsWith("PK")) return "unknown"; // zip/docx/xlsx
    if (buf[0] === 0x89 && buf[1] === 0x50) return "unknown"; // png
    if (buf[0] === 0xff && buf[1] === 0xd8) return "unknown"; // jpeg
    if (head4 === "GIF8") return "unknown";
  }
  // RFC-822 messages are text that starts with headers ("Header-Name: value"
  // or a "From " mbox line). Check the first few lines.
  const headText = buf.subarray(0, 2048).toString("utf8");
  const lines = headText.split(/\r?\n/).slice(0, 10);
  const headerLike = /^[A-Za-z][A-Za-z0-9-]*:\s/;
  if (lines.some(l => headerLike.test(l)) || headText.startsWith("From ")) return "eml";
  return "unknown";
}

/** Strip HTML to readable text: drop style/script, convert breaks, decode common entities. */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|table|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  out = out
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  return out
    .split("\n")
    .map(l => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Pull every anchor href out of an HTML body. */
export function extractHrefs(html: string | null): string[] {
  if (!html) return [];
  const hrefs: string[] = [];
  const re = /href\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[1] || m[2] || "").trim();
    if (href && !href.startsWith("mailto:") && !href.startsWith("#")) hrefs.push(href);
  }
  return hrefs;
}

/**
 * De-encapsulate RTF to something readable. This is intentionally lossy —
 * the output feeds an LLM/regex extractor, not a renderer.
 */
export function rtfToText(rtf: string): string {
  let out = rtf;
  // Drop ignorable destination groups ({\*\htmltag ...} content is kept below via htmltag handling)
  out = out.replace(/\{\\\*\\(?:fonttbl|colortbl|stylesheet|generator|themedata|colorschememapping|datastore|listtable|listoverridetable|info)[^{}]*(?:\{[^{}]*\})*[^{}]*\}/gi, " ");
  // \'hh hex escapes → char
  out = out.replace(/\\'([0-9a-fA-F]{2})/g, (_, hh) => {
    const code = parseInt(hh, 16);
    return code >= 32 ? String.fromCharCode(code) : " ";
  });
  // Line-break control words
  out = out.replace(/\\(par|line|pard)\b/g, "\n");
  out = out.replace(/\\tab\b/g, " ");
  // Remaining control words and control symbols
  out = out.replace(/\\[a-zA-Z]+-?\d*\s?/g, " ");
  out = out.replace(/\\[^a-zA-Z]/g, " ");
  // Braces
  out = out.replace(/[{}]/g, " ");
  return out
    .split("\n")
    .map(l => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function parseDateToIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extract a header value from a raw RFC-822 transport header block. */
function headerValue(headers: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = headers.match(re);
  return m ? m[1].trim() : null;
}

async function parseEml(buf: Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(buf);
  const from = parsed.from?.value?.[0];
  const html = typeof parsed.html === "string" && parsed.html ? parsed.html : null;
  const text = (parsed.text || "").trim() || (html ? htmlToText(html) : "");
  return {
    subject: parsed.subject || "",
    fromName: from?.name || "",
    fromEmail: from?.address || "",
    date: parseDateToIso(parsed.date),
    text,
    html,
    messageId: parsed.messageId || null,
    hrefs: extractHrefs(html),
    fileType: "eml",
  };
}

function parseMsg(buf: Buffer): ParsedEmail {
  // MsgReader wants a Uint8Array/ArrayBuffer view
  const reader = new MsgReader(new Uint8Array(buf));
  const data = reader.getFileData();
  if (!data || data.dataType !== "msg") {
    throw new Error("File is not a valid Outlook .msg message");
  }

  // Body resolution order: plain text → HTML string → PidTagHtml bytes → compressed RTF
  let html: string | null = null;
  if (typeof data.bodyHtml === "string" && data.bodyHtml.trim()) {
    html = data.bodyHtml;
  } else if (data.html instanceof Uint8Array && data.html.length > 0) {
    html = Buffer.from(data.html).toString("utf8");
  }

  let text = (data.body || "").trim();
  if (!text && html) text = htmlToText(html);
  if (!text && data.compressedRtf instanceof Uint8Array && data.compressedRtf.length > 0) {
    try {
      const rtfBytes = decompressRTF(Array.from(data.compressedRtf));
      const rtf = Buffer.from(rtfBytes as number[]).toString("latin1");
      text = rtfToText(rtf);
      // HTML-encapsulated RTF carries the original hrefs inside — keep them findable
      if (!html && /\\fromhtml/i.test(rtf)) html = rtf;
    } catch (err: any) {
      console.warn("[EmailIntake] compressed RTF decode failed:", err.message);
    }
  }

  const headers = typeof data.headers === "string" ? data.headers : "";
  const date =
    parseDateToIso(headers ? headerValue(headers, "Date") : null) ||
    parseDateToIso(data.messageDeliveryTime) ||
    parseDateToIso(data.clientSubmitTime) ||
    parseDateToIso(data.creationTime);
  const messageId = headers ? headerValue(headers, "Message-ID") : null;

  // Sender: prefer SMTP address props; transport headers From: as fallback
  let fromEmail = data.senderEmail || "";
  let fromName = data.senderName || "";
  if ((!fromEmail || !fromEmail.includes("@")) && headers) {
    const fromHeader = headerValue(headers, "From");
    if (fromHeader) {
      const m = fromHeader.match(/^(?:"?([^"<]*)"?\s*)?<([^>]+)>/) || fromHeader.match(/([^\s<>]+@[^\s<>]+)/);
      if (m) {
        if (m.length >= 3) { fromName = fromName || (m[1] || "").trim(); fromEmail = m[2]; }
        else fromEmail = m[1];
      }
    }
  }

  const hrefs = extractHrefs(html);

  return {
    subject: data.subject || "",
    fromName,
    fromEmail,
    date,
    text,
    html,
    messageId,
    hrefs,
    fileType: "msg",
  };
}

/**
 * Parse a dropped email file (.eml or .msg) into a normalized ParsedEmail.
 * Throws with a user-readable message when the file is not a parseable email.
 */
export async function parseEmailFile(buf: Buffer, fileName: string): Promise<ParsedEmail> {
  if (!buf || buf.length === 0) {
    throw new Error("File is empty");
  }
  const sniffed = sniffEmailType(buf);
  const ext = (fileName.split(".").pop() || "").toLowerCase();

  if (sniffed === "msg" || (sniffed === "unknown" && ext === "msg")) {
    return parseMsg(buf);
  }
  if (sniffed === "eml" || ext === "eml") {
    const parsed = await parseEml(buf);
    if (!parsed.subject && !parsed.fromEmail && !parsed.text) {
      throw new Error("File does not look like an email (.eml) — no headers or content found");
    }
    return parsed;
  }
  throw new Error("Not an email file — drop a .eml or .msg file (save the email from Outlook first)");
}
