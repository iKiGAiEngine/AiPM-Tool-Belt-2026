import { eq } from "drizzle-orm";
import { db } from "./db";
import { systemSettings } from "@shared/schema";

// Two admin-set "root" locations. A project's folder name (e.g. "LAX - Project Name")
// is tacked onto the end of each root to build the link shown in the Proposal Log.
const SHARE_DRIVE_KEY = "folder_link_share_drive_root";
const ONE_DRIVE_KEY = "folder_link_one_drive_root";

export interface FolderLinkSettings {
  shareDriveRoot: string;
  oneDriveRoot: string;
}

async function readSetting(key: string): Promise<string> {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return row?.value ?? "";
}

async function writeSetting(key: string, value: string): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemSettings.key, set: { value, updatedAt: new Date() } });
}

export async function getFolderLinkSettings(): Promise<FolderLinkSettings> {
  return {
    shareDriveRoot: await readSetting(SHARE_DRIVE_KEY),
    oneDriveRoot: await readSetting(ONE_DRIVE_KEY),
  };
}

export async function saveFolderLinkSettings(s: FolderLinkSettings): Promise<void> {
  await writeSetting(SHARE_DRIVE_KEY, s.shareDriveRoot.trim());
  await writeSetting(ONE_DRIVE_KEY, s.oneDriveRoot.trim());
}

/** Builds the two folder links for a new project. Empty string when that root isn't set up yet. */
export async function buildFolderLinks(folderName: string): Promise<{ shareDriveLink: string; oneDriveLink: string }> {
  const { shareDriveRoot, oneDriveRoot } = await getFolderLinkSettings();

  let shareDriveLink = "";
  if (shareDriveRoot) {
    const sep = shareDriveRoot.includes("/") && !shareDriveRoot.includes("\\") ? "/" : "\\";
    shareDriveLink = shareDriveRoot.replace(/[\\/]+$/, "") + sep + folderName;
  }

  let oneDriveLink = "";
  if (/^https?:\/\//i.test(oneDriveRoot)) {
    oneDriveLink = oneDriveRoot.replace(/\/+$/, "") + "/" + encodeURIComponent(folderName);
  }

  return { shareDriveLink, oneDriveLink };
}
