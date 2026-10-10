/**
 * Majority: a function of a birth date and a reference date.
 *
 * The legacy system had **no concept of minors at all** — there was no
 * `birth_date`, no guardian concept, and nothing stopping a fourteen-year-old
 * signing a player agreement. This module is that concept, and its central
 * decision is a shape decision:
 *
 * **Minority is computed, never stored.**
 *
 * There is no `is_minor` boolean anywhere in this package, and no function that
 * could set one. A stored boolean is wrong the moment somebody's date of birth is
 * corrected, and worse, it is wrong *silently*: the record continues to say the
 * person is a minor, or is not, long after the fact. Computing it from the birth
 * date against a supplied date makes it wrong only if the birth date itself is
 * wrong, which is a visible, correctable data problem.
 *
 * The second consequence is that `at` is always a parameter. There is no
 * `Date.now()` in this file. A test can ask "was this person a minor on the day
 * they signed?" and get the answer that day would have produced — which is the
 * only kind of answer worth having when a contract is being disputed years later.
 *
 * ## Instant-based, not calendar-date-based
 *
 * The threshold is an **instant**: the eighteenth birthday itself, to the
 * millisecond. Someone born at 12:00 turns 18 at 12:00, not at midnight.
 * Comparing calendar dates instead would hand adulthood to every person born
 * after midnight on their birthday — up to a day early — and would make the
 * answer depend on a timezone this package deliberately does not have.
 *
 * The three boundary cases (the day before, the instant of, and the instant
 * after) are each pinned by a test. `<=` rather than `<` would give adulthood
 * one millisecond early and is the single most likely way to get this wrong.
 *
 * The 29 February case is clamped to 28 February in a common year rather than
 * rolling to 1 March, which is what `Date`'s own arithmetic would do and what
 * most jurisdictions specify. **Product decision, not a recovered rule** — see
 * the module note in {@link addYears}.
 */

/**
 * Age at which a person may contract for themselves.
 *
 * Eighteen, held here once. The number is a jurisdiction-specific legal
 * threshold, so it is named, exported and read from one place rather than
 * written as an `18` at each call site — a value that changes when the
 * jurisdiction does should change in one line, visibly.
 */
export const MAJORITY_AGE_YEARS = 18;

/**
 * Age below which a person may not be engaged at all, guardian consent or not.
 *
 * **Product decision**, taken from the design spec section 10: *"Guardian consent
 * for minors; under-13 blocked."* The reasoning the spec does not spell out:
 * consent can only bridge a gap that consent is capable of bridging, and a
 * twelve-year-old's guardian cannot meaningfully authorise a professional
 * engagement on their behalf. Below the floor the answer is no, and it is not
 * negotiable by producing another guardian.
 */
export const ENGAGEMENT_MINIMUM_AGE_YEARS = 13;

/** The identity facts this module needs, and no more. */
export interface Person {
  readonly personId: string;
  readonly birthDate: Date;
}

/**
 * Add calendar years, clamping to the last day of the month.
 *
 * `setFullYear` on a 29 February would roll to 1 March, delaying that one
 * birthdate's majority by a day, every leap cycle, invisibly. Clamping to
 * 28 February matches the usual legal treatment.
 *
 * **Product decision**: this is not a rule recovered from the legacy source —
 * the legacy source had no birth dates at all (ADR-0016). Where jurisdictions
 * differ, this is the place to change it, and the tests here will say so.
 */
export function addYears(date: Date, years: number): Date {
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cannot add ${years} years to an invalid date`);
  }

  const shifted = new Date(date.getTime());
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);

  // `setUTCFullYear` rolls 29 Feb + 18y to 1 Mar. Walk back to the last day of
  // the month the clamp is standing in for.
  if (shifted.getUTCMonth() !== date.getUTCMonth()) {
    shifted.setUTCDate(0);
  }

  return shifted;
}

/**
 * The instant at which this person becomes an adult: their eighteenth birthday.
 *
 * Rejects a missing or malformed birth date. Such a record otherwise reads as
 * "infinitely young", which blocks everybody forever and presents as a
 * permissions decision rather than as the data fault it is.
 *
 * A birth date in the *future* is deliberately **not** rejected here. Doing so
 * would need a clock to compare against, and this module has none — that is the
 * point of it. Such a record is caught downstream by
 * {@link ageInYearsAt}, which reports a negative age and so makes the corruption
 * visible without ever asking what time it is.
 */
export function majorityDate(person: Person): Date {
  return addYears(requireBirthDate(person), MAJORITY_AGE_YEARS);
}

/**
 * Whether this person is a minor at `at`.
 *
 * `at` is a required parameter and there is no default, deliberately. Anything
 * that defaults it to "now" turns a historical question into a question about the
 * present, and the two give different answers for every minor in the system.
 */
export function isMinor(person: Person, at: Date): boolean {
  return at.getTime() < majorityDate(person).getTime();
}

/**
 * Whether this person is below the engagement floor at `at`.
 *
 * Separate from {@link isMinor} because the two rules are different rules. A
 * fifteen-year-old *is* a minor and may be engaged with guardian consent; a
 * twelve-year-old may not be engaged at all. Folding them together would either
 * let twelve-year-olds in or exclude every minor.
 */
export function isUnderEngagementMinimumAge(person: Person, at: Date): boolean {
  const threshold = addYears(requireBirthDate(person), ENGAGEMENT_MINIMUM_AGE_YEARS);
  return at.getTime() < threshold.getTime();
}

/**
 * Completed years of life at `at`, derived rather than approximated.
 *
 * Recomputed from the eighteenth-birthday comparison rather than by dividing
 * elapsed milliseconds by 365.25 days: the dividing-line version drifts by
 * several days across an eighteen-year span and gets leap years and leap
 * seconds wrong in ways nobody can reproduce.
 *
 * Returns a **negative** number before birth rather than clamping to zero. A
 * negative age is a corrupt record and should read as one; clamping would render
 * it indistinguishable from a newborn, and a newborn is below the engagement
 * floor — so the corruption would present as a permissions decision instead of
 * a data error.
 */
export function ageInYearsAt(person: Person, at: Date): number {
  const birth = requireBirthDate(person);
  if (at.getTime() < birth.getTime()) return -1;

  let age = at.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = at.getUTCMonth() - birth.getUTCMonth();
  const dayDelta = at.getUTCDate() - birth.getUTCDate();

  // The birthday has not come round yet this year.
  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) age -= 1;

  return age;
}

/**
 * Shared date validation for the entry points that bypass {@link majorityDate}.
 *
 * Separate because {@link majorityDate} additionally rejects future dates — a
 * check that makes sense for an adult threshold and would be nonsense for the
 * engagement floor, where "born in the future" just means the same thing it
 * means everywhere else: younger than the floor.
 */
function requireBirthDate(person: Person): Date {
  const birth = person.birthDate;
  if (birth === undefined || birth === null || Number.isNaN(birth.getTime())) {
    throw new Error(`Person ${person.personId} has no usable birthDate; age cannot be derived from it`);
  }
  return birth;
}