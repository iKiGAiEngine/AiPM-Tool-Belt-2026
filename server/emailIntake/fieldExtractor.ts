import OpenAI from "openai";
import {
  type ExtractedProjectDetails,
  parseJsonFromResponse,
  normalizeDate,
  extractFieldsFromOCRText,
  stripCountrySuffix,
} from "../screenshotExtractor";
import type { ParsedEmail } from "./emailParser";

export type ExtractionTier = "llm" | "regex" | "floor";

export interface EmailExtractionResult {
  fields: ExtractedProjectDetails;
  tier: ExtractionTier;
  /** Fields that were filled from the envelope floor rather than the winning tier */
  floorBackfilled: string[];
}

/** True when the sender is a bid platform's no-reply address, not a person. */
export function isPlatformSender(fromEmail: string): boolean {
  return /buildingconnected\.com|autodesk\.com|procore\.com|planhub\.com|no-?reply|donotreply/i.test(fromEmail || "");
}

const EMAIL_PARSE_PROMPT = `You are an expert construction bid-invitation data extractor. Below is the text of an email a subcontractor received — either a BuildingConnected bid invitation, a forwarded copy of one, or a direct invitation from a general contractor (GC).

Parse the email and extract the following fields. Return ONLY valid JSON, no prose, no markdown fences.

BUILDINGCONNECTED INVITE EMAILS typically say "<Contact Name> with <GC Company> has invited you to bid on <Project Name>" (newer templates say "<Contact Name> from <GC Company> has invited you...") and list labeled rows such as:
- "Project" → projectName
- "Client" → the GC company, often "Company - Office" (e.g. "Swinerton Builders - Dallas")
- "Location" or "Project location" → location (the PROJECT address, not the GC office)
- "Trade" or "Trade Name" → tradeName
- "Bid due" / "Date Due" / "Due Date" → dueDate (the bid submission deadline)
- "Date Invite" / "Invited" → inviteDate (when the invitation was sent)
- "Expected Start" / "Est. Start" → expectedStart (construction start)
- "Expected Finish" / "Est. End" → expectedFinish (construction end)
- "Project Size" / "Square Feet" / "Sq. Ft." → squareFeet (the project's size, exactly as shown, e.g. "7,191 sq. ft.")
- "Job Walk" / "Site Visit" / "Walkthrough" is a SEPARATE row from "Expected Start" — it is a walkthrough appointment date, not the construction start. NEVER use a Job Walk / Site Visit / Walkthrough date to fill expectedStart or expectedFinish, even if the Expected Start row is blank or shows "--". In that case return null for expectedStart rather than substituting a different date. The same applies to "RFIs Due" — never map it to expectedStart/expectedFinish either.
- Some newer BuildingConnected templates have NO "Company - Office" dash format at all — instead a "Client Details" section shows just the company name (e.g. "Swinerton Builders") followed by its own street address (e.g. "6890 West 52nd Avenue, Arvada, CO 80002"). When that's all you have, set clientLocation to that address's CITY and STATE (e.g. "Arvada, CO") — this is the only office signal available and is far better than leaving clientLocation null. Do not confuse this company address with the PROJECT location.

FORWARDED EMAILS: If the email contains a forwarded message (markers like "---------- Forwarded message ----------", "-----Original Message-----", or a quoted "From: ... Sent: ... Subject: ..." block), extract from the INNERMOST original invitation. The forwarding wrapper's sender is NOT the GC contact. The original sender line (e.g. "From: Turner Construction via BuildingConnected") identifies the platform, not the contact person.

GC-DIRECT INVITES (no BuildingConnected): the GC's estimator writes personally. Then:
- clientName = the GC company they represent (from the body or signature)
- gcContactName / gcContactEmail = the writer (from the body or signature)
- projectName / location / dueDate from the body text.

RULES:
- For dates, convert to YYYY-MM-DD. Handle "Aug 14, 2026 at 2:00 PM CDT", "07/30/2026", "July 30th, 2026" — strip times and timezones.
- "clientName" is the GC company name ONLY (e.g. "Swinerton Builders", "Turner Construction Company").
- "clientLocation" is the office/division designation after the company name dash, kept COMPLETE (e.g. "Dallas", "SoCal - Parking Structures"). If there's no dash format, fall back to the GC company's own office city/state from its address in the "Client Details" section (see above). NEVER use the project city/state as clientLocation.
- "gcContactName"/"gcContactEmail" = the person at the GC to respond to (invite sender, "Contact X:" line, or signature).
- Do NOT invent values. Use null for anything not clearly present in the email.
- Ignore unsubscribe footers, legal disclaimers, and email signatures except as a source of contact info.

Response schema:
{
  "projectName": string | null,
  "dueDate": string | null,
  "location": string | null,
  "tradeName": string | null,
  "inviteDate": string | null,
  "expectedStart": string | null,
  "expectedFinish": string | null,
  "squareFeet": string | null,
  "clientName": string | null,
  "clientLocation": string | null,
  "gcContactName": string | null,
  "gcContactEmail": string | null
}`;

/** Strip forward/reply prefixes and bid-invite boilerplate from an email subject. */
export function cleanSubjectToProjectName(subject: string): string {
  let s = (subject || "").trim();
  // Repeated FW:/RE:/Fwd: prefixes
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^(fw|fwd|re)\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  s = s
    .replace(/^invitation to bid\s*[:\-–—]\s*/i, "")
    .replace(/^bid invitation\s*[:\-–—]\s*/i, "")
    .replace(/^request for proposal\s*[:\-–—]\s*/i, "")
    .replace(/^rfp\s*[:\-–—]\s*/i, "")
    .replace(/^invitation to bid on\s+/i, "")
    .replace(/^you've been invited to bid on\s+/i, "")
    .replace(/^invited to bid\s*[:\-–—]\s*/i, "")
    .trim();
  return s;
}

/**
 * Deterministic extraction of the labeled rows BuildingConnected invite emails
 * carry ("Project:", "Client:", "Date Due:", …) plus the invite sentence
 * ("<Name> with <Company> has invited you to bid on <Project>").
 * High precision, zero cost — used to harden/backfill the LLM tier and as the
 * primary regex tier for BC-style bodies.
 */
export function extractLabeledEmailFields(text: string): Partial<ExtractedProjectDetails> {
  const out: Partial<ExtractedProjectDetails> = {};
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const labelValue = (line: string, labels: RegExp): string | null => {
    const m = line.match(labels);
    return m ? (m[1] || "").trim() : null;
  };

  for (const line of lines) {
    if (out.projectName === undefined) {
      const v = labelValue(line, /^Project(?:\s*Name)?\s*[:\-–—]\s*(.+)$/i);
      if (v) out.projectName = v;
    }
    if (out.clientName === undefined) {
      const v = labelValue(line, /^Client\s*[:\-–—]\s*(.+)$/i);
      if (v) {
        const dash = v.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dash) {
          out.clientName = dash[1].trim();
          out.clientLocation = dash[2].trim();
        } else {
          out.clientName = v;
        }
      }
    }
    if (out.location === undefined) {
      const v = labelValue(line, /^(?:Project\s*)?(?:Location|Address)\s*[:\-–—]\s*(.+)$/i);
      const stripped = stripCountrySuffix(v);
      if (stripped) out.location = stripped;
    }
    if (out.tradeName === undefined) {
      const v = labelValue(line, /^Trade(?:\s*Name)?(?:\s*\(s\))?\s*[:\-–—]\s*(.+)$/i);
      if (v) out.tradeName = v;
    }
    if (out.dueDate === undefined) {
      const v = labelValue(line, /^(?:Date\s*Due|Due\s*Date|Bids?\s*due|Response\s*Due|Proposals?\s*Due)\s*[:\-–—]?\s*(.+)$/i);
      if (v) { const d = normalizeDate(v); if (d) out.dueDate = d; }
    }
    if (out.inviteDate === undefined) {
      const v = labelValue(line, /^(?:Date\s*Invite|Invite\s*Date|Invited)\s*[:\-–—]?\s*(.+)$/i);
      if (v) { const d = normalizeDate(v); if (d) out.inviteDate = d; }
    }
    if (out.expectedStart === undefined) {
      const v = labelValue(line, /^(?:Expected|Est\.?|Anticipated)\s*Start\s*[:\-–—]?\s*(.+)$/i);
      if (v) { const d = normalizeDate(v); if (d) out.expectedStart = d; }
    }
    if (out.expectedFinish === undefined) {
      const v = labelValue(line, /^(?:Expected|Est\.?|Anticipated)\s*(?:Finish|End|Completion)\s*[:\-–—]?\s*(.+)$/i);
      if (v) { const d = normalizeDate(v); if (d) out.expectedFinish = d; }
    }
    if (out.squareFeet === undefined) {
      const v = labelValue(line, /^(?:Project\s*Size|Square\s*Feet|Square\s*Footage|Sq\.?\s*Ft\.?|Building\s*Size)\s*[:\-–—]?\s*(.+)$/i);
      if (v) out.squareFeet = v;
    }
    if (out.gcContactName === undefined || out.gcContactEmail === undefined) {
      const m = line.match(/^Contact\s+([^:]{2,60})\s*[:\-–—]\s*([^\s@]+@[^\s@]+\.[^\s@]+)\s*$/i);
      if (m) {
        out.gcContactName = out.gcContactName ?? m[1].trim();
        out.gcContactEmail = out.gcContactEmail ?? m[2].trim();
      }
    }
  }

  // Invite sentence: "<Name> with <Company> has invited you to bid on <Project>."
  // Newer BC templates phrase this as "<Name> from <Company> has invited..." —
  // accept either preposition.
  const sentence = text.match(/([A-Z][\w.'-]+(?:\s+[\w.'-]+){0,4}?)\s+(?:with|from)\s+(.{2,80}?)\s+has invited you to bid on\s+(.+?)\.?\s*(?:\r?\n|$)/i);
  if (sentence) {
    out.gcContactName = out.gcContactName ?? sentence[1].trim();
    const company = sentence[2].trim();
    if (out.clientName === undefined) {
      const dash = company.match(/^(.+?)\s*[-–—]\s*(.+)$/);
      if (dash) {
        out.clientName = dash[1].trim();
        out.clientLocation = out.clientLocation ?? dash[2].trim();
      } else {
        out.clientName = company;
      }
    }
    out.projectName = out.projectName ?? sentence[3].trim();
  }

  // Newer BC templates drop the "Company - Office" dash format entirely —
  // the "Client Details" section just shows the company name followed by its
  // own street address (e.g. "Swinerton Builders" / "6890 West 52nd Avenue,
  // Arvada, CO 80002"). That address is the only office signal available in
  // this template, so fall back to its city/state as the office designation
  // when nothing above produced a clientLocation.
  if (out.clientLocation === undefined) {
    const clientDetailsIdx = text.search(/Client\s*Details/i);
    if (clientDetailsIdx !== -1) {
      const window = text.slice(clientDetailsIdx, clientDetailsIdx + 800);
      const addrMatch = window.match(/,\s*([A-Za-z][A-Za-z .'-]+),\s*([A-Z]{2})\s+\d{5}/);
      if (addrMatch) {
        out.clientLocation = `${addrMatch[1].trim()}, ${addrMatch[2].trim()}`;
      }
    }
  }

  return out;
}

function emptyFields(rawText: string): ExtractedProjectDetails {
  return {
    projectName: null,
    dueDate: null,
    location: null,
    tradeName: null,
    inviteDate: null,
    expectedStart: null,
    expectedFinish: null,
    squareFeet: null,
    clientName: null,
    clientLocation: null,
    gcContactName: null,
    gcContactEmail: null,
    bcLink: null,
    rawText,
  };
}

/** Tier 3 floor: minimal fields from the envelope. Never returns an empty draft. */
export function floorExtraction(email: ParsedEmail): ExtractedProjectDetails {
  const fields = emptyFields("[Floor extraction: subject/sender only]");
  const name = cleanSubjectToProjectName(email.subject);
  fields.projectName = name || email.subject || null;
  // A platform no-reply sender is not a GC contact — leave contact blank rather than wrong
  if (!isPlatformSender(email.fromEmail)) {
    fields.gcContactEmail = email.fromEmail || null;
    fields.gcContactName = email.fromName || null;
  }
  fields.inviteDate = email.date ? email.date.split("T")[0] : null;
  return fields;
}

async function extractWithLLM(emailText: string, subject: string, apiKey: string): Promise<ExtractedProjectDetails> {
  const openai = new OpenAI({ apiKey });
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1500,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `${EMAIL_PARSE_PROMPT}\n\n--- EMAIL SUBJECT ---\n${subject}\n--- EMAIL BODY START ---\n${emailText.slice(0, 24000)}\n--- EMAIL BODY END ---`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content || "";
  console.log("[EmailIntake] LLM extraction response:", content.substring(0, 400));
  const parsed = parseJsonFromResponse(content);
  if (Object.keys(parsed).length === 0) {
    throw new Error("LLM returned unparseable JSON");
  }

  return {
    projectName: parsed.projectName || null,
    dueDate: normalizeDate(parsed.dueDate),
    location: stripCountrySuffix(parsed.location),
    tradeName: parsed.tradeName || null,
    inviteDate: normalizeDate(parsed.inviteDate),
    expectedStart: normalizeDate(parsed.expectedStart),
    expectedFinish: normalizeDate(parsed.expectedFinish),
    squareFeet: parsed.squareFeet || null,
    clientName: parsed.clientName || null,
    clientLocation: parsed.clientLocation || null,
    gcContactName: parsed.gcContactName || null,
    gcContactEmail: parsed.gcContactEmail || null,
    bcLink: null,
    rawText: `[Email LLM extraction]\n${content}`,
  };
}

/**
 * Extract bid fields from a parsed email. Tiered so it NEVER throws:
 *   1. LLM parse (gpt-4o-mini) of the email body
 *   2. Label-regex extraction (same code path as screenshot OCR text)
 *   3. Floor: subject/sender/date only
 * Missing fields in a higher tier are backfilled from the floor so a draft
 * always has at least a project name and contact.
 */
export async function extractFieldsFromEmail(email: ParsedEmail): Promise<EmailExtractionResult> {
  const floor = floorExtraction(email);
  const apiKey = process.env.OPENAI_API_KEY;

  let fields: ExtractedProjectDetails | null = null;
  let tier: ExtractionTier = "floor";

  if (apiKey && email.text.trim()) {
    try {
      fields = await extractWithLLM(email.text, email.subject, apiKey);
      tier = "llm";
    } catch (err: any) {
      console.warn("[EmailIntake] LLM extraction failed, falling back to regex:", err.message);
    }
  }

  // Deterministic labeled-line extraction — used to harden the LLM tier and
  // as the primary regex tier for BC-style bodies.
  let labeled: Partial<ExtractedProjectDetails> = {};
  try {
    labeled = extractLabeledEmailFields(email.text);
  } catch (err: any) {
    console.warn("[EmailIntake] Labeled extraction failed:", err.message);
  }

  if (fields) {
    // Backfill anything the LLM missed with deterministic labeled values
    for (const [key, value] of Object.entries(labeled)) {
      if (value && !(fields as any)[key]) (fields as any)[key] = value;
    }
  }

  if (!fields && email.text.trim()) {
    try {
      const regexFields = extractFieldsFromOCRText(email.text);
      // Labeled values are higher precision than the OCR-text heuristics
      for (const [key, value] of Object.entries(labeled)) {
        if (value) (regexFields as any)[key] = value;
      }
      // The OCR first-lines heuristic was tuned for screenshots and happily
      // grabs body sentences from emails. Unless a labeled row / invite
      // sentence named the project, the cleaned subject is the stronger signal.
      if (!labeled.projectName) {
        regexFields.projectName = floor.projectName || regexFields.projectName;
      }
      // The regex tier only counts when it genuinely read the body — a
      // subject-derived name alone stays "floor" so the UI keeps its
      // "minimal extraction — verify" flag.
      const labeledCount = Object.values(labeled).filter(Boolean).length;
      const otherHits = [regexFields.dueDate, regexFields.clientName, regexFields.location, regexFields.tradeName].filter(Boolean).length;
      if (labeledCount > 0 || otherHits > 0) {
        fields = regexFields;
        tier = "regex";
      }
    } catch (err: any) {
      console.warn("[EmailIntake] Regex extraction failed, using floor:", err.message);
    }
  }

  if (!fields) {
    const allFloorFields = Object.entries(floor)
      .filter(([k, v]) => k !== "rawText" && v != null)
      .map(([k]) => k);
    return { fields: floor, tier: "floor", floorBackfilled: allFloorFields };
  }

  // Backfill gaps from the floor — the envelope is always trustworthy
  const floorBackfilled: string[] = [];
  for (const key of ["projectName", "gcContactEmail", "gcContactName", "inviteDate"] as const) {
    if (!fields[key] && floor[key]) {
      fields[key] = floor[key];
      floorBackfilled.push(key);
    }
  }

  return { fields, tier, floorBackfilled };
}
