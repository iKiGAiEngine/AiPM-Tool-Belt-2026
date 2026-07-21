import crypto from "crypto";
import { db } from "../db";
import { emailIntakeLog, proposalLogEntries, bcSyncLog } from "@shared/schema";
import { eq } from "drizzle-orm";
import { parseEmailFile, type ParsedEmail } from "./emailParser";
import { extractFieldsFromEmail, type ExtractionTier } from "./fieldExtractor";
import { findBcLink, extractOpportunityIdFromLink } from "./bcLinkResolver";
import { pullBcOpportunity, type BcEnrichmentStatus } from "./bcReferencePull";
import { mapOpportunityToEntry, looksLikeNdaInvite, NDA_NOTE } from "../autodesk/bcSync";
import { guessMarket } from "../proposalLogService";
import { getActiveRegions } from "../scopeDictionaryStorage";
import { isSwinerton, matchSwinertonOffice, matchExtRegion } from "../swinertonOffices";
import { findFuzzyDuplicates, type DuplicateMatch } from "../fuzzyDuplicates";
import { recordEntryCreation, resolveChangedByName } from "../changeLogger";
import { auditLog } from "../auditService";
import { createNotificationForAdmins } from "../notificationRoutes";
import { sendDraftNotificationEmail } from "../emailService";

export type FieldProvenance = "email" | "bc" | "fallback";

export interface IntakeFileResult {
  fileName: string;
  status: "draft_created" | "duplicate_intake" | "failed";
  intakeId: number | null;
  entryId: number | null;
  /** The entry-shaped fields that were written to the draft */
  fields: Record<string, any> | null;
  provenance: Record<string, FieldProvenance> | null;
  bcEnrichment: {
    status: BcEnrichmentStatus;
    opportunityId: string | null;
    ndaRequired: boolean;
  };
  duplicates: DuplicateMatch[];
  extractionTier: ExtractionTier | null;
  /** Human-readable outcome message for the UI result card */
  message: string;
  error: string | null;
}

export interface IntakeOptions {
  /** Injectable fetch for BC pull + tracker unwrapping (tests/audit) */
  fetchImpl?: typeof fetch;
  /** Mark created drafts as test data (audit script cleanup) */
  isTest?: boolean;
}

/** Fields that flow from the email extraction into a proposal-log entry. */
function emailFieldsToEntry(email: ParsedEmail, fields: Record<string, any>, regionLabel: string, bcLink: string | null) {
  return {
    projectName: fields.projectName || "",
    region: regionLabel,
    primaryMarket: guessMarket(fields.projectName || "", email.text.slice(0, 4000)),
    dueDate: fields.dueDate || "",
    inviteDate: fields.inviteDate || "",
    anticipatedStart: fields.expectedStart || "",
    anticipatedFinish: fields.expectedFinish || "",
    gcEstimateLead: fields.gcContactName || "",
    selfPerformEstimator: "",
    owner: fields.clientName || "",
    bcLink: bcLink || "",
    bcProjectId: "",
    bcOpportunityIds: null as string | null,
    scopeList: fields.tradeName ? JSON.stringify([fields.tradeName]) : null,
    projectAddress: fields.location || "",
    squareFeet: fields.squareFeet || "",
    ndaRequired: false,
    bcAccessStatus: null as string | null,
    notes: "",
  };
}

/** Region match for email-only drafts — same logic as /api/extract-project-details. */
async function matchRegionForEmail(clientName: string, clientLocation: string): Promise<string> {
  if (!clientName && !clientLocation) return "";
  try {
    const activeRegions = await getActiveRegions();
    let regionMatch: { code: string; displayLabel?: string; confident: boolean } = { code: "", confident: false };

    if (isSwinerton(clientName)) {
      const fullClientStr = [clientName, clientLocation].filter(Boolean).join(" - ");
      const candidateStrings = Array.from(new Set([fullClientStr, clientLocation].filter(Boolean)));
      for (const str of candidateStrings) {
        const r = matchSwinertonOffice(str, activeRegions);
        if (r.confident) { regionMatch = r; break; }
      }
      if (!regionMatch.confident && clientLocation) {
        const segments = clientLocation.split(/[-–—]/).map(s => s.trim()).filter(Boolean);
        for (const seg of segments) {
          const segMatch = matchSwinertonOffice(seg, activeRegions);
          if (segMatch.confident) { regionMatch = segMatch; break; }
        }
      }
    } else if (clientName) {
      regionMatch = matchExtRegion(clientName, activeRegions);
    }

    if (regionMatch.confident && regionMatch.code) {
      return (regionMatch as any).displayLabel || regionMatch.code;
    }
  } catch (err: any) {
    console.warn("[EmailIntake] Region match failed:", err.message);
  }
  return "";
}

/**
 * BC-enriched values override email values per field when non-empty.
 * Returns the merged entry values plus per-field provenance.
 */
export function mergeWithProvenance(
  emailEntry: Record<string, any>,
  bcEntry: Record<string, any> | null,
  emailProvenance: Record<string, FieldProvenance>,
): { merged: Record<string, any>; provenance: Record<string, FieldProvenance> } {
  const merged: Record<string, any> = { ...emailEntry };
  const provenance: Record<string, FieldProvenance> = {};

  for (const [key, value] of Object.entries(emailEntry)) {
    if (value !== "" && value != null && value !== false) {
      provenance[key] = emailProvenance[key] || "email";
    }
  }

  if (bcEntry) {
    for (const [key, value] of Object.entries(bcEntry)) {
      if (key === "regionNotConfident" || key === "isDraft" || key === "estimateStatus" || key === "sourceType" || key === "isTest") continue;
      const nonEmpty = value !== "" && value != null && !(typeof value === "boolean" && value === false);
      if (nonEmpty) {
        merged[key] = value;
        provenance[key] = "bc";
      }
    }
    // ndaRequired=false from BC is still authoritative when enriched
    if (typeof bcEntry.ndaRequired === "boolean") {
      merged.ndaRequired = bcEntry.ndaRequired;
    }
  }

  return { merged, provenance };
}

function baseResult(fileName: string): IntakeFileResult {
  return {
    fileName,
    status: "failed",
    intakeId: null,
    entryId: null,
    fields: null,
    provenance: null,
    bcEnrichment: { status: "no_link", opportunityId: null, ndaRequired: false },
    duplicates: [],
    extractionTier: null,
    message: "",
    error: null,
  };
}

async function markFailed(intakeId: number | null, result: IntakeFileResult, error: string): Promise<IntakeFileResult> {
  result.status = "failed";
  result.error = error;
  result.message = `Failed: ${error} — logged for review`;
  if (intakeId != null) {
    try {
      await db.update(emailIntakeLog).set({ status: "failed", errorMessage: error }).where(eq(emailIntakeLog.id, intakeId));
    } catch (err: any) {
      console.error("[EmailIntake] Could not mark intake row failed:", err.message);
    }
  }
  try {
    await createNotificationForAdmins({
      type: "email_intake_failed",
      title: "Email Intake Failed",
      message: `"${result.fileName}": ${error}`,
      metadata: { intakeId, fileName: result.fileName, error },
    });
  } catch (err: any) {
    console.error("[EmailIntake] Could not notify admins of failure:", err.message);
  }
  return result;
}

/**
 * Process one dropped bid-invite email end-to-end:
 * parse → extract → BC reference pull → merge → draft + dup detection → audit.
 *
 * Deterministic outcome guarantee: every call returns exactly one of
 * draft_created | duplicate_intake | failed, and (except for pre-ledger
 * failures like a non-email file) leaves an email_intake_log row behind.
 */
export async function processEmailIntake(
  file: { buffer: Buffer; originalname: string },
  userId: number,
  opts: IntakeOptions = {},
): Promise<IntakeFileResult> {
  const result = baseResult(file.originalname);
  const fetchImpl = opts.fetchImpl || fetch;

  // ── Step 1: content-hash idempotency ──
  const contentHash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  let intakeId: number | null = null;
  try {
    const [existing] = await db.select().from(emailIntakeLog).where(eq(emailIntakeLog.contentHash, contentHash));
    if (existing) {
      if (existing.status === "draft_created" || existing.status === "duplicate_intake") {
        result.status = "duplicate_intake";
        result.intakeId = existing.id;
        result.entryId = existing.entryId;
        result.message = existing.entryId
          ? `Already imported — this email was previously added (entry #${existing.entryId}).`
          : "Already imported — this exact email was previously dropped.";
        return result;
      }
      // failed or stuck-processing row: reuse it so a re-drop retries cleanly
      intakeId = existing.id;
      await db.update(emailIntakeLog).set({
        status: "processing",
        errorMessage: null,
        fileName: file.originalname,
        uploadedBy: userId,
      }).where(eq(emailIntakeLog.id, intakeId));
    }
  } catch (err: any) {
    console.error("[EmailIntake] Ledger lookup failed:", err.message);
    return markFailed(null, result, `Intake ledger unavailable: ${err.message}`);
  }

  // ── Step 2: ledger row FIRST (crash-visible) ──
  if (intakeId == null) {
    try {
      const [row] = await db.insert(emailIntakeLog).values({
        contentHash,
        fileName: file.originalname,
        rawEmail: file.buffer,
        status: "processing",
        uploadedBy: userId,
      }).returning({ id: emailIntakeLog.id });
      intakeId = row.id;
    } catch (err: any) {
      console.error("[EmailIntake] Ledger insert failed:", err.message);
      return markFailed(null, result, `Intake ledger unavailable: ${err.message}`);
    }
  }
  result.intakeId = intakeId;

  try {
    // ── Step 3: parse ──
    let email: ParsedEmail;
    try {
      email = await parseEmailFile(file.buffer, file.originalname);
    } catch (err: any) {
      return await markFailed(intakeId, result, err.message);
    }

    await db.update(emailIntakeLog).set({
      messageId: email.messageId,
      fileType: email.fileType,
      fromEmail: email.fromEmail,
      subject: email.subject.slice(0, 500),
      emailDate: email.date,
      parsedText: email.text.slice(0, 100000),
    }).where(eq(emailIntakeLog.id, intakeId));

    // ── Step 4: field extraction (tiered, never throws) ──
    const extraction = await extractFieldsFromEmail(email);
    result.extractionTier = extraction.tier;

    // ── Step 5: BC link + reference pull ──
    const bcLink = await findBcLink(email, fetchImpl);
    const ids = bcLink ? extractOpportunityIdFromLink(bcLink) : { opportunityId: null, projectId: null };
    const pull = bcLink
      ? await pullBcOpportunity(userId, ids, fetchImpl)
      : { status: "no_link" as BcEnrichmentStatus };

    let bcEntry: Record<string, any> | null = null;
    let bcStatus: BcEnrichmentStatus = pull.status;
    let ndaRequired = false;
    // Tracks whether the region couldn't be confidently resolved, so the
    // consolidated "BC Invites" review UI can flag it (persisted column added
    // by the bid-intake overhaul; bcSync sets it the same way).
    let regionNeedsReview = false;
    if (pull.status === "enriched" && pull.opportunity) {
      const { regionNotConfident, ...mapped } = await mapOpportunityToEntry(pull.opportunity);
      bcEntry = mapped;
      regionNeedsReview = regionNotConfident;
      ndaRequired = looksLikeNdaInvite(pull.opportunity);
      if (ndaRequired) bcStatus = "nda_restricted";
    }

    result.bcEnrichment = { status: bcStatus, opportunityId: ids.opportunityId, ndaRequired };

    await db.update(emailIntakeLog).set({
      bcLink: bcLink || null,
      bcOpportunityId: ids.opportunityId,
      bcEnrichmentStatus: bcStatus,
      bcRawData: (pull as any).raw || null,
    }).where(eq(emailIntakeLog.id, intakeId));

    // ── Step 6: merge email + BC fields with provenance ──
    const regionLabel = bcEntry?.region
      ? "" // BC path supplies its own region below
      : await matchRegionForEmail(extraction.fields.clientName || "", extraction.fields.clientLocation || "");
    // Email-only drafts: matchRegionForEmail only returns a label on a
    // confident match, so an empty result means a human should set the region.
    if (!bcEntry) regionNeedsReview = !regionLabel;
    const emailEntry = emailFieldsToEntry(email, extraction.fields, regionLabel, bcLink);

    const emailProvenance: Record<string, FieldProvenance> = {};
    if (extraction.tier === "floor") {
      for (const key of Object.keys(emailEntry)) emailProvenance[key] = "fallback";
    } else {
      for (const key of extraction.floorBackfilled) {
        if (key === "gcContactName") emailProvenance.gcEstimateLead = "fallback";
        if (key === "gcContactEmail") emailProvenance.gcEstimateLead = emailProvenance.gcEstimateLead || "fallback";
        if (key === "projectName") emailProvenance.projectName = "fallback";
        if (key === "inviteDate") emailProvenance.inviteDate = "fallback";
      }
    }

    const { merged, provenance } = mergeWithProvenance(emailEntry, bcEntry, emailProvenance);

    if (!merged.projectName) {
      merged.projectName = `Untitled bid invite (${file.originalname})`;
      provenance.projectName = "fallback";
    }
    merged.projectName = String(merged.projectName).slice(0, 500);

    // ── Step 7: duplicate-opportunity guard + draft insert ──
    if (ids.opportunityId) {
      const [existingSync] = await db.select().from(bcSyncLog).where(eq(bcSyncLog.bcOpportunityId, ids.opportunityId));
      if (existingSync?.entryId) {
        const [existingEntry] = await db.select().from(proposalLogEntries).where(eq(proposalLogEntries.id, existingSync.entryId));
        if (existingEntry && !existingEntry.deletedAt) {
          result.status = "duplicate_intake";
          result.entryId = existingEntry.id;
          result.message = `This BuildingConnected opportunity is already in the log as "${existingEntry.projectName}"${existingEntry.estimateNumber ? ` (#${existingEntry.estimateNumber})` : ""}.`;
          await db.update(emailIntakeLog).set({ status: "duplicate_intake", entryId: existingEntry.id }).where(eq(emailIntakeLog.id, intakeId));
          return result;
        }
      }
    }

    const sourceType = bcEntry ? "bc-email" : "email";
    const insertValues = {
      ...merged,
      isDraft: true,
      estimateStatus: "Draft",
      isTest: opts.isTest ?? false,
      syncedToLocal: false,
      regionNeedsReview,
      sourceType,
      sourceEmail: email.fromEmail.slice(0, 500),
      sourceEmailSubject: email.subject.slice(0, 500),
      sourceAttachmentUrl: `/api/email-intake/${intakeId}/raw`,
      notes: merged.ndaRequired ? NDA_NOTE : merged.notes || "",
    } as typeof proposalLogEntries.$inferInsert;
    const [entry] = await db.insert(proposalLogEntries).values(insertValues).returning();

    result.entryId = entry.id;
    result.fields = merged;
    result.provenance = provenance;

    // Link the opportunity so a later BC Sync won't double-create
    if (ids.opportunityId) {
      try {
        await db.insert(bcSyncLog).values({
          bcOpportunityId: ids.opportunityId,
          rawData: ((pull as any).raw || { source: "email-intake" }) as Record<string, unknown>,
          entryId: entry.id,
        });
      } catch (err: any) {
        if ((err as { code?: string })?.code === "23505") {
          console.warn(`[EmailIntake] bcSyncLog row already exists for ${ids.opportunityId}, continuing`);
        } else {
          console.warn("[EmailIntake] bcSyncLog insert failed (non-fatal):", err.message);
        }
      }
    }

    // ── Step 8: fuzzy duplicate detection (re-bid → round candidates) ──
    try {
      const dupMatches = await findFuzzyDuplicates(merged.projectName, 0.40, 5, { includeDrafts: true, excludeId: entry.id });
      if (dupMatches.length > 0) {
        result.duplicates = dupMatches;
        await db.update(proposalLogEntries)
          .set({ duplicateOverrideNote: `__dup:${JSON.stringify(dupMatches)}` })
          .where(eq(proposalLogEntries.id, entry.id));
      }
    } catch (dupErr: any) {
      console.warn("[EmailIntake] Dup check failed, continuing:", dupErr.message);
    }

    // ── Step 9: audit trail + notifications ──
    const changedByName = await resolveChangedByName(userId);
    await recordEntryCreation(entry.id, merged.projectName, null, changedByName);
    await auditLog({
      actorUserId: userId,
      actionType: "email_intake",
      entityType: "proposal_log_entry",
      entityId: String(entry.id),
      summary: `Email intake created draft "${merged.projectName}" from ${file.originalname}`,
      metadata: {
        intakeId,
        contentHash,
        fileType: email.fileType,
        extractionTier: extraction.tier,
        bcEnrichmentStatus: bcStatus,
        bcOpportunityId: ids.opportunityId,
        provenance,
        duplicateCount: result.duplicates.length,
      },
    });
    await createNotificationForAdmins({
      type: "draft_created",
      title: "New Email Draft",
      message: `"${merged.projectName}" imported from a dropped bid-invite email${bcEntry ? " (BC-enriched)" : ""}.`,
      metadata: { entryId: entry.id, intakeId, sourceType },
    });
    sendDraftNotificationEmail("draft_created", merged.projectName, merged.dueDate || "", merged.gcEstimateLead || "").catch(err => {
      console.error("[EmailIntake] Draft notification email error:", err);
    });

    // ── Step 10: finalize ledger ──
    await db.update(emailIntakeLog).set({
      status: "draft_created",
      entryId: entry.id,
      extractedFields: merged,
      provenance,
    }).where(eq(emailIntakeLog.id, intakeId));

    result.status = "draft_created";
    result.message =
      bcStatus === "enriched" ? `Draft created from email + BuildingConnected pull — review in the Drafts tab.`
      : bcStatus === "nda_restricted" ? `Draft created — NDA-restricted invite, some details hidden until the NDA is accepted in BuildingConnected.`
      : bcStatus === "no_connection" ? `Draft created from email only — connect BuildingConnected to auto-pull full project details.`
      : bcStatus === "no_link" ? `Draft created from email data (no BuildingConnected link found).`
      : `Draft created from email only — the BuildingConnected pull ${bcStatus === "not_found" ? "could not find this opportunity" : "failed"}.`;
    return result;
  } catch (err: any) {
    console.error("[EmailIntake] Pipeline error:", err);
    return markFailed(intakeId, result, err.message || "Unexpected processing error");
  }
}
