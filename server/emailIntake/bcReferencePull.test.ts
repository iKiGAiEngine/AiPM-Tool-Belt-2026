// Run: tsx server/emailIntake/bcReferencePull.test.ts
import assert from "assert";
import { projectNamesMatch } from "./bcReferencePull";

// ── projectNamesMatch ──
// Regression for the DPS Gateway E-5 intake: the invite email's project name
// carries a trade suffix the BC opportunity name does not, so the name-match
// fallback (used when a /goto/ short-link gives no id) must still identify them
// as the same project.
assert.strictEqual(
  projectNamesMatch("DPS Gateway E-5 100% CDs: Building Specialties", "DPS Gateway E-5 100% CDs"),
  true,
  "email name (with trade suffix) matches BC name (without)"
);
assert.strictEqual(
  projectNamesMatch("DPS Gateway E-5 100% CDs", "DPS Gateway E-5 100% CDs"),
  true,
  "identical names match"
);
// Punctuation/spacing/case differences are normalized away.
assert.strictEqual(
  projectNamesMatch("DPS GATEWAY E-5 100% CDs", "dps gateway e-5  100%  cds"),
  true,
  "normalization ignores case/punctuation/whitespace"
);

// Different projects must NOT match.
assert.strictEqual(
  projectNamesMatch("Watermark II - RDH Office and 4th Floor TI", "DPS Gateway E-5 100% CDs"),
  false,
  "unrelated projects do not match"
);
// A short shared prefix must NOT be enough (guards against over-eager matches).
assert.strictEqual(
  projectNamesMatch("Building A", "Building B"),
  false,
  "short prefix collision rejected"
);
assert.strictEqual(
  projectNamesMatch("Denver School Project Phase 1", "Denver School Project Phase 2"),
  false,
  "same prefix but different phase does not match (prefix must be whole other string)"
);
// Empty / missing names never match.
assert.strictEqual(projectNamesMatch("", "DPS Gateway"), false, "empty name does not match");
assert.strictEqual(projectNamesMatch("DPS Gateway", ""), false, "empty other name does not match");

console.log("All bcReferencePull tests passed!");
