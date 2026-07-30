// =====================================================
// SUBMITTAL BUILDER — PDF package generation
// =====================================================
//
// Builds the real deliverable: one PDF per scope, laid out as
//   page 1        cover transmittal
//   pages 2..n    the schedule
//   pages n+1..   every attached product data PDF, in schedule order, with the
//                 line's callout stamped on its first page
//
// The cover's page references come from shared/submittal/pagination, and the
// page numbers stamped in the footer come from the document we actually built —
// so what the cover claims and what the GC receives are the same thing.

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import type { Scope, SubmittalProject } from "@shared/submittal/types";
import { computePagination, LINES_PER_SCHEDULE_PAGE } from "@shared/submittal/pagination";

const PAGE_W = 612; // US Letter portrait, 72 dpi
const PAGE_H = 792;
const MARGIN = 54;

const GOLD = rgb(0.749, 0.608, 0.188);
const NAVY = rgb(0.102, 0.18, 0.267);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.45, 0.45, 0.45);
const RULE = rgb(0.72, 0.72, 0.72);
const HEAD_BG = rgb(0.93, 0.93, 0.93);

const COMPANY = {
  name: "National Building Specialties",
  lines: ["4130 Flat Rock Drive, #110", "Riverside, CA 92505"],
};

export interface AttachmentBytes {
  attachmentId: string;
  fileName: string;
  data: Buffer;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Cut text to fit `maxWidth`, adding an ellipsis when it does not. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const value = String(text ?? "");
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(value.slice(0, mid) + "…", size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo) + "…";
}

/** Wrap text to `maxWidth`, capped at `maxLines` (last line ellipsized). */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === 0) return [""];
  if (lines.length === maxLines) lines[maxLines - 1] = fit(lines[maxLines - 1], font, size, maxWidth);
  return lines;
}

function drawBrandHeader(page: PDFPage, fonts: Fonts, y: number): number {
  page.drawRectangle({ x: MARGIN, y: y - 16, width: 4, height: 18, color: GOLD });
  page.drawText("NBS", { x: MARGIN + 10, y: y - 12, size: 14, font: fonts.bold, color: NAVY });
  page.drawLine({
    start: { x: MARGIN, y: y - 26 },
    end: { x: PAGE_W - MARGIN, y: y - 26 },
    thickness: 1.5,
    color: GOLD,
  });
  return y - 44;
}

// ---------------------------------------------------------------------------
// Cover transmittal
// ---------------------------------------------------------------------------

function drawCover(doc: PDFDocument, fonts: Fonts, project: SubmittalProject, scope: Scope, totalPages: number) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = drawBrandHeader(page, fonts, PAGE_H - MARGIN);

  page.drawText("Submittal Transmittal", { x: MARGIN, y, size: 17, font: fonts.bold, color: INK });
  y -= 28;

  const label = (text: string, value: string, yy: number) => {
    page.drawText(text, { x: MARGIN, y: yy, size: 9, font: fonts.bold, color: MUTED });
    page.drawText(fit(value || "—", fonts.regular, 10, PAGE_W - MARGIN * 2 - 120), {
      x: MARGIN + 110, y: yy, size: 10, font: fonts.regular, color: INK,
    });
  };

  label("DATE:", project.coverDate, y); y -= 18;
  label("PROJECT:", project.projectName, y); y -= 18;
  label("SPEC SECTION:", [scope.csi, scope.specTitle].filter(Boolean).join(" — "), y); y -= 26;

  page.drawText("SUBMITTED BY:", { x: MARGIN, y, size: 9, font: fonts.bold, color: MUTED });
  page.drawText(COMPANY.name, { x: MARGIN + 110, y, size: 10, font: fonts.regular, color: INK });
  y -= 14;
  for (const addressLine of COMPANY.lines) {
    page.drawText(addressLine, { x: MARGIN + 110, y, size: 10, font: fonts.regular, color: INK });
    y -= 14;
  }
  y -= 8;

  label("SUBMITTED TO:", project.gc, y); y -= 18;
  label("ATTENTION:", project.attention, y); y -= 32;

  // ---- Contents table ----
  const cols = [
    { title: "SPEC SECTION", width: 90 },
    { title: "DESCRIPTION", width: 200 },
    { title: "TYPE", width: 100 },
    { title: "COMMENTS", width: PAGE_W - MARGIN * 2 - 390 },
  ];
  const rowH = 20;
  let x = MARGIN;

  page.drawRectangle({ x: MARGIN, y: y - rowH + 4, width: PAGE_W - MARGIN * 2, height: rowH, color: HEAD_BG });
  for (const col of cols) {
    page.drawText(col.title, { x: x + 5, y: y - rowH + 11, size: 8, font: fonts.bold, color: INK });
    x += col.width;
  }
  y -= rowH;

  const coverRows = scope.coverLines ?? [];
  const printedRows = Math.max(coverRows.length, 5);
  for (let i = 0; i < printedRows; i++) {
    const row = coverRows[i];
    const values = row
      ? [scope.csi, scope.specTitle || scope.tabName, String(row.type ?? ""), String(row.comment ?? "")]
      : ["", "", "", ""];
    x = MARGIN;
    for (let c = 0; c < cols.length; c++) {
      page.drawRectangle({
        x, y: y - rowH + 4, width: cols[c].width, height: rowH,
        borderColor: RULE, borderWidth: 0.5,
      });
      if (values[c]) {
        page.drawText(fit(values[c], fonts.regular, 8.5, cols[c].width - 10), {
          x: x + 5, y: y - rowH + 11, size: 8.5, font: fonts.regular, color: INK,
        });
      }
      x += cols[c].width;
    }
    y -= rowH;
  }

  y -= 24;
  page.drawText(`This package contains ${totalPages} page${totalPages === 1 ? "" : "s"}.`, {
    x: MARGIN, y, size: 9, font: fonts.regular, color: MUTED,
  });
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function drawSchedule(doc: PDFDocument, fonts: Fonts, project: SubmittalProject, scope: Scope) {
  const lines = scope.lines ?? [];
  const pageCount = Math.max(1, Math.ceil(lines.length / LINES_PER_SCHEDULE_PAGE));

  const cols = [
    { title: "SPEC No.", width: 58, key: "spec" },
    { title: "SPEC TITLE", width: 96, key: "title" },
    { title: "CALLOUT", width: 58, key: "callout" },
    { title: "DESCRIPTION", width: 168, key: "desc" },
    { title: "MODEL", width: 90, key: "model" },
    { title: "QTY", width: PAGE_W - MARGIN * 2 - 470, key: "qty" },
  ];

  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    let y = drawBrandHeader(page, fonts, PAGE_H - MARGIN);

    page.drawText(fit(project.projectName, fonts.bold, 13, PAGE_W - MARGIN * 2), {
      x: MARGIN, y, size: 13, font: fonts.bold, color: INK,
    });
    y -= 16;
    const heading = `${scope.specTitle || scope.tabName} Schedule${pageCount > 1 ? ` (${p + 1} of ${pageCount})` : ""}`;
    page.drawText(heading, { x: MARGIN, y, size: 10.5, font: fonts.bold, color: MUTED });
    y -= 22;

    const headerH = 18;
    let x = MARGIN;
    page.drawRectangle({ x: MARGIN, y: y - headerH + 4, width: PAGE_W - MARGIN * 2, height: headerH, color: HEAD_BG });
    for (const col of cols) {
      page.drawText(col.title, { x: x + 4, y: y - headerH + 10, size: 7.5, font: fonts.bold, color: INK });
      x += col.width;
    }
    y -= headerH;

    const slice = lines.slice(p * LINES_PER_SCHEDULE_PAGE, (p + 1) * LINES_PER_SCHEDULE_PAGE);
    for (const line of slice) {
      const descCol = cols.find((c) => c.key === "desc")!;
      const descLines = wrap(line.desc, fonts.regular, 8, descCol.width - 8, 2);
      const rowH = Math.max(18, 10 + descLines.length * 9);

      const values: Record<string, string[]> = {
        spec: [fit(scope.csi, fonts.regular, 8, cols[0].width - 8)],
        title: [fit(scope.specTitle || scope.tabName, fonts.regular, 8, cols[1].width - 8)],
        callout: [fit(line.callout, fonts.bold, 8, cols[2].width - 8)],
        desc: descLines,
        model: [fit(line.model, fonts.regular, 8, cols[4].width - 8)],
        qty: [String(line.qty ?? "")],
      };

      x = MARGIN;
      for (const col of cols) {
        page.drawRectangle({
          x, y: y - rowH + 4, width: col.width, height: rowH,
          borderColor: RULE, borderWidth: 0.5,
        });
        const cellLines = values[col.key] ?? [""];
        let ty = y - 8;
        for (const text of cellLines) {
          if (text) {
            page.drawText(text, {
              x: x + 4, y: ty, size: 8,
              font: col.key === "callout" ? fonts.bold : fonts.regular,
              color: INK,
            });
          }
          ty -= 9;
        }
        x += col.width;
      }
      y -= rowH;
    }
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Stamp the callout in the top-right corner so the GC can tie sheet to line. */
function stampCallout(page: PDFPage, fonts: Fonts, callout: string) {
  if (!callout) return;
  const { width, height } = page.getSize();
  const rotation = page.getRotation().angle % 360;
  // On a rotated page the media box is sideways; skip rather than stamp
  // somewhere meaningless.
  if (rotation !== 0) return;

  const size = 11;
  const textWidth = fonts.bold.widthOfTextAtSize(callout, size);
  const boxW = textWidth + 16;
  const boxH = 20;
  const x = width - boxW - 18;
  const y = height - boxH - 18;
  if (x < 0 || y < 0) return;

  page.drawRectangle({ x, y, width: boxW, height: boxH, color: GOLD });
  page.drawText(callout, { x: x + 8, y: y + 6, size, font: fonts.bold, color: rgb(0, 0, 0) });
}

/** A placeholder page for an attachment whose bytes are missing or unreadable. */
function drawMissingAttachment(doc: PDFDocument, fonts: Fonts, fileName: string, callout: string, reason: string) {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const y = drawBrandHeader(page, fonts, PAGE_H - MARGIN);
  page.drawText("Product data not available", { x: MARGIN, y, size: 14, font: fonts.bold, color: INK });
  page.drawText(fit(fileName, fonts.regular, 11, PAGE_W - MARGIN * 2), {
    x: MARGIN, y: y - 24, size: 11, font: fonts.regular, color: INK,
  });
  page.drawText(reason, { x: MARGIN, y: y - 42, size: 9, font: fonts.regular, color: MUTED });
  stampCallout(page, fonts, callout);
}

// ---------------------------------------------------------------------------
// Footers
// ---------------------------------------------------------------------------

function drawFooters(doc: PDFDocument, fonts: Fonts, project: SubmittalProject, scope: Scope) {
  const pages = doc.getPages();
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const page = pages[i];
    if (page.getRotation().angle % 360 !== 0) continue;
    const { width } = page.getSize();
    const left = fit(`${project.projectName} — ${scope.specTitle || scope.tabName}`, fonts.regular, 7.5, width - 160);
    page.drawText(left, { x: 24, y: 20, size: 7.5, font: fonts.regular, color: MUTED });
    const right = `Page ${i + 1} of ${total}`;
    page.drawText(right, {
      x: width - 24 - fonts.regular.widthOfTextAtSize(right, 7.5),
      y: 20, size: 7.5, font: fonts.regular, color: MUTED,
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BuildResult {
  bytes: Buffer;
  pageCount: number;
  /** Attachments that could not be merged, for reporting back to the PM. */
  problems: Array<{ fileName: string; reason: string }>;
}

/** Build the submittal package PDF for one scope. */
export async function buildScopePackage(
  project: SubmittalProject,
  scope: Scope,
  attachments: AttachmentBytes[]
): Promise<BuildResult> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  doc.setTitle(`${project.projectName} — ${scope.specTitle || scope.tabName} Submittal`);
  doc.setProducer("AiPM Submittal Builder");
  doc.setCreator(COMPANY.name);

  const pageInfo = computePagination(scope);
  const problems: BuildResult["problems"] = [];
  const byId = new Map(attachments.map((a) => [a.attachmentId, a]));

  drawCover(doc, fonts, project, scope, pageInfo.total);
  drawSchedule(doc, fonts, project, scope);

  // Attachments follow the schedule in line order — the same order the cover's
  // page references were computed from.
  for (const line of scope.lines ?? []) {
    for (const att of line.attachments ?? []) {
      const source = byId.get(att.id);
      const callout = att.calloutStamp || line.callout || "";
      if (!source) {
        problems.push({ fileName: att.fileName, reason: "file was never uploaded" });
        drawMissingAttachment(doc, fonts, att.fileName, callout, "This attachment's file is missing from the package.");
        continue;
      }
      try {
        const src = await PDFDocument.load(source.data, { ignoreEncryption: true });
        const copied = await doc.copyPages(src, src.getPageIndices());
        copied.forEach((page, idx) => {
          doc.addPage(page);
          if (idx === 0) stampCallout(page, fonts, callout);
        });
      } catch (err: any) {
        problems.push({ fileName: att.fileName, reason: err?.message || "unreadable PDF" });
        drawMissingAttachment(doc, fonts, att.fileName, callout, "This PDF could not be read and was not merged.");
      }
    }
  }

  drawFooters(doc, fonts, project, scope);

  const bytes = Buffer.from(await doc.save());
  return { bytes, pageCount: doc.getPageCount(), problems };
}

/** Read a PDF's real page count. Returns 1 when the file cannot be parsed. */
export async function readPageCount(data: Buffer): Promise<number> {
  try {
    const doc = await PDFDocument.load(data, { ignoreEncryption: true });
    return Math.max(1, doc.getPageCount());
  } catch {
    return 1;
  }
}

/** Safe, readable file name for the downloaded package. */
export function packageFileName(project: SubmittalProject, scope: Scope): string {
  const clean = (s: string) => String(s || "").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "_");
  const parts = [clean(project.projectName), clean(scope.specTitle || scope.tabName), "Submittal"].filter(Boolean);
  return `${parts.join("_")}.pdf`;
}
