/**
 * Document expiry: the arithmetic, and the reminders that fall out of it.
 *
 * The design spec's second criterion for this phase is *"expiry reminders
 * fire"*. Everything here exists to make that phrase checkable: given a date, a
 * set of documents and a lead time, what is due, when, and to whom — answered
 * exactly, reproducibly, with the clock supplied by the caller.
 *
 * ## No scheduler, no queue, no delivery
 *
 * **This module computes and returns data. It delivers nothing.** There is no
 * timer, no `setInterval`, no queue, no provider call. Another package owns
 * delivery — `packages/observability` logs, the API route enqueues, whatever the
 * deployment turns out to be — and this module's job is to hand it an exact list
 * of what is owed. That boundary is deliberate: a scheduler built here would be a
 * second place where time is decided, and a reminder that fires on the wrong
 * schedule because two modules disagreed about "now" is worse than no reminder.
 *
 * Consequently {@link expiryRemindersDue} is **idempotent and stateless**: it
 * returns the full set of reminders that are due as of `asOf`, including ones
 * already sent. It has no memory, so it cannot claim to know what has already
 * gone out. De-duplicating delivery is the consumer's job, and it can only do
 * that job correctly if this module is honest about not having done it.
 *
 * ## The two boundaries, pinned
 *
 * **Inclusive.** `asOf >= expiresAt` means expired. A document whose deadline
 * instant has arrived is expired from that instant; `>` would leave it valid for
 * one instant past its own deadline.
 *
 * **Inclusive on the horizon too.** {@link documentsExpiringWithin} includes a
 * document expiring *exactly* on the cutoff and excludes one expiring a
 * millisecond after it. This is the off-by-one the module is built around: a
 * deadline on the horizon is a real deadline, and excluding it drops a document
 * from a renewal run on precisely the day it must be renewed — a failure that
 * looks like nothing at all until somebody's paperwork lapses.
 *
 * Already-expired documents are excluded from "expiring within", because
 * *overdue* and *upcoming* need different actions and a list containing both
 * cannot tell a caller which to take.
 *
 * ## Days are fixed spans, not calendar days
 *
 * One day is {@link DAY_MS} milliseconds, exactly. A calendar day would make the
 * answer depend on a timezone and on daylight-saving transitions — so a 30-day
 * reminder would fire on the 29th in March and the 31st in October, and the
 * difference would only ever be noticed by the person it was sent to.
 *
 * Pure: no database, no network, no clock. `asOf` is always supplied.
 */

/** Milliseconds in a "day" for every calculation in this module. */
export const DAY_MS = 86_400_000;

/**
 * Lead days used when a document states none.
 *
 * **Product decision**, not a recovered rule — the legacy system tracked no
 * document expiry at all. Thirty and seven are the two horizons that cover the
 * two ways a renewal goes wrong: the long one where a month is needed to obtain
 * anything at all (visas, background checks), and the short one where the
 * deadline is imminent and the long lead has plainly not been acted on.
 */
export const DEFAULT_REMINDER_LEAD_DAYS: readonly number[] = Object.freeze([30, 7]);

/**
 * Kinds of document the system tracks.
 *
 * A closed set rather than free text, for the same reason `Role.key` and the
 * lifecycle states are: an unrecognised type silently falls into every retention
 * sweep and no renewal rule, so it is a document nobody is managing.
 *
 * **Product decision** — the catalogue is this phase's, not a recovered one.
 */
export const DOCUMENT_TYPES = [
  "work_permit",
  "employment_contract",
  "guardian_consent",
  "identity_document",
  "insurance_certificate",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** A document with a deadline somebody has to act on before it arrives. */
export interface ExpirableDocument {
  readonly documentId: string;
  readonly organizationId: string;
  /** The subject of the document, or `null` for an organisational document. */
  readonly personId: string | null;
  readonly documentType: DocumentType;
  readonly title: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Ascending, deduplicated, non-negative. Empty means "use the defaults". */
  readonly reminderLeadDays: readonly number[];
  /** Who must be told. A reminder addressed to nobody is not a reminder. */
  readonly notifyIds: readonly string[];
}

export interface ExpirableDocumentDraft {
  readonly documentId: string;
  readonly organizationId: string;
  readonly personId?: string | null;
  readonly documentType: DocumentType;
  readonly title: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly reminderLeadDays?: readonly number[];
  readonly notifyIds: readonly string[];
}

/**
 * Validate and freeze an expirable document.
 *
 * Rejects the three shapes that produce a document nobody is managing: no
 * recipient, a negative lead day, and an expiry that is not after the issue date.
 */
export function createExpirableDocument(draft: ExpirableDocumentDraft): ExpirableDocument {
  if (draft.documentId.trim() === "") {
    throw new Error("Expirable document must carry a non-empty documentId");
  }
  if (!(DOCUMENT_TYPES as readonly string[]).includes(draft.documentType)) {
    throw new Error(
      `Document ${draft.documentId} has unknown documentType ${JSON.stringify(draft.documentType)}; an unrecognised type belongs to no retention rule and no renewal reminder`,
    );
  }
  if (draft.expiresAt.getTime() <= draft.issuedAt.getTime()) {
    throw new Error(
      `Document ${draft.documentId} has expiresAt ${draft.expiresAt.toISOString()} at or before issuedAt ${draft.issuedAt.toISOString()}`,
    );
  }
  if (draft.notifyIds.length === 0) {
    throw new Error(`Document ${draft.documentId} has nobody to notify; an unaddressed reminder is not a reminder`);
  }

  const leadDays = draft.reminderLeadDays === undefined || draft.reminderLeadDays.length === 0
    ? [...DEFAULT_REMINDER_LEAD_DAYS]
    : [...new Set(draft.reminderLeadDays)].sort((a, b) => a - b);

  for (const lead of leadDays) {
    if (!Number.isInteger(lead) || lead < 0) {
      throw new Error(
        `Document ${draft.documentId} has reminderLeadDays entry ${lead}; lead days are non-negative whole days, and a negative one would schedule a reminder after the document expires`,
      );
    }
  }

  return Object.freeze({
    documentId: draft.documentId,
    organizationId: draft.organizationId,
    personId: draft.personId ?? null,
    documentType: draft.documentType,
    title: draft.title,
    issuedAt: draft.issuedAt,
    expiresAt: draft.expiresAt,
    reminderLeadDays: Object.freeze(leadDays),
    notifyIds: Object.freeze([...draft.notifyIds]),
  });
}

/**
 * Whether the expiry instant has arrived.
 *
 * `>=`, not `>`. The deadline instant belongs to the expired side; a document
 * valid for one extra instant is a document whose renewal was one millisecond too
 * late.
 */
export function isExpired(document: ExpirableDocument, asOf: Date): boolean {
  return asOf.getTime() >= document.expiresAt.getTime();
}

/**
 * Whole days from `asOf` until expiry. `0` on the day itself, negative once
 * overdue.
 *
 * Floored, so a document expiring in 12 hours reads as `0` days — "today" —
 * rather than rounding up to `1`, which would put it in tomorrow's renewal run.
 * A negative figure is preserved rather than clamped, because a report that
 * cannot show how overdue something is cannot be sorted by urgency.
 */
export function daysUntilExpiry(document: ExpirableDocument, asOf: Date): number {
  return Math.floor((document.expiresAt.getTime() - asOf.getTime()) / DAY_MS);
}

function assertWithinDays(withinDays: number): void {
  if (!Number.isInteger(withinDays) || withinDays < 0) {
    throw new Error(
      `withinDays must be a non-negative whole number of days; received ${JSON.stringify(withinDays)}. A fractional or negative horizon cannot be compared against an expiry instant.`,
    );
  }
}

/**
 * Documents that are still valid **and** expire on or before `asOf + withinDays`.
 *
 * Both ends are inclusive. The far end is the one that matters: a document
 * expiring exactly on the horizon is included, and that is asserted by a test
 * because an off-by-one here drops a real deadline off a real renewal list.
 *
 * The near end is inclusive because "expiring today" is the most urgent case
 * there is, not a boundary to be excluded.
 *
 * Returns a frozen list ordered by expiry, then document id — so the same set of
 * documents always produces the same list, whatever order they arrived in.
 */
export function documentsExpiringWithin(
  documents: readonly ExpirableDocument[],
  asOf: Date,
  withinDays: number,
  organizationId?: string,
): readonly ExpirableDocument[] {
  assertWithinDays(withinDays);
  const horizon = asOf.getTime() + withinDays * DAY_MS;

  const matching = documents.filter((document) => {
    if (organizationId !== undefined && document.organizationId !== organizationId) return false;
    if (document.expiresAt.getTime() < asOf.getTime()) return false;
    return document.expiresAt.getTime() <= horizon;
  });

  return Object.freeze(
    [...matching].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || compare(a.documentId, b.documentId)),
  );
}

/** A reminder that is owed. Data only — see the module note about delivery. */
export type ExpiryReminder = ExpiringReminder | ExpiredReminder;

/** A horizon has been reached; the document is still valid. */
export interface ExpiringReminder {
  readonly kind: "expiring";
  readonly documentId: string;
  readonly recipientIds: readonly string[];
  /** The instant the reminder was due: `expiresAt` minus `leadDays`. */
  readonly remindAt: Date;
  readonly expiresAt: Date;
  readonly daysUntilExpiry: number;
  readonly leadDays: number;
}

/** The document has expired. Different remedy, so a different kind. */
export interface ExpiredReminder {
  readonly kind: "expired";
  readonly documentId: string;
  readonly recipientIds: readonly string[];
  /** The expiry instant itself — the moment it became overdue. */
  readonly remindAt: Date;
  readonly expiresAt: Date;
  readonly daysUntilExpiry: number;
  readonly leadDays: 0;
}

/**
 * Every reminder that is owed as of `asOf`, for every document, in one frozen,
 * deterministically ordered list.
 *
 * A reminder is owed when `expiresAt - leadDays <= asOf` — that is, when its
 * horizon has been reached. **It is owed from that instant onwards, every time
 * this is called**, because this function has no memory and does not pretend
 * otherwise. The consumer de-duplicates; that is the correct division of labour,
 * because only the consumer knows what it already sent.
 *
 * An expired document yields exactly one {@link ExpiredReminder} and never an
 * {@link ExpiringReminder}: telling somebody a document expires "in 30 days"
 * about something that lapsed a month ago is worse than saying nothing.
 *
 * `daysUntilExpiry` is carried on each reminder so the consumer can rank without
 * re-deriving it — and get the same answer if it did.
 */
export function expiryRemindersDue(
  documents: readonly ExpirableDocument[],
  asOf: Date,
  organizationId?: string,
): readonly ExpiryReminder[] {
  const reminders: ExpiryReminder[] = [];

  for (const document of documents) {
    if (organizationId !== undefined && document.organizationId !== organizationId) continue;

    if (isExpired(document, asOf)) {
      reminders.push({
        kind: "expired",
        documentId: document.documentId,
        recipientIds: Object.freeze([...document.notifyIds]),
        remindAt: document.expiresAt,
        expiresAt: document.expiresAt,
        daysUntilExpiry: daysUntilExpiry(document, asOf),
        leadDays: 0,
      });
      continue;
    }

    const leadDays = document.reminderLeadDays.length === 0 ? DEFAULT_REMINDER_LEAD_DAYS : document.reminderLeadDays;
    for (const lead of leadDays) {
      const remindAt = new Date(document.expiresAt.getTime() - lead * DAY_MS);
      if (remindAt.getTime() > asOf.getTime()) continue;

      reminders.push({
        kind: "expiring",
        documentId: document.documentId,
        recipientIds: Object.freeze([...document.notifyIds]),
        remindAt,
        expiresAt: document.expiresAt,
        daysUntilExpiry: daysUntilExpiry(document, asOf),
        leadDays: lead,
      });
    }
  }

  return Object.freeze(
    reminders.sort(
      (a, b) =>
        a.remindAt.getTime() - b.remindAt.getTime() ||
        compare(a.documentId, b.documentId) ||
        a.leadDays - b.leadDays,
    ),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}