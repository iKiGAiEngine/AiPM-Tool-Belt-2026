import OpenAI from "openai";

export interface ExtractedProjectDetails {
  projectName: string | null;
  dueDate: string | null;
  location: string | null;
  tradeName: string | null;
  inviteDate: string | null;
  expectedStart: string | null;
  expectedFinish: string | null;
  clientName: string | null;
  clientLocation: string | null;
  gcContactName: string | null;
  gcContactEmail: string | null;
  bcLink: string | null;
  rawText: string;
  extractionFailed?: boolean;
}

const EXTRACTION_PROMPT = `You are an expert construction project data extractor. Analyze this screenshot of a construction bid/project page (likely from BuildingConnected, Procore, PlanHub, or similar platform).

Extract the following fields. Return ONLY valid JSON, no prose, no markdown fences.

For each field, extract the EXACT value shown. If a field is not visible or cannot be determined, use null. Do NOT guess or infer values that are not clearly shown.

BUILDINGCONNECTED-SPECIFIC LABELS (these are the standard field names used on BuildingConnected):
- "Date Due" = the bid due date → maps to "dueDate"
- "Date Invite" = when the bid invitation was sent → maps to "inviteDate"
- "Expected Start" or "Est. Start" = anticipated construction start → maps to "expectedStart"
- "Expected Finish" or "Est. End" = anticipated construction end → maps to "expectedFinish"
- "Date Settled" = when bid was settled (ignore this field)

CRITICAL RULES:
- "dueDate" is the BID DUE DATE (when the bid/proposal must be submitted). Look for labels: "Due Date", "Bid Due", "Date Due", "Response Due", "Bid Date". This is NOT the project end date or completion date.
- "inviteDate" is when the invitation was sent. Look for labels: "Date Invite", "Invite Date", "Date Received", "Invited".
- "expectedStart" is the anticipated project START date. Look for labels: "Expected Start", "Est. Start", "Est Start", "Anticipated Start", "Start Date", "Scope Start", "Construction Start".
- "expectedFinish" is the anticipated project END/FINISH date. Look for labels: "Expected Finish", "Est. End", "Est End", "Est. Finish", "Expected End", "Anticipated Finish", "Completion Date", "Scope End". This is NOT the bid due date.
- IMPORTANT: Scan the ENTIRE screenshot for these date fields. They are often in a "Project Details" section on the left side of the page. Each date has its own row with a label and a value. Extract ALL dates you can find, even if a date seems wrong or contradictory (e.g., finish before start). Extract exactly what is shown.
- Do NOT confuse these dates with each other. Each date has a specific label on the page.
- Do NOT return null for a date field if the date is visible on the page. Always extract what is shown.
- For dates, return in YYYY-MM-DD format.
- "clientName" is the general contractor or client company name. Look for "Client", "Builder", "GC", "General Contractor". On BuildingConnected, this often appears near the top with a company icon. Extract ONLY the company name (e.g., "Swinerton Builders", "Turner Construction").
- "clientLocation" is the COMPLETE office/division designation shown after the company name. On BuildingConnected, the client field often shows "Company - Office" or "Company - Region - Division" (e.g., "Swinerton Builders - Portland", "Swinerton Builders - SoCal - Parking Structures", "Hensel Phelps - Dallas"). Extract EVERYTHING after the company name dash, preserving all parts including division names like "Parking Structures", "Special Projects", "Target Markets", "Facility Solutions". Do NOT strip division names — keep the full string (e.g., "SoCal - Parking Structures" not just "SoCal"). If the client shows as "Swinerton Builders - Parking Structures", extract "Parking Structures" as the clientLocation.
- "location" is the PROJECT location/address where the work will be done. Look for "Location", "Address", "Project Location", "City".
- "gcContactName" is the name of the contact person from the GC/client. On BuildingConnected, look in the "Team Summary" or contact section.
- "gcContactEmail" is their email address.
- "tradeName" is the trade/scope being bid. Look for "Trade Name", "Trade", "Scope", "CSI Division".
- "projectName" is the project name/title. Usually the largest or most prominent text at the top of the page.

CHECKLIST - Before returning, verify you checked for EACH of these fields in the Project Details section:
1. Date Due (dueDate)
2. Date Invite (inviteDate)
3. Expected Start (expectedStart)
4. Expected Finish (expectedFinish)
5. Project Name
6. Location
7. Client/GC name and location
8. GC Contact name and email
9. Trade Name
10. Any BuildingConnected URL visible in the browser address bar or page content (bcLink)

Response schema:
{
  "projectName": string | null,
  "dueDate": string | null,
  "location": string | null,
  "tradeName": string | null,
  "inviteDate": string | null,
  "expectedStart": string | null,
  "expectedFinish": string | null,
  "clientName": string | null,
  "clientLocation": string | null,
  "gcContactName": string | null,
  "gcContactEmail": string | null,
  "bcLink": string | null
}`;

export async function extractProjectDetailsFromScreenshot(
  imageBuffer: Buffer
): Promise<ExtractedProjectDetails> {
  const apiKey = process.env.OPENAI_API_KEY;

  let ocrText: string | null = null;
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    const { data } = await worker.recognize(imageBuffer);
    ocrText = data.text;
    await worker.terminate();
    console.log(`[ScreenshotExtractor] OCR captured ${ocrText.length} chars of text`);
  } catch (ocrErr: any) {
    console.warn("[ScreenshotExtractor] OCR text capture failed:", ocrErr.message);
  }

  if (apiKey && ocrText) {
    try {
      const result = await extractWithAIFromText(ocrText, apiKey);
      console.log("[ScreenshotExtractor] Hybrid extraction succeeded (OCR text + AI parsing)");
      return result;
    } catch (err: any) {
      console.warn("[ScreenshotExtractor] AI text parsing failed:", err.message);
    }
  }

  if (apiKey) {
    try {
      const result = await extractWithAIFromImage(imageBuffer, apiKey);
      if (!result.bcLink && ocrText) {
        result.bcLink = extractBcLink(ocrText) || null;
      }
      console.log("[ScreenshotExtractor] Vision extraction succeeded (image-only)");
      return result;
    } catch (err: any) {
      console.warn("[ScreenshotExtractor] AI vision extraction failed:", err.message);
    }
  }

  if (ocrText) {
    try {
      const result = extractFieldsFromOCRText(ocrText);
      console.log("[ScreenshotExtractor] Regex-only OCR extraction used");
      return result;
    } catch (err: any) {
      console.warn("[ScreenshotExtractor] OCR regex extraction failed:", err.message);
    }
  }

  console.error("[ScreenshotExtractor] All extraction methods failed");
  return {
    projectName: null,
    dueDate: null,
    location: null,
    tradeName: null,
    inviteDate: null,
    expectedStart: null,
    expectedFinish: null,
    clientName: null,
    clientLocation: null,
    gcContactName: null,
    gcContactEmail: null,
    bcLink: null,
    rawText: `[Extraction failed] No methods succeeded`,
    extractionFailed: true,
  };
}

const TEXT_PARSE_PROMPT = `You are an expert construction project data extractor. Below is OCR-extracted text from a screenshot of a construction bid/project page (likely BuildingConnected, Procore, or similar platform).

Parse the text and extract the following fields. Return ONLY valid JSON, no prose, no markdown fences.

BUILDINGCONNECTED FIELD LABELS (match these exactly in the OCR text):
- "Date Due" or "Due Date" → dueDate (the bid submission deadline)
- "Date Invite" or "Invite Date" → inviteDate (when invitation was sent)
- "Expected Start" or "Est. Start" or "Est Start" → expectedStart (construction start date)
- "Expected Finish" or "Est. End" or "Est End" or "Expected End" → expectedFinish (construction end date)
- Do NOT confuse "Date Settled" with any of the above dates.

RULES:
- Search the entire text for each labeled field. Dates typically appear on the same line or the line immediately after their label.
- For dates, convert to YYYY-MM-DD format. Handle formats like "Mar 16, 2026", "Feb 28, 2026 at 2:00 PM PST", "03/16/2026".
- Strip time/timezone from dates (e.g., "Mar 16, 2026 at 2:00 PM PST" → "2026-03-16").
- "clientName" is the general contractor (GC) company name only (e.g., "Swinerton Builders", "Turner Construction"). Look near labels like "Client", "GC", "General Contractor".
- "clientLocation" is the COMPLETE office/division designation shown LITERALLY after the company name dash in the client field. Extract EVERYTHING after the first dash — preserve all parts including division names like "Parking Structures", "Special Projects", "Target Markets", "Facility Solutions". Do NOT strip any part and do NOT infer from the project location/address. Examples: if client shows "Swinerton Builders - Parking Structures", return "Parking Structures"; if it shows "Swinerton Builders - SoCal - Parking Structures", return "SoCal - Parking Structures". NEVER use the project city or state as clientLocation.
- "location" is the project address/location where work is done (this is NOT the GC office).
- "gcContactName" and "gcContactEmail" are the GC contact person's name and email.
- "tradeName" is the trade/scope being bid.
- "projectName" is the project title, usually appearing near the top.
- Extract EVERY field you can find. Only use null if the field truly does not appear in the text.

Response schema:
{
  "projectName": string | null,
  "dueDate": string | null,
  "location": string | null,
  "tradeName": string | null,
  "inviteDate": string | null,
  "expectedStart": string | null,
  "expectedFinish": string | null,
  "clientName": string | null,
  "clientLocation": string | null,
  "gcContactName": string | null,
  "gcContactEmail": string | null
}`;

async function extractWithAIFromText(ocrText: string, apiKey: string): Promise<ExtractedProjectDetails> {
  const openai = new OpenAI({ apiKey });

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 1500,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `${TEXT_PARSE_PROMPT}\n\n--- OCR TEXT START ---\n${ocrText}\n--- OCR TEXT END ---`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content || "";
  console.log("[ScreenshotExtractor] AI text-parse response:", content.substring(0, 500));

  const parsed = parseJsonFromResponse(content);

  return {
    projectName: parsed.projectName || null,
    dueDate: normalizeDate(parsed.dueDate),
    location: parsed.location || null,
    tradeName: parsed.tradeName || null,
    inviteDate: normalizeDate(parsed.inviteDate),
    expectedStart: normalizeDate(parsed.expectedStart),
    expectedFinish: normalizeDate(parsed.expectedFinish),
    clientName: parsed.clientName || null,
    clientLocation: parsed.clientLocation || null,
    gcContactName: parsed.gcContactName || null,
    gcContactEmail: parsed.gcContactEmail || null,
    bcLink: extractBcLink(ocrText) || null,
    rawText: `[Hybrid: OCR + AI Text Parse]\n${content}`,
  };
}

async function extractWithAIFromImage(imageBuffer: Buffer, apiKey: string): Promise<ExtractedProjectDetails> {
  const openai = new OpenAI({ apiKey });

  const base64Image = imageBuffer.toString("base64");
  const mimeType = detectMimeType(imageBuffer);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACTION_PROMPT },
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
              detail: "high",
            },
          },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content || "";
  console.log("[ScreenshotExtractor] AI vision response:", content.substring(0, 500));

  const parsed = parseJsonFromResponse(content);

  return {
    projectName: parsed.projectName || null,
    dueDate: normalizeDate(parsed.dueDate),
    location: parsed.location || null,
    tradeName: parsed.tradeName || null,
    inviteDate: normalizeDate(parsed.inviteDate),
    expectedStart: normalizeDate(parsed.expectedStart),
    expectedFinish: normalizeDate(parsed.expectedFinish),
    clientName: parsed.clientName || null,
    clientLocation: parsed.clientLocation || null,
    gcContactName: parsed.gcContactName || null,
    gcContactEmail: parsed.gcContactEmail || null,
    bcLink: normalizeBcLink(parsed.bcLink) || null,
    rawText: `[AI Vision Extraction via GPT-4o]\n${content}`,
  };
}

function detectMimeType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "image/jpeg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return "image/gif";
  if (buffer.toString("utf8", 0, 4) === "RIFF") return "image/webp";
  return "image/png";
}

function parseJsonFromResponse(content: string): Record<string, any> {
  let cleaned = content.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    console.warn("[ScreenshotExtractor] Failed to parse AI JSON response");
    return {};
  }
}

function normalizeDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;

  const isoMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1]);
    const m = parseInt(isoMatch[2]);
    const d = parseInt(isoMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  const slashMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1]);
    const day = parseInt(slashMatch[2]);
    let year = parseInt(slashMatch[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9, sept: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };

  const namedMatch = dateStr.match(/(\w+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (namedMatch) {
    const monthKey = namedMatch[1].toLowerCase().replace(".", "");
    const m = months[monthKey];
    if (m) {
      const d = parseInt(namedMatch[2]);
      const y = parseInt(namedMatch[3]);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return null;
}

function extractFieldsFromOCRText(text: string): ExtractedProjectDetails {
  const projectName = extractProjectName(text);
  const dueDate = extractDueDate(text);
  const location = extractLocation(text);
  const tradeName = extractTradeName(text);
  const inviteDate = extractLabeledDate(text, ["Date\\s*Invite", "Invite\\s*Date", "Invited"]);
  const expectedStart = extractLabeledDate(text, ["Expected\\s*Start", "Est\\.?\\s*Start", "Anticipated\\s*Start", "Start\\s*Date"]);
  const expectedFinish = extractLabeledDate(text, ["Expected\\s*Finish", "Expected\\s*End", "Est\\.?\\s*End", "Est\\.?\\s*Finish", "Anticipated\\s*Finish", "Anticipated\\s*End", "End\\s*Date", "Completion\\s*Date"]);
  const { clientName, clientLocation, gcContactName, gcContactEmail } = extractClientInfo(text);

  const bcLink = extractBcLink(text);

  const result: ExtractedProjectDetails = {
    projectName,
    dueDate,
    location,
    tradeName,
    inviteDate,
    expectedStart,
    expectedFinish,
    clientName,
    clientLocation,
    gcContactName,
    gcContactEmail,
    bcLink,
    rawText: text,
  };

  return result;
}

function extractProjectName(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const namePatterns = [/Project\s*Name\s*[:\-]?\s*(.+)/i, /Project\s*Title\s*[:\-]?\s*(.+)/i];
  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match && match[1]?.trim()) {
      let name = match[1].trim().replace(/\s*[-–—]\s*\d+%.*$/, "").trim();
      if (name.length > 5) return name;
    }
  }
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const line = lines[i];
    if (line.length > 15 && line.length < 200 &&
      !line.match(/^(Overview|Files|Messages|Bid Form|Client|Vendors|Status|Links|Search|Accepted|Submitted|Won|Plan Room|Calendar|Leaderboard|Analytics|Reports|Settings|recently viewed)/i) &&
      !line.match(/^(Autodesk|BuildingConnected|Construction Cloud)/i) &&
      !line.match(/^\d+$/) && !line.match(/^[a-zA-Z0-9._%+-]+@/) && !line.match(/^https?:\/\//) &&
      (line.match(/\b(school|HS|high|elementary|middle|university|college|hospital|center|building|gym|gymnasium|library|remodel|renovation|construction|project|addition|phase|new|expansion|improvement|hall|tower|complex|facility|medical|office|residential|commercial|industrial|plaza|park|church|academy|institute|museum|arena|stadium|clinic|courthouse|fire\s*station|police)/i) ||
        (line.length > 20 && /^[A-Z]/.test(line) && !line.includes("@") && !line.includes("http")))
    ) {
      let name = line.replace(/\s*[-–—]\s*\d+%.*$/, "").replace(/\.\.\.$/, "").trim();
      if (name.length > 5) return name;
    }
  }
  return null;
}

function extractDueDate(text: string): string | null {
  const dueDatePatterns = [
    /(?:Date\s*Due|Due\s*Date|Bid\s*Due|Bid\s*Date|Response\s*Due)\s*[:\-]?\s*(\w+\.?\s+\d{1,2},?\s+\d{4})/i,
    /(?:Date\s*Due|Due\s*Date|Bid\s*Due|Bid\s*Date|Response\s*Due)\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  ];
  for (const pattern of dueDatePatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const parsed = parseDate(match[1].trim());
      if (parsed) return parsed;
    }
  }
  const nearDue = text.split("\n");
  for (let i = 0; i < nearDue.length; i++) {
    if (/due\s*date/i.test(nearDue[i])) {
      for (let j = i; j < Math.min(i + 3, nearDue.length); j++) {
        const dateMatch = nearDue[j].match(/(\w{3,9}\.?\s+\d{1,2},?\s+\d{4})/);
        if (dateMatch) { const parsed = parseDate(dateMatch[1]); if (parsed) return parsed; }
        const slashMatch = nearDue[j].match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
        if (slashMatch) { const parsed = parseDate(slashMatch[1]); if (parsed) return parsed; }
      }
    }
  }
  return null;
}

function extractLocation(text: string): string | null {
  const locationPatterns = [/Location\s*[:\-]?\s*(.+)/i, /Address\s*[:\-]?\s*(.+)/i, /Project\s*(?:Location|Address)\s*[:\-]?\s*(.+)/i];
  for (const pattern of locationPatterns) {
    const match = text.match(pattern);
    if (match && match[1]?.trim()) {
      let loc = match[1].trim().replace(/\s*(United States of America|United States|USA|US)\s*$/i, "").replace(/,\s*$/, "").trim();
      if (loc.length > 5) return loc;
    }
  }
  return null;
}

function extractTradeName(text: string): string | null {
  const tradePatterns = [/Trade\s*Name\s*\(?\s*s?\s*\)?\s*[:\-]?\s*(.+)/i, /Trade\s*[:\-]?\s*(.+)/i];
  for (const pattern of tradePatterns) {
    const match = text.match(pattern);
    if (match) {
      const trade = (match[1] || match[0]).trim();
      if (trade.length > 2 && trade.length < 100) return trade;
    }
  }
  return null;
}

function normalizeBcLink(link: string | null | undefined): string | null {
  if (!link) return null;
  let url = link.trim();
  if (!url) return null;
  if (url.includes('app.buildingconnected.com') && !url.startsWith('http')) {
    url = 'https://' + url.replace(/^\/\//, '');
  }
  if (/^https?:\/\/app\.buildingconnected\.com\//i.test(url)) return url;
  return null;
}

function extractBcLink(text: string): string | null {
  const bcPatternWithProtocol = /https?:\/\/app\.buildingconnected\.com\/[^\s"'<>)}\]]+/i;
  const match1 = text.match(bcPatternWithProtocol);
  if (match1) return match1[0].replace(/[.,;:]+$/, '');

  const bcPatternNoProtocol = /(?:^|[\s"'<>({\[])(?:www\.)?app\.buildingconnected\.com\/[^\s"'<>)}\]]+/im;
  const match2 = text.match(bcPatternNoProtocol);
  if (match2) {
    let url = match2[0].replace(/^[\s"'<>({\[]/, '').replace(/[.,;:]+$/, '');
    if (!url.startsWith('http')) url = 'https://' + url;
    return url;
  }
  return null;
}

function extractLabeledDate(text: string, labelPatterns: string[]): string | null {
  let labelFoundAnywhere = false;
  for (const labelPattern of labelPatterns) {
    if (new RegExp(labelPattern, "i").test(text)) { labelFoundAnywhere = true; break; }
  }
  if (!labelFoundAnywhere) return null;
  const lines = text.split("\n");
  for (const labelPattern of labelPatterns) {
    const inlinePatterns = [
      new RegExp(`${labelPattern}\\s*[:\\-]?\\s*(\\w+\\.?\\s+\\d{1,2},?\\s+\\d{4})`, "i"),
      new RegExp(`${labelPattern}\\s*[:\\-]?\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})`, "i"),
    ];
    for (const pattern of inlinePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) { const parsed = parseDate(match[1].trim()); if (parsed) return parsed; }
    }
    const labelRegex = new RegExp(labelPattern, "i");
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const dateMatch = lines[j].match(/(\w{3,9}\.?\s+\d{1,2},?\s+\d{4})/);
          if (dateMatch) { const parsed = parseDate(dateMatch[1]); if (parsed) return parsed; }
          const slashMatch = lines[j].match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
          if (slashMatch) { const parsed = parseDate(slashMatch[1]); if (parsed) return parsed; }
        }
      }
    }
  }
  return null;
}

function extractClientInfo(text: string): { clientName: string | null; clientLocation: string | null; gcContactName: string | null; gcContactEmail: string | null } {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const knownGCs = ["swinerton", "turner", "skanska", "hensel phelps", "dpr", "mccarthy", "webcor", "holder", "brasfield", "balfour beatty", "gilbane", "whiting-turner", "mortenson", "suffolk", "clark", "jacobs", "kiewit", "lendlease"];

  for (let i = 0; i < lines.length; i++) {
    if (/^Client\s*:?\s*$/i.test(lines[i])) {
      let fullClientText = "";
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const line = lines[j];
        if (line.length < 3 || /^(Bidding|Overview|Files|Messages|Vendors|Status)/i.test(line)) break;
        if (line.includes("@") || line.match(/^\+?\d[\d\s\-().]+$/)) continue;
        fullClientText += (fullClientText ? " " : "") + line;
      }
      if (fullClientText) {
        const dashMatch = fullClientText.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) return { clientName: dashMatch[1].trim(), clientLocation: dashMatch[2].trim(), gcContactName: null, gcContactEmail: null };
        if (fullClientText.length > 3) return { clientName: fullClientText, clientLocation: null, gcContactName: null, gcContactEmail: null };
      }
    }
    if (/\bClient\s*:\s*/i.test(lines[i])) {
      const afterLabel = lines[i].replace(/.*Client\s*:\s*/i, "").trim();
      if (afterLabel.length > 3) {
        const dashMatch = afterLabel.match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) return { clientName: dashMatch[1].trim(), clientLocation: dashMatch[2].trim(), gcContactName: null, gcContactEmail: null };
        return { clientName: afterLabel, clientLocation: null, gcContactName: null, gcContactEmail: null };
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    for (const gc of knownGCs) {
      if (lineLower.includes(gc)) {
        const dashMatch = lines[i].match(/^(.+?)\s*[-–—]\s*(.+)$/);
        if (dashMatch) return { clientName: dashMatch[1].trim(), clientLocation: dashMatch[2].trim(), gcContactName: null, gcContactEmail: null };
      }
    }
  }

  return { clientName: null, clientLocation: null, gcContactName: null, gcContactEmail: null };
}

function parseDate(dateStr: string): string | null {
  const months: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6,
    jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9, sept: 9,
    oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };
  const namedMatch = dateStr.match(/(\w+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (namedMatch) {
    const m = months[namedMatch[1].toLowerCase().replace(".", "")];
    if (m) {
      const d = parseInt(namedMatch[2]);
      const y = parseInt(namedMatch[3]);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  const slashMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1]);
    const d = parseInt(slashMatch[2]);
    let y = parseInt(slashMatch[3]);
    if (y < 100) y += 2000;
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}
