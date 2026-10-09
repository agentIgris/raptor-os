/**
 * The bridge's reentrancy invariant.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * -------------------------------
 * `session-isolation.test.ts` hung for 124s and reported 15 failures that all
 * looked like assertion failures. They were not: no assertion ever ran. Each test
 * opened a transaction on the single PGlite session and then called back into the
 * pool, which queued behind the transaction that was awaiting it.
 *
 * The failure mode is nasty because it is silent about itself. The tests are
 * written correctly, the SQL is correct, and the suite reports "failed" with no
 * hint that the harness deadlocked. Anything that removes the invariant will
 * reproduce exactly that, so the invariant gets its own test, stated directly,
 * rather than being inferred from a file that happens to pass.
 *
 * WHAT IS ACTUALLY PROVEN
 * -----------------------
 * 1. A query issued from inside a transaction opened on the bridge completes.
 * 2. It sees that transaction's GUC, so `SET LOCAL`-scoped tenant context works.
 * 3. The GUC is reverted at COMMIT, so one request cannot leak into the next.
 * 4. A DIFFERENT async context still queues — reentrancy must not have weakened
 *    the mutual exclusion that keeps a statement out of someone else's
 *    `SET ROLE` window. A fix that merely deleted the lock would pass 1-3 and
 *    fail this, which is precisely why it is here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PGlite } from "@electric-sql/pglite";

import { SessionLock, createPGlitePool } from "./pglite-pool.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

let db: PGlite;
let lock: SessionLock;
let pool: ReturnType<typeof createPGlitePool>;

beforeAll(async () => {
  db = new PGlite();
  lock = new SessionLock();
  pool = createPGlitePool(db, { lock });

  await db.exec("CREATE TABLE probe (id int, org text)");
  await db.exec(`INSERT INTO probe VALUES (1, '${ORG_A}'), (2, '${ORG_B}')`);
});

afterAll(async () => {
  await db.close();
});

/**
 * Fails loudly instead of hanging.
 *
 * A deadlock's natural symptom is a timeout, and a timeout inside a hook is
 * reported as an unrelated-looking failure. Racing it here turns "the suite hung
 * for two minutes" into "this one invariant is broken, here is the number".
 */
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("the bridge is reentrant", () => {
  it("runs a query issued from inside a transaction it holds", async () => {
    // The exact shape that deadlocked: BEGIN, set the GUC, then call the pool
    // from inside the same lock acquisition.
    const rows = await within(
      lock.run(async () => {
        await db.exec("BEGIN");
        try {
          await db.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          return await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM probe");
        } finally {
          await db.exec("COMMIT");
        }
      }),
      5_000,
      "nested query inside an open transaction",
    );

    expect(rows.rows[0]?.n).toBe(2);
  });

  it("still serialises work from a different async context", async () => {
    // Reentrancy must not mean "everyone runs at once". A caller in a different
    // context has to wait, otherwise a statement can land inside another caller's
    // SET ROLE window and execute with the wrong privileges — the one failure the
    // lock was introduced to prevent.
    const order: string[] = [];

    const holder = lock.run(async () => {
      order.push("holder-start");
      await pool.query("SELECT 1");
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push("holder-end");
    });

    // Deliberately started without awaiting, so it is queued rather than nested.
    // `async` because `run` takes a promise-returning callback; there is nothing to
    // await, which is the rule `require-await` is pointing at.
    // eslint-disable-next-line @typescript-eslint/require-await
    const interloper = lock.run(async () => {
      order.push("interloper");
    });

    await within(Promise.all([holder, interloper]), 5_000, "two independent lock holders");

    // The interloper could not have run between the holder's start and end.
    expect(order).toEqual(["holder-start", "holder-end", "interloper"]);
  });

  it("propagates a rejection without poisoning later callers", async () => {
    await expect(
      within(
        // eslint-disable-next-line @typescript-eslint/require-await
        lock.run(async () => {
          throw new Error("deliberate failure");
        }),
        5_000,
        "failing lock holder",
      ),
    ).rejects.toThrow("deliberate failure");

    // A rejected holder must not leave the chain wedged. Before the fix this was
    // unrecoverable in practice: one deadlock meant every later query in the file
    // hung too, which is why a single stuck test took down the whole suite.
    const after = await within(pool.query<{ n: number }>("SELECT 1::int AS n"), 5_000, "query after a failure");
    expect(after.rows[0]?.n).toBe(1);
  });
});

describe("transaction-scoped tenant context survives the nesting", () => {
  it("is visible inside the transaction and reverted at COMMIT", async () => {
    // The property `asOrg()` in session-isolation.test.ts depends on: the tenant
    // must be set for exactly one transaction. If this stopped working the
    // isolation tests would still pass, but they would be asserting against a
    // session with no tenant — which reads as zero rows everywhere.
    const insideTransaction = await within(
      lock.run(async () => {
        await db.exec("BEGIN");
        try {
          await db.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          return await pool.query<{ org: string | null }>(
            "SELECT current_setting('app.org_id', true) AS org",
          );
        } finally {
          await db.exec("COMMIT");
        }
      }),
      5_000,
      "reading the GUC inside the transaction",
    );

    expect(insideTransaction.rows[0]?.org).toBe(ORG_A);

    const afterCommit = await within(
      pool.query<{ org: string | null }>("SELECT current_setting('app.org_id', true) AS org"),
      5_000,
      "reading the GUC after COMMIT",
    );

    // Back to the fail-closed "no tenant" state, not left pointing at ORG_A.
    expect(afterCommit.rows[0]?.org ?? "").toBe("");
  });
});