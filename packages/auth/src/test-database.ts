/**
 * The integration-test database: one in-process PGlite session, wired to the
 * two roles this package's security model depends on.
 *
 * WHY PGLITE, AND WHY IT IS NOT A WEAKER DATABASE
 * ------------------------------------------------
 * Native PostgreSQL is unusable on this machine: every backend process dies at
 * creation with `0xC0000142` (`STATUS_DLL_INIT_FAILED`), giving a 0% connection
 * success rate over 30 sequential attempts — see
 * `docs/adr/0015-pglite-restored-after-native-postgres-retest.md`. PGlite is
 * PostgreSQL 18.3 compiled to WebAssembly, running in this process, and
 * `packages/db/scripts/pglite-capability.ts` records that it enforces every
 * property this package's assertions depend on: `NOSUPERUSER NOBYPASSRLS`
 * roles, `SET ROLE`, `SECURITY DEFINER`, forced RLS that filters and fails
 * closed, `timestamptz` comparison, `RAISE EXCEPTION`, and composite foreign
 * keys. Triggers and policies live in the engine, not in the transport, so
 * nothing about the property under test is lost.
 *
 * WHY THERE IS ONLY ONE SESSION, AND WHAT REPLACED THE TWO POOLS
 * -------------------------------------------------------------
 * The old harness ran against a server and therefore had two pools: fixtures
 * written as `raptor_migrator` (SUPERUSER) and assertions made as `raptor_app`
 * (NOSUPERUSER NOBYPASSRLS). PGlite has a single session, so the second pool is
 * gone and the role is switched instead. The property being preserved is not
 * "two connections" but "the assertions are evaluated by a role that cannot
 * switch RLS off" — ADR-0006's actual point.
 *
 * `SET ROLE` ALONE IS NOT ENOUGH HERE, AND THAT IS THE SUBTLE PART
 * -----------------------------------------------------------------
 * `schema.sql` protects the five identity tables with
 *
 *     USING (session_user = 'raptor_app')
 *
 * not `current_user`. In PostgreSQL `SET ROLE` changes `current_user` and leaves
 * `session_user` alone, so under `SET ROLE raptor_app` those five tables would
 * be invisible — verified in PGlite, where `current_user=raptor_app` and
 * `session_user=postgres` together return zero rows from a policy'd table.
 * A harness that switched roles and quietly saw "no rows everywhere" would be
 * indistinguishable from a working default-deny policy, which is precisely the
 * failure this package exists to detect.
 *
 * So the session identity is switched ONCE, at setup, with
 * `SET SESSION AUTHORIZATION raptor_app`. From that point `current_user` and
 * `session_user` are both `raptor_app`, which is exactly the production
 * condition: the application connects as `raptor_app` and never as anything
 * else. Every statement Better Auth issues is therefore already evaluated under
 * the real, RLS-enforced identity without any role juggling.
 *
 * `SET SESSION AUTHORIZATION` is one-way in PostgreSQL — only a superuser may
 * use it, and `RESET SESSION AUTHORIZATION` requires the caller to still be a
 * superuser — so the harness does the switch once, after all superuser setup,
 * and never tries to undo it. Owner access afterwards is by membership:
 * `GRANT raptor_migrator TO raptor_app`, so the session can `SET ROLE` up to
 * the owner and `RESET ROLE` back down. That membership is the single place
 * where the test session is more privileged than production, it exists only so
 * fixtures can write rows RLS would otherwise (correctly) refuse, and it is
 * granted by this harness rather than by `schema.sql` precisely because it must
 * never exist in a deployment.
 *
 * THE LEAK THAT MUST BE IMPOSSIBLE
 * --------------------------------
 * If `raptor_migrator` were ever left active, RLS would be bypassed for every
 * subsequent statement and every isolation assertion in this package would
 * pass while proving nothing — the exact output ADR-0006 recorded. Three
 * independent guards make that unreachable:
 *
 *   1. the owner pool wraps every statement in `SET ROLE` / `RESET ROLE` in a
 *      `finally`, so a throwing statement still gives the role back;
 *   2. the whole triple is serialised on a shared lock, so nothing can be
 *      executed in the middle of it;
 *   3. {@link assertNotElevated} refuses to run if the session is a superuser,
 *      and {@link resetRoles} is called from every `beforeEach`.
 *
 * {@link asOwnerRole} and {@link asAppRole} are the only two doors into the
 * database, so there is no way to take a role without giving it back.
 *
 * SECRET HYGIENE
 * --------------
 * Nothing here logs, prints, interpolates or returns a password, a session
 * token or a cookie value. Failure messages name the statement's role and the
 * SQLSTATE, never its arguments.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { SessionLock, createPGlitePool, type PGlitePool } from "./pglite-pool.js";

/**
 * The application role. `NOSUPERUSER NOBYPASSRLS` (ADR-0006).
 *
 * Named in `schema.sql`, in `env.ts`, and in every test that asserts on the
 * boundary, so it is defined here once and imported rather than re-typed.
 */
export const APP_ROLE = "raptor_app";

/**
 * The migration role. `SUPERUSER` — DDL only.
 *
 * It owns the schema, so the `SECURITY DEFINER` function
 * `auth_session_by_token()` runs as it, which is the whole reason that function
 * may be granted at all.
 */
export const OWNER_ROLE = "raptor_migrator";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

/** A prepared database plus the two role doors described above. */
export interface AuthTestDatabase {
  /** The instance. Exposed for `exec`-only work such as `TRUNCATE`. */
  readonly db: PGlite;
  /** Every statement Better Auth issues. Runs as {@link APP_ROLE}. */
  readonly appPool: PGlitePool;
  /** Fixture statements that RLS would otherwise refuse. Runs as {@link OWNER_ROLE}. */
  readonly ownerPool: PGlitePool;
  /** Run `work` with the application role assumed, and give it back in a `finally`. */
  asAppRole<T>(work: () => Promise<T>): Promise<T>;
  /** Run `work` with the owner role assumed, and give it back in a `finally`. */
  asOwnerRole<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Run `work` with `raptor_app` NOT a member of `raptor_migrator`.
   *
   * Mirrors production, where the application role holds no membership of the
   * owner. Needed to assert anything the owner would otherwise grant by
   * inheritance — a column-level REVOKE in particular, which cannot be
   * demonstrated while the membership stands.
   */
  withoutOwnerMembership<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Drop any assumed role and clear the tenant GUC.
   *
   * Idempotent, and safe to call when nothing is assumed. Called from every
   * `beforeEach` so that a failure which somehow skipped a `finally` still
   * cannot poison the next test.
   */
  resetRoles(): Promise<void>;
  /** Refuse to proceed while the session holds superuser rights. */
  assertNotElevated(): Promise<void>;
  /** Close the instance. The pools are part of it and need no separate teardown. */
  close(): Promise<void>;
}

/**
 * Fail unless the session is running as a role that cannot bypass RLS.
 *
 * Deliberately not a silent repair. A harness that quietly downgraded itself
 * would turn "the role leaked" into "the isolation test is quietly weaker",
 * which is the failure this whole file exists to prevent.
 *
 * @throws when `current_user` is a superuser or holds `BYPASSRLS`.
 */
export async function assertNotElevated(db: PGlite): Promise<void> {
  const result = await db.query<{ current_user: string; bypasses_rls: boolean }>(
    `SELECT current_user AS current_user,
            (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls`,
  );

  const row = result.rows[0];
  if (row === undefined) throw new Error("assertNotElevated: no identity row returned");
  if (row.bypasses_rls) {
    throw new Error(
      `The test session is ${row.current_user}, which bypasses Row Level Security. ` +
        `Every isolation assertion would pass without proving anything.`,
    );
  }
}

/**
 * Build the test database.
 *
 * Applies `schema.sql` as the owner, then drops the session to the application
 * role. Safe to call once per test file: each file gets its own process, and
 * therefore its own in-memory instance.
 */
export async function createTestDatabase(): Promise<AuthTestDatabase> {
  const db = new PGlite();
  const lock = new SessionLock();

  // Roles first: `schema.sql` grants to `raptor_app` and, at the end, asserts
  // it is neither a superuser nor BYPASSRLS. Creating them here means those
  // statements are exercised against roles with the attributes production has
  // rather than against whatever PGlite bootstrapped.
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
        CREATE ROLE ${OWNER_ROLE} LOGIN SUPERUSER;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
    $$;
  `);

  // The ONLY privilege the test session holds that production does not: the
  // ability to become the owner so fixtures can seed rows the tenant policy
  // exists to protect. It is a membership, not a password, it is created here
  // rather than in `schema.sql`, and it is unreachable in a deployment because
  // `env.ts` refuses to hand `raptor_migrator` to an application process.
  await db.exec(`GRANT ${OWNER_ROLE} TO ${APP_ROLE}`);

  // The membership must be revocable later, and the session identity by then is
  // `raptor_app` (see `SET SESSION AUTHORIZATION` below), which cannot revoke a
  // membership it was granted without ADMIN OPTION. So the grant carries the
  // option from the start.
  //
  // Harness plumbing only; it never reaches a deployment. It also does NOT weaken
  // any assertion: a member still inherits the owner's privileges, which is
  // exactly why {@link withoutOwnerMembership} exists.
  await db.exec(`GRANT ${OWNER_ROLE} TO ${APP_ROLE} WITH ADMIN OPTION`);

  // That membership has a consequence worth stating, because it changes what the
  // app role can be shown to do.
  //
  // In PostgreSQL a role inherits the privileges of every role it is a member of,
  // so while `raptor_app` is a member of `raptor_migrator` it holds the OWNER's
  // privileges — including any the owner holds and `raptor_app` was explicitly
  // denied. A column-level `REVOKE ... FROM raptor_app` cannot be demonstrated
  // while that membership stands: the inherited grant simply wins.
  //
  // Production has no such membership (`env.ts` refuses to hand the migration role
  // to an application process), so the restriction DOES hold there. To prove it
  // rather than assume it, {@link withoutOwnerMembership} drops the membership for
  // the duration of one check and restores it afterwards.
  // `SET SESSION AUTHORIZATION` below makes `session_user` the app role, and that
  // switch is one-way. Capture the bootstrap identity NOW, while it still exists,
  // so role DDL can be re-entered later: after the switch, `raptor_app` is not a
  // superuser and PGlite refuses `REVOKE` for it even with ADMIN OPTION held.
  const bootstrapSuperuser = await readBootstrapIdentity(db);

  const withoutOwnerMembership = async <T>(work: () => Promise<T>): Promise<T> => {
    await db.exec(`SET SESSION AUTHORIZATION ${bootstrapSuperuser}`);
    try {
      await db.exec(`REVOKE ${OWNER_ROLE} FROM ${APP_ROLE}`);
    } finally {
      await db.exec(`SET SESSION AUTHORIZATION ${APP_ROLE}`);
    }
    try {
      return await work();
    } finally {
      await db.exec(`SET SESSION AUTHORIZATION ${bootstrapSuperuser}`);
      try {
        await db.exec(`GRANT ${OWNER_ROLE} TO ${APP_ROLE} WITH ADMIN OPTION`);
      } finally {
        await db.exec(`SET SESSION AUTHORIZATION ${APP_ROLE}`);
      }
    }
  };

  const schemaSql = await readFile(SCHEMA_PATH, "utf8");
  await db.exec("SET ROLE " + OWNER_ROLE);
  try {
    await db.exec(schemaSql);
  } finally {
    await db.exec("RESET ROLE");
  }

  // Everything above needed superuser rights; nothing below is allowed to have
  // them. `SET SESSION AUTHORIZATION` changes `session_user` as well as
  // `current_user`, which is what the identity-table policies read.
  await db.exec(`SET SESSION AUTHORIZATION ${APP_ROLE}`);

  const appPool = createPGlitePool(db, { lock });
  const ownerPool = createPGlitePool(db, { lock, role: OWNER_ROLE });

  const asRole = <T>(role: string, work: () => Promise<T>): Promise<T> =>
    lock.run(async () => {
      await db.exec(`SET ROLE ${role}`);
      try {
        return await work();
      } finally {
        await db.exec("RESET ROLE");
      }
    });

  return {
    db,
    appPool,
    ownerPool,
    asAppRole: (work) => asRole(APP_ROLE, work),
    asOwnerRole: (work) => asRole(OWNER_ROLE, work),
    withoutOwnerMembership,
    resetRoles: async () => {
      await lock.run(async () => {
        await db.exec("RESET ROLE");
        // Cleared rather than set to '' so `current_org_id()` returns NULL,
        // which is the "no tenant" case the session policy fails closed on.
        await db.exec("SELECT set_config('app.org_id', '', false)");
      });
    },
    assertNotElevated: () => assertNotElevated(db),
    close: async () => {
      await db.close();
    },
  };
}

/**
 * The session's identity before `SET SESSION AUTHORIZATION` replaces it.
 *
 * Read from the server rather than hardcoded, because PGlite's bootstrap role name
 * is an implementation detail that should not leak into assertions. Needed because
 * `SET SESSION AUTHORIZATION` is one-way, so role DDL performed afterwards has no
 * privileged identity left to run as.
 */
async function readBootstrapIdentity(db: PGlite): Promise<string> {
  const result = await db.query<{ session_user: string }>("SELECT session_user");
  const identity = result.rows[0]?.session_user;
  if (identity === undefined) throw new Error("readBootstrapIdentity: no session_user returned");
  return identity;
}

/**
 * Read `schema.sql` and apply it, so a fixture can assert against a database
 * this module has not already prepared.
 *
 * Exported because `schema.test.ts` has to distinguish "the DDL says so" from
 * "the running database agrees", and it therefore applies the file to an empty
 * instance of its own.
 */
export async function applySchemaSql(db: PGlite): Promise<void> {
  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
        CREATE ROLE ${OWNER_ROLE} LOGIN SUPERUSER;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
  await db.exec(`GRANT ${OWNER_ROLE} TO ${APP_ROLE}`);
  await db.exec("SET ROLE " + OWNER_ROLE);
  try {
    await db.exec(await readFile(SCHEMA_PATH, "utf8"));
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** Absolute path of `schema.sql`, for the tests that read the file itself. */
export const SCHEMA_FILE_PATH = SCHEMA_PATH;