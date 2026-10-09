# ADR-0016 — Domain rules recovered from legacy source; one preserved rule withdrawn

**Status:** Accepted · **Date:** 2026-10-09
**Amends:** [ADR-0001](0001-rebuild-from-scratch.md)

## Why this exists

ADR-0001 committed to preserving the legacy system's real operational knowledge — the tryout
state machine, the attendance cutoff rules, the slot-expense arithmetic and the tier ladder.
Four of those rules are written down nowhere in the audit. They had to be read out of the
source, because a rewrite that invents them would be a rewrite of a fiction.

This ADR records what the source actually says, what could not be determined, and one
preserved rule that turns out not to exist.

## Withdrawn: OCK / SSF / WWF

ADR-0001 listed a "tier pricing ladder (OCK / SSF / WWF)" among the domain knowledge worth
carrying. **Those three names do not exist in the legacy system.**

Verified independently of the agent that first raised it: a search of the entire checkout —
every `.ts`, `.tsx`, `.sql`, `.md` and `.json`, across all 22 remote branches — returns zero
matches. They occur only in the audit's own prose (`MASTER_AUDIT_REPORT.md`,
`95_FINAL_RECOMMENDATION.md`) and, having been quoted into ADR-0001, in this repository's own
decision record.

The ladder that is really implemented is:

```
T4 → T3 → T2 → T1 → godtier      (lib/team-logic.ts:43)
```

with promotion at win rate `> 50%`, retention within `35–50%`, and demotion below `35%`
(`lib/team-logic.ts:104-124`). Both ends clamp. ADR-0001 has been corrected.

The lesson is worth stating plainly: this project audits a codebase for what it fails to do,
and in doing so copied an unverified noun list out of the audit's narrative and treated it as
a specification. A finding in prose is a hypothesis. Only a finding in source is a fact.

## Recovered rules, with confidence

### High confidence — carried into the rewrite

**1. The attendance cutoff is `cutoff_time < CURRENT_TIME`.** Strict less-than, evaluated
server-side in SQL, with no offset and no grace period
(`automation-scripts/02-session-attendance-automation.sql:88-139`). The session's
`start_time` is never referenced in the comparison at all — the cutoff is an independent
column on the session row, not derived from its start.

**2. "Late" is never computed.** No code anywhere derives `late` from an arrival time. It is
a literal the player clicks (`components/attendance/session-attendance.tsx:163-178`), and the
schema stores no arrival timestamp, so the distinction is unrecoverable afterwards.
`absent` is the only status any system decides on its own.

**3. Slot cost is exactly `rate × number_of_slots`.** Integer multiplication. No percentage,
no deduction, no discount, no rounding, no tax, no currency minor unit
(`automation-scripts/04-business-logic-automation.sql:12-32`).

**4. The tryout pipeline has three working transitions, not nine.** Only
`applied → invited → evaluated` is ever written
(`app/api/discord/tryout/{apply,invite,evaluate}/route.ts`). The remaining nine states the
schema permits — `screened`, `shortlisted`, `withdrawn`, `selected`, `rejected`, and every
`tryout_invitations` and `tryout_sessions` transition — are declared in CHECK constraints and
written by nothing. `tryout_selections` has no INSERT or UPDATE anywhere in the tree.

**5. Tier movement thresholds.** Promote above 50%, retain 35–50%, demote below 35%, with a
single `POST /api/teams/monthly` that permanently rewrites `teams.tier`
(`app/api/teams/monthly/route.ts:118-125`).

### Deliberately NOT carried — these are defects, not knowledge

| Legacy behaviour | Why it is not preserved |
| --- | --- |
| Three coexisting `auto_mark_absent_after_cutoff` definitions | They disagree on `is_mandatory`, on `session_type`, and on the existence test. A rule that has three answers is not a rule. |
| Three coexisting `generate_daily_practice_sessions` definitions | One ignores the holiday check entirely, one ignores `practice_session_config` entirely and hardcodes `cutoff_time = 12:00`, one is unqualified and therefore a *different function identity* that can coexist with the qualified one. |
| `attendances.session_time` as `text` | Written simultaneously as a human-typed label, a five-value enum, a `time` value, a denormalised copy of `session_subtype`, and (via the Discord route) a time-range string like `"06:00:00 - 10:00:00"`. Used as a join key against `session_subtype`, which is why the audit is right that it roots the attendance bug backlog. Replaced by a real `timestamptz` (ADR-0011 convention). |
| No timezone anywhere | `time without time zone` compared against the server's `CURRENT_TIME`, while the browser independently computed cutoff in local time. IST and UTC disagree by 5h30m with nothing to reconcile them. |
| `'auto'` attendance status | Treated as **present** in one endpoint, **absent** in another, and **neither** in a third. The same player on the same day gets a different attendance rate depending on which screen is asked. |
| Slot expense double-counting | `AFTER INSERT` trigger creates the expense row, then the API inserts a second one and swallows the failure with `console.warn`. Every API-created slot is billed twice. |
| Three rate cards seeded with `DO UPDATE` vs `DO NOTHING` | The live rate card is decided by migration order and the three disagree by roughly 10×. |

### Not determinable from source

Recorded so that no future phase treats these as settled:

- **Which of the three cutoff definitions was live.** All three exist in the tree.
- **Which rate card applied.** Migration-order dependent.
- **What `'auto'` means.** Genuinely undecidable; it is not merely ambiguous in the schema
  but interpreted inconsistently at read time.
- **Whether generated and manual sessions are distinguishable.** No column records it — the
  only fingerprints are cosmetic title and description text.

## What this changes in the design

1. **Attendance gets an arrival timestamp.** Since "late" must become computable rather than
   self-declared, the schema needs a recorded arrival instant. Without it the legacy ambiguity
   is unreproducible by construction.
2. **Session generation gets one implementation**, not three, and an explicit provenance
   column so generated and manual sessions can be told apart in data rather than by
   substring-matching a title.
3. **Every time is `timestamptz`.** No bare `time without time zone` anywhere.
4. **The cutoff rule is written once, in `packages/core`, and tested**, rather than embedded
   three times in SQL triggers where three drifts can accumulate.
5. **The tier ladder is an enum**, with `teams.tier` constrained — the legacy column was free
   text with a default and no CHECK, so any string could be stored.