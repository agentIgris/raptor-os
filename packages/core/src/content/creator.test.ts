import { describe, expect, it } from "vitest";

import { PLATFORMS, createCreatorProfile, createPlatformAccount } from "./creator.js";

const LINKED_AT = new Date("2026-01-05T00:00:00.000Z");

describe("createCreatorProfile", () => {
  it("keys on a person id and nothing else", () => {
    // The whole point of ADR-0018 in one assertion: a creator profile is a
    // *projection of a person*, so it names `person.id`. If this ever grew an
    // `email`, a `displayName` that was its own source of truth, or a
    // `creatorId` pointing somewhere else, it would be the third identity model.
    const profile = createCreatorProfile({
      creatorProfileId: "creator_profile_1",
      organizationId: "org_1",
      personId: "person_creator",
      handle: "@raptor",
      createdAt: LINKED_AT,
    });

    expect(Object.keys(profile).sort()).toEqual([
      "createdAt",
      "creatorProfileId",
      "handle",
      "organizationId",
      "personId",
    ]);
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("refuses a profile with no personId, which is exactly a second identity", () => {
    expect(() =>
      createCreatorProfile({
        creatorProfileId: "creator_profile_1",
        organizationId: "org_1",
        personId: "",
        handle: "@raptor",
        createdAt: LINKED_AT,
      }),
    ).toThrow(/personId/i);
  });

  it("refuses a blank profile id and a blank organisation id", () => {
    const base = {
      creatorProfileId: "creator_profile_1",
      organizationId: "org_1",
      personId: "person_creator",
      handle: "@raptor",
      createdAt: LINKED_AT,
    };

    expect(() => createCreatorProfile({ ...base, creatorProfileId: " " })).toThrow(/creatorProfileId/i);
    expect(() => createCreatorProfile({ ...base, organizationId: "" })).toThrow(/organizationId/i);
  });

  it("refuses a blank handle, because a profile nobody can find is not a profile", () => {
    expect(() =>
      createCreatorProfile({
        creatorProfileId: "creator_profile_1",
        organizationId: "org_1",
        personId: "person_creator",
        handle: "   ",
        createdAt: LINKED_AT,
      }),
    ).toThrow(/handle/i);
  });

  it("refuses an invalid creation instant", () => {
    expect(() =>
      createCreatorProfile({
        creatorProfileId: "creator_profile_1",
        organizationId: "org_1",
        personId: "person_creator",
        handle: "@raptor",
        createdAt: new Date("never"),
      }),
    ).toThrow(/createdAt/i);
  });

  it("refuses a handle that is not a handle, rather than storing a URL in a handle column", () => {
    expect(() =>
      createCreatorProfile({
        creatorProfileId: "creator_profile_1",
        organizationId: "org_1",
        personId: "person_creator",
        handle: "https://instagram.com/raptor",
        createdAt: LINKED_AT,
      }),
    ).toThrow(/handle/i);
  });
});

describe("createCreatorProfile edge cases", () => {
  it("refuses a blank profile id, which would name no profile", () => {
    expect(() =>
      createCreatorProfile({
        creatorProfileId: " ",
        organizationId: "org_1",
        personId: "person_creator",
        handle: "@raptor",
        createdAt: LINKED_AT,
      }),
    ).toThrow(/creatorProfileId/i);
  });

  it("refuses a profile with no usable creation instant", () => {
    expect(() =>
      createCreatorProfile({
        creatorProfileId: "creator_profile_1",
        organizationId: "org_1",
        personId: "person_creator",
        handle: "@raptor",
        createdAt: new Date("never"),
      }),
    ).toThrow(/createdAt/i);
  });
});

describe("createPlatformAccount", () => {
  it("returns a frozen account belonging to a profile and a person", () => {
    const account = createPlatformAccount({
      platformAccountId: "acct_1",
      organizationId: "org_1",
      creatorProfileId: "creator_profile_1",
      personId: "person_creator",
      platform: "instagram",
      handle: "@raptor",
      linkedAt: LINKED_AT,
    });

    expect(account.platformAccountId).toBe("acct_1");
    expect(account.personId).toBe("person_creator");
    expect(Object.isFrozen(account)).toBe(true);
  });

  it("carries the person id as well as the profile, so the link is checkable without a join", () => {
    // Same reasoning as `ContentApproval.creatorPersonId`: an authorisation
    // decision must be answerable from the record in front of you, not only from
    // a lookup that might not run.
    const account = createPlatformAccount({
      platformAccountId: "acct_1",
      organizationId: "org_1",
      creatorProfileId: "creator_profile_1",
      personId: "person_creator",
      platform: "instagram",
      handle: "@raptor",
      linkedAt: LINKED_AT,
    });

    expect(account.personId).toBe("person_creator");
    expect(account.creatorProfileId).toBe("creator_profile_1");
  });

  it("refuses an unknown platform rather than storing whatever string arrived", () => {
    expect(() =>
      createPlatformAccount({
        platformAccountId: "acct_1",
        organizationId: "org_1",
        creatorProfileId: "creator_profile_1",
        personId: "person_creator",
        platform: "myspace" as never,
        handle: "@raptor",
        linkedAt: LINKED_AT,
      }),
    ).toThrow(/platform/i);
  });

  it("declares a small closed platform vocabulary", () => {
    // Free-text platform names are how "Instagram", "instagram" and "IG" become
    // three accounts for one person and the follower count becomes a fiction.
    expect(PLATFORMS.length).toBeGreaterThan(0);
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
  });

  it("refuses a blank handle, account id or person id", () => {
    const base = {
      platformAccountId: "acct_1",
      organizationId: "org_1",
      creatorProfileId: "creator_profile_1",
      personId: "person_creator",
      platform: "instagram" as const,
      handle: "@raptor",
      linkedAt: LINKED_AT,
    };

    expect(() => createPlatformAccount({ ...base, handle: " " })).toThrow(/handle/i);
    expect(() => createPlatformAccount({ ...base, platformAccountId: "" })).toThrow(/platformAccountId/i);
    expect(() => createPlatformAccount({ ...base, personId: "" })).toThrow(/personId/i);
    expect(() => createPlatformAccount({ ...base, creatorProfileId: "" })).toThrow(/creatorProfileId/i);
    expect(() => createPlatformAccount({ ...base, linkedAt: new Date("never") })).toThrow(/linkedAt/i);
  });

  it("refuses a platform account with no organisation, because tenancy scopes every read", () => {
    expect(() =>
      createPlatformAccount({
        platformAccountId: "acct_1",
        organizationId: "",
        creatorProfileId: "creator_profile_1",
        personId: "person_creator",
        platform: "instagram",
        handle: "@raptor",
        linkedAt: LINKED_AT,
      }),
    ).toThrow(/organizationId/i);
  });

  it("refuses a handle containing whitespace, since handles do not have any", () => {
    expect(() =>
      createPlatformAccount({
        platformAccountId: "acct_1",
        organizationId: "org_1",
        creatorProfileId: "creator_profile_1",
        personId: "person_creator",
        platform: "instagram",
        handle: "@raptor esports",
        linkedAt: LINKED_AT,
      }),
    ).toThrow(/handle/i);
  });
});