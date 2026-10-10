/**
 * Compensation agreements: effective dating, and a decision about overlap.
 *
 * A compensation agreement answers two questions that are constantly confused:
 * *what did this person earn* and *what were they promised*. This module only
 * answers the second, and only ever for a **date the caller supplies**. There is
 * no clock read anywhere in it — `at` is a parameter — because a payroll question
 * asked in a dispute is always asked about the past, and an answer that depends
 * on when the process happened to start is not an answer.
 *
 * ## The window is half-open `[validFrom, validTo)`
 *
 * The same convention `src/authorization/model.ts` already uses, and for the
 * same reason: two agreements that meet at one instant leave no gap and no
 * overlap. `validFrom` is **inclusive** — an agreement applies on the day it
 * starts. `validTo` is **exclusive** — an agreement does *not* apply on the
 * instant it ends. Both boundaries are pinned by tests, because an off-by-one
 * here pays a raise one day early or late and nobody notices for a year.
 *
 * ## Overlap is a bug, not a stacking rule
 *
 * **Product decision, not a recovered rule.** ADR-0016 records no recoverable
 * compensation rule in the legacy source; the legacy system held a current
 * salary on the person row and overwrote it.
 *
 * The decision: two agreements covering the same instant for the same person in
 * the same organisation are **refused**, not merged and not ranked.
 *
 * The alternative — pick one — is the defect this design is built against. Two
 * open agreements mean either a data-entry error or a backdated raise applied
 * without amending the window it collided with. In both cases "which salary was
 * this?" has no answer derivable from the data, and silently resolving it picks
 * one at random. A refusal is recoverable; a wrong salary paid from a coin toss
 * is not.
 *
 * So {@link resolveCompensationAt} **throws** on an overlap rather than
 * returning a guess. The real-world fixes — amend the window, terminate the
 * superseded agreement, correct the backdating — each leave a trail, which is
 * what {@link assertNoOverlappingAgreements} is for at write time.
 * {@link agreementsCovering} is the un-throwing counterpart, for the report that
 * needs to *show* the conflict rather than refuse it.
 *
 * ## Money
 *
 * All amounts are the existing {@link Money} type: frozen `bigint` minor units at
 * four decimal places with an ISO 4217 currency (ADR-0003). No float appears
 * anywhere in this module, including in the bonus arithmetic.
 */

import type { Money } from "../money/index.js";
import { minorToDecimal, money } from "../money/index.js";

/**
 * Divisor turning a stored percentage into a fraction of the base salary.
 *
 * Two factors, not one, and the second is the easy one to forget: `parsePercent`
 * stores the *percent number* scaled by 1e4, so `"12.5"` is `125_000`, not
 * `1_250`. Converting that to the fraction `0.125` therefore divides by `1e4`
 * (the scale) and by `100` (percent to fraction). Dividing by `1e4` alone
 * multiplies every bonus by a hundred — a spectacular way to overpay somebody.
 */
const PERCENT_DIVISOR = 10_000n * 100n;

/** An effective-dated statement of what a person is to be paid. */
export interface CompensationAgreement {
  readonly agreementId: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly title: string;
  /** Guaranteed amount. Exact minor units; never a float (ADR-0003). */
  readonly baseSalary: Money;
  /**
   * Bonus as a percentage scaled by 1e4 (`"12.5"` becomes `125_000`), or `null`
   * when the agreement states no bonus at all.
   *
   * `null` is not `0n`. `0n` is an agreement promising a bonus of nothing;
   * `null` is an agreement silent on the subject. Collapsing them would make a
   * pay report understate a clause without saying so.
   */
  readonly bonusPercent: bigint | null;
  readonly validFrom: Date;
  /** `null` means open-ended. Exclusive at the boundary, like SQL's `tstzrange`. */
  readonly validTo: Date | null;
}

export interface CompensationAgreementDraft {
  readonly agreementId: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly title: string;
  readonly baseSalary: Money;
  /** Raw percentage text, e.g. `"12.5"`. Parsed exactly; never via a float. */
  readonly bonusPercent?: string | null;
  readonly validFrom: Date;
  readonly validTo?: Date | null;
}

/**
 * Validate and freeze a compensation agreement.
 *
 * Rejects the shapes that would make the agreement unpayable or unresolvable: a
 * window that does not advance, a negative salary, an agreement belonging to
 * nobody. Each produces a row that reads as "no agreement" six months later.
 */
export function createCompensationAgreement(draft: CompensationAgreementDraft): CompensationAgreement {
  if (draft.agreementId.trim() === "") {
    throw new Error("Compensation agreement must carry a non-empty agreementId");
  }
  if (draft.personId.trim() === "") {
    throw new Error(`Compensation agreement ${draft.agreementId} has a blank personId; it would pay nobody`);
  }
  if (draft.baseSalary.isNegative()) {
    throw new Error(
      `Compensation agreement ${draft.agreementId} has a negative base salary (${draft.baseSalary.toDecimal()} ${draft.baseSalary.currency})`,
    );
  }

  const validTo = draft.validTo ?? null;
  if (validTo !== null && validTo.getTime() <= draft.validFrom.getTime()) {
    throw new Error(
      `Compensation agreement ${draft.agreementId} has validTo ${validTo.toISOString()} at or before validFrom ${draft.validFrom.toISOString()}; it would cover no instant at all`,
    );
  }

  return Object.freeze({
    agreementId: draft.agreementId,
    personId: draft.personId,
    organizationId: draft.organizationId,
    title: draft.title,
    baseSalary: draft.baseSalary,
    bonusPercent: parseBonusPercent(draft.bonusPercent, draft.agreementId),
    validFrom: draft.validFrom,
    validTo,
  });
}

/**
 * Exact percentage parsing.
 *
 * `parsePercent` from `../money` is deliberately not reused: this one preserves
 * the difference between "no bonus stated" (`null`) and "a bonus of zero" (`0n`),
 * which is a domain decision about agreements rather than about money.
 *
 * The result is a `bigint` scaled by 1e4, so the product with a minor-unit
 * amount stays in integer space. A float here would be the first float in the pay
 * path, and ADR-0003 exists to keep it out.
 */
function parseBonusPercent(raw: string | null | undefined, agreementId: string): bigint | null {
  if (raw === null || raw === undefined) return null;

  const text = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Compensation agreement ${agreementId} has an invalid bonusPercent ${JSON.stringify(raw)}`);
  }

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  if (fraction.length > 4) {
    throw new Error(
      `Compensation agreement ${agreementId} bonusPercent ${raw} has more than 4 decimal places; refusing rather than rounding a pay figure`,
    );
  }
  if (negative) {
    throw new Error(`Compensation agreement ${agreementId} bonusPercent must not be negative`);
  }

  return BigInt(`${whole}${fraction.padEnd(4, "0")}`);
}

/**
 * Whether an agreement's window contains `at`. Half-open: `[validFrom, validTo)`.
 *
 * Exported so a caller filtering a list can use exactly the predicate the
 * resolver uses. A second, slightly different copy of this comparison elsewhere
 * is how a "resolved on the first" and a "listed on the last" disagreement starts.
 */
export function agreementAppliesAt(agreement: CompensationAgreement, at: Date): boolean {
  if (at.getTime() < agreement.validFrom.getTime()) return false;
  if (agreement.validTo === null) return true;
  return at.getTime() < agreement.validTo.getTime();
}

/**
 * Whether two agreements both cover at least one instant.
 *
 * Only meaningful within one person in one organisation: two different people
 * being paid at the same time is the entire point.
 *
 * Because the windows are half-open, two windows that merely touch — one's
 * `validTo` is the other's `validFrom` — do **not** overlap. That is the shape a
 * routine promotion actually takes, and treating it as a conflict would make a
 * raise unrecordable.
 */
export function hasOverlapAt(a: CompensationAgreement, b: CompensationAgreement): boolean {
  if (a.personId !== b.personId) return false;
  if (a.organizationId !== b.organizationId) return false;
  if (a.agreementId === b.agreementId) return false;

  const aTo = a.validTo === null ? Number.POSITIVE_INFINITY : a.validTo.getTime();
  const bTo = b.validTo === null ? Number.POSITIVE_INFINITY : b.validTo.getTime();

  // Half-open intersection: each window starts strictly before the other ends.
  return a.validFrom.getTime() < bTo && b.validFrom.getTime() < aTo;
}

/**
 * Every agreement in force for this person at `at`.
 *
 * Pass `organizationId` to scope the query to one tenant (ADR-0011). Without it
 * the query spans every organisation the person has ever been paid by, which is
 * correct for a cross-tenant report and wrong for an ordinary one — so the
 * caller has to say which.
 */
export function agreementsCovering(
  personId: string,
  at: Date,
  agreements: readonly CompensationAgreement[],
  organizationId?: string,
): readonly CompensationAgreement[] {
  return agreements.filter((candidate) => {
    if (candidate.personId !== personId) return false;
    if (organizationId !== undefined && candidate.organizationId !== organizationId) return false;
    return agreementAppliesAt(candidate, at);
  });
}

/**
 * The agreement governing `personId` at `at`, or `null`.
 *
 * **Throws** when two agreements are simultaneously in force. See the module
 * comment: overlap is refused rather than ranked, because picking one of two
 * payable agreements is not a decision this data supports.
 *
 * Returns `null` — rather than throwing — when nothing applies. "Employed at no
 * salary on this date" is a legitimate, answerable question; "employed at two
 * salaries" is not.
 */
export function resolveCompensationAt(
  personId: string,
  at: Date,
  agreements: readonly CompensationAgreement[],
  organizationId?: string,
): CompensationAgreement | null {
  const covering = agreementsCovering(personId, at, agreements, organizationId);

  // Destructured rather than indexed: under `noUncheckedIndexedAccess` an index
  // read is `T | undefined`, and defending against a length check that just
  // established the length leaves a branch no test can ever reach.
  const [first, ...rest] = covering;

  if (first === undefined) return null;

  if (rest.length > 0) {
    throw new Error(
      `Overlapping compensation agreements for ${personId} at ${at.toISOString()}: ${describeAll(covering)}. Two agreements may not cover the same instant; amend or terminate one of them.`,
    );
  }

  return first;
}

/** Write-time guard. Cheap enough to run on every save, and it catches the overlap where it is still correctable. */
export function assertNoOverlappingAgreements(agreements: readonly CompensationAgreement[]): void {
  // `.entries()` and `slice` rather than index arithmetic: both yield values
  // typed as `CompensationAgreement` rather than `| undefined`, so the pairwise
  // scan carries no branch that only exists to satisfy the compiler.
  for (const [index, candidate] of agreements.entries()) {
    for (const other of agreements.slice(index + 1)) {
      if (!hasOverlapAt(candidate, other)) continue;
      throw new Error(
        `Compensation agreements ${candidate.agreementId} [${describeWindow(candidate)}] and ${other.agreementId} [${describeWindow(other)}] overlap for ${candidate.personId}; two agreements may not cover the same instant.`,
      );
    }
  }
}

function describeWindow(agreement: CompensationAgreement): string {
  return `${agreement.validFrom.toISOString()}, ${
    agreement.validTo === null ? "open" : agreement.validTo.toISOString()
  }`;
}

function describeAll(agreements: readonly CompensationAgreement[]): string {
  return [...agreements]
    .map((agreement) => `${agreement.agreementId} [${describeWindow(agreement)}]`)
    .sort()
    .join(" and ");
}

/**
 * Base salary plus bonus for the agreement in force at `at`, or `null`.
 *
 * `null` rather than a zero {@link Money} when no agreement applies: there is no
 * currency to report in. `../money` deliberately has no global currency, and
 * inventing one here to fill a gap would be the same mistake one layer down.
 *
 * The bonus is `floor(salary · percent / 1e4)` on purpose: a percentage applied
 * to a minor-unit amount frequently does not divide evenly (`33.3333%` of
 * `33.3333 INR` is not a whole number of minor units), and rounding here would
 * silently invent or destroy money inside the pay path. The truncation is exact,
 * deterministic and documented; a caller that needs a different convention must
 * say so rather than inherit this one by accident.
 */
export function totalAnnualCompensationAt(
  personId: string,
  at: Date,
  agreements: readonly CompensationAgreement[],
  organizationId?: string,
): Money | null {
  const governing = resolveCompensationAt(personId, at, agreements, organizationId);
  if (governing === null) return null;

  const bonus =
    governing.bonusPercent === null
      ? 0n
      : (governing.baseSalary.minor * governing.bonusPercent) / PERCENT_DIVISOR;

  return money(minorToDecimal(governing.baseSalary.minor + bonus), governing.baseSalary.currency);
}