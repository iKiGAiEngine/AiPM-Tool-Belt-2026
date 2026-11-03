// Completes a project address that was read from a truncated or partial source.
//
// BuildingConnected's "Location" row is often shortened in the UI, e.g.
//   "1345 South Temperance Avenue, 1345 South Temperance Avenue, CA 9372..."
// while the full address ("1345 South Temperance Avenue, Fresno, CA 93727") sits
// in the Project Information text. The Summary Sheet needs the full address
// (Ship To) and its ZIP (tax rate lookup), so when the primary address has no
// usable ZIP we look for a full address elsewhere in the text.

// "<STATE> <ZIP>" — the canonical US form; same position rule the tax lookup uses.
const STATE_ZIP_RE = /\b[A-Za-z]{2}\.?\s+\d{5}(?:-\d{4})?\b/;

// "<street>, <city>, <ST> <ZIP>" with a numeric street number.
const FULL_ADDRESS_RE =
  /(\d{1,6}\s+[^,\n]{3,60}),\s*([A-Za-z][A-Za-z .'-]{1,40}),\s*([A-Z]{2})\.?\s+(\d{5})(?:-\d{4})?/g;

const COUNTRY_SUFFIX_RE = /\s*,?\s*(United States of America|United States|USA|US)\s*$/i;

export function addressHasZip(address: string | null | undefined): boolean {
  return !!address && STATE_ZIP_RE.test(address);
}

function streetNumber(address: string | null | undefined): string | null {
  const m = (address ?? "").trim().match(/^(\d{1,6})\b/);
  return m ? m[1] : null;
}

// Every full street address in `text`, de-duplicated, in order of appearance.
export function findFullAddressesInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const found: string[] = [];
  for (const m of text.matchAll(FULL_ADDRESS_RE)) {
    const addr = `${m[1].trim()}, ${m[2].trim()}, ${m[3]} ${m[4]}`;
    const key = addr.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push(addr);
    }
  }
  return found;
}

// Returns the best project address. A primary address that already has a ZIP is
// kept as is (minus any country suffix). Otherwise a full address from `fallbackText`
// replaces it, but only when that is safe:
//   - with a primary address: the street numbers must match, so a GC office
//     address elsewhere on the page is never mistaken for the project;
//   - with no primary address: only when exactly one address appears in the text.
// If nothing safe is found the primary address is returned unchanged.
export function resolveProjectAddress(
  primary: string | null | undefined,
  fallbackText: string | null | undefined,
): string | null {
  const cleaned = (primary ?? "").trim().replace(COUNTRY_SUFFIX_RE, "").replace(/,\s*$/, "").trim();
  if (cleaned && addressHasZip(cleaned)) return cleaned;

  const candidates = findFullAddressesInText(fallbackText);
  const number = streetNumber(cleaned);
  if (cleaned && number) {
    const match = candidates.find((c) => streetNumber(c) === number);
    if (match) return match;
  } else if (!cleaned && candidates.length === 1) {
    return candidates[0];
  }
  return cleaned || null;
}
