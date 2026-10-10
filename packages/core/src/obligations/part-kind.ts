/**
 * The closed vocabulary of things an organisation can promise a partner.
 *
 * Kept in its own file because `evidence.ts` needs the same list and importing it
 * from `obligation.ts` would make the evidence module depend on the aggregate it
 * is supposed to be evidence *about*. A dependency from evidence back to the
 * obligation is normal; the reverse is a cycle.
 *
 * ## Why a closed union and not free text
 *
 * Evidence carries the kind it evidences, and only evidence of the same kind
 * counts towards a part (see `./discharge.ts`). That check is only worth making if
 * the set of kinds is fixed. With `kind: string`, a caller could record evidence
 * typed `"live stream"` against a part typed `"live_stream"`, the two strings
 * would not be equal, and the part would quietly stop discharging — or worse,
 * someone would add a `catch_all` "other" member and a WhatsApp screenshot would
 * settle a promise of four broadcasts.
 *
 * **Product decision.** ADR-0016 records that the legacy system had no recoverable
 * commercial rules at all, so this list is designed rather than recovered. It is
 * deliberately small and concrete: it covers the deliverables an esports
 * organisation actually signs for. Adding a kind is a deliberate edit to this file
 * and to the tests, not a runtime string.
 */

/**
 * Deliverable kinds a sponsorship obligation can promise.
 *
 * Written out in full rather than derived, because the order is the reading order
 * of a contract clause and a generated list would drift from it silently.
 */
export const OBLIGATION_PART_KINDS = Object.freeze([
  /** A co-streamed or sponsored broadcast. */
  "live_stream",
  /** A post on a social platform. */
  "social_post",
  /** An in-person or remote presence at a named event. */
  "appearance",
  /** Sponsor marks shown in broadcast, on kit, or on stage. */
  "logo_placement",
  /** A commissioned piece of content delivered to the partner. */
  "content_delivery",
  /** Physical or digital merchandise handed over. */
  "asset_delivery",
] as const);

export type ObligationPartKind = (typeof OBLIGATION_PART_KINDS)[number];