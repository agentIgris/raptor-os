/**
 * The compiled matrix: one dataset, four consumers.
 *
 * The legacy failure was not that permissions were modelled badly; it was that
 * they were modelled *five times* — in TypeScript role config, in a DB CHECK, in
 * RLS policies, in API handler string comparisons, and in navigation — and the
 * five disagreed (`AUDIT/08_ROLES_PERMISSIONS.md`, `63_ROLE_MODEL.md` §5). Nav
 * let an analyst list users, RLS let a player read prize pools with the public
 * key, and neither matched the model.
 *
 * `compileMatrix` flattens roles into `(role, permission, scope)` rows so that
 * navigation, the API guard, the RLS policy generator and the audit log all
 * derive from the same array. The conformance test that asserts the API and the
 * SQL agree is only meaningful because both are projections of this.
 *
 * Output is sorted and frozen: a matrix that depends on the order roles happened
 * to be defined in cannot be diffed across a deploy, and a diff that cannot be
 * read is a diff nobody reviews.
 */

import type { Permission, Resource } from "./permissions.js";
import { parsePermission } from "./permissions.js";
import type { Role } from "./model.js";
import type { ScopeType } from "./scopes.js";
import { SCOPE_RANK, compareScopeRank } from "./scopes.js";

/** One flattened (role, permission, scope) fact. */
export interface MatrixRow {
  readonly roleKey: string;
  readonly permission: Permission;
  readonly resource: Resource;
  readonly scopeType: ScopeType;
  /** Denormalised rank, so a consumer comparing breadth needs no lookup table. */
  readonly scopeRank: number;
}

export interface PolicyMatrix {
  readonly rows: readonly MatrixRow[];
  /** `roleKey|permission` -> the scope types that role may exercise it at. */
  readonly byRoleAndPermission: ReadonlyMap<string, readonly ScopeType[]>;
  /** Every permission the catalogue knows about, sorted. */
  readonly permissions: readonly Permission[];
  /** Every role holding a permission, sorted. Empty when no role holds it. */
  rolesFor(encoded: Permission): string[];
  /** The broadest scope any role holds a permission at, or `null` if nobody holds it. */
  maxScopeFor(encoded: Permission): ScopeType | null;
  /** Every role with any permission on a resource, sorted. */
  rolesForResource(resource: Resource): string[];
}

function rowKey(roleKey: string, encoded: Permission): string {
  return `${roleKey}|${encoded}`;
}

/**
 * Flatten the role catalogue.
 *
 * Throws on an empty catalogue and on duplicate role keys. Both are load
 * failures dressed as data: an empty matrix is indistinguishable from "nobody
 * has permission" and would lock every tenant out while reporting success.
 */
export function compileMatrix(roles: readonly Role[]): PolicyMatrix {
  if (roles.length === 0) {
    throw new Error("Cannot compile a policy matrix from zero roles: an empty matrix locks out everyone");
  }

  const seenKeys = new Set<string>();
  const rows: MatrixRow[] = [];
  const byRoleAndPermission = new Map<string, ScopeType[]>();

  for (const role of roles) {
    if (seenKeys.has(role.key)) {
      throw new Error(`Duplicate role key ${role.key}: the matrix cannot represent two roles with one identity`);
    }
    seenKeys.add(role.key);

    for (const encoded of role.permissions) {
      const { resource } = parsePermission(encoded);
      for (const scopeType of role.permittedScopes) {
        rows.push({
          roleKey: role.key,
          permission: encoded,
          resource,
          scopeType,
          scopeRank: SCOPE_RANK[scopeType],
        });
      }
      const key = rowKey(role.key, encoded);
      const existing = byRoleAndPermission.get(key);
      byRoleAndPermission.set(
        key,
        existing === undefined ? [...role.permittedScopes] : [...existing, ...role.permittedScopes],
      );
    }
  }

  rows.sort((a, b) => {
    if (a.roleKey !== b.roleKey) return a.roleKey < b.roleKey ? -1 : 1;
    if (a.permission !== b.permission) return a.permission < b.permission ? -1 : 1;
    return compareScopeRank(b.scopeType, a.scopeType);
  });

  for (const [, scopes] of byRoleAndPermission) {
    scopes.sort((a, b) => compareScopeRank(b, a));
  }

  const rolesFor = (encoded: Permission): string[] =>
    [
      ...new Set(
        rows
          .filter((row) => row.permission === encoded)
          .map((row) => row.roleKey),
      ),
    ].sort();

  const maxScopeFor = (encoded: Permission): ScopeType | null => {
    let widest: ScopeType | null = null;
    for (const row of rows) {
      if (row.permission !== encoded) continue;
      if (widest === null || compareScopeRank(row.scopeType, widest) > 0) widest = row.scopeType;
    }
    return widest;
  };

  const rolesForResource = (resource: Resource): string[] =>
    [
      ...new Set(
        rows
          .filter((row) => row.resource === resource)
          .map((row) => row.roleKey),
      ),
    ].sort();

  return Object.freeze({
    rows: Object.freeze(rows),
    byRoleAndPermission,
    permissions: Object.freeze([...new Set(rows.map((row) => row.permission))].sort()),
    rolesFor,
    maxScopeFor,
    rolesForResource,
  });
}

/**
 * The navigation projection: role key -> the permissions to render affordances for.
 *
 * Convenience only, never security. A hidden menu item is not an authorisation
 * control, and the audit's players-read-prize-pools incident was a case of the
 * UI being correct while the data layer was not.
 */
export function matrixToNavigation(matrix: PolicyMatrix): ReadonlyMap<string, readonly Permission[]> {
  const nav = new Map<string, Set<Permission>>();
  for (const row of matrix.rows) {
    const existing = nav.get(row.roleKey);
    if (existing === undefined) nav.set(row.roleKey, new Set([row.permission]));
    else existing.add(row.permission);
  }
  return new Map([...nav.entries()].map(([key, values]) => [key, [...values].sort()]));
}

/**
 * The RLS projection: one predicate shape per matrix row.
 *
 * Returned as data, not executed. `packages/core` has no database (ADR-0010);
 * the consumer renders these into policies and the conformance test compares the
 * result against `evaluate` for every triple. The rank is emitted as a literal
 * so the SQL can compare against `member_role.max_scope_rank` without knowing
 * the ordering of scope types.
 */
export function matrixToRlsPolicies(matrix: PolicyMatrix): string[] {
  return matrix.rows.map(
    (row) =>
      `(role_key = '${row.roleKey}' and permission = '${row.permission}' and max_scope_rank >= ${row.scopeRank})`,
  );
}