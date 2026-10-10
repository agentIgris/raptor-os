import { describe, expect, it } from "vitest";

import type {
  Acceptance,
  AcceptanceRefusal,
  AcceptanceWithdrawal,
  RefusalReason,
} from "./version-acceptance.js";
import {
  createAcceptance,
  findEffectiveAcceptance,
  findUnexpiredAcceptance,
  recordRefusal,
  withdrawalMatchesAcceptance,
  withdrawAcceptance,
} from "./version-acceptance.js";
import type { ContractVersion } from "./version.js";
import { createContractVersion } from "./version.js";

function createVersion(input: {
  contractId: string;
  organizationId: string;
  version: number;
  body: string;
  supersedesVersionId: string | null;
}): ContractVersion {
  return createContractVersion({
    versionId: `contract_version_${input.version}`,
    content: {
      ...input,
      title: `Agreement v${input.version}`,
      clauses: [{ heading: "1. Terms", text: input.body }],
      effectiveFrom: AT,
      expiresAt: null,
    },
  });
}

const AT = new Date("2026-02-01T00:00:00.000Z");
const ORGANIZATION = "org_1";

function version(n: number): ContractVersion {
  return createVersion({
    contractId: "contract_1",
    organizationId: ORGANIZATION,
    version: n,
    body: `Body for version ${n}.`,
    supersedesVersionId: n === 1 ? null : "contract_version_1",
  });
}

function acceptance(a: { versionId: string; hash: string; by: string; at?: Date }): Acceptance {
  return createAcceptance({
    versionId: a.versionId,
    contentHash: a.hash,
    acceptedBy: a.by,
    acceptedAt: a.at ?? AT,
    organizationId: ORGANIZATION,
  });
}

describe("createAcceptance", () => {
  it("records who accepted, when, and which content hash they saw", () => {
    const v = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v.contentHash, by: "person_1" });

    expect(record).toEqual({
      versionId: "contract_version_1",
      contentHash: v.contentHash,
      acceptedBy: "person_1",
      acceptedAt: AT,
      organizationId: ORGANIZATION,
    });
  });

  it("freezes the acceptance: it is a statement that happened, not a row that can change", () => {
    const v = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v.contentHash, by: "person_1" });
    expect(Object.isFrozen(record)).toBe(true);
    expect(() => {
      (record as { acceptedBy: string }).acceptedBy = "someone_else";
    }).toThrow(TypeError);
  });

  it("rejects an acceptance carrying no content hash", () => {
    expect(() =>
      createAcceptance({ versionId: "contract_version_1", contentHash: "", acceptedBy: "person_1", acceptedAt: AT, organizationId: ORGANIZATION }),
    ).toThrow(/hash/i);
  });

  it("rejects a malformed hash rather than storing an unprovable acceptance", () => {
    expect(() =>
      createAcceptance({ versionId: "contract_version_1", contentHash: "not-a-hash", acceptedBy: "person_1", acceptedAt: AT, organizationId: ORGANIZATION }),
    ).toThrow(/hash/i);
  });

  it("rejects an acceptance with no accepting party", () => {
    const v = version(1);
    expect(() =>
      createAcceptance({ versionId: "contract_version_1", contentHash: v.contentHash, acceptedBy: " ", acceptedAt: AT, organizationId: ORGANIZATION }),
    ).toThrow(/acceptedBy/i);
  });

  it("rejects an acceptance with no version to attach it to", () => {
    const v = version(1);
    expect(() =>
      createAcceptance({ versionId: " ", contentHash: v.contentHash, acceptedBy: "person_1", acceptedAt: AT, organizationId: ORGANIZATION }),
    ).toThrow(/versionId/i);
  });

  it("rejects an acceptance with an invalid instant", () => {
    expect(() =>
      createAcceptance({
        versionId: "contract_version_1",
        contentHash: version(1).contentHash,
        acceptedBy: "person_1",
        acceptedAt: new Date("nonsense"),
        organizationId: ORGANIZATION,
      }),
    ).toThrow(/acceptedAt/i);
  });
});

describe("acceptance is bound to one version, never a version family", () => {
  it("does not accept a later version: the earlier acceptance names its own hash", () => {
    const v1 = version(1);
    const v2 = version(2);

    const acceptedV1 = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });

    // The acceptance is a statement about a specific byte string. It carries the
    // hash of that string, so it cannot be stretched over a document the
    // accepter never saw.
    expect(acceptedV1.contentHash).toBe(v1.contentHash);
    expect(acceptedV1.contentHash).not.toBe(v2.contentHash);
  });

  it("finds the acceptance for v1 and refuses it for v2", () => {
    const v1 = version(1);
    const v2 = version(2);
    const acceptances = [acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" })];

    expect(findEffectiveAcceptance(v1, acceptances)).not.toBeNull();
    expect(findEffectiveAcceptance(v2, acceptances)).toBeNull();
  });

  it("refuses an acceptance whose hash belongs to a different version of the same contract", () => {
    const v1 = version(1);
    const v2 = version(2);
    // An attacker who knows the versionId points a stale hash at a new version.
    const forged = acceptance({ versionId: "contract_version_2", hash: v1.contentHash, by: "person_1" });

    expect(findEffectiveAcceptance(v2, [forged])).toBeNull();
  });
});

describe("findEffectiveAcceptance", () => {
  it("returns the acceptance when versionId and contentHash both match", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    expect(findEffectiveAcceptance(v1, [record])).toBe(record);
  });

  it("ignores acceptances from another organisation, even with a matching hash", () => {
    const v1 = version(1);
    const foreign = createAcceptance({
      versionId: "contract_version_1",
      contentHash: v1.contentHash,
      acceptedBy: "person_1",
      acceptedAt: AT,
      organizationId: "org_other",
    });
    expect(findEffectiveAcceptance(v1, [foreign])).toBeNull();
  });

  it("picks the earliest acceptance when the same version was accepted twice", () => {
    const v1 = version(1);
    const later = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1", at: new Date("2026-03-01T00:00:00.000Z") });
    const earlier = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });

    // Deterministic under reordering: the result cannot depend on array order.
    expect(findEffectiveAcceptance(v1, [later, earlier])).toBe(earlier);
    expect(findEffectiveAcceptance(v1, [earlier, later])).toBe(earlier);
  });

  it("returns null when there are no acceptances at all", () => {
    expect(findEffectiveAcceptance(version(1), [])).toBeNull();
  });
});

describe("withdrawAcceptance", () => {
  const WITHDRAWN_AT = new Date("2026-04-01T00:00:00.000Z");

  function withdrawn(overrides: Partial<AcceptanceWithdrawal> = {}): AcceptanceWithdrawal {
    return {
      versionId: "contract_version_1",
      acceptanceContentHash: version(1).contentHash,
      withdrawnAt: WITHDRAWN_AT,
      withdrawnBy: "person_1",
      reason: "withdrawn_by_accepting_party",
      organizationId: ORGANIZATION,
      ...overrides,
    };
  }

  it("appends a withdrawal record and does not touch the acceptance", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });

    const withdrawal = withdrawAcceptance({
      acceptance: record,
      withdrawnAt: WITHDRAWN_AT,
      withdrawnBy: "person_1",
      reason: "withdrawn_by_accepting_party",
    });

    expect(withdrawal).toEqual({
      versionId: "contract_version_1",
      acceptanceContentHash: v1.contentHash,
      withdrawnAt: WITHDRAWN_AT,
      withdrawnBy: "person_1",
      reason: "withdrawn_by_accepting_party",
      organizationId: ORGANIZATION,
    });
    expect(Object.isFrozen(withdrawal)).toBe(true);

    // The acceptance is byte-for-byte what it was. Nothing was retracted.
    expect(record.contentHash).toBe(v1.contentHash);
    expect(record.acceptedBy).toBe("person_1");
    expect(record).toEqual(acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" }));
  });

  it("rejects a withdrawal with no actor", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    expect(() =>
      withdrawAcceptance({ acceptance: record, withdrawnAt: WITHDRAWN_AT, withdrawnBy: " ", reason: "revoked_by_organisation" }),
    ).toThrow(/withdrew it|withdrawnBy/i);
  });

  it("rejects a withdrawal dated before the acceptance it withdraws", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    expect(() =>
      withdrawAcceptance({
        acceptance: record,
        withdrawnAt: new Date("2026-01-01T00:00:00.000Z"),
        withdrawnBy: "person_1",
        reason: "revoked_by_organisation",
      }),
    ).toThrow(/predate/i);
  });

  it("rejects a withdrawal with an invalid instant", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    expect(() =>
      withdrawAcceptance({
        acceptance: record,
        withdrawnAt: new Date("nonsense"),
        withdrawnBy: "person_1",
        reason: "withdrawn_by_accepting_party",
      }),
    ).toThrow(/withdrawnAt/i);
  });

  it("matches a withdrawal to its acceptance on id and hash together", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });

    expect(withdrawalMatchesAcceptance(record, withdrawn())).toBe(true);
    // Same id, wrong hash: the withdrawal belongs to some other version.
    expect(withdrawalMatchesAcceptance(record, withdrawn({ acceptanceContentHash: version(2).contentHash }))).toBe(false);
    expect(withdrawalMatchesAcceptance(record, withdrawn({ versionId: "contract_version_2" }))).toBe(false);
    expect(withdrawalMatchesAcceptance(record, withdrawn({ organizationId: "org_other" }))).toBe(false);
  });
});

describe("findUnexpiredAcceptance", () => {
  const WITHDRAWN_AT = new Date("2026-04-01T00:00:00.000Z");

  it("returns the acceptance when nothing has withdrawn it", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    expect(findUnexpiredAcceptance(v1, [record], [])).toBe(record);
  });

  it("stops returning the acceptance once it is withdrawn", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    const withdrawal = withdrawAcceptance({
      acceptance: record,
      withdrawnAt: WITHDRAWN_AT,
      withdrawnBy: "person_1",
      reason: "withdrawn_by_accepting_party",
    });

    expect(findUnexpiredAcceptance(v1, [record], [withdrawal])).toBeNull();
  });

  it("still refuses the version after withdrawal: withdrawal does not become acceptance", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    withdrawAcceptance({ acceptance: record, withdrawnAt: WITHDRAWN_AT, withdrawnBy: "person_1", reason: "revoked_by_organisation" });

    const v2 = version(2);
    expect(findUnexpiredAcceptance(v2, [record], [])).toBeNull();
  });

  it("ignores a withdrawal aimed at a different version of the same contract", () => {
    const v1 = version(1);
    const record = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    const v2 = version(2);

    // A withdrawal naming version 2 must not silently retire version 1.
    const withdrawal = withdrawAcceptance({
      acceptance: record,
      withdrawnAt: WITHDRAWN_AT,
      withdrawnBy: "person_1",
      reason: "withdrawn_by_accepting_party",
    });
    const aimedElsewhere = { ...withdrawal, versionId: "contract_version_2", acceptanceContentHash: v2.contentHash };

    expect(findUnexpiredAcceptance(v1, [record], [aimedElsewhere])).toBe(record);
  });

  it("lets a re-acceptance stand after an earlier withdrawal", () => {
    const v1 = version(1);
    const first = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1" });
    const withdrawal = withdrawAcceptance({
      acceptance: first,
      withdrawnAt: WITHDRAWN_AT,
      withdrawnBy: "person_1",
      reason: "withdrawn_by_accepting_party",
    });

    const reAcceptedAt = new Date("2026-06-01T00:00:00.000Z");
    const second = acceptance({ versionId: "contract_version_1", hash: v1.contentHash, by: "person_1", at: reAcceptedAt });

    // A withdrawal at T kills acceptances up to T; a later acceptance survives.
    // That is why the comparison is a timestamp, not a boolean.
    expect(findUnexpiredAcceptance(v1, [first, second], [withdrawal])).toBe(second);
  });

  it("returns null when the version was never accepted", () => {
    expect(findUnexpiredAcceptance(version(1), [], [])).toBeNull();
  });
});

describe("recordRefusal", () => {
  it("records a refusal as its own append-only fact, leaving the version untouched", () => {
    const v = version(1);
    const refusal = recordRefusal({
      versionId: "contract_version_1",
      contentHash: v.contentHash,
      refusedBy: "person_1",
      refusedAt: AT,
      organizationId: ORGANIZATION,
      reason: "terms_not_agreed",
    });

    const expected: AcceptanceRefusal = {
      versionId: "contract_version_1",
      contentHash: v.contentHash,
      refusedBy: "person_1",
      refusedAt: AT,
      organizationId: ORGANIZATION,
      reason: "terms_not_agreed",
    };
    expect(refusal).toEqual(expected);
    expect(Object.isFrozen(refusal)).toBe(true);
  });

  it("rejects a refusal with an empty reason", () => {
    const v = version(1);
    // Cast through `unknown` deliberately: the union already stops a TypeScript
    // caller, and this is about what arrives from a JSON body instead.
    const emptyReason = "" as unknown as RefusalReason;
    expect(() =>
      recordRefusal({
        versionId: "contract_version_1",
        contentHash: v.contentHash,
        refusedBy: "person_1",
        refusedAt: AT,
        organizationId: ORGANIZATION,
        reason: emptyReason,
      }),
    ).toThrow(/reason/i);
  });

  it("rejects a refusal carrying a malformed hash", () => {
    expect(() =>
      recordRefusal({
        versionId: "contract_version_1",
        contentHash: "abc",
        refusedBy: "person_1",
        refusedAt: AT,
        organizationId: ORGANIZATION,
        reason: "read_more_time",
      }),
    ).toThrow(/hash/i);
  });

  it("rejects a refusal with no version to attach it to", () => {
    const v = version(1);
    expect(() =>
      recordRefusal({
        versionId: "  ",
        contentHash: v.contentHash,
        refusedBy: "person_1",
        refusedAt: AT,
        organizationId: ORGANIZATION,
        reason: "terms_not_agreed",
      }),
    ).toThrow(/versionId/i);
  });

  it("rejects a refusal with no refusing party", () => {
    const v = version(1);
    expect(() =>
      recordRefusal({
        versionId: "contract_version_1",
        contentHash: v.contentHash,
        refusedBy: " ",
        refusedAt: AT,
        organizationId: ORGANIZATION,
        reason: "terms_not_agreed",
      }),
    ).toThrow(/refusedBy/i);
  });

  it("rejects a refusal with an invalid instant", () => {
    const v = version(1);
    expect(() =>
      recordRefusal({
        versionId: "contract_version_1",
        contentHash: v.contentHash,
        refusedBy: "person_1",
        refusedAt: new Date("nonsense"),
        organizationId: ORGANIZATION,
        reason: "terms_not_agreed",
      }),
    ).toThrow(/refusedAt/i);
  });
});