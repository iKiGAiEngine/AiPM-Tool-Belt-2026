// Pure rules for "same project, different scope" BC invites.
//
// Business rule: invites for the same project are bundled into ONE bid.
// Bundling is a UNION: every scope and every BC opportunity ID survives on one
// live record. Nothing is deleted without a surviving record that holds it.
//
// No database access in this file so the rules can be tested on their own.

import { normalizeProjectName, tokenize, jaccardSimilarity } from "../fuzzyDuplicates";

export interface EntryLike {
  id: number;
  projectName: string;
  projectAddress?: string | null;
  scopeList?: string | null;
  bcOpportunityIds?: string | null;
  estimateNumber?: string | null;
  region?: string | null;
  dueDate?: string | null;
  squareFeet?: string | null;
  gcEstimateLead?: string | null;
  anticipatedStart?: string | null;
  anticipatedFinish?: string | null;
  isDraft?: boolean | null;
  deletedAt?: Date | null;
  pendingDeletion?: boolean | null;
  isTest?: boolean | null;
}

export const MAX_BUNDLE_SIZE = 10;
const RELATED_THRESHOLD = 0.6;

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string" && x.trim()) : [];
  } catch {
    return [];
  }
}

export function normScope(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normAddress(a: string | null | undefined): string {
  return (a || "")
    .toLowerCase()
    .replace(/\b(united states|usa)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Union of scopes, de-duplicated ignoring case/spacing, keeping first-seen spelling and order. */
export function unionScopes(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list) {
      const k = normScope(s);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(s.trim());
    }
  }
  return out;
}

export function unionIds(...lists: string[][]): string[] {
  return Array.from(new Set(lists.flat()));
}

/** Scopes of `a` that are NOT covered by `b` (case/spacing-insensitive). */
export function missingScopes(a: string[], b: string[]): string[] {
  const have = new Set(b.map(normScope));
  return a.filter((s) => !have.has(normScope(s)));
}

export type Relation = "same" | "related" | "none";

interface Keys { norm: string; tokens: Set<string>; addr: string }
function keysOf(e: EntryLike): Keys {
  const norm = normalizeProjectName(e.projectName || "");
  return { norm, tokens: tokenize(norm), addr: normAddress(e.projectAddress) };
}

function relationOfKeys(a: Keys, b: Keys): Relation {
  if (!a.norm || !b.norm) return "none";
  const addressConflict = !!a.addr && !!b.addr && a.addr !== b.addr;
  if (a.norm === b.norm) return addressConflict ? "related" : "same";
  return jaccardSimilarity(a.tokens, b.tokens) >= RELATED_THRESHOLD ? "related" : "none";
}

/**
 * "same":    identical project name (ignoring filler words like LLC/Inc/Phase) AND the address
 *            does not contradict (equal, or one side is blank).
 * "related": similar name but not identical, or identical name with a DIFFERENT address.
 *            Needs a human decision; never acted on automatically.
 */
export function relation(a: EntryLike, b: EntryLike): Relation {
  return relationOfKeys(keysOf(a), keysOf(b));
}

export function isLive(e: EntryLike): boolean {
  return !e.deletedAt && !e.pendingDeletion && !e.isTest;
}

export interface GroupMember {
  id: number;
  isDraft: boolean;
  estimateNumber: string | null;
  projectName: string;
  projectAddress: string | null;
  scopes: string[];
  region: string | null;
  dueDate: string | null;
  bcOpportunityIds: string[];
}

export interface DraftGroup {
  strength: "same" | "related";
  members: GroupMember[];
  /** Entry the others should be combined INTO. */
  suggestedPrimaryId: number;
  draftIds: number[];
  /** Drafts whose every scope is already covered by another member: true repeat invites. */
  repeatDraftIds: number[];
}

function toMember(e: EntryLike): GroupMember {
  return {
    id: e.id,
    isDraft: !!e.isDraft,
    estimateNumber: e.estimateNumber ?? null,
    projectName: e.projectName,
    projectAddress: e.projectAddress ?? null,
    scopes: parseJsonArray(e.scopeList),
    region: e.region ?? null,
    dueDate: e.dueDate ?? null,
    bcOpportunityIds: parseJsonArray(e.bcOpportunityIds),
  };
}

/** Pick the survivor: an already-approved live entry first, else the draft with a region, else the oldest. */
export function pickPrimary(members: GroupMember[]): number {
  const approved = members.filter((m) => !m.isDraft).sort((a, b) => a.id - b.id);
  if (approved.length) return approved[0].id;
  const withRegion = members.filter((m) => (m.region || "").trim()).sort((a, b) => a.id - b.id);
  if (withRegion.length) return withRegion[0].id;
  return [...members].sort((a, b) => a.id - b.id)[0].id;
}

/** Group live drafts with other live entries about the same project. Groups always contain at least one draft. */
export function groupSameProject(entries: EntryLike[]): DraftGroup[] {
  const live = entries.filter(isLive);
  const keys = live.map(keysOf); // computed once per entry, not once per pair
  const n = live.length;
  const rel: Relation[][] = Array.from({ length: n }, () => Array(n).fill("none"));
  const parent = live.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Two approved entries are never grouped here: only drafts need a decision.
      if (!live[i].isDraft && !live[j].isDraft) continue;
      const r = relationOfKeys(keys[i], keys[j]);
      rel[i][j] = rel[j][i] = r;
      if (r !== "none") union(i, j);
    }
  }

  const comps = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(i);
  }

  const groups: DraftGroup[] = [];
  for (const idxs of Array.from(comps.values())) {
    if (idxs.length < 2) continue;
    if (!idxs.some((i) => live[i].isDraft)) continue;

    // "same" only if the group is connected using "same" links alone.
    const p2 = idxs.map((_, k) => k);
    const f2 = (k: number): number => (p2[k] === k ? k : (p2[k] = f2(p2[k])));
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        if (rel[idxs[a]][idxs[b]] === "same") p2[f2(a)] = f2(b);
      }
    }
    const strong = new Set(idxs.map((_, k) => f2(k))).size === 1;

    const members = idxs.map((i) => toMember(live[i])).sort((a, b) => a.id - b.id);
    const repeatDraftIds = members
      .filter((m) => m.isDraft)
      .filter((m) =>
        members.some((o) => o.id !== m.id && m.scopes.length > 0 && missingScopes(m.scopes, o.scopes).length === 0),
      )
      .map((m) => m.id);

    groups.push({
      strength: strong ? "same" : "related",
      members,
      suggestedPrimaryId: pickPrimary(members),
      draftIds: members.filter((m) => m.isDraft).map((m) => m.id),
      repeatDraftIds,
    });
  }
  return groups.sort((a, b) => a.members[0].id - b.members[0].id);
}

export interface BundlePlan {
  scopes: string[];
  bcOpportunityIds: string[];
  addedScopes: string[];
  dueDate: string | null;
  fillFields: Partial<Record<"region" | "projectAddress" | "squareFeet" | "gcEstimateLead" | "anticipatedStart" | "anticipatedFinish", string>>;
  notes: string[];
}

function validDate(s: string | null | undefined): string | null {
  if (!s) return null;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

/** Work out the combined record. Never drops a scope or a BC ID; never overwrites a filled-in field. */
export function planBundle(primary: EntryLike, others: EntryLike[]): BundlePlan {
  const primaryScopes = parseJsonArray(primary.scopeList);
  const scopes = unionScopes(primaryScopes, ...others.map((o) => parseJsonArray(o.scopeList)));
  const bcOpportunityIds = unionIds(
    parseJsonArray(primary.bcOpportunityIds),
    ...others.map((o) => parseJsonArray(o.bcOpportunityIds)),
  );
  const addedScopes = missingScopes(scopes, primaryScopes);

  const notes: string[] = [];

  // A combined bid must meet the EARLIEST due date. Keep the earliest, and say so if they differed.
  const dates = [primary, ...others].map((e) => validDate(e.dueDate)).filter((d): d is string => !!d);
  let dueDate: string | null = primary.dueDate ?? null;
  if (dates.length) {
    const earliest = [...dates].sort()[0];
    if (earliest !== validDate(primary.dueDate)) dueDate = earliest;
    if (new Set(dates).size > 1) {
      notes.push(`Due dates differed (${Array.from(new Set(dates)).sort().join(", ")}); kept the earliest, ${earliest}.`);
    }
  }

  const fillFields: BundlePlan["fillFields"] = {};
  const keys = ["region", "projectAddress", "squareFeet", "gcEstimateLead", "anticipatedStart", "anticipatedFinish"] as const;
  for (const k of keys) {
    const have = ((primary[k] as string | null | undefined) || "").trim();
    const candidates = others.map((o) => ((o[k] as string | null | undefined) || "").trim()).filter(Boolean);
    if (!have && candidates.length) fillFields[k] = candidates[0];
    if (have && candidates.some((c) => c !== have) && k === "region") {
      notes.push(`Regions differed (kept "${have}"; other invite said "${candidates.find((c) => c !== have)}"). Please confirm.`);
    }
  }

  return { scopes, bcOpportunityIds, addedScopes, dueDate, fillFields, notes };
}

export type BundleCheck = { ok: true } | { ok: false; status: number; message: string };

/** Validate a bundle request against live data. `all` is every entry, used to recompute the groups. */
export function validateBundle(primaryId: number, otherIds: number[], all: EntryLike[]): BundleCheck {
  if (!Number.isInteger(primaryId)) return { ok: false, status: 400, message: "Invalid primary entry" };
  if (!Array.isArray(otherIds) || otherIds.length === 0) return { ok: false, status: 400, message: "Nothing to combine" };
  if (otherIds.length > MAX_BUNDLE_SIZE) return { ok: false, status: 400, message: `Too many invites (max ${MAX_BUNDLE_SIZE})` };
  if (otherIds.some((i) => !Number.isInteger(i))) return { ok: false, status: 400, message: "Invalid entry ID" };
  if (new Set(otherIds).size !== otherIds.length) return { ok: false, status: 400, message: "Duplicate IDs in request" };
  if (otherIds.includes(primaryId)) return { ok: false, status: 400, message: "An invite cannot be combined into itself" };

  const byId = new Map(all.map((e) => [e.id, e]));
  const primary = byId.get(primaryId);
  if (!primary) return { ok: false, status: 404, message: "Entry to combine into was not found" };
  if (!isLive(primary)) return { ok: false, status: 409, message: "The entry to combine into is deleted or pending deletion" };

  for (const id of otherIds) {
    const o = byId.get(id);
    if (!o) return { ok: false, status: 404, message: `Invite #${id} was not found` };
    if (!o.isDraft) return { ok: false, status: 409, message: `Invite #${id} is already approved; only pending invites can be combined into another entry` };
    if (!isLive(o)) return { ok: false, status: 409, message: `Invite #${id} is deleted or pending deletion` };
  }

  // Everything must belong to one computed group, so a bad ID can never pull in an unrelated project.
  const wanted = new Set([primaryId, ...otherIds]);
  const group = groupSameProject(all).find((g) => g.members.some((m) => m.id === primaryId));
  if (!group || Array.from(wanted).some((id) => !group.members.some((m) => m.id === id))) {
    return { ok: false, status: 409, message: "These invites are not recognised as the same project" };
  }
  return { ok: true };
}

/** Can `entry` be removed as a duplicate of `survivor` without losing any scope? */
export function checkDuplicateOf(entry: EntryLike, survivor: EntryLike | undefined): BundleCheck {
  if (!survivor) return { ok: false, status: 400, message: "Choose which existing entry this duplicates" };
  if (survivor.id === entry.id) return { ok: false, status: 400, message: "An invite cannot be a duplicate of itself" };
  if (!isLive(survivor)) return { ok: false, status: 409, message: "That entry is deleted or pending deletion, so it cannot hold this invite" };
  if (relation(entry, survivor) === "none") return { ok: false, status: 409, message: "That entry is not the same project" };
  const lost = missingScopes(parseJsonArray(entry.scopeList), parseJsonArray(survivor.scopeList));
  if (lost.length > 0) {
    return { ok: false, status: 409, message: `Not a duplicate: "${lost.join('", "')}" is not covered by the other entry. Use "Combine into one bid" so the scope is kept.` };
  }
  return { ok: true };
}

/** The only columns grouping needs. Selecting just these avoids loading big blobs (screenshots, raw email) for every entry. */
export const GROUPING_COLUMNS = [
  "id", "projectName", "projectAddress", "scopeList", "bcOpportunityIds", "estimateNumber", "region", "dueDate",
  "squareFeet", "gcEstimateLead", "anticipatedStart", "anticipatedFinish", "isDraft", "deletedAt", "pendingDeletion", "isTest",
] as const;
