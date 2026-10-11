/**
 * The dashboard view model.
 *
 * WHY THIS FILE HAS FIXTURES IN IT
 * --------------------------------
 * `packages/db` does not yet expose a query layer this app can call — its
 * package manifest points `./client` at a module that does not exist yet. So
 * the inputs here are literal fixtures.
 *
 * What is NOT a fixture is the derivation. Every number that reaches the screen
 * is produced by a `@raptor/core` function: the allocation comes from
 * `allocateByShareNumerators` (largest remainder), the tier movement comes from
 * `computeTierMovement`, the attendance status comes from
 * `resolveAttendanceStatus`. That is the whole point of the split the spec
 * describes — `packages/core` holds the load-bearing rules as pure functions
 * precisely so they can be exercised without a database.
 *
 * The alternative — hard-coding "€48,000" into a template — would render
 * identically and prove nothing, which is precisely how the money display path
 * went unexercised in the legacy system until a cent was wrong in production.
 *
 * When `packages/db` ships its query layer, the FIXTURES below are replaced by
 * those queries and nothing else in this file changes.
 */

import { resolveAttendanceStatus } from "@raptor/core/attendance";
import { allocateByShareNumerators, minorToDecimal, money, type Money } from "@raptor/core/money";
import { computeTierMovement, type Tier, type TierMovementKind } from "@raptor/core/tiers";

const CURRENCY = "EUR";

/**
 * Fixture prize pool.
 *
 * Written as DECIMAL STRINGS rather than as bigints, because the unit
 * conventions in `@raptor/core/money` are not symmetric and the asymmetry is
 * the sharp edge:
 *
 *  - `money()` takes its input in MAJOR units and returns a `Money` whose
 *    `.minor` holds MINOR units at a scale of 4.
 *  - `allocateByShareNumerators()` works purely in MINOR units and returns
 *    MINOR units.
 *
 * So passing an allocated bigint straight back into `money()` treats it as
 * major units and inflates it ten-thousand-fold. `minorToDecimal()` is the
 * documented bridge between the two, and every conversion between them in this
 * file goes through it. `dashboard.test.ts` asserts the resulting `.minor`
 * values, so the convention cannot drift silently.
 */
const FIXTURE_GROSS = "50000"; // €50,000.00
const FIXTURE_DEDUCTIONS = "2000"; // €2,000.00
const FIXTURE_TAX = "5000"; // €5,000.00
const FIXTURE_NET = "43000"; // €43,000.00

/** Build a {@link Money} from an amount expressed in MINOR units. */
function moneyFromMinor(minor: bigint): Money {
  return money(minorToDecimal(minor), CURRENCY);
}

interface AllocationRow {
  readonly id: string;
  readonly label: string;
  readonly participants: number;
  readonly computed: Money;
  readonly ruleVersion: string;
}

export interface PrizePreview {
  readonly currency: string;
  readonly gross: Money;
  readonly deductions: Money;
  readonly tax: Money;
  readonly net: Money;
  readonly allocations: readonly AllocationRow[];
  /**
   * `sum(allocations) - net`.
   *
   * Rendered on the page on purpose. An allocation engine whose variance is
   * not shown is an allocation engine nobody trusts; showing zero is the claim,
   * and this is where it is checked.
   */
  readonly variance: Money;
}

/** Share weights, expressed as integers so the arithmetic stays exact. */
const FIXTURE_SHARES: readonly {
  readonly id: string;
  readonly label: string;
  readonly weight: bigint;
  readonly participants: number;
}[] = [
  { id: "team-alpha", label: "Starting roster", weight: 50n, participants: 5 },
  { id: "sub-alpha", label: "Substitute pool", weight: 20n, participants: 2 },
  { id: "staff-alpha", label: "Coaching and support staff", weight: 15n, participants: 3 },
  { id: "reserve", label: "Held for the roster", weight: 15n, participants: 1 },
];

const RULE_VERSION = "v1-fixed-plus-percentage@2026-02-01";

export function buildPrizePreview(): PrizePreview {
  const gross = money(FIXTURE_GROSS, CURRENCY);
  const deductions = money(FIXTURE_DEDUCTIONS, CURRENCY);
  const tax = money(FIXTURE_TAX, CURRENCY);
  const net = money(FIXTURE_NET, CURRENCY);

  const shares = FIXTURE_SHARES.map((share) => ({ key: share.id, numerator: share.weight }));
  const allocated = allocateByShareNumerators(net.minor, shares);

  const allocations: AllocationRow[] = FIXTURE_SHARES.map((share) => ({
    id: share.id,
    label: share.label,
    participants: share.participants,
    computed: moneyFromMinor(allocated.get(share.id) ?? 0n),
    ruleVersion: RULE_VERSION,
  }));

  const distributed = [...allocated.values()].reduce((total, minor) => total + minor, 0n);

  return {
    currency: CURRENCY,
    gross,
    deductions,
    tax,
    net,
    allocations,
    variance: moneyFromMinor(distributed - net.minor),
  };
}

export interface RosterRow {
  readonly handle: string;
  readonly attendance: "present" | "late" | "absent";
  readonly movement: TierMovementKind;
  readonly previousTier: Tier;
  readonly newTier: Tier;
  readonly winRatePercent: number;
  readonly reason: string;
}

/**
 * Late threshold for a player session, in milliseconds.
 *
 * A PARAMETER, not a constant, and that is deliberate: the recovered domain
 * model has no lateness number in it, so the threshold is a policy decision
 * that belongs to the organisation and is stated where it is applied rather
 * than baked into the app. Fifteen minutes is the value used for this preview.
 */
const LATE_THRESHOLD_MS = 15 * 60 * 1000;

const SESSION_START = new Date("2026-06-14T18:00:00.000Z");

interface RosterFixture {
  readonly handle: string;
  readonly arrivalAt: Date | null;
  readonly winRatePercent: number;
  readonly currentTier: Tier;
  readonly isTrial: boolean;
}

const FIXTURE_ROSTER: readonly RosterFixture[] = [
  { handle: "kirra", arrivalAt: new Date("2026-06-14T17:52:00.000Z"), winRatePercent: 62, currentTier: "T2", isTrial: false },
  { handle: "nineveh", arrivalAt: new Date("2026-06-14T18:41:00.000Z"), winRatePercent: 50, currentTier: "T2", isTrial: false },
  { handle: "ozz", arrivalAt: null, winRatePercent: 34, currentTier: "T1", isTrial: false },
  { handle: "bramble", arrivalAt: new Date("2026-06-14T17:58:00.000Z"), winRatePercent: 88, currentTier: "T3", isTrial: true },
];

export function buildRosterPreview(): readonly RosterRow[] {
  return FIXTURE_ROSTER.map((fixture) => {
    const attendance = resolveAttendanceStatus({
      sessionStartAt: SESSION_START,
      arrivalAt: fixture.arrivalAt,
      lateThresholdMs: LATE_THRESHOLD_MS,
    });
    const movement = computeTierMovement({
      winRatePercent: fixture.winRatePercent,
      currentTier: fixture.currentTier,
      isTrial: fixture.isTrial,
    });

    return {
      handle: fixture.handle,
      attendance,
      movement: movement.movement,
      previousTier: movement.previousTier,
      newTier: movement.newTier,
      winRatePercent: movement.winRatePercent,
      reason: movement.reason,
    };
  });
}