import { db } from "./db";
import { proposalLogEntries, proposalAcknowledgements, regions } from "@shared/schema";
import { eq, inArray, isNull, and, sql, getTableColumns } from "drizzle-orm";
import { triggerSheetSync, isGoogleSheetConfigured } from "./googleSheetSync";

// Column whitelist for list queries — excludes binary screenshot blob to keep
// list responses small. Single-row reads can still hit the full table.
const { screenshotData: _omitScreenshotData, screenshotMimeType: _omitScreenshotMimeType, ...PROPOSAL_LOG_LIST_COLUMNS } = getTableColumns(proposalLogEntries);

async function lookupSpEstimatorFromRegion(region: string): Promise<string> {
  if (!region) return "";
  try {
    const m = region.match(/^([A-Z]{2,5})\s*-\s*(.+)$/);
    let code = "";
    let name = "";
    if (m) { code = m[1]; name = m[2]; }
    else if (/^[A-Z]{2,5}$/.test(region.trim())) { code = region.trim(); }
    if (!code) return "";
    const matches = await db.select().from(regions).where(eq(regions.code, code));
    const target = name ? (matches.find(r => r.name === name) || matches[0]) : matches[0];
    const arr = target?.selfPerformEstimators;
    return (arr && arr.length > 0) ? arr[0] : "";
  } catch { return ""; }
}

const MARKET_KEYWORDS: Record<string, string[]> = {
  "Education": ["school", "elementary", "middle", "high school", "university", "college", "campus", "academy", "institute", "classroom", "gymnasium", "library", "k-12", "k12", "education", "student", "learning"],
  "Healthcare": ["hospital", "medical", "clinic", "health", "healthcare", "surgical", "patient", "urgent care", "ambulatory", "pharmacy", "dental", "veterinary", "vet", "rehab", "rehabilitation"],
  "Aviation": ["airport", "aviation", "terminal", "hangar", "runway", "airline", "FAA", "airfield", "concourse"],
  "Hospitality": ["hotel", "resort", "motel", "lodge", "inn", "hospitality", "conference center", "convention"],
  "Residential": ["apartment", "condo", "condominium", "townhouse", "residential", "housing", "dwelling", "home", "senior living", "assisted living", "multifamily"],
  "Retail": ["retail", "shopping", "mall", "store", "storefront", "marketplace", "boutique", "outlet"],
  "Office": ["office", "corporate", "headquarters", "workspace", "coworking", "co-working", "business park", "tech center"],
  "Entertainment": ["theater", "theatre", "arena", "stadium", "amphitheater", "entertainment", "casino", "museum", "gallery", "performing arts", "recreation", "aquatic", "pool", "community center"],
  "Parking Structure": ["parking", "garage", "carport", "parking structure"],
  "Public Facility": ["courthouse", "city hall", "fire station", "police", "government", "public", "municipal", "federal", "civic", "post office", "transit", "jail", "prison", "detention", "water treatment", "wastewater"],
  "Special Projects": ["renovation", "remodel", "tenant improvement", "TI", "seismic", "retrofit", "demolition", "abatement"],
};

export function guessMarket(projectName: string, rawText?: string): string {
  const combined = `${projectName} ${rawText || ""}`.toLowerCase();

  let bestMatch = "";
  let bestScore = 0;

  for (const [market, keywords] of Object.entries(MARKET_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (combined.includes(kw.toLowerCase())) {
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = market;
    }
  }

  return bestMatch;
}


export async function createProposalLogEntry(data: {
  projectName: string;
  estimateNumber: string;
  region: string;
  primaryMarket: string;
  dueDate: string;
  owner: string;
  filePath: string;
  screenshotPath: string;
  screenshotData?: Buffer | null;
  screenshotMimeType?: string | null;
  projectDbId: number;
  isTest?: boolean;
  inviteDate?: string;
  estimateStatus?: string;
  anticipatedStart?: string;
  anticipatedFinish?: string;
  nbsEstimator?: string;
  bcLink?: string;
  sourceType?: string;
  sourceEmail?: string;
  sourceEmailSubject?: string;
  sourceAttachmentUrl?: string;
}) {
  const fallbackInviteDate = (() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  })();

  const spEstimator = await lookupSpEstimatorFromRegion(data.region);

  const [entry] = await db.insert(proposalLogEntries).values({
    projectName: data.projectName,
    estimateNumber: data.estimateNumber,
    region: data.region,
    primaryMarket: data.primaryMarket,
    inviteDate: data.inviteDate || fallbackInviteDate,
    dueDate: data.dueDate,
    estimateStatus: data.estimateStatus || "Estimating",
    owner: data.owner,
    filePath: data.filePath,
    screenshotPath: data.screenshotPath,
    screenshotData: data.screenshotData ?? null,
    screenshotMimeType: data.screenshotMimeType ?? null,
    projectDbId: data.projectDbId,
    anticipatedStart: data.anticipatedStart || null,
    anticipatedFinish: data.anticipatedFinish || null,
    nbsEstimator: data.nbsEstimator || null,
    selfPerformEstimator: spEstimator || null,
    bcLink: data.bcLink || null,
    sourceType: data.sourceType || null,
    sourceEmail: data.sourceEmail || null,
    sourceEmailSubject: data.sourceEmailSubject || null,
    sourceAttachmentUrl: data.sourceAttachmentUrl || null,
    isTest: data.isTest || false,
    syncedToLocal: false,
  }).returning();

  if (isGoogleSheetConfigured()) triggerSheetSync();
  return entry;
}

export async function bulkCreateProposalLogEntries(entries: Array<{
  projectName: string;
  estimateNumber: string;
  region?: string;
  primaryMarket?: string;
  dueDate?: string;
  owner?: string;
  filePath?: string;
  screenshotPath?: string;
  screenshotData?: Buffer | null;
  screenshotMimeType?: string | null;
  isTest?: boolean;
  inviteDate?: string;
  estimateStatus?: string;
  anticipatedStart?: string;
  anticipatedFinish?: string;
  nbsEstimator?: string;
  gcEstimateLead?: string;
  selfPerformEstimator?: string;
  proposalTotal?: string;
  bcLink?: string;
  sourceType?: string;
  sourceEmail?: string;
  sourceEmailSubject?: string;
  sourceAttachmentUrl?: string;
}>) {
  if (!entries.length) return [];

  const fallbackInviteDate = (() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  })();

  const terminalStatuses = ['Awarded', 'Lost', 'Lost - Note Why in Comments'];

  const allRegions = await db.select().from(regions);

  const values = entries.map(data => {
    let status = data.estimateStatus || "Estimating";
    const totalDigits = (data.proposalTotal || '').replace(/[^0-9.]/g, '');

    if (!terminalStatuses.includes(status)) {
      if (totalDigits && Number(totalDigits) > 0) {
        status = 'Submitted';
      } else {
        status = 'Estimating';
      }
    }

    let spEst = "";
    const regionStr = data.region || "";
    if (regionStr) {
      const rm = regionStr.match(/^([A-Z]{2,5})\s*-\s*(.+)$/);
      let code = "";
      let rName = "";
      if (rm) { code = rm[1]; rName = rm[2]; }
      else if (/^[A-Z]{2,5}$/.test(regionStr.trim())) { code = regionStr.trim(); }
      if (code) {
        const codeMatches = allRegions.filter(r => r.code === code);
        const target = rName ? (codeMatches.find(r => r.name === rName) || codeMatches[0]) : codeMatches[0];
        const spArr = target?.selfPerformEstimators;
        spEst = (spArr && spArr.length > 0) ? spArr[0] : "";
      }
    }

    return {
      projectName: data.projectName,
      estimateNumber: data.estimateNumber,
      region: regionStr,
      primaryMarket: data.primaryMarket || guessMarket(data.projectName),
      inviteDate: data.inviteDate || fallbackInviteDate,
      dueDate: data.dueDate || "",
      estimateStatus: status,
      owner: data.owner || "",
      filePath: data.filePath || "",
      screenshotPath: data.screenshotPath || "",
      screenshotData: data.screenshotData ?? null,
      screenshotMimeType: data.screenshotMimeType ?? null,
      projectDbId: 0,
      anticipatedStart: data.anticipatedStart || null,
      anticipatedFinish: data.anticipatedFinish || null,
      nbsEstimator: data.nbsEstimator || null,
      gcEstimateLead: data.gcEstimateLead || null,
      selfPerformEstimator: data.selfPerformEstimator || spEst || null,
      proposalTotal: data.proposalTotal || null,
      bcLink: data.bcLink || null,
      sourceType: data.sourceType || null,
      sourceEmail: data.sourceEmail || null,
      sourceEmailSubject: data.sourceEmailSubject || null,
      sourceAttachmentUrl: data.sourceAttachmentUrl || null,
      isTest: data.isTest || false,
      syncedToLocal: true,
    };
  });

  const created = await db.insert(proposalLogEntries).values(values).returning();

  console.log(`[ProposalLogService] Bulk created ${created.length} entries`);
  if (isGoogleSheetConfigured()) triggerSheetSync();
  return created;
}

export async function getUnsyncedEntries() {
  return db.select(PROPOSAL_LOG_LIST_COLUMNS).from(proposalLogEntries).where(eq(proposalLogEntries.syncedToLocal, false));
}

export async function markEntriesSynced(ids: number[]) {
  for (const id of ids) {
    await db.update(proposalLogEntries).set({ syncedToLocal: true }).where(eq(proposalLogEntries.id, id));
  }
}

export async function getActiveProposalLogEntries() {
  return db.select(PROPOSAL_LOG_LIST_COLUMNS).from(proposalLogEntries)
    .where(isNull(proposalLogEntries.deletedAt))
    .orderBy(proposalLogEntries.createdAt);
}

export async function getAllProposalLogEntries() {
  return db.select(PROPOSAL_LOG_LIST_COLUMNS).from(proposalLogEntries).orderBy(proposalLogEntries.createdAt);
}

export async function updateProposalLogEntryById(id: number, updates: Partial<{
  projectName: string;
  owner: string;
  nbsEstimator: string;
  estimateStatus: string;
  proposalTotal: string;
  gcEstimateLead: string;
  selfPerformEstimator: string;
  anticipatedStart: string;
  anticipatedFinish: string;
  estimateNumber: string;
  notes: string;
  dueDate: string;
  inviteDate: string;
  bcLink: string;
  nbsSelectedScopes: string;
  scopeList: string;
  finalReviewer: string;
  swinertonProject: string;
  region: string;
  primaryMarket: string;
  filePath: string;
  screenshotPath: string;
  screenshotData: Buffer | null;
  screenshotMimeType: string | null;
  sourceType: string;
  sourceEmail: string;
  sourceEmailSubject: string;
  sourceAttachmentUrl: string;
}>) {
  const cleanUpdates: Record<string, any> = {};
  if (updates.projectName !== undefined) cleanUpdates.projectName = updates.projectName;
  if (updates.owner !== undefined) cleanUpdates.owner = updates.owner;
  if (updates.nbsEstimator !== undefined) cleanUpdates.nbsEstimator = updates.nbsEstimator;
  if (updates.estimateStatus !== undefined) cleanUpdates.estimateStatus = updates.estimateStatus;
  if (updates.proposalTotal !== undefined) cleanUpdates.proposalTotal = updates.proposalTotal;
  if (updates.gcEstimateLead !== undefined) cleanUpdates.gcEstimateLead = updates.gcEstimateLead;
  if (updates.selfPerformEstimator !== undefined) cleanUpdates.selfPerformEstimator = updates.selfPerformEstimator;
  if (updates.anticipatedStart !== undefined) cleanUpdates.anticipatedStart = updates.anticipatedStart;
  if (updates.anticipatedFinish !== undefined) cleanUpdates.anticipatedFinish = updates.anticipatedFinish;
  if (updates.estimateNumber !== undefined) cleanUpdates.estimateNumber = updates.estimateNumber;
  if (updates.notes !== undefined) cleanUpdates.notes = updates.notes;
  if (updates.dueDate !== undefined) cleanUpdates.dueDate = updates.dueDate;
  if (updates.inviteDate !== undefined) cleanUpdates.inviteDate = updates.inviteDate;
  if (updates.bcLink !== undefined) cleanUpdates.bcLink = updates.bcLink;
  if (updates.nbsSelectedScopes !== undefined) cleanUpdates.nbsSelectedScopes = updates.nbsSelectedScopes;
  if (updates.scopeList !== undefined) cleanUpdates.scopeList = updates.scopeList;
  if (updates.finalReviewer !== undefined) cleanUpdates.finalReviewer = updates.finalReviewer;
  if (updates.swinertonProject !== undefined) cleanUpdates.swinertonProject = updates.swinertonProject;
  if (updates.region !== undefined) cleanUpdates.region = updates.region;
  if (updates.primaryMarket !== undefined) cleanUpdates.primaryMarket = updates.primaryMarket;
  if (updates.filePath !== undefined) cleanUpdates.filePath = updates.filePath;
  if (updates.screenshotPath !== undefined) cleanUpdates.screenshotPath = updates.screenshotPath;
  if (updates.screenshotData !== undefined) cleanUpdates.screenshotData = updates.screenshotData;
  if (updates.screenshotMimeType !== undefined) cleanUpdates.screenshotMimeType = updates.screenshotMimeType;
  if (updates.sourceType !== undefined) cleanUpdates.sourceType = updates.sourceType;
  if (updates.sourceEmail !== undefined) cleanUpdates.sourceEmail = updates.sourceEmail;
  if (updates.sourceEmailSubject !== undefined) cleanUpdates.sourceEmailSubject = updates.sourceEmailSubject;
  if (updates.sourceAttachmentUrl !== undefined) cleanUpdates.sourceAttachmentUrl = updates.sourceAttachmentUrl;

  if (Object.keys(cleanUpdates).length === 0) return null;

  const [updated] = await db.update(proposalLogEntries)
    .set(cleanUpdates)
    .where(eq(proposalLogEntries.id, id))
    .returning();

  if (updated && isGoogleSheetConfigured()) triggerSheetSync();
  return updated || null;
}

export async function deleteProposalLogEntry(id: number) {
  const [deleted] = await db.update(proposalLogEntries)
    .set({ deletedAt: new Date() })
    .where(eq(proposalLogEntries.id, id))
    .returning();
  if (deleted && isGoogleSheetConfigured()) triggerSheetSync();
  return deleted || null;
}

export async function deleteProposalLogEntries(ids: number[]) {
  if (!ids.length) return 0;
  const deleted = await db.update(proposalLogEntries)
    .set({ deletedAt: new Date() })
    .where(inArray(proposalLogEntries.id, ids))
    .returning();
  if (deleted.length > 0 && isGoogleSheetConfigured()) triggerSheetSync();
  return deleted.length;
}

export async function requestDeleteEntry(id: number, requestedByName: string) {
  const [updated] = await db.update(proposalLogEntries)
    .set({ pendingDeletion: true, pendingDeletionBy: requestedByName, pendingDeletionAt: new Date() })
    .where(and(eq(proposalLogEntries.id, id), isNull(proposalLogEntries.deletedAt)))
    .returning();
  return updated || null;
}

export async function cancelDeleteRequest(id: number) {
  const [updated] = await db.update(proposalLogEntries)
    .set({ pendingDeletion: false, pendingDeletionBy: null, pendingDeletionAt: null })
    .where(eq(proposalLogEntries.id, id))
    .returning();
  return updated || null;
}

export async function approveDeleteEntry(id: number) {
  return deleteProposalLogEntry(id);
}

export async function rejectDeleteEntry(id: number) {
  return cancelDeleteRequest(id);
}

export async function getScreenshotPathByProjectId(projectDbId: number): Promise<string | null> {
  const [entry] = await db.select({ screenshotPath: proposalLogEntries.screenshotPath })
    .from(proposalLogEntries)
    .where(eq(proposalLogEntries.projectDbId, projectDbId));
  return entry?.screenshotPath || null;
}

export async function getAcknowledgedEntryIds(userId: number): Promise<number[]> {
  const rows = await db.select({ entryId: proposalAcknowledgements.entryId })
    .from(proposalAcknowledgements)
    .where(eq(proposalAcknowledgements.userId, userId));
  return rows.map(r => r.entryId);
}

export async function acknowledgeEntry(userId: number, entryId: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO proposal_acknowledgements (user_id, entry_id)
    VALUES (${userId}, ${entryId})
    ON CONFLICT (user_id, entry_id) DO NOTHING
  `);
}

export async function unacknowledgeEntry(userId: number, entryId: number): Promise<void> {
  await db.delete(proposalAcknowledgements)
    .where(and(
      eq(proposalAcknowledgements.userId, userId),
      eq(proposalAcknowledgements.entryId, entryId)
    ));
}

export async function clearAcknowledgementsForEntry(entryId: number): Promise<void> {
  await db.delete(proposalAcknowledgements)
    .where(eq(proposalAcknowledgements.entryId, entryId));
}
