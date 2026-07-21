import type { Region } from "@shared/schema";
import { formatRegionDisplay } from "./regionMatcher";

export interface RegionMatchResult {
  code: string;
  displayLabel: string;
  confident: boolean;
}

/**
 * Returns true if the GC/client name is Swinerton.
 */
export function isSwinerton(clientName: string): boolean {
  return /swinerton/i.test(clientName || "");
}

/**
 * Offices that should intentionally return blank — too vague to assign a region.
 * The estimator will assign manually.
 */
const BLANK_OFFICE_PATTERNS: RegExp[] = [
  /^los angeles,?\s*(ca)?$/i,
  /^santa ana,?\s*(ca)?$/i,
  /^main office$/i,
  /ocla.*special\s*projects/i,
];

/**
 * Given a Swinerton office string (the part after "Swinerton Builders - "),
 * returns the matching RegionMatchResult.
 *
 * Returns confident=true + empty code/label for intentionally-blank offices.
 * Returns confident=false for completely unrecognized offices.
 */
export function matchSwinertonOffice(
  officeStr: string,
  regions: Region[]
): RegionMatchResult {
  const office = (officeStr || "").toLowerCase().trim();

  if (!office) return { code: "", displayLabel: "", confident: false };

  // --- Intentionally blank offices (too vague) ---
  for (const pattern of BLANK_OFFICE_PATTERNS) {
    if (pattern.test(office)) {
      return { code: "", displayLabel: "", confident: true };
    }
  }

  const findFirst = (code: string, name?: string): Region | undefined =>
    regions.find(r =>
      r.code === code && (name === undefined || r.name === name)
    );

  const result = (code: string, name?: string): RegionMatchResult => {
    const region = findFirst(code, name);
    if (!region) return { code, displayLabel: name ? `${code} - ${name}` : code, confident: true };
    return { code: region.code, displayLabel: formatRegionDisplay(region), confident: true };
  };

  // --- LAX - TM ---
  if (/parking\s*structures?/i.test(office) || /target\s*markets?/i.test(office)) {
    return result("LAX", "TM");
  }

  // --- LAX - OCLA (specific Santa Ana offices only; "Special Projects" already caught above) ---
  if (/\bocla\b/i.test(office)) {
    return result("LAX", "OCLA");
  }

  // --- SEA ---
  if (/seattle|bellevue/i.test(office)) {
    return result("SEA");
  }

  // --- GEG ---
  if (/spokane/i.test(office)) {
    return result("GEG");
  }

  // --- PDX ---
  // Two distinct PDX office rows exist (PDX - Portland, PDX - Idaho/Boise).
  // Passing name=undefined into result() would match whichever PDX row
  // happens to come first in the regions array — resolve the sub-office
  // explicitly instead of relying on array order.
  if (/portland/i.test(office)) {
    return result("PDX", "Portland");
  }
  if (/boise|idaho/i.test(office)) {
    return result("PDX", "Idaho");
  }

  // --- SFO ---
  if (/norcal|nor\s*cal|bay\s*area|cameron\s*park|fresno|san\s*jose|santa\s*clara|san\s*francisco|fairfield/i.test(office)) {
    return result("SFO");
  }

  // --- CLT ---
  if (/charlotte|greenville|foley/i.test(office)) {
    return result("CLT");
  }

  // --- DFW ---
  if (/dallas/i.test(office)) {
    return result("DFW");
  }

  // --- DEN ---
  if (/denver|colorado/i.test(office)) {
    return result("DEN");
  }

  // --- HNL ---
  if (/hawaii|honolulu/i.test(office)) {
    return result("HNL");
  }

  // --- LGA ---
  if (/new\s*york|summit[\s,]+nj/i.test(office)) {
    return result("LGA");
  }

  // --- SAN ---
  if (/san\s*diego/i.test(office)) {
    return result("SAN");
  }

  // Unrecognized — leave blank, estimator decides
  return { code: "", displayLabel: "", confident: false };
}

/**
 * Special-case resolver for Swinerton SoCal sub-regions.
 *
 * Background: BC labels like "Swinerton Builders - SoCal - Target Markets"
 * were sometimes being matched to a plain "LAX" or to the wrong LAX bucket.
 * AiPM splits SoCal into 4 internal buckets:
 *   - LAX - TM   (Target Markets)
 *   - LAX - SPD  (Special Projects)
 *   - LAX - OCLA (Orange County / new construction / residential)
 *   - LAX - FS   (Facility Solutions)
 *
 * Behavior:
 *   - Only fires when the combined text contains BOTH "swinerton" and "socal"
 *     (so the existing general resolver still owns every other case).
 *   - Uses word-boundary regex so short tokens (tm, fs, ti, spd) cannot match
 *     inside unrelated words (e.g. "atmosphere", "estimating", "offsite").
 *   - Priority order is fixed: TM > SPD > OCLA > FS.
 *   - If SoCal is detected but no sub-region phrase is present, returns
 *     confident=false with socalDetected=true so the caller can leave Region
 *     blank and flag the entry for manual review (we never guess).
 *
 * The caller decides whether to fall through to the general resolver:
 *   - socalDetected=false → fall through to existing matchSwinertonOffice
 *   - socalDetected=true  → use this result as-is (matched OR manual review)
 */
export interface SwinertonSoCalResolution extends RegionMatchResult {
  socalDetected: boolean;
}

const SWINERTON_RE = /\bswinerton\b/i;
const SOCAL_RE = /\bso\s*cal\b|\bsocal\b|\bsouthern\s+california\b/i;

const TM_RE = /\btarget\s*markets?\b|\btm\b/i;
const SPD_RE =
  /\bspecial\s+projects?\b|\bspd\b|\btenant\s+improvements?\b|\bti\b|\brenovations?\b|\bremodel(?:ing)?\b|\bbuild[\s-]?out\b/i;
const OCLA_RE =
  /\bocla\b|\borange\s+county\b|\bcore\s*(?:&|and)?\s*shell\b|\bground[\s-]?up\b|\bnew\s+construction\b|\bnew\s+build\b|\bresidential\b/i;
const FS_RE = /\bfacility\s+solutions?\b|\bfs\b|\bfacility\b/i;

export function resolveSwinertonSoCalSubregion(
  textSources: (string | undefined | null)[],
  regions: Region[],
): SwinertonSoCalResolution {
  const normalized = textSources
    .filter((s): s is string => Boolean(s))
    .map(s => String(s).toLowerCase())
    .join(" | ");

  if (!SWINERTON_RE.test(normalized) || !SOCAL_RE.test(normalized)) {
    return { code: "", displayLabel: "", confident: false, socalDetected: false };
  }

  const buildResult = (code: string, name: string): SwinertonSoCalResolution => {
    const region = regions.find(r => r.code === code && r.name === name);
    if (region) {
      return {
        code: region.code,
        displayLabel: formatRegionDisplay(region),
        confident: true,
        socalDetected: true,
      };
    }
    return {
      code,
      displayLabel: `${code} - ${name}`,
      confident: true,
      socalDetected: true,
    };
  };

  // Priority 1 — Target Markets
  if (TM_RE.test(normalized)) return buildResult("LAX", "TM");

  // Priority 2 — Special Projects
  if (SPD_RE.test(normalized)) return buildResult("LAX", "SPD");

  // Priority 3 — OCLA
  if (OCLA_RE.test(normalized)) return buildResult("LAX", "OCLA");

  // Priority 4 — Facility Solutions
  if (FS_RE.test(normalized)) return buildResult("LAX", "FS");

  // SoCal recognized but no sub-region clue — leave blank for manual review.
  return { code: "", displayLabel: "", confident: false, socalDetected: true };
}

/**
 * For a non-Swinerton GC, find the matching EXT region by GC name.
 * Returns the EXT region if found, otherwise blank.
 */
export function matchExtRegion(
  clientName: string,
  regions: Region[]
): RegionMatchResult {
  const extRegions = regions.filter(r => r.code === "EXT");
  const client = (clientName || "").toLowerCase();

  for (const region of extRegions) {
    const name = (region.name || "").toLowerCase();
    if (name && client.includes(name)) {
      return { code: region.code, displayLabel: formatRegionDisplay(region), confident: true };
    }
    // Also try the reverse — region name contains a word from client name
    const words = name.split(/\s+/).filter(w => w.length > 3);
    if (words.some(w => client.includes(w))) {
      return { code: region.code, displayLabel: formatRegionDisplay(region), confident: true };
    }
  }

  // Not a known EXT GC — leave blank
  return { code: "", displayLabel: "", confident: false };
}
