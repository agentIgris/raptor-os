/**
 * Typed, validated environment for the auth package.
 *
 * The legacy system compiled `console.*` out of production and read env vars
 * inline wherever they were needed, so a missing `BETTER_AUTH_SECRET` surfaced
 * as a runtime failure deep inside a sign-in attempt rather than at boot. This
 * module reads the environment exactly once, validates it, and fails loudly at
 * startup with a message that names the variable and nothing about its value.
 *
 * SECRET HYGIENE
 * --------------
 * Nothing in this file may ever interpolate a secret into an error message, a
 * log line, or a returned object. `describe()` therefore reports only the
 * variable NAME and whether it was present.
 */

import { APIError } from "better-auth";

/**
 * Connection string the application uses for every query.
 *
 * Points at `raptor_app`, which is NOSUPERUSER NOBYPASSRLS (ADR-0006). This is
 * not a preference: a superuser connection silently bypasses every RLS policy,
 * which is precisely the "isolation looks fine but does not exist" failure mode
 * ADR-0006 was written to prevent.
 */
export const DEFAULT_APP_DATABASE_URL = "postgresql://raptor_app@127.0.0.1:5432/raptor_os";

/**
 * Connection string used ONLY by migrations (DDL, RLS policy creation).
 *
 * !! NEVER let this reach an application environment. !!
 *
 * `raptor_migrator` is a SUPERUSER and can ALTER TABLE, DROP POLICY, and
 * GRANT. If this credential is present in the web app's environment, then any
 * RCE or SSRF in the application is an immediate, complete defeat of the
 * tenancy boundary: the attacker disables the policies rather than fighting
 * them. It belongs exclusively in the migration runner's environment, and its
 * absence from the app is the control.
 *
 * The password is intentionally NOT defaulted here. `migrationDatabaseUrl()`
 * fails closed when it is unset, so "no migration credential in this process"
 * is an assertion the code makes rather than a convention the operator must
 * remember.
 */
export const MIGRATION_URL_VARIABLE = "DATABASE_MIGRATION_URL";

/** A single required or optional environment entry. */
export interface EnvVarSpec {
  /** Name of the environment variable. Never its value. */
  readonly name: string;
  /**
   * Resolve the value from an env record. Returning `undefined` means "absent";
   * returning `null` means "present but empty", which is treated as an error for
   * required variables because an empty secret is worse than a missing one — it
   * looks configured.
   */
  readonly read: (env: Readonly<Record<string, string | undefined>>) => string | null | undefined;
  /** Whether startup must fail when the variable is absent. */
  readonly required: boolean;
  /** Human-readable explanation used in the failure message. */
  readonly purpose: string;
}

/** A resolved, validated configuration value. */
export interface EnvEntry {
  readonly name: string;
  readonly value: string;
}

/** Fully validated auth environment. */
export interface AuthEnv {
  /** Better Auth signing secret. Never log this. */
  readonly secret: string;
  /** Origin the app is served from; also the sole trusted origin. */
  readonly baseUrl: string;
  /** `raptor_app` connection string. Never the migrator. */
  readonly databaseUrl: string;
  /** `"production"` when `NODE_ENV` is production, else `"development"`. */
  readonly nodeEnv: "development" | "production" | "test";
}

/** Signals a misconfigured environment, at startup, naming variables only. */
export class AuthEnvironmentError extends Error {
  public constructor(missing: readonly string[]) {
    super(
      `Authentication environment is not configured. Missing or empty: ${missing.join(", ")}. ` +
        `Set them in the process environment. Note that ${MIGRATION_URL_VARIABLE} is a migration-only ` +
        `credential and must never be present in an application environment.`,
    );
    this.name = "AuthEnvironmentError";
  }
}

/**
 * Validate an environment record into a typed {@link AuthEnv}.
 *
 * @throws {AuthEnvironmentError} listing every missing variable by name.
 *
 * Note what this deliberately does NOT do: it never includes the value of a
 * present-but-invalid variable in the failure message, because a malformed
 * `DATABASE_URL` would otherwise land in a log aggregator with its password
 * intact.
 */
export function readAuthEnv(env: Readonly<Record<string, string | undefined>>): AuthEnv {
  const specs: readonly EnvVarSpec[] = [
    {
      name: "BETTER_AUTH_SECRET",
      read: (e) => e["BETTER_AUTH_SECRET"],
      required: true,
      purpose: "session and cookie signing",
    },
    {
      name: "BETTER_AUTH_URL",
      read: (e) => e["BETTER_AUTH_URL"],
      required: true,
      purpose: "the trusted origin for this deployment",
    },
    {
      name: "DATABASE_URL",
      read: (e) => e["DATABASE_URL"] ?? DEFAULT_APP_DATABASE_URL,
      required: false,
      purpose: "the raptor_app connection string",
    },
  ];

  const resolved = new Map<string, EnvEntry>();
  const missing: string[] = [];

  for (const spec of specs) {
    const raw = spec.read(env);
    if (raw === undefined || raw === null || raw.trim() === "") {
      if (spec.required) missing.push(spec.name);
      continue;
    }
    resolved.set(spec.name, { name: spec.name, value: raw.trim() });
  }

  if (missing.length > 0) throw new AuthEnvironmentError(missing);

  // Read the non-optional entries through a helper that narrows for the
  // compiler. `missing` being empty above is the proof they are present.
  const requiredEntry = (name: string): string => {
    const entry = resolved.get(name);
    if (entry === undefined) throw new AuthEnvironmentError([name]);
    return entry.value;
  };

  const databaseUrl = resolved.get("DATABASE_URL")?.value ?? DEFAULT_APP_DATABASE_URL;
  assertNotMigrationCredential(databaseUrl);

  const rawNodeEnv = env["NODE_ENV"] ?? "development";
  const nodeEnv: AuthEnv["nodeEnv"] =
    rawNodeEnv === "production" ? "production" : rawNodeEnv === "test" ? "test" : "development";

  return {
    secret: requiredEntry("BETTER_AUTH_SECRET"),
    baseUrl: requiredEntry("BETTER_AUTH_URL"),
    databaseUrl,
    nodeEnv,
  };
}

/**
 * Reject any application connection string that is not the application role.
 *
 * This is a runtime backstop for the ADR-0006 invariant. The real control is
 * that `DATABASE_MIGRATION_URL` is never injected into the app; this catches the
 * case where someone copies the migrator URL into `DATABASE_URL` "just to test
 * the migration", which is a common and catastrophic shortcut.
 */
function assertNotMigrationCredential(connectionString: string): void {
  // Parse rather than substring-match: a password may legitimately contain the
  // string "raptor_migrator", and a false positive here would block a working
  // deployment. Only the username — the part before the password — is examined.
  let username: string;
  try {
    username = decodeURIComponent(new URL(connectionString).username);
  } catch {
    throw new AuthEnvironmentError(["DATABASE_URL (not a parsable connection string)"]);
  }

  if (username === "raptor_migrator" || username === "postgres") {
    throw new AuthEnvironmentError([
      "DATABASE_URL points at a superuser or migration role",
    ]);
  }
}

/**
 * The migration connection string, available ONLY to a migration process.
 *
 * @throws {AuthEnvironmentError} when unset, so that an application process
 *   cannot accidentally acquire migration credentials.
 *
 * @param env - Process environment. Callers must pass the migration runner's
 *   environment, never the web app's.
 */
export function migrationDatabaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[MIGRATION_URL_VARIABLE];
  if (value === undefined || value === null || value.trim() === "") {
    throw new AuthEnvironmentError([MIGRATION_URL_VARIABLE]);
  }
  return value.trim();
}

/**
 * Build the `APIError` returned when a privileged account tries to obtain a
 * session without TOTP.
 *
 * `status` is `403 FORBIDDEN` and the code is stable, so the web app can branch
 * on the CODE and never on the message. The message is intentionally explicit
 * about the remedy — a user locked out of their own admin account with no
 * explanation is a support incident, and vague errors are how accounts end up
 * disabled permanently.
 *
 * Never includes the account id, email, or any token.
 */
export function mfaRequiredError(): APIError {
  return new APIError("FORBIDDEN", {
    message:
      "Multi-factor authentication is required for this role. Enrol a TOTP authenticator " +
      "before signing in. Contact an organisation owner if you have lost your authenticator.",
    code: "MFA_REQUIRED",
  });
}