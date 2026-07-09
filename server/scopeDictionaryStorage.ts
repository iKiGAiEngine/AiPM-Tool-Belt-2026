import { db } from "./db";
import { scopeDictionaries, regions, projects, projectIdSequence, projectScopes, planIndex } from "@shared/schema";
import type {
  ScopeDictionary, InsertScopeDictionaryInput,
  Region, InsertRegionInput,
  Project, InsertProjectInput,
  ProjectScope, InsertProjectScopeInput,
  PlanIndexEntry, InsertPlanIndexInput,
} from "@shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { DEFAULT_CLASSIFICATION_CONFIG } from "./planparser/classificationConfig";

export async function getAllScopeDictionaries(): Promise<ScopeDictionary[]> {
  return await db
    .select()
    .from(scopeDictionaries)
    .orderBy(scopeDictionaries.scopeName);
}

export async function getActiveScopeDictionaries(): Promise<ScopeDictionary[]> {
  return await db
    .select()
    .from(scopeDictionaries)
    .where(eq(scopeDictionaries.isActive, true))
    .orderBy(scopeDictionaries.scopeName);
}

export async function getScopeDictionaryById(id: number): Promise<ScopeDictionary | null> {
  const result = await db
    .select()
    .from(scopeDictionaries)
    .where(eq(scopeDictionaries.id, id))
    .limit(1);
  return result[0] || null;
}

export async function createScopeDictionary(data: InsertScopeDictionaryInput): Promise<ScopeDictionary> {
  const values = {
    scopeName: data.scopeName,
    includeKeywords: data.includeKeywords ?? [],
    boostPhrases: data.boostPhrases ?? [],
    excludeKeywords: data.excludeKeywords ?? [],
    weight: data.weight ?? 100,
    specSectionNumbers: data.specSectionNumbers ?? [],
    isActive: data.isActive ?? true,
  };
  const result = await db.insert(scopeDictionaries).values(values as any).returning();
  return result[0];
}

export async function updateScopeDictionary(id: number, data: Partial<InsertScopeDictionaryInput>): Promise<ScopeDictionary | null> {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.scopeName !== undefined) updateData.scopeName = data.scopeName;
  if (data.includeKeywords !== undefined) updateData.includeKeywords = data.includeKeywords;
  if (data.boostPhrases !== undefined) updateData.boostPhrases = data.boostPhrases;
  if (data.excludeKeywords !== undefined) updateData.excludeKeywords = data.excludeKeywords;
  if (data.weight !== undefined) updateData.weight = data.weight;
  if (data.specSectionNumbers !== undefined) updateData.specSectionNumbers = data.specSectionNumbers;
  if (data.calloutPrefixes !== undefined) updateData.calloutPrefixes = data.calloutPrefixes;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const result = await db
    .update(scopeDictionaries)
    .set(updateData)
    .where(eq(scopeDictionaries.id, id))
    .returning();
  return result[0] || null;
}

export async function deleteScopeDictionary(id: number): Promise<boolean> {
  const result = await db
    .delete(scopeDictionaries)
    .where(eq(scopeDictionaries.id, id))
    .returning();
  return result.length > 0;
}

export async function seedDefaultScopeDictionaries(): Promise<void> {
  const existing = await getAllScopeDictionaries();
  if (existing.length > 0) return;

  const defaults = DEFAULT_CLASSIFICATION_CONFIG.scopes.map((scope) => ({
    scopeName: scope.name,
    includeKeywords: scope.includeKeywords,
    boostPhrases: scope.boostPhrases,
    excludeKeywords: [] as string[],
    weight: Math.round(scope.weight * 100),
    specSectionNumbers: scope.includeKeywords.filter(k => /^\d/.test(k)),
    isActive: true,
  }));

  for (const entry of defaults) {
    await db.insert(scopeDictionaries).values(entry);
  }
}

export async function getAllRegions(): Promise<Region[]> {
  return await db.select().from(regions).orderBy(regions.code);
}

export async function getActiveRegions(): Promise<Region[]> {
  return await db.select().from(regions).where(eq(regions.isActive, true)).orderBy(regions.code);
}

export async function createRegion(data: InsertRegionInput): Promise<Region> {
  const result = await db.insert(regions).values({
    code: data.code.toUpperCase(),
    name: data.name,
    aliases: data.aliases ?? null,
    selfPerformEstimators: data.selfPerformEstimators ?? null,
    isActive: data.isActive ?? true,
  }).returning();
  return result[0];
}

export async function updateRegion(id: number, data: Partial<InsertRegionInput>): Promise<Region | null> {
  const updateData: Record<string, unknown> = {};
  if (data.code !== undefined) updateData.code = data.code.toUpperCase();
  if (data.name !== undefined) updateData.name = data.name;
  if (data.aliases !== undefined) updateData.aliases = data.aliases;
  if (data.selfPerformEstimators !== undefined) updateData.selfPerformEstimators = data.selfPerformEstimators;
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const result = await db
    .update(regions)
    .set(updateData)
    .where(eq(regions.id, id))
    .returning();
  return result[0] || null;
}

export async function deleteRegion(id: number): Promise<boolean> {
  const result = await db.delete(regions).where(eq(regions.id, id)).returning();
  return result.length > 0;
}

export async function generateProjectId(): Promise<string> {
  const currentYear = new Date().getFullYear() % 100;

  const seqResult = await db.execute(sql`
    INSERT INTO project_id_sequence (year, last_sequence)
    VALUES (${currentYear}, 1)
    ON CONFLICT (year) DO UPDATE
      SET last_sequence = project_id_sequence.last_sequence + 1
    RETURNING last_sequence;
  `);

  const seq = (seqResult.rows[0] as any).last_sequence as number;
  const yearStr = currentYear.toString().padStart(2, "0");
  const seqStr = seq.toString().padStart(4, "0");
  return `${yearStr}-${seqStr}`;
}

export async function getAllProjects(includeTest = false): Promise<Project[]> {
  if (includeTest) {
    return await db.select().from(projects).orderBy(desc(projects.createdAt));
  }
  return await db.select().from(projects).where(eq(projects.isTest, false)).orderBy(desc(projects.createdAt));
}

export async function getTestProjects(): Promise<Project[]> {
  return await db.select().from(projects).where(eq(projects.isTest, true)).orderBy(desc(projects.createdAt));
}

export async function getProjectById(id: number): Promise<Project | null> {
  const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  return result[0] || null;
}

export async function getProjectByProjectId(projectId: string): Promise<Project | null> {
  const result = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return result[0] || null;
}

export async function createProject(data: InsertProjectInput): Promise<Project> {
  const result = await db.insert(projects).values({
    projectId: data.projectId,
    projectName: data.projectName,
    regionCode: data.regionCode,
    dueDate: data.dueDate,
    projectAddress: data.projectAddress,
    status: data.status ?? "created",
    specsiftSessionId: data.specsiftSessionId,
    planparserJobId: data.planparserJobId,
    folderPath: data.folderPath,
    plansFilename: data.plansFilename,
    specsFilename: data.specsFilename,
    notes: data.notes,
    isTest: data.isTest ?? false,
    createdBy: data.createdBy ?? "admin",
  }).returning();
  return result[0];
}

export async function updateProject(id: number, data: Partial<InsertProjectInput>): Promise<Project | null> {
  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (data.projectName !== undefined) updateData.projectName = data.projectName;
  if (data.regionCode !== undefined) updateData.regionCode = data.regionCode;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.specsiftSessionId !== undefined) updateData.specsiftSessionId = data.specsiftSessionId;
  if (data.planparserJobId !== undefined) updateData.planparserJobId = data.planparserJobId;
  if (data.folderPath !== undefined) updateData.folderPath = data.folderPath;
  if (data.plansFilename !== undefined) updateData.plansFilename = data.plansFilename;
  if (data.specsFilename !== undefined) updateData.specsFilename = data.specsFilename;
  if (data.notes !== undefined) updateData.notes = data.notes;

  const result = await db
    .update(projects)
    .set(updateData)
    .where(eq(projects.id, id))
    .returning();
  return result[0] || null;
}

export async function getProjectScopes(projectId: number): Promise<ProjectScope[]> {
  return await db.select().from(projectScopes).where(eq(projectScopes.projectId, projectId));
}

export async function createProjectScope(data: InsertProjectScopeInput): Promise<ProjectScope> {
  const result = await db.insert(projectScopes).values(data as any).returning();
  return result[0];
}

export async function updateProjectScopeSelection(id: number, isSelected: boolean): Promise<ProjectScope | null> {
  const result = await db
    .update(projectScopes)
    .set({ isSelected })
    .where(eq(projectScopes.id, id))
    .returning();
  return result[0] || null;
}

export async function deleteProject(id: number): Promise<boolean> {
  await db.delete(planIndex).where(eq(planIndex.projectId, id));
  await db.delete(projectScopes).where(eq(projectScopes.projectId, id));
  const result = await db.delete(projects).where(eq(projects.id, id)).returning();
  return result.length > 0;
}

export async function getPlanIndex(projectId: number): Promise<PlanIndexEntry[]> {
  return await db.select().from(planIndex).where(eq(planIndex.projectId, projectId));
}

export async function createPlanIndexEntry(data: InsertPlanIndexInput): Promise<PlanIndexEntry> {
  const result = await db.insert(planIndex).values(data).returning();
  return result[0];
}
