/**
 * Public surface of `@raptor/auth`.
 *
 * WHAT IS DELIBERATELY NOT EXPORTED
 * ----------------------------------
 * The legacy library shipped `createAdminProfile` and `createBatchProfiles` in a
 * client-reachable module (AUDIT F-AUTH-03). Neither existed at any call site —
 * they were dormant, which is exactly what makes them dangerous: a documented
 * invitation to reintroduce privilege escalation, waiting for one permissive
 * policy to become exploitable.
 *
 * So this barrel exports the policy, the configuration, and the validation. It
 * exports NO function that mints, promotes, or grants a role, and none that
 * writes to the `user` table. Escalation is a server-side, audited operation
 * (see `assertRoleAssignable` for the rule and `packages/db` for the
 * `role_assignment` ledger); there is deliberately no client-reachable shortcut
 * to it here.
 *
 * Nothing here logs, returns, or embeds a password, token, or cookie value.
 */

export {
  ALL_ROLES,
  ASSIGNABLE_BY_NON_PRIVILEGED,
  PRIVILEGED_ROLES,
  asRole,
  assertRoleAssignable,
  evaluateMfaRequirement,
  isPrivilegedRole,
  requiresMfa,
  type MfaDenialReason,
  type MfaRequirement,
  type PrivilegedRole,
  type Role,
} from "./roles.js";

export {
  AuthEnvironmentError,
  DEFAULT_APP_DATABASE_URL,
  ENV_EXAMPLE_PLACEHOLDER_SECRETS,
  MIN_AUTH_SECRET_DISTINCT_CHARACTERS,
  MIN_AUTH_SECRET_LENGTH,
  MIGRATION_URL_VARIABLE,
  PLACEHOLDER_AUTH_SECRETS,
  TRUSTED_IP_HEADERS_VARIABLE,
  TRUSTED_PROXIES_VARIABLE,
  countDistinctCharacters,
  isPlaceholderAuthSecret,
  mfaRequiredError,
  migrationDatabaseUrl,
  readAuthEnv,
  secretRejectionReason,
  testAuthSecretAcceptable,
  type AuthEnv,
  type SecretRejectionReason,
} from "./env.js";

export {
  ACCOUNT_SIGNIN_LOCKOUT_CODE,
  ACCOUNT_SIGNIN_LOCKOUT_SECONDS,
  ACCOUNT_SIGNIN_MAX_FAILURES,
  MFA_CHALLENGE_COOKIE_MAX_AGE_SECONDS,
  MFA_LOCKOUT_DURATION_SECONDS,
  MFA_MAX_FAILED_ATTEMPTS,
  RATE_LIMITS,
  ROLE_CHECK_VALUES,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_TOKEN_LENGTH,
  SESSION_UPDATE_AGE_SECONDS,
  buildAuthOptions,
  createAuth,
  createAuthConfig,
  tlsOptionsForDatabaseUrl,
  type ResolvedAuthConfig,
} from "./config.js";