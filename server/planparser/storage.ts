import { randomUUID } from "crypto";
import type { PlanParserJob, InsertPlanParserJob, ParsedPage, InsertParsedPage } from "@shared/schema";
import { planParserJobs, parsedPages } from "@shared/schema";
import { db } from "../db";
import { eq, desc, lt } from "drizzle-orm";
import fs from "fs";
import path from "path";

const JOBS_DIR = path.join(process.cwd(), "data", "planparser_jobs");

export interface IPlanParserStorage {
  createJob(data: InsertPlanParserJob): Promise<PlanParserJob>;
  getJob(id: string): Promise<PlanParserJob | undefined>;
  updateJob(id: string, data: Partial<PlanParserJob>): Promise<PlanParserJob | undefined>;
  deleteJob(id: string): Promise<boolean>;
  getAllJobs(): Promise<PlanParserJob[]>;
  
  createPage(data: InsertParsedPage): Promise<ParsedPage>;
  getPage(id: string): Promise<ParsedPage | undefined>;
  getPagesByJob(jobId: string): Promise<ParsedPage[]>;
  updatePage(id: string, data: Partial<ParsedPage>): Promise<ParsedPage | undefined>;
  deletePagesByJob(jobId: string): Promise<boolean>;
  
  getJobDirectory(jobId: string): string;
  ensureJobDirectory(jobId: string): Promise<string>;
  cleanupExpiredJobs(): Promise<void>;
}

function dbRowToJob(row: any): PlanParserJob {
  return {
    id: row.id,
    status: row.status,
    totalPages: row.totalPages ?? 0,
    processedPages: row.processedPages ?? 0,
    flaggedPages: row.flaggedPages ?? 0,
    filenames: (row.filenames as string[]) || [],
    message: row.message ?? "",
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    scopeCounts: (row.scopeCounts as Record<string, number>) || {},
  };
}

function dbRowToPage(row: any): ParsedPage {
  return {
    id: row.id,
    jobId: row.jobId,
    originalFilename: row.originalFilename,
    pageNumber: row.pageNumber,
    isRelevant: row.isRelevant ?? false,
    tags: (row.tags as string[]) || [],
    confidence: row.confidence ?? 0,
    whyFlagged: row.whyFlagged ?? "",
    signageOverrideApplied: row.signageOverrideApplied ?? false,
    ocrSnippet: row.ocrSnippet ?? "",
    ocrText: row.ocrText ?? "",
    thumbnailPath: row.thumbnailPath ?? undefined,
    userModified: row.userModified ?? false,
    matchBoxes: (row.matchBoxes as ParsedPage["matchBoxes"]) || [],
    matchType: row.matchType ?? "none",
  };
}

export class PlanParserDbStorage implements IPlanParserStorage {
  async createJob(data: InsertPlanParserJob): Promise<PlanParserJob> {
    const id = randomUUID();
    const result = await db.insert(planParserJobs).values({
      id,
      status: data.status,
      totalPages: data.totalPages ?? 0,
      processedPages: data.processedPages ?? 0,
      flaggedPages: data.flaggedPages ?? 0,
      filenames: data.filenames || [],
      message: data.message ?? "",
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
      scopeCounts: data.scopeCounts || {},
    }).returning();
    await this.ensureJobDirectory(id);
    return dbRowToJob(result[0]);
  }
  
  async getJob(id: string): Promise<PlanParserJob | undefined> {
    const result = await db.select().from(planParserJobs).where(eq(planParserJobs.id, id)).limit(1);
    return result[0] ? dbRowToJob(result[0]) : undefined;
  }
  
  async updateJob(id: string, data: Partial<PlanParserJob>): Promise<PlanParserJob | undefined> {
    const updateData: Record<string, unknown> = {};
    if (data.status !== undefined) updateData.status = data.status;
    if (data.totalPages !== undefined) updateData.totalPages = data.totalPages;
    if (data.processedPages !== undefined) updateData.processedPages = data.processedPages;
    if (data.flaggedPages !== undefined) updateData.flaggedPages = data.flaggedPages;
    if (data.filenames !== undefined) updateData.filenames = data.filenames;
    if (data.message !== undefined) updateData.message = data.message;
    if (data.scopeCounts !== undefined) updateData.scopeCounts = data.scopeCounts;

    if (Object.keys(updateData).length === 0) {
      return this.getJob(id);
    }

    const result = await db.update(planParserJobs).set(updateData).where(eq(planParserJobs.id, id)).returning();
    return result[0] ? dbRowToJob(result[0]) : undefined;
  }
  
  async deleteJob(id: string): Promise<boolean> {
    await this.deletePagesByJob(id);
    
    const jobDir = this.getJobDirectory(id);
    try {
      if (fs.existsSync(jobDir)) {
        fs.rmSync(jobDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to delete job directory: ${jobDir}`, e);
    }
    
    const result = await db.delete(planParserJobs).where(eq(planParserJobs.id, id)).returning();
    return result.length > 0;
  }
  
  async getAllJobs(): Promise<PlanParserJob[]> {
    const result = await db.select().from(planParserJobs).orderBy(desc(planParserJobs.createdAt));
    return result.map(dbRowToJob);
  }
  
  async createPage(data: InsertParsedPage): Promise<ParsedPage> {
    const id = randomUUID();
    const result = await db.insert(parsedPages).values({
      id,
      jobId: data.jobId,
      originalFilename: data.originalFilename,
      pageNumber: data.pageNumber,
      isRelevant: data.isRelevant ?? false,
      tags: data.tags || [],
      confidence: data.confidence ?? 0,
      whyFlagged: data.whyFlagged ?? "",
      signageOverrideApplied: data.signageOverrideApplied ?? false,
      ocrSnippet: data.ocrSnippet ?? "",
      ocrText: data.ocrText ?? "",
      thumbnailPath: data.thumbnailPath ?? null,
      userModified: data.userModified ?? false,
      matchBoxes: data.matchBoxes || [],
      matchType: data.matchType ?? "none",
    }).returning();
    return dbRowToPage(result[0]);
  }
  
  async getPage(id: string): Promise<ParsedPage | undefined> {
    const result = await db.select().from(parsedPages).where(eq(parsedPages.id, id)).limit(1);
    return result[0] ? dbRowToPage(result[0]) : undefined;
  }
  
  async getPagesByJob(jobId: string): Promise<ParsedPage[]> {
    const result = await db.select().from(parsedPages)
      .where(eq(parsedPages.jobId, jobId))
      .orderBy(parsedPages.originalFilename, parsedPages.pageNumber);
    return result.map(dbRowToPage);
  }
  
  async updatePage(id: string, data: Partial<ParsedPage>): Promise<ParsedPage | undefined> {
    const updateData: Record<string, unknown> = {};
    if (data.isRelevant !== undefined) updateData.isRelevant = data.isRelevant;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.confidence !== undefined) updateData.confidence = data.confidence;
    if (data.whyFlagged !== undefined) updateData.whyFlagged = data.whyFlagged;
    if (data.signageOverrideApplied !== undefined) updateData.signageOverrideApplied = data.signageOverrideApplied;
    if (data.ocrSnippet !== undefined) updateData.ocrSnippet = data.ocrSnippet;
    if (data.ocrText !== undefined) updateData.ocrText = data.ocrText;
    if (data.thumbnailPath !== undefined) updateData.thumbnailPath = data.thumbnailPath;
    if (data.userModified !== undefined) updateData.userModified = data.userModified;
    if (data.matchBoxes !== undefined) updateData.matchBoxes = data.matchBoxes;
    if (data.matchType !== undefined) updateData.matchType = data.matchType;

    if (Object.keys(updateData).length === 0) {
      return this.getPage(id);
    }

    const result = await db.update(parsedPages).set(updateData).where(eq(parsedPages.id, id)).returning();
    return result[0] ? dbRowToPage(result[0]) : undefined;
  }
  
  async deletePagesByJob(jobId: string): Promise<boolean> {
    await db.delete(parsedPages).where(eq(parsedPages.jobId, jobId));
    return true;
  }
  
  getJobDirectory(jobId: string): string {
    return path.join(JOBS_DIR, jobId);
  }
  
  async ensureJobDirectory(jobId: string): Promise<string> {
    const dir = this.getJobDirectory(jobId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  
  async cleanupExpiredJobs(): Promise<void> {
    const now = new Date().toISOString();
    const expiredJobs = await db.select({ id: planParserJobs.id })
      .from(planParserJobs)
      .where(lt(planParserJobs.expiresAt, now));
    
    for (const job of expiredJobs) {
      await this.deleteJob(job.id);
      console.log(`Cleaned up expired job: ${job.id}`);
    }
  }
}

export const planParserStorage = new PlanParserDbStorage();

setInterval(() => {
  planParserStorage.cleanupExpiredJobs().catch(console.error);
}, 5 * 60 * 1000);
