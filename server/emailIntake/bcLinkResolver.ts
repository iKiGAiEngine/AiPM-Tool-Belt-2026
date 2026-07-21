import { extractBcLink, normalizeBcLink } from "../screenshotExtractor";
import type { ParsedEmail } from "./emailParser";

/**
 * Resolves the BuildingConnected invite link out of a parsed email.
 * BC invite emails rarely link straight to app.buildingconnected.com — the
 * link is usually wrapped in a login redirect (?continueUrl=...) and/or an
 * email-tracking host, so this module unwraps those layers deterministically
 * before falling back to a bounded redirect-follow.
 */

const REDIRECT_PARAM_NAMES = ["continueurl", "continue", "url", "redirect", "redirect_uri", "destination", "target", "u", "upn"];

const TRACKER_HOST_PATTERNS = [
  /(^|\.)links\.buildingconnected\.com$/i,
  /(^|\.)ct\.sendgrid\.net$/i,
  /(^|\.)sendgrid\.net$/i,
  /^click\./i,
  /^links?\./i,
  /(^|\.)mandrillapp\.com$/i,
  /(^|\.)mailgun\.(net|org)$/i,
];

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function tryBase64Decode(value: string): string | null {
  if (!/^[A-Za-z0-9+/_=-]{16,}$/.test(value)) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    // Only accept printable results that look like URLs
    if (/^https?:\/\//i.test(decoded) && !/[\x00-\x08\x0e-\x1f]/.test(decoded)) return decoded;
  } catch {
    /* not base64 */
  }
  return null;
}

/**
 * Unwrap one layer of redirect/tracking from a URL. Returns null when no
 * embedded target is found.
 */
function unwrapOnce(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // 1) Query params that contain a full URL or a path on app.buildingconnected.com
  for (const [key, rawValue] of Array.from(parsed.searchParams.entries())) {
    if (!REDIRECT_PARAM_NAMES.includes(key.toLowerCase())) continue;
    const value = safeDecode(rawValue);
    if (/^https?:\/\//i.test(value)) return value;
    const b64 = tryBase64Decode(rawValue);
    if (b64) return b64;
    // Path-only continueUrl (e.g. /opportunities/abc...) → resolve against BC app host
    if (value.startsWith("/")) return `https://app.buildingconnected.com${value}`;
  }

  // 2) URL-encoded or base64 payload embedded in the path (common tracker style)
  const pathDecoded = safeDecode(parsed.pathname);
  const embedded = pathDecoded.match(/https?:\/\/[^\s"'<>]+/i);
  if (embedded && embedded[0] !== url) return embedded[0];
  for (const seg of parsed.pathname.split("/")) {
    const b64 = tryBase64Decode(seg);
    if (b64) return b64;
  }

  return null;
}

/** Fully unwrap a URL (bounded), returning a BC app link if one emerges. */
export function unwrapToBcLink(url: string): string | null {
  let current = url;
  for (let i = 0; i < 5; i++) {
    const direct = normalizeBcLink(current) || extractBcLink(safeDecode(current));
    if (direct && !/\/login\b/i.test(new URL(direct).pathname)) return direct;
    const next = unwrapOnce(current);
    if (!next || next === current) break;
    current = next;
  }
  const last = normalizeBcLink(current) || extractBcLink(safeDecode(current));
  if (!last) return null;
  try {
    // A login link whose target we couldn't unwrap is not a usable BC link
    if (/\/login\b/i.test(new URL(last).pathname)) return null;
  } catch {
    return null;
  }
  return last;
}

function isTrackerHost(url: string): boolean {
  try {
    return TRACKER_HOST_PATTERNS.some(p => p.test(new URL(url).hostname));
  } catch {
    return false;
  }
}

/**
 * BuildingConnected's own short-link redirects (e.g. the "View this RFP" /
 * "Bidding" action buttons in newer invite templates link to
 * app.buildingconnected.com/goto/<code>, not directly to /opportunities/<id>).
 * These look like "direct" BC links by host, but the id is only revealed by
 * following the redirect — same treatment as an external tracker host.
 */
function isBcShortLink(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)buildingconnected\.com$/i.test(u.hostname) && /^\/goto\//i.test(u.pathname);
  } catch {
    return false;
  }
}

function hasResolvableId(link: string): boolean {
  const ids = extractOpportunityIdFromLink(link);
  return !!(ids.opportunityId || ids.projectId);
}

/**
 * Last-resort unwrap: follow redirects (HEAD, no body) to see where a tracking
 * link lands. Bounded to 3 hops / 5s per hop. Network failure is non-fatal.
 */
export async function followTrackerRedirects(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal: controller.signal });
      clearTimeout(timer);
      const location = res.headers.get("location");
      if (!location) return null;
      const resolved = new URL(location, current).toString();
      const bc = unwrapToBcLink(resolved);
      if (bc) return bc;
      current = resolved;
    } catch (err: any) {
      console.warn(`[EmailIntake] Tracker redirect follow failed for ${current.slice(0, 120)}: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Find the BuildingConnected link in a parsed email.
 * Order: HTML anchor hrefs (buttons) → raw text → tracking-link redirect follow.
 */
export async function findBcLink(email: ParsedEmail, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const candidates = [...email.hrefs, email.text, email.html || ""];

  // A link that resolves to a BC host but carries no extractable opportunity/
  // project id (e.g. a /goto/ short-link) isn't good enough to enrich from —
  // keep it as a fallback, but keep looking for something with a real id.
  let bestUnresolvedCandidate: string | null = null;

  // Pass 1: deterministic — direct links and unwrappable redirect params
  for (const candidate of email.hrefs) {
    const bc = unwrapToBcLink(candidate);
    if (!bc) continue;
    if (hasResolvableId(bc)) return bc;
    bestUnresolvedCandidate = bestUnresolvedCandidate || bc;
  }
  for (const blob of [email.text, email.html || ""]) {
    const direct = extractBcLink(blob);
    if (direct) {
      const bc = unwrapToBcLink(direct);
      if (bc) {
        if (hasResolvableId(bc)) return bc;
        bestUnresolvedCandidate = bestUnresolvedCandidate || bc;
      }
    }
    // Wrapped links sitting in plain text (e.g. login?continueUrl=…)
    const wrapped = blob.match(/https?:\/\/[^\s"'<>]*buildingconnected\.com[^\s"'<>]*/gi) || [];
    for (const w of wrapped) {
      const bc = unwrapToBcLink(w.replace(/[.,;:]+$/, ""));
      if (bc) {
        if (hasResolvableId(bc)) return bc;
        bestUnresolvedCandidate = bestUnresolvedCandidate || bc;
      }
    }
  }

  // Pass 2: network — follow known external tracker hosts, and BuildingConnected's
  // own /goto/ short-links (Pass 1 accepted these as "direct" by host, but the
  // real opportunity id only comes out after following the redirect).
  for (const candidate of candidates.slice(0, 20)) {
    if (typeof candidate !== "string" || !/^https?:\/\//i.test(candidate)) continue;
    if (!isTrackerHost(candidate) && !isBcShortLink(candidate)) continue;
    const bc = await followTrackerRedirects(candidate, fetchImpl);
    if (bc) return bc;
  }

  // Nothing yielded an extractable id — fall back to whatever BC-hosted link
  // we found so "View on BC" still has somewhere to point, even though
  // enrichment itself will report no_link/not_found for it.
  return bestUnresolvedCandidate;
}

export interface BcLinkIds {
  opportunityId: string | null;
  projectId: string | null;
}

/**
 * Extract the opportunity and/or project id from a BC app link.
 * Handles /opportunities/{id}, /projects/{id}, and /projects/{id}/opportunities/{id}.
 */
export function extractOpportunityIdFromLink(link: string): BcLinkIds {
  const ids: BcLinkIds = { opportunityId: null, projectId: null };
  if (!link) return ids;
  const decoded = safeDecode(link);
  const oppMatch = decoded.match(/\/opportunities\/([0-9a-f]{24})/i);
  if (oppMatch) ids.opportunityId = oppMatch[1].toLowerCase();
  const projMatch = decoded.match(/\/projects\/([0-9a-f]{24})/i);
  if (projMatch) ids.projectId = projMatch[1].toLowerCase();
  return ids;
}
