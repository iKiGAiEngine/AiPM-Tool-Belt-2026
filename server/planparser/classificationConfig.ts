import type { PlanParserScope, ScopeDictionary } from "@shared/schema";
import { getAllScopeDictionaries } from "../scopeDictionaryStorage";

export interface ScopeConfig {
  name: PlanParserScope;
  includeKeywords: string[];
  boostPhrases: string[];
  weight: number;
}

export interface ClassificationConfig {
  scopes: ScopeConfig[];
  signageExclusionKeywords: string[];
  signageOverrideThreshold: number;
  millworkExclusionKeywords: string[];
  scheduleBoostMultiplier: number;
  minConfidenceThreshold: number;
}

export const DEFAULT_CLASSIFICATION_CONFIG: ClassificationConfig = {
  scopes: [
    {
      name: "Toilet Accessories",
      includeKeywords: [
        "toilet accessories", "bath accessories", "restroom accessories",
        "grab bar", "soap dispenser", "paper towel", "hand dryer",
        "mirror", "toilet paper holder", "sanitary napkin", "waste receptacle",
        "seat cover dispenser", "robe hook", "towel bar", "shower rod",
        "baby changing", "diaper station", "10 28", "102800"
      ],
      boostPhrases: ["toilet accessory schedule", "restroom accessory", "bath accessory"],
      weight: 1.0
    },
    {
      name: "Toilet Partitions",
      includeKeywords: [
        "toilet partition", "toilet compartment", "restroom partition",
        "bathroom partition", "urinal screen", "privacy screen",
        "phenolic partition", "solid plastic partition", "stainless steel partition",
        "powder coated partition", "overhead braced", "floor mounted",
        "ceiling hung", "10 21", "102113", "102100"
      ],
      boostPhrases: ["partition schedule", "toilet compartment detail", "enlarged restroom plan"],
      weight: 1.0
    },
    {
      name: "Wall Protection",
      includeKeywords: [
        "wall protection", "corner guard", "crash rail", "handrail",
        "bumper guard", "wall guard", "chair rail", "door frame protector",
        "impact protection", "surface protection", "finish protection",
        "10 26", "102600"
      ],
      boostPhrases: ["wall protection schedule", "corner guard detail"],
      weight: 1.0
    },
    {
      name: "Fire Extinguisher Cabinets",
      includeKeywords: [
        "fire extinguisher", "fire cabinet", "extinguisher cabinet",
        "fec", "fire protection cabinet", "fire suppression",
        "abc extinguisher", "fire hose cabinet", "10 44", "104413", "104416"
      ],
      boostPhrases: ["fire extinguisher schedule", "fec location", "fire cabinet detail"],
      weight: 1.0
    },
    {
      name: "Cubicle Curtains",
      includeKeywords: [
        "cubicle curtain", "cubicle track", "privacy curtain",
        "hospital curtain", "exam curtain", "curtain track",
        "ceiling track", "mesh curtain", "anti-microbial curtain",
        "10 21 23", "102123"
      ],
      boostPhrases: ["cubicle curtain schedule", "curtain track layout"],
      weight: 1.0
    },
    {
      name: "Visual Display",
      includeKeywords: [
        "markerboard", "whiteboard", "tackboard", "bulletin board",
        "display case", "trophy case", "projection screen",
        "chalkboard", "visual display", "writing surface",
        "display board", "cork board", "fabric board",
        "10 11", "101100"
      ],
      boostPhrases: ["visual display schedule", "markerboard detail", "tackboard schedule"],
      weight: 1.0
    },
    {
      name: "Lockers",
      includeKeywords: [
        "locker", "metal locker", "wood locker", "plastic locker",
        "athletic locker", "gym locker", "employee locker",
        "storage locker", "locker room", "locker bench",
        "10 51", "105100", "105113"
      ],
      boostPhrases: ["locker schedule", "locker room plan", "locker detail"],
      weight: 1.0
    },
    {
      name: "Shelving",
      includeKeywords: [
        "shelving", "wire shelving", "closet shelving", "adjustable shelving",
        "metal shelving", "storage shelving", "shelf bracket", "shelf standard",
        "10 56", "105600"
      ],
      boostPhrases: ["shelving schedule", "shelf detail"],
      weight: 1.0
    },
    {
      name: "Other Div10",
      includeKeywords: [
        "division 10", "div 10", "specialties", "toilet specialties",
        "building specialties", "owner furnished", "install by others",
        "postal specialties", "telephone enclosure", "wardrobe",
        "protective cover", "entrance mat", "flagpole"
      ],
      boostPhrases: ["division 10 schedule", "specialty schedule"],
      weight: 0.8
    }
  ],
  signageExclusionKeywords: [
    "signage", "sign schedule", "room sign", "door sign",
    "wayfinding", "directional sign", "ada sign", "braille sign",
    "room number", "room identification", "sign type",
    "exterior signage", "interior signage", "monument sign",
    "10 14", "101400", "signage specification"
  ],
  signageOverrideThreshold: 0.6,
  millworkExclusionKeywords: [
    "millwork", "casework", "cabinet", "countertop", "woodwork",
    "custom cabinet", "built-in cabinet", "reception desk",
    "nurse station", "millwork schedule", "casework schedule",
    "wood veneer", "plastic laminate cabinet", "upper cabinet", "base cabinet"
  ],
  scheduleBoostMultiplier: 1.5,
  minConfidenceThreshold: 25
};

export interface SpecBoostData {
  scopeType: string;
  manufacturers: string[];
  modelNumbers: string[];
  materials: string[];
  specSectionNumber: string | null;
}

export function mergeSpecBoostIntoConfig(
  baseConfig: ClassificationConfig,
  specBoosts: SpecBoostData[]
): ClassificationConfig {
  const boostedScopes = baseConfig.scopes.map(scope => {
    const matchingBoosts = specBoosts.filter(boost => {
      const normalizedBoostType = boost.scopeType.toLowerCase().trim();
      const normalizedScopeName = scope.name.toLowerCase().trim();
      return normalizedBoostType.includes(normalizedScopeName) ||
        normalizedScopeName.includes(normalizedBoostType) ||
        (boost.specSectionNumber && scope.includeKeywords.some(kw =>
          kw.replace(/\s/g, '').includes(boost.specSectionNumber!.replace(/\s/g, ''))
        ));
    });

    if (matchingBoosts.length === 0) return scope;

    const extraKeywords: string[] = [];
    const extraBoostPhrases: string[] = [];

    for (const boost of matchingBoosts) {
      for (const mfr of boost.manufacturers) {
        if (mfr.length >= 3) {
          extraKeywords.push(mfr.toLowerCase());
          extraBoostPhrases.push(mfr.toLowerCase());
        }
      }
      for (const model of boost.modelNumbers) {
        if (model.length >= 3) {
          extraKeywords.push(model.toLowerCase());
        }
      }
      for (const mat of boost.materials) {
        if (mat.length >= 3) {
          extraKeywords.push(mat.toLowerCase());
        }
      }
    }

    const dedupedKeywords = Array.from(new Set([...scope.includeKeywords, ...extraKeywords]));
    const dedupedBoosts = Array.from(new Set([...scope.boostPhrases, ...extraBoostPhrases]));

    return {
      ...scope,
      includeKeywords: dedupedKeywords,
      boostPhrases: dedupedBoosts,
      weight: scope.weight * 1.2,
    };
  });

  return {
    ...baseConfig,
    scopes: boostedScopes,
  };
}

export async function getClassificationConfigFromDB(): Promise<ClassificationConfig> {
  try {
    const dictionaries = await getAllScopeDictionaries();
    const activeDicts = dictionaries.filter(d => d.isActive);

    if (activeDicts.length === 0) {
      return DEFAULT_CLASSIFICATION_CONFIG;
    }

    // Merge DB rows onto the full default scope set rather than replacing it
    // wholesale. Central Settings lets admins create/edit dictionaries one
    // scope at a time — if even one active row exists, a naive replace would
    // silently zero out keyword coverage for every OTHER scope that has no
    // DB row yet, making them permanently unmatchable regardless of PDF
    // content. Any scope with a DB row uses the DB version (customization
    // still works); any scope without one keeps its default keywords.
    const scopeMap = new Map<string, ScopeConfig>(
      DEFAULT_CLASSIFICATION_CONFIG.scopes.map((s) => [s.name, s]),
    );
    for (const dict of activeDicts) {
      scopeMap.set(dict.scopeName, {
        name: dict.scopeName as PlanParserScope,
        includeKeywords: dict.includeKeywords || [],
        boostPhrases: dict.boostPhrases || [],
        weight: (dict.weight ?? 100) / 100,
      });
    }

    return {
      ...DEFAULT_CLASSIFICATION_CONFIG,
      scopes: Array.from(scopeMap.values()),
    };
  } catch (err) {
    console.error("Failed to load scope dictionaries from DB, using defaults:", err);
    return DEFAULT_CLASSIFICATION_CONFIG;
  }
}
