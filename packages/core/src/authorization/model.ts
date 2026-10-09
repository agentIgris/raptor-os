/**
 * The role model: roles, grants, and effective dating.
 *
 * Two ideas carry the weight here.
 *
 * **Server-determined scope.** In the legacy app the client chose the scope: a
 * nullable `team_id` both identified a team *and* acted as a scope marker, so
 * `null` silently meant "whole organisation" (`AUDIT/10_AUTHORIZATION.md`
 * F-RBAC-01). Here a {@link Role} declares the scope types it may ever be
 * granted at, and `validateAssignmentScope` refuses anything else at the moment
 * of construction. A grant that cannot be constructed cannot be persisted.
 *
 * **Effective dating.** A grant has a window. An assignment whose `validTo` has
 * passed grants nothing, and one whose `validFrom` is in the future grants
 * nothing — which is what makes a temporary elevation (a tournament-week
 * finance admin) revocable without a delete. Nothing here reads a clock: `at`
 * is always a parameter, so a test can evaluate a decision for a date in the
 * past and get the answer that date would have produced.
 */

import type { Permission } from "./permissions.js";
import { isPermission } from "./permissions.js";
import type { ScopeType } from "./scopes.js";
import { SCOPE_RANK, SCOPE_TYPES } from "./scopes.js";

/**
 * A named, reusable bundle of permissions and the scopes they may be exercised at.
 *
 * `permittedScopes` is a *ceiling*, not a default. A `team` role may be granted
 * at `team` or `self`; granting it at `organization` is refused even by an
 * administrator, because an administrator choosing which grant to create is not
 * the same as being able to create any grant.
 */
export interface Role {
  /** Durable stable key. Renaming the display `name` must not change this. */
  readonly key: string;
  readonly name: string;
  /** Encoded permissions, deduplicated and sorted so two equal roles are `===` deep-equal. */
  readonly permissions: readonly Permission[];
  /** Scope types this role may ever be granted at. */
  readonly permittedScopes: readonly ScopeType[];
}

/** An effective-dated, scope-bound grant of a role to a person. */
export interface RoleAssignment {
  readonly roleKey: string;
  readonly personId: string;
  readonly organizationId: string;
  readonly scopeType: ScopeType;
  /**
   * The row the scope names, or `null` for `self` scope. `null` at any other
   * scope type is a construction error, because "somewhere in the organisation"
   * is not a scope.
   */
  readonly scopeId: string | null;
  readonly validFrom: Date;
  /** `null` means open-ended. Exclusive at the boundary, like SQL's `tstzrange`. */
  readonly validTo: Date | null;
  readonly grantedBy: string;
}

export interface RoleDraft {
  key: string;
  name: string;
  permissions: readonly string[];
  permittedScopes: readonly string[];
}

export interface AssignmentDraft {
  roleKey: string;
  personId: string;
  organizationId: string;
  scopeType: ScopeType;
  scopeId: string | null;
  validFrom: Date;
  validTo?: Date | null;
  grantedBy: string;
}

/**
 * Build a role, rejecting anything that could only ever mislead.
 *
 * Validation is strict because a role with no permissions is indistinguishable
 * from a role that failed to load, and a role permitting an off-catalogue scope
 * would make the compiled matrix disagree with the RLS policies derived from it.
 */
export function createRole(draft: RoleDraft): Role {
  if (draft.key.trim() === "") {
    throw new Error("Role key must be a non-empty stable identifier");
  }

  const permissions = [...new Set(draft.permissions)];
  if (permissions.length === 0) {
    throw new Error(`Role ${draft.key} has no permissions; it could never authorise anything`);
  }
  for (const candidate of permissions) {
    if (!isPermission(candidate)) {
      throw new Error(`Role ${draft.key} references unknown permission ${JSON.stringify(candidate)}`);
    }
  }

  const permittedScopes: ScopeType[] = [];
  for (const candidate of draft.permittedScopes) {
    if (!SCOPE_TYPES.includes(candidate as ScopeType)) {
      throw new Error(`Role ${draft.key} permits unknown scope type ${JSON.stringify(candidate)}`);
    }
    if (!permittedScopes.includes(candidate as ScopeType)) permittedScopes.push(candidate as ScopeType);
  }
  if (permittedScopes.length === 0) {
    throw new Error(`Role ${draft.key} permits no scope type; it could never be granted`);
  }

  return Object.freeze({
    key: draft.key,
    name: draft.name,
    permissions: Object.freeze(permissions.sort()) as readonly Permission[],
    // Broadest first, so a consumer reading `permittedScopes[0]` sees the ceiling.
    permittedScopes: Object.freeze(permittedScopes.sort((a, b) => SCOPE_RANK[b] - SCOPE_RANK[a])),
  });
}

/** Whether the role may be granted at this scope type at all. */
export function rolePermitsScope(role: Role, scopeType: ScopeType): boolean {
  return role.permittedScopes.includes(scopeType);
}

/**
 * Validate a proposed grant scope against the role's ceiling, returning the
 * `scopeId` to store.
 *
 * This is the server-determined-scope guard. It runs before persistence, so the
 * caller never chooses an unpermitted scope in the first place; and it is
 * re-runnable, so a role edited later to narrow its scopes can be audited
 * against grants already in existence.
 */
export function validateAssignmentScope(role: Role, scopeType: ScopeType, scopeId: string | null): string | null {
  if (!rolePermitsScope(role, scopeType)) {
    throw new Error(
      `Role ${role.key} cannot be granted at ${scopeType} scope; it permits only ${role.permittedScopes.join(", ")}`,
    );
  }

  if (scopeType === "self") {
    if (scopeId !== null) {
      throw new Error(`self scope must carry a null scopeId; received ${JSON.stringify(scopeId)}`);
    }
    return null;
  }

  if (scopeId === null || scopeId === "") {
    throw new Error(`Scope type ${scopeType} requires a scopeId identifying the row the scope names`);
  }
  return scopeId;
}

/** {@link validateAssignmentScope} as a bare assertion, for call sites that discard the result. */
export function assertScopePermitted(role: Role, scopeType: ScopeType, scopeId: string | null): void {
  validateAssignmentScope(role, scopeType, scopeId);
}

/**
 * Build an assignment, enforcing the scope ceiling and a sane date window.
 *
 * The window is half-open `[validFrom, validTo)`, matching Postgres range
 * semantics, so handing a role from one person to the next at the same instant
 * leaves no gap and no overlap.
 */
export function createAssignment(draft: AssignmentDraft): RoleAssignment {
  const validTo = draft.validTo ?? null;
  if (validTo !== null && validTo.getTime() <= draft.validFrom.getTime()) {
    throw new Error(
      `Assignment for ${draft.roleKey} has validTo ${validTo.toISOString()} at or before validFrom ${draft.validFrom.toISOString()}`,
    );
  }
  return Object.freeze({
    roleKey: draft.roleKey,
    personId: draft.personId,
    organizationId: draft.organizationId,
    scopeType: draft.scopeType,
    scopeId: draft.scopeId ?? null,
    validFrom: draft.validFrom,
    validTo,
    grantedBy: draft.grantedBy,
  });
}

/** Whether an assignment's window contains `at` and the window is itself well-formed. */
export function isAssignmentActive(assignment: RoleAssignment, at: Date): boolean {
  const from = assignment.validFrom.getTime();
  if (at.getTime() < from) return false;
  if (assignment.validTo === null) return true;
  return at.getTime() < assignment.validTo.getTime();
}

/** {@link isAssignmentActive} under a name that reads correctly in a filter chain. */
export function assignmentActiveAt(assignment: RoleAssignment, at: Date): boolean {
  return isAssignmentActive(assignment, at);
}

/**
 * The broadest assignment a person holds at `at`, or `null`.
 *
 * Only assignments in `organizationId` are considered: ADR-0011 makes the tenant
 * part of every identity, so an org-wide grant from another tenant must never
 * widen this one. This is what navigation uses to decide what to render.
 */
export function maxAssignment(
  personId: string,
  organizationId: string,
  assignments: readonly RoleAssignment[],
  at: Date,
): RoleAssignment | null {
  let widest: RoleAssignment | null = null;
  for (const candidate of assignments) {
    if (candidate.personId !== personId) continue;
    if (candidate.organizationId !== organizationId) continue;
    if (!isAssignmentActive(candidate, at)) continue;
    if (widest === null || SCOPE_RANK[candidate.scopeType] > SCOPE_RANK[widest.scopeType]) {
      widest = candidate;
    }
  }
  return widest;
}