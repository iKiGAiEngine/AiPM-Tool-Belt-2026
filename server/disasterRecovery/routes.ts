/**
 * Disaster Recovery — web endpoints and the nightly scheduler.
 *
 *   GET  /api/admin/dr-backup/status           admin: configuration + history
 *   POST /api/admin/dr-backup/run              admin: start a backup now
 *   POST /api/admin/dr-backup/test-connection  admin: check SharePoint access
 *   POST /api/dr-backup/trigger                external scheduler (Power Automate) with
 *                                              header "Authorization: Bearer <DR_BACKUP_TRIGGER_TOKEN>"
 *   GET  /api/dr-backup/trigger/status/:jobId  poll until the triggered backup finishes
 */
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { pool } from "../db";
import { requireAdmin } from "../authRoutes";
import { auditLog } from "../auditService";
import { getDrConfig, isMicrosoftConfigured, describeDestination } from "./config";
import { runDisasterRecoveryBackup, readStatus, currentRun, isBackupDue, type BackupRunRecord } from "./runBackup";
import { SharePointClient } from "./sharepointClient";

function startBackup(trigger: string) {
  return runDisasterRecoveryBackup({ pool, databaseUrl: process.env.DATABASE_URL!, trigger });
}

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function registerDisasterRecoveryRoutes(app: Express) {
  app.get("/api/admin/dr-backup/status", requireAdmin, async (_req: Request, res: Response) => {
    const cfg = getDrConfig();
    const status = await readStatus(pool);
    res.json({
      configured: isMicrosoftConfigured(cfg),
      destination: describeDestination(cfg),
      scheduleHourUtc: cfg.backupHourUtc,
      everyHours: cfg.everyHours,
      scheduleDisabled: cfg.disabled,
      retainDaily: cfg.retainDaily,
      retainMonthly: cfg.retainMonthly,
      externalTriggerEnabled: !!cfg.triggerToken,
      running: currentRun(),
      lastSuccess: status.lastSuccess ?? null,
      lastAttempt: status.lastAttempt ?? null,
      history: (status.history || []).slice(0, 14),
    });
  });

  app.post("/api/admin/dr-backup/run", requireAdmin, async (req: Request, res: Response) => {
    if (currentRun()) return res.status(409).json({ message: "A backup is already running." });
    const userId = (req.session as any)?.userId;
    void auditLog({ actorUserId: userId, actionType: "dr_backup_run", entityType: "backup", summary: "Started a disaster-recovery backup manually", requestPath: req.path, requestMethod: req.method });
    startBackup(`manual (user ${userId})`).catch((e) => console.error("[DR] Manual backup error:", e.message));
    res.status(202).json({ message: "Backup started. This usually takes a few minutes." });
  });

  app.post("/api/admin/dr-backup/test-connection", requireAdmin, async (_req: Request, res: Response) => {
    const cfg = getDrConfig();
    if (!isMicrosoftConfigured(cfg)) {
      return res.status(400).json({ ok: false, message: "SharePoint/OneDrive settings are not entered yet. See docs/DISASTER_RECOVERY.md (IT setup)." });
    }
    try {
      const r = await new SharePointClient(cfg).testConnection(cfg.rootFolder);
      res.json({ ok: true, message: "Connected. AiPM can write to the backup folder.", webUrl: r.webUrl });
    } catch (err: any) {
      res.status(502).json({ ok: false, message: err?.message || "Connection failed" });
    }
  });

  // For a Swinerton-owned scheduler (e.g. a nightly Power Automate flow). Uses the standard
  // "asynchronous request" pattern: reply 202 + a Location URL that the caller polls until the
  // backup finishes. Power Automate's HTTP action follows this automatically, and the polling
  // keeps a sleeping Autoscale deployment awake for the whole backup.
  app.post("/api/dr-backup/trigger", async (req: Request, res: Response) => {
    const cfg = getDrConfig();
    const header = req.get("authorization") || "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!cfg.triggerToken || !given || !tokenMatches(given, cfg.triggerToken)) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (currentRun()) return res.status(409).json({ message: "A backup is already running." });
    const jobId = crypto.randomBytes(24).toString("hex");
    const job: TriggerJob = { done: false, createdAt: Date.now() };
    triggerJobs.set(jobId, job);
    for (const [k, j] of Array.from(triggerJobs.entries())) if (Date.now() - j.createdAt > 24 * 3600 * 1000) triggerJobs.delete(k);
    startBackup("external scheduler")
      .then((rec) => Object.assign(job, { done: true, rec }))
      .catch((e) => Object.assign(job, { done: true, error: String(e?.message || e) }));
    res.setHeader("Location", `${req.protocol}://${req.get("host")}/api/dr-backup/trigger/status/${jobId}`);
    res.setHeader("Retry-After", "20");
    res.status(202).json({ message: "Backup started.", statusUrl: `/api/dr-backup/trigger/status/${jobId}` });
  });

  // Poll target. The long random id in the URL is the credential (only the caller who started the job has it).
  app.get("/api/dr-backup/trigger/status/:jobId", (req: Request, res: Response) => {
    const job = triggerJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ message: "Unknown job" });
    if (!job.done) {
      res.setHeader("Retry-After", "20");
      return res.status(202).json({ status: "running", step: currentRun()?.step });
    }
    const rec = job.rec;
    if (!rec || rec.result === "failed") return res.status(500).json({ status: "failed", error: job.error || rec?.error });
    res.status(200).json({ status: rec.result, backupId: rec.backupId, totalRows: rec.totalRows, totalBytes: rec.totalBytes, webUrl: rec.webUrl, note: rec.result === "local_only" ? rec.error : undefined });
  });
}

interface TriggerJob {
  done: boolean;
  createdAt: number;
  rec?: BackupRunRecord;
  error?: string;
}
const triggerJobs = new Map<string, TriggerJob>();

let timer: ReturnType<typeof setInterval> | null = null;

/** Check every 15 minutes whether tonight's backup is due; run it if so. */
export function startDisasterRecoveryScheduler() {
  const cfg = getDrConfig();
  if (cfg.disabled) {
    console.log("[DR] Automatic disaster-recovery backups are disabled (DR_BACKUP_DISABLED=true).");
    return;
  }
  if (process.env.NODE_ENV !== "production" && !isMicrosoftConfigured(cfg)) {
    console.log("[DR] Disaster-recovery scheduler idle in development (SharePoint not configured). Use Admin → Backup to run one manually.");
    return;
  }
  const tick = async () => {
    try {
      if (currentRun()) return;
      const status = await readStatus(pool);
      if (isBackupDue(status, getDrConfig())) await startBackup("nightly schedule");
    } catch (err: any) {
      console.error("[DR] Scheduler error:", err?.message);
    }
  };
  setTimeout(tick, 3 * 60 * 1000); // shortly after start-up (catches up after the app was asleep)
  timer = setInterval(tick, 15 * 60 * 1000);
  console.log(`[DR] Disaster-recovery scheduler started — ${cfg.everyHours === 24 ? "daily" : `every ${cfg.everyHours}h`} from ${String(cfg.backupHourUtc).padStart(2, "0")}:00 UTC → ${describeDestination(cfg)}`);
}

export function stopDisasterRecoveryScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
