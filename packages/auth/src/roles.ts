/**
 * Canonical role vocabulary for Raptor OS.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS THE ONLY PLACE ROLES ARE WRITTEN
 * -------------------------------------------------------------------
 * The legacy system had *three* role enums that disagreed with each other:
 * `lib/role-system.ts` defined nine roles, `app/api/users/route.ts` allow-listed
 * six, and the database CHECK constraint allowed seven. Three role identifiers
 * (`pending`, `awaiting_approval`, `tryout`) existed only in TypeScript and could
 * not be written without tripping a 23514 constraint violation (AUDIT/08).
 *
 * This module is the ONE definition. The database CHECK constraint in
 * `schema.sql` and this TypeScript union are derived from the same list, so a
 * role picker built from `ALL_ROLES` cannot offer a value the database rejects.
 *
 * PRIVILEGED ROLES AND MFA
 * ------------------------
 * `PRIVILEGED_ROLES` is the security boundary this package exists to enforce.
 * The legacy app had **no MFA at all**, including for administrators
 * (AUDIT F-AUTH-01 / §1 "MFA / TOTP: NOT IMPLEMENTED"). A stolen admin password
 * therefore yielded immediate, permanent, unchallenged access.
 *
 * A role appearing in `PRIVILEGED_ROLES` is refused a session until TOTP is
 * enrolled. The rule is deliberately role-keyed rather than blanket "everyone
 * needs MFA": requiring a second factor for a player signing in for the first
 * time is a conversion cost, while the accounts that can move money, purge
 * data, and grant access are a small, known set that must be challenged.
 */

/**
 * Every role Raptor OS recognises, least- to most-privileged.
 *
 * Ordered by privilege so a UI can render a picker and a reviewer can read the
 * escalation path top to bottom. `pending` is the sign-up default: an account
 * with no completed onboarding holds no access.
 */
export const ALL_ROLES = [
  "pending",
  "player",
  "coach",
  "analyst",
  "manager",
  "admin",
  "owner",
] as const;

/** A role string that this system recognises. */
export type Role = (typeof ALL_ROLES)[number];

/**
 * Roles that MUST have TOTP enrolled before a session is issued.
 *
 * Read from left to right this is the blast-radius ordering: a `coach` can
 * affect one roster, a `manager` can delete a team, an `admin` can grant
 * themselves anything, and an `owner` controls the tenant itself.
 *
 * `player` is absent deliberately. Sign-up for a player must not be a two-factor
 * gauntlet, and a player account cannot itself escalate — see the note on
 * `assertRoleAssignable` below.
 */
export const PRIVILEGED_ROLES = ["manager", "admin", "owner"] as const;

/** A role in {@link PRIVILEGED_ROLES}. */
export type PrivilegedRole = (typeof PRIVILEGED_ROLES)[number];

/**
 * Narrow an arbitrary string to a {@link Role}.
 *
 * Used at every trust boundary where a role arrives as an untyped string (a
 * database row, a claim, an operator tool). Returns `null` rather than throwing
 * so a caller can treat an unknown role as *unprivileged*, which fails closed.
 */
export function asRole(value: string): Role | null {
  return (ALL_ROLES as readonly string[]).includes(value) ? (value as Role) : null;
}

/**
 * Is this role subject to mandatory MFA?
 *
 * An unrecognised role string answers `false`. That is deliberate: this function
 * gates the *additional* MFA requirement, and an unknown role must not be able
 * to crash or short-circuit the sign-in path. The authorisation layer is
 * responsible for rejecting unknown roles outright; this function's job is only
 * "is this role in the privileged set".
 */
export function isPrivilegedRole(value: string): value is PrivilegedRole {
  return (PRIVILEGED_ROLES as readonly string[]).includes(value);
}

/**
 * Does this account require TOTP before it may hold a session?
 *
 * @param role - The account's role. Unrecognised values are treated as
 *   unprivileged; authorisation rejects them separately.
 * @param twoFactorEnabled - Whether the account has completed TOTP enrolment.
 * @returns `true` when MFA must be satisfied before the session is honoured.
 *
 * This is the single expression the MFA gate consults, so that "which accounts
 * need MFA" cannot drift between the enforcement hook and its test.
 */
export function requiresMfa(role: string, twoFactorEnabled: boolean): boolean {
  return isPrivilegedRole(role) && !twoFactorEnabled;
}

/**
 * Why an account is being denied a session.
 *
 * Returned rather than thrown so the caller decides how to surface the reason
 * (HTTP status, audit record, user-facing message) without this module taking a
 * dependency on Better Auth's error types.
 */
export type MfaDenialReason = "privileged_role_requires_mfa";

/** Outcome of evaluating {@link evaluateMfaRequirement}. */
export type MfaRequirement =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: MfaDenialReason };

/**
 * Decide whether a session may be issued for this account.
 *
 * Pure and total: every input yields a decision, no I/O, no clock. That is what
 * makes the policy exhaustively testable without a database, and it is why the
 * enforcement hook is a thin wrapper around this function rather than a place
 * where the rule lives.
 */
export function evaluateMfaRequirement(role: string, twoFactorEnabled: boolean): MfaRequirement {
  return requiresMfa(role, twoFactorEnabled)
    ? { allowed: false, reason: "privileged_role_requires_mfa" }
    : { allowed: true };
}

/**
 * Roles a non-privileged actor is permitted to assign.
 *
 * THIS IS THE STRUCTURAL FIX FOR AUDIT F-AUTH-03.
 *
 * The legacy code shipped `SecureProfileCreation.createAdminProfile(userId,
 * email, name)`, commented *"Emergency admin creation — skipping auth
 * verification"* and *"caller is responsible for verification"*, performing
 * `upsert({ id: userId, role: 'admin', role_level: 100 })` on the **user-bound
 * client**. It was dormant, but if the permissive INSERT policy required to fix
 * sign-up were ever added, it became a one-call escalation for any
 * authenticated user.
 *
 * The lesson was not "delete that function" — it was that role assignment must
 * not be expressible as a client-supplied value. So role is declared on the
 * Better Auth user model with `input: false`, which makes Better Auth reject any
 * sign-up or update body carrying a `role` key with `FIELD_NOT_ALLOWED`, and the
 * only supported escalation path is the server-side `grantRole` helper in
 * `provisioning.ts`, which writes to the audit log.
 *
 * This constant is the allowlist that helper consults. It is exported so a
 * reviewer can verify the escalation surface without reading the helper.
 */
export const ASSIGNABLE_BY_NON_PRIVILEGED: readonly Role[] = ["pending", "player"];

/**
 * Can an actor holding `actorRole` assign `targetRole` to somebody?
 *
 * Total and pure. `false` for any unrecognised role on either side, so a corrupt
 * or absent role never widens the escalation surface.
 */
export function assertRoleAssignable(actorRole: string, targetRole: string): boolean {
  const actor = asRole(actorRole);
  const target = asRole(targetRole);
  if (actor === null || target === null) return false;

  // Anyone may move an account down to the default, including to itself. This is
  // self-demotion, not escalation, and it must not require admin.
  if (target === "pending") return true;

  if (!isPrivilegedRole(actor)) {
    return (ASSIGNABLE_BY_NON_PRIVILEGED as readonly string[]).includes(target);
  }

  // A privileged actor may only assign a role strictly below its own. This is
  // what stops a `manager` from minting an `admin` — the exact confusion the
  // legacy role tables produced.
  return ALL_ROLES.indexOf(target) < ALL_ROLES.indexOf(actor);
}