import { describe, expect, it } from "vitest";

import { money } from "../money/index.js";
import type { CompensationAgreement } from "./compensation.js";
import {
  agreementAppliesAt,
  agreementsCovering,
  assertNoOverlappingAgreements,
  createCompensationAgreement,
  hasOverlapAt,
  resolveCompensationAt,
  totalAnnualCompensationAt,
} from "./compensation.js";

const ORG = "org_1";
const SALARY = money("50000.0000", "INR");

function agreement(overrides: Partial<Parameters<typeof createCompensationAgreement>[0]> = {}): CompensationAgreement {
  return createCompensationAgreement({
    agreementId: "ca_1",
    personId: "person_1",
    organizationId: ORG,
    title: "Player",
    baseSalary: SALARY,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: new Date("2027-01-01T00:00:00.000Z"),
    ...overrides,
  });
}

describe("createCompensationAgreement", () => {
  it("freezes the agreement and its money", () => {
    const a = agreement();
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.baseSalary.minor).toBe(500_000_000n);
    expect(a.baseSalary.toDecimal()).toBe("50000.0000");
  });

  it("keeps the salary in exact minor units, never a float", () => {
    const a = agreement({ baseSalary: money("0.0001", "INR") });
    expect(typeof a.baseSalary.minor).toBe("bigint");
    expect(a.baseSalary.minor).toBe(1n);
    expect(a.baseSalary.toDecimal()).toBe("0.0001");
  });

  it("carries a bonus percentage as an exact scaled bigint", () => {
    const a = agreement({ bonusPercent: "12.5" });
    expect(a.bonusPercent).toBe(125_000n);
    expect(typeof a.bonusPercent).toBe("bigint");
  });

  it("normalises an absent bonus to null rather than zero", () => {
    // null means "this agreement states no bonus"; 0n means "this agreement
    // states a bonus of nothing". Different contracts, and conflating them
    // makes a pay report quietly understate a clause.
    expect(agreement().bonusPercent).toBeNull();
  });

  it("distinguishes an explicit zero bonus from an absent one", () => {
    expect(agreement({ bonusPercent: "0" }).bonusPercent).toBe(0n);
    expect(agreement({ bonusPercent: null }).bonusPercent).toBeNull();
    expect(agreement({ bonusPercent: undefined }).bonusPercent).toBeNull();
  });

  it("rejects a bonus percentage finer than four decimal places", () => {
    expect(() => agreement({ bonusPercent: "12.50001" })).toThrow(/decimal places/i);
  });

  it("rejects a negative bonus percentage", () => {
    expect(() => agreement({ bonusPercent: "-5" })).toThrow(/negative/i);
  });

  it("rejects a bonus percentage that is not a number", () => {
    expect(() => agreement({ bonusPercent: "twelve" })).toThrow(/bonusPercent/i);
  });

  it("exposes the same half-open predicate the resolver uses", () => {
    const a = agreement();
    expect(agreementAppliesAt(a, new Date("2026-01-01T00:00:00.000Z"))).toBe(true);
    expect(agreementAppliesAt(a, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
    expect(agreementAppliesAt(agreement({ validTo: null }), new Date("2099-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("normalises an absent bonus to null rather than zero", () => {
    // null means "this agreement states no bonus"; 0n means "this agreement
    // states a bonus of nothing". Different contracts, and conflating them
    // makes a pay report quietly understate a clause.
    expect(agreement().bonusPercent).toBeNull();
  });

  it("accepts an open-ended agreement", () => {
    expect(agreement({ validTo: null }).validTo).toBeNull();
    expect(agreement({ validTo: undefined }).validTo).toBeNull();
  });

  it("rejects a window that ends before it begins", () => {
    expect(() =>
      agreement({
        validFrom: new Date("2026-06-01T00:00:00.000Z"),
        validTo: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/validTo/i);
  });

  it("rejects a zero-length window, which covers no instant at all", () => {
    expect(() =>
      agreement({
        validFrom: new Date("2026-01-01T00:00:00.000Z"),
        validTo: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).toThrow(/validTo/i);
  });

  it("rejects a negative salary", () => {
    expect(() => agreement({ baseSalary: money("-1.0000", "INR") })).toThrow(/negative/i);
  });

  it("rejects a blank person id: an agreement belonging to nobody pays nobody", () => {
    expect(() => agreement({ personId: " " })).toThrow(/personId/i);
  });

  it("rejects a blank agreement id", () => {
    expect(() => agreement({ agreementId: "" })).toThrow(/agreementId/i);
  });
});

describe("resolveCompensationAt — the half-open window boundary", () => {
  const a = agreement();

  it("applies at the instant validFrom is reached: the window is inclusive at the start", () => {
    expect(resolveCompensationAt("person_1", new Date("2026-01-01T00:00:00.000Z"), [a])).toBe(a);
  });

  it("does not apply one millisecond before validFrom", () => {
    expect(resolveCompensationAt("person_1", new Date("2025-12-31T23:59:59.999Z"), [a])).toBeNull();
  });

  it("does NOT apply at the instant validTo is reached: the window is exclusive at the end", () => {
    // The boundary decision that matters. [validFrom, validTo) means handing the
    // role from one agreement to the next at the same instant leaves no gap and
    // no overlap — the same convention src/authorization/model.ts uses.
    expect(resolveCompensationAt("person_1", new Date("2027-01-01T00:00:00.000Z"), [a])).toBeNull();
  });

  it("applies one millisecond before validTo", () => {
    expect(resolveCompensationAt("person_1", new Date("2026-12-31T23:59:59.999Z"), [a])).toBe(a);
  });

  it("treats an open-ended agreement as still applying years later", () => {
    const openEnded = agreement({ validTo: null });
    expect(resolveCompensationAt("person_1", new Date("2099-01-01T00:00:00.000Z"), [openEnded])).toBe(openEnded);
  });

  it("returns null when nothing applies at that date", () => {
    expect(resolveCompensationAt("person_1", new Date("2025-01-01T00:00:00.000Z"), [a])).toBeNull();
  });

  it("ignores agreements belonging to another person", () => {
    expect(resolveCompensationAt("person_2", new Date("2026-06-01T00:00:00.000Z"), [a])).toBeNull();
  });

  it("ignores agreements from another organisation when the caller scopes by tenant", () => {
    const foreign = agreement({ organizationId: "org_other" });
    const at = new Date("2026-06-01T00:00:00.000Z");
    // Unscoped, the question spans every tenant the person was ever paid by.
    expect(resolveCompensationAt("person_1", at, [foreign])).toBe(foreign);
    // Scoped, an org in another tenant cannot answer for this one (ADR-0011).
    expect(resolveCompensationAt("person_1", at, [foreign], ORG)).toBeNull();
  });

  it("hands over cleanly between two agreements that abut exactly", () => {
    // validTo of the first equals validFrom of the second: no instant is
    // covered twice and none is missed.
    const first = agreement({
      agreementId: "ca_1",
      baseSalary: money("50000.0000", "INR"),
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: new Date("2026-07-01T00:00:00.000Z"),
    });
    const second = agreement({
      agreementId: "ca_2",
      baseSalary: money("60000.0000", "INR"),
      validFrom: new Date("2026-07-01T00:00:00.000Z"),
      validTo: new Date("2027-01-01T00:00:00.000Z"),
    });
    const all = [first, second];

    const beforeHandover = resolveCompensationAt("person_1", new Date("2026-06-30T23:59:59.999Z"), all);
    const atHandover = resolveCompensationAt("person_1", new Date("2026-07-01T00:00:00.000Z"), all);

    expect(beforeHandover).toBe(first);
    expect(atHandover).toBe(second);
    expect(atHandover?.baseSalary.minor).toBe(600_000_000n);
  });
});

describe("overlapping agreements are a bug, not a stacking rule", () => {
  // DECISION: overlap is refused. Two agreements covering the same instant would
  // mean two salaries payable for one person at one time, and "resolve" would
  // have to pick one — which is indistinguishable from paying the wrong one.
  // Real-world situations that produce overlapping rows (a backdated raise, a
  // contract re-issued with a widened window) are corrected by amending the
  // window, which leaves a trail, not by letting the reader guess.

  const first = agreement({
    agreementId: "ca_1",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    validTo: new Date("2026-09-01T00:00:00.000Z"),
  });
  const second = agreement({
    agreementId: "ca_2",
    validFrom: new Date("2026-07-01T00:00:00.000Z"),
    validTo: new Date("2027-01-01T00:00:00.000Z"),
  });

  it("detects the overlap between two windows", () => {
    expect(hasOverlapAt(first, second)).toBe(true);
  });

  it("does not report an overlap when two windows merely touch", () => {
    const abutting = agreement({
      agreementId: "ca_2",
      validFrom: new Date("2026-09-01T00:00:00.000Z"),
      validTo: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(hasOverlapAt(first, abutting)).toBe(false);
  });

  it("does not compare two agreements belonging to different people", () => {
    expect(hasOverlapAt(first, agreement({ agreementId: "ca_2", personId: "person_2" }))).toBe(false);
  });

  it("does not compare two agreements from different organisations", () => {
    expect(hasOverlapAt(first, agreement({ agreementId: "ca_2", organizationId: "org_other" }))).toBe(false);
  });

  it("throws from resolveCompensationAt rather than silently picking one", () => {
    expect(() => resolveCompensationAt("person_1", new Date("2026-08-01T00:00:00.000Z"), [first, second])).toThrow(
      /ca_1|ca_2/,
    );
  });

  it("names both agreements in the conflict so the operator can act", () => {
    let message = "";
    try {
      resolveCompensationAt("person_1", new Date("2026-08-01T00:00:00.000Z"), [first, second]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("ca_1");
    expect(message).toContain("ca_2");
  });

  it("resolves fine at a date where the overlap is not in force", () => {
    // The conflict is only a conflict where both windows are open. Outside the
    // overlap the answer is unambiguous and no throw is warranted.
    expect(resolveCompensationAt("person_1", new Date("2026-02-01T00:00:00.000Z"), [first, second])).toBe(first);
    expect(resolveCompensationAt("person_1", new Date("2026-11-01T00:00:00.000Z"), [first, second])).toBe(second);
  });

  it("reports the conflicting pair from assertNoOverlappingAgreements", () => {
    expect(() => assertNoOverlappingAgreements([first, second])).toThrow(/ca_1.*ca_2|s/s);
  });

  it("reports an open-ended window as open, rather than as a missing date", () => {
    // An operator reading a conflict report needs to see that one of the two
    // agreements has no end, not an `undefined` that looks like a bug in the
    // report itself.
    const openEnded = agreement({
      agreementId: "ca_open",
      validFrom: new Date("2026-07-01T00:00:00.000Z"),
      validTo: null,
    });

    let message = "";
    try {
      resolveCompensationAt("person_1", new Date("2026-08-01T00:00:00.000Z"), [first, openEnded]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("open");
  });

  it("accepts a clean history from assertNoOverlappingAgreements", () => {
    const abutting = agreement({
      agreementId: "ca_2",
      validFrom: new Date("2026-09-01T00:00:00.000Z"),
      validTo: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(() => assertNoOverlappingAgreements([first, abutting])).not.toThrow();
  });

  it("accepts interleaved agreements belonging to different people", () => {
    const p2 = agreement({ agreementId: "ca_p2", personId: "person_2" });
    expect(() => assertNoOverlappingAgreements([first, p2])).not.toThrow();
  });

  it("accepts an empty history", () => {
    expect(() => assertNoOverlappingAgreements([])).not.toThrow();
  });

  it("accepts a single agreement", () => {
    expect(() => assertNoOverlappingAgreements([first])).not.toThrow();
  });

  it("catches an overlap that is not adjacent in the list", () => {
    const middle = agreement({
      agreementId: "ca_mid",
      validFrom: new Date("2026-10-01T00:00:00.000Z"),
      validTo: new Date("2027-01-01T00:00:00.000Z"),
    });
    // first spans Jan-Sep, second spans Jul-Jan, third spans Oct-Jan. The only
    // conflict is first/second, and they are not next to each other after a sort.
    expect(() => assertNoOverlappingAgreements([middle, first, second])).toThrow(/ca_1.*ca_2|s/s);
  });

  it("ignores an agreement compared against itself", () => {
    // `hasOverlapAt` must not report a document as overlapping itself, or the
    // pairwise scan above would throw on any single-row history.
    expect(hasOverlapAt(first, first)).toBe(false);
  });

  it("lists every agreement in force at an instant", () => {
    // The un-throwing counterpart, for reports that need to *show* the conflict
    // rather than refuse it.
    expect(agreementsCovering("person_1", new Date("2026-08-01T00:00:00.000Z"), [first, second])).toEqual([
      first,
      second,
    ]);
  });
});

describe("totalAnnualCompensationAt", () => {
  it("adds base salary and bonus in exact minor units", () => {
    // 50,000 + 12.5% of 50,000 = 56,250. Computed as bigints: 12.5% is stored
    // as 125_000 scaled by 1e4, so the product divides exactly.
    const a = agreement({ bonusPercent: "12.5" });
    const total = totalAnnualCompensationAt("person_1", new Date("2026-06-01T00:00:00.000Z"), [a]);

    expect(total?.currency).toBe("INR");
    expect(total?.minor).toBe(562_500_000n);
    expect(total?.toDecimal()).toBe("56250.0000");
  });

  it("is exact and explicitly truncating for a percentage that does not divide evenly", () => {
    // 33.3333% of 33.3333 INR does not land on a whole minor unit. Rather than
    // round — which would invent or destroy money — the minor-unit division is
    // floored, and the floor is pinned here so the convention cannot move.
    const a = agreement({ baseSalary: money("33.3333", "INR"), bonusPercent: "33.3333" });
    const total = totalAnnualCompensationAt("person_1", new Date("2026-06-01T00:00:00.000Z"), [a]);

    // 333333 * 333333 / 10000 = 111110.8889 -> 111110 minor units of bonus.
    expect(total?.minor).toBe(333333n + 111_110n);
  });

  it("returns just the base salary when no bonus is stated", () => {
    const total = totalAnnualCompensationAt("person_1", new Date("2026-06-01T00:00:00.000Z"), [agreement()]);
    expect(total?.minor).toBe(500_000_000n);
  });

  it("returns null when no agreement applies, rather than a zero in an invented currency", () => {
    // `../money` has no global currency by design; this module will not invent
    // one to fill a gap.
    expect(totalAnnualCompensationAt("person_1", new Date("2025-01-01T00:00:00.000Z"), [agreement()])).toBeNull();
  });

  it("scopes to a tenant when asked", () => {
    const foreign = agreement({ agreementId: "ca_foreign", organizationId: "org_other" });
    const at = new Date("2026-06-01T00:00:00.000Z");
    expect(totalAnnualCompensationAt("person_1", at, [foreign], ORG)).toBeNull();
    expect(totalAnnualCompensationAt("person_1", at, [foreign])).not.toBeNull();
  });

  it("propagates the overlap conflict rather than totalling an ambiguous figure", () => {
    const first = agreement({
      agreementId: "ca_1",
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      validTo: new Date("2026-09-01T00:00:00.000Z"),
    });
    const second = agreement({
      agreementId: "ca_2",
      validFrom: new Date("2026-07-01T00:00:00.000Z"),
      validTo: new Date("2027-01-01T00:00:00.000Z"),
    });

    expect(() => totalAnnualCompensationAt("person_1", new Date("2026-08-01T00:00:00.000Z"), [first, second])).toThrow(
      /ca_1|ca_2/,
    );
  });
});