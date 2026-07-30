// =====================================================
// SUBMITTAL BUILDER — page numbering
// =====================================================
//
// One package per scope: cover transmittal (page 1), the schedule, then every
// attached product-data PDF in schedule order. The page references printed on
// the cover come from here, so `pageCount` MUST be the real page count read
// from the uploaded PDF — it used to be a hardcoded 2, which made every page
// reference on every transmittal wrong.

import type { Scope, Attachment } from "./types";

/** Schedule rows that fit on one printed page. */
export const LINES_PER_SCHEDULE_PAGE = 15;

export interface AttachmentPage {
  id: string;
  fileName: string;
  callout: string;
  model: string;
  calloutStamp: string;
  pageCount: number;
  startPage: number;
  endPage: number;
}

export interface PageInfo {
  cover: number;
  scheduleStart: number;
  scheduleEnd: number;
  schedulePages: number;
  attachments: AttachmentPage[];
  total: number;
}

export function computePagination(scope: Scope | null | undefined): PageInfo {
  const lines = scope?.lines ?? [];
  const schedulePages = Math.max(1, Math.ceil(lines.length / LINES_PER_SCHEDULE_PAGE));
  const scheduleEnd = 1 + schedulePages;

  let page = scheduleEnd + 1;
  const attachments: AttachmentPage[] = [];

  for (const line of lines) {
    for (const att of (line.attachments ?? []) as Attachment[]) {
      const pageCount = Math.max(1, att.pageCount || 1);
      attachments.push({
        id: att.id,
        fileName: att.fileName,
        callout: line.callout,
        model: line.model,
        calloutStamp: att.calloutStamp,
        pageCount,
        startPage: page,
        endPage: page + pageCount - 1,
      });
      page += pageCount;
    }
  }

  return {
    cover: 1,
    scheduleStart: 2,
    scheduleEnd,
    schedulePages,
    attachments,
    total: attachments.length > 0 ? page - 1 : scheduleEnd,
  };
}

/** Total printed pages across every scope's package. */
export function totalPackagePages(scopes: Scope[] | null | undefined): number {
  return (scopes ?? []).reduce((sum, s) => sum + computePagination(s).total, 0);
}
