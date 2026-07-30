// Types & Quantities (T&Q) lead-time math.
//
// Single source of truth for "how many business days before the bid due date did
// we receive the types and quantities?". Imported by the report service and its
// tests. Deliberately dependency-free so it runs in Node and the browser.
//
// The business-day count mirrors bizDaysUntil() in public/tools/proposal-log.html
// so report numbers agree with the "Bid Due Dates" panel already in that tool:
// weekdays are counted in the half-open range (from, to] — i.e. the start day is
// excluded and the end day is included when it is a weekday.

export type TqBucket =
  | "ample"
  | "comfortable"
  | "tight"
  | "crunch"
  | "bid_day"
  | "late"
  | "not_received"
  | "unmeasurable";

export const TQ_BUCKET_LABELS: Record<TqBucket, string> = {
  ample: "15+ BD ahead",
  comfortable: "8–14 BD ahead",
  tight: "4–7 BD ahead",
  crunch: "1–3 BD ahead",
  bid_day: "Bid day",
  late: "After bid day",
  not_received: "Never received",
  unmeasurable: "No due date",
};

// Worst-to-best is the useful reading order for a report, but the stacked
// distribution bar reads best-to-worst. Keep both explicit.
export const TQ_BUCKET_ORDER: TqBucket[] = [
  "ample",
  "comfortable",
  "tight",
  "crunch",
  "bid_day",
  "late",
  "not_received",
  "unmeasurable",
];

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a 'YYYY-MM-DD' string into a local-midnight Date.
 *
 * Built from explicit components rather than `new Date(str)` — the latter parses
 * bare date strings as UTC, which shifts the day backwards for anyone west of
 * Greenwich and would silently move every lead time by one day.
 *
 * Returns null for empty, malformed, or non-existent dates (e.g. 2026-02-30)
 * rather than an Invalid Date, so callers never propagate NaN.
 */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = ISO_DATE_RE.exec(String(value).trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day, 0, 0, 0, 0);
  // Rejects rollovers like 2026-02-30 → Mar 2
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/** Format a Date back to 'YYYY-MM-DD' in local time. */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isWeekend(d: Date): boolean {
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

/**
 * Signed count of business days between two dates, weekends excluded.
 *
 * Counts weekdays in (from, to] — same-day is 0, and the result is negative when
 * `to` falls before `from`. Holidays are not modeled; NBS bid calendars treat
 * holidays inconsistently by region and guessing would be worse than not trying.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());

  if (end.getTime() === start.getTime()) return 0;

  const backwards = end < start;
  const lo = backwards ? end : start;
  const hi = backwards ? start : end;

  let count = 0;
  const cur = new Date(lo);
  while (cur < hi) {
    cur.setDate(cur.getDate() + 1);
    if (!isWeekend(cur)) count++;
  }
  return backwards ? -count : count;
}

/**
 * Business days between receiving the types & quantities and the bid due date.
 *
 * Positive  → received that many business days ahead of bid day.
 * Zero      → received on bid day.
 * Negative  → received after bid day.
 * null      → not measurable (either date missing or malformed).
 */
export function tqLeadBusinessDays(
  receivedDate: string | null | undefined,
  dueDate: string | null | undefined,
): number | null {
  const received = parseIsoDate(receivedDate);
  const due = parseIsoDate(dueDate);
  if (!received || !due) return null;
  return businessDaysBetween(received, due);
}

/**
 * Classify a bid by how much runway the estimator had.
 *
 * Thresholds mirror the existing due-date buckets on the Proposal Log dashboard
 * (0-3 / 4-7 / 8-14 / 15+) so the two views tell a consistent story.
 */
export function leadBucket(days: number | null, received: boolean): TqBucket {
  if (!received) return "not_received";
  if (days === null) return "unmeasurable";
  if (days < 0) return "late";
  if (days === 0) return "bid_day";
  if (days <= 3) return "crunch";
  if (days <= 7) return "tight";
  if (days <= 14) return "comfortable";
  return "ample";
}

/** True when the bid had 3 or fewer business days of runway (but wasn't late). */
export function isCrunch(days: number | null): boolean {
  return days !== null && days >= 0 && days <= 3;
}

/** Today's date in the business timezone, as 'YYYY-MM-DD'. */
export const BUSINESS_TIMEZONE = "America/Los_Angeles";

export function todayInBusinessTz(now: Date = new Date()): string {
  // 'en-CA' formats as YYYY-MM-DD, which is exactly the storage format.
  return now.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
}
