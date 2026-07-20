// Twice-daily QA audit scheduler. Mirrors the nightlyBackup pattern: kicks off
// shortly after boot, then runs on a fixed interval. Each run audits the live
// site over loopback + the in-process database/config, persists the result, and
// emails a summary to the ops recipient.
//
// Alert policy (override via env):
//   - RED    → always email (something is broken).
//   - YELLOW → email (needs attention) unless QA_AUDIT_EMAIL_ON=red-only.
//   - GREEN  → email only when QA_AUDIT_EMAIL_ON=always (a daily "all clear").
// Default QA_AUDIT_EMAIL_ON = "problems" (RED + YELLOW).

import { runAudit } from "./runner";
import { renderEmailSubject, renderEmailText, renderHtml } from "./report";
import type { QaAuditReport } from "./types";

const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const STARTUP_DELAY = 90 * 1000; // let the server settle before the first probe

let auditInterval: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;

function alertRecipient(): string {
  return (
    process.env.QA_AUDIT_ALERT_EMAIL ||
    process.env.ADMIN_NOTIFICATION_EMAIL ||
    "Haley.Kruse@nationalbuildingspecialties.com"
  );
}

function shouldEmail(status: QaAuditReport["status"]): boolean {
  const policy = (process.env.QA_AUDIT_EMAIL_ON || "problems").toLowerCase();
  if (policy === "always") return true;
  if (policy === "red-only") return status === "RED";
  // "problems" (default): anything not green.
  return status !== "GREEN";
}

async function sendReportEmail(report: QaAuditReport): Promise<void> {
  if (!shouldEmail(report.status)) {
    console.log(`[QaAudit] ${report.status} — email suppressed by policy (QA_AUDIT_EMAIL_ON).`);
    return;
  }
  const to = alertRecipient();
  const subject = renderEmailSubject(report);
  const text = renderEmailText(report);
  const html = renderHtml(report);

  try {
    if (process.env.SENDGRID_API_KEY) {
      const sgMail = (await import("@sendgrid/mail")).default;
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      const from = process.env.EMAIL_FROM || "no-reply@aipmapp.com";
      await sgMail.send({ to, from, subject, text, html });
      console.log(`[QaAudit] Report emailed to ${to} (${report.status}).`);
    } else {
      console.log(`\n===== [QaAudit] EMAIL (console mode) =====`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(text);
      console.log(`=========================================\n`);
    }
  } catch (err: any) {
    console.error("[QaAudit] Failed to send report email:", err?.response?.body || err?.message || err);
  }
}

export async function runScheduledAudit(): Promise<QaAuditReport> {
  const port = process.env.PORT || "5000";
  const baseUrl = process.env.QA_AUDIT_SELF_URL || `http://127.0.0.1:${port}`;
  const report = await runAudit({ baseUrl, includeLocalChecks: true, persist: true });
  console.log(`[QaAudit] ${report.status} — ${report.headline}`);
  await sendReportEmail(report);
  return report;
}

export function startQaAuditScheduler(): void {
  if (process.env.QA_AUDIT_DISABLE === "true") {
    console.log("[QaAudit] Scheduler disabled via QA_AUDIT_DISABLE=true");
    return;
  }
  // First run after a short delay so routes/DB are fully warmed up.
  startupTimer = setTimeout(() => {
    runScheduledAudit().catch((err) => console.error("[QaAudit] Startup audit failed:", err?.message || err));
  }, STARTUP_DELAY);
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  auditInterval = setInterval(() => {
    runScheduledAudit().catch((err) => console.error("[QaAudit] Scheduled audit failed:", err?.message || err));
  }, TWELVE_HOURS);
  if (typeof auditInterval.unref === "function") auditInterval.unref();

  console.log("[QaAudit] Scheduler started (every 12h — twice daily).");
}

export function stopQaAuditScheduler(): void {
  if (auditInterval) clearInterval(auditInterval);
  if (startupTimer) clearTimeout(startupTimer);
  auditInterval = null;
  startupTimer = null;
}
