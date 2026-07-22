import { getValidToken } from "../autodesk/tokenManager";
import { normalizeOpportunity, fetchBcOpportunities, type BcOpportunity } from "../autodesk/bcSync";
import type { BcLinkIds } from "./bcLinkResolver";

export type BcEnrichmentStatus =
  | "enriched"
  | "no_link"
  | "no_connection"
  | "not_found"
  | "fetch_failed"
  | "nda_restricted";

export interface BcPullResult {
  status: BcEnrichmentStatus;
  opportunity?: BcOpportunity;
  raw?: Record<string, any>;
}

/**
 * Content hints for resolving an opportunity when the invite link carries no
 * extractable id. Newer BC invite emails link via app.buildingconnected.com/goto/<code>
 * short-links, which only reveal the real opportunity id after an authenticated
 * redirect we can't reliably follow — so we fall back to matching the dropping
 * user's own bid-board list by project name (and due date to disambiguate).
 */
export interface BcMatchHint {
  projectName?: string | null;
  dueDate?: string | null;
}

const GET_BY_ID_BASES = [
  "https://developer.api.autodesk.com/buildingconnected/v2/bid-board/opportunities",
  "https://developer.api.autodesk.com/construction/buildingconnected/v2/opportunities",
];

// Normalize a project name for tolerant comparison: lowercase, punctuation and
// runs of non-alphanumerics collapsed to single spaces. So "DPS Gateway E-5
// 100% CDs: Building Specialties" → "dps gateway e 5 100 cds building specialties".
function normalizeProjectName(name: string | null | undefined): string {
  return (name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// True when two project names refer to the same project. Exact after
// normalization, or one is a whole-word prefix of the other — BC invite emails
// append the trade to the project name ("<Project>: <Trade>"), so the email's
// name is often the BC name plus a trade suffix. The shared portion must be
// substantial (>=10 chars) so short names can't collide.
export function projectNamesMatch(a: string, b: string): boolean {
  const na = normalizeProjectName(a);
  const nb = normalizeProjectName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length < 10) return false;
  return longer === shorter || longer.startsWith(shorter + " ");
}

/**
 * Fetch a single BuildingConnected opportunity referenced by a bid-invite email.
 * Uses the dropping user's own APS OAuth connection (same as BC Sync).
 * Every failure mode is a status, never a throw — an email-only draft is
 * always still created upstream.
 *
 * When `ids` yields no opportunity/project id (e.g. a /goto/ short-link) but a
 * `hint.projectName` is supplied, the opportunity is resolved by matching the
 * user's bid-board list by name — this is how enrichment (and therefore the
 * BC-only fields like Expected Start/Finish) still runs for the newer invite
 * template that only links via short-links.
 */
export async function pullBcOpportunity(
  userId: number,
  ids: BcLinkIds,
  fetchImpl: typeof fetch = fetch,
  hint: BcMatchHint = {},
): Promise<BcPullResult> {
  const hasId = !!(ids.opportunityId || ids.projectId);
  const hasNameHint = !!(hint.projectName && normalizeProjectName(hint.projectName).length >= 10);
  if (!hasId && !hasNameHint) {
    return { status: "no_link" };
  }

  let token: string | null = null;
  try {
    token = await getValidToken(userId);
  } catch (err: any) {
    console.warn("[EmailIntake] BC token lookup failed:", err.message);
  }
  if (!token) {
    return { status: "no_connection" };
  }

  let sawFetchError = false;

  // 1) Direct GET-by-id on both API bases (bid-board first — invite emails
  //    reference the sub's own opportunity)
  if (ids.opportunityId) {
    for (const base of GET_BY_ID_BASES) {
      const url = `${base}/${ids.opportunityId}`;
      try {
        const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const data = (await res.json()) as Record<string, any>;
          // Some APS endpoints nest the resource under `data`
          const rawOpp = data && data.data && !Array.isArray(data.data) ? data.data : data;
          if (rawOpp && (rawOpp.id || rawOpp._id)) {
            const opportunity = normalizeOpportunity(rawOpp);
            console.log(`[EmailIntake] BC GET-by-id hit on ${base.includes("bid-board") ? "Bid Board" : "GC"} API for ${ids.opportunityId}`);
            return { status: "enriched", opportunity, raw: rawOpp };
          }
        } else if (res.status !== 404) {
          const errText = await res.text();
          console.warn(`[EmailIntake] BC GET-by-id ${res.status} on ${url}: ${errText.slice(0, 200)}`);
          if (res.status !== 400 && res.status !== 403) sawFetchError = true;
        }
      } catch (err: any) {
        console.warn(`[EmailIntake] BC GET-by-id fetch error on ${url}: ${err.message}`);
        sawFetchError = true;
      }
    }
  }

  // 2) Fallback: list fetch (the exact path BC Sync uses). Match by id when we
  //    have one; otherwise (the /goto/ short-link case) match by project name so
  //    enrichment still runs and the BC-only fields carry over.
  try {
    const { opportunities, error } = await fetchBcOpportunities(token, undefined, true);
    if (error) {
      console.warn("[EmailIntake] BC list-fetch fallback error:", error);
      return { status: "fetch_failed" };
    }

    const idMatch = hasId
      ? opportunities.find(
          o =>
            (ids.opportunityId && o.id === ids.opportunityId) ||
            (ids.projectId && o.projectId === ids.projectId),
        )
      : undefined;
    if (idMatch) {
      console.log(`[EmailIntake] BC list-fetch fallback matched opportunity ${idMatch.id} by id`);
      return { status: "enriched", opportunity: idMatch, raw: idMatch as unknown as Record<string, any> };
    }

    if (hint.projectName) {
      const nameMatches = opportunities.filter(o => projectNamesMatch(o.projectName || "", hint.projectName!));
      let chosen: BcOpportunity | undefined;
      if (nameMatches.length === 1) {
        chosen = nameMatches[0];
      } else if (nameMatches.length > 1 && hint.dueDate) {
        // Disambiguate multiple same-name opportunities by the bid due date.
        chosen = nameMatches.find(o => (o.bidDueDate || "").startsWith(hint.dueDate!)) || undefined;
      }
      if (chosen) {
        console.log(`[EmailIntake] BC list-fetch fallback matched opportunity ${chosen.id} by name "${chosen.projectName}"`);
        return { status: "enriched", opportunity: chosen, raw: chosen as unknown as Record<string, any> };
      }
      if (nameMatches.length > 1) {
        console.warn(`[EmailIntake] BC name-match ambiguous for "${hint.projectName}" (${nameMatches.length} candidates, no due-date match) — not guessing.`);
      }
    }
  } catch (err: any) {
    console.warn("[EmailIntake] BC list-fetch fallback failed:", err.message);
    return { status: "fetch_failed" };
  }

  return { status: sawFetchError ? "fetch_failed" : "not_found" };
}
