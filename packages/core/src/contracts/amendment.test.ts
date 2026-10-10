import { describe, expect, it } from "vitest";

import type { Amendment } from "./amendment.js";
import type { ContractVersion } from "./version.js";
import { amendContract, amendmentChain, isAmendedFrom } from "./amendment.js";
import { createContractVersion } from "./version.js";

const AT = new Date("2026-02-01T00:00:00.000Z");
const ORGANIZATION = "org_1";

function original(n = 1): ContractVersion {
  return createContractVersion({
    versionId: `contract_version_${n}`,
    content: {
      contractId: "contract_1",
      organizationId: ORGANIZATION,
      version: n,
      title: "Player Agreement",
      body: "Body text.",
      clauses: [{ heading: "1. Fees", text: "Fees payable monthly." }],
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: null,
      supersedesVersionId: null,
    },
  });
}

describe("amendContract", () => {
  it("produces a NEW version rather than changing the one it corrects", () => {
    const v1 = original();

    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Body text, with the fee corrected.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(v2).not.toBe(v1);
    expect(v1.body).toBe("Body text.");
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v2.body).toBe("Body text, with the fee corrected.");
  });

  it("links the new version back to the one it replaces", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Corrected.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(v2.supersedesVersionId).toBe(v1.versionId);
    expect(isAmendedFrom(v2, v1)).toBe(true);
    expect(isAmendedFrom(v1, v2)).toBe(false);
  });

  it("gives the amendment its own content hash, never the predecessor's", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Corrected.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(v2.contentHash).not.toBe(v1.contentHash);
  });

  it("gives an amendment that changes no prose a different hash anyway", () => {
    // The version number and the supersession link are part of the content, so
    // an amendment can never hash-equal the thing it amends. If it could, the
    // acceptance proof would prove nothing about which document was signed.
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: v1.body,
      at: AT,
      actorId: "person_1",
      reason: "reissued_for_record",
    });

    expect(v2.body).toBe(v1.body);
    expect(v2.contentHash).not.toBe(v1.contentHash);
  });

  it("freezes the amendment and leaves the predecessor frozen", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Corrected.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(Object.isFrozen(v2)).toBe(true);
    expect(Object.isFrozen(v2.clauses)).toBe(true);
    expect(Object.isFrozen(v1)).toBe(true);
    expect(() => {
      (v1 as { body: string }).body = "edited in place";
    }).toThrow(TypeError);
  });

  it("carries forward the fields an amendment does not restate", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Corrected.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(v2.contractId).toBe(v1.contractId);
    expect(v2.organizationId).toBe(v1.organizationId);
    expect(v2.title).toBe(v1.title);
    expect(v2.effectiveFrom).toBe(v1.effectiveFrom);
    expect(v2.expiresAt).toBe(v1.expiresAt);
  });

  it("lets an amendment restate clauses and the effective date", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Corrected.",
      clauses: [{ heading: "1. Fees", text: "Fees payable monthly, net 30." }],
      effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(v2.clauses[0]?.text).toBe("Fees payable monthly, net 30.");
    expect(v2.effectiveFrom).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    expect(v2.supersedesVersionId).toBe(v1.versionId);
  });

  it("does not share the predecessor's clause objects, so amending one does not alter the other", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Corrected.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });

    expect(v2.clauses[0]).not.toBe(v1.clauses[0]);
    expect(v2.clauses[0]).toEqual(v1.clauses[0]);
  });

  it("requires a reason: an unexplained correction is the thing an audit looks for", () => {
    const v1 = original();
    expect(() =>
      amendContract({
        previous: v1,
        versionId: "contract_version_2",
        body: "Corrected.",
        at: AT,
        actorId: "person_1",
        reason: "  ",
      }),
    ).toThrow(/reason/i);
  });

  it("requires an actor", () => {
    const v1 = original();
    expect(() =>
      amendContract({
        previous: v1,
        versionId: "contract_version_2",
        body: "Corrected.",
        at: AT,
        actorId: " ",
        reason: "fee_schedule_correction",
      }),
    ).toThrow(/actor/i);
  });

  it("requires a valid instant", () => {
    const v1 = original();
    expect(() =>
      amendContract({
        previous: v1,
        versionId: "contract_version_2",
        body: "Corrected.",
        at: new Date("nonsense"),
        actorId: "person_1",
        reason: "fee_schedule_correction",
      }),
    ).toThrow(/at/i);
  });

  it("requires a distinct version id, so an amendment cannot overwrite its predecessor's row", () => {
    const v1 = original();
    expect(() =>
      amendContract({
        previous: v1,
        versionId: v1.versionId,
        body: "Corrected.",
        at: AT,
        actorId: "person_1",
        reason: "fee_schedule_correction",
      }),
    ).toThrow(/versionId/i);
  });

  it("chains three amendments with strictly increasing version numbers", () => {
    const v1 = original();
    const v2 = amendContract({
      previous: v1,
      versionId: "contract_version_2",
      body: "Second.",
      at: AT,
      actorId: "person_1",
      reason: "fee_schedule_correction",
    });
    const v3 = amendContract({
      previous: v2,
      versionId: "contract_version_3",
      body: "Third.",
      at: AT,
      actorId: "person_2",
      reason: "fee_schedule_correction",
    });

    expect(v3.version).toBe(3);
    expect(v3.supersedesVersionId).toBe(v2.versionId);
    expect(v2.supersedesVersionId).toBe(v1.versionId);
    expect(v1.supersedesVersionId).toBeNull();
  });
});

describe("amendmentChain", () => {
  const v1 = original();
  const v2 = amendContract({
    previous: v1,
    versionId: "contract_version_2",
    body: "Second.",
    at: AT,
    actorId: "person_1",
    reason: "fee_schedule_correction",
  });
  const v3 = amendContract({
    previous: v2,
    versionId: "contract_version_3",
    body: "Third.",
    at: AT,
    actorId: "person_2",
    reason: "fee_schedule_correction",
  });

  const chainInput: readonly Amendment[] = [
    { previousVersionId: v1.versionId, amendmentVersionId: v2.versionId, at: AT, actorId: "person_1", reason: "fee_schedule_correction" },
    { previousVersionId: v2.versionId, amendmentVersionId: v3.versionId, at: AT, actorId: "person_2", reason: "fee_schedule_correction" },
  ];

  it("walks the chain from the original to the latest version", () => {
    expect(amendmentChain(v3.versionId, chainInput)).toEqual(["contract_version_1", "contract_version_2", "contract_version_3"]);
  });

  it("is order-independent: reversing the supplied records changes nothing", () => {
    expect(amendmentChain(v3.versionId, [...chainInput].reverse())).toEqual(
      amendmentChain(v3.versionId, chainInput),
    );
  });

  it("returns just the version itself when nothing amended it", () => {
    expect(amendmentChain(v1.versionId, chainInput)).toEqual(["contract_version_1"]);
  });

  it("returns just the version itself when handed no records at all", () => {
    expect(amendmentChain(v3.versionId, [])).toEqual(["contract_version_3"]);
  });

  it("rejects a chain that forks, rather than silently picking one branch", () => {
    const forked = [
      ...chainInput,
      {
        previousVersionId: v2.versionId,
        amendmentVersionId: "contract_version_2b",
        at: AT,
        actorId: "person_3",
        reason: "conflicting_correction",
      },
    ];
    // Two different amendments to version 2 means the history is ambiguous.
    // Picking one would make "the current version" a coin toss.
    expect(() => amendmentChain(v3.versionId, forked)).toThrow(/fork|ambiguous|two/i);
  });

  it("tolerates byte-identical duplicate records from a re-imported history", () => {
    const duplicated = [...chainInput, chainInput[0]!];
    expect(amendmentChain(v3.versionId, duplicated)).toEqual(["contract_version_1", "contract_version_2", "contract_version_3"]);
  });

  it("rejects a merge: one version replacing two different predecessors", () => {
    const merged: readonly Amendment[] = [
      ...chainInput,
      {
        previousVersionId: "contract_version_9",
        amendmentVersionId: v3.versionId,
        at: AT,
        actorId: "person_3",
        reason: "conflicting_correction",
      },
    ];
    expect(() => amendmentChain(v3.versionId, merged)).toThrow(/both|merged|two contracts/i);
  });

  it("rejects a fork that sits off the path being walked, rather than ignoring it", () => {
    const forkedElsewhere: readonly Amendment[] = [
      ...chainInput,
      {
        previousVersionId: "contract_version_0",
        amendmentVersionId: "contract_version_0b",
        at: AT,
        actorId: "person_3",
        reason: "conflicting_correction",
      },
      {
        previousVersionId: "contract_version_0",
        amendmentVersionId: "contract_version_0c",
        at: AT,
        actorId: "person_3",
        reason: "conflicting_correction",
      },
    ];
    expect(() => amendmentChain(v3.versionId, forkedElsewhere)).toThrow(/fork|ambiguous|amended twice/i);
  });

  it("rejects a cycle rather than looping forever", () => {
    const cyclic: readonly Amendment[] = [
      { previousVersionId: "a", amendmentVersionId: "b", at: AT, actorId: "person_1", reason: "r" },
      { previousVersionId: "b", amendmentVersionId: "a", at: AT, actorId: "person_1", reason: "r" },
    ];
    expect(() => amendmentChain("a", cyclic)).toThrow(/cycle|circular/i);
  });

  it("rejects a self-referential amendment", () => {
    const selfLoop: readonly Amendment[] = [
      { previousVersionId: "a", amendmentVersionId: "a", at: AT, actorId: "person_1", reason: "r" },
    ];
    expect(() => amendmentChain("a", selfLoop)).toThrow(/cycle|circular|itself/i);
  });
});