import { db } from "../db";
import { and, eq, sql } from "drizzle-orm";
import { bidDocsLearning, type BidDocsLearning } from "@shared/schema";
import { planParserStorage } from "../planparser/storage";
import {
  getAllScopeDictionaries,
  updateScopeDictionary,
} from "../scopeDictionaryStorage";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "shall", "will",
  "page", "sheet", "detail", "typical", "note", "notes", "scale", "date",
  "drawn", "checked", "project", "plan", "floor", "level", "room", "wall",
  "ceiling", "door", "window", "north", "south", "east", "west", "section",
  "elevation", "provide", "install", "verify", "field", "contractor",
  "architect", "owner", "drawing", "drawings", "number", "revision",
]);

/**
 * Record a user correction on a review-grid page and derive keyword
 * suggestions from it.
 *
 * - Page ADDED to a scope the classifier missed → the page's distinctive
 *   OCR terms (not already in the scope's dictionary, not on obviously
 *   irrelevant pages) become suggested include-keywords.
 * - Page REMOVED (false positive) → the keywords that caused the flag
 *   (already listed in whyFlagged) become suggested exclude-keywords.
 */
export async function recordPageCorrection(
  pageId: string,
  action: "added" | "removed",
  scopes: string[],
): Promise<void> {
  try {
    const page = await planParserStorage.getPage(pageId);
    if (!page) return;

    if (action === "removed") {
      // whyFlagged format: `Matched: "kw" (Scope), "kw2" (Scope2) | Context: ...`
      const kwMatches = Array.from(page.whyFlagged.matchAll(/"([^"]+)"\s*\(([^)]+)\)/g));
      for (const [, keyword, scope] of kwMatches) {
        if (scopes.length > 0 && !scopes.includes(scope)) continue;
        await upsertSuggestion(scope, keyword.toLowerCase(), "page_removed");
      }
      return;
    }

    // action === "added": suggest distinctive terms from this page
    const dictionaries = await getAllScopeDictionaries();
    for (const scope of scopes) {
      const dict = dictionaries.find(d => d.scopeName === scope);
      const known = new Set(
        [
          ...(dict?.includeKeywords || []),
          ...(dict?.boostPhrases || []),
          ...(dict?.excludeKeywords || []),
        ].map(k => k.toLowerCase()),
      );

      const counts = new Map<string, number>();
      const words = page.ocrText.toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
      for (const w of words) {
        if (STOPWORDS.has(w) || known.has(w)) continue;
        counts.set(w, (counts.get(w) || 0) + 1);
      }

      const top = Array.from(counts.entries())
        .filter(([, c]) => c >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

      for (const [term, occurrences] of top) {
        await upsertSuggestion(scope, term, "page_added", occurrences);
      }
    }
  } catch (err) {
    console.error("[BidDocs Learning] Failed to record correction:", err);
  }
}

async function upsertSuggestion(
  scopeName: string,
  term: string,
  source: "page_added" | "page_removed",
  occurrences: number = 1,
): Promise<void> {
  const [existing] = await db.select().from(bidDocsLearning).where(and(
    eq(bidDocsLearning.scopeName, scopeName),
    eq(bidDocsLearning.term, term),
    eq(bidDocsLearning.source, source),
  ));
  if (existing) {
    if (existing.status === "suggested") {
      await db.update(bidDocsLearning)
        .set({ occurrences: existing.occurrences + occurrences })
        .where(eq(bidDocsLearning.id, existing.id));
    }
    return;
  }
  await db.insert(bidDocsLearning).values({ scopeName, term, source, occurrences, status: "suggested" });
}

export async function getSuggestions(status: string = "suggested"): Promise<BidDocsLearning[]> {
  return db.select().from(bidDocsLearning)
    .where(eq(bidDocsLearning.status, status))
    .orderBy(sql`${bidDocsLearning.occurrences} DESC`);
}

/**
 * Accept a suggestion: merge the term into the scope dictionary
 * (include-keywords for page_added terms, exclude-keywords for
 * page_removed terms) and mark it accepted.
 */
export async function acceptSuggestion(id: number): Promise<boolean> {
  const [suggestion] = await db.select().from(bidDocsLearning).where(eq(bidDocsLearning.id, id));
  if (!suggestion || suggestion.status !== "suggested") return false;

  const dictionaries = await getAllScopeDictionaries();
  const dict = dictionaries.find(d => d.scopeName === suggestion.scopeName);
  if (!dict) return false;

  if (suggestion.source === "page_added") {
    const keywords = Array.from(new Set([...(dict.includeKeywords || []), suggestion.term]));
    await updateScopeDictionary(dict.id, { includeKeywords: keywords });
  } else {
    const excludes = Array.from(new Set([...(dict.excludeKeywords || []), suggestion.term]));
    await updateScopeDictionary(dict.id, { excludeKeywords: excludes });
  }

  await db.update(bidDocsLearning).set({ status: "accepted" }).where(eq(bidDocsLearning.id, id));
  console.log(`[BidDocs Learning] Accepted "${suggestion.term}" into ${suggestion.scopeName} (${suggestion.source})`);
  return true;
}

export async function dismissSuggestion(id: number): Promise<boolean> {
  const result = await db.update(bidDocsLearning)
    .set({ status: "dismissed" })
    .where(and(eq(bidDocsLearning.id, id), eq(bidDocsLearning.status, "suggested")))
    .returning();
  return result.length > 0;
}
