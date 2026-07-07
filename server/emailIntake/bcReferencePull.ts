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

const GET_BY_ID_BASES = [
  "https://developer.api.autodesk.com/buildingconnected/v2/bid-board/opportunities",
  "https://developer.api.autodesk.com/construction/buildingconnected/v2/opportunities",
];

/**
 * Fetch a single BuildingConnected opportunity referenced by a bid-invite email.
 * Uses the dropping user's own APS OAuth connection (same as BC Sync).
 * Every failure mode is a status, never a throw — an email-only draft is
 * always still created upstream.
 */
export async function pullBcOpportunity(
  userId: number,
  ids: BcLinkIds,
  fetchImpl: typeof fetch = fetch,
): Promise<BcPullResult> {
  if (!ids.opportunityId && !ids.projectId) {
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

  // 2) Fallback: list fetch (the exact path BC Sync uses) and filter by id.
  //    Also the only path when the link gave a projectId but no opportunityId.
  try {
    const { opportunities, error } = await fetchBcOpportunities(token, undefined, true);
    if (error) {
      console.warn("[EmailIntake] BC list-fetch fallback error:", error);
      return { status: "fetch_failed" };
    }
    const match = opportunities.find(
      o =>
        (ids.opportunityId && o.id === ids.opportunityId) ||
        (ids.projectId && o.projectId === ids.projectId),
    );
    if (match) {
      console.log(`[EmailIntake] BC list-fetch fallback matched opportunity ${match.id}`);
      return { status: "enriched", opportunity: match, raw: match as unknown as Record<string, any> };
    }
  } catch (err: any) {
    console.warn("[EmailIntake] BC list-fetch fallback failed:", err.message);
    return { status: "fetch_failed" };
  }

  return { status: sawFetchError ? "fetch_failed" : "not_found" };
}
