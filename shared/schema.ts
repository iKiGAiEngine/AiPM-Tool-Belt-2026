import { z } from "zod";
import { pgTable, serial, text, timestamp, jsonb, boolean, integer, varchar, unique, customType, numeric, json, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import type { BuyoutBoard } from "./buyout/types";

// External tables not owned by this schema file but present in the database.
// These stubs exist so `db:push` does NOT propose dropping them. Do not remove.
//   - `session` is managed by connect-pg-simple (Express session store).
//   - `system_settings` is a runtime key/value bag used by app code.
export const dbSession = pgTable("session", {
  sid: varchar("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { mode: "date" }).notNull(),
}, (table) => ({
  expireIdx: index("IDX_session_expire").on(table.expire),
}));

export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
});

export const processingStatusSchema = z.enum(["idle", "processing", "complete", "error"]);
export type ProcessingStatus = z.infer<typeof processingStatusSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  filename: z.string(),
  projectName: z.string(),
  status: processingStatusSchema,
  progress: z.number().min(0).max(100),
  message: z.string(),
  createdAt: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;
export type InsertSession = Omit<Session, "id">;

export const extractedSectionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sectionNumber: z.string(),
  title: z.string(),
  content: z.string().optional(),
  pageNumber: z.number().optional(),
  startPage: z.number().optional(),
  endPage: z.number().optional(),
  manufacturers: z.array(z.string()).default([]),
  modelNumbers: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  conflicts: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  isEdited: z.boolean().default(false),
});
export type ExtractedSection = z.infer<typeof extractedSectionSchema>;
export type InsertSection = Omit<ExtractedSection, "id">;

export const accessoryScopeSchema = z.object({
  name: z.string(),
  keywords: z.array(z.string()),
  sectionHint: z.string(),
  divisionScope: z.array(z.number()),
});
export type AccessoryScope = z.infer<typeof accessoryScopeSchema>;

export const accessoryMatchSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  scopeName: z.string(),
  matchedKeyword: z.string(),
  context: z.string(),
  pageNumber: z.number(),
  sectionHint: z.string(),
});
export type AccessoryMatch = z.infer<typeof accessoryMatchSchema>;
export type InsertAccessoryMatch = Omit<AccessoryMatch, "id">;

export const DEFAULT_SCOPES: Record<string, string> = {
  "10 11 00": "Visual Display Units",
  "10 11 13": "Chalkboards",
  "10 11 16": "Markerboards",
  "10 11 23": "Tackboards",
  "10 11 53": "Sliding Displays",
  "10 12 00": "Display Cases",
  "10 14 00": "Signage",
  "10 14 19": "Dimensional Signage",
  "10 14 23": "Panel Signage",
  "10 14 26": "Post and Panel Signage",
  "10 14 33": "Directory Signage",
  "10 14 53": "Traffic Signage",
  "10 14 73": "Painted Signage",
  "10 21 00": "Compartments and Cubicles",
  "10 21 13": "Toilet Compartments",
  "10 21 13.13": "Metal Toilet Compartments",
  "10 21 13.16": "Plastic Laminate Compartments",
  "10 21 13.17": "Phenolic Compartments",
  "10 21 13.19": "Solid Plastic Compartments",
  "10 21 15": "Plastic Compartments",
  "10 21 16": "ADA Shower Receptors",
  "10 21 17": "Shower Receptors",
  "10 21 19": "Shower Compartments",
  "10 21 23": "Cubicle Curtains",
  "10 22 00": "Partitions",
  "10 22 13": "Wire Mesh Partitions",
  "10 22 16": "Folding Gates",
  "10 22 19": "Demountable Partitions",
  "10 22 23": "Portable Partitions",
  "10 22 26": "Operable Partitions",
  "10 22 33": "Accordion Partitions",
  "10 22 36": "Panel Partitions",
  "10 22 39": "Folding Partitions",
  "10 22 43": "Sliding Partitions",
  "10 26 00": "Wall Protection",
  "10 26 01": "Wall Protection",
  "10 26 13": "Wall and Door Protection",
  "10 26 16": "Corner Guards",
  "10 26 23": "Wall Guards",
  "10 26 33": "Bumper Guards",
  "10 26 43": "Door Protection",
  "10 28 00": "Toilet Accessories",
  "10 28 13": "Toilet Accessories",
  "10 28 16": "Bath Accessories",
  "10 28 19": "Shower Enclosures",
  "10 28 23": "Laundry Accessories",
  "10 31 00": "Fireplaces",
  "10 32 00": "Fireplace Specialties",
  "10 35 00": "Stoves",
  "10 41 00": "Emergency Cabinets",
  "10 41 13": "Defibrillator Cabinets",
  "10 41 16": "Key Cabinets",
  "10 43 00": "Emergency Aid",
  "10 44 00": "Fire Protection",
  "10 44 13": "Fire Protection Cabinets",
  "10 44 16": "Fire Extinguishers",
  "10 44 43": "Fire Blankets",
  "10 51 00": "Lockers",
  "10 51 13": "Metal Lockers",
  "10 51 16": "Plastic Lockers",
  "10 51 23": "Wood Lockers",
  "10 51 26": "Phenolic Lockers",
  "10 51 53": "Athletic Lockers",
  "10 55 00": "Postal Specialties",
  "10 55 23": "Mail Boxes",
  "10 56 00": "Storage Assemblies",
  "10 56 13": "Metal Shelving",
  "10 56 19": "Wire Shelving",
  "10 56 26": "High-Density Storage",
  "10 71 00": "Exterior Protection",
  "10 71 13": "Sun Control Devices",
  "10 73 00": "Protective Covers",
  "10 73 13": "Awnings",
  "10 73 16": "Canopies",
  "10 74 00": "Exterior Specialties",
  "10 75 00": "Flagpoles",
  "10 81 00": "Pest Control",
  "10 82 00": "Grilles and Screens",
  "10 83 00": "Flags and Banners",
  "10 86 00": "Security Mirrors",
};

export const ACCESSORY_SCOPES: AccessoryScope[] = [
  { name: "Bike Racks", keywords: ["bike rack", "bicycle rack", "bicycle parking"], sectionHint: "12 93 43", divisionScope: [11, 12] },
  { name: "Expansion Joints", keywords: ["expansion joint", "control joint"], sectionHint: "07 95 13", divisionScope: [6, 7] },
  { name: "Window Shades", keywords: ["window shade", "roller shade", "blind"], sectionHint: "12 24 13", divisionScope: [11, 12] },
  { name: "Site Furnishings", keywords: ["site furnishing", "bench", "picnic table"], sectionHint: "12 93 00", divisionScope: [11, 12] },
  { name: "Entrance Mats/Grilles", keywords: ["entrance mat", "entrance grille", "entrance floor grille", "entrance floor mat", "walk-off mat", "walk-off grille", "floor mat", "floor grille"], sectionHint: "12 48 13", divisionScope: [11, 12] },
  { name: "Flagpoles", keywords: ["flagpole", "flag pole"], sectionHint: "12 93 23", divisionScope: [11, 12] },
  { name: "Display Cases", keywords: ["display case", "trophy case", "exhibit case"], sectionHint: "11 11 13", divisionScope: [11, 12] },
  { name: "Wardrobe Closets/Shelving", keywords: ["wardrobe", "closet shelving", "wire shelving"], sectionHint: "10 56 00", divisionScope: [11, 12] },
];

export const uploadFileSchema = z.object({
  file: z.instanceof(File),
});

export const updateSectionSchema = z.object({
  title: z.string().optional(),
  isEdited: z.boolean().optional(),
});
export type UpdateSection = z.infer<typeof updateSectionSchema>;


// Plan Parser schemas
export const planParserJobStatusSchema = z.enum(["pending", "processing", "complete", "error"]);
export type PlanParserJobStatus = z.infer<typeof planParserJobStatusSchema>;

export const planParserJobSchema = z.object({
  id: z.string(),
  status: planParserJobStatusSchema,
  totalPages: z.number().default(0),
  processedPages: z.number().default(0),
  flaggedPages: z.number().default(0),
  filenames: z.array(z.string()).default([]),
  message: z.string().default(""),
  createdAt: z.string(),
  expiresAt: z.string(),
  scopeCounts: z.record(z.string(), z.number()).default({}),
});
export type PlanParserJob = z.infer<typeof planParserJobSchema>;
export type InsertPlanParserJob = Omit<PlanParserJob, "id">;

export const parsedPageSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  originalFilename: z.string(),
  pageNumber: z.number(),
  isRelevant: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(100).default(0),
  whyFlagged: z.string().default(""),
  signageOverrideApplied: z.boolean().default(false),
  ocrSnippet: z.string().default(""),
  ocrText: z.string().default(""),
  thumbnailPath: z.string().optional(),
  userModified: z.boolean().default(false),
});
export type ParsedPage = z.infer<typeof parsedPageSchema>;
export type InsertParsedPage = Omit<ParsedPage, "id">;

// Plan Parser Scope Types
export const PLAN_PARSER_SCOPES = [
  "Toilet Accessories",
  "Toilet Partitions",
  "Wall Protection",
  "Fire Extinguisher Cabinets",
  "Cubicle Curtains",
  "Visual Display",
  "Lockers",
  "Shelving",
  "Other Div10",
] as const;
export type PlanParserScope = typeof PLAN_PARSER_SCOPES[number];

// Spec Extractor Configuration Database Schema
export interface AccessoryScopeData {
  name: string;
  keywords: string[];
  sectionHint: string;
  divisionScope: number[];
}

export const specsiftConfig = pgTable("specsift_config", {
  id: serial("id").primaryKey(),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  sectionPattern: text("section_pattern").notNull(),
  defaultScopes: jsonb("default_scopes").notNull().$type<Record<string, string>>(),
  accessoryScopes: jsonb("accessory_scopes").notNull().$type<AccessoryScopeData[]>(),
  manufacturerExcludeTerms: jsonb("manufacturer_exclude_terms").notNull().$type<string[]>(),
  modelPatterns: jsonb("model_patterns").notNull().$type<string[]>(),
  materialKeywords: jsonb("material_keywords").notNull().$type<string[]>(),
  conflictPatterns: jsonb("conflict_patterns").notNull().$type<string[]>(),
  notePatterns: jsonb("note_patterns").notNull().$type<string[]>(),
  notes: text("notes").default(""),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  createdBy: varchar("created_by", { length: 100 }).default("admin"),
});

export type SpecsiftConfig = typeof specsiftConfig.$inferSelect;
export type InsertSpecsiftConfig = typeof specsiftConfig.$inferInsert;

export const insertSpecsiftConfigSchema = createInsertSchema(specsiftConfig).omit({
  id: true,
  createdAt: true,
});

export const accessoryScopeDataSchema = z.object({
  name: z.string().min(1),
  keywords: z.array(z.string()),
  sectionHint: z.string(),
  divisionScope: z.array(z.number()),
});

export const specsiftConfigFormSchema = z.object({
  sectionPattern: z.string().min(1, "Section pattern is required"),
  defaultScopes: z.record(z.string(), z.string()),
  accessoryScopes: z.array(accessoryScopeDataSchema),
  manufacturerExcludeTerms: z.array(z.string()),
  modelPatterns: z.array(z.string()),
  materialKeywords: z.array(z.string()),
  conflictPatterns: z.array(z.string()),
  notePatterns: z.array(z.string()),
  notes: z.string().optional(),
});

export type SpecsiftConfigFormData = z.infer<typeof specsiftConfigFormSchema>;

// =====================================================
// AIPM CENTRAL SETTINGS - Vendors & Products
// =====================================================

// Vendor Parse Configuration - vendor-specific quote parsing rules
export interface VendorParseConfig {
  quoteFormat?: "inline" | "table"; // "table" means totals are in separate columns
  subtotalLabel?: string; // e.g., "Subtotal" - what to look for
  freightLabel?: string; // e.g., "Estimated Freight"
  lineItemPattern?: string; // Regex pattern for line items
  skipFreightFromTotal?: boolean; // If true, use Subtotal (before freight) not Total
}

// Vendor Profiles Table
export const vendors = pgTable("vendors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  shortName: varchar("short_name", { length: 50 }), // e.g., "Activar", "Bobrick"
  quotePatterns: jsonb("quote_patterns").$type<string[]>().default([]), // Regex patterns to identify vendor quotes
  modelPrefixes: jsonb("model_prefixes").$type<string[]>().default([]), // e.g., ["B-", "ASI-"]
  parseConfig: jsonb("parse_config").$type<VendorParseConfig>().default({}), // Vendor-specific parsing rules
  contactEmail: varchar("contact_email", { length: 200 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  website: varchar("website", { length: 300 }),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Vendor = typeof vendors.$inferSelect;
export type InsertVendor = typeof vendors.$inferInsert;

export const insertVendorSchema = createInsertSchema(vendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVendorInput = z.infer<typeof insertVendorSchema>;

// Division 10 Products Table
export const div10Products = pgTable("div10_products", {
  id: serial("id").primaryKey(),
  modelNumber: varchar("model_number", { length: 100 }).notNull(),
  description: text("description").notNull(),
  manufacturer: varchar("manufacturer", { length: 200 }),
  vendorId: integer("vendor_id"), // Optional link to vendor
  scopeCategory: varchar("scope_category", { length: 100 }).notNull(), // e.g., "Toilet Accessories", "Fire Extinguisher Cabinets"
  aliases: jsonb("aliases").$type<string[]>().default([]), // Alternative model numbers or names
  typicalPrice: varchar("typical_price", { length: 50 }), // For reference/validation
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Div10Product = typeof div10Products.$inferSelect;
export type InsertDiv10Product = typeof div10Products.$inferInsert;

export const insertDiv10ProductSchema = createInsertSchema(div10Products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDiv10ProductInput = z.infer<typeof insertDiv10ProductSchema>;

// Scope categories for the products dropdown
export const DIV10_SCOPE_CATEGORIES = [
  "Toilet Accessories",
  "Toilet Partitions",
  "Wall Protection",
  "Fire Extinguisher Cabinets",
  "Fire Extinguishers",
  "Cubicle Curtains",
  "Visual Display",
  "Lockers",
  "Shelving",
  "Signage",
  "Other Div10",
] as const;
export type Div10ScopeCategory = typeof DIV10_SCOPE_CATEGORIES[number];

// =====================================================
// MODEL SUFFIX DECODER - For extended model numbers
// =====================================================

// Suffix decoder entries for manufacturer-specific codes
export const modelSuffixDecoders = pgTable("model_suffix_decoders", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id"), // Optional link to specific vendor
  manufacturer: varchar("manufacturer", { length: 200 }), // e.g., "JL Industries", "Larsen's"
  suffixCode: varchar("suffix_code", { length: 50 }).notNull(), // e.g., "F17", "FX2", "AL"
  decodedText: varchar("decoded_text", { length: 200 }).notNull(), // e.g., "17\" Depth", "Fire-Rated"
  category: varchar("category", { length: 100 }), // e.g., "depth", "fire-rating", "material", "door-style"
  sortOrder: integer("sort_order").default(0), // For ordering decoded text in output
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ModelSuffixDecoder = typeof modelSuffixDecoders.$inferSelect;
export type InsertModelSuffixDecoder = typeof modelSuffixDecoders.$inferInsert;

export const insertModelSuffixDecoderSchema = createInsertSchema(modelSuffixDecoders).omit({
  id: true,
  createdAt: true,
});
export type InsertModelSuffixDecoderInput = z.infer<typeof insertModelSuffixDecoderSchema>;

// Common suffix categories
export const SUFFIX_CATEGORIES = [
  "depth",
  "fire-rating",
  "material",
  "door-style",
  "trim-style",
  "mounting",
  "finish",
  "size",
  "other",
] as const;
export type SuffixCategory = typeof SUFFIX_CATEGORIES[number];

// =====================================================
// SPECIAL LINE ITEM RULES - For freight, tags, decals
// =====================================================

export const specialLineRules = pgTable("special_line_rules", {
  id: serial("id").primaryKey(),
  ruleType: varchar("rule_type", { length: 50 }).notNull(), // "freight", "tag", "decal", "exclude"
  matchPattern: varchar("match_pattern", { length: 200 }).notNull(), // Regex or text pattern
  action: varchar("action", { length: 50 }).notNull(), // "consolidate", "exclude", "transform"
  appendText: varchar("append_text", { length: 200 }), // Text to append (e.g., " - tagged")
  targetScope: varchar("target_scope", { length: 100 }), // Which scope it applies to
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SpecialLineRule = typeof specialLineRules.$inferSelect;
export type InsertSpecialLineRule = typeof specialLineRules.$inferInsert;

export const insertSpecialLineRuleSchema = createInsertSchema(specialLineRules).omit({
  id: true,
  createdAt: true,
});
export type InsertSpecialLineRuleInput = z.infer<typeof insertSpecialLineRuleSchema>;

// =====================================================
// SCOPE DICTIONARIES - Editable keywords per scope type
// =====================================================

export const scopeDictionaries = pgTable("scope_dictionaries", {
  id: serial("id").primaryKey(),
  scopeName: varchar("scope_name", { length: 100 }).notNull(),
  includeKeywords: jsonb("include_keywords").notNull().$type<string[]>().default([]),
  boostPhrases: jsonb("boost_phrases").notNull().$type<string[]>().default([]),
  excludeKeywords: jsonb("exclude_keywords").notNull().$type<string[]>().default([]),
  weight: integer("weight").notNull().default(100),
  specSectionNumbers: jsonb("spec_section_numbers").notNull().$type<string[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ScopeDictionary = typeof scopeDictionaries.$inferSelect;
export type InsertScopeDictionary = typeof scopeDictionaries.$inferInsert;

export const insertScopeDictionarySchema = createInsertSchema(scopeDictionaries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertScopeDictionaryInput = z.infer<typeof insertScopeDictionarySchema>;

// =====================================================
// REGIONS - Airport codes / region names
// =====================================================

export const regions = pgTable("regions", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 20 }).notNull(),
  name: varchar("name", { length: 200 }),
  aliases: text("aliases").array(),
  selfPerformEstimators: text("self_perform_estimators").array(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Region = typeof regions.$inferSelect;
export type InsertRegion = typeof regions.$inferInsert;

export const insertRegionSchema = createInsertSchema(regions).omit({
  id: true,
  createdAt: true,
});
export type InsertRegionInput = z.infer<typeof insertRegionSchema>;

// =====================================================
// PROJECT ID SEQUENCE - Transaction-safe YY-#### IDs
// =====================================================

export const projectIdSequence = pgTable("project_id_sequence", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull().unique(),
  lastSequence: integer("last_sequence").notNull().default(0),
});

// =====================================================
// PROJECTS - Main project records
// =====================================================

export const projectStatusSchema = z.enum([
  "created",
  "plans_uploaded",
  "specs_uploaded",
  "specsift_running",
  "specsift_complete",
  "specsift_error",
  "planparser_baseline_running",
  "planparser_baseline_complete",
  "planparser_baseline_error",
  "scopes_selected",
  "planparser_specpass_running",
  "planparser_specpass_complete",
  "planparser_specpass_error",
  "outputs_ready",
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  projectId: varchar("project_id", { length: 20 }).notNull(),
  projectName: varchar("project_name", { length: 500 }).notNull(),
  regionCode: varchar("region_code", { length: 20 }).notNull(),
  dueDate: varchar("due_date", { length: 20 }).notNull(),
  projectAddress: varchar("project_address", { length: 1000 }),
  status: varchar("status", { length: 50 }).notNull().default("created"),
  specsiftSessionId: varchar("specsift_session_id", { length: 100 }),
  planparserJobId: varchar("planparser_job_id", { length: 100 }),
  folderPath: varchar("folder_path", { length: 1000 }),
  plansFilename: varchar("plans_filename", { length: 500 }),
  specsFilename: varchar("specs_filename", { length: 500 }),
  notes: text("notes"),
  baselineScopeCounts: jsonb("baseline_scope_counts").$type<Record<string, number>>(),
  baselineFlaggedPages: integer("baseline_flagged_pages"),
  isTest: boolean("is_test").default(false).notNull(),
  createdBy: varchar("created_by", { length: 100 }).default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

export const insertProjectSchema = createInsertSchema(projects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProjectInput = z.infer<typeof insertProjectSchema>;

// =====================================================
// PROJECT SCOPES - Selected scopes from Spec Extractor
// =====================================================

export const projectScopes = pgTable("project_scopes", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  scopeType: varchar("scope_type", { length: 100 }).notNull(),
  specSectionNumber: varchar("spec_section_number", { length: 50 }),
  specSectionTitle: varchar("spec_section_title", { length: 500 }),
  keyRequirements: jsonb("key_requirements").$type<string[]>().default([]),
  manufacturers: jsonb("manufacturers").$type<string[]>().default([]),
  modelNumbers: jsonb("model_numbers").$type<string[]>().default([]),
  materials: jsonb("materials").$type<string[]>().default([]),
  keywords: jsonb("keywords").$type<string[]>().default([]),
  confidenceScore: integer("confidence_score").default(0),
  isSelected: boolean("is_selected").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ProjectScope = typeof projectScopes.$inferSelect;
export type InsertProjectScope = typeof projectScopes.$inferInsert;

export const insertProjectScopeSchema = createInsertSchema(projectScopes).omit({
  id: true,
  createdAt: true,
});
export type InsertProjectScopeInput = z.infer<typeof insertProjectScopeSchema>;

// =====================================================
// PLAN INDEX - Sheet-level index of plan pages
// =====================================================

export const planIndex = pgTable("plan_index", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  jobId: varchar("job_id", { length: 100 }).notNull(),
  sheetNumber: varchar("sheet_number", { length: 50 }),
  sheetTitle: varchar("sheet_title", { length: 500 }),
  pageNumber: integer("page_number").notNull(),
  inferredCategory: varchar("inferred_category", { length: 100 }),
  confidence: integer("confidence").default(0),
  isRelevant: boolean("is_relevant").default(false),
  scopeType: varchar("scope_type", { length: 100 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PlanIndexEntry = typeof planIndex.$inferSelect;
export type InsertPlanIndexEntry = typeof planIndex.$inferInsert;

export const insertPlanIndexSchema = createInsertSchema(planIndex).omit({
  id: true,
  createdAt: true,
});
export type InsertPlanIndexInput = z.infer<typeof insertPlanIndexSchema>;

// =====================================================
// FOLDER TEMPLATES - Versioned folder structure templates
// =====================================================

export const folderTemplates = pgTable("folder_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  filePath: varchar("file_path", { length: 1000 }).notNull(),
  fileSize: integer("file_size").notNull().default(0),
  fileData: customType<{ data: Buffer; driverData: Buffer }>({
    dataType() { return "bytea"; },
  })("file_data"),
  folderStructure: jsonb("folder_structure").$type<string[]>().default([]),
  uploadedBy: varchar("uploaded_by", { length: 100 }).default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type FolderTemplate = typeof folderTemplates.$inferSelect;
export type InsertFolderTemplate = typeof folderTemplates.$inferInsert;

export const insertFolderTemplateSchema = createInsertSchema(folderTemplates).omit({
  id: true,
  createdAt: true,
});
export type InsertFolderTemplateInput = z.infer<typeof insertFolderTemplateSchema>;

// =====================================================
// ESTIMATE TEMPLATES - Versioned Excel estimate files
// =====================================================

export interface StampMapping {
  cellRef: string;
  fieldName: string;
  label: string;
}

export const estimateTemplates = pgTable("estimate_templates", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  filePath: varchar("file_path", { length: 1000 }).notNull(),
  originalFilename: varchar("original_filename", { length: 500 }).notNull(),
  fileSize: integer("file_size").notNull().default(0),
  fileData: customType<{ data: Buffer; driverData: Buffer }>({
    dataType() { return "bytea"; },
  })("file_data"),
  sheetNames: jsonb("sheet_names").$type<string[]>().default([]),
  stampMappings: jsonb("stamp_mappings").$type<StampMapping[]>().default([]),
  uploadedBy: varchar("uploaded_by", { length: 100 }).default("admin"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type EstimateTemplate = typeof estimateTemplates.$inferSelect;
export type InsertEstimateTemplate = typeof estimateTemplates.$inferInsert;

export const insertEstimateTemplateSchema = createInsertSchema(estimateTemplates).omit({
  id: true,
  createdAt: true,
});
export type InsertEstimateTemplateInput = z.infer<typeof insertEstimateTemplateSchema>;

// =====================================================
// SPECSIFT SESSIONS - Persistent session storage
// =====================================================

export const sessions = pgTable("sessions", {
  id: varchar("id", { length: 100 }).primaryKey(),
  filename: varchar("filename", { length: 500 }).notNull(),
  projectName: varchar("project_name", { length: 500 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("idle"),
  progress: integer("progress").notNull().default(0),
  message: text("message").notNull().default(""),
  createdAt: varchar("created_at", { length: 100 }).notNull(),
});

// =====================================================
// EXTRACTED SECTIONS - Spec sections from Spec Extractor
// =====================================================

export const extractedSections = pgTable("extracted_sections", {
  id: varchar("id", { length: 100 }).primaryKey(),
  sessionId: varchar("session_id", { length: 100 }).notNull(),
  sectionNumber: varchar("section_number", { length: 50 }).notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  content: text("content"),
  pageNumber: integer("page_number"),
  startPage: integer("start_page"),
  endPage: integer("end_page"),
  manufacturers: jsonb("manufacturers").$type<string[]>().default([]),
  modelNumbers: jsonb("model_numbers").$type<string[]>().default([]),
  materials: jsonb("materials").$type<string[]>().default([]),
  conflicts: jsonb("conflicts").$type<string[]>().default([]),
  notes: jsonb("notes").$type<string[]>().default([]),
  isEdited: boolean("is_edited").notNull().default(false),
});

// =====================================================
// ACCESSORY MATCHES - Matched accessory scopes
// =====================================================

export const accessoryMatches = pgTable("accessory_matches", {
  id: varchar("id", { length: 100 }).primaryKey(),
  sessionId: varchar("session_id", { length: 100 }).notNull(),
  scopeName: varchar("scope_name", { length: 200 }).notNull(),
  matchedKeyword: varchar("matched_keyword", { length: 200 }).notNull(),
  context: text("context").notNull(),
  pageNumber: integer("page_number").notNull(),
  sectionHint: varchar("section_hint", { length: 50 }).notNull(),
});

// =====================================================
// PLAN PARSER JOBS - Persistent job storage
// =====================================================

export const planParserJobs = pgTable("plan_parser_jobs", {
  id: varchar("id", { length: 100 }).primaryKey(),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  totalPages: integer("total_pages").notNull().default(0),
  processedPages: integer("processed_pages").notNull().default(0),
  flaggedPages: integer("flagged_pages").notNull().default(0),
  filenames: jsonb("filenames").$type<string[]>().default([]),
  message: text("message").notNull().default(""),
  createdAt: varchar("created_at", { length: 100 }).notNull(),
  expiresAt: varchar("expires_at", { length: 100 }).notNull(),
  scopeCounts: jsonb("scope_counts").$type<Record<string, number>>().default({}),
});

// =====================================================
// PARSED PAGES - Individual plan page results
// =====================================================

// =====================================================
// SPEC EXTRACTOR SESSIONS - Standalone regex-based extractor
// =====================================================

export const specExtractorSessions = pgTable("spec_extractor_sessions", {
  id: varchar("id", { length: 100 }).primaryKey(),
  filename: varchar("filename", { length: 500 }).notNull(),
  projectName: varchar("project_name", { length: 500 }).notNull(),
  suggestedProjectName: varchar("suggested_project_name", { length: 500 }),
  status: varchar("status", { length: 50 }).notNull().default("idle"),
  progress: integer("progress").notNull().default(0),
  message: text("message").notNull().default(""),
  totalPages: integer("total_pages").notNull().default(0),
  tocStart: integer("toc_start"),
  tocEnd: integer("toc_end"),
  selectedAccessories: jsonb("selected_accessories").$type<string[]>().default([]),
  createdAt: varchar("created_at", { length: 100 }).notNull(),
});

export const specExtractorSections = pgTable("spec_extractor_sections", {
  id: varchar("id", { length: 100 }).primaryKey(),
  sessionId: varchar("session_id", { length: 100 }).notNull(),
  sectionNumber: varchar("section_number", { length: 50 }).notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  startPage: integer("start_page").notNull(),
  endPage: integer("end_page").notNull(),
  pageCount: integer("page_count").notNull().default(1),
  folderName: varchar("folder_name", { length: 500 }).notNull(),
  aiReviewStatus: varchar("ai_review_status", { length: 50 }),
  aiReviewNotes: text("ai_review_notes"),
  originalTitle: varchar("original_title", { length: 500 }),
  sectionType: varchar("section_type", { length: 50 }).notNull().default("div10"),
  isSignage: boolean("is_signage").notNull().default(false),
  matchedKeywords: jsonb("matched_keywords").$type<string[]>().default([]),
});

export const specExtractorSessionSchema = z.object({
  id: z.string(),
  filename: z.string(),
  projectName: z.string(),
  suggestedProjectName: z.string().nullable().optional(),
  status: z.string(),
  progress: z.number(),
  message: z.string(),
  totalPages: z.number(),
  tocStart: z.number().nullable().optional(),
  tocEnd: z.number().nullable().optional(),
  selectedAccessories: z.array(z.string()).optional().default([]),
  createdAt: z.string(),
});
export type SpecExtractorSession = z.infer<typeof specExtractorSessionSchema>;

export const specExtractorSectionSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  sectionNumber: z.string(),
  title: z.string(),
  startPage: z.number(),
  endPage: z.number(),
  pageCount: z.number(),
  folderName: z.string(),
  aiReviewStatus: z.string().nullable().optional(),
  aiReviewNotes: z.string().nullable().optional(),
  originalTitle: z.string().nullable().optional(),
  sectionType: z.string().default("div10"),
  isSignage: z.boolean().default(false),
  matchedKeywords: z.array(z.string()).optional().default([]),
});
export type SpecExtractorSection = z.infer<typeof specExtractorSectionSchema>;

// =====================================================
// PARSED PAGES - Individual plan page results
// =====================================================

export const parsedPages = pgTable("parsed_pages", {
  id: varchar("id", { length: 100 }).primaryKey(),
  jobId: varchar("job_id", { length: 100 }).notNull(),
  originalFilename: varchar("original_filename", { length: 500 }).notNull(),
  pageNumber: integer("page_number").notNull(),
  isRelevant: boolean("is_relevant").notNull().default(false),
  tags: jsonb("tags").$type<string[]>().default([]),
  confidence: integer("confidence").notNull().default(0),
  whyFlagged: text("why_flagged").notNull().default(""),
  signageOverrideApplied: boolean("signage_override_applied").notNull().default(false),
  ocrSnippet: text("ocr_snippet").notNull().default(""),
  ocrText: text("ocr_text").notNull().default(""),
  thumbnailPath: varchar("thumbnail_path", { length: 500 }),
  userModified: boolean("user_modified").notNull().default(false),
});

// =====================================================
// AUTH - Users, auth tokens, audit logs
// =====================================================

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }),
  displayName: varchar("display_name", { length: 255 }),
  initials: varchar("initials", { length: 10 }),
  role: varchar("role", { length: 20 }).notNull().default("user"),
  isActive: boolean("is_active").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default("invited"),
  passwordHash: text("password_hash"),
  resetToken: text("reset_token"),
  resetTokenExpiresAt: timestamp("reset_token_expires_at"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at"),
  dashboardScope: varchar("dashboard_scope", { length: 30 }).default("my_projects"),
  dashboardLayout: varchar("dashboard_layout", { length: 30 }).default("estimator"),
  assignedRegion: varchar("assigned_region", { length: 100 }),
  isAdmin: boolean("is_admin").notNull().default(false),
});

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true, lastLoginAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const authTokens = pgTable("auth_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  type: varchar("type", { length: 20 }).notNull().default("otp"),
});

export type AuthToken = typeof authTokens.$inferSelect;

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  actorUserId: integer("actor_user_id"),
  actorEmail: varchar("actor_email", { length: 255 }),
  actionType: varchar("action_type", { length: 100 }).notNull(),
  entityType: varchar("entity_type", { length: 100 }),
  entityId: varchar("entity_id", { length: 255 }),
  summary: text("summary"),
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  ipAddress: varchar("ip_address", { length: 100 }),
  userAgent: text("user_agent"),
  requestPath: varchar("request_path", { length: 500 }),
  requestMethod: varchar("request_method", { length: 10 }),
  responseStatus: integer("response_status"),
});

export type AuditLog = typeof auditLogs.$inferSelect;

export const toolUsageEvents = pgTable("tool_usage_events", {
  id: serial("id").primaryKey(),
  toolId: varchar("tool_id", { length: 100 }).notNull(),
  userId: integer("user_id").notNull(),
  usedAt: timestamp("used_at").notNull().defaultNow(),
});

export const insertToolUsageEventSchema = createInsertSchema(toolUsageEvents).omit({ id: true, usedAt: true });
export type InsertToolUsageEvent = z.infer<typeof insertToolUsageEventSchema>;
export type ToolUsageEvent = typeof toolUsageEvents.$inferSelect;

// Bytea custom type for binary file storage (matches existing template/quote pattern)
const screenshotBytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

export const emailTemplateConfig = pgTable("email_template_config", {
  id: serial("id").primaryKey(),
  templateKey: varchar("template_key", { length: 100 }).notNull().unique(),
  subject: varchar("subject", { length: 500 }).notNull(),
  greeting: text("greeting").notNull(),
  bodyMessage: text("body_message").notNull(),
  signOff: text("sign_off").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type EmailTemplateConfig = typeof emailTemplateConfig.$inferSelect;
export type InsertEmailTemplateConfig = typeof emailTemplateConfig.$inferInsert;

export const insertEmailTemplateConfigSchema = createInsertSchema(emailTemplateConfig).omit({
  id: true,
  updatedAt: true,
});
export type InsertEmailTemplateConfigInput = z.infer<typeof insertEmailTemplateConfigSchema>;

export const proposalLogEntries = pgTable("proposal_log_entries", {
  id: serial("id").primaryKey(),
  projectName: varchar("project_name", { length: 500 }).notNull(),
  estimateNumber: varchar("estimate_number", { length: 50 }),
  region: varchar("region", { length: 200 }),
  primaryMarket: varchar("primary_market", { length: 200 }),
  inviteDate: varchar("invite_date", { length: 20 }),
  dueDate: varchar("due_date", { length: 20 }),
  nbsEstimator: varchar("nbs_estimator", { length: 200 }),
  gcEstimateLead: varchar("gc_estimate_lead", { length: 200 }),
  selfPerformEstimator: varchar("self_perform_estimator", { length: 200 }),
  proposalTotal: varchar("proposal_total", { length: 50 }),
  estimateStatus: varchar("estimate_status", { length: 100 }),
  owner: varchar("owner", { length: 200 }),
  filePath: varchar("file_path", { length: 1000 }),
  screenshotPath: varchar("screenshot_path", { length: 1000 }),
  screenshotData: screenshotBytea("screenshot_data"),
  screenshotMimeType: varchar("screenshot_mime_type", { length: 50 }),
  projectDbId: integer("project_db_id"),
  anticipatedStart: varchar("anticipated_start", { length: 20 }),
  anticipatedFinish: varchar("anticipated_finish", { length: 20 }),
  projectAddress: varchar("project_address", { length: 1000 }),
  squareFeet: varchar("square_feet", { length: 50 }),
  notes: text("notes").default(""),
  bcLink: varchar("bc_link", { length: 1000 }),
  ndaRequired: boolean("nda_required").default(false),
  bcAccessStatus: varchar("bc_access_status", { length: 30 }),
  isTest: boolean("is_test").default(false),
  syncedToLocal: boolean("synced_to_local").default(false),
  isDraft: boolean("is_draft").default(false),
  bcProjectId: varchar("bc_project_id", { length: 100 }),
  bcOpportunityIds: text("bc_opportunity_ids"),
  sourceType: varchar("source_type", { length: 30 }),
  sourceEmail: varchar("source_email", { length: 500 }),
  sourceEmailSubject: varchar("source_email_subject", { length: 500 }),
  sourceAttachmentUrl: varchar("source_attachment_url", { length: 2000 }),
  scopeList: text("scope_list"),
  nbsSelectedScopes: text("nbs_selected_scopes"),
  draftApprovedBy: varchar("draft_approved_by", { length: 200 }),
  draftApprovedAt: timestamp("draft_approved_at"),
  bcUpdateFlag: boolean("bc_update_flag").default(false),
  bcChangeLog: text("bc_change_log"),
  finalReviewer: varchar("final_reviewer", { length: 200 }),
  swinertonProject: varchar("swinerton_project", { length: 10 }),
  deletedAt: timestamp("deleted_at"),
  pendingDeletion: boolean("pending_deletion").default(false),
  pendingDeletionBy: varchar("pending_deletion_by", { length: 200 }),
  pendingDeletionAt: timestamp("pending_deletion_at"),
  bidRounds: jsonb("bid_rounds").$type<Array<{
    roundNumber: number;
    addedAt: string;
    addedBy: string;
    nbsEstimator?: string;
    proposalTotal?: string;
    estimateStatus?: string;
    dueDate?: string;
    notes?: string;
  }>>().default([]),
  duplicateOverrideNote: text("duplicate_override_note"),
  estimatedStartDate: timestamp("estimated_start_date"),
  estimatedEndDate: timestamp("estimated_end_date"),
  statusChangedAt: timestamp("status_changed_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProposalLogEntrySchema = createInsertSchema(proposalLogEntries).omit({ id: true, createdAt: true, statusChangedAt: true });
export type InsertProposalLogEntry = z.infer<typeof insertProposalLogEntrySchema>;
export type ProposalLogEntry = typeof proposalLogEntries.$inferSelect;

export const apsTokens = pgTable("aps_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id).unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  scope: varchar("scope", { length: 500 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ApsToken = typeof apsTokens.$inferSelect;
export type InsertApsToken = typeof apsTokens.$inferInsert;

export const insertApsTokenSchema = createInsertSchema(apsTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertApsTokenInput = z.infer<typeof insertApsTokenSchema>;

export const proposalAcknowledgements = pgTable("proposal_acknowledgements", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  entryId: integer("entry_id").notNull().references(() => proposalLogEntries.id),
  acknowledgedAt: timestamp("acknowledged_at").notNull().defaultNow(),
}, (table) => ({
  uniqueUserEntry: unique().on(table.userId, table.entryId),
}));

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  type: varchar("type", { length: 100 }).notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  message: text("message").notNull(),
  metadata: jsonb("metadata"),
  isRead: boolean("is_read").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({ id: true, createdAt: true });
export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

export const bcSyncLog = pgTable("bc_sync_log", {
  id: serial("id").primaryKey(),
  bcOpportunityId: varchar("bc_opportunity_id", { length: 200 }).notNull().unique(),
  rawData: jsonb("raw_data"),
  entryId: integer("entry_id").references(() => proposalLogEntries.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BcSyncLog = typeof bcSyncLog.$inferSelect;

export const bcSyncState = pgTable("bc_sync_state", {
  id: serial("id").primaryKey(),
  lastSyncAt: timestamp("last_sync_at"),
  syncedBy: integer("synced_by").references(() => users.id),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BcSyncState = typeof bcSyncState.$inferSelect;

export const proposalChangeLog = pgTable("proposal_change_log", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull().references(() => proposalLogEntries.id),
  fieldName: varchar("field_name", { length: 100 }).notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: varchar("changed_by", { length: 200 }),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
});

export type ProposalChangeLog = typeof proposalChangeLog.$inferSelect;
export type InsertProposalChangeLog = typeof proposalChangeLog.$inferInsert;

// =====================================================
// VENDOR / MANUFACTURER DATABASE MODULE
// =====================================================

export const mfrVendors = pgTable("mfr_vendors", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(), // legacy — kept for back-compat; populated alongside legalName
  legalName: varchar("legal_name", { length: 255 }), // full official company name (will become NOT NULL in follow-up after backfill)
  shortCode: varchar("short_code", { length: 10 }), // unique abbreviation (uppercased); will become NOT NULL in follow-up
  aliases: text("aliases").array(), // alternate names for incoming-email/bid matching
  category: varchar("category", { length: 100 }),
  website: varchar("website", { length: 500 }),
  materials: text("materials"), // Comma-separated material types (e.g., "Solid Plastic, Phenolic, Metal")
  notes: text("notes"),
  tags: jsonb("tags").$type<string[]>().default([]),
  scopes: text("scopes").array(), // trade tags — canonical Div 10 scopes this vendor covers
  // Buyout Bot: subset of `scopes` for which this vendor is pre-checked when
  // building an RFQ. Stored as canonical scope names (see shared/buyout/canonicalScopes).
  preferredForTrades: text("preferred_for_trades").array(),
  manufacturerIds: integer("manufacturer_ids").array(),
  manufacturerDirect: boolean("manufacturer_direct").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type MfrVendor = typeof mfrVendors.$inferSelect;
export type InsertMfrVendor = typeof mfrVendors.$inferInsert;
export const insertMfrVendorSchema = createInsertSchema(mfrVendors).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMfrVendorInput = z.infer<typeof insertMfrVendorSchema>;

export const mfrContacts = pgTable("mfr_contacts", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id),
  name: varchar("name", { length: 255 }),
  role: varchar("role", { length: 255 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  territory: varchar("territory", { length: 255 }),
  isPrimary: boolean("is_primary").default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type MfrContact = typeof mfrContacts.$inferSelect;
export type InsertMfrContact = typeof mfrContacts.$inferInsert;
export const insertMfrContactSchema = createInsertSchema(mfrContacts).omit({ id: true, createdAt: true });
export type InsertMfrContactInput = z.infer<typeof insertMfrContactSchema>;

export const mfrManufacturers = pgTable("mfr_manufacturers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(), // legacy — kept for back-compat; populated alongside legalName
  legalName: varchar("legal_name", { length: 255 }), // full official manufacturer name (will become NOT NULL in follow-up after backfill)
  shortCode: varchar("short_code", { length: 10 }), // unique abbreviation (uppercased); will become NOT NULL in follow-up
  aliases: text("aliases").array(), // alternate names for incoming-email/bid matching
  website: varchar("website", { length: 500 }),
  primaryContact: varchar("primary_contact", { length: 255 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  address: text("address"),
  notes: text("notes"),
  scopes: text("scopes").array(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type MfrManufacturer = typeof mfrManufacturers.$inferSelect;
export type InsertMfrManufacturer = typeof mfrManufacturers.$inferInsert;
export const insertMfrManufacturerSchema = createInsertSchema(mfrManufacturers).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMfrManufacturerInput = z.infer<typeof insertMfrManufacturerSchema>;

export const mfrVendorManufacturers = pgTable("mfr_vendor_manufacturers", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id),
  manufacturerId: integer("manufacturer_id").notNull().references(() => mfrManufacturers.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  unique: unique().on(table.vendorId, table.manufacturerId),
}));
export type MfrVendorManufacturer = typeof mfrVendorManufacturers.$inferSelect;
export type InsertMfrVendorManufacturer = typeof mfrVendorManufacturers.$inferInsert;

export const mfrProducts = pgTable("mfr_products", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id),
  manufacturerId: integer("manufacturer_id").notNull().references(() => mfrManufacturers.id),
  model: varchar("model", { length: 255 }),
  description: text("description"),
  csiCode: varchar("csi_code", { length: 50 }),
  listPrice: varchar("list_price", { length: 50 }),
  unit: varchar("unit", { length: 20 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type MfrProduct = typeof mfrProducts.$inferSelect;
export type InsertMfrProduct = typeof mfrProducts.$inferInsert;
export const insertMfrProductSchema = createInsertSchema(mfrProducts).omit({ id: true, createdAt: true });
export type InsertMfrProductInput = z.infer<typeof insertMfrProductSchema>;

export const mfrPricing = pgTable("mfr_pricing", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id).unique(),
  discountTier: varchar("discount_tier", { length: 255 }),
  paymentTerms: varchar("payment_terms", { length: 255 }),
  notes: text("notes"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type MfrPricing = typeof mfrPricing.$inferSelect;

export const mfrLogistics = pgTable("mfr_logistics", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id).unique(),
  avgLeadTimeDays: integer("avg_lead_time_days"),
  shipsFrom: varchar("ships_from", { length: 255 }),
  freightNotes: text("freight_notes"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type MfrLogistics = typeof mfrLogistics.$inferSelect;

export const mfrTaxInfo = pgTable("mfr_tax_info", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id).unique(),
  ein: varchar("ein", { length: 20 }),
  w9OnFile: boolean("w9_on_file").default(false),
  w9ReceivedDate: varchar("w9_received_date", { length: 20 }),
  is1099Eligible: boolean("is_1099_eligible").default(false),
  taxExempt: boolean("tax_exempt").default(false),
  exemptionType: varchar("exemption_type", { length: 100 }),
  exemptionCertNumber: varchar("exemption_cert_number", { length: 100 }),
  nexusStates: jsonb("nexus_states").$type<string[]>().default([]),
  taxNotes: text("tax_notes"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type MfrTaxInfo = typeof mfrTaxInfo.$inferSelect;

export const mfrResaleCerts = pgTable("mfr_resale_certs", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id),
  state: varchar("state", { length: 2 }).notNull(),
  certType: varchar("cert_type", { length: 20 }).default("Resale"),
  certNumber: varchar("cert_number", { length: 100 }),
  issueDate: varchar("issue_date", { length: 20 }),
  expirationDate: varchar("expiration_date", { length: 20 }),
  sent: boolean("sent").default(false),
  dateSent: varchar("date_sent", { length: 20 }),
  contactSentTo: varchar("contact_sent_to", { length: 255 }),
  vendorConfirmed: boolean("vendor_confirmed").default(false),
  confirmationDate: varchar("confirmation_date", { length: 20 }),
  blanket: boolean("blanket").default(false),
  projectName: varchar("project_name", { length: 255 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type MfrResaleCert = typeof mfrResaleCerts.$inferSelect;
export type InsertMfrResaleCert = typeof mfrResaleCerts.$inferInsert;
export const insertMfrResaleCertSchema = createInsertSchema(mfrResaleCerts).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMfrResaleCertInput = z.infer<typeof insertMfrResaleCertSchema>;

export const mfrFiles = pgTable("mfr_files", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id").notNull().references(() => mfrVendors.id),
  fileType: varchar("file_type", { length: 50 }),
  originalName: varchar("original_name", { length: 500 }),
  fileData: text("file_data"),
  mimeType: varchar("mime_type", { length: 100 }),
  sizeBytes: integer("size_bytes"),
  uploadedBy: varchar("uploaded_by", { length: 100 }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  notes: varchar("notes", { length: 500 }),
});
export type MfrFile = typeof mfrFiles.$inferSelect;

// =====================================================
// USER FEATURE ACCESS CONTROL
// =====================================================

// Define all available features/tools
export const FEATURES = {
  PROPOSAL_LOG: "proposal-log",
  VENDOR_DATABASE: "vendor-database",
  SUBMITTAL_BUILDER: "submittal-builder",
  SCHEDULE_CONVERTER: "schedule-converter",
  SPEC_EXTRACTOR: "spec-extractor",
  QUOTE_PARSER: "quote-parser",
  PLAN_PARSER: "plan-parser",
  BC_SYNC: "bc-sync",
  DRAFT_REVIEW: "draft-review",
  CENTRAL_SETTINGS: "central-settings",
  PROJECT_START: "project-start",
  ESTIMATING_MODULE: "estimating-module",
  RFQ_VENDOR_LOOKUP: "rfq-vendor-lookup",
  PROCUREMENT_PROCESS: "procurement-process",
  SETTINGS_REGIONS: "settings-regions",
  BUYOUT_BOT: "buyout-bot",
} as const;

export type Feature = typeof FEATURES[keyof typeof FEATURES];

// Default feature access per role
export const DEFAULT_ROLE_FEATURES: Record<string, Feature[]> = {
  admin: Object.values(FEATURES) as Feature[],
  accounting: [
    FEATURES.PROPOSAL_LOG,
    FEATURES.VENDOR_DATABASE,
    FEATURES.CENTRAL_SETTINGS,
  ],
  project_manager: [
    FEATURES.PROPOSAL_LOG,
    FEATURES.SUBMITTAL_BUILDER,
    FEATURES.SCHEDULE_CONVERTER,
    FEATURES.SPEC_EXTRACTOR,
    FEATURES.QUOTE_PARSER,
    FEATURES.PROJECT_START,
    FEATURES.BUYOUT_BOT,
  ],
  user: [FEATURES.PROPOSAL_LOG],
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  user: "Estimator",
  accounting: "Accounting",
  project_manager: "Project Manager",
};

export const userFeatureAccess = pgTable("user_feature_access", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  feature: varchar("feature", { length: 50 }).notNull(),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
});

export const insertUserFeatureAccessSchema = createInsertSchema(userFeatureAccess).omit({
  id: true,
  grantedAt: true,
});
export type InsertUserFeatureAccess = z.infer<typeof insertUserFeatureAccessSchema>;
export type UserFeatureAccess = typeof userFeatureAccess.$inferSelect;

// Permission Profiles - reusable bundles of features
export const permissionProfiles = pgTable("permission_profiles", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  features: jsonb("features").$type<string[]>().default([]),
  linkedRole: varchar("linked_role", { length: 50 }), // Optional: links this profile to a role (admin, user, accounting, project_manager, etc)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertPermissionProfileSchema = createInsertSchema(permissionProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertPermissionProfile = z.infer<typeof insertPermissionProfileSchema>;
export type PermissionProfile = typeof permissionProfiles.$inferSelect;

// =====================================================
// ESTIMATING MODULE
// =====================================================

export const estimates = pgTable("estimates", {
  id: serial("id").primaryKey(),
  proposalLogId: integer("proposal_log_id").notNull(),
  estimateNumber: varchar("estimate_number", { length: 50 }).notNull(),
  projectName: varchar("project_name", { length: 255 }).notNull(),
  activeScopes: jsonb("active_scopes").$type<string[]>().default([]),
  defaultOh: numeric("default_oh", { precision: 5, scale: 2 }).default("8"),
  defaultFee: numeric("default_fee", { precision: 5, scale: 2 }).default("5"),
  defaultEsc: numeric("default_esc", { precision: 5, scale: 2 }).default("0"),
  taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).default("0"),
  bondRate: numeric("bond_rate", { precision: 5, scale: 2 }).default("0"),
  catOverrides: jsonb("cat_overrides").$type<Record<string, { oh?: number; fee?: number; esc?: number }>>().default({}),
  catComplete: jsonb("cat_complete").$type<Record<string, boolean>>().default({}),
  catQuals: jsonb("cat_quals").$type<Record<string, { inclusions?: string; exclusions?: string; qualifications?: string }>>().default({}),
  assumptions: jsonb("assumptions").$type<string[]>().default([]),
  risks: jsonb("risks").$type<string[]>().default([]),
  checklist: jsonb("checklist").$type<any[]>().default([]),
  reviewStatus: varchar("review_status", { length: 30 }).default("drafting"),
  isTest: boolean("is_test").default(false),
  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEstimateSchema = createInsertSchema(estimates).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;
export type Estimate = typeof estimates.$inferSelect;

export const estimateLineItems = pgTable("estimate_line_items", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  planCallout: varchar("plan_callout", { length: 50 }),
  name: varchar("name", { length: 255 }).notNull(),
  model: varchar("model", { length: 100 }),
  mfr: varchar("mfr", { length: 100 }),
  manufacturerId: integer("manufacturer_id").references(() => mfrManufacturers.id, { onDelete: "set null" }),
  qty: integer("qty").default(1).notNull(),
  uom: varchar("uom", { length: 10 }).default("EA"),
  unitCost: numeric("unit_cost", { precision: 10, scale: 2 }).default("0").notNull(),
  escOverride: numeric("esc_override", { precision: 5, scale: 2 }),
  quoteId: integer("quote_id"),
  source: varchar("source", { length: 30 }).default("manual"),
  note: text("note"),
  hasBackup: boolean("has_backup").default(false),
  sortOrder: integer("sort_order").default(0),
  extractionConfidence: integer("extraction_confidence"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEstimateLineItemSchema = createInsertSchema(estimateLineItems).omit({ id: true, createdAt: true });
export type InsertEstimateLineItem = z.infer<typeof insertEstimateLineItemSchema>;
export type EstimateLineItem = typeof estimateLineItems.$inferSelect;

export const rfqLog = pgTable("rfq_log", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  scopeId: varchar("scope_id", { length: 50 }).notNull(),
  scopeLabel: varchar("scope_label", { length: 200 }).notNull(),
  manufacturerName: varchar("manufacturer_name", { length: 300 }).notNull(),
  projectName: varchar("project_name", { length: 500 }).notNull(),
  sentBy: varchar("sent_by", { length: 200 }).notNull(),
  userId: integer("user_id"),
  action: varchar("action", { length: 20 }).notNull(),
  recipientEmails: text("recipient_emails").array().notNull().default(sql`ARRAY[]::text[]`),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});
export const insertRfqLogSchema = createInsertSchema(rfqLog).omit({ id: true, sentAt: true });
export type InsertRfqLog = z.infer<typeof insertRfqLogSchema>;
export type RfqLog = typeof rfqLog.$inferSelect;

export const estimateSpecSections = pgTable("estimate_spec_sections", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  scopeId: text("scope_id").notNull(),
  csiCode: text("csi_code"),
  specSectionNumber: text("spec_section_number"),
  specSectionTitle: text("spec_section_title"),
  content: text("content"),
  manufacturers: jsonb("manufacturers").$type<string[]>().default([]),
  keyRequirements: jsonb("key_requirements").$type<string[]>().default([]),
  substitutionPolicy: text("substitution_policy"),
  sourcePages: text("source_pages"),
  extractionConfidence: integer("extraction_confidence").default(80),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEstimateSpecSectionSchema = createInsertSchema(estimateSpecSections).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEstimateSpecSection = z.infer<typeof insertEstimateSpecSectionSchema>;
export type EstimateSpecSection = typeof estimateSpecSections.$inferSelect;

// Approved manufacturers per (estimate, scope)
export const estimateScopeManufacturers = pgTable("estimate_scope_manufacturers", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  scopeId: text("scope_id").notNull(),
  manufacturerId: integer("manufacturer_id").notNull().references(() => mfrManufacturers.id, { onDelete: "cascade" }),
  isBasisOfDesign: boolean("is_basis_of_design").notNull().default(false),
  notes: text("notes"),
  addedByUserId: integer("added_by_user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  uniqueScopeMfr: unique().on(table.estimateId, table.scopeId, table.manufacturerId),
}));

export const insertEstimateScopeManufacturerSchema = createInsertSchema(estimateScopeManufacturers).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEstimateScopeManufacturer = z.infer<typeof insertEstimateScopeManufacturerSchema>;
export type EstimateScopeManufacturer = typeof estimateScopeManufacturers.$inferSelect;

const quoteByteaType = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

export const estimateQuotes = pgTable("estimate_quotes", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  category: varchar("category", { length: 50 }).notNull(),
  vendor: varchar("vendor", { length: 100 }).notNull(),
  note: text("note"),
  freight: numeric("freight", { precision: 10, scale: 2 }).default("0"),
  taxIncluded: boolean("tax_included").default(false),
  pricingMode: varchar("pricing_mode", { length: 20 }).default("per_item"),
  lumpSumTotal: numeric("lump_sum_total", { precision: 10, scale: 2 }).default("0"),
  breakoutGroupId: integer("breakout_group_id"),
  materialTotalCost: numeric("material_total_cost", { precision: 12, scale: 2 }),
  hasBackup: boolean("has_backup").default(false),
  filePath: varchar("file_path", { length: 500 }),
  backupFileData: quoteByteaType("backup_file_data"),
  backupMimeType: varchar("backup_mime_type", { length: 100 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  status: varchar("status", { length: 30 }),
  latestExtractionJson: jsonb("latest_extraction_json"),
  latestError: text("latest_error"),
  processingMetadataJson: jsonb("processing_metadata_json"),
  // Optional FK back to the RFQ log entry this quote responds to.
  // Nullable: walk-in / cold quotes have no originating RFQ. Used by the
  // RFQ Log "Quote received" indicator to tie a quote to a specific
  // (manufacturer, vendor-recipient) RFQ row instead of name-matching.
  rfqLogId: integer("rfq_log_id"),
});

export const insertEstimateQuoteSchema = createInsertSchema(estimateQuotes).omit({ id: true, createdAt: true });
export type InsertEstimateQuote = z.infer<typeof insertEstimateQuoteSchema>;
export type EstimateQuote = typeof estimateQuotes.$inferSelect;

export const vendorQuoteLineItems = pgTable("vendor_quote_line_items", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").notNull(),
  sortOrder: integer("sort_order").default(0),
  description: text("description"),
  partNumber: varchar("part_number", { length: 200 }),
  qty: numeric("qty", { precision: 10, scale: 2 }),
  unit: varchar("unit", { length: 30 }),
  unitCost: numeric("unit_cost", { precision: 12, scale: 2 }),
  extendedCost: numeric("extended_cost", { precision: 12, scale: 2 }),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  notes: text("notes"),
  isApproved: boolean("is_approved").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type VendorQuoteLineItem = typeof vendorQuoteLineItems.$inferSelect;

export const vendorQuoteToEstimateLineItemMap = pgTable("vendor_quote_to_estimate_line_item_map", {
  id: serial("id").primaryKey(),
  quoteId: integer("quote_id").notNull(),
  vendorQuoteLineItemId: integer("vendor_quote_line_item_id").notNull(),
  estimateLineItemId: integer("estimate_line_item_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const estimateBreakoutGroups = pgTable("estimate_breakout_groups", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  code: varchar("code", { length: 20 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  type: varchar("type", { length: 30 }).default("building"),
  ohOverride: numeric("oh_override", { precision: 5, scale: 2 }),
  feeOverride: numeric("fee_override", { precision: 5, scale: 2 }),
  escOverride: numeric("esc_override", { precision: 5, scale: 2 }),
  freightMethod: varchar("freight_method", { length: 20 }).default("proportional"),
  manualFreight: numeric("manual_freight", { precision: 10, scale: 2 }),
  sortOrder: integer("sort_order").default(0),
});

export const insertEstimateBreakoutGroupSchema = createInsertSchema(estimateBreakoutGroups).omit({ id: true });
export type InsertEstimateBreakoutGroup = z.infer<typeof insertEstimateBreakoutGroupSchema>;
export type EstimateBreakoutGroup = typeof estimateBreakoutGroups.$inferSelect;

export const estimateBreakoutAllocations = pgTable("estimate_breakout_allocations", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  lineItemId: integer("line_item_id").notNull(),
  breakoutGroupId: integer("breakout_group_id").notNull(),
  qty: integer("qty").default(0).notNull(),
});

export const insertEstimateBreakoutAllocationSchema = createInsertSchema(estimateBreakoutAllocations).omit({ id: true });
export type InsertEstimateBreakoutAllocation = z.infer<typeof insertEstimateBreakoutAllocationSchema>;
export type EstimateBreakoutAllocation = typeof estimateBreakoutAllocations.$inferSelect;

export const estimateVersions = pgTable("estimate_versions", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  version: integer("version").notNull(),
  savedBy: varchar("saved_by", { length: 100 }),
  notes: text("notes"),
  grandTotal: numeric("grand_total", { precision: 12, scale: 2 }).default("0"),
  snapshotData: jsonb("snapshot_data"),
  savedAt: timestamp("saved_at").notNull().defaultNow(),
});

export const insertEstimateVersionSchema = createInsertSchema(estimateVersions).omit({ id: true, savedAt: true });
export type InsertEstimateVersion = z.infer<typeof insertEstimateVersionSchema>;
export type EstimateVersion = typeof estimateVersions.$inferSelect;

export const estimateReviewComments = pgTable("estimate_review_comments", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  author: varchar("author", { length: 100 }).notNull(),
  comment: text("comment").notNull(),
  resolved: boolean("resolved").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEstimateReviewCommentSchema = createInsertSchema(estimateReviewComments).omit({ id: true, createdAt: true });
export type InsertEstimateReviewComment = z.infer<typeof insertEstimateReviewCommentSchema>;
export type EstimateReviewComment = typeof estimateReviewComments.$inferSelect;

export const ohApprovalLog = pgTable("oh_approval_log", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  catId: varchar("cat_id", { length: 50 }).notNull(),
  catLabel: varchar("cat_label", { length: 100 }),
  oldRate: numeric("old_rate", { precision: 5, scale: 2 }),
  newRate: numeric("new_rate", { precision: 5, scale: 2 }),
  requestedBy: varchar("requested_by", { length: 100 }),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
  approvedBy: varchar("approved_by", { length: 100 }),
  approvedAt: timestamp("approved_at"),
  status: varchar("status", { length: 20 }).default("pending"),
  type: varchar("type", { length: 20 }).default("oh"),
});

export const insertOhApprovalLogSchema = createInsertSchema(ohApprovalLog).omit({ id: true, requestedAt: true });
export type InsertOhApprovalLog = z.infer<typeof insertOhApprovalLogSchema>;
export type OhApprovalLog = typeof ohApprovalLog.$inferSelect;

// Estimator engagement analytics. Each row is a contiguous interval the user
// was actively interacting with the Estimating Module on a given estimate at
// a given stage (and optional scope). Idle time and background-tab time are
// excluded by the client-side tracker before flushing.
export const estimateActivityEvents = pgTable("estimate_activity_events", {
  id: serial("id").primaryKey(),
  estimateId: integer("estimate_id").notNull(),
  userId: integer("user_id").notNull(),
  stage: varchar("stage", { length: 30 }).notNull(),
  scope: varchar("scope", { length: 50 }),
  startedAt: timestamp("started_at").notNull(),
  endedAt: timestamp("ended_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertEstimateActivityEventSchema = createInsertSchema(estimateActivityEvents).omit({ id: true, createdAt: true });
export type InsertEstimateActivityEvent = z.infer<typeof insertEstimateActivityEventSchema>;
export type EstimateActivityEvent = typeof estimateActivityEvents.$inferSelect;

// === Admin Dashboard / Support Chatbot tables ===
// New tables use UUID primary keys (varchar with gen_random_uuid default).
// Foreign keys to users.id remain integer to match existing serial PK.

// Feedback submissions (bug/suggestion/question/other) — populated via chatbot
export const feedbackSubmissions = pgTable("feedback_submissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: integer("user_id").notNull().references(() => users.id),
  userEmail: text("user_email").notNull(),
  submissionType: text("submission_type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  conversationLog: jsonb("conversation_log").$type<Array<{ role: string; content: string; timestamp: string }>>().default([]),
  pageUrl: text("page_url"),
  status: text("status").notNull().default("new"),
  priority: text("priority").notNull().default("medium"),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});
export const insertFeedbackSubmissionSchema = createInsertSchema(feedbackSubmissions).omit({ id: true, createdAt: true, updatedAt: true, resolvedAt: true });
export type InsertFeedbackSubmission = z.infer<typeof insertFeedbackSubmissionSchema>;
export type FeedbackSubmission = typeof feedbackSubmissions.$inferSelect;

// Chat sessions — one per user-initiated chatbot conversation
export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: integer("user_id").notNull().references(() => users.id),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  messages: jsonb("messages").$type<Array<{ role: string; content: string; timestamp: string }>>().default([]),
  resultedInSubmissionId: varchar("resulted_in_submission_id").references(() => feedbackSubmissions.id),
  topicCategory: text("topic_category"),
});
export const insertChatSessionSchema = createInsertSchema(chatSessions).omit({ id: true, startedAt: true });
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;
export type ChatSession = typeof chatSessions.$inferSelect;

// Screenshots attached to chat sessions (and optionally finalized submissions)
export const feedbackScreenshots = pgTable("feedback_screenshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  submissionId: varchar("submission_id").references(() => feedbackSubmissions.id),
  sessionId: varchar("session_id").notNull().references(() => chatSessions.id),
  fileData: screenshotBytea("file_data").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export const insertFeedbackScreenshotSchema = createInsertSchema(feedbackScreenshots).omit({ id: true, createdAt: true });
export type InsertFeedbackScreenshot = z.infer<typeof insertFeedbackScreenshotSchema>;
export type FeedbackScreenshot = typeof feedbackScreenshots.$inferSelect;

// System errors — auto-captured by global error middleware + frontend reporter
export const systemErrors = pgTable("system_errors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  errorType: text("error_type").notNull(),
  errorMessage: text("error_message").notNull(),
  stackTrace: text("stack_trace"),
  endpoint: text("endpoint"),
  userId: integer("user_id").references(() => users.id),
  pageUrl: text("page_url"),
  metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  occurrenceCount: integer("occurrence_count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  status: text("status").notNull().default("new"),
  priority: text("priority").notNull().default("medium"),
  adminNotes: text("admin_notes"),
});
export const insertSystemErrorSchema = createInsertSchema(systemErrors).omit({ id: true, firstSeenAt: true, lastSeenAt: true, occurrenceCount: true });
export type InsertSystemError = z.infer<typeof insertSystemErrorSchema>;
export type SystemError = typeof systemErrors.$inferSelect;

export const portfolioVisits = pgTable("portfolio_visits", {
  id: serial("id").primaryKey(),
  visitedAt: timestamp("visited_at").notNull().defaultNow(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  referer: text("referer"),
  acceptLanguage: text("accept_language"),
  path: text("path"),
});
export type PortfolioVisit = typeof portfolioVisits.$inferSelect;

export const quoteParserFeedback = pgTable("quote_parser_feedback", {
  id: serial("id").primaryKey(),
  vendorName: text("vendor_name"),
  quoteNumber: text("quote_number"),
  issueDescription: text("issue_description").notNull(),
  rawTextSnippet: text("raw_text_snippet"),
  status: varchar("status", { length: 20 }).notNull().default("open"), // open | reviewed | applied
  createdAt: timestamp("created_at").notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at"),
  appliedNote: text("applied_note"),
});
export type QuoteParserFeedback = typeof quoteParserFeedback.$inferSelect;

export const taxRates = pgTable("tax_rates", {
  id: serial("id").primaryKey(),
  zipCode: varchar("zip_code", { length: 10 }).notNull(),
  state: text("state"),
  county: text("county"),
  city: text("city"),
  totalUseTax: numeric("total_use_tax", { precision: 10, scale: 4 }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
}, (table) => ({
  zipIdx: index("idx_tax_rates_zip").on(table.zipCode),
}));
export type TaxRate = typeof taxRates.$inferSelect;
// =====================================================
// BUYOUT BOT MODULE
// =====================================================
// A buyout project = one dropped NBS estimate workbook. The full trackable
// board (scopes / line items / quotes / awards) is stored as a single JSONB
// document (`boardData`) so auto-save is one PATCH and resume is one GET.
// Header columns are cached for the project-log list view.

export const buyoutProjects = pgTable("buyout_projects", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 500 }).notNull(), // derived from the file name
  sourceFilename: varchar("source_filename", { length: 500 }),
  // Optional link to an AiPM project / estimate so buyout ties to the real job.
  projectId: integer("project_id"),
  estimateId: integer("estimate_id"),
  // Cached list-view fields (kept in sync on save; board is source of truth).
  status: varchar("status", { length: 20 }).notNull().default("in_progress"), // in_progress | complete
  scopeCount: integer("scope_count").notNull().default(0),
  boughtOutCount: integer("bought_out_count").notNull().default(0),
  budgetTotal: numeric("budget_total", { precision: 14, scale: 2 }).notNull().default("0"),
  awardedTotal: numeric("awarded_total", { precision: 14, scale: 2 }).notNull().default("0"),
  // Budget of only the awarded scopes — savings/variance compare against this.
  awardedBudget: numeric("awarded_budget", { precision: 14, scale: 2 }).notNull().default("0"),
  // The whole board document.
  boardData: jsonb("board_data").$type<BuyoutBoard>().notNull(),
  isTest: boolean("is_test").default(false).notNull(),
  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type BuyoutProject = typeof buyoutProjects.$inferSelect;
export type InsertBuyoutProject = typeof buyoutProjects.$inferInsert;
export const insertBuyoutProjectSchema = createInsertSchema(buyoutProjects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBuyoutProjectInput = z.infer<typeof insertBuyoutProjectSchema>;
