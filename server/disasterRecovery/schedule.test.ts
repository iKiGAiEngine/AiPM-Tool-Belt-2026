// Run with:  npx tsx server/disasterRecovery/schedule.test.ts
import assert from "assert";
import { selectBackupsToPrune, isBackupDue, lastScheduledSlot, type BackupStatus, type BackupRunRecord } from "./runBackup";
import type { DrConfig } from "./config";

const cfg = (over: Partial<DrConfig> = {}): DrConfig => ({
  rootFolder: "x", backupHourUtc: 9, everyHours: 24, retainDaily: 30, retainMonthly: 12, disabled: false, ...over,
});
const rec = (startedAt: string, result: BackupRunRecord["result"]): BackupRunRecord => ({
  backupId: "", startedAt, finishedAt: startedAt, result, trigger: "t", durationSec: 1,
});
const id = (d: Date) => d.toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === "T" ? "_" : c === ":" ? "" : "-")) + "Z";

// --- schedule slots ---
assert.strictEqual(lastScheduledSlot(cfg(), new Date("2026-11-05T10:00:00Z")).toISOString(), "2026-11-05T09:00:00.000Z");
assert.strictEqual(lastScheduledSlot(cfg(), new Date("2026-11-05T08:59:00Z")).toISOString(), "2026-11-04T09:00:00.000Z");
assert.strictEqual(lastScheduledSlot(cfg({ everyHours: 6 }), new Date("2026-11-05T08:00:00Z")).toISOString(), "2026-11-05T03:00:00.000Z");
assert.strictEqual(lastScheduledSlot(cfg({ everyHours: 6 }), new Date("2026-11-05T22:30:00Z")).toISOString(), "2026-11-05T21:00:00.000Z");

// --- due logic ---
const now = new Date("2026-11-05T10:00:00Z");
assert.strictEqual(isBackupDue({ history: [] }, cfg(), now), true, "never backed up → due");
const okToday: BackupStatus = { history: [], lastSuccess: rec("2026-11-05T09:01:00Z", "success"), lastAttempt: rec("2026-11-05T09:01:00Z", "success") };
assert.strictEqual(isBackupDue(okToday, cfg(), now), false, "already done this slot");
const okYesterday: BackupStatus = { history: [], lastSuccess: rec("2026-11-04T09:01:00Z", "success"), lastAttempt: rec("2026-11-04T09:01:00Z", "success") };
assert.strictEqual(isBackupDue(okYesterday, cfg(), now), true, "missed today (app was asleep) → catch up");
const justFailed: BackupStatus = { ...okYesterday, lastAttempt: rec("2026-11-05T09:30:00Z", "failed") };
assert.strictEqual(isBackupDue(justFailed, cfg(), now), false, "failed 30 min ago → wait");
assert.strictEqual(isBackupDue(justFailed, cfg(), new Date("2026-11-05T10:31:00Z")), true, "failed an hour ago → retry");
const localOnly: BackupStatus = { history: [], lastAttempt: rec("2026-11-05T09:02:00Z", "local_only") };
assert.strictEqual(isBackupDue(localOnly, cfg(), now), false, "not configured → one local copy per slot");

// --- retention ---
const nowR = new Date("2026-11-05T12:00:00Z");
const names: string[] = [];
for (let h = 0; h < 24 * 400; h += 6) names.push(id(new Date(nowR.getTime() - h * 3600_000)));
names.push("random-folder", "_in-progress");
const prune = new Set(selectBackupsToPrune(names, 30, 12, nowR));
const kept = names.filter((n) => /^\d{4}-/.test(n) && !prune.has(n));
assert.ok(!prune.has("random-folder") && !prune.has("_in-progress"), "never touches unrelated folders");
assert.ok(kept.includes(names[0]), "newest kept");
const last48 = names.filter((n) => /^\d{4}-/.test(n)).slice(0, 8);
assert.ok(last48.every((n) => kept.includes(n)), "all backups from last 48h kept");
const days = new Set(kept.map((n) => n.slice(0, 10)));
assert.ok(days.size >= 30, "one per day for 30 days");
const months = new Set(kept.map((n) => n.slice(0, 7)));
assert.ok(months.size >= 12, "12 months covered");
assert.ok(kept.length <= 8 + 30 + 12, `bounded size (kept ${kept.length})`);
// Daily keep is the NEWEST of each day.
const nov2 = kept.filter((n) => n.startsWith("2026-11-02"));
assert.deepStrictEqual(nov2, [names.filter((n) => n.startsWith("2026-11-02")).sort().reverse()[0]]);

console.log("disaster-recovery schedule/retention tests: all passed");
