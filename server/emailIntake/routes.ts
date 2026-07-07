import type { Express, Request, Response } from "express";
import multer from "multer";
import { db } from "../db";
import { emailIntakeLog } from "@shared/schema";
import { desc, eq } from "drizzle-orm";
import { processEmailIntake, type IntakeFileResult } from "./intakeService";
import { sniffEmailType } from "./emailParser";

const MAX_EMAIL_FILES = 10;
const MAX_EMAIL_BYTES = 25 * 1024 * 1024;

const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EMAIL_BYTES, files: MAX_EMAIL_FILES },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || "").toLowerCase();
    const okExt = name.endsWith(".eml") || name.endsWith(".msg");
    const okMime = ["message/rfc822", "application/vnd.ms-outlook", "application/octet-stream", "text/plain", ""].includes(
      (file.mimetype || "").toLowerCase(),
    );
    // Extension is the primary gate; content is magic-byte sniffed after upload.
    if (okExt && okMime) return cb(null, true);
    if (okExt) return cb(null, true);
    cb(new Error(`"${file.originalname}" is not an email file — drop .eml or .msg files`));
  },
});

function handleEmailUploadError(req: Request, res: Response, next: Function) {
  emailUpload.array("emails", MAX_EMAIL_FILES)(req, res, (err: any) => {
    if (err) {
      console.error("[EmailIntake] Upload error:", err.message);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: `Each email file must be under ${MAX_EMAIL_BYTES / (1024 * 1024)}MB` });
      }
      return res.status(400).json({ message: err.message || "Invalid file upload" });
    }
    next();
  });
}

export function registerEmailIntakeRoutes(app: Express) {
  // Drag-and-drop bid-invite email intake. Auth: any logged-in user (global
  // /api middleware) — intake only creates drafts; approval still requires
  // draft-review access. Intake must never be blocked by permissions, or
  // bids get missed.
  app.post("/api/email-intake", handleEmailUploadError, async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });

      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        return res.status(400).json({ message: "No email files uploaded — drop .eml or .msg files" });
      }

      const results: IntakeFileResult[] = [];
      for (const file of files) {
        // Cheap pre-check for obviously wrong content (renamed pdf/png/etc.)
        if (sniffEmailType(file.buffer) === "unknown" && !file.originalname.toLowerCase().endsWith(".msg")) {
          results.push({
            fileName: file.originalname,
            status: "failed",
            intakeId: null,
            entryId: null,
            fields: null,
            provenance: null,
            bcEnrichment: { status: "no_link", opportunityId: null, ndaRequired: false },
            duplicates: [],
            extractionTier: null,
            message: "Not an email file (.eml/.msg)",
            error: "Not an email file (.eml/.msg)",
          });
          continue;
        }
        const result = await processEmailIntake({ buffer: file.buffer, originalname: file.originalname }, userId);
        results.push(result);
      }

      res.json({ results });
    } catch (err) {
      console.error("[EmailIntake] Route error:", err);
      res.status(500).json({ message: "Failed to process email intake" });
    }
  });

  // Paginated intake ledger — the audit view of every drop ever made.
  app.get("/api/email-intake/log", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });

      const limit = Math.min(parseInt(String(req.query.limit || "50")) || 50, 200);
      const offset = Math.max(parseInt(String(req.query.offset || "0")) || 0, 0);

      const rows = await db
        .select({
          id: emailIntakeLog.id,
          fileName: emailIntakeLog.fileName,
          fileType: emailIntakeLog.fileType,
          fromEmail: emailIntakeLog.fromEmail,
          subject: emailIntakeLog.subject,
          emailDate: emailIntakeLog.emailDate,
          status: emailIntakeLog.status,
          entryId: emailIntakeLog.entryId,
          bcLink: emailIntakeLog.bcLink,
          bcOpportunityId: emailIntakeLog.bcOpportunityId,
          bcEnrichmentStatus: emailIntakeLog.bcEnrichmentStatus,
          extractedFields: emailIntakeLog.extractedFields,
          provenance: emailIntakeLog.provenance,
          errorMessage: emailIntakeLog.errorMessage,
          uploadedBy: emailIntakeLog.uploadedBy,
          createdAt: emailIntakeLog.createdAt,
        })
        .from(emailIntakeLog)
        .orderBy(desc(emailIntakeLog.id))
        .limit(limit)
        .offset(offset);

      res.json({ entries: rows, limit, offset });
    } catch (err) {
      console.error("[EmailIntake] Log fetch error:", err);
      res.status(500).json({ message: "Failed to fetch email intake log" });
    }
  });

  // Download the original dropped email (audit requirement / review link).
  app.get("/api/email-intake/:id/raw", async (req: Request, res: Response) => {
    try {
      const userId = (req.session as any)?.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });

      const [row] = await db
        .select({ rawEmail: emailIntakeLog.rawEmail, fileName: emailIntakeLog.fileName, fileType: emailIntakeLog.fileType })
        .from(emailIntakeLog)
        .where(eq(emailIntakeLog.id, id));
      if (!row || !row.rawEmail) return res.status(404).json({ message: "Original email not found" });

      const fileName = row.fileName || `email-${id}.${row.fileType || "eml"}`;
      res.setHeader("Content-Type", row.fileType === "msg" ? "application/vnd.ms-outlook" : "message/rfc822");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/[^\w.\- ]+/g, "_")}"`);
      res.send(row.rawEmail);
    } catch (err) {
      console.error("[EmailIntake] Raw download error:", err);
      res.status(500).json({ message: "Failed to download original email" });
    }
  });
}
