/**
 * Package-level structural guarantees.
 *
 * These tests do not test behaviour — the modules' own suites do that. They test
 * **shape**: that the guarantees the module comments make are still true of the
 * exported surface. A guarantee that only exists in prose is a comment, and
 * comments do not fail a build.
 *
 * The mutator-name check follows the same approach the ledger already uses for
 * `journal.ts`. It is deliberately not the whole story — a mutator named
 * innocuously would slip past it — but it forces anyone who really wants an edit
 * path to name it `amend*`, and the allowance below shows there is already a
 * legitimate one, so the escape hatch is visible rather than hidden.
 */

import { describe, expect, it } from "vitest";

import * as contracts from "./index.js";

/**
 * The only export that *produces* a correction. It returns a new version; it
 * does not write to the one it is given.
 */
const WRITE_AMENDERS = new Set(["amendContract"]);

/**
 * Every legitimate export whose name contains an edit-like word, and why each is
 * safe. Listed explicitly so that adding a new one is a deliberate edit to this
 * file rather than something the regex quietly tolerates.
 *
 * - `amendContract` — produces a NEW version; the predecessor is untouched.
 * - `amendmentChain` — reads the supersession links. A query.
 * - `isAmendedFrom` — compares two versions. A query.
 */
const ALLOWED_EDIT_LIKE = new Set([...WRITE_AMENDERS, "amendmentChain", "isAmendedFrom"]);

/** Names that would mean "change an existing record in place". */
const MUTATOR_PATTERN = /(amend|update|mutate|delete|remove|replace|patch|purge|void|edit|retract|rewrite|backdate|overwrite|undo|correct)/i;

describe("the contracts package exports no in-place mutator", () => {
  it("exports nothing named as an edit, a delete or a retraction", () => {
    const offenders = Object.keys(contracts).filter(
      (name) => !ALLOWED_EDIT_LIKE.has(name) && MUTATOR_PATTERN.test(name),
    );

    // A contract is corrected by publishing a new version (see `./amendment.js`),
    // never by rewriting the one somebody already signed. If a mutator is ever
    // added under another name, this fails and makes that an argument rather
    // than a review comment nobody reads.
    expect(offenders).toEqual([]);
  });

  it("exports exactly one amender that writes, and it is the one that makes a new version", () => {
    const writeAmenders = Object.keys(contracts).filter((name) => WRITE_AMENDERS.has(name));
    expect(writeAmenders).toEqual([...WRITE_AMENDERS]);

    // And it demonstrably does not mutate what it was given.
    const version = contracts.createContractVersion({
      versionId: "contract_version_1",
      content: {
        contractId: "contract_1",
        organizationId: "org_1",
        version: 1,
        title: "Agreement",
        body: "Body.",
        clauses: [{ heading: "1. Terms", text: "Terms." }],
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: null,
        supersedesVersionId: null,
      },
    });

    const amended = contracts.amendContract({
      previous: version,
      versionId: "contract_version_2",
      body: "Corrected.",
      at: new Date("2026-02-01T00:00:00.000Z"),
      actorId: "person_1",
      reason: "correction",
    });

    expect(amended).not.toBe(version);
    expect(version.body).toBe("Body.");
  });

  it("keeps the allowlist honest: every listed name still exists", () => {
    // A stale allowlist entry would silently permit a future export to reuse the
    // name it describes, which is the whole thing this file exists to prevent.
    for (const name of ALLOWED_EDIT_LIKE) {
      expect(name in contracts).toBe(true);
    }
  });
});

describe("the acceptance proof is reachable from the package entry point", () => {
  it("exposes hashing, acceptance, withdrawal, lifecycle and amendment together", () => {
    // The criterion is "acceptance provable by content hash". If the barrel stops
    // re-exporting one of these, a caller cannot build the proof without
    // reaching into private paths, and the guarantee quietly stops being usable.
    for (const name of [
      "hashContractVersion",
      "verifyContractVersion",
      "createAcceptance",
      "findEffectiveAcceptance",
      "findUnexpiredAcceptance",
      "withdrawAcceptance",
      "canTransition",
      "amendContract",
    ] as const) {
      expect(typeof contracts[name]).toBe("function");
    }
  });

  it("exposes the transition table itself, not only a predicate over it", () => {
    // A predicate with no table cannot be audited. "Which moves are legal?" has
    // to be answerable by reading something.
    expect(Object.keys(contracts.CONTRACT_TRANSITIONS)).toEqual([...contracts.CONTRACT_STATES]);
  });
});