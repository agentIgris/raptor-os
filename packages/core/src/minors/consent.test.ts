import { describe, expect, it } from "vitest";

import type { ConsentWithdrawal, GuardianConsent } from "./consent.js";
import {
  createGuardianConsent,
  isConsentEffective,
  resolveEngagementConsent,
  withdrawConsent,
} from "./consent.js";
import type { Person } from "./majority.js";

const ORG = "org_1";
const GRANTED_AT = new Date("2026-02-01T00:00:00.000Z");
const EXPIRES_AT = new Date("2027-02-01T00:00:00.000Z");

/** A fifteen-year-old: a minor, above the engagement floor. */
const MINOR: Person = { personId: "minor_1", birthDate: new Date("2011-03-15T00:00:00.000Z") };
/** A twelve-year-old: below the engagement floor entirely. */
const UNDER_TWELVE: Person = { personId: "minor_2", birthDate: new Date("2014-03-15T00:00:00.000Z") };
const ADULT: Person = { personId: "adult_1", birthDate: new Date("2000-03-15T00:00:00.000Z") };

function consent(overrides: Partial<Parameters<typeof createGuardianConsent>[0]> = {}): GuardianConsent {
  return createGuardianConsent({
    consentId: "gc_1",
    minorId: MINOR.personId,
    guardianId: "guardian_1",
    engagementId: "engagement_1",
    organizationId: ORG,
    grantedAt: GRANTED_AT,
    expiresAt: EXPIRES_AT,
    evidenceReference: "notarised_letter_2026_02_01",
    ...overrides,
  });
}

describe("createGuardianConsent", () => {
  it("records who consented, for whom, to which engagement, and until when", () => {
    const c = consent();
    expect(c.minorId).toBe(MINOR.personId);
    expect(c.guardianId).toBe("guardian_1");
    expect(c.engagementId).toBe("engagement_1");
    expect(c.expiresAt).toEqual(EXPIRES_AT);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("requires independently provable evidence, not just a name", () => {
    // A guardian's word is not a control. Without something to point at later,
    // "the guardian consented" is unfalsifiable — which is the same as untrue.
    expect(() => consent({ evidenceReference: "  " })).toThrow(/evidence/i);
  });

  it("refuses consent where the guardian IS the minor", () => {
    // The conflict case. A person cannot consent to their own engagement on
    // their own behalf: the whole point of guardian consent is that the person
    // whose interests are at stake is not the one deciding.
    expect(() => consent({ guardianId: MINOR.personId })).toThrow(/cannot consent to themselves/i);
  });

  it("refuses consent where the guardian is the minor, even with matching org", () => {
    expect(() => consent({ minorId: ADULT.personId, guardianId: ADULT.personId })).toThrow(/themselves/i);
  });

  it("requires an engagement: consent to nothing proves nothing", () => {
    expect(() => consent({ engagementId: " " })).toThrow(/engagementId/i);
  });

  it("requires an expiry: guardian consent is not a standing authorisation", () => {
    expect(() =>
      createGuardianConsent({
        consentId: "gc_1",
        minorId: MINOR.personId,
        guardianId: "guardian_1",
        engagementId: "engagement_1",
        organizationId: ORG,
        grantedAt: GRANTED_AT,
        expiresAt: null as unknown as Date,
        evidenceReference: "evidence_1",
      }),
    ).toThrow(/expire|expiresAt/i);
  });

  it("rejects an expiry at or before the grant", () => {
    expect(() => consent({ expiresAt: GRANTED_AT })).toThrow(/expiresAt/i);
    expect(() => consent({ expiresAt: new Date("2026-01-01T00:00:00.000Z") })).toThrow(/expiresAt/i);
  });

  it("requires the guardian to be named", () => {
    expect(() => consent({ guardianId: "" })).toThrow(/guardianId/i);
  });

  it("requires a consent id: an unnamed consent cannot be withdrawn later", () => {
    expect(() => consent({ consentId: "  " })).toThrow(/consentId/i);
  });

  it("requires the minor to be named", () => {
    expect(() => consent({ minorId: " " })).toThrow(/minorId/i);
  });
});

describe("isConsentEffective — the window boundary", () => {
  const c = consent();

  it("is effective at the instant it was granted", () => {
    expect(isConsentEffective(c, GRANTED_AT)).toBe(true);
  });

  it("is not effective one millisecond before it was granted", () => {
    expect(isConsentEffective(c, new Date("2026-01-31T23:59:59.999Z"))).toBe(false);
  });

  it("is NOT effective at the expiry instant: the window is half-open, like everywhere else", () => {
    expect(isConsentEffective(c, EXPIRES_AT)).toBe(false);
  });

  it("is effective one millisecond before expiry", () => {
    expect(isConsentEffective(c, new Date("2027-01-31T23:59:59.999Z"))).toBe(true);
  });
});

describe("resolveEngagementConsent", () => {
  const at = new Date("2026-06-01T00:00:00.000Z");

  it("lets an adult consent for themselves, with no guardian involved", () => {
    const status = resolveEngagementConsent({
      person: ADULT,
      engagementId: "engagement_1",
      consents: [],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "self_consented", personId: ADULT.personId });
  });

  it("admits a minor with a live guardian consent for that exact engagement", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "guardian_consented", consentId: "gc_1", guardianId: "guardian_1" });
  });

  it("refuses a minor with no consent on record", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "refused", reason: "no_consent_on_record", blockingConsentIds: [] });
  });

  it("refuses a consent given for a DIFFERENT engagement", () => {
    // Consent is to a specific engagement, not to the minor in general. A
    // global flag is exactly what this replaces.
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_OTHER",
      consents: [consent()],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "refused", reason: "no_consent_on_record", blockingConsentIds: [] });
  });

  it("refuses a consent given by a different guardian for someone else", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent({ consentId: "gc_other", minorId: "minor_someone_else" })],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "refused", reason: "no_consent_on_record", blockingConsentIds: [] });
  });

  it("refuses a consent from another organisation", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent({ consentId: "gc_foreign", organizationId: "org_other" })],
      withdrawals: [],
      at,
      organizationId: ORG,
    });

    expect(status).toEqual({ kind: "refused", reason: "no_consent_on_record", blockingConsentIds: [] });
  });

  it("admits a cross-tenant consent when the caller deliberately does not scope by tenant", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent({ consentId: "gc_foreign", organizationId: "org_other" })],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "guardian_consented", consentId: "gc_foreign", guardianId: "guardian_1" });
  });

  it("refuses an expired consent and says so", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [],
      at: new Date("2028-01-01T00:00:00.000Z"),
    });

    expect(status).toEqual({ kind: "refused", reason: "consent_expired", blockingConsentIds: ["gc_1"] });
  });

  it("refuses a consent at the exact instant it expires", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [],
      at: EXPIRES_AT,
    });

    expect(status).toEqual({ kind: "refused", reason: "consent_expired", blockingConsentIds: ["gc_1"] });
  });

  it("refuses a consent before it was granted, as not yet in force", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [],
      at: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(status).toEqual({ kind: "refused", reason: "not_yet_in_force", blockingConsentIds: ["gc_1"] });
  });

  it("blocks a child below the engagement floor even WITH a valid guardian consent", () => {
    // The floor is not a consent problem. No number of guardians makes a twelve
    // year old eligible.
    const status = resolveEngagementConsent({
      person: UNDER_TWELVE,
      engagementId: "engagement_1",
      consents: [consent({ consentId: "gc_child", minorId: UNDER_TWELVE.personId })],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "refused", reason: "below_engagement_minimum_age", blockingConsentIds: [] });
  });

  it("lets a person consent for themselves the moment they turn 18", () => {
    const almostEighteen: Person = { personId: "p", birthDate: new Date("2008-06-02T00:00:00.000Z") };
    expect(
      resolveEngagementConsent({ person: almostEighteen, engagementId: "e", consents: [], withdrawals: [], at: new Date("2026-06-01T23:59:59.999Z") }),
    ).toEqual({ kind: "refused", reason: "no_consent_on_record", blockingConsentIds: [] });
    expect(
      resolveEngagementConsent({ person: almostEighteen, engagementId: "e", consents: [], withdrawals: [], at: new Date("2026-06-02T00:00:00.000Z") }),
    ).toEqual({ kind: "self_consented", personId: "p" });
  });
});

describe("withdrawal propagates: the consequences are tested, not asserted", () => {
  const at = new Date("2026-06-01T00:00:00.000Z");
  const AFTER = new Date("2026-05-01T00:00:00.000Z");

  function withdrawal(overrides: Partial<ConsentWithdrawal> = {}): ConsentWithdrawal {
    return {
      consentId: "gc_1",
      withdrawnAt: AFTER,
      withdrawnBy: "guardian_1",
      reason: "guardian_withdrew",
      organizationId: ORG,
      ...overrides,
    };
  }

  it("removes the consent, and the same engagement that was admissible is now refused", () => {
    const before = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [],
      at,
    });
    const after = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [withdrawal()],
      at,
    });

    expect(before.kind).toBe("guardian_consented");
    // This is the propagation: same person, same engagement, same date, one
    // appended withdrawal, and the answer flips. Nothing about the minor
    // changed; the authorisation did.
    expect(after).toEqual({ kind: "refused", reason: "consent_withdrawn", blockingConsentIds: ["gc_1"] });
  });

  it("leaves the consent record itself untouched", () => {
    const original = consent();
    withdrawConsent({ consent: original, at: AFTER, withdrawnBy: "guardian_1", reason: "guardian_withdrew" });

    expect(original.guardianId).toBe("guardian_1");
    expect(original.engagementId).toBe("engagement_1");
    expect(Object.isFrozen(original)).toBe(true);
  });

  it("does not withdraw a consent dated before it was granted", () => {
    expect(() =>
      withdrawConsent({
        consent: consent(),
        at: new Date("2026-01-01T00:00:00.000Z"),
        withdrawnBy: "guardian_1",
        reason: "guardian_withdrew",
      }),
    ).toThrow(/before|predate|granted/i);
  });

  it("names the withdrawing party", () => {
    expect(() =>
      withdrawConsent({ consent: consent(), at: AFTER, withdrawnBy: " ", reason: "guardian_withdrew" }),
    ).toThrow(/withdrawnBy|withdrew/i);
  });

  it("rejects a withdrawal with an invalid instant", () => {
    expect(() =>
      withdrawConsent({ consent: consent(), at: new Date("nonsense"), withdrawnBy: "guardian_1", reason: "guardian_withdrew" }),
    ).toThrow(/at/i);
  });

  it("ignores a withdrawal aimed at a different consent", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [withdrawal({ consentId: "gc_elsewhere" })],
      at,
    });

    expect(status).toEqual({ kind: "guardian_consented", consentId: "gc_1", guardianId: "guardian_1" });
  });

  it("ignores a withdrawal from another organisation", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent()],
      withdrawals: [withdrawal({ organizationId: "org_other" })],
      at,
    });

    expect(status).toEqual({ kind: "guardian_consented", consentId: "gc_1", guardianId: "guardian_1" });
  });

  it("does not let one guardian's withdrawal kill a second guardian's live consent", () => {
    // Two independent guardians both consented; one withdraws, and the other
    // consent still stands. Withdrawal removes the consent it names, not every
    // consent the minor happens to have.
    const second = consent({ consentId: "gc_2", guardianId: "guardian_2" });
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent(), second],
      withdrawals: [withdrawal()],
      at,
    });

    expect(status).toEqual({ kind: "guardian_consented", consentId: "gc_2", guardianId: "guardian_2" });
  });

  it("refuses once every guardian consent has been withdrawn", () => {
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent(), consent({ consentId: "gc_2", guardianId: "guardian_2" })],
      withdrawals: [withdrawal(), withdrawal({ consentId: "gc_2" })],
      at,
    });

    expect(status).toEqual({
      kind: "refused",
      reason: "consent_withdrawn",
      blockingConsentIds: ["gc_1", "gc_2"],
    });
  });

  it("still admits the engagement for an adult, whatever happened to a stale consent", () => {
    const status = resolveEngagementConsent({
      person: ADULT,
      engagementId: "engagement_1",
      consents: [consent({ consentId: "gc_stale", minorId: ADULT.personId })],
      withdrawals: [withdrawal({ consentId: "gc_stale" })],
      at,
    });

    // A withdrawn minor-consent must never *create* a bar on an adult.
    expect(status).toEqual({ kind: "self_consented", personId: ADULT.personId });
  });

  it("reports every blocking consent id in sorted order, whatever order they arrive in", () => {
    const reversed = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [consent({ consentId: "gc_z" }), consent({ consentId: "gc_a", guardianId: "guardian_3" })],
      withdrawals: [withdrawal({ consentId: "gc_z" }), withdrawal({ consentId: "gc_a" })],
      at,
    });

    expect(reversed).toEqual({ kind: "refused", reason: "consent_withdrawn", blockingConsentIds: ["gc_a", "gc_z"] });
  });

  it("chooses between two live consents by consent id when they were granted at the same instant", () => {
    // The tie-break branch. Without it the winner would depend on the order rows
    // came back from the database, which is not a property anybody can rely on.
    const sameInstant = new Date("2026-02-01T00:00:00.000Z");
    const status = resolveEngagementConsent({
      person: MINOR,
      engagementId: "engagement_1",
      consents: [
        consent({ consentId: "gc_b", guardianId: "guardian_2", grantedAt: sameInstant }),
        consent({ consentId: "gc_a", guardianId: "guardian_1", grantedAt: sameInstant }),
      ],
      withdrawals: [],
      at,
    });

    expect(status).toEqual({ kind: "guardian_consented", consentId: "gc_a", guardianId: "guardian_1" });
  });
});