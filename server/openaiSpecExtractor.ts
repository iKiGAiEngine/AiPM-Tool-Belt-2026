import OpenAI from "openai";
import { instrumentOpenAI } from "./aiUsage";
import { z } from "zod";
import { getActiveConfiguration, clearConfigCache } from "./configService";
import type { SpecsiftConfig, AccessoryScopeData } from "@shared/schema";

const openai = instrumentOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), "spec-extractor");

const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TOKENS = 4096;
const PAGES_PER_BATCH = 15;

const EQUIPMENT_REF_RE = /10\s*\d{4}-\d+/;

const END_MARKERS = [
  "end of section", "end of spec", "end section",
  "end of specification", "— end —", "- end -",
  "end div", "section end",
];

const CONTENT_MARKERS_TO_STRIP = [
  "GENERAL", "SUMMARY", "PRODUCTS", "EXECUTION", "REQUIREMENTS",
  "SUBMITTALS", "QUALITY ASSURANCE", "DELIVERY", "WARRANTY",
];

const SectionIdentSchema = z.object({
  sectionNumber: z.string(),
  title: z.string(),
  startPage: z.number(),
  endPage: z.number(),
});

const IdentResponseSchema = z.object({
  sections: z.array(SectionIdentSchema),
});

const SectionDetailSchema = z.object({
  manufacturers: z.array(z.string()).default([]),
  modelNumbers: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export interface AIIdentifiedSection {
  sectionNumber: string;
  title: string;
  startPage: number;
  endPage: number;
}

export interface AISectionDetails {
  manufacturers: string[];
  modelNumbers: string[];
  materials: string[];
  conflicts: string[];
  notes: string[];
}

export interface AISpecResult {
  sections: AIIdentifiedSection[];
  modelUsed: string;
}

interface PreScanHeader {
  sectionNumber: string;
  title: string;
  page: number;
  confidence: "high" | "medium" | "low";
}

interface TOCBounds {
  start: number;
  end: number;
}

function canonizeSection(raw: string): string {
  const original = raw.trim();

  if (EQUIPMENT_REF_RE.test(original)) {
    return original;
  }

  const digits = original.replace(/[^\d]/g, "");

  if (digits.length >= 6 && digits.startsWith("10")) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 6)}`;
  }
  if (digits.length === 4 && digits.startsWith("10")) {
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} 00`;
  }
  return original;
}

function cleanSectionTitle(title: string): string {
  let cleaned = title.trim();

  cleaned = cleaned.replace(/\s*SECTION\s+\d+.*$/i, "");
  cleaned = cleaned.replace(/\s*PART\s+\d+.*$/i, "");

  for (const marker of CONTENT_MARKERS_TO_STRIP) {
    cleaned = cleaned.replace(new RegExp(`\\s+${marker}.*$`, "i"), "");
  }

  cleaned = cleaned.replace(/[\-–—:]+\s*$/, "").trim();
  cleaned = cleaned.replace(/\s{2,}/g, " ");

  return cleaned;
}

function isPageTOCLike(pageText: string): boolean {
  const lines = pageText.split(/[\n\r]+/);

  let dotLeaderCount = 0;
  let sectionListingCount = 0;

  for (const line of lines) {
    if (/\.{3,}/.test(line)) {
      dotLeaderCount++;
    }
    if (/(?:SECTION|DIVISION)\s+\d+.*\d+\s*$/i.test(line)) {
      sectionListingCount++;
    }
  }

  if (dotLeaderCount >= 3) return true;
  if (sectionListingCount >= 3) return true;

  return false;
}

function detectTOCBounds(pages: string[]): TOCBounds {
  let tocStart = -1;
  let tocEnd = -1;

  const scanLimit = Math.min(100, pages.length);

  for (let i = 0; i < scanLimit; i++) {
    const pageUpper = pages[i].toUpperCase();
    if (/TABLE\s+OF\s+CONTENTS/i.test(pages[i]) ||
        /^CONTENTS\s*$/im.test(pages[i]) ||
        /SPECIFICATION\s+INDEX/i.test(pages[i]) ||
        /SPECIFICATIONS?\s+TABLE\s+OF\s+CONTENTS/i.test(pages[i]) ||
        /INDEX\s+OF\s+SPECIFICATIONS/i.test(pages[i])) {
      tocStart = i;
      console.log(`[TOC] Found TOC label on page ${i + 1}`);
      break;
    }
  }

  if (tocStart < 0) {
    for (let i = 0; i < Math.min(50, pages.length); i++) {
      if (isPageTOCLike(pages[i])) {
        tocStart = i;
        console.log(`[TOC] Detected TOC-like page ${i + 1} via dot-leaders/listings`);
        break;
      }
    }
  }

  if (tocStart < 0) {
    console.log(`[TOC] No Table of Contents detected`);
    return { start: -1, end: -1 };
  }

  let lastTocPage = tocStart;
  for (let i = tocStart; i < Math.min(tocStart + 50, pages.length); i++) {
    if (isPageTOCLike(pages[i])) {
      lastTocPage = i;
    } else if (i > tocStart + 1) {
      break;
    }
  }

  tocEnd = lastTocPage;
  console.log(`[TOC] TOC detected: pages ${tocStart + 1} to ${tocEnd + 1}`);
  return { start: tocStart, end: tocEnd };
}

function countUniqueDiv10SectionsOnPage(pageText: string): number {
  const secNumberRe = /\b10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6})\b/g;
  const uniqueSections = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = secNumberRe.exec(pageText)) !== null) {
    const canon = canonizeSection(match[0]);
    if (canon.startsWith("10 ") && !EQUIPMENT_REF_RE.test(match[0])) {
      uniqueSections.add(canon);
    }
  }
  return uniqueSections.size;
}

function isExcludedPage(pageIdx: number, tocBounds: TOCBounds, pageText: string): string | null {
  if (tocBounds.end >= 0 && pageIdx <= tocBounds.end) {
    return "TOC page";
  }

  if (isPageTOCLike(pageText)) {
    return "TOC-like (dot leaders/section listings)";
  }

  return null;
}

function isIndexLikePage(pageText: string): boolean {
  const uniqueCount = countUniqueDiv10SectionsOnPage(pageText);
  if (uniqueCount > 2 && isPageTOCLike(pageText)) {
    return true;
  }
  if (uniqueCount >= 5) {
    return true;
  }
  return false;
}

function findDiv10Headers(pages: string[], tocBounds: TOCBounds): PreScanHeader[] {
  const headers: PreScanHeader[] = [];
  const excludedPages = new Set<number>();

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const exclusion = isExcludedPage(pageIdx, tocBounds, pages[pageIdx]);
    if (exclusion) {
      excludedPages.add(pageIdx);
      console.log(`[PreScan] SKIP page ${pageIdx + 1}: ${exclusion}`);
      continue;
    }
    if (isIndexLikePage(pages[pageIdx])) {
      excludedPages.add(pageIdx);
      console.log(`[PreScan] SKIP page ${pageIdx + 1}: index-like (many section numbers)`);
      continue;
    }
  }

  const HDR_PATTERNS = [
    /(?:SECTION|SPEC(?:IFICATION)?)\s+(10[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)\s*[\-–—:]+\s*([A-Za-z][A-Za-z\s,&\/\-]+)/i,
    /(?:SECTION|SPEC(?:IFICATION)?)\s+(10[\s\-\._]*\d{4,6})\s*[\-–—:]+\s*([A-Za-z][A-Za-z\s,&\/\-]+)/i,
    /(?:SECTION|SPEC(?:IFICATION)?)\s+(10[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)\s+([A-Z][A-Z\s,&\/\-]{5,})/i,
    /(?:SECTION|SPEC(?:IFICATION)?)\s+(10[\s\-\._]*\d{4,6})\s+([A-Z][A-Z\s,&\/\-]{5,})/i,
    /^(10[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)\s*[\-–—:]+\s*([A-Za-z][A-Za-z\s,&\/\-]+)/im,
    /^(10[\s\-\._]*\d{4,6})\s*[\-–—:]+\s*([A-Za-z][A-Za-z\s,&\/\-]+)/im,
  ];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    if (excludedPages.has(pageIdx)) continue;

    const text = pages[pageIdx];
    const lines = text.split("\n");
    const topZone = lines.slice(0, 20).join("\n");

    let foundOnPage = false;

    for (const pattern of HDR_PATTERNS) {
      const match = topZone.match(pattern);
      if (match) {
        const rawNum = match[1];
        const rawTitle = match[2];
        const canon = canonizeSection(rawNum);

        if (!canon.startsWith("10 ")) continue;
        if (EQUIPMENT_REF_RE.test(rawNum)) continue;
        if (headers.some(h => h.sectionNumber === canon)) continue;

        const cleaned = cleanSectionTitle(rawTitle);
        if (cleaned.length < 3) continue;

        console.log(`[PreScan] FOUND header: ${canon} - "${cleaned}" on page ${pageIdx + 1} (pattern match)`);
        headers.push({
          sectionNumber: canon,
          title: cleaned,
          page: pageIdx,
          confidence: "high",
        });
        foundOnPage = true;
        break;
      }
    }

    if (!foundOnPage) {
      for (let li = 0; li < Math.min(20, lines.length); li++) {
        const line = lines[li].trim();

        const secMatch = line.match(/(?:SECTION\s+)?(10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\b/i);
        if (secMatch) {
          const rawNum = secMatch[1];
          const canon = canonizeSection(rawNum);
          if (!canon.startsWith("10 ") || EQUIPMENT_REF_RE.test(rawNum)) continue;
          if (headers.some(h => h.sectionNumber === canon)) continue;

          let title = "";
          const afterNum = line.substring(line.indexOf(rawNum) + rawNum.length).replace(/^[\s\-–—:]+/, "").trim();
          if (afterNum.length >= 5 && /^[A-Za-z]/.test(afterNum)) {
            title = cleanSectionTitle(afterNum);
          } else if (li + 1 < lines.length) {
            const nextLine = lines[li + 1].trim();
            if (/^[A-Z][A-Za-z\s,&\/\-]+/.test(nextLine) && nextLine.length >= 5 && nextLine.length < 100) {
              title = cleanSectionTitle(nextLine);
            }
          }

          if (title.length < 3) continue;

          console.log(`[PreScan] FOUND header: ${canon} - "${title}" on page ${pageIdx + 1} (line scan)`);
          headers.push({ sectionNumber: canon, title, page: pageIdx, confidence: "medium" });
          foundOnPage = true;
          break;
        }
      }
    }

    if (!foundOnPage && /PART\s*1\s*[\-–—:]?\s*GENERAL/i.test(text)) {
      const secPatterns = [
        /\b(10\s+\d{2}\s+\d{2})\b/g,
        /\b(10[\-\._]\d{2}[\-\._]\d{2})\b/g,
        /\b(10\d{4})\b/g,
      ];

      for (const secPattern of secPatterns) {
        let match;
        while ((match = secPattern.exec(text)) !== null) {
          const canon = canonizeSection(match[1]);
          if (!canon.startsWith("10 ") || EQUIPMENT_REF_RE.test(match[1])) continue;
          if (headers.some(h => h.sectionNumber === canon)) continue;

          console.log(`[PreScan] FOUND section ${canon} on page ${pageIdx + 1} via PART 1 marker fallback`);
          headers.push({ sectionNumber: canon, title: "", page: pageIdx, confidence: "low" });
          foundOnPage = true;
          break;
        }
        if (foundOnPage) break;
      }
    }
  }

  return headers;
}

function isLegitimateSection(pages: string[], pageIdx: number, sectionNumber: string): boolean {
  for (let offset = 0; offset <= 1 && pageIdx + offset < pages.length; offset++) {
    const pageText = pages[pageIdx + offset];
    const upper = pageText.toUpperCase();

    if (/PART\s*1\s*[\-–—:]?\s*GENERAL/i.test(pageText)) return true;
    if (/PART\s*[23]\s*[\-–—:]?\s*(PRODUCTS|EXECUTION)/i.test(pageText)) return true;

    if (upper.includes("GENERAL") && upper.includes("PRODUCTS")) return true;

    const contentMarkers = [
      "SCOPE", "RELATED SECTIONS", "REFERENCES", "SUBMITTALS",
      "QUALITY ASSURANCE", "DELIVERY", "PROJECT CONDITIONS",
      "MANUFACTURERS", "MATERIALS", "FABRICATION", "INSTALLATION"
    ];
    let markerCount = 0;
    for (const marker of contentMarkers) {
      if (upper.includes(marker)) markerCount++;
    }
    if (markerCount >= 3) return true;
  }

  const digits = sectionNumber.replace(/\s/g, "");
  const sectionPattern = new RegExp(
    `(?:SECTION|SPEC)\\s+${digits.slice(0, 2)}[\\s\\-\\._]*${digits.slice(2, 4)}[\\s\\-\\._]*${digits.length >= 6 ? digits.slice(4, 6) : "\\d{2}"}`,
    "i"
  );
  if (sectionPattern.test(pages[pageIdx])) return true;

  return false;
}

function findSectionStartPage(pages: string[], detectedPage: number, sectionNumber: string): number {
  const digits = sectionNumber.replace(/\s/g, "");
  const escapedDigits = digits.slice(0, 2) + "[\\s\\-\\._]*" +
    digits.slice(2, 4) + "[\\s\\-\\._]*" +
    (digits.length >= 6 ? digits.slice(4, 6) : "(?:\\d{2})?");

  const headerPatterns = [
    new RegExp(`(?:SECTION|SPEC)\\s+${escapedDigits}`, "i"),
    new RegExp(`^${escapedDigits}\\s*[\\-–—:]`, "im"),
  ];

  for (let lookBack = 0; lookBack < Math.min(10, detectedPage + 1); lookBack++) {
    const checkPage = detectedPage - lookBack;
    if (checkPage < 0) break;

    const pageText = pages[checkPage];
    const lines = pageText.split("\n");
    const topZone = lines.slice(0, 20).join("\n");

    for (const pattern of headerPatterns) {
      if (pattern.test(topZone)) {
        if (lookBack > 0) {
          console.log(`[StartPage] Section ${sectionNumber} start moved back from page ${detectedPage + 1} to ${checkPage + 1}`);
        }
        return checkPage;
      }
    }

    if (/PART\s*1\s*[\-–—:]?\s*GENERAL/i.test(topZone)) {
      const secRe = new RegExp(digits.slice(0, 2) + "[\\s\\-\\._]*" + digits.slice(2, 4), "i");
      if (secRe.test(pageText)) {
        if (lookBack > 0) {
          console.log(`[StartPage] Section ${sectionNumber} start moved back from page ${detectedPage + 1} to ${checkPage + 1} via PART 1`);
        }
        return checkPage;
      }
    }
  }

  return detectedPage;
}

function findSectionEndPage(pages: string[], startPage: number, maxSearchPage: number, sectionNumber: string): number {
  const effectiveMax = Math.min(maxSearchPage, pages.length - 1);
  const digits = sectionNumber.replace(/\s/g, "");

  for (let pageNum = startPage; pageNum <= effectiveMax; pageNum++) {
    const pageText = pages[pageNum];
    const lines = pageText.split("\n");

    for (const line of lines) {
      const lineLower = line.toLowerCase().trim();
      for (const marker of END_MARKERS) {
        if (lineLower === marker || (lineLower.includes(marker) && lineLower.length < marker.length + 20)) {
          if (pageNum > startPage || lines.indexOf(line) > 5) {
            console.log(`[EndPage] Section ${sectionNumber} ends at page ${pageNum + 1} via END marker: "${lineLower}"`);
            return pageNum;
          }
        }
      }
    }

    if (pageNum > startPage) {
      const topZone = lines.slice(0, 20).join("\n");

      const nextSectionPatterns = [
        /(?:^|\n)\s*SECTION\s+(\d{2})\s*[\s\-\._]*(\d{2})\s*[\s\-\._]*(\d{2})/im,
        /(?:^|\n)\s*SECTION\s+(\d{2})(\d{2})(\d{2})/im,
      ];

      for (const nextPattern of nextSectionPatterns) {
        const nextSectionMatch = topZone.match(nextPattern);
        if (nextSectionMatch) {
          const newSecFull = `${nextSectionMatch[1]} ${nextSectionMatch[2]} ${nextSectionMatch[3]}`;
          if (newSecFull !== sectionNumber) {
            console.log(`[EndPage] Section ${sectionNumber} ends at page ${pageNum} (next section ${newSecFull} starts on page ${pageNum + 1})`);
            return pageNum - 1;
          }
        }
      }

      if (/PART\s*1\s*[\-–—:]?\s*GENERAL/i.test(topZone)) {
        const secRe = new RegExp(`\\b${digits.slice(0, 2)}[\\s\\-\\._]*\\d{2}[\\s\\-\\._]*\\d{2}\\b`);
        const topMatch = topZone.match(secRe);
        if (topMatch) {
          const foundCanon = canonizeSection(topMatch[0]);
          if (foundCanon !== sectionNumber && foundCanon.startsWith("10 ")) {
            console.log(`[EndPage] Section ${sectionNumber} ends at page ${pageNum} (new section ${foundCanon} with PART 1 on page ${pageNum + 1})`);
            return pageNum - 1;
          }
        }
      }
    }
  }

  const defaultEnd = effectiveMax;
  console.log(`[EndPage] Section ${sectionNumber} ends at page ${defaultEnd + 1} (reached max search boundary)`);
  return defaultEnd;
}

function calculatePageRanges(
  headers: PreScanHeader[],
  totalPages: number,
  pages: string[]
): AIIdentifiedSection[] {
  const sections: AIIdentifiedSection[] = [];

  const sortedHeaders = [...headers].sort((a, b) => a.page - b.page);

  for (let i = 0; i < sortedHeaders.length; i++) {
    const h = sortedHeaders[i];

    const startPage = findSectionStartPage(pages, h.page, h.sectionNumber);

    let maxEnd: number;
    if (i + 1 < sortedHeaders.length) {
      maxEnd = sortedHeaders[i + 1].page - 1;
    } else {
      maxEnd = Math.min(startPage + 80, totalPages - 1);
    }

    if (maxEnd < startPage) maxEnd = startPage;

    const endPage = findSectionEndPage(pages, startPage, maxEnd, h.sectionNumber);

    const pageCount = endPage - startPage + 1;
    if (pageCount > 80) {
      console.log(`[PageRange] WARNING: Section ${h.sectionNumber} has ${pageCount} pages, capping at 80`);
    }
    const cappedEnd = pageCount > 80 ? startPage + 79 : endPage;

    console.log(`[PageRange] ${h.sectionNumber} - "${h.title}" pages ${startPage + 1} to ${cappedEnd + 1} (${cappedEnd - startPage + 1} pages)`);

    sections.push({
      sectionNumber: h.sectionNumber,
      title: h.title,
      startPage: startPage + 1,
      endPage: cappedEnd + 1,
    });
  }

  return sections;
}

function verifySectionContent(pages: string[], section: AIIdentifiedSection): { valid: boolean; issue?: string } {
  const startIdx = section.startPage - 1;
  const endIdx = section.endPage - 1;

  if (startIdx < 0 || startIdx >= pages.length) {
    return { valid: false, issue: `Start page ${section.startPage} out of range` };
  }

  const digits = section.sectionNumber.replace(/\s/g, "");
  const secPattern = new RegExp(
    digits.slice(0, 2) + "[\\s\\-\\._]*" + digits.slice(2, 4) + "[\\s\\-\\._]*" +
    (digits.length >= 6 ? digits.slice(4, 6) : "\\d{2}"),
    "i"
  );

  let foundSectionRef = false;
  let foundPartMarker = false;
  const checkEnd = Math.min(startIdx + 2, endIdx, pages.length - 1);

  for (let p = startIdx; p <= checkEnd; p++) {
    const pageText = pages[p];
    if (secPattern.test(pageText)) foundSectionRef = true;
    if (/PART\s*[123]\s*[\-–—:]?\s*(GENERAL|PRODUCTS|EXECUTION)/i.test(pageText)) foundPartMarker = true;
  }

  if (!foundSectionRef) {
    return { valid: false, issue: `Section number ${section.sectionNumber} not found in pages ${section.startPage}-${Math.min(section.startPage + 2, section.endPage)}` };
  }

  if (!foundPartMarker) {
    const extendedCheck = Math.min(startIdx + 5, endIdx, pages.length - 1);
    for (let p = checkEnd + 1; p <= extendedCheck; p++) {
      if (/PART\s*[123]\s*[\-–—:]?\s*(GENERAL|PRODUCTS|EXECUTION)/i.test(pages[p])) {
        foundPartMarker = true;
        break;
      }
    }

    if (!foundPartMarker) {
      return { valid: false, issue: `No PART markers found for ${section.sectionNumber} within pages ${section.startPage}-${Math.min(section.startPage + 5, section.endPage)}` };
    }
  }

  const exclusionReason = isExcludedPage(startIdx, { start: -1, end: -1 }, pages[startIdx]);
  if (exclusionReason) {
    return { valid: false, issue: `Start page is ${exclusionReason}` };
  }

  return { valid: true };
}

function buildSectionIdentPrompt(config: SpecsiftConfig): string {
  const defaultScopes = config.defaultScopes as Record<string, string>;
  const scopeList = Object.entries(defaultScopes)
    .map(([num, name]) => `  - ${num}: ${name}`)
    .join("\n");

  const accessoryScopes = config.accessoryScopes as AccessoryScopeData[];
  const nonDiv10Examples = accessoryScopes
    .filter(s => !s.sectionHint.startsWith("10"))
    .slice(0, 5)
    .map(s => `${s.sectionHint} (${s.name})`)
    .join(", ");

  return `You are a construction specification parser. Your ONLY job is to find ACTUAL Division 10 specification sections in the provided text.

IMPORTANT: Pages within the Table of Contents have already been excluded. The text you receive contains ONLY body pages. However, you must still verify each section has actual content (PART markers).

WHAT TO LOOK FOR — Section Headers:
Section headers in construction specs follow a standard CSI format. They typically appear at the TOP of a page (within the first 10-15 lines) and contain:
- The word "SECTION" followed by a 6-digit number (e.g., "SECTION 102613" or "SECTION 10 26 13")
- A title in ALL CAPS following the number (e.g., "SECTION 102613 - WALL AND DOOR PROTECTION")
- Sometimes the title appears on the NEXT LINE after the section number
- The section body then contains "PART 1 - GENERAL", "PART 2 - PRODUCTS", "PART 3 - EXECUTION"
- Sections end with "END OF SECTION" on the last page

KNOWN Division 10 section types you should look for:
${scopeList}

CRITICAL RULES — FOLLOW EXACTLY:
1. ONLY report sections whose number LITERALLY starts with "10" (Division 10 - Specialties).
2. DO NOT report sections from other divisions. Numbers starting with 11, 12, 13, 14, etc. are NOT Division 10.${nonDiv10Examples ? `\n   Examples of NON-Division 10 sections to IGNORE: ${nonDiv10Examples}` : ""}
3. ONLY report a section if you can see its EXACT section number literally written in the text as a HEADER near the top of a page. DO NOT report numbers that only appear in body text references or cross-references.
4. ONLY report sections that have actual body content — look for "PART 1 - GENERAL", "PART 2 - PRODUCTS", or "PART 3 - EXECUTION" markers.
5. The section number you report MUST match EXACTLY what appears in the text (just reformat to "10 XX XX" spacing).
6. REJECT equipment references like "10 1400-11" — these are product numbers, not section numbers.
7. If you find ZERO Division 10 sections, return {"sections": []}.
8. A page that lists MANY section numbers (like a table of contents or index) should NOT be treated as containing section headers. Only individual section start pages count.

For each Division 10 section found, provide:
- sectionNumber: The literal number from the text, normalized to "10 XX XX" format
- title: The exact title as written in the document header. Remove PART markers and content words (GENERAL, PRODUCTS, EXECUTION) from the title.
- startPage: The page number where the section header (containing "SECTION 10XXXX") appears
- endPage: The page where "END OF SECTION" appears or where the next section begins

Return ONLY valid JSON. No markdown fences, no explanation.
Response schema: { "sections": [{ "sectionNumber": "10 XX XX", "title": "Section Title", "startPage": number, "endPage": number }] }`;
}

function buildDetailExtractionPrompt(config: SpecsiftConfig): string {
  const excludeTerms = config.manufacturerExcludeTerms as string[];
  const materialKeywords = config.materialKeywords as string[];
  const modelPatterns = config.modelPatterns as string[];
  const conflictPatterns = config.conflictPatterns as string[];
  const notePatterns = config.notePatterns as string[];

  const excludeList = excludeTerms.length > 0
    ? `Do NOT include these as manufacturer names (they are generic/spec terms): ${excludeTerms.slice(0, 30).join(", ")}`
    : "Do NOT include generic specification language as manufacturer names.";

  const materialHints = materialKeywords.length > 0
    ? `Common material terms to look for include: ${materialKeywords.join(", ")}`
    : "";

  const modelHints = modelPatterns.length > 0
    ? `Model numbers typically follow patterns like: ${modelPatterns.map(p => p.replace(/\\\\/g, "\\").replace(/\(\[.*?\]\[.*?\]\+\)/g, "XXX")).slice(0, 3).join("; ")}`
    : "";

  const conflictHints = conflictPatterns.length > 0
    ? `Look specifically for these phrases that indicate conflicts: ${conflictPatterns.join(", ")}`
    : "";

  const noteHints = notePatterns.length > 0
    ? `Look specifically for these topics in notes: ${notePatterns.join(", ")}`
    : "";

  return `You are a construction specification analyst specializing in Division 10 (Specialties).

You will receive the full text of a single specification section. Extract the following details:

1. **manufacturers**: List all manufacturer names mentioned as approved/acceptable/basis-of-design. Include company names like "Bobrick Washroom Equipment", "ASI Group", "Koala Kare Products", etc.
   ${excludeList}

2. **modelNumbers**: List all specific product model numbers mentioned (e.g., "B-2621", "K-14367-CP", "0199-MBH", "Series 2850"). Include the full model designation.
   ${modelHints}

3. **materials**: List all materials specified (e.g., "Stainless Steel Type 304", "Solid Phenolic", "Powder-Coated Aluminum", "Tempered Glass"). Only include actual material types, not generic words.
   ${materialHints}

4. **conflicts**: Flag any potential issues:
   - "No substitutions allowed - sole source requirement" if sole source / no substitution language exists
   - "Single manufacturer specified without 'or equal'" if only one manufacturer is listed without alternatives
   - "Both performance and prescriptive requirements" if both specification types are mixed
   - Any contradictory requirements
   ${conflictHints}

5. **notes**: Extract important notes:
   - Warranty requirements (e.g., "5-year warranty required")
   - Special installation requirements
   - ADA/accessibility requirements mentioned
   - Fire rating requirements
   - Color/finish selection requirements
   - Submittal requirements of note
   ${noteHints}

Return ONLY valid JSON, no markdown fences, no explanation.
Response schema: { "manufacturers": [], "modelNumbers": [], "materials": [], "conflicts": [], "notes": [] }`;
}

function buildPageText(pages: string[], startIdx: number, endIdx: number): string {
  const parts: string[] = [];
  for (let i = startIdx; i <= endIdx && i < pages.length; i++) {
    const text = pages[i].trim();
    if (text.length > 0) {
      parts.push(`--- PAGE ${i + 1} ---\n${text}`);
    }
  }
  return parts.join("\n\n");
}

function buildFilteredPageText(pages: string[], startIdx: number, endIdx: number, tocBounds: TOCBounds): string {
  const parts: string[] = [];
  for (let i = startIdx; i <= endIdx && i < pages.length; i++) {
    const exclusion = isExcludedPage(i, tocBounds, pages[i]);
    if (exclusion) continue;
    const text = pages[i].trim();
    if (text.length > 0) {
      parts.push(`--- PAGE ${i + 1} ---\n${text}`);
    }
  }
  return parts.join("\n\n");
}

async function callOpenAI(systemPrompt: string, userContent: string, model: string = DEFAULT_MODEL): Promise<string> {
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.1,
  });

  return response.choices[0]?.message?.content || "";
}

function parseJSON<T>(raw: string, schema: z.ZodType<T>): T | null {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(cleaned);
    const result = schema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
    console.error("[AI Spec Extractor] Schema validation failed:", result.error.issues);
    return null;
  } catch (e) {
    console.error("[AI Spec Extractor] JSON parse error:", e);
    return null;
  }
}

function verifySectionInText(pages: string[], sectionNumber: string, startPage: number, endPage: number): boolean {
  const digits = sectionNumber.replace(/\s/g, "");
  if (digits.length < 4) return false;

  const d1 = digits.slice(0, 2);
  const d2 = digits.slice(2, 4);
  const d3 = digits.length >= 6 ? digits.slice(4, 6) : "00";

  const searchStart = Math.max(0, startPage - 3);
  const searchEnd = Math.min(pages.length - 1, endPage + 1);
  const searchText = pages.slice(searchStart, searchEnd + 1).join("\n");

  if (searchText.includes(`${d1}${d2}${d3}`)) return true;
  if (searchText.includes(`${d1} ${d2} ${d3}`)) return true;
  if (searchText.includes(`${d1}-${d2}-${d3}`)) return true;
  if (searchText.includes(`${d1}.${d2}.${d3}`)) return true;

  if (d3 === "00") {
    const looseShort = new RegExp(
      `(?:SECTION\\s+)?${d1}[\\s\\-\\._]*${d2}(?:\\s|$|[\\-\\._])`,
      "gm"
    );
    if (looseShort.test(searchText)) return true;
  }

  const loosePattern = new RegExp(
    d1 + "[\\s\\-\\._]*" + d2 + "[\\s\\-\\._]*" + d3,
    "g"
  );
  if (loosePattern.test(searchText)) return true;

  return false;
}

function verifyHeaderOnPage(pages: string[], sectionNumber: string, startPage: number): boolean {
  const pageIdx = Math.max(0, startPage - 1);
  if (pageIdx >= pages.length) return false;

  const digits = sectionNumber.replace(/\s/g, "");

  const headerPattern = new RegExp(
    `(?:SECTION\\s+)?` +
    digits.slice(0, 2) + `[\\s\\-\\._]*` +
    digits.slice(2, 4) + `[\\s\\-\\._]*` +
    (digits.length >= 6 ? digits.slice(4, 6) : `(?:\\d{2})?`),
    "i"
  );

  const checkPage = (idx: number): boolean => {
    if (idx < 0 || idx >= pages.length) return false;
    const lines = pages[idx].split("\n");
    const topZone = lines.slice(0, 20).join("\n");
    return headerPattern.test(topZone);
  };

  if (checkPage(pageIdx)) return true;
  if (checkPage(pageIdx + 1)) return true;
  if (checkPage(pageIdx - 1)) return true;

  return false;
}

export async function identifySectionsWithAI(
  pages: string[],
  onProgress?: (progress: number, message: string) => void
): Promise<AISpecResult> {
  clearConfigCache();
  const config = await getActiveConfiguration();
  const defaultScopes = config.defaultScopes as Record<string, string>;
  console.log(`[AI Spec Extractor] ===== EXTRACTION START =====`);
  console.log(`[AI Spec Extractor] ${pages.length} total pages, ${Object.keys(defaultScopes).length} default scopes configured`);

  for (let i = 0; i < Math.min(5, pages.length); i++) {
    const preview = pages[i].slice(0, 150).replace(/\n/g, "\\n");
    console.log(`[AI Spec Extractor] Page ${i + 1} preview: "${preview}"`);
  }

  onProgress?.(5, "Detecting Table of Contents...");
  const tocBounds = detectTOCBounds(pages);

  onProgress?.(10, "Pre-scanning for Division 10 headers...");
  const preScanHeaders = findDiv10Headers(pages, tocBounds);
  console.log(`[PreScan] ===== RESULTS: Found ${preScanHeaders.length} Division 10 headers via regex =====`);

  for (const h of preScanHeaders) {
    console.log(`[PreScan] ${h.sectionNumber} - "${h.title}" (page ${h.page + 1}, confidence: ${h.confidence})`);
  }

  let preScanSections: AIIdentifiedSection[] = [];
  if (preScanHeaders.length > 0) {
    onProgress?.(15, `Validating and calculating page ranges for ${preScanHeaders.length} sections...`);

    const validHeaders = preScanHeaders.filter(h => {
      const legitimate = isLegitimateSection(pages, h.page, h.sectionNumber);
      if (!legitimate && h.confidence !== "high") {
        console.log(`[PreScan] REJECTED: ${h.sectionNumber} on page ${h.page + 1} (not legitimate, confidence: ${h.confidence})`);
        return false;
      }
      if (!legitimate && h.confidence === "high") {
        console.log(`[PreScan] KEPT despite no PART markers: ${h.sectionNumber} on page ${h.page + 1} (high confidence header match)`);
      }
      return true;
    });

    preScanSections = calculatePageRanges(validHeaders, pages.length, pages);

    const verifiedSections: AIIdentifiedSection[] = [];
    for (const sec of preScanSections) {
      const verification = verifySectionContent(pages, sec);
      if (verification.valid) {
        console.log(`[PreScan] VERIFIED: ${sec.sectionNumber} - "${sec.title}" (pages ${sec.startPage}-${sec.endPage})`);
        verifiedSections.push(sec);
      } else {
        console.log(`[PreScan] VERIFICATION FAILED: ${sec.sectionNumber} - ${verification.issue}`);
      }
    }
    preScanSections = verifiedSections;
  }

  onProgress?.(20, `Running AI verification on ${pages.length} pages...`);
  const identPrompt = buildSectionIdentPrompt(config);

  const aiSections: AIIdentifiedSection[] = [];
  const totalBatches = Math.ceil(pages.length / PAGES_PER_BATCH);

  for (let batch = 0; batch < totalBatches; batch++) {
    const startIdx = batch * PAGES_PER_BATCH;
    const endIdx = Math.min(startIdx + PAGES_PER_BATCH - 1, pages.length - 1);
    const pageText = buildFilteredPageText(pages, startIdx, endIdx, tocBounds);

    if (pageText.trim().length < 50) continue;

    const progress = 20 + Math.floor(((batch + 1) / totalBatches) * 30);
    onProgress?.(progress, `AI scanning pages ${startIdx + 1}-${endIdx + 1} (batch ${batch + 1}/${totalBatches})...`);

    try {
      const raw = await callOpenAI(identPrompt, pageText);
      const parsed = parseJSON(raw, IdentResponseSchema);

      if (parsed) {
        for (const sec of parsed.sections) {
          const canon = canonizeSection(sec.sectionNumber);
          if (!canon.startsWith("10 ")) {
            console.log(`[AI] REJECTED non-Div10: ${sec.sectionNumber} (${sec.title})`);
            continue;
          }
          if (EQUIPMENT_REF_RE.test(sec.sectionNumber)) {
            console.log(`[AI] REJECTED equipment ref: ${sec.sectionNumber}`);
            continue;
          }
          if (aiSections.some(s => s.sectionNumber === canon)) continue;

          if (!verifyHeaderOnPage(pages, canon, sec.startPage)) {
            console.log(`[AI] REJECTED: ${canon} - "${sec.title}" (header not in top zone of page ${sec.startPage})`);
            continue;
          }

          if (!verifySectionInText(pages, canon, sec.startPage, sec.endPage)) {
            console.log(`[AI] REJECTED hallucination: ${canon} - "${sec.title}" (not found in PDF near pages ${sec.startPage}-${sec.endPage})`);
            continue;
          }

          const startPageIdx = Math.max(0, sec.startPage - 1);
          const exclusion = isExcludedPage(startPageIdx, tocBounds, pages[startPageIdx]);
          if (exclusion) {
            console.log(`[AI] REJECTED: ${canon} - "${sec.title}" (start page ${sec.startPage} is ${exclusion})`);
            continue;
          }

          const cleanedTitle = cleanSectionTitle(sec.title.trim());

          aiSections.push({
            sectionNumber: canon,
            title: cleanedTitle || sec.title.trim(),
            startPage: sec.startPage,
            endPage: sec.endPage,
          });
          console.log(`[AI] VERIFIED: ${canon} - "${cleanedTitle}" (pages ${sec.startPage}-${sec.endPage})`);
        }
      }
    } catch (err) {
      console.error(`[AI] Batch ${batch + 1} identification error:`, err);
    }
  }

  onProgress?.(55, "Merging pre-scan and AI results...");
  const mergedMap = new Map<string, AIIdentifiedSection>();

  for (const sec of preScanSections) {
    mergedMap.set(sec.sectionNumber, sec);
  }

  for (const sec of aiSections) {
    if (!mergedMap.has(sec.sectionNumber)) {
      const preScanStart = findSectionStartPage(pages, sec.startPage - 1, sec.sectionNumber);
      let maxEnd: number;
      const sortedExisting = Array.from(mergedMap.values()).sort((a, b) => a.startPage - b.startPage);
      const nextSection = sortedExisting.find(s => s.startPage > preScanStart + 1);
      if (nextSection) {
        maxEnd = nextSection.startPage - 2;
      } else {
        maxEnd = Math.min(preScanStart + 80, pages.length - 1);
      }
      const preScanEnd = findSectionEndPage(pages, preScanStart, maxEnd, sec.sectionNumber);

      const newSec: AIIdentifiedSection = {
        sectionNumber: sec.sectionNumber,
        title: sec.title,
        startPage: preScanStart + 1,
        endPage: preScanEnd + 1,
      };

      const verification = verifySectionContent(pages, newSec);
      if (verification.valid) {
        mergedMap.set(sec.sectionNumber, newSec);
        console.log(`[Merge] AI found additional section: ${sec.sectionNumber} - "${sec.title}" (pages ${newSec.startPage}-${newSec.endPage})`);
      } else {
        console.log(`[Merge] AI section REJECTED after verification: ${sec.sectionNumber} - ${verification.issue}`);
      }
    } else {
      const existing = mergedMap.get(sec.sectionNumber)!;
      if (sec.title.length > existing.title.length && sec.title.length > 5) {
        existing.title = sec.title;
      }
    }
  }

  const allSections = Array.from(mergedMap.values());
  allSections.sort((a, b) => a.sectionNumber.localeCompare(b.sectionNumber));

  for (const sec of allSections) {
    if (sec.title.length < 5) {
      const scopeName = defaultScopes[sec.sectionNumber];
      if (scopeName) {
        sec.title = scopeName;
      } else {
        const parentKey = sec.sectionNumber.split(" ").slice(0, 2).join(" ");
        const parentMatch = Object.entries(defaultScopes).find(([k]) => k.startsWith(parentKey));
        if (parentMatch) {
          sec.title = parentMatch[1];
        }
      }
    }
  }

  console.log(`[AI Spec Extractor] ===== FINAL RESULTS =====`);
  console.log(`[AI Spec Extractor] ${allSections.length} sections total (${preScanSections.length} from regex, ${aiSections.length} from AI)`);
  for (const sec of allSections) {
    console.log(`[AI Spec Extractor] ${sec.sectionNumber} - "${sec.title}" (pages ${sec.startPage}-${sec.endPage})`);
  }

  return {
    sections: allSections,
    modelUsed: DEFAULT_MODEL,
  };
}

export async function extractSectionDetailsWithAI(
  sectionText: string,
  sectionNumber: string,
  title: string
): Promise<AISectionDetails> {
  clearConfigCache();
  const config = await getActiveConfiguration();
  const detailPrompt = buildDetailExtractionPrompt(config);

  const truncated = sectionText.slice(0, 12000);
  const userContent = `Section: ${sectionNumber} - ${title}\n\n${truncated}`;

  try {
    const raw = await callOpenAI(detailPrompt, userContent);
    const parsed = parseJSON(raw, SectionDetailSchema);

    if (parsed) {
      const excludeTerms = config.manufacturerExcludeTerms as string[];
      const filteredManufacturers = (parsed.manufacturers || []).filter(mfr => {
        const lower = mfr.toLowerCase();
        return !excludeTerms.some(term => lower === term.toLowerCase());
      });

      const result: AISectionDetails = {
        manufacturers: filteredManufacturers,
        modelNumbers: parsed.modelNumbers || [],
        materials: parsed.materials || [],
        conflicts: parsed.conflicts || [],
        notes: parsed.notes || [],
      };
      console.log(`[AI Spec Extractor] Details for ${sectionNumber}: ${result.manufacturers.length} mfrs, ${result.modelNumbers.length} models, ${result.materials.length} materials`);
      return result;
    }
  } catch (err) {
    console.error(`[AI Spec Extractor] Detail extraction error for ${sectionNumber}:`, err);
  }

  return {
    manufacturers: [],
    modelNumbers: [],
    materials: [],
    conflicts: [],
    notes: [],
  };
}

export { isExcludedPage, detectTOCBounds as detectTOCBoundsAI };
