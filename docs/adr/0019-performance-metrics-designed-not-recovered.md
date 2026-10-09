# ADR-0019 — Performance metrics are designed, not recovered

**Status:** Accepted · **Date:** 2026-10-10
**Completes:** Phase 2 of the design spec
**Relates to:** [ADR-0016](0016-domain-rules-recovered-from-legacy-source.md)

## Why this ADR is different in kind

ADR-0016 recovered rules from the legacy source and carried them forward. This one records the
opposite outcome: **there is no performance formula in the legacy system to recover.** Phase 2
of the spec requires "performance + metrics", and that requirement cannot be satisfied by
preservation. It has to be designed, and the difference should not be blurred.

## What the legacy system actually contained

A `performances` table, and a great deal of arithmetic that was never derived from data.

**There is no match entity.** No matches table, no `match_id`, no map pool, no per-match
roster. A "match" exists only as one player's `performances` row, so every aggregate counts
*player-rows*, not matches. `/api/public/stats/route.ts:26-28` counts rows for matches and
rows with `placement = 1` for WWCD, so a single team win by a four-player squad reports **four
wins** — then adds hardcoded baselines of `37800 / 3240 / 1134` that nothing can recompute.

**`performances.slot` is permanently NULL.** The API nulls it on every insert and a trigger
enforces it, while the real link goes to `slot_id`. The only performance↔winnings join can
therefore never match, and `total_winnings` is structurally always zero. Net profit/loss was
always negative by exactly the total spend.

**Fabricated metrics were rendered as real ones:**

| Displayed as | Actually computed |
| --- | --- |
| "Win rate" | `totalMatches * 0.7` |
| "Team Ranking" | `Math.ceil(totalMatches / 5)` |
| OCR confidence | hardcoded `85` |

**`bestDay` returns the oldest day.** `analytics/performance/route.ts:513` calls `days.sort(...)`
and discards the return value, then reads `days[0]` — still ascending from line 508.

**Time filtering uses `created_at`, not the match date.** Every window filters on insert
timestamp, so backfilled history lands in the present bucket. Trend buckets use UTC days while
period filters use local `new Date()` — two different calendars.

**Silent truncation.** `limit` defaults to unlimited but caps at 1000 when supplied
(`performances/route.ts:63-64`), and top-performer maps never report that they saw a truncated
set.

**No duplicate protection server-side.** The `UNIQUE(player_id, match_number, slot)` exists in
one DDL and not the other; the client-side check queries by `player_id` alone with no slot
filter, contradicting its own documentation, and runs over the anon client so RLS can void it.

## Explicitly absent from the source

Searched exhaustively across all `.ts`, `.tsx`, `.sql`, `.md`: **no** K/D or any death tracking
— so no true K/D ratio is computable. **No** ADR, ACS or impact rating. **No** headshot
percentage formula; the single occurrence is a zero default that is never rendered. **No**
computed or generated column. **No** provenance column on `performances`. **No** tie-breaker in
any leaderboard sort. **No** month-granularity rollup; trends bucket by day only. **No**
tier-based sort or filter anywhere.

## Genuinely unresolvable from source

Recorded so no later phase treats them as settled:

1. Which of the two mutually exclusive `performances` DDLs was live. `19-fix-slot-field-constraint.sql:51`
   runs `ALTER COLUMN slot DROP NOT NULL`, which only succeeds against a `NOT NULL` column —
   yet the same script's comment calls it an integer while the other DDL declares `uuid`.
2. Which of four `validate_performance_entry()` definitions won. They are `CREATE OR REPLACE`
   with no ordering marker in the repository.
3. **`survival_time`'s unit.** Minutes in one surface, seconds in another. A stored `10` and a
   stored `600` are indistinguishable in the data.
4. Which score formula was user-visible: `dashboard-data.ts` includes a win-rate term,
   `dashboard/page.tsx` does not, and a third inline implementation exists as a fallback
   depending on which endpoint succeeds.

## Decision

**Design the metric layer from first principles, using the new competitive schema as the
foundation the legacy system lacked.** Concretely:

1. **A metric derives from a match, never from a free-floating row.** The new `match`,
   `match_map` and `match_result` tables are the anchor. A per-player line references a match,
   so a four-player squad win is one match won, and no aggregate can double-count it the way
   counting player-rows did.
2. **Every computed value is reproducible from stored raw inputs**, and is stored with its
   derivation rather than recalculated on read. A metric that cannot be reproduced cannot be
   audited, and an esports org disputing a payout needs exactly that.
3. **Provenance is mandatory and non-optional.** `match_result` already carries `source` and
   `confidence`. Every player performance line inherits the same treatment: a hand-entered
   number is not the same claim as an imported one, and the legacy system could not tell them
   apart — which is how a hardcoded `85` came to be presented as OCR confidence.
4. **Units are named in the schema.** `survival_time` ambiguity is the lesson: a duration
   column with no unit in its name is a defect waiting to be misread. Duration columns carry an
   explicit unit suffix.
5. **Windows filter on the event date, never on `created_at`.** Backfilled history belongs to
   the period it happened in.
6. **Truncation is always reported.** A leaderboard that silently capped at 1000 rows and
   presented the result as a ranking is worse than one that refuses: it looks authoritative.

## What is deliberately NOT carried forward

Every fabricated metric above. In particular there is no "win rate = matches × 0.7", because a
number presented as a measurement while being an invented constant is the precise failure this
rebuild exists to eliminate. Where the legacy system displayed a metric that cannot be
computed from available data, the new system shows that it is unavailable.

## Standing risk

Design means new invention, which carries the risk ADR-0016 exists to avoid. The mitigation is
that these metrics are computed from a schema that is itself tested for isolation and
reproducibility, and that every derived value is stored alongside its inputs. Inventing a
formula is acceptable; inventing a *claim* is not.