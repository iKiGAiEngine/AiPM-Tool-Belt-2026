// Detailed Spec Review — the deep read that happens after extraction when the
// estimator ticks "Detailed Spec Review" on the Spec Extractor upload screen.
//
// For each extracted section we send the section's own spec text to the model
// and ask it to fill out a Short Order Form: one row per distinct material the
// section buys, with the fields needed to price and order it. Whatever the spec
// does not say comes back as an Open Item classified rfi / assumed / qualify.
// On top of the model's own findings we apply the deterministic rules in
// specDetailRules.ts, so the things an estimator must never miss (two versions
// of the same material, fire-rated FECs, sole-source language) are flagged even
// if the model stays quiet.

import OpenAI from "openai";
import { db } from "./db";
import { specExtractorSections } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { SpecSectionDetailReview } from "@shared/specDetailReview";
import {
  SYSTEM_PROMPT,
  buildSectionText,
  completenessScore,
  dedupeFlags,
  deterministicFlags,
  parseAiFlags,
  parseItems,
  parseOpenItems,
  str,
  type DetailReviewTarget,
} from "./specDetailRules";

export type { DetailReviewTarget } from "./specDetailRules";
export { buildSectionText } from "./specDetailRules";

const DETAIL_MODEL = "gpt-4o";
const MAX_TOKENS = 4000;

// ── Public API ─────────────────────────────────────────────────────────────

/** Review one section. Never throws — failures come back on `error`. */
export async function reviewSectionDetail(
  target: DetailReviewTarget,
  sectionText: string,
  projectName: string,
): Promise<SpecSectionDetailReview> {
  const base: SpecSectionDetailReview = {
    sectionId: target.id,
    sectionNumber: target.sectionNumber,
    title: target.title,
    scopeSummary: "",
    substitutionsAllowed: "unclear",
    items: [],
    flags: [],
    openItems: [],
    completeness: 0,
    reviewedAt: new Date().toISOString(),
  };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ...base, error: "OpenAI API key not configured" };
  }
  if (!sectionText.trim()) {
    return { ...base, error: "No text could be read from this section's pages" };
  }

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: DETAIL_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Project: "${projectName}"\nSection: ${target.sectionNumber} — ${target.title}\nPages ${target.startPage + 1}–${target.endPage + 1}\n\nSPECIFICATION TEXT:\n${sectionText}`,
        },
      ],
      temperature: 0.1,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content || "{}";
    const cleaned = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const items = parseItems(parsed.items);
    const openItems = parseOpenItems(parsed.openItems);
    const substitutionsAllowed = ["yes", "no", "unclear"].includes(str(parsed.substitutionsAllowed).toLowerCase())
      ? (str(parsed.substitutionsAllowed).toLowerCase() as "yes" | "no" | "unclear")
      : "unclear";

    const flags = dedupeFlags([
      ...parseAiFlags(parsed.flags),
      ...deterministicFlags(target, items, openItems, substitutionsAllowed, sectionText),
    ]);

    return {
      ...base,
      scopeSummary: str(parsed.scopeSummary),
      substitutionsAllowed,
      items,
      flags,
      openItems,
      completeness: completenessScore(items, openItems),
    };
  } catch (err: any) {
    console.error(`[SpecDetailReview] Section ${target.sectionNumber} failed:`, err?.message || err);
    return { ...base, error: err?.message || "Detail review failed" };
  }
}

/**
 * Review each target section in turn, storing the result on the section row as
 * it lands so a long run is still useful if it is interrupted.
 */
export async function runDetailReview(
  targets: DetailReviewTarget[],
  pages: string[],
  projectName: string,
  onProgress?: (done: number, total: number, sectionNumber: string) => Promise<void> | void,
): Promise<SpecSectionDetailReview[]> {
  const results: SpecSectionDetailReview[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    if (onProgress) await onProgress(i, targets.length, target.sectionNumber);

    const sectionText = buildSectionText(pages, target.startPage, target.endPage);
    const review = await reviewSectionDetail(target, sectionText, projectName);
    results.push(review);

    await db.update(specExtractorSections)
      .set({ detailReview: review })
      .where(eq(specExtractorSections.id, target.id));
  }

  if (onProgress) await onProgress(targets.length, targets.length, "");
  return results;
}
