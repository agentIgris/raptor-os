/**
 * The permission catalogue vocabulary: nouns and verbs.
 *
 * The legacy system expressed permissions as 24 booleans on a role record
 * (`AUDIT/08_ROLES_PERMISSIONS.md`), which is not composable — it cannot say
 * "approve invoices", let alone "approve invoices up to 10,000". A permission
 * here is the pair (resource, action), encoded as a single stable string so the
 * same row can be stored in Postgres, embedded in an RLS policy, and compared
 * in a test without a mapping layer that can drift.
 *
 * These lists are a *seed catalogue*, not the whole domain: a tenant may hold
 * custom resources. They are nevertheless fixed in `packages/core` because the
 * four consumers (nav, API, RLS, audit) must agree on the spelling, and a
 * spelling agreed on in four places at runtime is not agreed on at all.
 */

/**
 * The nouns of an esports organisation OS.
 *
 * `role` is last because it is the noun the audit identified as unprotected:
 * nothing in the legacy app recorded who changed a permission, so granting a
 * role had to be modelled as a first-class resource with its own audit class.
 */
export const RESOURCES = [
  "person",
  "team",
  "roster",
  "contract",
  "agreement",
  "invoice",
  "expense",
  "deliverable",
  "travel_plan",
  "prize_pool",
  "payout",
  "tryout",
  "document",
  "setting",
  "role",
] as const;

export type Resource = (typeof RESOURCES)[number];

/**
 * The verbs.
 *
 * `approve`, `sign`, `pay` and `publish` are separated from `update` on purpose:
 * money leaving the organisation and an agreement becoming binding are the two
 * events a regulator and a player's lawyer will ask about, and neither is an
 * "update".
 */
export const ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "approve",
  "export",
  "send",
  "manage",
  "publish",
  "sign",
  "pay",
  "impersonate",
] as const;

export type Action = (typeof ACTIONS)[number];

/** An encoded permission, e.g. `"invoice:approve"`. */
export type Permission = `${Resource}:${Action}`;

const RESOURCE_SET: ReadonlySet<string> = new Set(RESOURCES);
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

/** Narrows an untrusted string to a {@link Resource}. Used at request boundaries. */
export function isResource(value: string): value is Resource {
  return RESOURCE_SET.has(value);
}

/** Narrows an untrusted string to an {@link Action}. Used at request boundaries. */
export function isAction(value: string): value is Action {
  return ACTION_SET.has(value);
}

/**
 * Whether a string is a well-formed permission for a known resource and action.
 *
 * Both halves are checked, not just the shape: `"wallet:sudo"` is structurally
 * fine but not a permission this system understands, and accepting it would let
 * an unknown grant sit in the catalogue unnoticed.
 */
export function isPermission(value: string): value is Permission {
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return false;
  return isResource(value.slice(0, separator)) && isAction(value.slice(separator + 1));
}

/**
 * Encode a permission.
 *
 * Throws for an off-catalogue pair instead of producing `"wallet:sudo"`. A
 * permission that does not exist cannot be granted, reviewed, or revoked, so
 * letting one be constructed is how a dead grant becomes permanent.
 */
export function permission(resource: Resource, action: Action): Permission {
  // Built as a plain string, not a template-literal type, so the runtime check
  // below is what actually guards a value that reached here off-catalogue.
  const encoded: string = `${resource}:${action}`;
  if (!isPermission(encoded)) {
    throw new Error(`Unknown permission: ${JSON.stringify(encoded)} (not in the catalogue)`);
  }
  return encoded;
}

/** Split a permission back into its parts. Throws for anything malformed. */
export function parsePermission(encoded: string): { resource: Resource; action: Action } {
  if (!isPermission(encoded)) {
    throw new Error(`Malformed permission: ${JSON.stringify(encoded)}`);
  }
  const separator = encoded.indexOf(":");
  return {
    resource: encoded.slice(0, separator) as Resource,
    action: encoded.slice(separator + 1) as Action,
  };
}