/**
 * A `pg`-Pool-shaped adapter over an in-process PGlite instance.
 *
 * WHY THIS MODULE EXISTS AT ALL
 * -----------------------------
 * Better Auth's `database` option is duck-typed, not class-checked. In the
 * installed `better-auth@1.7.7`, `createKyselyAdapter` walks the candidate in
 * this order (`@better-auth/kysely-adapter/dist/index.mjs`):
 *
 *     if ("db" in db)         -> a Kysely instance
 *     if ("dialect" in db)    -> a Kysely dialect
 *     if ("aggregate" in db)  -> better-sqlite3
 *     if ("getConnection" in db) -> mysql2
 *     if ("connect" in db)    -> PostgresDialect({ pool: db })
 *
 * so anything exposing `connect()` is a PostgreSQL driver. Kysely's
 * `PostgresDriver` then touches exactly three members of the "pool":
 *
 *     pool.connect()            -> client
 *     client.query(sql, params) -> { command, rowCount, rows }
 *     client.release()
 *     pool.end()
 *
 * Verified in `kysely@0.28.8/dist/cjs/dialect/postgres/postgres-driver.js`.
 * That is the whole contract, and this module implements exactly it — no
 * attempt is made to emulate `pg`'s type coercion, because Kysely performs its
 * own parsing on top of `rows` and PGlite already returns real JavaScript
 * values (`timestamptz` -> `Date`, `bigint` -> `bigint`, `jsonb` -> object,
 * `numeric` -> `string`), which is what `pg` hands over too.
 *
 * WHY A BRIDGE AND NOT A DIFFERENT BETTER AUTH ADAPTER
 * ----------------------------------------------------
 * The installed package ships adapters for Drizzle, Prisma, Kysely, MongoDB and
 * an in-memory store (`better-auth/dist/adapters/`). There is no PGlite
 * adapter — a grep for `pglite` across the whole of `better-auth/dist` returns
 * nothing — and Drizzle/Prisma would mean depending on an ORM layer and
 * re-declaring this package's hand-written schema, which `schema.sql` says was
 * produced by Better Auth's own migration compiler and must not be "tidied up".
 * The Kysely path is the one Better Auth itself selects for a `connect`-shaped
 * object, so the bridge is not a workaround around Better Auth; it is the
 * driver Better Auth would build itself around a real `pg.Pool`.
 *
 * WHAT IS DELIBERATELY *NOT* HERE
 * -------------------------------
 *   - No statement rewriting, no query logging, no error swallowing. Every
 *     failure propagates with PGlite's original `code` (`23514`, `42501`, …),
 *     which is what `mfa-enforcement.test.ts` asserts on.
 *   - No connection pooling and no concurrency. PGlite is one in-process
 *     session, so `connect()` hands out a handle onto that one session and
 *     `end()` is a no-op for the shared instance (the harness owns the
 *     instance's lifetime). Anything claiming two concurrent connections here
 *     would be theatre.
 *   - No cursor support. Kysely only reaches for `pg-cursor` when a query is
 *     streamed, and `config.ts` sets `cookieCache.enabled: false`, so no
 *     session read is ever streamed.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { PGlite } from "@electric-sql/pglite";

/** Commands Kysely turns into `numAffectedRows`. Everything else is a read. */
const WRITE_COMMANDS = ["INSERT", "UPDATE", "DELETE", "MERGE"] as const;

/** The result shape Kysely's `PostgresConnection.executeQuery` destructures. */
export interface QueryResultLike<Row> {
  readonly command: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE";
  readonly rowCount: number;
  readonly rows: Row[];
}

/** The client Kysely holds while it owns the (single) session. */
export interface PGlitePoolClient {
  query<Row>(sql: string, parameters?: ReadonlyArray<unknown>): Promise<QueryResultLike<Row>>;
  release(): void;
}

/**
 * The pool Kysely is constructed with.
 *
 * `query` is not part of Kysely's contract — it is here because the test
 * fixtures issue their own SQL, and giving them the same door Better Auth uses
 * means there is one code path to reason about rather than two.
 */
export interface PGlitePool {
  connect(): Promise<PGlitePoolClient>;
  query<Row>(sql: string, parameters?: ReadonlyArray<unknown>): Promise<QueryResultLike<Row>>;
  end(): Promise<void>;
}

/**
 * Narrow PGlite's `command` to the union Kysely declares.
 *
 * PGlite reports whatever tag PostgreSQL's `CommandComplete` carried, which
 * includes commands Kysely never treats as writes (`BEGIN`, `SET`, `TRUNCATE`).
 * Those must NOT be mapped to a write command or Kysely would report a
 * `numAffectedRows` for a statement that affected nothing.
 */
function toCommand(tag: string | undefined): QueryResultLike<unknown>["command"] {
  return WRITE_COMMANDS.find((candidate) => candidate === tag) ?? "SELECT";
}

/**
 * Serialises every statement that crosses the single PGlite session.
 *
 * WHY: the harness gives the owner pool a `SET ROLE` / statement / `RESET ROLE`
 * triple. Without a lock, a statement issued by the application pool could land
 * between the `SET ROLE` and the `RESET ROLE` and would then execute with
 * superuser rights — silently switching RLS off for exactly one query. The
 * window is small and the failure would be invisible, which is the worst
 * combination available. Holding the lock for the whole triple closes it.
 *
 * WHY IT IS REENTRANT
 * -------------------
 * A fixture opens a transaction, sets `app.org_id` transaction-locally, and then
 * calls back into the pool:
 *
 *     lock.run(async () => {
 *       await db.exec("BEGIN");
 *       await db.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
 *       return await pool.query("SELECT ... FROM session");   // nested
 *       // COMMIT
 *     });
 *
 * With a plain promise chain the nested `pool.query` queues behind the very
 * promise that is awaiting it, so it can never run: the outer call does not
 * return until the inner one does, and the inner one does not start until the
 * outer one does. Every test using this shape hangs until the hook timeout, and
 * the assertions never get to run — which is why this was read as a test failure
 * rather than as a harness bug.
 *
 * A boolean "am I inside run()" flag would fix the hang and silently destroy the
 * guarantee above: a genuinely concurrent caller arriving while the flag is set
 * would be admitted immediately and could land inside someone else's
 * `SET ROLE` window. So ownership is tracked per async context with
 * `AsyncLocalStorage` instead. A nested call in the SAME context runs inline — it
 * already holds the session — while a DIFFERENT context still queues. That keeps
 * the isolation property intact and makes the deadlock structurally impossible.
 *
 * It is deliberately NOT a transaction: the lock covers one top-level `run()`
 * call, so a statement another caller issues while a `BEGIN`/`COMMIT` pair is open
 * still lands inside that transaction. That is inherent to a one-session
 * database and is why the tests never interleave fixture writes with an
 * in-flight Better Auth call; the alternative — a real server with two
 * connections — is exactly what ADR-0015 recorded as unavailable here.
 */
export class SessionLock {
  #tail: Promise<void> = Promise.resolve();

  /**
   * Non-undefined in exactly the async contexts that currently hold this lock.
   *
   * A context is marked only for the duration of the `run()` that acquired it, and
   * every continuation inside that work inherits the mark — which is what makes
   * "issued from inside the transaction that issued it" detectable at all.
   */
  readonly #holding = new AsyncLocalStorage<true>();

  public run<T>(work: () => Promise<T>): Promise<T> {
    // Already the owner in this async context: the session is ours for the whole
    // call, so queueing would only make us wait on ourselves.
    if (this.#holding.getStore() === true) return work();

    const result = this.#tail.then(
      () => this.#holding.run(true, work),
      () => this.#holding.run(true, work),
    );
    // Keep the chain alive even when `work` rejects, or every later caller
    // would inherit the rejection.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Build a `pg`-Pool-shaped pool over one PGlite session.
 *
 * @param db - The instance to talk to. Shared: every pool built from the same
 *   instance reaches the same session, which is the whole point — PGlite
 *   cannot give two of them.
 * @param options.lock - Shared with every other pool over the same instance.
 * @param options.role - When set, each statement runs inside
 *   `SET ROLE <role>` / `RESET ROLE`, in a `finally`. Omit it for statements
 *   that must run as the session's own identity — which is the application
 *   role, and therefore the only identity under which the RLS assertions mean
 *   anything.
 */
export function createPGlitePool(db: PGlite, options: { lock: SessionLock; role?: string }): PGlitePool {
  const run = async <Row>(
    sql: string,
    parameters: ReadonlyArray<unknown> | undefined,
  ): Promise<QueryResultLike<Row>> => {
    const result = await db.query<Row>(sql, [...(parameters ?? [])]);
    return {
      command: toCommand(result.command),
      rowCount: result.rowCount ?? result.affectedRows ?? 0,
      rows: result.rows,
    };
  };

  const guarded =
    options.role === undefined
      ? run
      : async <Row>(sql: string, parameters?: ReadonlyArray<unknown>): Promise<QueryResultLike<Row>> => {
          // Identifiers cannot be parameterised, so `role` is interpolated. It
          // is a compile-time constant from the harness, never user input, and
          // it is quoted so that anything other than a bare role name fails
          // loudly at parse time instead of executing.
          const quoted = `"${options.role?.replaceAll('"', '""') ?? ""}"`;
          await db.exec(`SET ROLE ${quoted}`);
          try {
            return await run<Row>(sql, parameters);
          } finally {
            await db.exec("RESET ROLE");
          }
        };

  return {
    // Acquiring needs no lock of its own: there is no handshake to interleave
    // with, and `release()` is a no-op for the same reason. Written as an
    // explicit resolved promise rather than an `async` arrow, because there is
    // nothing to await and `require-await` is right to object.
    connect: (): Promise<PGlitePoolClient> =>
      Promise.resolve({
        query: <Row>(sql: string, parameters?: ReadonlyArray<unknown>) =>
          options.lock.run(() => guarded<Row>(sql, parameters)),
        // Nothing to release: there is no second connection to hand back. Kept
        // because Kysely calls it on every error path, and an absent method there
        // would turn a failed assertion into an unrelated crash.
        release: (): void => undefined,
      }),
    query: <Row>(sql: string, parameters?: ReadonlyArray<unknown>) =>
      options.lock.run(() => guarded<Row>(sql, parameters)),
    // The instance is shared and outlives any single pool. Closing it is the
    // harness's job; doing it here would break the sibling pool.
    end: (): Promise<void> => Promise.resolve(),
  };
}