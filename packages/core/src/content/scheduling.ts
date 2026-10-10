/**
 * Scheduling: publication is a named instant, supplied by the caller.
 *
 * ## No `Date.now()` in this file
 *
 * `publishAt` is data. So is `at`. The module has no clock of its own, which is
 * what lets "was this piece live on 3 April?" be answered for 3 April by code
 * built today rather than by whatever the process happened to think when the
 * question was asked.
 *
 * ## The boundary is inclusive, and pinned in both directions
 *
 * {@link isDueForPublication} is true at the publish instant exactly. `<` rather
 * than `<=` would report every piece of content as published one millisecond late,
 * which is a difference no human will ever notice and every reconciliation will
 * trip over. This is the same reasoning `minors/majority.ts` uses for the
 * eighteenth birthday, and it is the most likely way to get a scheduled boundary
 * wrong in either direction.
 *
 * It is also true *arbitrarily far afterwards*. A scheduler that was down when
 * the piece was due must not leave it stuck in `scheduled` for ever: the question
 * this function answers is "is this moment at or after the one named", not "is
 * this moment exactly the one named".
 *
 * ## Unscheduling appends
 *
 * {@link unschedulePublication} returns a separate record and leaves the schedule
 * standing. Cancelling is appending, exactly as a retraction in
 * `../obligations/evidence.ts` is — the plan existed, and the fact that it
 * existed is not erased by the fact that it was cancelled.
 *
 * A cancellation is refused *after* the publish instant, because by then the
 * content is out. Recording a "cancellation" of something already published
 * would produce a record that says the publication was prevented, which is the
 * opposite of what happened.
 *
 * **Product decision.** The minimum lead time is a design choice made here, not
 * a rule recovered from the legacy source: legacy had no content pipeline. It is
 * exported as a constant so it can be changed in one visible line, and pinned by
 * a test so changing it is a decision rather than an accident.
 *
 * Pure: no database, no network, no clock.
 */

import type { ContentApproval } from "./approval.js";

/**
 * The shortest gap between scheduling a publication and its publish instant.
 *
 * One day. The reasoning is not about clock precision — it is that a publication
 * with no gap is a publish button. With a day there is time to cancel, to notice
 * an embargo, and to check the time zone the audience is in.
 *
 * **Product decision**, exported so it is one visible edit rather than a literal
 * repeated at call sites.
 */
export const SCHEDULE_MINIMUM_LEAD_MS = 86_400_000;

/** A piece of content with a decided publication instant. */
export interface PublicationSchedule {
  readonly contentId: string;
  readonly organizationId: string;
  /** When it goes out. Data, never read from a clock. */
  readonly publishAt: Date;
  readonly scheduledAt: Date;
  readonly scheduledBy: string;
}

export interface SchedulePublicationInput {
  readonly contentId: string;
  readonly organizationId: string;
  /**
   * The approval this rests on, when the caller has it.
   *
   * Optional because the check is on the caller's own facts: a caller holding the
   * approval gets the extra guarantee that publication cannot predate sign-off,
   * and a caller that has already checked does not have to construct an approval
   * to prove something it knows.
   */
  readonly approval?: ContentApproval;
  readonly publishAt: Date;
  /** Injected clock: when the decision was made. Required, never defaulted. */
  readonly at: Date;
  readonly scheduledBy: string;
}

/**
 * Decide when a piece of content goes out.
 *
 * Refuses an undated or blank identity, a scheduler with no name, an invalid
 * instant, a publication dated before the approval it rests on, a publication in
 * the past, and a publication with less than {@link SCHEDULE_MINIMUM_LEAD_MS}
 * between it and the decision to schedule it.
 */
export function schedulePublication(input: SchedulePublicationInput): PublicationSchedule {
  if (input.contentId.trim() === "") {
    throw new Error("A publication schedule must name a contentId");
  }
  if (input.organizationId.trim() === "") {
    throw new Error(
      `Schedule for ${input.contentId} has a blank organizationId; tenancy scopes every read of this data (ADR-0011)`,
    );
  }
  if (typeof input.scheduledBy !== "string" || input.scheduledBy.trim() === "") {
    throw new Error(
      `Schedule for ${input.contentId} has a blank scheduledBy; somebody decided to publish this, and the decision has to be attributable`,
    );
  }
  if (input.publishAt === null || input.publishAt === undefined || Number.isNaN(input.publishAt.getTime())) {
    throw new Error(`Schedule for ${input.contentId} has no usable publishAt`);
  }
  if (input.at === null || input.at === undefined || Number.isNaN(input.at.getTime())) {
    throw new Error(`Schedule for ${input.contentId} has an invalid at`);
  }

  if (input.approval !== undefined && input.publishAt.getTime() < input.approval.approvedAt.getTime()) {
    throw new Error(
      `Content ${input.contentId} cannot be scheduled to publish at ${input.publishAt.toISOString()}: the approval it rests on is dated ${input.approval.approvedAt.toISOString()}. Content cannot go out before the sign-off that made publishing it legitimate.`,
    );
  }

  if (input.publishAt.getTime() <= input.at.getTime()) {
    throw new Error(
      `Content ${input.contentId} cannot be scheduled to publish at ${input.publishAt.toISOString()}: that moment is already in the past at the moment of scheduling, ${input.at.toISOString()}. A publication with no lead time is a publish button, not a schedule.`,
    );
  }

  if (input.publishAt.getTime() - input.at.getTime() < SCHEDULE_MINIMUM_LEAD_MS) {
    throw new Error(
      `Content ${input.contentId} is scheduled ${String(input.publishAt.getTime() - input.at.getTime())}ms from now, below the ${String(SCHEDULE_MINIMUM_LEAD_MS)}ms minimum lead time. See SCHEDULE_MINIMUM_LEAD_MS.`,
    );
  }

  return Object.freeze({
    contentId: input.contentId,
    organizationId: input.organizationId,
    publishAt: input.publishAt,
    scheduledAt: input.at,
    scheduledBy: input.scheduledBy,
  });
}

/**
 * Whether this moment has reached the scheduled publish instant.
 *
 * Inclusive at the boundary: true when `at` is exactly `publishAt`. Also true for
 * every later instant — a schedule missed while the scheduler was down is still
 * due, and content stuck in `scheduled` for ever is worse than content that went
 * out late.
 *
 * There is deliberately no `false` case after the boundary. "Overdue" is a
 * question for the caller to answer with its own reporting; answering it here
 * would mean this function knew something it does not, namely what actually
 * happened.
 */
export function isDueForPublication(schedule: PublicationSchedule, at: Date): boolean {
  if (at === null || at === undefined || Number.isNaN(at.getTime())) {
    throw new Error("isDueForPublication requires a valid at instant; there is no default clock in this package");
  }
  return at.getTime() >= schedule.publishAt.getTime();
}

/** A recorded cancellation of one schedule. Appended beside it, never in place of it. */
export interface ScheduleCancellation {
  readonly contentId: string;
  readonly organizationId: string;
  /** The instant that was cancelled, carried so the record stands on its own. */
  readonly publishAt: Date;
  readonly cancelledAt: Date;
  readonly cancelledBy: string;
  readonly reason: string;
}

export interface UnschedulePublicationInput {
  readonly schedule: PublicationSchedule;
  readonly at: Date;
  readonly cancelledBy: string;
  readonly reason: string;
}

/**
 * Append a cancellation of a schedule. The schedule is untouched and still stands
 * as a record.
 *
 * Refuses a cancellation dated before the schedule it cancels, one dated at or
 * after the publish instant (by then the content is out, and a record saying the
 * publication was prevented would be the opposite of what happened), and one with
 * no stated reason.
 *
 * The boundary is inclusive the same way {@link isDueForPublication} is:
 * cancelling at the publish instant is cancelling in time.
 */
export function unschedulePublication(input: UnschedulePublicationInput): ScheduleCancellation {
  const { schedule, at, cancelledBy, reason } = input;

  if (typeof cancelledBy !== "string" || cancelledBy.trim() === "") {
    throw new Error(
      `Cancellation of the publication schedule for ${schedule.contentId} has a blank cancelledBy; somebody stopped this publication and the decision has to be attributable`,
    );
  }
  if (at === null || at === undefined || Number.isNaN(at.getTime())) {
    throw new Error(`Cancellation of the publication schedule for ${schedule.contentId} has an invalid at`);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(
      `Cancellation of the publication schedule for ${schedule.contentId} states no reason. "It was cancelled" is not an answer to "why was our post pulled?"`,
    );
  }

  if (at.getTime() < schedule.scheduledAt.getTime()) {
    throw new Error(
      `The publication schedule for ${schedule.contentId} cannot be cancelled at ${at.toISOString()}: it was made at ${schedule.scheduledAt.toISOString()}, and a cancellation cannot predate the schedule it cancels`,
    );
  }

  if (at.getTime() >= schedule.publishAt.getTime()) {
    throw new Error(
      `The publication schedule for ${schedule.contentId} cannot be cancelled at ${at.toISOString()}: it was scheduled to publish at ${schedule.publishAt.toISOString()}, so it was already published. Recording a cancellation now would assert that the publication was prevented, which is the opposite of what happened.`,
    );
  }

  return Object.freeze({
    contentId: schedule.contentId,
    organizationId: schedule.organizationId,
    publishAt: schedule.publishAt,
    cancelledAt: at,
    cancelledBy,
    reason,
  });
}