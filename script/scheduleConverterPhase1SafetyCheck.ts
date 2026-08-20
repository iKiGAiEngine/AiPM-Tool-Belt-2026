import assert from "node:assert/strict";
import {
  applyQuantityVerificationFlag,
  markExtractionIncomplete,
  needsScheduleReview,
  QUANTITY_UNCORROBORATED_FLAG,
  EXTRACTION_INCOMPLETE_FLAG,
} from "../server/scheduleReview";
import {
  CROSS_SCREENSHOT_DUPLICATE_FLAG,
  flagCrossScreenshotDuplicates,
} from "../client/src/lib/scheduleOverlap";

function assertUnverifiedQuantityCannotPassSilently(quantity: number): void {
  const flags: string[] = [];
  applyQuantityVerificationFlag(flags, "unverified");

  assert.equal(
    flags.includes(QUANTITY_UNCORROBORATED_FLAG),
    true,
    `quantity ${quantity} must be visibly flagged when it has no independent corroboration`,
  );

  assert.equal(
    needsScheduleReview({ confidence: 100, flags, quantityVerification: "unverified" }),
    true,
    `quantity ${quantity} must require review even if a model self-reports 100% confidence`,
  );
}

// Regression case: a real 2 that is misread as 1 must never pass silently.
assertUnverifiedQuantityCannotPassSilently(1);
assertUnverifiedQuantityCannotPassSilently(2);

const overlappingRows = flagCrossScreenshotDuplicates([
  {
    planCallout: "TA-02",
    description: "Soap dispenser; surface mounted",
    manufacturer: "ASI",
    rawModel: "0361",
    modelNumber: "ASI 0361",
    quantity: 2,
    flags: [],
    needsReview: false,
    confidence: 95,
    sourceIndex: 0,
  },
  {
    planCallout: "TA-02",
    description: "Soap dispenser surface mounted",
    manufacturer: "ASI",
    rawModel: "0361",
    modelNumber: "ASI 0361",
    quantity: 1,
    flags: [],
    needsReview: false,
    confidence: 95,
    sourceIndex: 1,
  },
]);

assert.equal(overlappingRows.length, 2, "overlap detection must retain both rows for human comparison");
for (const row of overlappingRows) {
  assert.equal(row.flags.includes(CROSS_SCREENSHOT_DUPLICATE_FLAG), true);
  assert.equal(row.needsReview, true);
}

const incompleteRows = markExtractionIncomplete([
  {
    confidence: 99,
    flags: [],
    needsReview: false,
    quantityVerification: "corroborated" as const,
  },
]);

assert.equal(incompleteRows[0].flags.includes(EXTRACTION_INCOMPLETE_FLAG), true);
assert.equal(incompleteRows[0].needsReview, true);
assert.equal(incompleteRows[0].confidence <= 70, true);

console.log("Schedule Converter Phase 1 safety checks passed.");
