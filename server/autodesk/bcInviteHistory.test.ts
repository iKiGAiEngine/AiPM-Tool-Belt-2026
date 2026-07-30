// Run: DATABASE_URL=... tsx server/autodesk/bcInviteHistory.test.ts
//
// Covers classifyProcessedInvite — the rule that turns a proposal-log row into a
// BC Invites change-log entry (accepted / merged / rejected / duplicate).
import assert from "assert";
import { classifyProcessedInvite } from "./bcSync";

const rejectLine = (iso: string, who: string, reason?: string) =>
  `${iso}: Rejected by ${who}${reason ? ` - ${reason}` : ""}`;

function run() {
  // ── Accepted ──
  const accepted = classifyProcessedInvite({
    draftApprovedBy: "Hunter Kruse",
    draftApprovedAt: new Date("2026-07-01T17:30:00.000Z"),
  });
  assert.ok(accepted, "approved draft is classified");
  assert.strictEqual(accepted!.outcome, "accepted");
  assert.strictEqual(accepted!.processedBy, "Hunter Kruse");
  assert.strictEqual(accepted!.processedAt, "2026-07-01T17:30:00.000Z");
  assert.strictEqual(accepted!.mergedIntoId, null);

  // ── Merged ──
  const merged = classifyProcessedInvite({
    duplicateOverrideNote: "Merged into entry #4821 as bid round by Gene Ramirez",
    deletedAt: new Date("2026-07-02T00:00:00.000Z"),
  });
  assert.ok(merged, "merged draft is classified");
  assert.strictEqual(merged!.outcome, "merged");
  assert.strictEqual(merged!.mergedIntoId, 4821);
  assert.strictEqual(merged!.processedBy, "Gene Ramirez");
  assert.strictEqual(merged!.processedAt, "2026-07-02T00:00:00.000Z");

  // ── Rejected, with a reason ──
  const rejected = classifyProcessedInvite({
    bcChangeLog: JSON.stringify([rejectLine("2026-07-03T12:00:00.000Z", "Gonzalo Diaz", "Out of region")]),
    deletedAt: new Date("2026-07-03T12:00:00.000Z"),
  });
  assert.ok(rejected, "rejected draft is classified");
  assert.strictEqual(rejected!.outcome, "rejected");
  assert.strictEqual(rejected!.processedBy, "Gonzalo Diaz");
  assert.strictEqual(rejected!.reason, "Out of region");
  assert.strictEqual(rejected!.processedAt, "2026-07-03T12:00:00.000Z");

  // ── Rejected, no reason ──
  const noReason = classifyProcessedInvite({
    bcChangeLog: JSON.stringify([rejectLine("2026-07-03T12:00:00.000Z", "Gonzalo Diaz")]),
  });
  assert.strictEqual(noReason!.outcome, "rejected");
  assert.strictEqual(noReason!.reason, null);
  assert.strictEqual(noReason!.processedBy, "Gonzalo Diaz");

  // ── The one-click "Duplicate" reject gets its own outcome ──
  const dupe = classifyProcessedInvite({
    bcChangeLog: JSON.stringify([rejectLine("2026-07-04T09:15:00.000Z", "Hunter Kruse", "Duplicate")]),
  });
  assert.strictEqual(dupe!.outcome, "duplicate");
  assert.strictEqual(dupe!.reason, "Duplicate");

  // ── BC field-update lines share the "<ISO>: <text>" shape but are not verdicts ──
  const updatesOnly = classifyProcessedInvite({
    bcChangeLog: JSON.stringify([
      "2026-06-01T00:00:00.000Z: dueDate: 2026-07-15 → 2026-07-28",
      "2026-06-02T00:00:00.000Z: squareFeet: 40,000 → 52,500",
    ]),
  });
  assert.strictEqual(updatesOnly, null, "BC update lines alone are not a processed invite");

  // ── The reject line is found even when update lines were appended around it ──
  const mixed = classifyProcessedInvite({
    bcChangeLog: JSON.stringify([
      "2026-06-01T00:00:00.000Z: dueDate: 2026-07-15 → 2026-07-28",
      rejectLine("2026-07-05T08:00:00.000Z", "Gene Ramirez", "GC pulled the package"),
    ]),
  });
  assert.strictEqual(mixed!.outcome, "rejected");
  assert.strictEqual(mixed!.reason, "GC pulled the package");

  // ── A reason containing a colon is not mistaken for the timestamp separator ──
  const colonReason = classifyProcessedInvite({
    bcChangeLog: JSON.stringify([rejectLine("2026-07-06T08:00:00.000Z", "Hunter Kruse", "See email: no Div 10 scope")]),
  });
  assert.strictEqual(colonReason!.reason, "See email: no Div 10 scope");
  assert.strictEqual(colonReason!.processedAt, "2026-07-06T08:00:00.000Z");

  // ── Merge wins over any leftover duplicate-warning payload ──
  const dupWarningOnly = classifyProcessedInvite({
    duplicateOverrideNote: '__dup:[{"id":12,"projectName":"Something"}]',
  });
  assert.strictEqual(dupWarningOnly, null, "an unreviewed duplicate warning is not a verdict");

  // ── Ordinary Proposal Log rows never entered the review queue ──
  assert.strictEqual(classifyProcessedInvite({}), null);
  assert.strictEqual(
    classifyProcessedInvite({ deletedAt: new Date("2026-07-07T00:00:00.000Z") }),
    null,
    "a plain soft-deleted entry is not a rejected invite",
  );

  // ── Malformed change logs degrade to "not a verdict" rather than throwing ──
  assert.strictEqual(classifyProcessedInvite({ bcChangeLog: "{not json" }), null);
  assert.strictEqual(classifyProcessedInvite({ bcChangeLog: JSON.stringify({ a: 1 }) }), null);

  // ── An unparseable approval timestamp still classifies, with a null date ──
  const badDate = classifyProcessedInvite({ draftApprovedBy: "Hunter Kruse", draftApprovedAt: "not-a-date" });
  assert.strictEqual(badDate!.outcome, "accepted");
  assert.strictEqual(badDate!.processedAt, null);

  console.log("All bcInviteHistory tests passed!");
}

run();
