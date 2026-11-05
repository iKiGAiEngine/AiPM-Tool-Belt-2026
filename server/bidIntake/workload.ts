// Pure calculation helpers for the homepage "Bid Intake" panel.
// No database or network imports here on purpose, so these can be unit-tested
// on their own (see workload.test.ts).

export const ACTIVE_STATUSES = ["Lead", "Estimating", "Revising"] as const;

// How far back we look to figure out who is on the estimator roster and what
// regions / markets each person has experience with.
export const ROSTER_WINDOW_DAYS = 120;

export interface EntryLike {
  id: number;
  projectName: string | null;
  owner: string | null;
  region: string | null;
  primaryMarket: string | null;
  dueDate: string | null;
  inviteDate: string | null;
  nbsEstimator: string | null;
  estimateStatus: string | null;
  isDraft: boolean | null;
  isTest: boolean | null;
  deletedAt: Date | null;
  createdAt: Date;
  draftApprovedAt: Date | null;
  ndaRequired: boolean | null;
  regionNeedsReview: boolean | null;
  bcLink: string | null;
  sourceType: string | null;
}

export interface UserLike {
  displayName: string | null;
  email: string;
  initials: string | null;
  isActive: boolean;
}

export interface PendingDraft {
  id: number;
  projectName: string;
  gc: string;
  region: string;
  market: string;
  dueDate: string;
  daysUntilDue: number | null;
  waitingHours: number;
  ndaRequired: boolean;
  regionNeedsReview: boolean;
  bcLink: string;
  sourceType: string;
}

export interface EstimatorWorkload {
  code: string;
  name: string;
  active: number;
  overdue: number;
  dueWithin3Days: number;
  dueWithin7Days: number;
  newLast7Days: number;
  nextDueDate: string | null;
  topRegions: string[];
  topMarkets: string[];
  /** active + 2 x due-within-3-days + 2 x overdue. Lower = more room. */
  loadScore: number;
  lightest: boolean;
}

/** "AB, cd / ef" -> ["AB", "CD", "EF"] */
export function parseEstimatorCodes(value: string | null | undefined): string[] {
  return (value || "")
    .split(/[,;/|]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** Calendar date (YYYY-MM-DD) of `now` in the given time zone. */
export function todayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole calendar days from `today` to `dateStr` (negative = overdue). null if unparseable. */
export function daysBetween(today: string, dateStr: string | null | undefined): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

function topN(counts: Map<string, number>, n: number): string[] {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k]) => k);
}

function bump(map: Map<string, number>, key: string | null | undefined) {
  const k = (key || "").trim();
  if (k) map.set(k, (map.get(k) || 0) + 1);
}

/** Draft = a bid invite that has been pulled in but not yet approved / rejected. */
export function isPendingDraft(e: EntryLike): boolean {
  return !!e.isDraft && !e.deletedAt && !e.isTest;
}

export function buildPendingDrafts(entries: EntryLike[], today: string, now: Date, limit: number): {
  count: number;
  oldestWaitingHours: number | null;
  items: PendingDraft[];
} {
  const drafts = entries.filter(isPendingDraft);
  const items: PendingDraft[] = drafts.map((e) => ({
    id: e.id,
    projectName: e.projectName || "(untitled)",
    gc: e.owner || "",
    region: e.region || "",
    market: e.primaryMarket || "",
    dueDate: e.dueDate || "",
    daysUntilDue: daysBetween(today, e.dueDate),
    waitingHours: Math.max(0, Math.round((now.getTime() - new Date(e.createdAt).getTime()) / 3_600_000)),
    ndaRequired: !!e.ndaRequired,
    regionNeedsReview: !!e.regionNeedsReview,
    bcLink: e.bcLink || "",
    sourceType: e.sourceType || "",
  }));

  // Most urgent first: soonest due date, undated last, then longest waiting.
  items.sort((a, b) => {
    const ad = a.daysUntilDue ?? Number.POSITIVE_INFINITY;
    const bd = b.daysUntilDue ?? Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return b.waitingHours - a.waitingHours;
  });

  return {
    count: items.length,
    oldestWaitingHours: items.length ? Math.max(...items.map((i) => i.waitingHours)) : null,
    items: items.slice(0, limit),
  };
}

export function buildWorkload(
  entries: EntryLike[],
  users: UserLike[],
  today: string,
  now: Date,
): EstimatorWorkload[] {
  const nameByCode = new Map<string, string>();
  for (const u of users) {
    if (!u.isActive || !u.initials) continue;
    nameByCode.set(u.initials.trim().toUpperCase(), u.displayName || u.email);
  }

  const windowStart = now.getTime() - ROSTER_WINDOW_DAYS * 86_400_000;
  const weekAgo = now.getTime() - 7 * 86_400_000;

  interface Acc {
    active: number; overdue: number; due3: number; due7: number; new7: number;
    nextDue: string | null;
    regions: Map<string, number>; markets: Map<string, number>;
  }
  const byCode = new Map<string, Acc>();
  const get = (code: string): Acc => {
    let a = byCode.get(code);
    if (!a) {
      a = { active: 0, overdue: 0, due3: 0, due7: 0, new7: 0, nextDue: null, regions: new Map(), markets: new Map() };
      byCode.set(code, a);
    }
    return a;
  };

  for (const e of entries) {
    if (e.isDraft || e.deletedAt || e.isTest) continue;
    const codes = parseEstimatorCodes(e.nbsEstimator);
    if (codes.length === 0) continue;

    const startedAt = new Date(e.draftApprovedAt || e.createdAt).getTime();
    const recent = startedAt >= windowStart;
    const isActive = (ACTIVE_STATUSES as readonly string[]).includes(e.estimateStatus || "");
    if (!recent && !isActive) continue;

    const days = daysBetween(today, e.dueDate);
    for (const code of codes) {
      const a = get(code); // being on the roster only needs one recent / active bid
      if (recent) {
        bump(a.regions, e.region);
        bump(a.markets, e.primaryMarket);
      }
      if (startedAt >= weekAgo) a.new7++;
      if (!isActive) continue;
      a.active++;
      if (days !== null) {
        if (days < 0) a.overdue++;
        else {
          if (days <= 3) a.due3++;
          if (days <= 7) a.due7++;
          if (!a.nextDue || (e.dueDate as string) < a.nextDue) a.nextDue = e.dueDate as string;
        }
      }
    }
  }

  // A registered user with initials but no bids lately is the *best* person to
  // give work to, so make sure they still appear (with zeros).
  nameByCode.forEach((_n, code) => get(code));

  const rows: EstimatorWorkload[] = Array.from(byCode.entries()).map(([code, a]) => ({
    code,
    name: nameByCode.get(code) || code,
    active: a.active,
    overdue: a.overdue,
    dueWithin3Days: a.due3,
    dueWithin7Days: a.due7,
    newLast7Days: a.new7,
    nextDueDate: a.nextDue,
    topRegions: topN(a.regions, 2),
    topMarkets: topN(a.markets, 2),
    loadScore: a.active + 2 * a.due3 + 2 * a.overdue,
    lightest: false,
  }));

  rows.sort((a, b) => a.loadScore - b.loadScore || a.name.localeCompare(b.name));
  if (rows.length > 1) rows[0].lightest = true;
  return rows;
}

/**
 * BC invites that exist in BuildingConnected but have never been pulled into
 * the app (no row in bc_sync_log) - i.e. what the next "Pull" would find.
 */
export function countUnpulledInvites<T extends { id: string }>(opps: T[], loggedOpportunityIds: Set<string>): number {
  const seen = new Set<string>();
  for (const o of opps) {
    if (!loggedOpportunityIds.has(o.id)) seen.add(o.id);
  }
  return seen.size;
}
