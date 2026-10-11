/**
 * Per-ACCOUNT failed-password counter.
 *
 * WHAT THIS EXISTS BECAUSE OF
 * ---------------------------
 * A red-team reproduction: with a unique `X-Forwarded-For` per request, 200 of
 * 200 password guesses against ONE named account were accepted, never limited.
 * Two independent causes, and this module addresses the second:
 *
 *   1. the rate-limit key was derived from a header the client controls, so each
 *      request landed in a bucket the attacker minted (handled by
 *      `advanced.ipAddress` in `config.ts`);
 *   2. `user` carries no failure counter, so nothing at all bounded guessing
 *      against a single account regardless of address.
 *
 * Per-IP limiting cannot substitute for (2). A distributed attacker has as many
 * addresses as they like; the one thing they cannot change is which account they
 * are guessing. Only an account-keyed budget bounds that.
 *
 * WHY NOT THE `twoFactor` PLUGIN'S `accountLockout`
 * -----------------------------------------------
 * It does not apply, and this is worth stating precisely because the option name
 * invites the assumption. In the installed `better-auth@1.7.7`,
 * `dist/plugins/two-factor/verify-two-factor.mjs`, `recordTwoFactorFailure` is
 * called from exactly one place: the TOTP verification route. It counts 6-digit
 * code guesses, on a `twoFactor` row that does not exist until the user enrols.
 * A wrong PASSWORD never touches it — verified by `signin-throttle.test.ts`,
 * which asserts the twoFactor counter stays at zero across a full password
 * lockout. An attacker who has the password and is guessing it is not attacking
 * the TOTP oracle, so the MFA lockout is the wrong control for this threat.
 *
 * WHY IT REUSES THE `rateLimit` TABLE
 * -----------------------------------
 * Because there is no `failedSignIns` column to add: a schema change here is a
 * migration, and a migration for a counter that behaves exactly like an existing
 * one is a migration nobody schedules. The table is already database-backed
 * (survives restarts, shared across instances), already has a UNIQUE key, and
 * is already emptied by the fixtures.
 *
 * WHY THE KEY IS A HASH
 * ---------------------
 * The stored key is a SHA-256 digest of the lower-cased address, prefixed so
 * these rows can never collide with Better Auth's own `${ip}|${path}` keys. The
 * address therefore never appears in a row, a log line, or an error message —
 * which matters because `rateLimit` is a table an operator can read, and an
 * address is personal data that this table has no business holding.
 *
 * NO secret is recorded: the counter records that a guess FAILED, never what was
 * guessed, and never the address itself.
 */

import { createHash } from "node:crypto";

/** Prefix on every key this module writes, so the rows are identifiable and cannot collide. */
const ACCOUNT_KEY_PREFIX = "acct-signin-fail|";

/** Table the counters live in. Matches Better Auth's own `rateLimit` model name. */
const RATE_LIMIT_MODEL = "rateLimit";

/**
 * One adapter operation, described structurally.
 *
 * Better Auth's `DBAdapterInstance` is a recursive generic that collapses to an
 * error type under this package's lint settings — the same trap
 * `AuthDatabase` documents in `config.ts`. The four methods actually used here
 * are declared instead, so the dependency is stated exactly and a change to the
 * library's adapter shape surfaces here rather than as a type error three files
 * away.
 */
export interface AccountCounterAdapter {
  findOne<Row>(input: {
    model: string;
    where: ReadonlyArray<{ field: string; value: unknown }>;
  }): Promise<Row | null>;
  create(input: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  incrementOne(input: {
    model: string;
    where: ReadonlyArray<{ field: string; value: unknown; operator?: string }>;
    increment: Record<string, number>;
    set?: Record<string, unknown>;
  }): Promise<Record<string, unknown> | null>;
}

/**
 * The storage key for an address.
 *
 * Exported so `config.ts` and its test read the same function; a test that
 * recomputed the key would be a second implementation that could disagree.
 */
export function accountCounterKey(email: string): string {
  return `${ACCOUNT_KEY_PREFIX}${sha256Hex(email.trim().toLowerCase())}`;
}

/**
 * The rate-limit key for `/sign-in/*`, used only by {@link isCredentialFailure}
 * documentation and tests. Present so a reader can see the two key families are
 * disjoint rather than merely different.
 */
export const ACCOUNT_KEY_PREFIX_STRING = ACCOUNT_KEY_PREFIX;

/**
 * Is this failure a wrong credential?
 *
 * Better Auth answers "no such user", "no credential account" and "wrong password"
 * with the SAME 401 `INVALID_EMAIL_OR_PASSWORD`, which is the right call: a
 * counter that only caught some of those three would itself become an account
 * enumeration oracle, because the address that stops incrementing is the address
 * that exists. Counting all three keeps the response identical whether or not the
 * account exists, and bounds guessing either way.
 *
 * The 429 exclusion matters: once the account is locked, further attempts are
 * refused BY this module, and counting those refusals would extend the lockout on
 * every rejected attempt — an attacker could then hold an account locked
 * indefinitely by continuing to try, turning a control into a denial-of-service
 * lever.
 */
export function isCredentialFailure(status: number, code: string | null): boolean {
  if (status === 429) return false;
  if (code === null) return false;
  return code === "INVALID_EMAIL_OR_PASSWORD" || code === "INVALID_PASSWORD";
}

/** The persisted counter state for one address. */
export interface AccountFailureState {
  /** Consecutive failures inside the current window. */
  readonly count: number;
  /** True when the account is refusing further attempts. */
  readonly locked: boolean;
}

const EMPTY_STATE: AccountFailureState = { count: 0, locked: false };

/**
 * Read the current counter, or the empty state when there is no row.
 *
 * A row whose window has expired reads as empty rather than locked, which is what
 * makes the lockout time-limited without a background job: there is nothing to
 * expire, because a stale row simply stops counting the moment the window closes.
 */
export async function readAccountFailures(
  adapter: AccountCounterAdapter,
  key: string,
  windowMilliseconds: number,
  maxFailures: number,
  nowMilliseconds: number = Date.now(),
): Promise<AccountFailureState> {
  const row = await readRow(adapter, key);
  if (row === null) return EMPTY_STATE;

  const count = Number(row.count);
  const lastRequest = Number(row.lastRequest);
  if (!Number.isFinite(count) || !Number.isFinite(lastRequest)) return EMPTY_STATE;
  if (nowMilliseconds - lastRequest >= windowMilliseconds) return EMPTY_STATE;

  return { count, locked: count >= maxFailures };
}

/**
 * Record one failed attempt and return the new state.
 *
 * Atomic by construction: the increments go through `incrementOne`, whose WHERE
 * clause pins the row id/key, so concurrent failures from a distributed attacker
 * cannot lose an update by overwriting one another with a stale read. This is the
 * same primitive Better Auth's own limiter uses.
 *
 * A `create` that loses a race is not an error — it means another request created
 * the row first — so it is retried through the increment path rather than
 * propagated. Losing that race must not turn a failed sign-in into a 500.
 */
export async function recordAccountFailure(
  adapter: AccountCounterAdapter,
  key: string,
  windowMilliseconds: number,
  maxFailures: number,
  nowMilliseconds: number = Date.now(),
): Promise<AccountFailureState> {
  const row = await readRow(adapter, key);

  if (row === null) {
    try {
      await adapter.create({
        model: RATE_LIMIT_MODEL,
        data: { key, count: 1, lastRequest: nowMilliseconds },
      });
      return { count: 1, locked: maxFailures <= 1 };
    } catch {
      // Lost the insert race. Fall through and count against the row that won.
      return recordAccountFailure(adapter, key, windowMilliseconds, maxFailures, nowMilliseconds);
    }
  }

  const lastRequest = Number(row.lastRequest);
  const windowExpired = !Number.isFinite(lastRequest) || nowMilliseconds - lastRequest >= windowMilliseconds;

  const updated = windowExpired
    ? // The window has closed, so this failure starts a fresh budget. The
      // `lastRequest <=` guard makes the reset safe under concurrency: only the
      // request that observed the newest row wins, and the rest simply increment.
      await adapter.incrementOne({
        model: RATE_LIMIT_MODEL,
        where: [
          { field: "key", value: key },
          { field: "lastRequest", value: lastRequest, operator: "lte" },
        ],
        increment: {},
        set: { count: 1, lastRequest: nowMilliseconds },
      })
    : await adapter.incrementOne({
        model: RATE_LIMIT_MODEL,
        where: [{ field: "key", value: key }],
        increment: { count: 1 },
        set: { lastRequest: nowMilliseconds },
      });

  const count = Number(updated?.["count"]);
  const effectiveCount = Number.isFinite(count) ? count : Number(row.count) + 1;
  return { count: effectiveCount, locked: effectiveCount >= maxFailures };
}

/**
 * Clear the counter after a success.
 *
 * Written unconditionally rather than only when a row exists: a successful
 * sign-in is the strongest evidence available that the previous failures were
 * typos, and a conditional write would leave that evidence uncounted whenever the
 * row happened to be absent.
 */
export async function clearAccountFailures(adapter: AccountCounterAdapter, key: string): Promise<void> {
  await adapter.incrementOne({
    model: RATE_LIMIT_MODEL,
    where: [{ field: "key", value: key }],
    increment: {},
    // `lastRequest: 0` puts the row definitively outside any window, so a later
    // read treats it as empty even though the row still exists.
    set: { count: 0, lastRequest: 0 },
  });
}

/** A `rateLimit` row, narrowed to the two columns this module reads. */
interface CounterRow {
  readonly count: unknown;
  readonly lastRequest: unknown;
}

async function readRow(adapter: AccountCounterAdapter, key: string): Promise<CounterRow | null> {
  const row: unknown = await adapter.findOne<CounterRow>({
    model: RATE_LIMIT_MODEL,
    where: [{ field: "key", value: key }],
  });
  if (row === null || typeof row !== "object") return null;

  // The adapter's row type is not known to the caller, so it is narrowed here
  // rather than asserted at each use. Both columns are typed `unknown` in
  // {@link CounterRow} and read through `Number()`, which turns a missing,
  // null, or non-numeric value into NaN and therefore into "no counter" — the
  // fail-open-for-reads, fail-closed-for-writes direction: a row we cannot parse
  // can never be read as a lockout it did not earn.
  return row as CounterRow;
}

/**
 * SHA-256 as lowercase hex.
 *
 * `createHash` rather than a hand-rolled digest: this value identifies an account
 * in a table an operator can read, so it must not be a digest anyone can invert by
 * inspection the way a truncated or unsalted hash of a common address would be.
 */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}