// Builds the RFQ email body from a scope's parsed line items.
// Server-side so the same markup is used for every vendor on a scope.

import type { BuyoutScope } from "@shared/buyout/types";

function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

export interface RfqContext {
  vendorName: string;
  vendorContactName?: string;
  projectName: string;
  senderName?: string;
  senderEmail?: string;
  /** Optional explicit RFQ due date the PM wants quotes back by. */
  quotesDueBy?: string;
  /** Optional required-on-site date for the scope. */
  rosDate?: string | null;
}

export function buildRfqSubject(ctx: RfqContext, scope: BuyoutScope): string {
  return `RFQ — ${scope.name} — ${ctx.projectName}`;
}

export function buildRfqEmail(ctx: RfqContext, scope: BuyoutScope): { subject: string; html: string; text: string } {
  const subject = buildRfqSubject(ctx, scope);
  const greetName = ctx.vendorContactName || ctx.vendorName;

  // Only include real line items (skip allowance lines flagged for internal use? No —
  // include them but mark them so the vendor knows they're allowances).
  const rows = scope.items
    .map(
      (it) => `
      <tr>
        <td style="padding:6px 10px;border:1px solid #ddd;">${esc(it.callout || "")}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${esc(it.description)}${it.isAllowance ? ' <span style="color:#A8892E;font-weight:600;">(ALLOWANCE)</span>' : ""}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;">${esc(it.model || "")}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${it.qty || ""}</td>
      </tr>`
    )
    .join("");

  const dueLine = ctx.quotesDueBy ? `<p>Please return your quote by <strong>${esc(ctx.quotesDueBy)}</strong>.</p>` : "";
  const rosLine = ctx.rosDate ? `<p>Required on site: <strong>${esc(ctx.rosDate)}</strong>.</p>` : "";

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1A1A1E;">
    <div style="border-bottom:3px solid #A8892E;padding-bottom:10px;margin-bottom:16px;">
      <h2 style="margin:0;color:#A8892E;">Request for Quote</h2>
      <p style="margin:4px 0 0;color:#555;">${esc(ctx.projectName)} &middot; ${esc(scope.name)}</p>
    </div>
    <p>Hello ${esc(greetName)},</p>
    <p>We are requesting a quote for the <strong>${esc(scope.name)}</strong> scope on
       <strong>${esc(ctx.projectName)}</strong>. The line items are below.</p>
    ${dueLine}
    ${rosLine}
    <table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:13px;">
      <thead>
        <tr style="background:#A8892E;color:#fff;">
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Callout</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Description</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:left;">Model</th>
          <th style="padding:6px 10px;border:1px solid #ddd;text-align:right;">Qty</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p>Please include unit pricing, freight, lead time, and any exclusions. Quotes may cover
       all or part of the scope — line-level pricing is welcome.</p>
    <p>Thank you,<br>${esc(ctx.senderName || "NBS Procurement")}</p>
  </div>`;

  const textRows = scope.items
    .map((it) => `  - [${it.callout || ""}] ${it.description}${it.isAllowance ? " (ALLOWANCE)" : ""} | ${it.model || ""} | qty ${it.qty || ""}`)
    .join("\n");
  const text = [
    `Request for Quote`,
    `${ctx.projectName} - ${scope.name}`,
    ``,
    `Hello ${greetName},`,
    ``,
    `We are requesting a quote for the ${scope.name} scope on ${ctx.projectName}.`,
    ctx.quotesDueBy ? `Please return your quote by ${ctx.quotesDueBy}.` : "",
    ctx.rosDate ? `Required on site: ${ctx.rosDate}.` : "",
    ``,
    `Line items:`,
    textRows,
    ``,
    `Please include unit pricing, freight, lead time, and any exclusions.`,
    ``,
    `Thank you,`,
    ctx.senderName || "NBS Procurement",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}
