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
 *
 * BETTER_AUTH_SECRET IS A STRENGTH GATE, NOT A PRESENCE CHECK
 * ---------------------------------------------------------
 * `BETTER_AUTH_SECRET` is the root of trust for this package. It signs session
 * cookies, email-verification tokens and password-reset tokens, so a value an
 * attacker can guess is not a weakened control — it is the absence of one.
 * Reproduced: with `BETTER_AUTH_SECRET=secret`, forging the email-verification
 * JWT (`HS256` over `{email, iat, exp}`) yielded a session for an UNVERIFIED
 * account, with no password and no interaction from the legitimate user.
 *
 * A presence check also cannot catch the failure mode that actually happens:
 * an operator who copies `.env.example`, keeps the shipped value, and deploys.
 * That is why there is an explicit placeholder denylist below, and why
 * `.env.example` no longer ships a literal secret.
 *
 * THE RULE IS IDENTICAL IN EVERY ENVIRONMENT
 * ------------------------------------------
 * There is no relaxed development rule, and that is a decision rather than an
 * oversight. A development secret is the secret that gets promoted: the normal
 * sequence — copy `.env.local` to staging, copy staging's to production —
 * carries whatever weakness development tolerated, while the NODE_ENV that
 * permitted it does not travel with it. A policy that is strict in production
 * and lenient in development therefore has a real chance of never being applied
 * to a live system at all. One rule, one answer to "is this deployment safe?".
 *
 * The cost is one command for a developer to run (`openssl rand -base64 32`);
 * see `MIN_AUTH_SECRET_LENGTH`.
 */

import { APIError } from "better-auth";

import { DEFAULT_EMAIL_FROM } from "./email.js";

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

/**
 * Minimum accepted length of `BETTER_AUTH_SECRET`, in characters.
 *
 * 32 is the smallest length that leaves a secret outside the reach of an
 * exhaustive online search once the value is also required to be non-degenerate
 * (see {@link MIN_AUTH_SECRET_DISTINCT_CHARACTERS}). It is also exactly what
 * `openssl rand -base64 32` produces, which is the command `.env.example`
 * names — so the bar is "do what the documentation says", not an obstacle.
 *
 * Not 16, despite 16 being the historical recommendation: this secret does not
 * protect one account, it forges a session for any account, including accounts
 * whose address was never verified.
 */
export const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Minimum number of DISTINCT characters a signing secret must contain.
 *
 * Length alone does not measure strength. `"a".repeat(48)` and
 * `"ab12ab12ab12..."` both clear a 32-character rule and both are recovered by
 * an attacker in a single guess. Counting distinct characters is the cheapest
 * test that separates a machine-generated secret from a degenerate one without
 * pretending to be a full entropy estimator.
 *
 * The threshold is deliberately low (12) so it cannot produce false negatives
 * on legitimate output: `openssl rand -hex 32` yields 64 hex characters
 * containing 16 distinct symbols, and a passphrase yields more. A generator that
 * produced 12 distinct symbols in 32 characters would not be producing a secret.
 */
export const MIN_AUTH_SECRET_DISTINCT_CHARACTERS = 12;

/**
 * Values that are rejected however well they score on length and diversity.
 *
 * This is the list that catches the failure mode that actually occurs: an
 * operator who copied `.env.example` and never returned. A length rule waves
 * `changemechangemechangemechangemechangem` straight through, because it IS long.
 *
 * Compared case-insensitively after trimming, and also after removing spaces and
 * dashes, so `Change Me`, `change-me` and `changeme` are one value rather than
 * three spellings an attacker (or an operator) can pick between.
 */
export const PLACEHOLDER_AUTH_SECRETS: readonly string[] = [
  "changeme",
  "change-me",
  "change_me",
  "change-me-please",
  "please-change-me",
  "replace-me",
  "replace-me-with-a-real-secret",
  "secret",
  "password",
  "supersecret",
  "super-secret",
  "not-a-secret",
  "insecure",
  "insecure-secret",
  "your-secret-here",
  "your-secret",
  "example-secret",
  "dummy-secret",
  "signing-secret",
  "todo",
  "fixme",
  "xxx",
];

/**
 * Values the repository's own `.env.example` shipped or shipped previously.
 *
 * Kept separate from {@link PLACEHOLDER_AUTH_SECRETS} because they are a
 * different kind of entry: not things a human types, but things this repository
 * PUBLISHED as example values. Shipping one teaches every operator who copies
 * the file that the secret is disposable, which is a documentation defect that
 * no validator can undo on its own — the file itself has to stop shipping one.
 *
 * `ENV_EXAMPLE_PLACEHOLDER_SECRETS` is the list the validator consults, so a
 * value that is ever re-introduced into the example file stays rejected even if
 * nobody remembers why it is on this list.
 */
export const ENV_EXAMPLE_PLACEHOLDER_SECRETS: readonly string[] = [
  // `BETTER_AUTH_SECRET` in `.env.example`.
  "dev-only-not-a-real-secret-change-me",
  // `STORAGE_SIGNING_SECRET` in the same file. Listed because a copy-paste of
  // the file moves both values across together.
  "dev-only-signing-secret-change-me",
];

/**
 * Normalise a candidate for comparison against the placeholder lists.
 *
 * Lower-cases and drops every character that is not a letter or a digit, so
 * `Change Me`, `CHANGE-ME`, `change_me` and `changeme` collapse to one key.
 * Without this, the denylist would be a list of exact strings an operator can
 * trivially walk around by typing a space.
 */
function normalizeSecretForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Is this value one of the known placeholders?
 *
 * Exported so the predicate the validator uses is the same one a test asserts
 * against, rather than a copy that can drift from it.
 */
export function isPlaceholderAuthSecret(value: string): boolean {
  const normalized = normalizeSecretForComparison(value);
  if (normalized === "") return true;

  const candidates = [value.trim().toLowerCase(), normalized];
  return [...PLACEHOLDER_AUTH_SECRETS, ...ENV_EXAMPLE_PLACEHOLDER_SECRETS].some(
    (placeholder) =>
      candidates.includes(placeholder.toLowerCase()) ||
      candidates.includes(normalizeSecretForComparison(placeholder)),
  );
}

/**
 * Count the distinct characters in a value.
 *
 * Exported for the same reason as {@link isPlaceholderAuthSecret}: the rule and
 * the test must read the same function.
 */
export function countDistinctCharacters(value: string): number {
  return new Set(value).size;
}

/**
 * Why a signing secret was refused, or `null` when it is acceptable.
 *
 * A discriminated union rather than a boolean so the failure message can tell an
 * operator WHICH rule they tripped without ever showing them the value.
 */
export type SecretRejectionReason =
  | { readonly rule: "placeholder" }
  | { readonly rule: "length"; readonly required: number; readonly actual: number }
  | { readonly rule: "character-diversity"; readonly required: number; readonly actual: number };

/**
 * Evaluate a candidate signing secret against every rule.
 *
 * Total and side-effect free. Returns `null` when the value is acceptable, so
 * `readAuthEnv` has exactly one place where "is this secret usable?" is decided.
 *
 * Length and distinct-character count are properties of the VALUE, which is why
 * they are safe to put in a failure message. The placeholder reason carries no
 * detail at all: naming the matched string would confirm that a particular
 * guess was the right one.
 */
export function secretRejectionReason(value: string): SecretRejectionReason | null {
  const trimmed = value.trim();

  if (isPlaceholderAuthSecret(trimmed)) return { rule: "placeholder" };

  const actualLength = trimmed.length;
  if (actualLength < MIN_AUTH_SECRET_LENGTH) {
    return { rule: "length", required: MIN_AUTH_SECRET_LENGTH, actual: actualLength };
  }

  const actualDistinct = countDistinctCharacters(trimmed);
  if (actualDistinct < MIN_AUTH_SECRET_DISTINCT_CHARACTERS) {
    return {
      rule: "character-diversity",
      required: MIN_AUTH_SECRET_DISTINCT_CHARACTERS,
      actual: actualDistinct,
    };
  }

  return null;
}

/**
 * Is this candidate secret acceptable under the production policy?
 *
 * Exported so a test fixture can assert that the secret the whole suite signs
 * with would survive a real deployment. If the policy is ever tightened, that
 * assertion fails and the FIXTURE is updated — the policy is not.
 */
export function testAuthSecretAcceptable(value: string): boolean {
  return secretRejectionReason(value) === null;
}

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
  /**
   * Google OAuth client ID for "Sign in with Google".
   *
   * `undefined` when unset, in which case Google sign-in is not offered: the
   * provider block is omitted from the Better Auth options entirely rather than
   * configured with an empty credential, because an OAuth flow that starts and
   * cannot complete strands the user on Google's error page with no way back.
   * Obtained from the Google Cloud Console (APIs & Services → Credentials →
   * OAuth client ID, application type "Web application").
   */
  readonly googleClientId: string | undefined;
  /**
   * Google OAuth client secret. Never log this. Same optionality contract as
   * {@link AuthEnv.googleClientId}: both set or Google sign-in stays off. A
   * client ID without its secret (or vice versa) is a refused configuration,
   * not a half-enabled provider.
   */
  readonly googleClientSecret: string | undefined;
  /** `"production"` when `NODE_ENV` is production, else `"development"`. */
  readonly nodeEnv: "development" | "production" | "test";
  /**
   * Request headers allowed to carry the client IP for rate-limit keying.
   *
   * EMPTY BY DEFAULT, which means no forwarding header is read at all. See
   * {@link TRUSTED_IP_HEADERS_VARIABLE} for why the library default is unsafe
   * behind Next.js, and what an operator who sets this is actually asserting.
   */
  readonly trustedIpHeaders: readonly string[];
  /**
   * Resend API key for authentication mail (verification + password reset).
   *
   * `undefined` when unset, in which case mail sends fail loudly at call
   * time rather than silently swallowing sign-ups. Optional (not required)
   * so existing deployments without mail keep booting.
   */
  readonly resendApiKey: string | undefined;
  /**
   * Sender address for authentication mail. Defaults to Resend's onboarding
   * sender, which only delivers to the Resend account's own address — the
   * staging-appropriate default. Never a placeholder check: any non-empty
   * value is accepted, because deliverability is the provider's verdict.
   */
  readonly emailFrom: string;
  /**
   * CIDR ranges of the reverse proxies that populate {@link trustedIpHeaders}.
   *
   * Empty alongside {@link trustedIpHeaders}: Better Auth's rule is that a
   * single-value forwarding header is trusted VERBATIM when this is unset, which
   * is exactly the client-supplied case the header setting exists to exclude.
   */
  readonly trustedProxies: readonly string[];
}

/** Names the request header(s) carrying a trustworthy client IP. See {@link AuthEnv.trustedIpHeaders}. */
export const TRUSTED_IP_HEADERS_VARIABLE = "AUTH_TRUSTED_IP_HEADERS";

/** Names the CIDR ranges of the proxies that set that header. See {@link AuthEnv.trustedProxies}. */
export const TRUSTED_PROXIES_VARIABLE = "AUTH_TRUSTED_PROXIES";

/**
 * Split a comma-separated environment value into trimmed, non-empty entries.
 *
 * Returns `[]` for an absent, empty, or whitespace-only value, which is the
 * "trust nothing" setting and the default everywhere in this package.
 */
function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Signals a misconfigured environment, at startup, naming variables only.
 *
 * The message deliberately describes PROBLEMS rather than MISSING VALUES, because
 * the three failure modes below have different remedies and an operator who is
 * told "missing" for a variable that is present and merely unusable will go
 * looking in the wrong place:
 *
 *   - `BETTER_AUTH_SECRET` unset or blank  -> set it;
 *   - `BETTER_AUTH_SECRET` too weak         -> GENERATE a new one, do not pad
 *     the existing one (see {@link secretRejectionReason}).
 *
 * No value ever appears in the message, in any case. `secretRejectionReason` is
 * summarised by rule name and by the counts, which are properties of the value
 * rather than the value itself.
 */
export class AuthEnvironmentError extends Error {
  public constructor(problems: readonly string[]) {
    super(
      `Authentication environment is not configured. Missing, empty or unsafe: ${problems.join(", ")}. ` +
        `BETTER_AUTH_SECRET must be a generated value of at least ${MIN_AUTH_SECRET_LENGTH} characters ` +
        `containing at least ${MIN_AUTH_SECRET_DISTINCT_CHARACTERS} distinct characters and no placeholder; ` +
        `generate one with "openssl rand -base64 32". ` +
        `Note that ${MIGRATION_URL_VARIABLE} is a migration-only ` +
        `credential and must never be present in an application environment.`,
    );
    this.name = "AuthEnvironmentError";
  }
}

/**
 * Describe a rejected signing secret WITHOUT revealing anything about its value.
 *
 * @returns A message fragment naming the rule that failed. The placeholder rule
 *   reports only that a placeholder was recognised; naming the matching string
 *   would confirm to whoever is reading the log that a particular guess was
 *   correct, which is a free oracle for an offline attacker.
 */
function describeSecretRejection(reason: SecretRejectionReason): string {
  switch (reason.rule) {
    case "placeholder":
      return "BETTER_AUTH_SECRET is a known placeholder value";
    case "length":
      return `BETTER_AUTH_SECRET is too short (${reason.actual} characters, ${reason.required} required)`;
    case "character-diversity":
      return (
        `BETTER_AUTH_SECRET is degenerate (${reason.actual} distinct characters, ` +
        `${reason.required} required)`
      );
  }
}

/**
 * Validate an environment record into a typed {@link AuthEnv}.
 *
 * @throws {AuthEnvironmentError} listing every problem by name. A weak signing
 *   secret is a problem here, not an accepted value — this function is the one
 *   documented gate, so a rule that lives anywhere else is a rule that can be
 *   bypassed.
 *
 * Note what this deliberately does NOT do: it never includes the value of a
 * present-but-invalid variable in the failure message, because a malformed
 * `DATABASE_URL` would otherwise land in a log aggregator with its password
 * intact, and a rejected secret would land there telling an offline attacker
 * which guess was close.
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

  // Strength is checked AFTER presence, so an operator who set nothing gets one
  // clear "missing" message rather than two overlapping complaints about a value
  // that is not there.
  const secret = resolved.get("BETTER_AUTH_SECRET")?.value ?? "";
  const secretProblem = secretRejectionReason(secret);
  if (secretProblem !== null) throw new AuthEnvironmentError([describeSecretRejection(secretProblem)]);

  // Read the non-optional entries through a helper that narrows for the
  // compiler. `missing` being empty above is the proof they are present.
  const requiredEntry = (name: string): string => {
    const entry = resolved.get(name);
    if (entry === undefined) throw new AuthEnvironmentError([name]);
    return entry.value;
  };

  const databaseUrl = resolved.get("DATABASE_URL")?.value ?? DEFAULT_APP_DATABASE_URL;
  assertNotMigrationCredential(databaseUrl);

  // Optional entries are read WITHOUT trimming-to-required: an absent variable
  // and an empty one both mean "not configured", and neither is an error. The
  // caller decides whether absence disables a feature (Google sign-in) or is
  // itself refused (a half-configured provider).
  const optionalEntry = (name: string): string | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return undefined;
    return raw.trim();
  };

  // A client ID without its secret (or vice versa) is a refused configuration,
  // not a half-enabled provider. An OAuth flow with one half of its credential
  // starts at Google and dies there, stranding the user outside the app with an
  // error page that names nothing actionable.
  const googleClientId = optionalEntry("GOOGLE_CLIENT_ID");
  const googleClientSecret = optionalEntry("GOOGLE_CLIENT_SECRET");
  if ((googleClientId === undefined) !== (googleClientSecret === undefined)) {
    throw new AuthEnvironmentError([
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set, or neither",
    ]);
  }

  const rawNodeEnv = env["NODE_ENV"] ?? "development";
  const nodeEnv: AuthEnv["nodeEnv"] =
    rawNodeEnv === "production" ? "production" : rawNodeEnv === "test" ? "test" : "development";

  return {
    secret,
    baseUrl: requiredEntry("BETTER_AUTH_URL"),
    databaseUrl,
    googleClientId,
    googleClientSecret,
    nodeEnv,
    resendApiKey: optionalEntry("RESEND_API_KEY"),
    emailFrom: optionalEntry("EMAIL_FROM") ?? DEFAULT_EMAIL_FROM,
    trustedIpHeaders: splitList(env[TRUSTED_IP_HEADERS_VARIABLE]),
    trustedProxies: splitList(env[TRUSTED_PROXIES_VARIABLE]),
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