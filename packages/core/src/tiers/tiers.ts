/**
 * The tier ladder and the movement rule.
 *
 * The ladder is recovered verbatim from `lib/team-logic.ts:43`:
 *
 * ```
 * T4 → T3 → T2 → T1 → godtier
 * ```
 *
 * It is a closed tuple, not free text. The legacy `teams.tier` column had a
 * default and no CHECK, so `OCK`, `SSF`, `godtier ` and `gode tier` were all
 * storable. ADR-0016 additionally withdrew the "OCK / SSF / WWF" ladder that
 * ADR-0001 had claimed: those three names occur nowhere in the legacy source, in
 * any branch. They are not here.
 *
 * Movement is recovered from `lib/team-logic.ts:104-124` and from the single
 * `POST /api/teams/monthly` route that permanently rewrote `teams.tier`
 * (`app/api/teams/monthly/route.ts:118-125`):
 *
 * - promote above 50%
 * - retain within 35–50% inclusive
 * - demote below 35%
 *
 * Both ends of that ladder clamp. `promote("godtier")` is `godtier` and
 * `demote("T4")` is `T4`; a team at the ceiling cannot be promoted into a rank
 * that does not exist, and a team at the floor cannot fall off it.
 *
 * The 50% boundary is strict and it is pinned by a test: exactly 50.0 is
 * **retained**. Legacy wrote `> 50`, and that single character decides whether a
 * team that merely held even is promoted along with every other team that held
 * even, all in the same run of the monthly job.
 */

/**
 * The ladder, ordered ascending from the lowest tier to the highest.
 *
 * `as const` so `Tier` is a closed union and an off-ladder string is a compile
 * error rather than a runtime surprise.
 */
export const TIER_LADDER = ["T4", "T3", "T2", "T1", "godtier"] as const;

export type Tier = (typeof TIER_LADDER)[number];

const TIER_SET: ReadonlySet<string> = new Set(TIER_LADDER);

/** Narrows an untrusted string — from `teams.tier`, which was free text. */
export function isTier(value: string): value is Tier {
  return TIER_SET.has(value);
}

/**
 * Position in the ladder, 0 at `T4` and 4 at `godtier`.
 *
 * Exposed because "is this team above that one" is a question the ladder answers
 * better with numbers than with repeated string comparison, and because it makes
 * the ordering assertable rather than merely conventional.
 */
export function tierRank(tier: Tier): number {
  const rank = TIER_LADDER.indexOf(tier);
  if (rank < 0) {
    throw new Error(`Unknown tier: ${JSON.stringify(tier)} (expected one of ${TIER_LADDER.join(", ")})`);
  }
  return rank;
}

/**
 * Move a team exactly one rung up, **clamping at the top**.
 *
 * A team already at `godtier` stays at `godtier`. Clamping rather than throwing
 * because the monthly job applies this to every team at once and must not abort
 * half way because one of them was already at the ceiling.
 */
export function promote(tier: Tier): Tier {
  return move(tier, 1);
}

/**
 * Move a team exactly one rung down, **clamping at the bottom**.
 *
 * A team already at `T4` stays at `T4`, for the same reason: the monthly job is
 * not allowed to fail on a boundary team.
 */
export function demote(tier: Tier): Tier {
  return move(tier, -1);
}

function move(tier: Tier, delta: 1 | -1): Tier {
  const rank = tierRank(tier);
  const next = Math.min(Math.max(rank + delta, 0), TIER_LADDER.length - 1);
  // Bounded above by the clamp, so the index is always in range.
  return TIER_LADDER[next] as Tier;
}