/**
 * The content item itself: identity, creator, and nothing about its state.
 *
 * ## A creator is a reference to a person, not a second identity
 *
 * {@link ContentItem.creatorPersonId} is a `person.id`. There is no embedded
 * name, no email, no handle and no `creatorId` pointing at some other table.
 *
 * ADR-0018 exists because this repository had **two** competing identity models
 * — `person` in the domain and Better Auth's `"user"` — and nothing joined them.
 * Every authorisation decision keyed on `person_id` and every authentication
 * decision keyed on `"user"."id"`, and the function meant to bridge them could
 * not execute. A content item that grew its own creator identity would be the
 * third such model, and the third is the one that eventually wins by accident.
 *
 * ## No state field
 *
 * There is no `status` on a content item, and that is the same structural
 * decision as `Obligation` carrying no `fulfilled` flag: a stored state is
 * written by a different code path from the one that records the transitions, and
 * the two are never compared. The state is derived by replaying
 * {@link ContentTransition} records through the table in `./lifecycle.ts`.
 *
 * Pure: no database, no network, no clock. `createdAt` is supplied.
 */

/**
 * A piece of content and who made it.
 *
 * `title` is here rather than in a separate metadata object because a title is
 * not a lifecycle fact — it does not change as the item moves from draft to
 * published — and splitting it out would give somebody a second place to edit.
 */
export interface ContentItem {
  readonly contentId: string;
  readonly organizationId: string;
  /** A `person.id`. Never a handle, never an email, never a separate creator entity. */
  readonly creatorPersonId: string;
  readonly title: string;
  readonly createdAt: Date;
}

/**
 * Validate and freeze a content item.
 *
 * Existence, identity and a valid `createdAt` are all that is checked, because all
 * that is all that is knowable here. Everything else about the item's standing is
 * derived.
 */
export function createContentItem(input: ContentItem): ContentItem {
  if (input.contentId.trim() === "") {
    throw new Error("Content must carry a non-empty contentId: an unnamed item cannot be reviewed or published");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Content ${input.contentId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`,
    );
  }
  if (input.creatorPersonId.trim() === "") {
    throw new Error(
      `Content ${input.contentId} names no creatorPersonId. A creator is a person (ADR-0018): storing a handle or an email here would introduce the second identity model this repository already had to undo.`,
    );
  }
  if (input.title.trim() === "") {
    throw new Error(`Content ${input.contentId} has a blank title`);
  }
  if (input.createdAt === null || input.createdAt === undefined || Number.isNaN(input.createdAt.getTime())) {
    throw new Error(`Content ${input.contentId} has no usable createdAt`);
  }

  return Object.freeze({
    contentId: input.contentId,
    organizationId: input.organizationId,
    creatorPersonId: input.creatorPersonId,
    title: input.title,
    createdAt: input.createdAt,
  });
}