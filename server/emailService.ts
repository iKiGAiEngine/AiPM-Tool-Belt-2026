import sgMail from "@sendgrid/mail";
import { db } from "./db";
import { emailTemplateConfig } from "@shared/schema";
import { eq } from "drizzle-orm";

const EMAIL_PROVIDER = process.env.SENDGRID_API_KEY ? "sendgrid" : "console";
const EMAIL_FROM = process.env.EMAIL_FROM || "no-reply@aipmapp.com";

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

export const BID_ASSIGNMENT_DEFAULTS = {
  subject: "AiPM Tool Belt - New Bid Assignment",
  greeting: "Hello {{estimator}},",
  bodyMessage: "You have been assigned to a new bid. Please review the details below and begin your estimate.",
  signOff: "Thank you,\nAiPM Tool Belt Team",
};

export const PROJECT_WON_DEFAULTS = {
  subject: "AiPM Tool Belt - Project Won",
  bodyMessage: "Great news! A project has been marked as Won. Please see the details below.",
  signOff: "Congratulations,\nAiPM Tool Belt Team",
};

export async function getBidAssignmentTemplate(): Promise<{
  subject: string;
  greeting: string;
  bodyMessage: string;
  signOff: string;
}> {
  const [config] = await db
    .select()
    .from(emailTemplateConfig)
    .where(eq(emailTemplateConfig.templateKey, "bid_assignment"));

  if (config) {
    return {
      subject: config.subject,
      greeting: config.greeting,
      bodyMessage: config.bodyMessage,
      signOff: config.signOff,
    };
  }

  return { ...BID_ASSIGNMENT_DEFAULTS };
}

export async function saveBidAssignmentTemplate(data: {
  subject: string;
  greeting: string;
  bodyMessage: string;
  signOff: string;
}): Promise<void> {
  const [existing] = await db
    .select()
    .from(emailTemplateConfig)
    .where(eq(emailTemplateConfig.templateKey, "bid_assignment"));

  if (existing) {
    await db
      .update(emailTemplateConfig)
      .set({
        subject: data.subject,
        greeting: data.greeting,
        bodyMessage: data.bodyMessage,
        signOff: data.signOff,
        updatedAt: new Date(),
      })
      .where(eq(emailTemplateConfig.id, existing.id));
  } else {
    await db.insert(emailTemplateConfig).values({
      templateKey: "bid_assignment",
      subject: data.subject,
      greeting: data.greeting,
      bodyMessage: data.bodyMessage,
      signOff: data.signOff,
    });
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function buildBidAssignmentHtml(
  template: { subject: string; greeting: string; bodyMessage: string; signOff: string },
  details: {
    estimatorName: string;
    projectName: string;
    estimateNumber: string;
    dueDate: string;
    gcLead: string;
  }
): { subject: string; text: string; html: string } {
  const greeting = escapeHtml(template.greeting.replace(/\{\{estimator\}\}/g, details.estimatorName));
  const bodyMessage = escapeHtml(template.bodyMessage);
  const signOff = escapeHtml(template.signOff).replace(/\n/g, "<br>");

  const subject = template.subject;

  const text = [
    greeting,
    "",
    bodyMessage,
    "",
    `Project: ${details.projectName}`,
    `Estimate #: ${details.estimateNumber}`,
    `Due Date: ${details.dueDate || "Not set"}`,
    `GC Lead: ${details.gcLead || "Not set"}`,
    "",
    template.signOff,
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #333; font-size: 15px; margin: 0 0 16px 0;">${greeting}</p>
      <p style="color: #555; font-size: 14px; margin: 0 0 20px 0;">${bodyMessage}</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #D4A843;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px; width: 110px;">Project</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.projectName)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Estimate #</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.estimateNumber)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Due Date</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.dueDate || "Not set")}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">GC Lead</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.gcLead || "Not set")}</td>
          </tr>
        </table>
      </div>
      <p style="color: #666; font-size: 13px; margin: 0;">${signOff}</p>
    </div>
  `;

  return { subject, text, html };
}

export interface BidAssignmentDetails {
  estimatorInitials: string;
  projectName: string;
  estimateNumber: string;
  dueDate: string;
  gcLead: string;
}

export async function sendBidAssignmentEmail(
  to: string,
  estimatorName: string,
  details: BidAssignmentDetails
): Promise<void> {
  const template = await getBidAssignmentTemplate();

  const { subject, text, html } = buildBidAssignmentHtml(template, {
    estimatorName,
    projectName: details.projectName,
    estimateNumber: details.estimateNumber,
    dueDate: details.dueDate,
    gcLead: details.gcLead,
  });

  if (EMAIL_PROVIDER === "sendgrid") {
    try {
      await sgMail.send({ to, from: EMAIL_FROM, subject, text, html });
      console.log(`[Email] Bid assignment notification sent to ${to} via SendGrid`);
    } catch (error: any) {
      console.error(`[Email] SendGrid error sending bid assignment:`, error?.response?.body || error.message);
    }
  } else {
    console.log(`\n========================================`);
    console.log(`[Email-DEV] Bid Assignment Notification`);
    console.log(`To: ${to}`);
    console.log(`Estimator: ${estimatorName} (${details.estimatorInitials})`);
    console.log(`Project: ${details.projectName}`);
    console.log(`Estimate #: ${details.estimateNumber}`);
    console.log(`Due Date: ${details.dueDate || "Not set"}`);
    console.log(`GC Lead: ${details.gcLead || "Not set"}`);
    console.log(`========================================\n`);
  }
}

export async function sendDraftNotificationEmail(
  eventType: "draft_created" | "draft_scope_updated" | "draft_bc_updated",
  projectName: string,
  dueDate: string,
  gcLead: string
): Promise<void> {
  const ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL || "Haley.Kruse@nationalbuildingspecialties.com";

  const titles: Record<string, string> = {
    draft_created: "New BC Draft Imported",
    draft_scope_updated: "BC Draft Scopes Updated",
    draft_bc_updated: "BC Draft Details Updated",
  };

  const bodies: Record<string, string> = {
    draft_created: `A new draft has been imported from BuildingConnected and needs your review.`,
    draft_scope_updated: `The scopes for this draft have been updated from BuildingConnected.`,
    draft_bc_updated: `Details for this draft have been updated from BuildingConnected.`,
  };

  const subject = `AiPM Tool Belt - ${titles[eventType]}`;
  const bodyMsg = bodies[eventType];

  const text = [
    bodyMsg,
    "",
    `Project: ${projectName}`,
    `Due Date: ${dueDate || "Not set"}`,
    `GC Lead: ${gcLead || "Not set"}`,
    "",
    "Please log in to AiPM Tool Belt to review.",
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #555; font-size: 14px; margin: 0 0 20px 0;">${escapeHtml(bodyMsg)}</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #D4A843;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px; width: 110px;">Project</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(projectName)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Due Date</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(dueDate || "Not set")}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">GC Lead</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(gcLead || "Not set")}</td>
          </tr>
        </table>
      </div>
      <p style="color: #666; font-size: 13px; margin: 0;">Please log in to review and take action.</p>
    </div>
  `;

  if (EMAIL_PROVIDER === "sendgrid") {
    try {
      await sgMail.send({ to: ADMIN_EMAIL, from: EMAIL_FROM, subject, text, html });
      console.log(`[Email] Draft notification (${eventType}) sent to ${ADMIN_EMAIL} via SendGrid`);
    } catch (error: any) {
      console.error(`[Email] SendGrid error sending draft notification:`, error?.response?.body || error.message);
    }
  } else {
    console.log(`\n========================================`);
    console.log(`[Email-DEV] Draft Notification (${eventType})`);
    console.log(`To: ${ADMIN_EMAIL}`);
    console.log(`Project: ${projectName}`);
    console.log(`Due Date: ${dueDate || "Not set"}`);
    console.log(`GC Lead: ${gcLead || "Not set"}`);
    console.log(`========================================\n`);
  }
}

export async function getProjectWonTemplate(): Promise<{
  subject: string;
  bodyMessage: string;
  signOff: string;
}> {
  const [config] = await db
    .select()
    .from(emailTemplateConfig)
    .where(eq(emailTemplateConfig.templateKey, "project_won"));

  if (config) {
    return {
      subject: config.subject,
      bodyMessage: config.bodyMessage,
      signOff: config.signOff,
    };
  }

  return { ...PROJECT_WON_DEFAULTS };
}

export async function saveProjectWonTemplate(data: {
  subject: string;
  bodyMessage: string;
  signOff: string;
}): Promise<void> {
  const [existing] = await db
    .select()
    .from(emailTemplateConfig)
    .where(eq(emailTemplateConfig.templateKey, "project_won"));

  if (existing) {
    await db
      .update(emailTemplateConfig)
      .set({
        subject: data.subject,
        greeting: "",
        bodyMessage: data.bodyMessage,
        signOff: data.signOff,
        updatedAt: new Date(),
      })
      .where(eq(emailTemplateConfig.id, existing.id));
  } else {
    await db.insert(emailTemplateConfig).values({
      templateKey: "project_won",
      subject: data.subject,
      greeting: "",
      bodyMessage: data.bodyMessage,
      signOff: data.signOff,
    });
  }
}

export interface ProjectWonDetails {
  projectName: string;
  estimateNumber: string;
  proposalTotal: string;
  gcLead: string;
  dueDate: string;
}

export async function sendProjectWonEmail(
  recipients: string[],
  details: ProjectWonDetails
): Promise<void> {
  if (recipients.length === 0) return;

  const template = await getProjectWonTemplate();

  const bodyMessage = escapeHtml(template.bodyMessage);
  const signOff = escapeHtml(template.signOff).replace(/\n/g, "<br>");

  const text = [
    template.bodyMessage,
    "",
    `Project: ${details.projectName}`,
    `Estimate #: ${details.estimateNumber}`,
    `Proposal Total: ${details.proposalTotal || "Not set"}`,
    `GC Lead: ${details.gcLead || "Not set"}`,
    `Due Date: ${details.dueDate || "Not set"}`,
    "",
    template.signOff,
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #555; font-size: 14px; margin: 0 0 20px 0;">${bodyMessage}</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 20px; margin-bottom: 24px; border-left: 4px solid #D4A843;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px; width: 120px;">Project</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.projectName)}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Estimate #</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.estimateNumber || "Not set")}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Proposal Total</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.proposalTotal || "Not set")}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">GC Lead</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.gcLead || "Not set")}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #888; font-size: 13px;">Due Date</td>
            <td style="padding: 6px 0; color: #111; font-size: 14px; font-weight: 600;">${escapeHtml(details.dueDate || "Not set")}</td>
          </tr>
        </table>
      </div>
      <p style="color: #666; font-size: 13px; margin: 0;">${signOff}</p>
    </div>
  `;

  if (EMAIL_PROVIDER === "sendgrid") {
    for (const to of recipients) {
      try {
        await sgMail.send({ to, from: EMAIL_FROM, subject: template.subject, text, html });
        console.log(`[Email] Project Won notification sent to ${to} via SendGrid`);
      } catch (error: any) {
        console.error(`[Email] SendGrid error sending project won notification to ${to}:`, error?.response?.body || error.message);
      }
    }
  } else {
    console.log(`\n========================================`);
    console.log(`[Email-DEV] Project Won Notification`);
    console.log(`To: ${recipients.join(", ")}`);
    console.log(`Project: ${details.projectName}`);
    console.log(`Estimate #: ${details.estimateNumber}`);
    console.log(`Proposal Total: ${details.proposalTotal || "Not set"}`);
    console.log(`GC Lead: ${details.gcLead || "Not set"}`);
    console.log(`Due Date: ${details.dueDate || "Not set"}`);
    console.log(`========================================\n`);
  }
}

export async function sendInviteEmail(to: string, token: string): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL || "http://localhost:5000";
  const link = `${baseUrl}/reset-password?token=${token}`;
  const subject = "You've been invited to AiPM — set your password.";
  const text = `You have been invited to AiPM Tool Belt.\n\nSet your password using the link below (valid for 72 hours):\n${link}\n\nIf you did not expect this email, you can ignore it.`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #333; font-size: 15px;">You have been invited to access <strong>AiPM Tool Belt</strong>.</p>
      <p style="color: #555; font-size: 14px;">Click the button below to set your password and activate your account. This link is valid for <strong>72 hours</strong>.</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${link}" style="display: inline-block; padding: 13px 28px; background: linear-gradient(135deg, #D4A843, #B8903C); color: #fff; font-weight: 700; font-size: 15px; border-radius: 8px; text-decoration: none; letter-spacing: 0.5px;">Set Your Password</a>
      </div>
      <p style="color: #888; font-size: 12px;">If you did not expect this invitation, you can safely ignore this email.</p>
    </div>
  `;

  if (EMAIL_PROVIDER === "sendgrid") {
    try {
      await sgMail.send({ to, from: EMAIL_FROM, subject, text, html });
      console.log(`[Email] Invite sent to ${to} via SendGrid`);
    } catch (error: any) {
      console.error(`[Email] SendGrid error sending invite:`, error?.response?.body || error.message);
      throw new Error("Failed to send invite email");
    }
  } else {
    console.log(`\n========================================`);
    console.log(`[Email-DEV] Invite for ${to}`);
    console.log(`Link: ${link}`);
    console.log(`========================================\n`);
  }
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL || "http://localhost:5000";
  const link = `${baseUrl}/reset-password?token=${token}`;
  const subject = "Reset your AiPM password.";
  const text = `You requested a password reset for your AiPM Tool Belt account.\n\nReset your password using the link below (valid for 1 hour):\n${link}\n\nIf you did not request this, please ignore this email.`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <div style="border-bottom: 3px solid #D4A843; padding-bottom: 12px; margin-bottom: 24px;">
        <h2 style="margin: 0; font-size: 20px; color: #111;">AiPM Tool Belt</h2>
      </div>
      <p style="color: #333; font-size: 15px;">We received a request to reset your password.</p>
      <p style="color: #555; font-size: 14px;">Click the button below to choose a new password. This link is valid for <strong>1 hour</strong>.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin: 28px auto;">
        <tr>
          <td align="center" bgcolor="#B8903C" style="background-color: #B8903C; border-radius: 8px;">
            <a href="${link}" target="_blank" style="display: inline-block; padding: 14px 32px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 700; color: #ffffff; text-decoration: none; letter-spacing: 0.5px; border-radius: 8px; mso-padding-alt: 0;">
              <!--[if mso]>&nbsp;&nbsp;&nbsp;&nbsp;<![endif]-->Reset Password<!--[if mso]>&nbsp;&nbsp;&nbsp;&nbsp;<![endif]-->
            </a>
          </td>
        </tr>
      </table>
      <p style="color: #555; font-size: 13px; word-break: break-all;">Or copy and paste this link into your browser:<br><a href="${link}" style="color: #B8903C;">${link}</a></p>
      <p style="color: #888; font-size: 12px;">If you did not request a password reset, you can safely ignore this email.</p>
    </div>
  `;

  if (EMAIL_PROVIDER === "sendgrid") {
    try {
      await sgMail.send({ to, from: EMAIL_FROM, subject, text, html });
      console.log(`[Email] Password reset sent to ${to} via SendGrid`);
    } catch (error: any) {
      console.error(`[Email] SendGrid error sending password reset:`, error?.response?.body || error.message);
      throw new Error("Failed to send password reset email");
    }
  } else {
    console.log(`\n========================================`);
    console.log(`[Email-DEV] Password Reset for ${to}`);
    console.log(`Link: ${link}`);
    console.log(`========================================\n`);
  }
}

// =====================================================
// BUYOUT BOT — RFQ email
// =====================================================
// Sends ONE individual RFQ email per vendor (never a shared BCC). Returns a
// per-recipient result so the caller can report partial failures. Honors the
// same SendGrid / console-fallback path as every other email in this service.

export interface RfqEmailInput {
  to: string;
  vendorName: string;
  projectName: string;
  scopeName: string;
  subject: string;
  /** Pre-rendered HTML body (built from parsed line items by the caller). */
  html: string;
  /** Plain-text fallback. */
  text: string;
  /** Optional reply-to (the requesting PM). */
  replyTo?: string;
}

export async function sendRfqEmail(input: RfqEmailInput): Promise<{ ok: boolean; error?: string }> {
  const { to, subject, html, text, replyTo } = input;
  if (!to || !/.+@.+\..+/.test(to)) {
    return { ok: false, error: "Missing or invalid recipient email" };
  }
  if (EMAIL_PROVIDER === "sendgrid") {
    try {
      await sgMail.send({ to, from: EMAIL_FROM, subject, text, html, ...(replyTo ? { replyTo } : {}) });
      console.log(`[Email] RFQ sent to ${to} (${input.vendorName}) for ${input.scopeName} via SendGrid`);
      return { ok: true };
    } catch (error: any) {
      const msg = error?.response?.body ? JSON.stringify(error.response.body) : error.message;
      console.error(`[Email] SendGrid error sending RFQ to ${to}:`, msg);
      return { ok: false, error: String(error.message || "SendGrid send failed") };
    }
  }
  console.log(`\n========================================`);
  console.log(`[Email-DEV] RFQ to ${input.vendorName} <${to}>`);
  console.log(`Project: ${input.projectName}  ·  Scope: ${input.scopeName}`);
  console.log(`Subject: ${subject}`);
  console.log(`----------------------------------------`);
  console.log(text);
  console.log(`========================================\n`);
  return { ok: true };
}
