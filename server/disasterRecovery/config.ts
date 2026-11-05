/**
 * Disaster Recovery (DR) backup — configuration.
 *
 * Every setting comes from an environment variable (a Replit "Secret") so that
 * Swinerton IT controls where backups go without any code change.
 *
 * Destination (pick ONE):
 *   DR_SHAREPOINT_SITE_URL   e.g. https://swinerton.sharepoint.com/sites/AiPM-Backups   (recommended)
 *   DR_ONEDRIVE_USER         e.g. aipm-backups@swinerton.com  (a OneDrive for Business account)
 *   DR_GRAPH_DRIVE_ID        a raw Microsoft Graph drive id (advanced)
 *
 * Microsoft Entra ID (Azure AD) app registration created by Swinerton IT:
 *   DR_MS_TENANT_ID, DR_MS_CLIENT_ID, DR_MS_CLIENT_SECRET
 *
 * Optional:
 *   DR_SHAREPOINT_LIBRARY    document library name (default: the site's default "Documents" library)
 *   DR_ROOT_FOLDER           top folder inside the library (default "AiPM Disaster Recovery")
 *   DR_BACKUP_HOUR_UTC       hour of day the nightly backup runs (default 9 = 1-2 AM Pacific)
 *   DR_BACKUP_EVERY_HOURS    run more often than nightly: 1, 2, 3, 4, 6, 8, 12 or 24 (default 24)
 *   DR_RETAIN_DAILY          days for which one backup per day is kept (default 30)
 *   DR_RETAIN_MONTHLY        months for which one month-end backup is kept (default 12)
 *                            (every backup from the last 48 hours is always kept)
 *   DR_BACKUP_TRIGGER_TOKEN  shared secret allowing an external scheduler (e.g. Power Automate)
 *                            to start a backup via POST /api/dr-backup/trigger
 *   DR_BACKUP_DISABLED       "true" to switch the automatic schedule off
 *   DR_INCLUDE_SOURCE_CODE   "false" to leave application source code out of backups (smaller files)
 *
 * No-IT option: with only DR_BACKUP_TRIGGER_TOKEN set, the owner's own Power Automate flow pulls
 * the backup into their OneDrive (see pickup.ts and docs/DR_SETUP_POWER_AUTOMATE.md).
 */

export interface DrConfig {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  siteUrl?: string;
  libraryName?: string;
  oneDriveUser?: string;
  driveId?: string;
  rootFolder: string;
  backupHourUtc: number;
  everyHours: number;
  retainDaily: number;
  retainMonthly: number;
  triggerToken?: string;
  disabled: boolean;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) return fallback;
  return n;
}

function strEnv(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export function getDrConfig(): DrConfig {
  return {
    tenantId: strEnv("DR_MS_TENANT_ID"),
    clientId: strEnv("DR_MS_CLIENT_ID"),
    clientSecret: strEnv("DR_MS_CLIENT_SECRET"),
    siteUrl: strEnv("DR_SHAREPOINT_SITE_URL"),
    libraryName: strEnv("DR_SHAREPOINT_LIBRARY"),
    oneDriveUser: strEnv("DR_ONEDRIVE_USER"),
    driveId: strEnv("DR_GRAPH_DRIVE_ID"),
    rootFolder: (strEnv("DR_ROOT_FOLDER") || "AiPM Disaster Recovery").replace(/^\/+|\/+$/g, ""),
    backupHourUtc: intEnv("DR_BACKUP_HOUR_UTC", 9, 0, 23),
    everyHours: [1, 2, 3, 4, 6, 8, 12, 24].includes(intEnv("DR_BACKUP_EVERY_HOURS", 24, 1, 24)) ? intEnv("DR_BACKUP_EVERY_HOURS", 24, 1, 24) : 24,
    retainDaily: intEnv("DR_RETAIN_DAILY", 30, 3, 365),
    retainMonthly: intEnv("DR_RETAIN_MONTHLY", 12, 0, 120),
    triggerToken: strEnv("DR_BACKUP_TRIGGER_TOKEN"),
    disabled: (process.env.DR_BACKUP_DISABLED || "").toLowerCase() === "true",
  };
}

/** True when enough settings exist to upload to Microsoft 365. */
export function isMicrosoftConfigured(cfg: DrConfig = getDrConfig()): boolean {
  const hasCreds = !!(cfg.tenantId && cfg.clientId && cfg.clientSecret);
  const hasTarget = !!(cfg.siteUrl || cfg.oneDriveUser || cfg.driveId);
  return hasCreds && hasTarget;
}

export function describeDestination(cfg: DrConfig = getDrConfig()): string {
  if (cfg.driveId) return `Microsoft 365 drive ${cfg.driveId} › ${cfg.rootFolder}`;
  if (cfg.siteUrl) return `${cfg.siteUrl} › ${cfg.libraryName || "Documents"} › ${cfg.rootFolder}`;
  if (cfg.oneDriveUser) return `OneDrive of ${cfg.oneDriveUser} › ${cfg.rootFolder}`;
  return "Not configured";
}

/**
 * Tables whose *rows* are deliberately not backed up (their structure still is).
 * They hold short-lived security tokens only; after a restore users simply log in again.
 */
export const TRANSIENT_TABLES: Record<string, string> = {
  session: "Active browser login sessions (users just sign in again after a restore).",
  auth_tokens: "One-time email login codes that expire within minutes.",
};

/**
 * Every environment variable / Replit Secret the application reads, so a
 * recovery team knows exactly what to re-enter. VALUES ARE NEVER BACKED UP.
 */
export const REQUIRED_SECRETS: { name: string; required: boolean; purpose: string; source: string }[] = [
  { name: "DATABASE_URL", required: true, purpose: "Connection string to the PostgreSQL database.", source: "Created automatically when a new Replit (or other) PostgreSQL database is provisioned." },
  { name: "SESSION_SECRET", required: true, purpose: "Signs login cookies.", source: "Any long random string. Generate a new one during recovery (users will simply sign in again)." },
  { name: "OPENAI_API_KEY", required: true, purpose: "AI features (Spec Extractor review, Schedule Converter, Quote extraction, chat).", source: "OpenAI account owner → platform.openai.com → API keys." },
  { name: "SENDGRID_API_KEY", required: true, purpose: "Sends the email login codes and notifications.", source: "SendGrid account owner → Settings → API Keys." },
  { name: "EMAIL_FROM", required: false, purpose: "The 'from' address on outgoing email.", source: "The verified SendGrid sender address." },
  { name: "ALLOWED_EMAIL_DOMAINS", required: false, purpose: "Which email domains may sign in.", source: "Business decision, e.g. swinerton.com." },
  { name: "ADMIN_NOTIFICATION_EMAIL", required: false, purpose: "Where admin alerts are emailed.", source: "Business decision." },
  { name: "APP_BASE_URL", required: false, purpose: "Public web address of AiPM, used in links inside emails.", source: "The new deployment URL." },
  { name: "APS_CLIENT_ID", required: false, purpose: "Autodesk / BuildingConnected integration.", source: "Autodesk Platform Services developer portal (aps.autodesk.com) → the AiPM app." },
  { name: "APS_CLIENT_SECRET", required: false, purpose: "Autodesk / BuildingConnected integration.", source: "Autodesk Platform Services developer portal." },
  { name: "APS_REDIRECT_DOMAIN", required: false, purpose: "Return address for the Autodesk sign-in. Must also be updated in the Autodesk portal if the URL changes.", source: "The new deployment domain." },
  { name: "GOOGLE_SHEET_ID", required: false, purpose: "Optional Google Sheet mirror of the Proposal Log.", source: "The ID in the Google Sheet's URL." },
  { name: "SPEC_EXTRACTOR_URL", required: false, purpose: "Optional external Spec Extractor service address.", source: "Set in .replit [userenv.shared]; included in the source code backup." },
  { name: "DR_MS_TENANT_ID", required: false, purpose: "Disaster-recovery backup: Swinerton Microsoft 365 tenant.", source: "Swinerton IT (Entra ID app registration)." },
  { name: "DR_MS_CLIENT_ID", required: false, purpose: "Disaster-recovery backup: app registration client ID.", source: "Swinerton IT." },
  { name: "DR_MS_CLIENT_SECRET", required: false, purpose: "Disaster-recovery backup: app registration secret.", source: "Swinerton IT." },
  { name: "DR_SHAREPOINT_SITE_URL", required: false, purpose: "Disaster-recovery backup: destination SharePoint site.", source: "Swinerton IT." },
  { name: "DR_BACKUP_TRIGGER_TOKEN", required: false, purpose: "Password for the backup link that your Power Automate flow uses to copy backups to OneDrive.", source: "Any long letters-and-numbers password; must match the links in the Power Automate flow (docs/DR_SETUP_POWER_AUTOMATE.md)." },
  { name: "DR_INCLUDE_SOURCE_CODE", required: false, purpose: "Set to false to leave the app code out of backups (smaller files).", source: "Only if OneDrive rejects the file size." },
];
