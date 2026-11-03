import assert from "assert";
import { resolveProjectAddress, findFullAddressesInText, addressHasZip } from "./projectAddress.js";

const SANGER_DESCRIPTION =
  "Swinerton Builders is Seeking Qualified Subcontractors and Suppliers to provide pricing (bids) for the " +
  "Sanger USD New Temperance ES located at 1345 South Temperance Avenue, Fresno, CA 93727\n\nScope of work includes: ...";

// The real BC screenshot case: truncated, repeated-street Location row.
assert.strictEqual(
  resolveProjectAddress("1345 South Temperance Avenue, 1345 South Temperance Avenue, CA 9372...", SANGER_DESCRIPTION),
  "1345 South Temperance Avenue, Fresno, CA 93727",
);

// A complete address is left alone (country suffix still stripped).
assert.strictEqual(
  resolveProjectAddress("5301 55th Street, San Diego, CA 92182, United States of America", "irrelevant text"),
  "5301 55th Street, San Diego, CA 92182",
);

// A GC office address elsewhere on the page must not replace a project address
// with a different street number.
assert.strictEqual(
  resolveProjectAddress("1345 South Temperance Avenue, CA 9372...", "Client Details 6890 West 52nd Avenue, Arvada, CO 80002"),
  "1345 South Temperance Avenue, CA 9372...",
);

// No primary address: use the text only when exactly one address appears.
assert.strictEqual(resolveProjectAddress(null, SANGER_DESCRIPTION), "1345 South Temperance Avenue, Fresno, CA 93727");
assert.strictEqual(
  resolveProjectAddress(null, "1 Main St, Reno, NV 89501 and 2 Oak Ave, Sparks, NV 89431"),
  null,
);

// Nothing usable anywhere.
assert.strictEqual(resolveProjectAddress(null, null), null);
assert.strictEqual(resolveProjectAddress("Fresno, CA", "no address here"), "Fresno, CA");

// Street numbers are never mistaken for a ZIP, and findFullAddressesInText de-duplicates.
assert.strictEqual(addressHasZip("12345 Sunset Blvd, Los Angeles"), false);
assert.strictEqual(addressHasZip("Fresno, CA 93727"), true);
assert.deepStrictEqual(
  findFullAddressesInText("1345 South Temperance Avenue, Fresno, CA 93727 ... 1345 South Temperance Avenue, Fresno, CA 93727"),
  ["1345 South Temperance Avenue, Fresno, CA 93727"],
);

console.log("projectAddress tests passed");
