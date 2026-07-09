import { DEFAULT_CLASSIFICATION_CONFIG, type ClassificationConfig, type ScopeConfig } from "./classificationConfig";
import type { PlanParserScope } from "@shared/schema";

export interface ClassificationResult {
  isRelevant: boolean;
  tags: PlanParserScope[];
  confidence: number;
  whyFlagged: string;
  signageOverrideApplied: boolean;
  keywordHits: { keyword: string; scope: string; count: number }[];
}

// Tolerates a single word being split across adjacent PDF text-positioning
// runs (common in CAD/Revit exports, e.g. "ACCESSORIES" rendered as two
// items and joined as "ACCESSOR IES") by allowing any single stray
// character between each letter.
function wordFuzzyRegex(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.split('').join('.?'), 'i');
}

// Multi-word keywords only need every word present somewhere on the page
// (not necessarily adjacent) — pdfjs's item-join can also drop the space
// between two words entirely, fusing them, so exact-substring matching on
// the full phrase silently fails even though a human reading the sheet
// would see it clearly.
function fuzzyMatch(text: string, keyword: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();

  if (lowerText.includes(lowerKeyword)) {
    return true;
  }

  const words = lowerKeyword.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.every(word => wordFuzzyRegex(word).test(lowerText));
  }

  return words.length === 1 ? wordFuzzyRegex(words[0]).test(lowerText) : false;
}

function countKeywordHits(text: string, keywords: string[]): { keyword: string; count: number }[] {
  const hits: { keyword: string; count: number }[] = [];
  const lowerText = text.toLowerCase();

  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    const escapedKeyword = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedKeyword, 'gi');
    const matches = lowerText.match(regex);
    if (matches && matches.length > 0) {
      hits.push({ keyword, count: matches.length });
    } else if (fuzzyMatch(text, keyword)) {
      // Exact substring match found nothing — CAD-exported PDFs frequently
      // split words or drop spaces between them across text-positioning
      // runs. A fuzzy hit still counts, just as a single occurrence (we
      // can't reliably count repeats once we're not doing exact matching).
      hits.push({ keyword, count: 1 });
    }
  }

  return hits;
}

function isScheduleLayout(text: string): boolean {
  const scheduleIndicators = [
    /schedule/i,
    /\btype\b.*\bqty\b/i,
    /\bmodel\b.*\bmanufacturer\b/i,
    /\blocation\b.*\bsize\b/i,
    /\bitem\b.*\bdescription\b/i,
    /\bmark\b.*\btype\b/i
  ];
  
  return scheduleIndicators.some(regex => regex.test(text));
}

function extractSnippet(text: string, keyword: string, contextLength: number = 50): string {
  const lowerText = text.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  const index = lowerText.indexOf(lowerKeyword);
  
  if (index === -1) return "";
  
  const start = Math.max(0, index - contextLength);
  const end = Math.min(text.length, index + keyword.length + contextLength);
  
  let snippet = text.substring(start, end).trim();
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  
  return snippet;
}

export function classifyPage(
  ocrText: string,
  config: ClassificationConfig = DEFAULT_CLASSIFICATION_CONFIG
): ClassificationResult {
  const result: ClassificationResult = {
    isRelevant: false,
    tags: [],
    confidence: 0,
    whyFlagged: "",
    signageOverrideApplied: false,
    keywordHits: []
  };
  
  if (!ocrText || ocrText.trim().length < 20) {
    return result;
  }
  
  const normalizedText = ocrText.toLowerCase();
  const signageHits = countKeywordHits(ocrText, config.signageExclusionKeywords);
  const signageScore = signageHits.reduce((sum, h) => sum + h.count, 0);
  
  const scopeScores: Map<PlanParserScope, { score: number; hits: { keyword: string; count: number }[] }> = new Map();
  const allKeywordHits: { keyword: string; scope: string; count: number }[] = [];
  const snippets: string[] = [];
  
  for (const scope of config.scopes) {
    const keywordHits = countKeywordHits(ocrText, scope.includeKeywords);
    const boostHits = countKeywordHits(ocrText, scope.boostPhrases);
    
    let score = keywordHits.reduce((sum, h) => sum + h.count, 0) * scope.weight;
    score += boostHits.reduce((sum, h) => sum + h.count * 2, 0) * scope.weight;
    
    if (scope.name === "Shelving") {
      const millworkHits = countKeywordHits(ocrText, config.millworkExclusionKeywords);
      const millworkScore = millworkHits.reduce((sum, h) => sum + h.count, 0);
      if (millworkScore > score * 0.5) {
        score = 0;
      }
    }
    
    if (score > 0 && isScheduleLayout(ocrText)) {
      score *= config.scheduleBoostMultiplier;
    }
    
    if (score > 0) {
      scopeScores.set(scope.name, { score, hits: [...keywordHits, ...boostHits] });
      
      for (const hit of keywordHits) {
        allKeywordHits.push({ keyword: hit.keyword, scope: scope.name, count: hit.count });
        const snippet = extractSnippet(ocrText, hit.keyword);
        if (snippet && !snippets.includes(snippet)) {
          snippets.push(snippet);
        }
      }
    }
  }
  
  const totalDiv10Score = Array.from(scopeScores.values()).reduce((sum, s) => sum + s.score, 0);
  
  if (signageScore > 0 && totalDiv10Score > 0) {
    const signageRatio = signageScore / (signageScore + totalDiv10Score);
    if (signageRatio > config.signageOverrideThreshold && totalDiv10Score < 3) {
      result.signageOverrideApplied = true;
      result.whyFlagged = "Page excluded: primarily signage content";
      return result;
    }
  }
  
  const relevantScopes: PlanParserScope[] = [];
  scopeScores.forEach((data, scopeName) => {
    if (data.score >= 1) {
      relevantScopes.push(scopeName);
    }
  });
  
  if (relevantScopes.length > 0) {
    result.isRelevant = true;
    result.tags = relevantScopes;
    result.keywordHits = allKeywordHits;
    
    const maxScore = Math.max(...Array.from(scopeScores.values()).map(s => s.score));
    result.confidence = Math.min(100, Math.round(maxScore * 15));
    
    const topHits = allKeywordHits
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map(h => `"${h.keyword}" (${h.scope})`)
      .join(", ");
    
    result.whyFlagged = `Matched: ${topHits}`;
    
    if (snippets.length > 0) {
      result.whyFlagged += ` | Context: ${snippets[0]}`;
    }
  }
  
  return result;
}
