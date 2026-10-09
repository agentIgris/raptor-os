/**
 * Scope breadth.
 *
 * A scope answers "within which boundary does this action apply". The legacy
 * app had no such thing: `team_id` was a nullable column that doubled as both a
 * foreign key and a scope marker, so a `null` team meant "everything" and a
 * client-chosen `team_id` meant "whatever you asked for" (`AUDIT/10_AUTHORIZATION.md`
 * F-RBAC-01).
 *
 * Scope is only safe if breadth is a **total order**. If two scopes were merely
 * "different", then checking `granted === requested` would make the hierarchy
 * unenforceable — a `team` grant could not be reasoned about against a
 * `department` request at all. So the order is made explicit here, in one
 * table, and every other part of the engine derives from it rather than
 * re-deriving it with ad-hoc comparisons.
 */

/**
 * Every scope type the product recognises, ordered broadest to narrowest.
 *
 * The order is load-bearing: `self` is last because it is the narrowest scope
 * that exists, and the engine relies on array position being rank order.
 */
export const SCOPE_TYPES = [
  "organization",
  "department",
  "division",
  "team",
  "campaign",
  "assigned",
  "self",
] as const;

export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Breadth rank per scope type. Higher means broader; `organization` is the
 * ceiling and `self` the floor.
 *
 * Exported as data because three of the four consumers of this module need it
 * as data, not as a function: navigation decides what to show, RLS wants a
 * `max_scope_rank` column, and the audit log wants to record the boundary an
 * action was taken within.
 */
export const SCOPE_RANK: Readonly<Record<ScopeType, number>> = Object.freeze({
  organization: 6,
  department: 5,
  division: 4,
  team: 3,
  campaign: 2,
  assigned: 1,
  self: 0,
});

/** Numeric breadth of a scope type. Higher is broader. */
export function scopeRank(type: ScopeType): number {
  return SCOPE_RANK[type];
}

/** Scope types from broadest to narrowest, as a fresh array callers may mutate. */
export function scopeTypesByBreadth(): ScopeType[] {
  return [...SCOPE_TYPES];
}

/**
 * Compare two scopes by breadth: `1` when `a` is broader, `-1` when narrower,
 * `0` when equal.
 *
 * Returns `-1 | 0 | 1` rather than a bare boolean so callers that need a sort
 * comparator (the compiled matrix, a nav ordering) do not re-derive it.
 */
export function compareScopeRank(a: ScopeType, b: ScopeType): -1 | 0 | 1 {
  if (scopeRank(a) > scopeRank(b)) return 1;
  if (scopeRank(a) < scopeRank(b)) return -1;
  return 0;
}

/**
 * Whether a grant made at `granted` reaches a request made at `requested`.
 *
 * This is the over-broad-grant guard. A role granted at `team` does **not**
 * authorise an `organization` request; an `organization` grant does authorise a
 * `self` request. Without this single predicate every call site grows its own
 * version of the same comparison, which is how five disagreeing permission
 * models happened in the first place.
 */
export function scopeCovers(granted: ScopeType, requested: ScopeType): boolean {
  return compareScopeRank(granted, requested) >= 0;
}