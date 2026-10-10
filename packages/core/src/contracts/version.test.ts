import { describe, expect, it } from "vitest";

import type { ContractClause, ContractVersionContent } from "./version.js";
import {
  CONTRACT_HASH_ALGORITHM,
  assertContractVersionVerified,
  canonicalFrame,
  canonicalizeContractVersion,
  createContractVersion,
  encodeContractVersion,
  hashContractVersion,
  verifyContractVersion,
} from "./version.js";

const CLAUSES: readonly ContractClause[] = [
  Object.freeze({ heading: "1. Term", text: "This agreement runs for twelve months from the effective date." }),
  Object.freeze({ heading: "2. Fees", text: "Fees are payable monthly in arrears." }),
];

function content(overrides: Partial<ContractVersionContent> = {}): ContractVersionContent {
  return {
    contractId: "contract_1",
    organizationId: "org_1",
    version: 1,
    title: "Player Agreement",
    body: "This Player Agreement is made between the Organisation and the Player.",
    clauses: CLAUSES,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    supersedesVersionId: null,
    ...overrides,
  };
}

describe("canonicalFrame", () => {
  it("prefixes every value with its UTF-8 byte length", () => {
    expect(canonicalFrame("abc")).toBe("3:abc");
  });

  it("measures UTF-8 bytes, not JavaScript string length", () => {
    // "é" is one JS char but two UTF-8 bytes. Framing by `length` would make a
    // multi-byte document decode one byte per char, shifting every boundary after
    // the first non-ASCII character.
    expect(canonicalFrame("é")).toBe("2:é");
    expect(canonicalFrame("é").startsWith("1:")).toBe(false);
  });

  it("keeps a colon inside the value from being read as a boundary", () => {
    // "12:" is a length header; the value "1:2" must not be mistaken for it.
    expect(canonicalFrame("1:2")).toBe("3:1:2");
  });
});

describe("encodeContractVersion", () => {
  it("is a pure function of content: the same content encodes to the same string", () => {
    expect(encodeContractVersion(content())).toBe(encodeContractVersion(content()));
  });

  it("is independent of the order the input properties were written in", () => {
    const forward = {
      contractId: "contract_1",
      organizationId: "org_1",
      version: 1,
      title: "Player Agreement",
      body: "Body text.",
      clauses: CLAUSES,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: null,
      supersedesVersionId: null,
    } satisfies ContractVersionContent;

    const backward = {
      supersedesVersionId: null,
      expiresAt: null,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      clauses: CLAUSES,
      body: "Body text.",
      title: "Player Agreement",
      version: 1,
      organizationId: "org_1",
      contractId: "contract_1",
    } satisfies ContractVersionContent;

    expect(Object.keys(forward)).not.toEqual(Object.keys(backward));
    expect(encodeContractVersion(forward)).toBe(encodeContractVersion(backward));
  });

  it("frames every clause, so a boundary shifted between two clauses changes the bytes", () => {
    // THE ATTACK. An unframed concatenation of ["ab", "c"] and ["a", "bc"] is
    // byte-identical, so a hash over it would accept two different contracts.
    const shiftedEarly = content({
      clauses: [
        { heading: "h", text: "ab" },
        { heading: "h", text: "c" },
      ],
    });
    const shiftedLate = content({
      clauses: [
        { heading: "h", text: "a" },
        { heading: "h", text: "bc" },
      ],
    });

    expect(encodeContractVersion(shiftedEarly)).not.toBe(encodeContractVersion(shiftedLate));
    expect(hashContractVersion(shiftedEarly)).not.toBe(hashContractVersion(shiftedLate));
  });

  it("frames adjacent scalar fields against each other, not just the whole document", () => {
    // Same attack, one level up: "AB" + "C" versus "A" + "BC" across two fields.
    const left = content({ title: "AB", body: "C" });
    const right = content({ title: "A", body: "BC" });

    expect(encodeContractVersion(left)).not.toBe(encodeContractVersion(right));
    expect(hashContractVersion(left)).not.toBe(hashContractVersion(right));
  });

  it("distinguishes an absent expiry from an explicit one", () => {
    // `undefined` and `null` both mean "no end" to a careless reader; here the
    // canonical form records exactly what the caller supplied, so the two never
    // share a hash by accident and never differ by accident either.
    expect(encodeContractVersion(content({ expiresAt: null }))).toBe(
      encodeContractVersion(content({ expiresAt: undefined })),
    );
    expect(hashContractVersion(content({ expiresAt: null }))).toBe(
      hashContractVersion(content({ expiresAt: undefined })),
    );
    expect(hashContractVersion(content({ expiresAt: new Date("2027-01-01T00:00:00.000Z") }))).not.toBe(
      hashContractVersion(content({ expiresAt: null })),
    );
  });

  it("distinguishes clauses that are reordered", () => {
    // Clause order is legally meaningful. Sorting the array away would let two
    // genuinely different contracts share a hash, which is the whole class of
    // defect this module exists to prevent.
    const reversed = content({ clauses: [...CLAUSES].reverse() });
    expect(hashContractVersion(reversed)).not.toBe(hashContractVersion(content()));
  });

  it("cannot be defeated by a value that impersonates the field framing itself", () => {
    // THE DECISIVE ATTACK, and the one a naive fix for the cases above misses.
    //
    // If a scalar value is written unframed, an attacker can move a length
    // header across a boundary. `title` = "A4:bodyZ" with `body` = "X" and
    // `title` = "A" with `body` = "Z4:bodyX" both emit, after the shared
    // "5:titleA" prefix, the identical bytes:
    //
    //     4:bodyZ 4:body X ...     (impostor title)
    //     4:body Z4:body X ...     (honest title, shifted body)
    //
    // Length framing is only injective if EVERY value is framed, not just the
    // containers. This test is the reason it is not a comment.
    const impostor = content({ title: "A4:bodyZ", body: "X" });
    const shifted = content({ title: "A", body: "Z4:bodyX" });

    expect(encodeContractVersion(impostor)).not.toBe(encodeContractVersion(shifted));
    expect(hashContractVersion(impostor)).not.toBe(hashContractVersion(shifted));
  });

  it("cannot be defeated by a value that impersonates the supersession framing", () => {
    // The same attack one field further along, where the impostor would have to
    // swallow three intervening framed fields.
    const a = content({ body: "X", supersedesVersionId: "v1" });
    const b = content({ body: "7:clauses0:13:effectiveFrom9:expiresAt~18:supersedesVersionId3:v1X", supersedesVersionId: null });

    expect(encodeContractVersion(a)).not.toBe(encodeContractVersion(b));
    expect(hashContractVersion(a)).not.toBe(hashContractVersion(b));
  });

  it("cannot be defeated by a value that impersonates the list framing", () => {
    const a = content({ clauses: [{ heading: "h", text: "1:a" }] });
    const b = content({ clauses: [{ heading: "h", text: "a" }] });

    expect(hashContractVersion(a)).not.toBe(hashContractVersion(b));
  });

  it("distinguishes a differing clause heading from a differing clause body", () => {
    const headingChanged = content({
      clauses: [{ heading: "1. Term (amended)", text: CLAUSES[0]!.text }],
    });
    const bodyChanged = content({
      clauses: [{ heading: "1. Term", text: `${CLAUSES[0]!.text} ` }],
    });
    expect(hashContractVersion(headingChanged)).not.toBe(hashContractVersion(bodyChanged));
  });

  it("distinguishes instants that differ by one millisecond", () => {
    expect(hashContractVersion(content({ effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }))).not.toBe(
      hashContractVersion(content({ effectiveFrom: new Date("2026-01-01T00:00:00.001Z") })),
    );
  });

  it("carries the version number, so an amendment is never hash-equal to its predecessor", () => {
    // Even an amendment that changes no prose is a different contractual
    // instrument, and a hash that could not tell them apart would make the
    // acceptance proof meaningless.
    expect(hashContractVersion(content({ version: 1 }))).not.toBe(hashContractVersion(content({ version: 2 })));
  });

  it("carries the supersession link, so the chain is provable from the hash alone", () => {
    expect(hashContractVersion(content({ supersedesVersionId: "contract_version_7" }))).not.toBe(
      hashContractVersion(content({ supersedesVersionId: "contract_version_8" })),
    );
  });
});

describe("canonicalizeContractVersion", () => {
  it("keeps clause order and hands back a frozen, reproducible list", () => {
    const canonical = canonicalizeContractVersion(CLAUSES);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(canonical.map((c) => c.heading)).toEqual(["1. Term", "2. Fees"]);
    expect(canonicalizeContractVersion(CLAUSES)).toEqual(canonical);
  });

  it("does not mutate the caller's clause array", () => {
    const mutable = [...CLAUSES];
    const before = [...mutable];
    canonicalizeContractVersion(mutable);
    expect(mutable).toEqual(before);
  });
});

describe("hashContractVersion", () => {
  it("is a lowercase hex sha-256 of the canonical encoding", () => {
    expect(CONTRACT_HASH_ALGORITHM).toBe("sha256");
    expect(hashContractVersion(content())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls and across separately-built equal content", () => {
    expect(hashContractVersion(content())).toBe(hashContractVersion(content()));
  });

  it("does not depend on the caller freezing anything", () => {
    const frozen = createContractVersion({
      versionId: "contract_version_1",
      content: content(),
    });
    expect(hashContractVersion(frozen)).toBe(frozen.contentHash);
  });

  it("cannot be confused with an absent optional by a literal tilde", () => {
    // `~` is the "no value" sentinel. A present value is always framed, so the
    // smallest framed form of a tilde is `1:~` — a different token. Without the
    // framing, `supersedesVersionId: "~"` would encode exactly as "absent".
    const tilde = content({ supersedesVersionId: "~" });
    const absent = content({ supersedesVersionId: null });

    expect(encodeContractVersion(tilde)).not.toBe(encodeContractVersion(absent));
    expect(hashContractVersion(tilde)).not.toBe(hashContractVersion(absent));
  });
});

describe("the canonical encoding is injective over adversarial values", () => {
  // A brute-force sweep in place of a proof. Every value here is drawn from a
  // set built out of the encoding's own syntax — length headers, colons, the
  // no-value sentinel, field names — because those are the only strings that
  // could possibly confuse a length-framed encoder.
  const ADVERSARIAL = [
    "",
    "~",
    ":",
    "0:",
    "1:",
    "4:body",
    "5:title",
    "1:~",
    "2:clauses",
    "18:supersedesVersionId",
    "4:bodyX",
    "A4:bodyZ",
    "Z4:bodyX",
    "~1:~",
    "é",
    "日",
  ];

  it("gives a distinct hash to every distinct (title, body) pair drawn from it", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];

    for (const title of ADVERSARIAL) {
      for (const body of ADVERSARIAL) {
        const version = content({ title, body, clauses: [{ heading: "h", text: body }] });
        const hash = hashContractVersion(version);
        const key = `${title} ${body}`;

        const existing = seen.get(hash);
        if (existing !== undefined && existing !== key) {
          collisions.push(`${existing} == ${key}`);
        }
        seen.set(hash, key);
      }
    }

    // 225 distinct documents, 225 distinct hashes. One collision here would mean
    // two different contracts share an acceptance proof.
    expect(collisions).toEqual([]);
    expect(seen.size).toBe(ADVERSARIAL.length * ADVERSARIAL.length);
  });

  it("gives a distinct hash to every distinct clause-list shape drawn from it", () => {
    const shapes: readonly ContractClause[][] = [
      [{ heading: "~", text: "1:2" }],
      [{ heading: "1", text: ":2" }],
      [{ heading: "1:", text: "2" }],
      [{ heading: "", text: "" }],
      [
        { heading: "h", text: "" },
        { heading: "", text: "h" },
      ],
      [
        { heading: "h", text: "h" },
        { heading: "h", text: "h" },
      ],
    ];

    const hashes = shapes.map((clauses) => hashContractVersion(content({ clauses })));
    expect(new Set(hashes).size).toBe(shapes.length);
  });
});

describe("createContractVersion", () => {
  it("freezes the version and every clause, so a correction cannot be an edit", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });

    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.clauses)).toBe(true);
    for (const clause of version.clauses) expect(Object.isFrozen(clause)).toBe(true);

    expect(() => {
      (version as { title: string }).title = "Amended in place";
    }).toThrow(TypeError);
    expect(version.title).toBe("Player Agreement");
  });

  it("stamps the content hash onto the version it creates", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });
    expect(version.contentHash).toBe(hashContractVersion(content()));
  });

  it("rejects a version number below 1", () => {
    expect(() => createContractVersion({ versionId: "v1", content: content({ version: 0 }) })).toThrow(/version/i);
  });

  it("rejects an empty title: a version nobody can identify in a list is not a version", () => {
    expect(() => createContractVersion({ versionId: "v1", content: content({ title: "   " }) })).toThrow(/title/i);
  });

  it("rejects an expiry at or before the effective date", () => {
    expect(() =>
      createContractVersion({
        versionId: "v1",
        content: content({
          effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      }),
    ).toThrow(/expires/i);
  });

  it("accepts an open-ended contract", () => {
    expect(() => createContractVersion({ versionId: "v1", content: content({ expiresAt: null }) })).not.toThrow();
  });

  it("rejects a clause with a blank heading, which would hash as an anonymous clause", () => {
    expect(() =>
      createContractVersion({ versionId: "v1", content: content({ clauses: [{ heading: " ", text: "x" }] }) }),
    ).toThrow(/heading/i);
  });

  it("rejects a contract with no clauses at all", () => {
    expect(() => createContractVersion({ versionId: "v1", content: content({ clauses: [] }) })).toThrow(/clause/i);
  });
});

describe("verifyContractVersion", () => {
  it("accepts a version whose hash still matches its content", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });
    expect(verifyContractVersion(version)).toBe(true);
  });

  it("rejects a version whose recorded hash was tampered with", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });
    const tampered = { ...version, contentHash: "0".repeat(64) };
    expect(verifyContractVersion(tampered)).toBe(false);
  });

  it("rejects a version whose content was tampered with, hash left alone", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });
    const tampered = { ...version, title: "A different agreement" };
    expect(verifyContractVersion(tampered)).toBe(false);
  });

  it("throws rather than returning false when asked, so a failed proof cannot be ignored", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });
    expect(() => assertContractVersionVerified({ ...version, title: "Different" })).toThrow(/does not match/i);
  });

  it("accepts an intact version through the throwing assertion", () => {
    const version = createContractVersion({ versionId: "contract_version_1", content: content() });
    expect(() => assertContractVersionVerified(version)).not.toThrow();
  });
});