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
 * Fields the normal BC Sync list fetch populates. A GET-by-id response can be
 * a lean summary that omits the office/company expansion (the region source)
 * and the expected start/finish dates — when any of these are missing the
 * opportunity is treated as incomplete and backfilled from the list fetch.
 */
export function missingOpportunityFields(opp: BcOpportunity): string[] {
  const missing: string[] = [];
  if (!opp.gcCompanyName && !opp.gcOfficeHint) missing.push("gcCompanyName/gcOfficeHint");
  if (!opp.expectedStart) missing.push("expectedStart");
  if (!opp.expectedFinish) missing.push("expectedFinish");
  if (!opp.bidDueDate) missing.push("bidDueDate");
  if (!opp.invitedDate) missing.push("invitedDate");
  if (!opp.gcContactName) missing.push("gcContactName");
  if (!opp.gcContactEmail) missing.push("gcContactEmail");
  if (!opp.squareFeet) missing.push("squareFeet");
  if (!opp.scopes || opp.scopes.length === 0) missing.push("scopes");
  if (!opp.projectId) missing.push("projectId");
  if (!opp.location?.formattedAddress && !opp.location?.city && !opp.location?.state) missing.push("location");
  return missing;
}

export function opportunityIsComplete(opp: BcOpportunity): boolean {
  return missingOpportunityFields(opp).length === 0;
}

/**
 * Field-level merge of two normalized opportunities: prefer the primary
 * (GET-by-id — most direct) value when present, fill anything empty from the
 * backfill (list-fetch) record, including the nested location and scopes.
 */
export function mergeOpportunities(primary: BcOpportunity, backfill: BcOpportunity): BcOpportunity {
  const merged: BcOpportunity = { ...primary };
  for (const key of Object.keys(backfill) as (keyof BcOpportunity)[]) {
    if (key === "location" || key === "scopes") continue;
    const primaryVal = merged[key];
    const backfillVal = backfill[key];
    if ((primaryVal == null || primaryVal === "") && backfillVal != null && backfillVal !== "") {
      (merged as Record<string, any>)[key] = backfillVal;
    }
  }
  const pLoc = primary.location || {};
  const bLoc = backfill.location || {};
  merged.location = {
    city: pLoc.city || bLoc.city,
    state: pLoc.state || bLoc.state,
    formattedAddress: pLoc.formattedAddress || bLoc.formattedAddress,
  };
  if ((!primary.scopes || primary.scopes.length === 0) && backfill.scopes && backfill.scopes.length > 0) {
    merged.scopes = backfill.scopes;
  }
  return merged;
}

/**
 * Backfill a lean GET-by-id record from the list fetch (the exact source BC
 * Sync uses, which returns the expanded record). Never downgrades a successful
 * GET — on any list-fetch failure or miss the partial record is returned as-is.
 */
export async function backfillFromListFetch(
  token: string,
  opportunity: BcOpportunity,
  rawOpp: Record<string, any>,
): Promise<BcPullResult> {
  try {
    const { opportunities, error } = await fetchBcOpportunities(token, undefined, true);
    if (error) {
      console.warn(`[EmailIntake] BC list backfill fetch error (keeping partial GET-by-id data): ${error}`);
      return { status: "enriched", opportunity, raw: rawOpp };
    }
    const match = opportunities.find(
      o =>
        o.id === opportunity.id ||
        (opportunity.projectId && o.projectId === opportunity.projectId),
    );
    if (!match) {
      console.warn(`[EmailIntake] BC list backfill: opportunity ${opportunity.id} not in list results, keeping partial GET-by-id data`);
      return { status: "enriched", opportunity, raw: rawOpp };
    }
    const merged = mergeOpportunities(opportunity, match);
    const stillMissing = missingOpportunityFields(merged);
    const backfilled = missingOpportunityFields(opportunity).filter(f => !stillMissing.includes(f));
    console.log(`[EmailIntake] BC list backfill for ${opportunity.id}: filled [${backfilled.join(", ")}]${stillMissing.length ? `, still missing [${stillMissing.join(", ")}]` : ""}`);
    return { status: "enriched", opportunity: merged, raw: { ...rawOpp, _listBackfill: match } };
  } catch (err: any) {
    console.warn(`[EmailIntake] BC list backfill failed (keeping partial GET-by-id data): ${err.message}`);
    return { status: "enriched", opportunity, raw: rawOpp };
  }
}

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
            const missing = missingOpportunityFields(opportunity);
            if (missing.length === 0) {
              return { status: "enriched", opportunity, raw: rawOpp };
            }
            // The GET-by-id response can be a lean summary that omits the
            // office/company expansion (region source), expected start/finish
            // dates, and more. Backfill from the list fetch — the same source
            // BC Sync uses — before mapping to an entry.
            console.log(`[EmailIntake] BC GET-by-id record for ${ids.opportunityId} is missing [${missing.join(", ")}] — backfilling from list fetch`);
            return await backfillFromListFetch(token, opportunity, rawOpp);
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
