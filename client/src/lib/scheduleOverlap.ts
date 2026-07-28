export const CROSS_SCREENSHOT_DUPLICATE_FLAG = "Possible duplicate across screenshots";

export interface OverlapScheduleItem {
  planCallout: string;
  description: string;
  manufacturer: string;
  rawModel: string;
  modelNumber: string;
  quantity: number;
  flags: string[];
  needsReview: boolean;
  confidence: number;
  sourceIndex?: number;
}

function normalize(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function tokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(normalize(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalize(b).split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection++;
  }
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function isLikelyOverlap(a: OverlapScheduleItem, b: OverlapScheduleItem): boolean {
  if (a.sourceIndex === undefined || b.sourceIndex === undefined || a.sourceIndex === b.sourceIndex) {
    return false;
  }

  const calloutA = compact(a.planCallout);
  const calloutB = compact(b.planCallout);
  const modelA = compact(a.modelNumber || a.rawModel);
  const modelB = compact(b.modelNumber || b.rawModel);
  const manufacturerA = compact(a.manufacturer);
  const manufacturerB = compact(b.manufacturer);
  const descriptionSimilarity = tokenSimilarity(a.description, b.description);

  const exactSignatureA = [calloutA, normalize(a.description), manufacturerA, modelA, a.quantity].join("|");
  const exactSignatureB = [calloutB, normalize(b.description), manufacturerB, modelB, b.quantity].join("|");
  if (exactSignatureA === exactSignatureB) return true;

  const sameCallout = calloutA.length > 0 && calloutA === calloutB;
  const sameModel = modelA.length > 0 && modelA === modelB;
  const sameManufacturer =
    manufacturerA.length > 0 && manufacturerB.length > 0 && manufacturerA === manufacturerB;

  // Quantity is deliberately NOT part of these near-match checks. If two overlapping
  // screenshots read the same row as different quantities, that disagreement is exactly
  // the kind of error this detector must surface instead of hiding.
  if (sameCallout && sameModel) return true;
  if (sameCallout && descriptionSimilarity >= 0.6) return true;
  if (sameModel && sameManufacturer && descriptionSimilarity >= 0.75) return true;
  if (sameCallout && sameManufacturer && descriptionSimilarity >= 0.5) return true;

  return false;
}

export function flagCrossScreenshotDuplicates<T extends OverlapScheduleItem>(items: T[]): T[] {
  const flagged = items.map((item) => ({
    ...item,
    flags: [...item.flags],
  })) as T[];

  for (let i = 0; i < flagged.length; i++) {
    for (let j = i + 1; j < flagged.length; j++) {
      if (!isLikelyOverlap(flagged[i], flagged[j])) continue;

      for (const index of [i, j]) {
        if (!flagged[index].flags.includes(CROSS_SCREENSHOT_DUPLICATE_FLAG)) {
          flagged[index].flags.push(CROSS_SCREENSHOT_DUPLICATE_FLAG);
        }
        flagged[index].needsReview = true;
        flagged[index].confidence = Math.min(flagged[index].confidence, 70);
      }
    }
  }

  return flagged;
}
