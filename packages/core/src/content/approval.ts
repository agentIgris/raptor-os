/**
 * Review and approval, and the separation of duties between them.
 *
 * ## A creator is a `personId`
 *
 * {@link ContentItem.creatorPersonId} is a reference to `person.id` and nothing
 * else. There is no `creatorId` pointing at a different table, no embedded name,
 * no email, and no second identity type — because ADR-0018 exists precisely
 * because this repository once had two competing identity models that nothing
 * joined. Adding a third would be the same defect wearing different clothes.
 *
 * A `CreatorProfile` (see `./creator.ts`) is a **projection** of a person: their
 * handles and their linked platform accounts. It is keyed on the same
 * `personId`, and deleting it deletes a profile, not a human.
 *
 * ## Approval is a separate act from writing, performed by a different person
 *
 * {@link approveContent} refuses an approval by the item's own creator. This is
 * the same control `tryout/state-machine.ts` applies to `evaluated → selected`:
 * the person who scored a candidate may not hire them, and the person who wrote a
 * piece may not sign it off.
 *
 * The check is on **person ids**, not on names or roles. The actual conflict is
 * "may this person decide on their own work"; a role check would ask "may this
 * job do this", which is a different question and the wrong one — a brand-new
 * editor with the right role has the same conflict as the author.
 *
 * Requesting review is *not* approving it, so {@link recordReviewRequest} carries
 * no such guard. Refusing an author the ability to submit their own work would be
 * a different control, and it is not this one.
 *
 * Pure: no database, no network, no clock. `at` is always supplied.
 */

import type { ContentItem } from "./item.js";

/** One person's approval of one piece of content. */
export interface ContentApproval {
  readonly contentId: string;
  readonly organizationId: string;
  /** Carried onto the record so the conflict is checkable without a join. */
  readonly creatorPersonId: string;
  readonly approvedBy: string;
  readonly approvedAt: Date;
  readonly notes?: string;
}

export interface ApproveContentInput {
  readonly content: ContentItem;
  /** The person signing off. Must differ from `content.creatorPersonId`. */
  readonly approvedBy: string;
  /** Injected clock. Required, never defaulted. */
  readonly at: Date;
  readonly notes?: string;
}

/**
 * Record an approval of a piece of content.
 *
 * Refuses an approval by the item's creator, an unattributed approval, an
 * approval dated before the item existed, and whitespace-only notes.
 *
 * Note what this function does **not** do: it does not check that the item is in
 * `review`, and it does not consume or mutate the item. Those are the caller's
 * facts. A guard that silently ignored the arguments it was not given would be
 * worse than no guard, because it would read as enforcement.
 */
export function approveContent(input: ApproveContentInput): ContentApproval {
  const { content, approvedBy, at } = input;

  if (content === null || typeof content !== "object") {
    throw new Error("Invalid content: an approval requires the item being approved");
  }
  if (content.contentId.trim() === "") {
    throw new Error("Invalid contentId: an approval must name the item it approves");
  }
  if (content.organizationId.trim() === "") {
    throw new Error(`Invalid organizationId: approval of ${content.contentId} has no tenancy scope`);
  }
  if (content.creatorPersonId.trim() === "") {
    throw new Error(`Content ${content.contentId} names no creatorPersonId, so nobody can be shown to have approved their own work`);
  }
  if (typeof approvedBy !== "string" || approvedBy.trim() === "") {
    throw new Error(
      `Approval of ${content.contentId} has a blank approvedBy. Approval is a decision somebody makes; an unattributed approval is not a decision.`,
    );
  }
  if (at === null || at === undefined || Number.isNaN(at.getTime())) {
    throw new Error(`Approval of ${content.contentId} has an invalid at`);
  }

  // Trimmed on both sides before comparing. `" person_creator"` is a different
  // string and would otherwise sail past an identity check, which is not a
  // defence of anything — it is a spelling of the same person. `creatorPersonId`
  // is validated as non-blank by `createContentItem`, and the trim here costs
  // nothing either way.
  if (approvedBy.trim() === content.creatorPersonId.trim()) {
    throw new Error(
      `Separation of duties violated: ${approvedBy} created content ${content.contentId} and may not also approve it. An author who signs off their own work has not been reviewed, and the record would claim otherwise.`,
    );
  }

  if (at.getTime() < content.createdAt.getTime()) {
    throw new Error(
      `Cannot approve content ${content.contentId} at ${at.toISOString()}: it was created at ${content.createdAt.toISOString()}, and an approval cannot predate the work it approves`,
    );
  }

  if (input.notes !== undefined && input.notes.trim() === "") {
    throw new Error(`Approval of ${content.contentId} has whitespace-only notes; an empty note is not a note`);
  }

  return Object.freeze({
    contentId: content.contentId,
    organizationId: content.organizationId,
    creatorPersonId: content.creatorPersonId,
    approvedBy,
    approvedAt: at,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  });
}

/** A request that a piece of content be looked at. */
export interface ReviewRequest {
  readonly contentId: string;
  readonly organizationId: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
}

export interface RecordReviewRequestInput {
  readonly content: ContentItem;
  readonly requestedBy: string;
  readonly at: Date;
}

/**
 * Record that content has been submitted for review.
 *
 * No separation-of-duties guard here, and deliberately so: the author is normally
 * the person who submits their own work, and refusing that would not be a
 * control against self-approval, it would just be a control against publishing.
 * The guard belongs on the approval, which is the act that confers standing.
 */
export function recordReviewRequest(input: RecordReviewRequestInput): ReviewRequest {
  const { content, requestedBy, at } = input;

  if (typeof requestedBy !== "string" || requestedBy.trim() === "") {
    throw new Error(`Review request for ${content.contentId} has a blank requestedBy`);
  }
  if (at === null || at === undefined || Number.isNaN(at.getTime())) {
    throw new Error(`Review request for ${content.contentId} has an invalid at`);
  }

  return Object.freeze({
    contentId: content.contentId,
    organizationId: content.organizationId,
    requestedBy,
    requestedAt: at,
  });
}