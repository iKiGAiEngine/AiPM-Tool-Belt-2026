import { db } from "./db";
import { regions, scopeDictionaries, vendors, div10Products } from "@shared/schema";
import { count, sql } from "drizzle-orm";

async function ensureUserAuthColumns(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'invited'`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP`);
    // Enforce valid status values at DB level
    await db.execute(sql`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'users' AND constraint_name = 'users_status_check'
        ) THEN
          ALTER TABLE users ADD CONSTRAINT users_status_check
            CHECK (status IN ('invited', 'active', 'inactive'));
        END IF;
      END $$
    `);
    // Back-fill: active users created before the status column existed get status='active'
    // (Deactivated users without a reset_token are old accounts — mark them inactive)
    await db.execute(sql`UPDATE users SET status = 'active' WHERE is_active = true AND status = 'invited' AND reset_token IS NULL`);
    await db.execute(sql`UPDATE users SET status = 'inactive' WHERE is_active = false AND status = 'invited' AND reset_token IS NULL`);
  } catch (e: any) {
    console.log("[Migration] user auth columns check:", e.message);
  }
}

async function ensureRegionAliasesColumn(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE regions ADD COLUMN IF NOT EXISTS aliases text[]`);
    await db.execute(sql`ALTER TABLE regions ADD COLUMN IF NOT EXISTS self_perform_estimators text[]`);
    await db.execute(sql`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='regions' AND column_name='self_perform_estimator') THEN UPDATE regions SET self_perform_estimators = ARRAY[self_perform_estimator] WHERE self_perform_estimator IS NOT NULL AND self_perform_estimator != '' AND self_perform_estimators IS NULL; ALTER TABLE regions DROP COLUMN self_perform_estimator; END IF; END $$`);
  } catch (e: any) {
    console.log("[Migration] aliases column check:", e.message);
  }
}

async function ensureProposalChangeLogTable(): Promise<void> {
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS proposal_change_log (
      id SERIAL PRIMARY KEY,
      entry_id INTEGER NOT NULL REFERENCES proposal_log_entries(id),
      field_name VARCHAR(100) NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by VARCHAR(200),
      changed_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`);
  } catch (e: any) {
    console.log("[Migration] proposal_change_log table check:", e.message);
  }
}

async function ensureProposalLogExtraColumns(): Promise<void> {
  try {
    await db.execute(sql`ALTER TABLE proposal_log_entries ADD COLUMN IF NOT EXISTS final_reviewer varchar(200)`);
    await db.execute(sql`ALTER TABLE proposal_log_entries ADD COLUMN IF NOT EXISTS swinerton_project varchar(10)`);
    // Types & Quantities receipt tracking — added on boot so a deploy that
    // hasn't run `npm run db:push` still starts cleanly.
    await db.execute(sql`ALTER TABLE proposal_log_entries ADD COLUMN IF NOT EXISTS tq_received_date varchar(20)`);
    await db.execute(sql`ALTER TABLE proposal_log_entries ADD COLUMN IF NOT EXISTS tq_received_by varchar(200)`);
    await db.execute(sql`ALTER TABLE proposal_log_entries ADD COLUMN IF NOT EXISTS tq_received_at timestamp`);
  } catch (e: any) {
    console.log("[Migration] proposal log extra columns check:", e.message);
  }
}

export async function seedDefaultData(): Promise<void> {
  try {
    await ensureUserAuthColumns();
    await ensureRegionAliasesColumn();
    await ensureProposalLogExtraColumns();
    await ensureProposalChangeLogTable();
    const [regionCount] = await db.select({ value: count() }).from(regions);
    if (regionCount.value === 0) {
      const defaultRegions = [
        { code: "ATL", name: "Atlanta" },
        { code: "AUS", name: "Austin" },
        { code: "CLT", name: "N Carolina" },
        { code: "CLT", name: "S Carolina" },
        { code: "DEN", name: "Colorado" },
        { code: "DFW", name: "Dallas" },
        { code: "EXT", name: "BN Builders" },
        { code: "EXT", name: "Bristol Industries" },
        { code: "EXT", name: "CBU" },
        { code: "EXT", name: "Hensel Phelps" },
        { code: "EXT", name: "Jacobs" },
        { code: "EXT", name: "McCarthy" },
        { code: "EXT", name: "PCL" },
        { code: "GEG", name: "Spokane & Boise" },
        { code: "HNL", name: "Hawaii" },
        { code: "LAX", name: "FS" },
        { code: "LAX", name: "OCLA" },
        { code: "LAX", name: "SPD" },
        { code: "LAX", name: "TM" },
        { code: "LGA", name: "New York" },
        { code: "PDX", name: "Idaho" },
        { code: "PDX", name: "Portland" },
        { code: "SAN", name: "SD" },
        { code: "SEA", name: "Washington" },
        { code: "SFO", name: "Nor Cal" },
      ];
      await db.insert(regions).values(defaultRegions);
      console.log(`Seeded ${defaultRegions.length} default regions`);
    }

    const [scopeCount] = await db.select({ value: count() }).from(scopeDictionaries);
    if (scopeCount.value === 0) {
      const defaultScopes = [
        {
          scopeName: "Toilet Accessories",
          includeKeywords: ["toilet accessories", "bath accessories", "restroom accessories", "grab bar", "soap dispenser", "paper towel", "hand dryer", "mirror", "toilet paper holder", "sanitary napkin", "waste receptacle", "seat cover dispenser", "robe hook", "towel bar", "shower rod", "baby changing", "diaper station", "10 28", "102800"],
          boostPhrases: ["toilet accessory schedule", "restroom accessory", "bath accessory"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 28", "102800"],
        },
        {
          scopeName: "Toilet Partitions",
          includeKeywords: ["toilet partition", "toilet compartment", "restroom partition", "bathroom partition", "urinal screen", "privacy screen", "phenolic partition", "solid plastic partition", "stainless steel partition", "powder coated partition", "overhead braced", "floor mounted", "ceiling hung", "10 21", "102113", "102100"],
          boostPhrases: ["partition schedule", "toilet compartment detail", "enlarged restroom plan"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 21", "102113", "102100"],
        },
        {
          scopeName: "Wall Protection",
          includeKeywords: ["wall protection", "corner guard", "crash rail", "handrail", "bumper guard", "wall guard", "chair rail", "door frame protector", "impact protection", "surface protection", "finish protection", "10 26", "102600"],
          boostPhrases: ["wall protection schedule", "corner guard detail"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 26", "102600"],
        },
        {
          scopeName: "Fire Extinguisher Cabinets",
          includeKeywords: ["fire extinguisher", "fire cabinet", "extinguisher cabinet", "fec", "fire protection cabinet", "fire suppression", "abc extinguisher", "fire hose cabinet", "10 44", "104413", "104416"],
          boostPhrases: ["fire extinguisher schedule", "fec location", "fire cabinet detail"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 44", "104413", "104416"],
        },
        {
          scopeName: "Cubicle Curtains",
          includeKeywords: ["cubicle curtain", "cubicle track", "privacy curtain", "hospital curtain", "exam curtain", "curtain track", "ceiling track", "mesh curtain", "anti-microbial curtain", "10 21 23", "102123"],
          boostPhrases: ["cubicle curtain schedule", "curtain track layout"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 21 23", "102123"],
        },
        {
          scopeName: "Visual Display",
          includeKeywords: ["markerboard", "whiteboard", "tackboard", "bulletin board", "display case", "trophy case", "projection screen", "chalkboard", "visual display", "writing surface", "display board", "cork board", "fabric board", "10 11", "101100"],
          boostPhrases: ["visual display schedule", "markerboard detail", "tackboard schedule"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 11", "101100"],
        },
        {
          scopeName: "Lockers",
          includeKeywords: ["locker", "metal locker", "wood locker", "plastic locker", "athletic locker", "gym locker", "employee locker", "storage locker", "locker room", "locker bench", "10 51", "105100", "105113"],
          boostPhrases: ["locker schedule", "locker room plan", "locker detail"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 51", "105100", "105113"],
        },
        {
          scopeName: "Shelving",
          includeKeywords: ["shelving", "wire shelving", "closet shelving", "adjustable shelving", "metal shelving", "storage shelving", "shelf bracket", "shelf standard", "10 56", "105600"],
          boostPhrases: ["shelving schedule", "shelf detail"],
          excludeKeywords: [] as string[],
          weight: 100,
          specSectionNumbers: ["10 56", "105600"],
        },
        {
          scopeName: "Other Div10",
          includeKeywords: ["division 10", "div 10", "specialties", "toilet specialties", "building specialties", "owner furnished", "install by others", "postal specialties", "telephone enclosure", "wardrobe", "protective cover", "entrance mat", "flagpole"],
          boostPhrases: ["division 10 schedule", "specialty schedule"],
          excludeKeywords: [] as string[],
          weight: 80,
          specSectionNumbers: [] as string[],
        },
      ];
      await db.insert(scopeDictionaries).values(defaultScopes);
      console.log(`Seeded ${defaultScopes.length} default scope dictionaries`);
    }

    const [vendorCount] = await db.select({ value: count() }).from(vendors);
    if (vendorCount.value === 0) {
      const defaultVendors = [
        { name: "Activar" },
        { name: "JL Industries" },
        { name: "Larsen's" },
        { name: "Potter Roemer" },
        { name: "Fire End & Croker" },
        { name: "Modern Metal" },
      ];
      await db.insert(vendors).values(defaultVendors);
      console.log(`Seeded ${defaultVendors.length} default vendors`);
    }

    const [productCount] = await db.select({ value: count() }).from(div10Products);
    if (productCount.value === 0) {
      const defaultProducts = [
        { modelNumber: "FEA445454", description: "FIRE EXT, RED LINE, CARTRIDGE OPERATED, 17LB", manufacturer: "Ansul", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Cosmic 2-½ E", description: "Multi-Purpose ABC Dry Chemical, 2.5lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Cosmic 5E", description: "Multi-Purpose ABC Dry Chemical, 5lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Cosmic 5X", description: "Multi-Purpose ABC Dry Chemical, 5lb (High Performance)", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Cosmic 6E", description: "Multi-Purpose ABC Dry Chemical, 6lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Cosmic 10E", description: "Multi-Purpose ABC Dry Chemical, 10lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Cosmic 20E", description: "Multi-Purpose ABC Dry Chemical, 20lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Sentinel 5", description: "Carbon Dioxide (CO2), 5lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Sentinel 10", description: "Carbon Dioxide (CO2), 10lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Sentinel 15", description: "Carbon Dioxide (CO2), 15lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Sentinel 20", description: "Carbon Dioxide (CO2), 20lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Galaxy 5", description: "Regular Dry Chemical, 5lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Galaxy 10", description: "Regular Dry Chemical, 10lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Galaxy 20", description: "Regular Dry Chemical, 20lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Mercury 5", description: "Halotron Clean Agent, 5lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Mercury 11", description: "Halotron Clean Agent, 11lb", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "Grenadier P", description: "Pressurized Water, 2.5gal", manufacturer: "JL Industries", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "MP 2-½", description: "Multi-Purpose ABC Dry Chemical, 2.5lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "MP5", description: "Multi-Purpose ABC Dry Chemical, 5lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "MP6", description: "Multi-Purpose ABC Dry Chemical, 6lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "MP10", description: "Multi-Purpose ABC Dry Chemical, 10lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "MP20", description: "Multi-Purpose ABC Dry Chemical, 20lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "CD5", description: "Carbon Dioxide (CO2), 5lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "CD10", description: "Carbon Dioxide (CO2), 10lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "CD15", description: "Carbon Dioxide (CO2), 15lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "CD20", description: "Carbon Dioxide (CO2), 20lb", manufacturer: "Larsen's", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3002", description: "Multi-Purpose ABC Dry Chemical, 2.5lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3005", description: "Multi-Purpose ABC Dry Chemical, 5lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3006", description: "Multi-Purpose ABC Dry Chemical, 6lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3010", description: "Multi-Purpose ABC Dry Chemical, 10lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3020", description: "Multi-Purpose ABC Dry Chemical, 20lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3405", description: "Carbon Dioxide (CO2), 5lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "3410", description: "Carbon Dioxide (CO2), 10lb", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguishers" },
        { modelNumber: "8115", description: "Ambassador Series, Steel, Flat Trim, Semi-Recessed, 10lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "8117", description: 'Ambassador Series, Steel, 2.5" Rolled Trim, Semi-Recessed, 10lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "8113", description: "Ambassador Series, Steel, Surface Mount, 10lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1015", description: "Ambassador Series, Steel, Flat Trim, Recessed, 10lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1017", description: 'Ambassador Series, Steel, 3" Rolled Trim, Recessed, 10lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1013", description: "Ambassador Series, Steel, Surface Mount, 10lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2015", description: "Ambassador Series, Steel, Flat Trim, Recessed, 20lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2017", description: 'Ambassador Series, Steel, 2.5" Rolled Trim, Recessed, 20lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2037", description: 'Ambassador Series, Steel, 2.5" Rolled Trim, Recessed, 20lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2013", description: "Ambassador Series, Steel, Surface Mount, 20lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1025", description: "Academy Series, Aluminum, Flat Trim, Recessed, 10lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1027", description: 'Academy Series, Aluminum, 3" Rolled Trim, Recessed, 10lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2025", description: "Academy Series, Aluminum, Flat Trim, Recessed, 20lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2027", description: 'Academy Series, Aluminum, 2.5" Rolled Trim, Recessed, 20lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1035", description: "Cosmopolitan Series, Stainless Steel, Flat Trim, Recessed, 10lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "1037", description: 'Cosmopolitan Series, Stainless Steel, 3" Rolled Trim, Recessed, 10lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2035", description: "Cosmopolitan Series, Stainless Steel, Flat Trim, Recessed, 20lb Cap", manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2037SS", description: 'Cosmopolitan Series, Stainless Steel, 2.5" Rolled Trim, Recessed, 20lb Cap', manufacturer: "JL Industries", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2409-R1", description: "Standard Cabinet, Flat Trim, Recessed, 10lb Cap", manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2409-R2", description: "Standard Cabinet, Flat Trim, Recessed, 10lb Cap", manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2409-5R", description: 'Standard Cabinet, 1.5" Square Trim, Recessed, 10lb Cap', manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2409-6R", description: 'Standard Cabinet, 3" Rolled Trim, Recessed, 10lb Cap', manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2409-SM", description: "Standard Cabinet, Surface Mount, 10lb Cap", manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2712-R", description: "Standard Cabinet, Flat Trim, Recessed, 20lb Cap", manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2712-RL", description: 'Standard Cabinet, 2.5" Rolled Trim, Recessed, 20lb Cap', manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "2712-SM", description: "Standard Cabinet, Surface Mount, 20lb Cap", manufacturer: "Larsen's", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7007", description: "Alta Series, Steel, Flat Trim, Semi-Recessed, 10lb Cap", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7008-RR", description: 'Alta Series, Steel, 2.5" Rolled Trim, Semi-Recessed, 10lb Cap', manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7009", description: "Alta Series, Steel, Surface Mount, 10lb Cap", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7020", description: "Alta Series, Steel, Flat Trim, Recessed, 10lb Cap", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7023-RR", description: 'Alta Series, Steel, 3" Rolled Trim, Recessed, 10lb Cap', manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7024", description: "Alta Series, Steel, Surface Mount, 10lb Cap", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7025", description: "Alta Series, Steel, Flat Trim, Recessed, 20lb Cap", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7027-RR", description: 'Alta Series, Steel, 2.5" Rolled Trim, Recessed, 20lb Cap', manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
        { modelNumber: "7029", description: "Alta Series, Steel, Surface Mount, 20lb Cap", manufacturer: "Potter Roemer", scopeCategory: "Fire Extinguisher Cabinets" },
      ];
      await db.insert(div10Products).values(defaultProducts);
      console.log(`Seeded ${defaultProducts.length} default div10 products`);
    }
  } catch (error) {
    console.error("Error seeding default data:", error);
  }
}
