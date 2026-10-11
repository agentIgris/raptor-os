/**
 * Windows are on the EVENT DATE, and they are closed.
 *
 * ## Rule 5 is the whole reason this file exists
 *
 * ADR-0019 rule 5: *"Windows filter on the event date, never on `created_at`.
 * Backfilled history belongs to the period it happened in."* The legacy system
 * filtered on the insert timestamp, so a season imported last Tuesday landed in
 * the present bucket and every trend line lied about when the work happened.
 *
 * That failure is not detectable by reading a filter. `WHERE created_at >= $1`
 * and `WHERE event_at >= $1` differ only in one identifier, both run, and both
 * return rows. So the window is expressed here as a value that cannot carry a
 * creation timestamp at all: {@link EventInstant} is the event's own instant and
 * nothing else, and `assertEventDate` refuses a value whose meaning is ambiguous.
 *
 * ## A window is never open-ended
 *
 * "All time" and "this month" are different claims, and a report that silently
 * treats a missing bound as "no bound" will render one as the other the first
 * time history is truncated. {@link assertClosedWindow} refuses rather than
 * defaulting, which is the same argument 0007 makes about its leaderboard
 * window.
 *
 * ## Half-open, like every window in this schema
 *
 * `[from, to)` — the instant `to` belongs to the NEXT window. A daily bucket for
 * 2026-05-04 is `[2026-05-04T00:00:00Z, 2026-05-05T00:00:00Z)`, and an event at
 * exactly midnight belongs to exactly one of them. A closed interval would put it
 * in two.
 *
 * Pure: no clock. Every instant is supplied, so "was this in March?" is
 * answerable for a date in the past and a test never depends on the day it runs.
 */

/** The EVENT instant a row is filed under. Never its insertion instant. */
export interface EventInstant {
  /** The instant the thing HAPPENED, as an ISO-8601 UTC string. */
  readonly eventAt: string;
  /** Which stored column this came from, so a wrong call site is visible. */
  readonly source: "match.scheduled_at" | "task.transitioned_at" | "asset_custody.occurred_at" | "attendance_record.recorded_at";
}

/**
 * A closed, half-open time window.
 *
 * `from` inclusive, `to` exclusive. Both required: there is no "unbounded" here
 * because an unbounded window has no boundary to be wrong about, and a report
 * whose period is undefined cannot be compared with one whose period is defined.
 */
export interface EventWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * ISO-8601 with an explicit UTC offset.
 *
 * The offset is REQUIRED. A bare `2026-05-04` or `2026-05-04T18:00:00` parses
 * happily in PostgreSQL and means different instants in different sessions — and
 * PostgreSQL parses a malformed ISO literal into a wrong-but-valid instant with
 * NO error, so a test built on one passes while asserting nothing. Forcing the
 * offset moves the ambiguity to the point of construction, where it can be
 * refused.
 */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Assert that a string is an unambiguous instant.
 *
 * A CALENDAR DATE is refused outright, not merely warned about. "Which day was
 * this match in?" has a different answer in every reader's timezone once the
 * instant is flattened, and ADR-0003's reasoning for money — a date is not a
 * moment — is exactly this reasoning applied to time.
 */
export function assertEventDate(value: string, label: string): string {
  if (!UTC_INSTANT.test(value)) {
    throw new Error(
      `${label} must be an ISO-8601 instant with an explicit UTC offset (e.g. 2026-05-04T18:00:00Z); got ${JSON.stringify(value)}. A bare date or a bare local time means a different instant in every reader's timezone, and PostgreSQL will parse a malformed literal into a wrong-but-valid instant without complaining.`,
    );
  }
  const asNumber = Date.parse(value);
  if (Number.isNaN(asNumber)) {
    throw new Error(`${label} is not a real instant: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A closed window, or a refusal.
 *
 * `to <= from` is refused rather than returning an empty window: an empty window
 * and an impossible one are different answers, and "no data" is the wrong report
 * for a caller who passed March after April.
 */
export function eventWindow(from: string, to: string): EventWindow {
  assertEventDate(from, "A window's start");
  assertEventDate(to, "A window's end");

  if (from === to) {
    throw new Error(`A window of [${from} , ${from} ) is empty by construction; it is almost certainly a duplicated argument rather than a zero-length period.`);
  }
  if (Date.parse(to) < Date.parse(from)) {
    throw new Error(`A window of [${from} , ${to} ) ends before it starts; refusing rather than returning nothing.`);
  }

  return Object.freeze({ from, to });
}

/**
 * Is this event inside the window? HALF-OPEN: `[from, to)`.
 *
 * The comparison is done on PARSED INTEGERS, not on the strings. String comparison
 * of two ISO-8601 instants with different offsets — `2026-05-04T18:00:00Z` and
 * `2026-05-04T20:00:00+02:00`, which are the same moment — orders them
 * alphabetically and puts one of them on the wrong side of a boundary.
 */
export function isInWindow(event: EventInstant, window: EventWindow): boolean {
  assertEventDate(event.eventAt, `Event ${event.source}`);

  const at = Date.parse(event.eventAt);
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);

  return at >= from && at < to;
}

/**
 * The day bucket an event belongs to, as an ISO date.
 *
 * UTC days, and UTC only. ADR-0019 records that the legacy system bucketed
 * trends by UTC day while filtering periods by local `new Date()` — two calendars
 * in one report, so the trend's last point could fall outside the period it was
 * filtered by. One calendar here, and it is stated rather than inferred from the
 * session's timezone.
 */
export function utcDayBucket(event: EventInstant): string {
  return event.eventAt.slice(0, 10);
}

/**
 * Refuse an open-ended window.
 *
 * Exported so a caller that assembles a window from optional query parameters
 * cannot pass `undefined` through to a report. The refusal names the missing
 * bound, because "all time" is often what the caller meant and is a different
 * claim from "this month".
 */
export function assertClosedWindow(window: { readonly from?: string; readonly to?: string }): EventWindow {
  if (window.from === undefined || window.to === undefined) {
    throw new Error(
      `An analytics window needs both a start and an end; ${window.from === undefined ? "the start" : "the end"} is missing. "All time" and "this month" are different claims, and a report that defaults one to the other stops meaning anything the first time history is truncated.`,
    );
  }
  return eventWindow(window.from, window.to);
}
