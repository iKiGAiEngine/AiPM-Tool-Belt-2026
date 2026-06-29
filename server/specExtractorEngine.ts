import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "path";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";

const STANDARD_FONT_DATA_URL = path.join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/");

export interface ExtractedHeader {
  section: string;
  title: string;
  page: number;
  isLegitimate: boolean;
}

export interface SectionRange {
  section: string;
  title: string;
  start: number;
  end: number;
  folderName: string;
}

export interface TOCBounds {
  start: number;
  end: number;
}

export interface ExtractionResult {
  sections: SectionRange[];
  tocBounds: TOCBounds;
  totalPages: number;
}

export interface TOCHint {
  section: string;
  title: string;
}

export type ProgressCallback = (progress: number, message: string) => void;

export function parseTocHints(rawText: string): TOCHint[] {
  const hints: TOCHint[] = [];
  const seen = new Set<string>();
  const lines = rawText.split(/[\n\r]+/);

  for (const line of lines) {
    const trimmed = line.replace(/\.{2,}/g, "").replace(/\s{2,}/g, " ").trim();
    if (!trimmed) continue;

    const match = trimmed.match(
      /(\d{2}[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)\s*[-–—:\s]\s*(.+)/
    );
    if (match) {
      const canon = canonize(match[1]);
      const title = match[2].replace(/[\s\-–—:]+$/, "").trim();
      if (!seen.has(canon) && title.length >= 2) {
        seen.add(canon);
        hints.push({ section: canon, title });
      }
    } else {
      const numOnly = trimmed.match(/(\d{2}[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)/);
      if (numOnly) {
        const canon = canonize(numOnly[1]);
        if (!seen.has(canon)) {
          seen.add(canon);
          hints.push({ section: canon, title: "" });
        }
      }
    }
  }

  return hints;
}

const DEFAULT_SCOPES: Record<string, string> = {
  "10 11 00": "Visual Display Units",
  "10 14 00": "Signage",
  "10 14 19": "Dimensional Signage",
  "10 14 73": "Painted Signage",
  "10 21 13": "Toilet Compartments",
  "10 21 23": "Cubicle Curtains",
  "10 22 39": "Folding Partitions",
  "10 26 00": "Wall Protection",
  "10 26 01": "Wall Protection",
  "10 28 00": "Toilet Accessories",
  "10 41 16": "Key Cabinets",
  "10 44 00": "Fire Protection",
  "10 44 13": "Fire Protection Cabinets",
  "10 44 16": "Fire Extinguishers",
  "10 51 00": "Lockers",
  "10 51 13": "Metal Lockers",
  "10 82 00": "Grilles and Screens",
};

const SIGNAGE_PREFIXES = ["10 14"];

export function isSignageSection(sectionNumber: string): boolean {
  const normalized = sectionNumber.replace(/[\-._]/g, " ").replace(/\s+/g, " ").trim();
  return SIGNAGE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

export interface AccessoryScope {
  name: string;
  keywords: string[];
  sectionHint: string;
  divisionScope: number[];
}

export const ACCESSORY_SCOPES: AccessoryScope[] = [
  { name: "Bike Racks", keywords: ["bike rack", "bicycle rack", "bicycle parking"], sectionHint: "12 93 43", divisionScope: [11, 12] },
  { name: "Expansion Joints", keywords: ["expansion joint", "control joint"], sectionHint: "07 95 13", divisionScope: [6, 7] },
  { name: "Window Shades", keywords: ["window shade", "roller shade", "blind"], sectionHint: "12 24 13", divisionScope: [11, 12] },
  { name: "Site Furnishings", keywords: ["site furnishing", "bench", "picnic table"], sectionHint: "12 93 00", divisionScope: [11, 12] },
  { name: "Entrance Mats/Grilles", keywords: ["entrance mat", "entrance grille", "entrance floor grille", "entrance floor mat", "walk-off mat", "walk-off grille", "floor mat", "floor grille"], sectionHint: "12 48 13", divisionScope: [11, 12] },
  { name: "Flagpoles", keywords: ["flagpole", "flag pole"], sectionHint: "12 93 23", divisionScope: [11, 12] },
  { name: "Display Cases", keywords: ["display case", "trophy case", "exhibit case"], sectionHint: "11 11 13", divisionScope: [11, 12] },
  { name: "Wardrobe Closets/Shelving", keywords: ["wardrobe", "closet shelving", "wire shelving"], sectionHint: "10 56 00", divisionScope: [11, 12] },
];

export interface AccessoryMatch {
  accessoryName: string;
  sectionNumber: string;
  title: string;
  start: number;
  end: number;
  folderName: string;
  matchedKeywords: string[];
}

function extractDivisionFromHeader(topLines: string): number | null {
  const headerMatch = topLines.match(
    /(?:SECTION|SPEC)\s+(\d{2})[\s\-._]*\d{2}[\s\-._]*\d{2}/i
  );
  if (headerMatch) {
    return parseInt(headerMatch[1], 10);
  }
  const standaloneSec = topLines.match(/^(\d{2})[\s\-._]*\d{2}[\s\-._]*\d{2}\s*[-–—:]/m);
  if (standaloneSec) {
    return parseInt(standaloneSec[1], 10);
  }
  return null;
}

function extractSectionNumberFromHeader(topLines: string): string | null {
  const patterns = [
    /(?:SECTION|SPEC)\s+(\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2})\s*[-–—:]/i,
    /^(\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2})\s*[-–—:]/m,
    /(?:SECTION|SPEC)\s+(\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2})\s+[A-Z]/i,
  ];
  for (const pat of patterns) {
    const m = topLines.match(pat);
    if (m) {
      return canonize(m[1]);
    }
  }
  return null;
}

function extractTitleFromHeader(topLines: string): string | null {
  const patterns = [
    /(?:SECTION|SPEC)\s+\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2}\s*[-–—:]\s*([A-Za-z][A-Za-z\s,&\/\-]+)/i,
    /^\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2}\s*[-–—:]\s*([A-Za-z][A-Za-z\s,&\/\-]+)/m,
    /(?:SECTION|SPEC)\s+\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2}\s+([A-Z][A-Z\s,&\/\-]{5,})/i,
  ];
  for (const pat of patterns) {
    const m = topLines.match(pat);
    if (m && m[1].trim().length >= 3) {
      return cleanSectionTitle(m[1].trim());
    }
  }
  return null;
}

function buildFlexibleKeywordRegex(keyword: string): RegExp {
  const words = keyword.toLowerCase().trim().split(/\s+/);
  const pattern = words
    .map(w => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return escaped + "(?:s|es)?";
    })
    .join("\\s+(?:\\w+\\s+)*");
  return new RegExp(pattern, "i");
}

export function findAccessorySections(
  pages: string[],
  selectedAccessories: string[],
  tocBounds: TOCBounds,
  existingDiv10Sections?: SectionRange[],
  scopeOverrides?: AccessoryScope[]
): AccessoryMatch[] {
  if (!selectedAccessories || selectedAccessories.length === 0) return [];

  const scopeSource = scopeOverrides && scopeOverrides.length > 0 ? scopeOverrides : ACCESSORY_SCOPES;
  const selected = scopeSource.filter(a => selectedAccessories.includes(a.name));
  if (selected.length === 0) return [];

  const matches: AccessoryMatch[] = [];
  const seenPageRanges = new Set<string>();

  if (existingDiv10Sections) {
    for (const s of existingDiv10Sections) {
      seenPageRanges.add(`${s.start}-${s.end}`);
    }
  }

  for (const accessory of selected) {
    const candidatePages: { page: number; keywords: string[]; title: string; sectionNumber: string; score: number }[] = [];

    for (let pno = 0; pno < pages.length; pno++) {
      if (tocBounds.end >= 0 && pno <= tocBounds.end) continue;

      const pageText = pages[pno];
      const lines = pageText.split(/[\n\r]+/);
      const topLines = lines.slice(0, 20).join("\n");

      if (accessory.divisionScope.length > 0) {
        const pageDivision = extractDivisionFromHeader(topLines);
        if (pageDivision !== null && !accessory.divisionScope.includes(pageDivision)) {
          continue;
        }
      }

      const topLinesLower = topLines.toLowerCase();
      const fullPageLower = pageText.toLowerCase();
      const matchedKws: string[] = [];
      let score = 0;

      for (const kw of accessory.keywords) {
        const kwRegex = buildFlexibleKeywordRegex(kw);
        if (kwRegex.test(topLinesLower)) {
          matchedKws.push(kw);
          score += 10;
        } else if (kwRegex.test(fullPageLower)) {
          matchedKws.push(kw);
          score += 3;
        }
      }

      if (matchedKws.length === 0) continue;

      const hasHeader = topLines.match(
        /(?:SECTION|SPEC)\s+\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2}/i
      );
      const hasStandaloneHeader = topLines.match(
        /^\d{2}[\s\-._]*\d{2}[\s\-._]*\d{2}\s*[-–—:]/m
      );
      const hasPartOne = pageText.toUpperCase().includes("PART 1") && pageText.toUpperCase().includes("GENERAL");

      if (hasHeader || hasStandaloneHeader) {
        score += 20;
      }
      if (hasPartOne) {
        score += 15;
      }

      const sectionNumber = extractSectionNumberFromHeader(topLines) || accessory.sectionHint;
      const title = extractTitleFromHeader(topLines) || accessory.name;

      candidatePages.push({
        page: pno,
        keywords: matchedKws,
        title,
        sectionNumber,
        score,
      });
    }

    if (candidatePages.length === 0) {
      console.log(`[SpecExtractor] Accessory "${accessory.name}": no keyword matches found in spec`);
      continue;
    }

    candidatePages.sort((a, b) => b.score - a.score);
    const best = candidatePages[0];

    if (best.score < 10) {
      console.log(`[SpecExtractor] Accessory "${accessory.name}": best match score too low (${best.score}), skipping`);
      continue;
    }

    const sectionStart = best.page;
    const sectionEnd = findSectionEndPage(pages, sectionStart, Math.min(sectionStart + 30, pages.length - 1), best.sectionNumber);
    const rangeKey = `${sectionStart}-${sectionEnd}`;

    if (seenPageRanges.has(rangeKey)) {
      console.log(`[SpecExtractor] Accessory "${accessory.name}": overlaps existing section at pages ${sectionStart + 1}-${sectionEnd + 1}, skipping duplicate`);
      continue;
    }
    seenPageRanges.add(rangeKey);

    const folderName = getFolderName(best.sectionNumber, best.title);

    console.log(`[SpecExtractor] Accessory match: "${accessory.name}" -> ${best.sectionNumber} pages ${sectionStart + 1}-${sectionEnd + 1}, score: ${best.score}, keywords: [${best.keywords.join(", ")}]`);

    matches.push({
      accessoryName: accessory.name,
      sectionNumber: best.sectionNumber,
      title: best.title,
      start: sectionStart,
      end: sectionEnd,
      folderName,
      matchedKeywords: best.keywords,
    });
  }

  return matches;
}

const EQUIPMENT_REF_RE = /10\s*\d{4}-\d+/;

const SEC_RE = /\b10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6})\b/g;

const HDR_PATTERNS = [
  /(?:SECTION|Section|SPEC|Spec)\s+(10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\s*[–—\-:]\s*([A-Za-z][A-Za-z\s,&\/\-\.()]+)/i,
  /^(10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\s*[–—\-:]\s*([A-Z][A-Z\s,&\/\-\.()]+)/,
  /(?:SECTION|Section|SPEC|Spec)\s+(10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\s+([A-Z][A-Z\s,&\/\-\.()]{5,})/i,
  /^(10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\s+([A-Z][A-Z\s,&\/\-\.()]{5,})/m,
];

const END_MARKERS = [
  "end of section", "end of spec", "end section",
  "end of specification", "— end —", "- end -",
  "end div", "section end",
];

const CONTENT_MARKERS = ["GENERAL", "SUMMARY", "PRODUCTS", "EXECUTION", "REQUIREMENTS"];

function canonize(sec: string): string {
  if (EQUIPMENT_REF_RE.test(sec)) {
    return sec;
  }

  const digits = sec.replace(/[^\d]/g, "");

  if (digits.length === 6) {
    const dv = digits.slice(0, 2);
    const p1 = digits.slice(2, 4);
    const p2 = digits.slice(4, 6);
    return `${dv} ${p1} ${p2}`;
  } else if (digits.length === 4 && digits.startsWith("10")) {
    const dv = digits.slice(0, 2);
    const p1p2 = digits.slice(2, 4);
    return `${dv} ${p1p2} 00`;
  } else if (digits.length === 8) {
    const dv = digits.slice(0, 2);
    const p1 = digits.slice(2, 4);
    const p2 = digits.slice(4, 6);
    return `${dv} ${p1} ${p2}`;
  }

  return sec;
}

function parentKey(canon: string): string {
  const parts = canon.split(".")[0];
  const segs = parts.split(" ");
  if (segs.length >= 2) {
    return `${segs[0]} ${segs[1]}`;
  }
  return canon;
}

function cleanSectionTitle(title: string): string {
  let cleaned = title;

  cleaned = cleaned.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

  cleaned = cleaned.replace(/\s*SECTION\s+\d+.*$/i, "");
  cleaned = cleaned.replace(/\s*PART\s+\d+.*$/i, "");

  for (const marker of CONTENT_MARKERS) {
    cleaned = cleaned.replace(new RegExp(`\\s+${marker}.*$`, "i"), "");
  }

  cleaned = cleaned.replace(/[\s\-–—:]+$/, "").trim();

  return cleaned;
}

function getScopeName(section: string, rawTitle: string): string {
  const cleanedTitle = cleanSectionTitle(rawTitle);
  return DEFAULT_SCOPES[section] || DEFAULT_SCOPES[parentKey(section)] || cleanedTitle || "Unknown Section";
}

const MAX_FOLDER_NAME_LENGTH = 50;

function compactSectionNumber(section: string): string {
  return section.replace(/\s+/g, "");
}

function truncateAtWordBoundary(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace).replace(/[\s\-]+$/, "");
  }
  return truncated.replace(/[\s\-]+$/, "");
}

function getFolderName(section: string, rawTitle: string): string {
  const scopeName = getScopeName(section, rawTitle);
  const compact = compactSectionNumber(section);
  const prefix = `${compact} - `;
  const maxTitleLen = MAX_FOLDER_NAME_LENGTH - prefix.length;
  const truncatedTitle = truncateAtWordBoundary(scopeName, maxTitleLen);
  return `${prefix}${truncatedTitle}`;
}

function detectTOCBounds(pages: string[]): TOCBounds {
  let tocStartPage = -1;
  let tocEndPage = -1;

  const scanLimit = Math.min(100, pages.length);
  for (let pageNum = 0; pageNum < scanLimit; pageNum++) {
    if (/TABLE\s+OF\s+CONTENTS/i.test(pages[pageNum])) {
      tocStartPage = pageNum;
      console.log(`[SpecExtractor] TOC found on page ${pageNum + 1}`);
      break;
    }
  }

  if (tocStartPage < 0) {
    console.log(`[SpecExtractor] No TABLE OF CONTENTS found`);
    return { start: -1, end: -1 };
  }

  const tocPattern = /\.{3,}|(?:DIVISION|SECTION)\s+\d+.*\d+\s*$/im;
  let lastTocPage = tocStartPage;

  for (let pageNum = tocStartPage; pageNum < Math.min(tocStartPage + 50, pages.length); pageNum++) {
    const lines = pages[pageNum].split(/[\n\r]+/);
    let tocLineCount = 0;

    for (const line of lines) {
      if (tocPattern.test(line)) {
        tocLineCount++;
      }
    }

    if (tocLineCount >= 5) {
      lastTocPage = pageNum;
    } else if (pageNum > tocStartPage) {
      break;
    }
  }

  tocEndPage = lastTocPage;
  console.log(`[SpecExtractor] TOC: pages ${tocStartPage + 1} to ${tocEndPage + 1}`);
  return { start: tocStartPage, end: tocEndPage };
}

function extractTitleFromPage(lines: string[], sectionCanon: string): string {
  const sectionCompact = sectionCanon.replace(/\s/g, "");
  const escapedSection = sectionCanon.replace(/\s+/g, "[\\s\\-\\._]*");

  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const line = lines[i].trim();

    const titleAfterDash = line.match(new RegExp(`(?:${escapedSection}|${sectionCompact})\\s*[–—\\-:]\\s*(.+)`, "i"));
    if (titleAfterDash && titleAfterDash[1].trim().length >= 3) {
      return cleanSectionTitle(titleAfterDash[1].trim());
    }

    const titleAfterSpace = line.match(new RegExp(`(?:SECTION|SPEC)?\\s*(?:${escapedSection}|${sectionCompact})\\s{2,}(.+)`, "i"));
    if (titleAfterSpace && titleAfterSpace[1].trim().length >= 3) {
      return cleanSectionTitle(titleAfterSpace[1].trim());
    }

    const sectionOnly = line.match(new RegExp(`(?:SECTION|SPEC)?\\s*(?:${escapedSection}|${sectionCompact})\\s*$`, "i"));
    if (sectionOnly && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      if (nextLine.length >= 3 && /^[A-Za-z]/.test(nextLine)) {
        return cleanSectionTitle(nextLine);
      }
    }
  }

  return getScopeName(sectionCanon, "");
}

function findDiv10Headers(pages: string[], tocBounds: TOCBounds): ExtractedHeader[] {
  const headers: ExtractedHeader[] = [];
  const foundPages = new Set<number>();

  for (let pno = 0; pno < pages.length; pno++) {
    if (tocBounds.end >= 0 && pno <= tocBounds.end) {
      continue;
    }

    const txt = pages[pno];
    const lines = txt.split(/[\n\r]+/);
    const topZone = lines.slice(0, 20).join("\n");

    const multiLineResult = parseMultiLineHeader(lines, pno, txt);
    if (multiLineResult) {
      headers.push(multiLineResult);
      foundPages.add(pno);
      console.log(`[SpecExtractor] Multi-line header p${pno + 1}: ${multiLineResult.section} - "${multiLineResult.title}"`);
    }

    if (!foundPages.has(pno)) {
      for (const pattern of HDR_PATTERNS) {
        const match = pattern.exec(topZone);
        if (match) {
          const rawSec = match[1];
          const rawTitle = match[2].trim();
          const canon = canonize(rawSec);

          if (!canon.startsWith("10 ")) continue;
          if (EQUIPMENT_REF_RE.test(rawSec)) continue;

          const matchIndex = match.index;
          const textBefore = topZone.slice(Math.max(0, matchIndex - 10), matchIndex);
          if (/[A-Z]\.\s+$/i.test(textBefore)) {
            continue;
          }

          const cleaned = cleanSectionTitle(rawTitle);
          if (cleaned.length < 3) continue;

          const isLegit = isLegitimateSection(txt, canon);

          headers.push({
            section: canon,
            title: cleaned,
            page: pno,
            isLegitimate: isLegit,
          });
          foundPages.add(pno);

          console.log(`[SpecExtractor] Header found p${pno + 1}: ${canon} - "${cleaned}" (legit: ${isLegit})`);
          break;
        }
      }
    }
  }

  const foundSections = new Set(headers.map(h => h.section));

  for (let pno = 0; pno < pages.length; pno++) {
    if (tocBounds.end >= 0 && pno <= tocBounds.end) continue;
    if (foundPages.has(pno)) continue;

    const txt = pages[pno];
    const lines = txt.split(/[\n\r]+/);
    const topZone = lines.slice(0, 20).join("\n");
    const upper = txt.toUpperCase();

    const hasPart1 = upper.includes("PART 1") && (upper.includes("GENERAL") || upper.includes("PART 2") || upper.includes("PART 3"));

    const sectionNumberRe = /\b(10[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)\b/g;
    const topMatches: string[] = [];
    let m;
    while ((m = sectionNumberRe.exec(topZone)) !== null) {
      const canon = canonize(m[1]);
      if (canon.startsWith("10 ") && !EQUIPMENT_REF_RE.test(m[1]) && !foundSections.has(canon)) {
        const parts = canon.split(" ");
        if (parts.length >= 2 && parts[1] === "00") {
          continue;
        }
        topMatches.push(canon);
      }
    }

    const uniqueTopMatches = Array.from(new Set(topMatches));

    if (uniqueTopMatches.length === 1) {
      const canon = uniqueTopMatches[0];
      const title = extractTitleFromPage(lines, canon);
      const isLegit = isLegitimateSection(txt, canon);

      if (isLegit) {
        headers.push({
          section: canon,
          title,
          page: pno,
          isLegitimate: true,
        });
        foundPages.add(pno);
        foundSections.add(canon);
        console.log(`[SpecExtractor] Catch-all found p${pno + 1}: ${canon} - "${title}"`);
      }
    }

    if (!foundPages.has(pno) && hasPart1) {
      const topZoneForPart1 = lines.slice(0, 15).join("\n");
      const part1SectionRe = /\b(10[\s\-\._]*\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?)\b/g;
      const compactRe = /\b(10\d{4,6})\b/g;
      let fullPageMatch;
      const candidates: string[] = [];

      while ((fullPageMatch = part1SectionRe.exec(topZoneForPart1)) !== null) {
        const canon = canonize(fullPageMatch[1]);
        if (canon.startsWith("10 ") && !EQUIPMENT_REF_RE.test(fullPageMatch[1]) && !foundSections.has(canon) && !candidates.includes(canon)) {
          const cParts = canon.split(" ");
          if (cParts.length >= 2 && cParts[1] === "00") continue;
          candidates.push(canon);
        }
      }
      while ((fullPageMatch = compactRe.exec(topZoneForPart1)) !== null) {
        const canon = canonize(fullPageMatch[1]);
        if (canon.startsWith("10 ") && !EQUIPMENT_REF_RE.test(fullPageMatch[1]) && !foundSections.has(canon) && !candidates.includes(canon)) {
          const cParts = canon.split(" ");
          if (cParts.length >= 2 && cParts[1] === "00") continue;
          candidates.push(canon);
        }
      }

      if (candidates.length === 1) {
        const canon = candidates[0];
        const title = extractTitleFromPage(lines, canon);
        const isLegit = isLegitimateSection(txt, canon);
        headers.push({
          section: canon,
          title,
          page: pno,
          isLegitimate: isLegit,
        });
        foundPages.add(pno);
        foundSections.add(canon);
        console.log(`[SpecExtractor] PART1 fallback p${pno + 1}: ${canon} - "${title}" (legit: ${isLegit})`);
      }
    }
  }

  return headers;
}

function parseMultiLineHeader(lines: string[], pageNum: number, fullText: string): ExtractedHeader | null {
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const line = lines[i].trim();
    const sectionOnlyMatch = line.match(/^(?:SECTION|SPEC)\s+(10[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\s*$/i);

    if (sectionOnlyMatch && i + 1 < lines.length) {
      const nextLine = lines[i + 1].trim();
      if (/^[A-Z][A-Z\s,&\/\-]+$/.test(nextLine) && nextLine.length >= 5) {
        const canon = canonize(sectionOnlyMatch[1]);
        if (!canon.startsWith("10 ")) continue;
        if (EQUIPMENT_REF_RE.test(sectionOnlyMatch[1])) continue;

        const cleaned = cleanSectionTitle(nextLine);
        const isLegit = isLegitimateSection(fullText, canon);

        return {
          section: canon,
          title: cleaned,
          page: pageNum,
          isLegitimate: isLegit,
        };
      }
    }
  }
  return null;
}

function isLegitimateSection(fullPageText: string, section: string): boolean {
  if (/\d+\s*-\s*\d+/.test(section)) {
    return false;
  }

  const upper = fullPageText.toUpperCase();
  if (upper.includes("PART 1")) {
    return true;
  }

  if (upper.includes("PART 2") || upper.includes("PART 3")) {
    return true;
  }

  for (const marker of CONTENT_MARKERS) {
    if (upper.includes(marker)) {
      return true;
    }
  }

  const sectionCompact = section.replace(/\s/g, "");
  const textCompact = fullPageText.replace(/[\s\-\._]/g, "");
  if (textCompact.includes(sectionCompact)) {
    return true;
  }

  return false;
}

function findSectionStartPage(pages: string[], detectedPage: number, section: string): number {
  const lookBackLimit = Math.min(10, detectedPage + 1);

  const escapedSection = section.replace(/\s+/g, "\\s*[-._]*\\s*");

  for (let lookBack = 0; lookBack < lookBackLimit; lookBack++) {
    const checkPage = detectedPage - lookBack;
    const pageText = pages[checkPage];
    const lines = pageText.split(/[\n\r]+/);
    const topLines = lines.slice(0, 15).join("\n");

    const headerPatterns = [
      new RegExp(`SECTION\\s+${escapedSection}\\s*[-–—]\\s*`, "i"),
      new RegExp(`^${escapedSection}\\s*[-–—]\\s*`, "im"),
    ];

    for (const pattern of headerPatterns) {
      if (pattern.test(topLines)) {
        if (checkPage !== detectedPage) {
          console.log(`[SpecExtractor] Start page for ${section}: moved back from p${detectedPage + 1} to p${checkPage + 1}`);
        }
        return checkPage;
      }
    }

    const pageUpper = pageText.toUpperCase();
    if (pageUpper.includes("PART 1") && pageUpper.includes("GENERAL")) {
      if (pageText.includes(section) || pageText.replace(/[\s\-\._]/g, "").includes(section.replace(/\s/g, ""))) {
        if (checkPage !== detectedPage) {
          console.log(`[SpecExtractor] Start page for ${section}: found PART 1 on p${checkPage + 1}`);
        }
        return checkPage;
      }
    }
  }

  return detectedPage;
}

function detectAnyNewSectionHeader(topZone: string, currentSection: string): string | null {
  for (const pattern of HDR_PATTERNS) {
    const match = pattern.exec(topZone);
    if (match) {
      const rawSec = match[1];
      const canon = canonize(rawSec);
      if (EQUIPMENT_REF_RE.test(rawSec)) continue;
      if (canon !== currentSection) {
        return canon;
      }
    }
  }

  const lines = topZone.split(/[\n\r]+/);
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const line = lines[i].trim();
    const sectionOnlyMatch = line.match(/^(?:SECTION|SPEC)\s+(\d{2}[\s\-\._]*(?:\d{2}[\s\-\._]*\d{2}(?:[\s\-\._]*\d{2})?|\d{4,6}))\s*$/i);
    if (sectionOnlyMatch) {
      const canon = canonize(sectionOnlyMatch[1]);
      if (!EQUIPMENT_REF_RE.test(sectionOnlyMatch[1]) && canon !== currentSection) {
        return canon;
      }
    }
  }

  const standaloneRe = /^\s*(\d{2}[\s\-\._]*\d{2}[\s\-\._]*\d{2})\s*$/m;
  const standaloneMatch = topZone.match(standaloneRe);
  if (standaloneMatch) {
    const canon = canonize(standaloneMatch[1]);
    if (canon !== currentSection && !EQUIPMENT_REF_RE.test(standaloneMatch[1])) {
      const lineIdx = lines.findIndex(l => l.trim() === standaloneMatch[0].trim());
      if (lineIdx >= 0 && lineIdx < 10) {
        const nextLine = lineIdx + 1 < lines.length ? lines[lineIdx + 1].trim() : "";
        if (/^[A-Z][A-Z\s,&\/\-]{3,}/.test(nextLine) || /PART\s+1/i.test(nextLine)) {
          return canon;
        }
      }
    }
  }

  return null;
}

function findSectionEndPage(pages: string[], startPage: number, maxSearchPage: number, section: string): number {
  for (let pageNum = startPage; pageNum <= Math.min(maxSearchPage, pages.length - 1); pageNum++) {
    const pageText = pages[pageNum];
    const pageLines = pageText.split(/[\n\r]+/);

    const linesAfterStart = pageNum === startPage ? pageLines.slice(Math.floor(pageLines.length / 2)) : pageLines;
    for (const line of linesAfterStart) {
      const lineLower = line.toLowerCase().trim();
      for (const marker of END_MARKERS) {
        if (lineLower === marker || (lineLower.includes(marker) && lineLower.length < marker.length + 10)) {
          console.log(`[SpecExtractor] End of section for ${section} at p${pageNum + 1} ("${marker}")`);
          return pageNum;
        }
      }
    }

    if (pageNum > startPage) {
      const topZone = pageLines.slice(0, 20).join("\n");
      const newSection = detectAnyNewSectionHeader(topZone, section);
      if (newSection) {
        console.log(`[SpecExtractor] Next section header ${newSection} found at p${pageNum + 1}, ending ${section} at p${pageNum}`);
        return pageNum - 1;
      }

      const pageUpper = pageText.toUpperCase();
      if (pageUpper.includes("PART 1") && (pageUpper.includes("GENERAL") || pageUpper.includes("SUMMARY"))) {
        const topZoneForPart1 = pageLines.slice(0, 15).join("\n");
        const sectionRe = /\b(\d{2}[\s\-\._]*\d{2}[\s\-\._]*\d{2})\b/g;
        let m2;
        const candidateSections: string[] = [];
        while ((m2 = sectionRe.exec(topZoneForPart1)) !== null) {
          const canon = canonize(m2[1]);
          if (!EQUIPMENT_REF_RE.test(m2[1]) && canon !== section && !candidateSections.includes(canon)) {
            candidateSections.push(canon);
          }
        }
        if (candidateSections.length === 1) {
          console.log(`[SpecExtractor] PART 1 boundary: ${candidateSections[0]} found at p${pageNum + 1}, ending ${section} at p${pageNum}`);
          return pageNum - 1;
        }
      }
    }
  }

  return Math.min(startPage + 10, maxSearchPage);
}

function filterHeaders(headers: ExtractedHeader[], tocBounds: TOCBounds): ExtractedHeader[] {
  const pageCounts: Record<number, number> = {};
  for (const h of headers) {
    pageCounts[h.page] = (pageCounts[h.page] || 0) + 1;
  }

  const eligible: ExtractedHeader[] = [];
  for (const h of headers) {
    if (tocBounds.end >= 0 && h.page <= tocBounds.end) {
      console.log(`[SpecExtractor] Filtering ${h.section} on p${h.page + 1}: within TOC`);
      continue;
    }

    if ((pageCounts[h.page] || 0) > 4) {
      console.log(`[SpecExtractor] Filtering ${h.section} on p${h.page + 1}: index page (${pageCounts[h.page]} sections)`);
      continue;
    }

    if ((pageCounts[h.page] || 0) > 2 && !h.isLegitimate) {
      console.log(`[SpecExtractor] Filtering ${h.section} on p${h.page + 1}: dense page and not legitimate`);
      continue;
    }

    eligible.push(h);
  }

  const div10Pages = eligible.filter(h => h.section.startsWith("10 ")).map(h => h.page).sort((a, b) => a - b);
  let clusterCenter = -1;
  if (div10Pages.length > 0) {
    const mid = Math.floor(div10Pages.length / 2);
    clusterCenter = div10Pages.length % 2 === 0
      ? (div10Pages[mid - 1] + div10Pages[mid]) / 2
      : div10Pages[mid];
  }

  const duplicateGroups = new Map<string, ExtractedHeader[]>();
  for (const h of eligible) {
    const group = duplicateGroups.get(h.section) || [];
    group.push(h);
    duplicateGroups.set(h.section, group);
  }

  const filtered: ExtractedHeader[] = [];
  const seenSections = new Set<string>();

  for (const h of eligible) {
    if (seenSections.has(h.section)) continue;

    const group = duplicateGroups.get(h.section)!;
    if (group.length > 1) {
      const legitimate = group.filter(g => g.isLegitimate);
      let best: ExtractedHeader;
      if (legitimate.length === 1) {
        best = legitimate[0];
      } else if (clusterCenter >= 0 && h.section.startsWith("10 ")) {
        best = group.reduce((a, b) =>
          Math.abs(a.page - clusterCenter) <= Math.abs(b.page - clusterCenter) ? a : b
        );
      } else {
        best = group[group.length - 1];
      }
      for (const g of group) {
        if (g !== best) {
          console.log(`[SpecExtractor] Filtering ${g.section} on p${g.page + 1}: duplicate (keeping p${best.page + 1})`);
        }
      }
      seenSections.add(h.section);
      filtered.push(best);
    } else {
      seenSections.add(h.section);
      filtered.push(h);
    }
  }

  return filtered;
}

function verifyStartPageContent(pages: string[], startPage: number, section: string): boolean {
  const pageText = pages[startPage];
  const lines = pageText.split(/[\n\r]+/);
  const topZone = lines.slice(0, 20).join("\n");

  const sectionDigits = section.replace(/\s/g, "");
  const flexPattern = new RegExp(
    sectionDigits.split("").map((d, i) => {
      if (i > 0 && i % 2 === 0) return `[\\s\\-\\._]*${d}`;
      return d;
    }).join(""),
    "i"
  );

  if (flexPattern.test(topZone)) {
    return true;
  }

  if (topZone.includes(section) || topZone.includes(sectionDigits)) {
    return true;
  }

  return false;
}

function makeRangesFromHeaders(headers: ExtractedHeader[], totalPages: number, pages: string[]): SectionRange[] {
  const ranges: SectionRange[] = [];

  const sorted = [...headers].sort((a, b) => a.page - b.page);

  for (let i = 0; i < sorted.length; i++) {
    const h = sorted[i];

    const start = findSectionStartPage(pages, h.page, h.section);

    let maxEnd: number;
    if (i + 1 < sorted.length) {
      maxEnd = sorted[i + 1].page - 1;
    } else {
      maxEnd = totalPages - 1;
    }

    const end = findSectionEndPage(pages, start, maxEnd, h.section);

    if (!verifyStartPageContent(pages, start, h.section)) {
      console.log(`[SpecExtractor] WARNING: Start page p${start + 1} does not contain section number ${h.section}, checking detected page p${h.page + 1}`);
      const detectedPageVerified = verifyStartPageContent(pages, h.page, h.section);
      if (detectedPageVerified) {
        const correctedEnd = findSectionEndPage(pages, h.page, maxEnd, h.section);
        // No page cap: extract the full detected section. The range is already
        // bounded by the next section's start (maxEnd), so we always keep the
        // complete content rather than truncating long sections.
        const finalEnd = correctedEnd;
        const folderName = getFolderName(h.section, h.title);
        ranges.push({
          section: h.section,
          title: getScopeName(h.section, h.title),
          start: h.page,
          end: finalEnd,
          folderName,
        });
        console.log(`[SpecExtractor] Range (corrected): ${h.section} - "${folderName}" pages ${h.page + 1}-${finalEnd + 1}`);
        continue;
      } else {
        console.log(`[SpecExtractor] WARNING: Neither start p${start + 1} nor detected p${h.page + 1} verified for ${h.section}, using original range`);
      }
    }

    // No page cap: extract the full detected section. findSectionEndPage already
    // bounds the range by the next section's start, so long sections keep their
    // complete content instead of being truncated.
    const finalEnd = end;

    const folderName = getFolderName(h.section, h.title);

    ranges.push({
      section: h.section,
      title: getScopeName(h.section, h.title),
      start,
      end: finalEnd,
      folderName,
    });

    console.log(`[SpecExtractor] Range: ${h.section} - "${folderName}" pages ${start + 1}-${finalEnd + 1}`);
  }

  return ranges;
}

function findHintedSections(
  pages: string[],
  hints: TOCHint[],
  tocBounds: TOCBounds,
  alreadyFound: Set<string>
): ExtractedHeader[] {
  const hintedHeaders: ExtractedHeader[] = [];

  for (const hint of hints) {
    if (alreadyFound.has(hint.section)) {
      console.log(`[SpecExtractor] Hint ${hint.section}: already found by standard scan`);
      continue;
    }

    const sectionDigits = hint.section.replace(/\s/g, "");
    const flexPattern = new RegExp(
      sectionDigits.split("").map((d, i) => {
        if (i > 0 && i % 2 === 0) return `[\\s\\-\\._]*${d}`;
        return d;
      }).join(""),
      "i"
    );

    let bestPage = -1;
    let bestScore = 0;
    let bestTitle = hint.title || "";

    for (let pno = 0; pno < pages.length; pno++) {
      if (tocBounds.end >= 0 && pno <= tocBounds.end) continue;

      const txt = pages[pno];
      const lines = txt.split(/[\n\r]+/);
      const topZone = lines.slice(0, 25).join("\n");
      const fullText = txt;

      let score = 0;

      if (flexPattern.test(topZone)) {
        score += 20;
      } else if (flexPattern.test(fullText)) {
        score += 5;
      } else {
        continue;
      }

      const upper = fullText.toUpperCase();
      if (upper.includes("PART 1") && upper.includes("GENERAL")) score += 15;
      if (upper.includes("PART 2")) score += 5;
      if (upper.includes("PART 3")) score += 5;

      for (const marker of CONTENT_MARKERS) {
        if (upper.includes(marker)) { score += 2; break; }
      }

      for (const marker of END_MARKERS) {
        if (fullText.toLowerCase().includes(marker)) { score += 3; break; }
      }

      const hasHeader = /(?:SECTION|SPEC)\s+\d{2}/i.test(topZone);
      if (hasHeader) score += 10;

      if (score > bestScore) {
        bestScore = score;
        bestPage = pno;

        const extractedTitle = extractTitleFromHeader(topZone);
        if (extractedTitle && extractedTitle.length >= 3) {
          bestTitle = extractedTitle;
        }
      }
    }

    if (bestPage >= 0 && bestScore >= 15) {
      const title = bestTitle || DEFAULT_SCOPES[hint.section] || DEFAULT_SCOPES[parentKey(hint.section)] || "Unknown Section";

      hintedHeaders.push({
        section: hint.section,
        title,
        page: bestPage,
        isLegitimate: true,
      });

      console.log(`[SpecExtractor] Hint-guided match: ${hint.section} - "${title}" on p${bestPage + 1} (score: ${bestScore})`);
    } else {
      console.log(`[SpecExtractor] Hint ${hint.section}: no match found (best score: ${bestScore})`);
    }
  }

  return hintedHeaders;
}

export async function extractPages(pdfBuffer: Buffer): Promise<string[]> {
  const uint8 = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useSystemFonts: true,
  });
  const pdfDoc = await loadingTask.promise;
  const numPages = pdfDoc.numPages;

  const pageTexts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const items = textContent.items as any[];
    if (items.length === 0) {
      pageTexts.push("");
      continue;
    }
    const filtered = items.filter((item: any) => item.str && item.str.trim().length > 0);
    const fontHeights = filtered
      .map((item: any) => Math.abs(item.transform[3] || item.height || 0))
      .filter((h: number) => h > 1);
    const avgFontHeight = fontHeights.length > 0
      ? fontHeights.reduce((sum: number, h: number) => sum + h, 0) / fontHeights.length
      : 10;
    const lineThreshold = Math.max(2, avgFontHeight * 0.4);
    const sorted = filtered.sort((a: any, b: any) => {
      const yDiff = b.transform[5] - a.transform[5];
      if (Math.abs(yDiff) > lineThreshold) return yDiff;
      return a.transform[4] - b.transform[4];
    });
    let text = "";
    let lastY: number | null = null;
    for (const item of sorted) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > lineThreshold) {
        text += "\n";
      } else if (lastY !== null) {
        text += " ";
      }
      text += item.str;
      lastY = y;
    }
    pageTexts.push(text);
  }

  return pageTexts;
}

export async function runExtraction(
  pdfBuffer: Buffer,
  onProgress?: ProgressCallback,
  tocHints?: TOCHint[]
): Promise<ExtractionResult> {
  onProgress?.(5, "Parsing PDF text...");

  const pages = await extractPages(pdfBuffer);
  const totalPages = pages.length;
  console.log(`[SpecExtractor] Total pages: ${totalPages}`);

  if (totalPages === 0) {
    throw new Error("This PDF has no pages, or could not be read. Please confirm the file is a valid PDF and try again.");
  }
  if (!pages.some(p => p.trim().length > 0)) {
    throw new Error("No selectable text was found in this PDF — it may be a scanned/image-only document. Please run OCR (e.g. Acrobat 'Recognize Text') and re-upload.");
  }

  onProgress?.(15, "Detecting Table of Contents...");

  const tocBounds = detectTOCBounds(pages);

  onProgress?.(25, "Scanning for Division 10 section headers...");

  const rawHeaders = findDiv10Headers(pages, tocBounds);
  console.log(`[SpecExtractor] Raw headers found: ${rawHeaders.length}`);

  onProgress?.(50, "Filtering and validating sections...");

  const filteredHeaders = filterHeaders(rawHeaders, tocBounds);
  console.log(`[SpecExtractor] Filtered headers: ${filteredHeaders.length}`);

  let allHeaders = [...filteredHeaders];

  if (tocHints && tocHints.length > 0) {
    onProgress?.(60, `Using ${tocHints.length} TOC hints to find additional sections...`);
    console.log(`[SpecExtractor] Processing ${tocHints.length} TOC hints`);

    const alreadyFound = new Set(filteredHeaders.map(h => h.section));
    const hintedHeaders = findHintedSections(pages, tocHints, tocBounds, alreadyFound);
    console.log(`[SpecExtractor] Hint-guided scan found ${hintedHeaders.length} additional sections`);

    allHeaders = [...filteredHeaders, ...hintedHeaders];
  }

  onProgress?.(70, "Calculating page ranges...");

  const sections = makeRangesFromHeaders(allHeaders, totalPages, pages);
  console.log(`[SpecExtractor] Final sections: ${sections.length}`);

  onProgress?.(90, "Extraction complete");

  return {
    sections,
    tocBounds,
    totalPages,
  };
}

export async function extractSectionPdf(
  sourcePdfPath: string,
  startPage: number,
  endPage: number
): Promise<Uint8Array> {
  if (!fs.existsSync(sourcePdfPath)) {
    throw new Error(`Source PDF not found: ${sourcePdfPath}`);
  }

  let totalPages: number;
  try {
    const npagesOutput = execFileSync("qpdf", ["--show-npages", sourcePdfPath], { timeout: 10000 }).toString().trim();
    totalPages = parseInt(npagesOutput, 10);
  } catch {
    totalPages = Infinity;
  }

  const validStart = Math.max(0, Math.min(startPage, totalPages - 1));
  const validEnd = Math.max(validStart, Math.min(endPage, totalPages - 1));

  if (validStart !== startPage || validEnd !== endPage) {
    console.warn(`[SpecExtractor] Clamped page range ${startPage}-${endPage} to ${validStart}-${validEnd} (total: ${totalPages})`);
  }

  const pageStart = validStart + 1;
  const pageEnd = validEnd + 1;
  const pageCount = pageEnd - pageStart + 1;

  console.log(`[SpecExtractor] Extracting pages ${pageStart}-${pageEnd} (${pageCount} pages) using qpdf`);

  const tmpOut = path.join(os.tmpdir(), `se_extract_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`);

  try {
    execFileSync("qpdf", [
      sourcePdfPath,
      "--pages", ".", `${pageStart}-${pageEnd}`, "--",
      tmpOut,
    ], { timeout: 30000 });

    const result = fs.readFileSync(tmpOut);
    if (result.length === 0) {
      throw new Error(`qpdf produced empty output for pages ${pageStart}-${pageEnd}`);
    }
    return new Uint8Array(result);
  } catch (err: any) {
    if (err.message?.includes("qpdf produced empty")) throw err;
    throw new Error(`PDF extraction failed for pages ${pageStart}-${pageEnd}: ${err.message}`);
  } finally {
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}
