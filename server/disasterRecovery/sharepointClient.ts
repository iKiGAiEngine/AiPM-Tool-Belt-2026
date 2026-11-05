/**
 * Disaster Recovery — minimal Microsoft Graph client for SharePoint / OneDrive uploads.
 *
 * Authentication: OAuth 2.0 "client credentials" with an Entra ID (Azure AD) app
 * registration owned by Swinerton IT. Recommended permission: **Sites.Selected**
 * (application) granted *write* on the single backup site only — AiPM then cannot see
 * any other Swinerton data.
 */
import fs from "fs";
import type { DrConfig } from "./config";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 32; // 10 MiB — Graph requires multiples of 320 KiB

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount: number };
  file?: unknown;
  createdDateTime?: string;
  webUrl?: string;
}

const encPath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SharePointClient {
  private token: { value: string; expires: number } | null = null;
  private driveId: string | null = null;
  private folderCache = new Map<string, string>();

  constructor(private cfg: DrConfig) {}

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expires - 120_000) return this.token.value;
    const { tenantId, clientId, clientSecret } = this.cfg;
    if (!tenantId || !clientId || !clientSecret) throw new Error("Microsoft 365 credentials (DR_MS_TENANT_ID / DR_MS_CLIENT_ID / DR_MS_CLIENT_SECRET) are not set.");
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Microsoft sign-in failed (${res.status}): ${body.error_description || body.error || "no token returned"}`);
    }
    this.token = { value: body.access_token, expires: Date.now() + (body.expires_in || 3600) * 1000 };
    return this.token.value;
  }

  /** Call Graph with automatic retry on throttling (429) and temporary server errors. */
  private async graph<T = any>(method: string, url: string, body?: unknown, allow404 = false): Promise<T | null> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url.startsWith("http") ? url : `${GRAPH}${url}`, {
        method,
        headers: { Authorization: `Bearer ${await this.getToken()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404 && allow404) return null;
      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
        await sleep((Number.isFinite(retryAfter) ? retryAfter : 2 ** attempt) * 1000);
        continue;
      }
      const errText = await res.text().catch(() => "");
      let msg = errText;
      try { msg = JSON.parse(errText)?.error?.message || errText; } catch {}
      throw new Error(`Microsoft Graph ${method} ${url.replace(GRAPH, "")} failed (${res.status}): ${msg.slice(0, 300)}`);
    }
  }

  async getDriveId(): Promise<string> {
    if (this.driveId) return this.driveId;
    if (this.cfg.driveId) return (this.driveId = this.cfg.driveId);
    if (this.cfg.siteUrl) {
      const u = new URL(this.cfg.siteUrl);
      const sitePath = u.pathname.replace(/\/+$/, "");
      const site = await this.graph<any>("GET", `/sites/${u.hostname}:${sitePath || "/"}`);
      if (this.cfg.libraryName) {
        const drives = await this.graph<any>("GET", `/sites/${site.id}/drives`);
        const match = (drives.value || []).find((d: any) => d.name?.toLowerCase() === this.cfg.libraryName!.toLowerCase());
        if (!match) throw new Error(`Document library "${this.cfg.libraryName}" was not found on ${this.cfg.siteUrl}.`);
        return (this.driveId = match.id);
      }
      const drive = await this.graph<any>("GET", `/sites/${site.id}/drive`);
      return (this.driveId = drive.id);
    }
    if (this.cfg.oneDriveUser) {
      const drive = await this.graph<any>("GET", `/users/${encodeURIComponent(this.cfg.oneDriveUser)}/drive`);
      return (this.driveId = drive.id);
    }
    throw new Error("No SharePoint/OneDrive destination configured (set DR_SHAREPOINT_SITE_URL).");
  }

  async getItem(remotePath: string): Promise<DriveItem | null> {
    const d = await this.getDriveId();
    return this.graph<DriveItem>("GET", `/drives/${d}/root:/${encPath(remotePath)}`, undefined, true);
  }

  /** Create a folder path (like mkdir -p) and return the final folder's item id. */
  async ensureFolder(remotePath: string): Promise<string> {
    const clean = remotePath.split("/").filter(Boolean).join("/");
    const cached = this.folderCache.get(clean);
    if (cached) return cached;
    const d = await this.getDriveId();
    let parentId = (await this.graph<DriveItem>("GET", `/drives/${d}/root`))!.id;
    let soFar = "";
    for (const seg of clean.split("/")) {
      soFar = soFar ? `${soFar}/${seg}` : seg;
      const hit = this.folderCache.get(soFar);
      if (hit) { parentId = hit; continue; }
      let item = await this.getItem(soFar);
      if (!item) {
        try {
          item = await this.graph<DriveItem>("POST", `/drives/${d}/items/${parentId}/children`, { name: seg, folder: {}, "@microsoft.graph.conflictBehavior": "fail" });
        } catch {
          item = await this.getItem(soFar); // created concurrently
        }
      }
      if (!item) throw new Error(`Could not create folder ${soFar}`);
      this.folderCache.set(soFar, item.id);
      parentId = item.id;
    }
    return parentId;
  }

  async uploadText(remotePath: string, text: string): Promise<DriveItem> {
    const d = await this.getDriveId();
    const parent = remotePath.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    const res = await fetch(`${GRAPH}/drives/${d}/root:/${encPath(remotePath)}:/content`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await this.getToken()}`, "Content-Type": "text/plain; charset=utf-8" },
      body: text,
    });
    if (!res.ok) throw new Error(`Upload of ${remotePath} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as DriveItem;
  }

  /** Upload a local file of any size, then confirm the stored size matches exactly. */
  async uploadFile(localPath: string, remotePath: string): Promise<DriveItem> {
    const d = await this.getDriveId();
    const size = fs.statSync(localPath).size;
    const parent = remotePath.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);

    let item: DriveItem;
    if (size <= SIMPLE_UPLOAD_LIMIT) {
      item = await this.withRetry(async () => {
        const res = await fetch(`${GRAPH}/drives/${d}/root:/${encPath(remotePath)}:/content`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${await this.getToken()}`, "Content-Type": "application/octet-stream" },
          body: fs.readFileSync(localPath),
        });
        if (!res.ok) throw Object.assign(new Error(`Upload of ${remotePath} failed (${res.status}): ${(await res.text()).slice(0, 300)}`), { status: res.status });
        return (await res.json()) as DriveItem;
      });
    } else {
      const session = await this.graph<any>("POST", `/drives/${d}/root:/${encPath(remotePath)}:/createUploadSession`, {
        item: { "@microsoft.graph.conflictBehavior": "replace" },
      });
      const fd = fs.openSync(localPath, "r");
      try {
        let offset = 0;
        let last: any = null;
        const buf = Buffer.alloc(CHUNK);
        while (offset < size) {
          const len = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
          const chunk = buf.subarray(0, len);
          const start = offset;
          last = await this.withRetry(async () => {
            const res = await fetch(session.uploadUrl, {
              method: "PUT",
              headers: { "Content-Length": String(len), "Content-Range": `bytes ${start}-${start + len - 1}/${size}` },
              body: chunk,
            });
            if (!res.ok && res.status !== 202) throw Object.assign(new Error(`Chunk upload of ${remotePath} failed (${res.status}): ${(await res.text()).slice(0, 300)}`), { status: res.status });
            return res.json();
          });
          offset += len;
        }
        item = last as DriveItem;
      } finally {
        fs.closeSync(fd);
      }
    }
    if (item.size !== undefined && item.size !== size) {
      throw new Error(`Upload verification failed for ${remotePath}: local ${size} bytes, SharePoint has ${item.size} bytes.`);
    }
    return item;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const retryable = !err.status || err.status === 429 || err.status >= 500;
        if (!retryable || attempt >= 5) throw err;
        await sleep(2 ** attempt * 1000);
      }
    }
  }

  async listChildren(remotePath: string): Promise<DriveItem[]> {
    const d = await this.getDriveId();
    const first = await this.graph<any>("GET", `/drives/${d}/root:/${encPath(remotePath)}:/children?$top=200&$select=id,name,size,folder,file,createdDateTime,webUrl`, undefined, true);
    if (!first) return [];
    const out: DriveItem[] = [...(first.value || [])];
    let next = first["@odata.nextLink"];
    while (next) {
      const page = await this.graph<any>("GET", next);
      out.push(...(page.value || []));
      next = page["@odata.nextLink"];
    }
    return out;
  }

  /** Move (and optionally rename) an item into another folder. */
  async moveItem(itemId: string, newParentFolderPath: string, newName: string): Promise<DriveItem> {
    const d = await this.getDriveId();
    const parentId = await this.ensureFolder(newParentFolderPath);
    return (await this.graph<DriveItem>("PATCH", `/drives/${d}/items/${itemId}`, { parentReference: { id: parentId }, name: newName }))!;
  }

  /** Delete an item. SharePoint keeps deleted items in its recycle bin (93 days by default). */
  async deleteItem(itemId: string): Promise<void> {
    const d = await this.getDriveId();
    await this.graph("DELETE", `/drives/${d}/items/${itemId}`, undefined, true);
  }

  /** Quick end-to-end check used by the admin "Test connection" button. */
  async testConnection(rootFolder: string): Promise<{ driveId: string; webUrl?: string }> {
    const driveId = await this.getDriveId();
    await this.ensureFolder(rootFolder);
    const item = await this.uploadText(`${rootFolder}/_connection-test.txt`, `AiPM connection test ${new Date().toISOString()}\n`);
    await this.deleteItem(item.id);
    const folder = await this.getItem(rootFolder);
    return { driveId, webUrl: folder?.webUrl };
  }
}
