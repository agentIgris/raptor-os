/**
 * The decision function.
 *
 * One pure function answers "may this actor take this action on this resource
 * within this scope at this instant", and answers it with a **reason**. The
 * reason is not decoration: the audit found no way to answer "why was this
 * denied", the nav needed to explain a hidden menu item, and support needed to
 * tell a player whose payout they cannot yet see. A boolean satisfies none of
 * the three, so a boolean is not what this returns.
 *
 * `at` is always a parameter and the module never calls `Date.now()`. A
 * decision for a past instant is reproducible, which is what lets an audit row
 * be re-checked months later against the same policy version.
 *
 * Evaluation order is fixed and documented because a decision must be
 * reproducible:
 *
 *   1. validate the request (fail loudly on a malformed one)
 *   2. tenant check — the scope's organisation must be the actor's
 *   3. applicable DENY rules (tenant policy beats role)
 *   4. applicable conditions on the request (amount limits, separation of duties)
 *   5. active assignments, narrowed to the actor's own and the actor's tenant
 *   6. per assignment: does the role exist, hold the permission, and cover the scope?
 *   7. ALLOW on the first assignment that satisfies all three
 *
 * A denial reports the *closest* reason: if the actor held the role but at too
 * narrow a scope, the denial says so rather than the generic "no permission".
 */

import type { Action, Permission, Resource } from "./permissions.js";
import { isAction, isResource, permission } from "./permissions.js";
import type { Role, RoleAssignment } from "./model.js";
import { isAssignmentActive, rolePermitsScope } from "./model.js";
import type { ConditionContext, PolicyCondition, PolicyRule } from "./policy.js";
import { evaluateCondition, ruleMatches } from "./policy.js";
import type { ScopeType } from "./scopes.js";
import { compareScopeRank, scopeCovers } from "./scopes.js";

/** A scope instance: the type plus the row it names. */
export interface ScopeRef {
  readonly type: ScopeType;
  /** `null` only for `self` scope. */
  readonly id: string | null;
  /**
   * The tenant the scope belongs to. Optional, because most call sites already
   * resolved it; when present it is checked, because a scope pointing at another
   * tenant is the cross-tenant leak ADR-0011 exists to prevent.
   */
  readonly organizationId?: string;
}

/** The actor's identity and the grants held at `at`. */
export interface Actor {
  readonly personId: string;
  readonly organizationId: string;
  readonly assignments: readonly RoleAssignment[];
}

export interface AuthorizationRequest {
  readonly actor: Actor;
  readonly resource: Resource;
  readonly action: Action;
  readonly scope: ScopeRef;
  /** The role catalogue. Looked up by key; never mutated. */
  readonly roles: readonly Role[];
  /** The instant to evaluate at. Never defaulted from a clock. */
  readonly at: Date;
  /** Actor id used by conditions. Defaults to `actor.personId` when omitted. */
  readonly actorId?: string;
  /** Owner of the target record, for separation-of-duties conditions. */
  readonly resourceOwnerId?: string;
  /** Request-scoped conditions (e.g. an amount limit for this particular invoice). */
  readonly conditions?: readonly PolicyCondition[];
  /** Tenant policy rules. A matching DENY rule overrides any role grant. */
  readonly policyRules?: readonly PolicyRule[];
}

/** Why a decision went the way it did. */
export type DenialReason =
  | "no_active_assignment"
  | "unknown_role"
  | "permission_not_in_role"
  | "scope_not_covered_by_grant"
  | "scope_id_mismatch"
  | "separation_of_duties_violation"
  | "policy_condition_failed";

export type AllowReason = "role_grants_permission";

/**
 * The outcome.
 *
 * `roleKey`, `permission` and `matchedScope` are populated on both allow and
 * deny wherever they are known, because "who almost let you do this, and over
 * what boundary" is the question support actually needs answered.
 */
export interface Decision {
  readonly effect: "ALLOW" | "DENY";
  readonly reason: AllowReason | DenialReason;
  /** The permission that was requested, whether or not it was granted. */
  readonly permission: Permission;
  readonly roleKey: string | null;
  /** The scope the grant was made at, when one matched the actor. */
  readonly matchedScope: ScopeRef | null;
  /** The rule id, when a policy rule or the built-in SoD rule caused a denial. */
  readonly policyRuleId: string | null;
}

/**
 * Actions that bind the organisation or move money, and therefore carry the
 * built-in "requester must not equal approver" rule.
 *
 * `read` and `update` are excluded on purpose: an approver needs to read their
 * own invoice to review it, and blocking that would push people to approve
 * without reading.
 */
const SEPARATION_OF_DUTIES_ACTIONS: ReadonlySet<Action> = new Set<Action>(["approve", "sign", "pay"]);

const SO_D_RULE_ID = "requester_must_not_equal_approver";

/**
 * Decide. Pure: no clock, no network, no database.
 *
 * Throws only for a malformed *request* (unknown permission, scope that names
 * nothing, cross-tenant scope). A malformed request is a bug in the calling
 * code, and silently denying it would hide that bug; everything else returns a
 * decision.
 */
export function evaluate(request: AuthorizationRequest): Decision {
  const requested: Permission = buildPermission(request.resource, request.action);
  const actorId = request.actorId ?? request.actor.personId;
  const scope = request.scope;

  if (scope.organizationId !== undefined && scope.organizationId !== request.actor.organizationId) {
    throw new Error(
      `Scope belongs to organisation ${scope.organizationId} but the actor belongs to ${request.actor.organizationId}; refusing to evaluate a cross-tenant scope`,
    );
  }
  assertScopeWellFormed(scope);

  const conditions: ConditionContext = {
    actorId,
    resourceOwnerId: request.resourceOwnerId,
  };

  // 3. Tenant deny rules beat every role grant.
  for (const rule of request.policyRules ?? []) {
    if (rule.effect !== "DENY") continue;
    if (!ruleMatches(rule, request.resource, request.action, scope.type)) continue;
    if (evaluateCondition(rule.condition, conditions)) {
      return deny(requested, "policy_condition_failed", null, null, rule.id);
    }
  }

  // 4. Built-in separation of duties, then request-scoped conditions.
  const requiresSoD =
    SEPARATION_OF_DUTIES_ACTIONS.has(request.action) &&
    actorId !== undefined &&
    request.resourceOwnerId !== undefined &&
    actorId === request.resourceOwnerId;
  if (requiresSoD) {
    return deny(requested, "separation_of_duties_violation", null, null, SO_D_RULE_ID);
  }

  for (const condition of request.conditions ?? []) {
    if (!evaluateCondition(condition, conditions)) {
      return deny(requested, "policy_condition_failed", null, null, null);
    }
  }

  // 5-7. Only the actor's own grants, in the actor's own tenant. `pickGrant`
  // always returns a candidate — a denial carries the closest near-miss rather
  // than nothing, so there is no "no candidate" case to handle here.
  const candidate = pickGrant(request, requested);
  if (candidate.reason !== null) {
    return deny(requested, candidate.reason, candidate.roleKey, candidate.matchedScope, null);
  }

  return {
    effect: "ALLOW",
    reason: "role_grants_permission",
    permission: requested,
    roleKey: candidate.roleKey,
    matchedScope: candidate.matchedScope,
    policyRuleId: null,
  };
}

/** Whether a decision allows the action. Provided so callers need not branch on the string. */
export function isAllowed(decision: Decision): boolean {
  return decision.effect === "ALLOW";
}

/** Whether a decision denies. The negation of {@link isAllowed}, named for readability at call sites. */
export function isDenied(decision: Decision): boolean {
  return decision.effect === "DENY";
}

interface Candidate {
  readonly roleKey: string | null;
  readonly matchedScope: ScopeRef | null;
  readonly reason: DenialReason | null;
}

function pickGrant(request: AuthorizationRequest, requested: Permission): Candidate {
  const { actor, roles, at, scope } = request;
  const byKey = new Map(roles.map((role) => [role.key, role]));

  const active = actor.assignments.filter(
    (assignment) =>
      assignment.personId === actor.personId &&
      assignment.organizationId === actor.organizationId &&
      isAssignmentActive(assignment, at),
  );

  if (active.length === 0) {
    return { roleKey: null, matchedScope: null, reason: "no_active_assignment" };
  }

  // Track the closest near-miss so a denial explains itself instead of
  // collapsing to "no active assignment".
  let nearMiss: Candidate | null = null;

  for (const assignment of active) {
    const matchedScope: ScopeRef = { type: assignment.scopeType, id: assignment.scopeId };
    const role = byKey.get(assignment.roleKey);
    if (role === undefined) {
      if (nearMiss === null) {
        nearMiss = { roleKey: assignment.roleKey, matchedScope, reason: "unknown_role" };
      }
      continue;
    }

    if (!role.permissions.includes(requested)) {
      if (nearMiss === null) {
        nearMiss = { roleKey: role.key, matchedScope, reason: "permission_not_in_role" };
      }
      continue;
    }

    // A grant whose scope type the role could never hold at is a data-integrity
    // problem upstream, not a policy decision; treat it as an over-broad refusal.
    if (!rolePermitsScope(role, assignment.scopeType)) {
      if (nearMiss === null) {
        nearMiss = { roleKey: role.key, matchedScope, reason: "scope_not_covered_by_grant" };
      }
      continue;
    }

    if (!scopeCovers(assignment.scopeType, scope.type)) {
      if (nearMiss === null) {
        nearMiss = { roleKey: role.key, matchedScope, reason: "scope_not_covered_by_grant" };
      }
      continue;
    }

    if (!idMatches(assignment, scope)) {
      if (nearMiss === null) {
        nearMiss = { roleKey: role.key, matchedScope, reason: "scope_id_mismatch" };
      }
      continue;
    }

    return { roleKey: role.key, matchedScope, reason: null };
  }

  // Unreachable while every `continue` above records a near-miss: the loop
  // always either returns an allow or leaves `nearMiss` set. The fallback keeps
  // the return total if a future branch forgets to record one.
  return nearMiss ?? { roleKey: null, matchedScope: null, reason: "no_active_assignment" };
}

/**
 * Whether a grant names the same scope instance the request names.
 *
 * Only compared at equal breadth. A strictly broader grant already covers the
 * narrower scope by containment — an `organization` grant covering `org_1`
 * reaches department `dep_1` inside it without needing to name it — so
 * demanding id equality there would deny the very case the rank ordering exists
 * to permit. At equal breadth the ids must match, which is what stops a grant
 * on `team_7` from authorising `team_9`.
 */
function idMatches(assignment: RoleAssignment, scope: ScopeRef): boolean {
  if (compareScopeRank(assignment.scopeType, scope.type) !== 0) return true;
  return assignment.scopeId === scope.id;
}

function deny(
  requested: Permission,
  reason: DenialReason,
  roleKey: string | null,
  matchedScope: ScopeRef | null,
  policyRuleId: string | null,
): Decision {
  return {
    effect: "DENY",
    reason,
    permission: requested,
    roleKey,
    matchedScope,
    policyRuleId,
  };
}

function buildPermission(resource: Resource, action: Action): Permission {
  if (!isResource(resource) || !isAction(action)) {
    throw new Error(
      `Unknown permission: ${JSON.stringify(`${resource}:${action}`)} (not in the catalogue)`,
    );
  }
  return permission(resource, action);
}

function assertScopeWellFormed(scope: ScopeRef): void {
  if (scope.type === "self") {
    if (scope.id !== null) {
      throw new Error(`self scope must carry a null id; received ${JSON.stringify(scope.id)}`);
    }
    return;
  }
  if (scope.id === null || scope.id === "") {
    throw new Error(`Scope type ${scope.type} requires a scopeId identifying the row it names`);
  }
}