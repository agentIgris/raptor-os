/**
 * Documents: expiry arithmetic and the reminders that fall out of it.
 *
 * The phase's second criterion is *"expiry reminders fire"*. What this package
 * makes true is the part that can be made true without a delivery channel:
 * given a date and a set of documents, exactly which reminders are owed, when
 * they became due, and to whom.
 *
 * **This package computes. It does not deliver.** No timer, no queue, no
 * provider call — another package owns delivery. `expiryRemindersDue` is
 * stateless and returns everything owed as of `asOf`, including reminders a
 * consumer has already sent; only the consumer knows what has gone out, and it
 * can de-duplicate correctly only if this package is honest about not having.
 *
 * Both boundaries are inclusive and both are pinned by tests: a document is
 * expired at the exact instant of its expiry, and a document expiring exactly on
 * a horizon is inside that horizon. An off-by-one here silently drops a real
 * deadline. See `./expiry.js`.
 */

export {
  DAY_MS,
  DEFAULT_REMINDER_LEAD_DAYS,
  DOCUMENT_TYPES,
  createExpirableDocument,
  daysUntilExpiry,
  documentsExpiringWithin,
  expiryRemindersDue,
  isExpired,
} from "./expiry.js";

export type {
  DocumentType,
  ExpirableDocument,
  ExpirableDocumentDraft,
  ExpiredReminder,
  ExpiringReminder,
  ExpiryReminder,
} from "./expiry.js";