export type QuantityVerificationStatus =
  | "corroborated"
  | "human-confirmed"
  | "unverified"
  | "conflict"
  | "not-applicable";

export const QUANTITY_UNCORROBORATED_FLAG = "Quantity uncorroborated";
export const QUANTITY_CONFLICT_FLAG = "Quantity reader disagreement";
export const EXTRACTION_INCOMPLETE_FLAG = "Extraction incomplete";

export interface ScheduleReviewState {
  confidence: number;
  flags: string[];
  quantityVerification?: QuantityVerificationStatus;
}

export function addScheduleFlag(flags: string[], flag: string): void {
  if (!flags.includes(flag)) flags.push(flag);
}

export function applyQuantityVerificationFlag(
  flags: string[],
  status: QuantityVerificationStatus,
): void {
  if (status === "unverified") {
    addScheduleFlag(flags, QUANTITY_UNCORROBORATED_FLAG);
  } else if (status === "conflict") {
    addScheduleFlag(flags, QUANTITY_CONFLICT_FLAG);
  }
}

export function needsScheduleReview(item: ScheduleReviewState): boolean {
  const quantityNeedsReview =
    item.quantityVerification === "unverified" ||
    item.quantityVerification === "conflict";

  return item.confidence < 90 || item.flags.length > 0 || quantityNeedsReview;
}

export function markExtractionIncomplete<T extends ScheduleReviewState & { needsReview: boolean }>(
  items: T[],
): T[] {
  return items.map((item) => {
    const flags = [...item.flags];
    addScheduleFlag(flags, EXTRACTION_INCOMPLETE_FLAG);
    const updated = {
      ...item,
      flags,
      confidence: Math.min(item.confidence, 70),
    };
    return {
      ...updated,
      needsReview: needsScheduleReview(updated),
    };
  });
}
