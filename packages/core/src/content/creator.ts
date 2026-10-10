/**
 * Creator profiles and platform accounts — **projections of a person**, not
 * identities.
 *
 * ## Why this file exists at all
 *
 * Because the design spec's CONTENT context lists `CreatorProfile` and
 * `PlatformAccount`, and the obvious way to model those is to give them their own
 * ids and let them grow an identity of their own. That is precisely how ADR-0018
 * happened here once already: `person` in the domain, Better Auth's `"user"` in
 * the auth layer, and **nothing joining them**. Every authorisation decision keyed
 * on `person_id`, every authentication decision keyed on `"user"."id"`, and the
 * one function meant to bridge them could not execute.
 *
 * So the rule this module states, and its tests enforce, is:
 *
 * - A {@link CreatorProfile} is keyed on `personId`. It has no email, no display
 *   name that is its own source of truth, and no `creatorId` pointing at another
 *   table.
 * - A {@link PlatformAccount} carries **both** the profile it belongs to and the
 *   `personId`, so the link is checkable from the record in front of you rather
 *   than only from a join that might not run — the same reasoning as
 *   `ContentApproval.creatorPersonId` in `./approval.ts`.
 *
 * Deleting a profile deletes a profile. A person with no profile is still a
 * person: they may be rostered, paid and contracted, exactly as ADR-0018
 * requires.
 *
 * **Product decision.** The platform vocabulary is designed here: the legacy
 * source had no creator concept to recover. It is deliberately a small closed
 * set — free-text platform names are how "Instagram", "instagram" and "IG"
 * become three accounts for one person and the follower count becomes a fiction.
 *
 * Pure: no database, no network, no clock. Every instant is supplied.
 */

/**
 * The platforms a creator account can exist on.
 *
 * Closed, because a platform name that is free text will accumulate spellings,
 * and a follower count summed across spellings is a number that means nothing.
 */
export const PLATFORMS = ["instagram", "youtube", "twitch", "x", "tiktok", "linkedin"] as const;

export type Platform = (typeof PLATFORMS)[number];

/**
 * A creator's public identity on this organisation's roster.
 *
 * A projection of `person`, not a second identity. `handle` is the one field that
 * looks identity-ish, and it is scoped by `organizationId`: the same person can
 * present a different handle to a different sponsor, and only one of those is
 * ever "the" profile.
 */
export interface CreatorProfile {
  readonly creatorProfileId: string;
  readonly organizationId: string;
  /** A `person.id`. The only identity reference on this record. */
  readonly personId: string;
  readonly handle: string;
  readonly createdAt: Date;
}

/**
 * A handle, validated.
 *
 * Leading `@` permitted, everything else alphanumeric plus `_`, `.` and `-`, no
 * whitespace. A URL in a handle column is a schema failure waiting to be read as
 * a link, and whitespace in a handle is how two spellings of one account become
 * two accounts.
 */
const HANDLE_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate and freeze a creator profile.
 *
 * Refuses a blank profile id, organisation id, person id or handle, an invalid
 * instant, and a handle that is not a handle.
 */
export function createCreatorProfile(input: CreatorProfile): CreatorProfile {
  if (input.creatorProfileId.trim() === "") {
    throw new Error("A creator profile must carry a non-empty creatorProfileId");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Creator profile ${input.creatorProfileId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`,
    );
  }
  if (input.personId.trim() === "") {
    throw new Error(
      `Creator profile ${input.creatorProfileId} names no personId. A creator is a person (ADR-0018): a profile with its own identity is the third competing model, and the third is the one that eventually wins by accident.`,
    );
  }
  if (!HANDLE_PATTERN.test(input.handle)) {
    throw new Error(
      `Creator profile ${input.creatorProfileId} has handle ${JSON.stringify(input.handle)}, which is not a handle. Handles are alphanumeric with _ . and -, optionally prefixed with @, and carry no spaces or URLs.`,
    );
  }
  if (input.createdAt === null || input.createdAt === undefined || Number.isNaN(input.createdAt.getTime())) {
    throw new Error(`Creator profile ${input.creatorProfileId} has no usable createdAt`);
  }

  return Object.freeze({
    creatorProfileId: input.creatorProfileId,
    organizationId: input.organizationId,
    personId: input.personId,
    handle: input.handle,
    createdAt: input.createdAt,
  });
}

/** One social account belonging to a creator, on one platform. */
export interface PlatformAccount {
  readonly platformAccountId: string;
  readonly organizationId: string;
  readonly creatorProfileId: string;
  /** Carried from the profile so the person behind the account is one field away. */
  readonly personId: string;
  readonly platform: Platform;
  readonly handle: string;
  readonly linkedAt: Date;
}

/**
 * Validate and freeze a platform account.
 *
 * Refuses an off-vocabulary platform, a blank id in any position, a handle that
 * is not a handle, and an invalid instant.
 */
export function createPlatformAccount(input: PlatformAccount): PlatformAccount {
  if (input.platformAccountId.trim() === "") {
    throw new Error("A platform account must carry a non-empty platformAccountId");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Platform account ${input.platformAccountId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`,
    );
  }
  if (input.creatorProfileId.trim() === "") {
    throw new Error(
      `Platform account ${input.platformAccountId} names no creatorProfileId. An account belongs to a profile, and a profile belongs to a person; anything else is a new identity.`,
    );
  }
  if (input.personId.trim() === "") {
    throw new Error(
      `Platform account ${input.platformAccountId} names no personId. Carrying the person on the account is what makes "who owns this reach?" answerable without a join (ADR-0018).`,
    );
  }
  if (!(PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new Error(
      `Platform account ${input.platformAccountId} has unknown platform ${JSON.stringify(input.platform)}; expected one of ${PLATFORMS.join(", ")}. Free-text platform names are how one account becomes three spellings and a follower total becomes a fiction.`,
    );
  }
  if (!HANDLE_PATTERN.test(input.handle)) {
    throw new Error(
      `Platform account ${input.platformAccountId} has handle ${JSON.stringify(input.handle)}, which is not a handle. Handles are alphanumeric with _ . and -, optionally prefixed with @, and carry no spaces.`,
    );
  }
  if (input.linkedAt === null || input.linkedAt === undefined || Number.isNaN(input.linkedAt.getTime())) {
    throw new Error(`Platform account ${input.platformAccountId} has no usable linkedAt`);
  }

  return Object.freeze({
    platformAccountId: input.platformAccountId,
    organizationId: input.organizationId,
    creatorProfileId: input.creatorProfileId,
    personId: input.personId,
    platform: input.platform,
    handle: input.handle,
    linkedAt: input.linkedAt,
  });
}