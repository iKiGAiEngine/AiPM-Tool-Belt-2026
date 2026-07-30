// Submittal Builder API client.
//
// Replaces the old localStorage layer. That layer silently swallowed write
// failures — a full quota returned false, nothing checked it, and the UI kept
// showing "✓ Saved" while the PM's work was discarded. Every call here surfaces
// its error to the caller so the workspace can show a real save state.

import { apiRequest } from "@/lib/queryClient";
import type { SubmittalProject, SubmittalPackage, Scope, Attachment } from "@shared/submittal/types";

const BASE = "/api/submittal/projects";

export interface CreateProjectInput {
  proposalLogId?: string | number | null;
  projectName: string;
  gc?: string;
  attention?: string;
  assignedPm?: string;
  coverDate?: string;
  estimateNumber?: string | null;
  region?: string | null;
}

export interface UploadedAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string | null;
  pageCount: number;
  byteSize: number;
}

/** Pull the readable part out of the `"<status>: <body>"` errors apiRequest throws. */
export function readableError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const match = /^\d{3}:\s*([\s\S]*)$/.exec(raw);
  const body = match ? match[1] : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.error) return String(parsed.error);
    if (parsed?.message) return String(parsed.message);
  } catch {
    /* not JSON — fall through */
  }
  return body.trim() || fallback;
}

export async function listProjects(): Promise<SubmittalProject[]> {
  const res = await apiRequest("GET", BASE);
  return res.json();
}

export async function loadProject(id: string): Promise<SubmittalProject> {
  const res = await apiRequest("GET", `${BASE}/${id}`);
  return res.json();
}

export async function createProject(input: CreateProjectInput): Promise<SubmittalProject> {
  const res = await apiRequest("POST", BASE, {
    ...input,
    package: { version: 1, scopes: [] },
  });
  return res.json();
}

export interface SaveProjectInput {
  projectName?: string;
  gc?: string;
  attention?: string;
  assignedPm?: string;
  coverDate?: string;
  sourceFilename?: string | null;
  package?: SubmittalPackage;
}

export async function saveProject(id: string, input: SaveProjectInput): Promise<SubmittalProject> {
  const res = await apiRequest("PATCH", `${BASE}/${id}`, input);
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  await apiRequest("DELETE", `${BASE}/${id}`);
}

/** Upload one product data PDF. Returns the REAL page count read server-side. */
export async function uploadAttachment(
  projectId: string,
  attachmentId: string,
  file: File
): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append("file", file);
  form.append("attachmentId", attachmentId);
  const res = await fetch(`${BASE}/${projectId}/attachments`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export async function deleteAttachment(projectId: string, attachmentId: string): Promise<void> {
  await apiRequest("DELETE", `${BASE}/${projectId}/attachments/${attachmentId}`);
}

export function attachmentUrl(projectId: string, attachmentId: string): string {
  return `${BASE}/${projectId}/attachments/${attachmentId}`;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  problems: Array<{ fileName: string; reason: string }>;
}

/** Generate the package PDF. Omit scopeId to get every scope as a zip. */
export async function exportPackage(projectId: string, scopeId?: string): Promise<ExportResult> {
  const res = await fetch(`${BASE}/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scopeId: scopeId ?? null }),
    credentials: "include",
  });
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }

  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  let problems: ExportResult["problems"] = [];
  try {
    const header = res.headers.get("X-Submittal-Problems");
    if (header) problems = JSON.parse(decodeURIComponent(header));
  } catch {
    /* reporting only — never block the download */
  }

  return {
    blob: await res.blob(),
    fileName: match ? match[1] : "Submittal.pdf",
    problems,
  };
}

/** Hand a generated file to the browser as a download. */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoke on the next tick so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build the package document the server persists. */
export function toPackage(scopes: Scope[], ui: { lastActiveScopeId: string | null; lastActiveTab: string; sourceFilename?: string | null }): SubmittalPackage {
  return {
    version: 1,
    scopes,
    lastActiveScopeId: ui.lastActiveScopeId,
    lastActiveTab: ui.lastActiveTab,
    sourceFilename: ui.sourceFilename ?? null,
  };
}

export type { Attachment };
