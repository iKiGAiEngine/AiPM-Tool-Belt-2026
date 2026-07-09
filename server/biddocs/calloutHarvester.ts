import { planParserStorage } from "../planparser/storage";
import { classifyPage } from "../planparser/classifier";
import {
  getClassificationConfigFromDB,
  type ClassificationConfig,
} from "../planparser/classificationConfig";
import { getAllScopeDictionaries } from "../scopeDictionaryStorage";
import { loadPositionedWords, findMatchBoxes } from "./highlighter";
import type { ParsedPage, PlanParserScope, MatchBox } from "@shared/schema";
import { PLAN_PARSER_SCOPES } from "@shared/schema";

/**
 * Default type-mark prefixes per scope, used when a scope dictionary has no
 * calloutPrefixes configured. A mark like "WP-1" on a floor plan often has
 * no other text tying the sheet to Wall Protection — these prefixes are how
 * schedule-defined marks get trusted.
 */
const DEFAULT_CALLOUT_PREFIXES: Record<string, string[]> = {
  "Toilet Accessories": ["TA", "BA", "RA"],
  "Toilet Partitions": ["TP", "TC"],
  "Wall Protection": ["WP", "CG", "CR", "WG"],
  "Fire Extinguisher Cabinets": ["FEC", "FE"],
  "Cubicle Curtains": ["CC", "CT"],
  "Visual Display": ["MB", "TB", "VD"],
  "Lockers": ["LK", "L"],
  "Shelving": ["SH"],
};

/** A schedule page's harvested marks, with provenance for whyFlagged. */
export interface HarvestedCallouts {
  scope: PlanParserScope;
  callouts: string[];
  sourceDescription: string; // e.g. "Wall Protection schedule, Sheet A-601 (page 12 of A-Drawings.pdf)"
}

const SCHEDULE_HINT = /schedule/i;

// Sheet number in a title block, e.g. A-601, A6.01, TA101
const SHEET_NUMBER_RE = /\b([A-Z]{1,2}[-.]?\d{1,3}(?:\.\d{1,2})?)\b/g;

/**
 * Extract the most likely sheet number from a page's OCR text (title blocks
 * OCR near the end of the text stream more often than not, so the last
 * distinct match wins). Best-effort — used for provenance strings only.
 */
export function guessSheetNumber(ocrText: string): string | null {
  const tail = ocrText.slice(-1500);
  const matches = Array.from(tail.matchAll(SHEET_NUMBER_RE), m => m[1]);
  if (matches.length > 0) return matches[matches.length - 1];
  const all = Array.from(ocrText.matchAll(SHEET_NUMBER_RE), m => m[1]);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * Harvest type-mark callouts (e.g. WP-1, CG-2, FEC-1) from a schedule page's
 * OCR text, restricted to the prefixes trusted for that scope.
 */
export function harvestCalloutsFromText(
  ocrText: string,
  prefixes: string[],
): string[] {
  if (prefixes.length === 0) return [];
  const found = new Set<string>();
  const prefixAlt = prefixes
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  // Mark = trusted prefix + separator (- or space or none) + 1-3 digits,
  // bounded so grid lines ("A1") and dimensions don't slip through via
  // longer prefixes.
  const re = new RegExp(`\\b(${prefixAlt})[-\\s]?(\\d{1,3})\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(ocrText)) !== null) {
    const normalized = `${m[1].toUpperCase()}-${m[2]}`;
    found.add(normalized);
  }
  return Array.from(found);
}

async function getCalloutPrefixMap(): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = { ...DEFAULT_CALLOUT_PREFIXES };
  try {
    const dicts = await getAllScopeDictionaries();
    for (const dict of dicts) {
      if (dict.isActive && Array.isArray(dict.calloutPrefixes) && dict.calloutPrefixes.length > 0) {
        map[dict.scopeName] = dict.calloutPrefixes.map(p => p.toUpperCase());
      }
    }
  } catch (err) {
    console.error("[CalloutPass] Failed to load callout prefixes from scope dictionaries:", err);
  }
  return map;
}

/**
 * Schedule-driven callout expansion pass.
 *
 * 1. Find pages already classified to a scope whose text looks like a
 *    schedule; harvest that scope's type marks from them.
 * 2. Re-scan EVERY page of the job for those marks. Pages that carry a mark
 *    but weren't flagged get pulled into the scope, tagged matchType
 *    "callout", with whyFlagged citing the source schedule sheet. Pages
 *    already flagged by keywords get the callout boxes merged in
 *    (matchType "both").
 *
 * Returns the harvested callouts per scope for run bookkeeping.
 */
export async function runCalloutPass(
  jobId: string,
  selectedScopes?: string[],
): Promise<Record<string, string[]>> {
  const job = await planParserStorage.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  const pages = await planParserStorage.getPagesByJob(jobId);
  if (pages.length === 0) return {};

  const prefixMap = await getCalloutPrefixMap();
  const scopeFilter = selectedScopes && selectedScopes.length > 0 ? new Set(selectedScopes) : null;

  // --- 1. Harvest marks from schedule pages, per scope -----------------
  const harvested: Map<string, { callouts: Set<string>; sources: string[] }> = new Map();

  for (const page of pages) {
    if (!page.isRelevant || !SCHEDULE_HINT.test(page.ocrText)) continue;
    for (const tag of page.tags) {
      if (scopeFilter && !scopeFilter.has(tag)) continue;
      const prefixes = prefixMap[tag] || [];
      const marks = harvestCalloutsFromText(page.ocrText, prefixes);
      if (marks.length === 0) continue;

      const sheet = guessSheetNumber(page.ocrText);
      const source = `${tag} schedule${sheet ? `, Sheet ${sheet}` : ""} (page ${page.pageNumber} of ${page.originalFilename})`;
      const entry = harvested.get(tag) || { callouts: new Set<string>(), sources: [] };
      marks.forEach(mk => entry.callouts.add(mk));
      if (!entry.sources.includes(source)) entry.sources.push(source);
      harvested.set(tag, entry);
    }
  }

  if (harvested.size === 0) {
    console.log(`[CalloutPass] Job ${jobId}: no Div 10 schedules with harvestable marks found`);
    return {};
  }

  for (const [scope, entry] of Array.from(harvested.entries())) {
    console.log(`[CalloutPass] Job ${jobId}: ${scope} → ${Array.from(entry.callouts).join(", ")} (from ${entry.sources.join("; ")})`);
  }

  // --- 2. Re-scan all pages for harvested marks ------------------------
  const jobDir = planParserStorage.getJobDirectory(jobId);
  let addedPages = 0;

  for (const page of pages) {
    const calloutHits: Array<{ scope: string; callout: string; source: string }> = [];

    for (const [scope, entry] of Array.from(harvested.entries())) {
      for (const callout of Array.from(entry.callouts)) {
        // Word-boundary match, tolerating "WP-1", "WP 1", "WP1"
        const [prefix, num] = callout.split("-");
        const re = new RegExp(`\\b${prefix}[-\\s]?${num}\\b`, "i");
        if (re.test(page.ocrText)) {
          calloutHits.push({ scope, callout, source: entry.sources[0] });
        }
      }
    }

    if (calloutHits.length === 0) continue;

    const newScopes = Array.from(new Set(calloutHits.map(h => h.scope))) as PlanParserScope[];
    const mergedTags = Array.from(new Set([...page.tags, ...newScopes])) as PlanParserScope[];
    const wasRelevant = page.isRelevant;

    // Compute highlight boxes for the callout hits from the word sidecar
    const words = loadPositionedWords(jobDir, page.originalFilename, page.pageNumber);
    const calloutBoxes: MatchBox[] = words.length > 0
      ? findMatchBoxes(words, calloutHits.map(h => ({ term: h.callout, scope: h.scope })))
      : [];
    const existingBoxes = page.matchBoxes || [];
    const mergedBoxes = [...existingBoxes];
    for (const box of calloutBoxes) {
      const dup = existingBoxes.some(
        b => b.keyword === box.keyword && Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2,
      );
      if (!dup) mergedBoxes.push(box);
    }

    const calloutSummary = Array.from(new Set(calloutHits.map(h => `${h.callout} (defined in ${h.source})`))).join("; ");
    const whyFlagged = wasRelevant
      ? `${page.whyFlagged} | Callouts: ${calloutSummary}`
      : `Callout match: ${calloutSummary}`;

    await planParserStorage.updatePage(page.id, {
      isRelevant: true,
      tags: mergedTags,
      confidence: wasRelevant ? page.confidence : Math.max(page.confidence, 60),
      whyFlagged,
      matchBoxes: mergedBoxes,
      matchType: wasRelevant && page.matchType !== "none" ? "both" : "callout",
    });

    if (!wasRelevant) addedPages++;
  }

  // --- 3. Refresh job counters -----------------------------------------
  const refreshed = await planParserStorage.getPagesByJob(jobId);
  const scopeCounts: Record<string, number> = {};
  PLAN_PARSER_SCOPES.forEach(s => { scopeCounts[s] = 0; });
  let flaggedCount = 0;
  for (const p of refreshed) {
    if (p.isRelevant) {
      flaggedCount++;
      for (const tag of p.tags) {
        scopeCounts[tag] = (scopeCounts[tag] || 0) + 1;
      }
    }
  }
  await planParserStorage.updateJob(jobId, {
    flaggedPages: flaggedCount,
    scopeCounts,
    message: `Callout pass complete: ${addedPages} page(s) added via schedule callouts.`,
  });

  console.log(`[CalloutPass] Job ${jobId}: ${addedPages} pages newly flagged via callouts`);

  const result: Record<string, string[]> = {};
  for (const [scope, entry] of Array.from(harvested.entries())) {
    result[scope] = Array.from(entry.callouts);
  }
  return result;
}
