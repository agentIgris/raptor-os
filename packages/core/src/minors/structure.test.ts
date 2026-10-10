/**
 * Structural guarantees for the minors domain.
 *
 * The properties that matter most here are the ones a behaviour test cannot
 * check, because they are properties of the *source* rather than of any call:
 *
 * 1. **No clock.** `isMinor(person, at)` is meaningless if some caller can get
 *    the same person evaluated against "now". Reading a clock anywhere in this
 *    package would reintroduce exactly the defect the parameter exists to avoid.
 * 2. **No stored minority flag.** If any exported shape carries a boolean saying
 *    somebody is a minor, the design has been undone and every argument in
 *    `./majority.ts` about derived-over-stored is decoration.
 * 3. **The thresholds are declared once.** A literal `18` or `13` outside the
 *    declaration is a second definition waiting to drift.
 *
 * Comments are stripped before scanning. These rules are about executable code,
 * and the prose explaining *why* a rule exists has to be able to name the thing
 * it forbids without tripping the check that enforces it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ENGAGEMENT_MINIMUM_AGE_YEARS, MAJORITY_AGE_YEARS } from "./index.js";

const SOURCE_DIR = join(import.meta.dirname);

/** Module files under test, excluding the suites that read them. */
function sourceFiles(): readonly string[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(SOURCE_DIR, name));
}

/**
 * Remove comments so a rule about executable code is not enforced against prose.
 *
 * Deliberately a crude stripper: string literals here hold no `//`, and being
 * over-eager costs nothing because a false positive fails loudly and visibly
 * rather than silently permitting a clock.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("no clock is read anywhere in the minors domain", () => {
  it("contains no Date.now(), no-argument Date construction, or performance.now()", () => {
    // These are the three ways a "pure" function quietly acquires a dependency on
    // wall-clock time. Any of them would make `isMinor(person, at)` return
    // different answers for the same inputs depending on when it was called.
    const forbidden: readonly RegExp[] = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /performance\.now\s*\(/];

    for (const file of sourceFiles()) {
      for (const pattern of forbidden) {
        expect(pattern.test(code(file)), `${file} matched ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("declares every reference-date parameter as required, never optional", () => {
    // `at?: Date` is the shape that invites `at = new Date()` one refactor later.
    // The parameter has to be mandatory for the call to be explicit, which is the
    // property that makes a historical question answerable.
    //
    // Deliberately narrower than "no `= new Date`": `new Date(date.getTime())` is
    // a copy constructor, not a clock read, and banning it would be banning the
    // ordinary way to clone a Date.
    for (const file of sourceFiles()) {
      expect(/\b(at|asOf|grantedAt|expiresAt)\?:\s*Date/.test(code(file)), `${file} has an optional date`).toBe(false);
    }
  });

  it("finds at least one file to scan, so the checks above cannot pass vacuously", () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });
});

describe("minority is never stored", () => {
  it("exports no record carrying a boolean minority flag", () => {
    // `noUncheckedIndexedAccess` makes the no-match case explicit. A derived
    // `isMinor(person, at)` function is the whole design; a stored
    // `readonly isMinor: boolean` is the thing it replaces.
    const flags: string[] = [];
    for (const file of sourceFiles()) {
      for (const match of code(file).matchAll(/readonly\s+(is[A-Za-z]*[Mm]inor[A-Za-z]*)\s*:/g)) {
        flags.push(`${file}: ${match[1]}`);
      }
    }

    expect(flags).toEqual([]);
  });
});

describe("the age thresholds are declared exactly once", () => {
  it("hard-codes neither 18 nor 13 outside the declarations in majority.ts", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      if (file.endsWith(`${"majority.ts"}`)) continue;

      const source = code(file);
      for (const literal of ["18", "13"]) {
        const pattern = new RegExp(`\\b${literal}\\b`, "g");
        if (pattern.test(source)) offenders.push(`${file}: ${literal}`);
      }
    }

    // A threshold that appears as a bare number in two places is a threshold that
    // will be changed in one of them.
    expect(offenders).toEqual([]);
  });

  it("exposes the thresholds callers must read", () => {
    expect(MAJORITY_AGE_YEARS).toBe(18);
    expect(ENGAGEMENT_MINIMUM_AGE_YEARS).toBe(13);
  });
});