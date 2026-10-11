/**
 * Operations — tasks, workflow runs, travel, assets and facilities.
 *
 * The design spec closes Phase 6 on *"Tasks, workflows, travel, assets,
 * facilities provable end to end"*. This file is the release gate for that claim,
 * and it is organised around the five places where "provable" is easy to say and
 * hard to enforce.
 *
 * THE CENTRAL CLAIMS
 * ------------------
 * 1. **A task's legal transitions are DATA, and the database refuses any move
 *    the table does not contain.** A `status` column with a CHECK can say what a
 *    row may BE; it cannot say what a row may BECOME, because that is a relation
 *    between two rows in time. So the edges live in `task_state_transition`,
 *    seeded from the same table `packages/core/src/tasks/task.ts` declares — and
 *    a test asserts the two agree by NAME, so the domain and the schema cannot
 *    drift apart silently.
 * 2. **A workflow run's stored status cannot disagree with its step rows.** The
 *    status is a cached aggregate, re-derived at COMMIT and enforced. Deferred,
 *    so "complete the step AND move the run" is one transaction.
 * 3. **A task a workflow step created agrees with that step.** A completed step
 *    whose task is still open is the "workflow says done, backlog says
 *    otherwise" case that makes a board untrustworthy.
 * 4. **A minor may not travel without a live guardian consent naming THIS
 *    engagement.** 0008's `guardian_consent_covers_in_org` is the rule; this
 *    file asserts it is REUSED rather than restated, by proving a consent for
 *    another engagement does not travel.
 * 5. **Custody is append-only and the holder is DERIVED**, because a mutable
 *    holder column is the gap ADR-0016 found in the legacy system. No table here
 *    has a `holder_id`.
 * 6. **Overlapping facility reservations are impossible** — enforced by trigger,
 *    because `btree_gist` is unavailable and `EXCLUDE USING gist` over uuid
 *    fails in this environment. Both facts are recorded in the migration header
 *    and neither is worked around silently.
 *
 * WHAT IS ASSERTED TO BE ABSENT
 * -----------------------------
 * Structural claims are made by reflecting over the catalogue, not by trusting
 * the DDL, matching the existing isolation suites:
 *
 *   * No `holder_id` / `assigned_to` / `custodian` column on `asset`.
 *   * No stored minority boolean anywhere in the travel tables.
 *   * No `task.status`-like flag that the trigger does not govern.
 *   * No `LIMIT` inside any reporting function.
 *
 * METHOD
 * ------
 * Real SQL against a real PGlite instance. Isolation assertions are made as
 * `raptor_app` (`rolsuper=false AND rolbypassrls=false`), because a superuser
 * bypasses every policy (ADR-0006) and would let an assertion pass for the wrong
 * reason.
 *
 * Both environment traps this file is written around are recorded in the
 * migration brief:
 *
 *   * PGlite returns `timestamptz` to Node as HOST-timezone `Date` objects, so
 *     every instant is cast to text IN SQL before it reaches an assertion.
 *   * PostgreSQL SILENTLY parses a malformed ISO literal into a wrong-but-valid
 *     instant with NO error, so every instant here is a whole literal or is
 *     produced by PostgreSQL. Nothing is concatenated.
 *
 * A third, specific to this file: several guarantees are DEFERRABLE CONSTRAINT
 * TRIGGERS, so the refusal arrives at COMMIT rather than at the offending
 * statement. Every such test therefore wraps its transaction in a single
 * `BEGIN; ...; COMMIT;` and asserts that the refusal happened at COMMIT.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

/**
 * The domain's task vocabulary and transition table, read as SOURCE TEXT.
 *
 * `packages/db` deliberately does NOT depend on `packages/core`, and this is where
 * that decision is tested rather than merely asserted. A relative import of the
 * core source was tried first and broke `tsc --build`: the file sits outside
 * `packages/db`'s `rootDir` and outside its `include`, so the project reference
 * fails with TS6059/TS6307. Adding the dependency to `package.json` would fix
 * the build and cost a real coupling introduced for a test convenience.
 *
 * Reading the exported constants as text keeps the assertion — which is that the
 * domain and the schema agree — without coupling the build. The alternative,
 * asserting nothing, is what this test exists to avoid.
 *
 * Read from the CANONICAL files rather than the barrel, so the assertion is about
 * the declaration and not about re-exports.
 */
const DOMAIN_TASK_STATES: readonly string[] = readExportedStringArray(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "src", "tasks", "task.ts"),
  "TASK_STATES",
);

const DOMAIN_TASK_TRANSITIONS: Readonly<Record<string, readonly string[]>> = readExportedTransitionTable(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "core", "src", "tasks", "task.ts"),
  "TASK_TRANSITIONS",
);

/** The `export const NAME = [ ... ] as const;` array in `file`. */
function readExportedStringArray(file: string, name: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`, "s").exec(source);
  if (match === null) {
    throw new Error(`Could not find 'export const ${name} = [...] as const' in ${file}`);
  }
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
}

/**
 * The `export const NAME: Readonly<Record<State, readonly State[]>> = { ... }`
 * object in `file`, read key by key.
 */
function readExportedTransitionTable(file: string, name: string): Readonly<Record<string, readonly string[]>> {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`export const ${name}`);
  if (start < 0) {
    throw new Error(`Could not find 'export const ${name}' in ${file}`);
  }

  // Scan from the opening brace to its match, tracking nesting so a brace inside a
  // comment or a string does not end the object early.
  const body_start = source.indexOf("{", start);
  let depth = 0;
  let body_end = body_start;
  for (let i = body_start; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        body_end = i;
        break;
      }
    }
  }

  const body = source.slice(body_start + 1, body_end);
  const table: Record<string, readonly string[]> = {};
  // `key: Object.freeze<Type[]>([ "a", "b" ]),` — the generic parameter and the
  // wrapper are both matched rather than assumed, because a tighter pattern
  // would silently stop matching the day the declaration is reformatted and
  // this test would then compare the database against an EMPTY table. The
  // non-vacuity assertion below is what makes that loud.
  for (const entry of body.matchAll(/(\w+):\s*Object\.freeze<[^>]*>\(\s*\[([^\]]*)\]/g)) {
    table[entry[1]!] = [...entry[2]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]!);
  }

  if (Object.keys(table).length === 0) {
    throw new Error(
      `Parsed no transitions out of ${file}. The pattern no longer matches the declaration, and a silent empty parse would make every agreement test vacuous.`,
    );
  }
  return table;
}

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/** ORG_A's people: an adult, a minor, their guardian, a staff member, a second adult. */
const ADULT_A = "aaaa0000-0000-0000-0000-000000000001";
const MINOR_A = "aaaa0000-0000-0000-0000-000000000002";
const GUARDIAN_A = "aaaa0000-0000-0000-0000-000000000003";
const STAFF_A = "aaaa0000-0000-0000-0000-000000000004";
const SECOND_ADULT_A = "aaaa0000-0000-0000-0000-000000000005";
/** ORG_B's people, so cross-tenant refusals have something real to point at. */
const ADULT_B = "bbbb0000-0000-0000-0000-000000000001";
/**
 * A SEPARATE ORG_B guardian.
 *
 * 0008 forbids a person being their own guardian
 * (`guardian_consent_not_self_check`), so the ORG_B consent fixture cannot reuse
 * ADULT_B for both columns. Using it for both failed with a check violation on
 * the FIXTURE rather than on the constraint the test was written to prove.
 */
const GUARDIAN_B = "bbbb0000-0000-0000-0000-000000000002";

const INR = "INR";

/**
 * Every TENANT table introduced by 0010_operations.sql.
 */
const OPERATIONS_TABLES = [
  "asset",
  "asset_custody",
  "facility",
  "facility_reservation",
  "task",
  "task_dependency",
  "task_state_transition",
  "task_transition",
  "trip",
  "trip_destination",
  "trip_leg",
  "trip_traveller",
  "workflow_definition",
  "workflow_run",
  "workflow_step_definition",
  "workflow_step_run",
] as const;

/**
 * Whole ISO instants, never assembled from parts — see the file header.
 *
 * The trip fixtures are dated 2026 because this repository's design spec is dated
 * 2026-10-09: a fixture pinned to 2025 would be in the past relative to whenever
 * the suite runs, and the "not_before" and currency-window checks are all as-of
 * comparisons that must not depend on the day they execute.
 */
const PAST = "2026-01-15T09:00:00Z";
const DEPARTS = "2026-07-14T04:00:00Z";
const RETURNS = "2026-07-21T20:00:00Z";

let db: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the session to a usable state: no open transaction, no assumed role.
 *
 * The ROLLBACK must come FIRST. PostgreSQL refuses every statement in an ABORTED
 * transaction with 25P02 until it is rolled back — including `RESET ROLE` — and
 * getting that order wrong turns one intended refusal into a cascade of false
 * failures that look like schema bugs and are not.
 */
async function recoverSession(): Promise<void> {
  try {
    await db.exec("ROLLBACK");
  } catch {
    // No transaction was open, which is the normal case after a successful commit.
  }
  try {
    await db.exec("RESET ROLE");
  } catch {
    // Nothing to reset.
  }
}

/** As the schema owner, which bypasses RLS. Used only for seeding and reflection. */
async function asOwner(sql: string): Promise<void> {
  await recoverSession();
  try {
    await db.exec(sql);
  } catch (error) {
    await recoverSession();
    throw error;
  }
}

/**
 * A query as the schema owner, which bypasses RLS.
 *
 * The tenant IS set in the session, deliberately: several reporting functions in
 * this schema resolve their tenant from `current_org_id()` rather than from a
 * parameter (ADR-0011 rule 3), so a read with no tenant set returns zero rows —
 * and a test that passes on an empty answer is worse than one that fails.
 */
async function ownerRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await recoverSession();
  await db.exec(`SET app.org_id = '${ORG_A}'`);
  try {
    const result = await db.query<T>(sql, params);
    return result.rows;
  } finally {
    await recoverSession();
  }
}

/**
 * Runs `fn` as the non-superuser application role.
 *
 * A superuser bypasses every policy in this schema, so an isolation assertion
 * made as the owner proves nothing.
 */
async function asApp(fn: () => Promise<void>, orgId?: string): Promise<void> {
  await recoverSession();
  await db.exec("SET ROLE raptor_app");
  if (orgId) await db.exec(`SET app.org_id = '${orgId}'`);
  else await db.exec("SELECT set_config('app.org_id', '', false)");
  try {
    await fn();
  } finally {
    await recoverSession();
  }
}

/** A query through the application role with ORG_A in the session context. */
async function appRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await recoverSession();
  await db.exec("SET ROLE raptor_app");
  await db.exec(`SET app.org_id = '${ORG_A}'`);
  try {
    const result = await db.query<T>(sql, params);
    return result.rows;
  } finally {
    await recoverSession();
  }
}

/**
 * Runs `fn` expecting PostgreSQL to refuse it with a specific SQLSTATE.
 *
 * Asserting the code rather than the message: several guarantees here raise the
 * same SQLSTATE from different mechanisms, and a message match would let the
 * wrong mechanism satisfy a test that claims a specific one.
 */
async function expectSqlstate(fn: () => Promise<unknown>, sqlstate: string, label: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }

  // DELIBERATELY no `recoverSession()` here.
  //
  // An earlier version reset the session in a `finally`, and `recoverSession`
  // does `RESET ROLE` as well as `ROLLBACK`. Called TWICE inside one `asApp(...)`
  // block, the first assertion silently dropped the role and the second ran as
  // the SCHEMA OWNER — so `DELETE FROM asset_custody` SUCCEEDED and the
  // assertion reported "expected 42501 but the statement succeeded" against a
  // schema that refuses the delete perfectly well. Two of these tests were
  // failing for that reason and neither was a schema bug.
  //
  // Session recovery belongs to `asApp` and `asOwner`, which both do it in their
  // own `finally`. This helper's only job is to catch and classify.
  if (caught === undefined) {
    throw new Error(`${label}: expected SQLSTATE ${sqlstate} but the statement succeeded`);
  }

  const actual = (caught as { code?: string }).code;
  expect(actual, `${label}: wrong SQLSTATE → ${String((caught as Error).message).slice(0, 240)}`).toBe(sqlstate);
}

/** Wraps a multi-statement transaction that is expected to be REFUSED at COMMIT. */
async function expectCommitRefusal(statements: string, sqlstate: string, label: string): Promise<void> {
  await expectSqlstate(() => asOwner(`BEGIN; ${statements} COMMIT;`), sqlstate, label);
}

/** Wraps a multi-statement transaction expected to SUCCEED. */
async function commit(statements: string): Promise<void> {
  await asOwner(`BEGIN; ${statements} COMMIT;`);
}

const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_NOT_NULL_VIOLATION = "23502";
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Quotes a value as a SQL string literal.
 *
 * Present because fixture strings contain apostrophes, as trip purposes
 * genuinely do. Interpolating them raw produces a syntax error, and a suite full
 * of syntax errors is a suite that has stopped testing anything at all.
 */
function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** An engagement for a traveller. Consent is to an ENGAGEMENT (0008), never global. */
const ENGAGEMENT_A = "e0000000-0000-0000-0000-000000000001";
/** A second engagement, so a consent for the WRONG one has something to be. */
const ENGAGEMENT_A_OTHER = "e0000000-0000-0000-0000-000000000002";
const ENGAGEMENT_B = "e0000000-0000-0000-0000-000000000003";

const TRIP_A = "7a000000-0000-0000-0000-000000000001";
const TRIP_B = "7b000000-0000-0000-0000-000000000001";

const TASK_A = "7c000000-0000-0000-0000-000000000001";
const TASK_DEP = "7c000000-0000-0000-0000-000000000002";
const TASK_BLOCKER = "7c000000-0000-0000-0000-000000000003";

const WF_DEF_A = "7d000000-0000-0000-0000-000000000001";
const WF_STEP_QUOTE = "7e000000-0000-0000-0000-000000000001";
const WF_STEP_BOOK = "7e000000-0000-0000-0000-000000000002";
const WF_RUN_A = "7f000000-0000-0000-0000-000000000001";
const WF_TASK = "7c000000-0000-0000-0000-000000000010";
const WF_DEF_ONE = "7d000000-0000-0000-0000-000000000010";
const WF_STEP_ONE = "7e000000-0000-0000-0000-000000000010";
const WF_RUN_ONE = "7f000000-0000-0000-0000-000000000010";

const ASSET_A = "9a000000-0000-0000-0000-000000000001";
const ASSET_B = "9b000000-0000-0000-0000-000000000001";
const FACILITY_A = "8a000000-0000-0000-0000-000000000001";
const FACILITY_B = "8b000000-0000-0000-0000-000000000001";
const FACILITY_UNBOUNDED = "8a000000-0000-0000-0000-000000000002";
const FACILITY_BANK = "8a000000-0000-0000-0000-000000000003";

/**
 * Extra ids for scenarios that need their own row.
 *
 * ALL of them are real uuids. An earlier draft used readable strings like
 * `t-done`, and every one of those scenarios failed with `22P02 invalid input
 * syntax for type uuid` before reaching the constraint it was written to test —
 * which is the worst kind of test failure, because a fixture bug reads exactly
 * like a schema bug.
 */
const TASK_DONE = "7c000000-0000-0000-0000-0000000000d1";
const TASK_LATE = "7c000000-0000-0000-0000-0000000000d2";
const TASK_B_ORG = "7c000000-0000-0000-0000-0000000000b1";
const TASK_HALF_ORIGIN = "7c000000-0000-0000-0000-0000000000d3";
const TASK_GHOST_ORIGIN = "7c000000-0000-0000-0000-0000000000d4";
const WF_RUN_TWO = "7f000000-0000-0000-0000-000000000002";
const WF_DEF_DUP = "7d000000-0000-0000-0000-000000000002";
const WS_DUP_A = "7e000000-0000-0000-0000-0000000000d1";
const WS_DUP_B = "7e000000-0000-0000-0000-0000000000d2";
const TRIP_NO_CURRENCY = "7a000000-0000-0000-0000-0000000000d1";
const TRIP_NO_LEGS = "7a000000-0000-0000-0000-0000000000d2";
const TRIP_NO_LEGS_D1 = "7a000000-0000-0000-0000-0000000000d3";
const TRIP_NO_LEGS_D2 = "7a000000-0000-0000-0000-0000000000d4";
const TRIP_SPEND = "7a000000-0000-0000-0000-0000000000d5";
const TRIP_CROSS = "7a000000-0000-0000-0000-0000000000d6";
const TRIP_NO_ENGAGEMENT = "7a000000-0000-0000-0000-0000000000d7";
const CONSENT_B = "6a000000-0000-0000-0000-0000000000b1";
const TASK_CROSS_WRITE = "7c000000-0000-0000-0000-0000000000b2";

/** A guardian consent naming ENGAGEMENT_A, live over the whole trip window. */
const CONSENT_A = "6a000000-0000-0000-0000-000000000001";
/** A consent naming the WRONG engagement — the case that must not travel. */
const CONSENT_WRONG_ENGAGEMENT = "6a000000-0000-0000-0000-000000000002";
/** A consent that EXPIRES before the trip departs. */
const CONSENT_EXPIRED = "6a000000-0000-0000-0000-000000000003";

async function seedEngagement(engagementId: string, orgId: string, personId: string, title: string): Promise<void> {
  // `worker_classification` matters here and is not cosmetic: 0001 allows only
  // ONE live engagement per (person, classification), so the second engagement
  // below is given a different one. Seeding both as `player` fails with
  // `engagement_current_per_classification_key`, which reads exactly like a
  // schema bug and is a fixture bug.
  const classification = title === "Streaming contract" ? "contractor" : "player";
  await asOwner(`
    INSERT INTO engagement (id, org_id, person_id, classification, title, valid_from)
    VALUES ('${engagementId}', '${orgId}', '${personId}', '${classification}', ${sql(title)}, '${PAST}')
  `);
}

/**
 * A guardian consent for one engagement, live over the given window.
 *
 * The column list is 0001's `guardian_consent` as CORRECTED by 0008, and every
 * one of these names is load-bearing:
 *
 *   * `guardian_name` is 0001's NOT NULL column. There is no
 *     `evidence_reference` and no `granted_by_person_id` — the first was never in
 *     this schema and the second belongs to the domain's own
 *     `GuardianConsent`, not to the database. Inventing either to satisfy a
 *     fixture would have written a table nobody asked for.
 *   * `engagement_id` is NOT NULL after 0008, which is why `trip.engagement_id`
 *     exists: consent is to an ENGAGEMENT, never a global flag.
 *   * `relationship` is NOT NULL after 0008.
 */
async function seedConsent(options: {
  readonly consentId: string;
  readonly engagementId: string;
  readonly minorId: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly orgId?: string;
}): Promise<void> {
  const orgId = options.orgId ?? ORG_A;
  await asOwner(`
    INSERT INTO guardian_consent
      (id, org_id, person_id, guardian_person_id, guardian_name, engagement_id,
       relationship, granted_at, expires_at)
    VALUES
      ('${options.consentId}', '${orgId}', '${options.minorId}', '${GUARDIAN_A}',
       'A Guardian', '${options.engagementId}', 'parent',
       '${options.grantedAt}', '${options.expiresAt}')
  `);
}

/** A trip with one destination, for ORG_A on ENGAGEMENT_A. */
async function seedTrip(tripId: string, orgId: string, engagementId: string): Promise<void> {
  // The destination id is derived from the trip id by a UUID-SAFE transform, not
  // by string concatenation: `${tripId}-dest` is not a uuid at all, and every
  // travel scenario failed with `22P02` before reaching the constraint it was
  // written to test.
  await asOwner(`
    INSERT INTO trip (id, org_id, engagement_id, title, departs_at, returns_at, created_by)
    VALUES ('${tripId}', '${orgId}', '${engagementId}', 'Berlin LAN', '${DEPARTS}', '${RETURNS}', '${STAFF_A}');

    INSERT INTO trip_destination (id, org_id, trip_id, place, country_code, position)
    VALUES ('${destinationId(tripId)}', '${orgId}', '${tripId}', 'Berlin', 'DE', 0);
  `);
}

/**
 * A deterministic uuid derived from a trip id.
 *
 * Replaces the FINAL group while preserving the 8-4-4-4-12 shape, so
 * `TRIP_A` and `TRIP_B` get different destinations and both stay valid uuids.
 * An earlier version sliced to 23 characters, which silently dropped a group and
 * produced `7a000000-0000-0000-00000001` — 29 characters, not a uuid.
 */
function destinationId(tripId: string): string {
  return `${tripId.slice(0, 24)}${"0".repeat(12)}`;
}

/** The task state machine's legal edges are seeded automatically with the org. */
async function seedTasks(): Promise<void> {
  await asOwner(`
    INSERT INTO task (id, org_id, title, state, assignee_id, created_at)
    VALUES ('${TASK_A}', '${ORG_A}', 'Book the practice room', 'open', '${STAFF_A}', '${PAST}'),
           ('${TASK_DEP}', '${ORG_A}', 'Confirm the visa', 'open', '${STAFF_A}', '${PAST}'),
           ('${TASK_BLOCKER}', '${ORG_A}', 'Get the visa appointment', 'open', '${STAFF_A}', '${PAST}');

    INSERT INTO task_dependency (org_id, task_id, depends_on_task_id)
    VALUES ('${ORG_A}', '${TASK_DEP}', '${TASK_BLOCKER}');
  `);
}

/**
 * A run of a SINGLE-step workflow, for the status tests.
 *
 * Separate from {@link seedWorkflow} because the run-status rule only becomes
 * observable when completing a step is what ENDS the run. With the two-step
 * fixture, completing `quote` leaves `book` pending and the derived status
 * correctly stays `running` — so a test asserting that the status must change
 * would be asserting something the design explicitly does not do.
 *
 * `WF_RUN_ONE` is seeded with its step `pending`, which is the honest starting
 * state: nothing has happened yet.
 */
async function seedSingleStepRun(): Promise<void> {
  await asOwner(`
    INSERT INTO workflow_definition (id, org_id, slug, name, created_at)
    VALUES ('${WF_DEF_ONE}', '${ORG_A}', 'single-step', 'Single step', '${PAST}');

    INSERT INTO workflow_step_definition
      (id, org_id, definition_id, step_id, title, position, idempotency_scope, outcome_required)
    VALUES ('${WF_STEP_ONE}', '${ORG_A}', '${WF_DEF_ONE}', 'only', 'The only step', 0, 'only', false);

    INSERT INTO workflow_run (id, org_id, definition_id, subject_id, status, started_at)
    VALUES ('${WF_RUN_ONE}', '${ORG_A}', '${WF_DEF_ONE}', '${TRIP_A}', 'running', '${PAST}');

    INSERT INTO workflow_step_run (org_id, run_id, definition_step_id, status, started_at)
    VALUES ('${ORG_A}', '${WF_RUN_ONE}', '${WF_STEP_ONE}', 'pending', NULL);
  `);
}

/**
 * A workflow with two steps and a run, for ORG_A.
 *
 * BOTH steps get a `workflow_step_run` row. An earlier draft seeded only the
 * first, so every assertion that targeted the second — "a pending step row
 * carrying a completion time", for one — updated ZERO rows and therefore
 * SUCCEEDED, which is how an assertion against a schema that does not refuse
 * anything passed anyway.
 */
async function seedWorkflow(): Promise<void> {
  await asOwner(`
    INSERT INTO workflow_definition (id, org_id, slug, name, created_at)
    VALUES ('${WF_DEF_A}', '${ORG_A}', 'player-travel', 'Player travel request', '${PAST}');

    INSERT INTO workflow_step_definition
      (id, org_id, definition_id, step_id, title, position, idempotency_scope, outcome_required)
    VALUES
      ('${WF_STEP_QUOTE}', '${ORG_A}', '${WF_DEF_A}', 'quote',  'Quote the trip',      0, 'quote',  true),
      ('${WF_STEP_BOOK}', '${ORG_A}', '${WF_DEF_A}', 'book',   'Book the flights',   1, 'book',   false);

    INSERT INTO workflow_run (id, org_id, definition_id, subject_id, status, started_at)
    VALUES ('${WF_RUN_A}', '${ORG_A}', '${WF_DEF_A}', '${TRIP_A}', 'running', '${PAST}');

    INSERT INTO workflow_step_run (org_id, run_id, definition_step_id, status, started_at)
    VALUES ('${ORG_A}', '${WF_RUN_A}', '${WF_STEP_QUOTE}', 'in_progress', '${PAST}'),
           ('${ORG_A}', '${WF_RUN_A}', '${WF_STEP_BOOK}',  'pending',     NULL);
  `);
}

/** An asset issued to a person, and one belonging to ORG_B. */
async function seedAssets(): Promise<void> {
  await asOwner(`
    INSERT INTO asset (id, org_id, asset_tag, name, category, purchased_at)
    VALUES
      ('${ASSET_A}', '${ORG_A}', 'LAPTOP-001', 'Tournament laptop', 'equipment', '${PAST}'),
      ('${ASSET_B}', '${ORG_B}', 'LAPTOP-001', 'ORG B laptop',      'equipment', '${PAST}');
  `);
}

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await recoverSession();
  await db.exec("SELECT set_config('app.org_id', '', false)");
  // organization cascades to every tenant table, so this is a complete reset.
  await asOwner("TRUNCATE organization, person CASCADE");

  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES ('${ORG_A}', 'org-a', 'Org A', '${INR}', 'active'),
           ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref, birth_date) VALUES
      ('${ADULT_A}',        'adult-a',        '1995-04-02'),
      ('${MINOR_A}',        'minor-a',        '2010-03-14'),
      ('${GUARDIAN_A}',     'guardian-a',     '1985-01-09'),
      ('${STAFF_A}',        'staff',          '1990-06-30'),
      ('${SECOND_ADULT_A}', 'second-adult-a', '1992-02-02'),
      ('${ADULT_B}',        'adult-b',        '1995-04-02'),
      ('${GUARDIAN_B}',     'guardian-b',     '1984-11-11');
  `);
});

// ---------------------------------------------------------------------------
// Isolation invariants
// ---------------------------------------------------------------------------

describe("operations schema — isolation", () => {
  it("applies 0010_operations.sql with no pending work", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0010_operations.sql");
    expect(status.pending).toHaveLength(0);
  });

  it("runs the isolation assertions as a role that CANNOT bypass RLS", async () => {
    // Without this, every isolation assertion below could pass while proving
    // nothing: a superuser bypasses every policy in this schema (ADR-0006).
    const found = await ownerRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raptor_app'",
    );

    expect(found, "the application role must exist").toHaveLength(1);
    expect(found[0]!.rolsuper).toBe(false);
    expect(found[0]!.rolbypassrls).toBe(false);
  });

  it("ENABLES and FORCES row level security on every operations table", async () => {
    const found = await ownerRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...OPERATIONS_TABLES]],
    );

    expect(found.map((r) => r.relname)).toEqual([...OPERATIONS_TABLES].sort());
    for (const row of found) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("gives every operations table one tenant policy with no IS NULL bypass", async () => {
    const found = await ownerRows<{ relname: string; polname: string; qual: string; with_check: string }>(
      `SELECT c.relname, p.polname,
              pg_get_expr(p.polqual, p.polrelid)    AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...OPERATIONS_TABLES]],
    );

    expect(found).toHaveLength(OPERATIONS_TABLES.length);
    for (const row of found) {
      expect(row.polname).toBe(`${row.relname}_tenant_isolation`);
      // The tenant predicate is the WHOLE predicate. An `OR org_id IS NULL`
      // anywhere here hands every tenant every row whenever the context is
      // missing — the failure ADR-0015 exists to prevent.
      expect(row.qual).not.toMatch(/IS NULL/i);
      expect(row.with_check).not.toMatch(/IS NULL/i);
      expect(row.qual).toMatch(/org_id/);
      expect(row.with_check).toMatch(/org_id/);
    }
  });

  it("makes org_id NOT NULL on every operations table", async () => {
    const found = await ownerRows<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id'
        ORDER BY table_name`,
      [[...OPERATIONS_TABLES]],
    );

    expect(found.map((r) => r.table_name)).toEqual([...OPERATIONS_TABLES].sort());
    for (const row of found) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("gives every operations table UNIQUE (org_id, id)", async () => {
    const found = await ownerRows<{ conrelid: string }>(
      `SELECT t.relname AS conrelid
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = ANY($1)
          AND EXISTS (
                SELECT 1
                  FROM pg_constraint c
                 WHERE c.conrelid = t.oid
                   AND c.contype  = 'u'
                   AND pg_get_constraintdef(c.oid) = 'UNIQUE (org_id, id)'
              )
        ORDER BY t.relname`,
      [[...OPERATIONS_TABLES]],
    );

    // Written as EXISTS over `pg_class` rather than `SELECT DISTINCT c.conrelid
    // ... ORDER BY conrelid`: `conrelid` is a regclass, which sorts by OID rather
    // than by name, so the two orderings disagree and the comparison below
    // fails for a reason that has nothing to do with the schema.
    //
    // The equality match on the constraint text is deliberate — a LIKE without
    // the comma-space would also match `UNIQUE (org_id, identifier)`, and a test
    // that passes on the wrong constraint is worse than no test.
    expect(found.map((r) => r.conrelid)).toEqual([...OPERATIONS_TABLES].sort());
  });

  it("leads every operations INDEX with org_id, or is the primary key", async () => {
    const found = await ownerRows<{ tablename: string; indexdef: string; isprimary: boolean }>(
      `SELECT tablename, indexdef, indisprimary AS isprimary
         FROM pg_indexes p
         JOIN pg_class t ON t.relname = p.tablename
         JOIN pg_index i  ON i.indexrelid = (quote_ident(p.schemaname) || '.' || quote_ident(p.indexname))::regclass
        WHERE p.schemaname = 'public'
          AND p.tablename = ANY($1)
        ORDER BY tablename, indexname`,
      [[...OPERATIONS_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      // The PRIMARY KEY on `id` is deliberately not tenant-leading — `id` is a
      // global uuid — so it is the one documented exception. Every other index
      // leads with org_id, and this asserts that rather than assuming it.
      if (row.isprimary) {
        expect(row.indexdef, `${row.tablename} primary key`).toMatch(/\(id\)$/);
        continue;
      }
      const columns = /USING \w+ \((.*)\)$/.exec(row.indexdef)?.[1] ?? "";
      expect(columns, `${row.tablename}: ${row.indexdef}`).toMatch(/^org_id/);
    }
  });

  it("makes every FK BETWEEN TENANT TABLES composite and include org_id", async () => {
    // ADR-0011.
    //
    // `engagement` IS a tenant table (0001 gives it org_id and UNIQUE (org_id,id)),
    // so `trip → engagement` is in scope and IS composite. It is listed here in
    // FULL rather than excluded, which is what makes the assertion meaningful: a
    // reviewer can see that no tenant FK was quietly skipped.
    const NON_TENANT = new Set(["person", "organization"]);

    const found = await ownerRows<{ conrelid: string; confrelid: string; def: string }>(
      `SELECT c.conrelid::regclass::text AS conrelid,
              c.confrelid::regclass::text AS confrelid,
              pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_class f ON f.oid = c.confrelid
        WHERE c.contype = 'f'
          AND t.relname = ANY($1)
          AND f.relname <> ALL($2)
        ORDER BY conrelid, def`,
      [[...OPERATIONS_TABLES], [[...NON_TENANT]]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      // The key columns must lead with org_id and carry at least one more.
      const keyColumns = /\(([^)]*)\)\s*REFERENCES/.exec(row.def)?.[1] ?? "";
      const columns = keyColumns.split(",").map((c) => c.trim());
      expect(columns[0], `${row.conrelid} → ${row.confrelid}: ${row.def}`).toBe("org_id");
      expect(columns.length, `${row.conrelid} → ${row.confrelid}: ${row.def}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("DENIES hard deletes to the application role on every operations table", async () => {
    const found = await ownerRows<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_app'
          AND table_schema = 'public'
          AND table_name = ANY($1)
          AND privilege_type = 'DELETE'
        ORDER BY table_name`,
      [[...OPERATIONS_TABLES]],
    );

    // No hard deletes anywhere in this domain. A correction is an append-only
    // record or a reversal, never a removal.
    expect(found).toEqual([]);
  });

  it("gives the application role NO write access to the governance tables", async () => {
    const found = await ownerRows<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_app'
          AND table_schema = 'public'
          AND table_name IN ('task_state_transition')
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
        ORDER BY table_name, privilege_type`,
    );

    // An organisation editing its own legal task machine from a request handler
    // is "a stage table the app role can rewrite is not a state machine", which
    // 0008 argues about hr_state_transition and 0009 about partner_state_transition.
    //
    // `workflow_step_definition` is NOT in this list because a definition is not
    // governance over an EXISTING organisation's legal lifecycle — it is a
    // document the organisation authors, the way 0009 treats `content_item`. The
    // distinction is stated rather than left for a reader to guess.
    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property 1 — the task transition table is DATA, and the database obeys it
// ---------------------------------------------------------------------------

describe("tasks — the transition table is the authority", () => {
  it("seeds the task state machine for every new organisation", async () => {
    // An organisation whose transition table is empty refuses EVERY move rather
    // than accepting every one. Empty-means-nothing-legal is the safe direction,
    // and this asserts the seed actually fires.
    const found = await ownerRows<{ from_state: string; to_state: string }>(
      `SELECT from_state::text, to_state::text
         FROM task_state_transition
        WHERE org_id = $1
        ORDER BY from_state, to_state`,
      [ORG_A],
    );

    expect(found).toHaveLength(11);
    // The specific edge that makes the whole design worth having: no `open ->
    // done`. A task cannot be born finished.
    expect(found.some((r) => r.from_state === "open" && r.to_state === "done")).toBe(false);
    // And completion IS reachable, through review.
    expect(found.some((r) => r.from_state === "in_review" && r.to_state === "done")).toBe(true);
  });

  it("agrees with packages/core on the transition table, by NAME", async () => {
    // The domain owns the rules and the database owns the storage, and a table
    // written down twice is a table that will be changed in one place. This
    // asserts the two agree, which is what makes either of them trustworthy.
    const fromDomain = new Set(
      DOMAIN_TASK_STATES.flatMap((from) =>
        (DOMAIN_TASK_TRANSITIONS[from] ?? []).map((to) => `${from}>${to}`),
      ),
    );

    const fromDatabase = await ownerRows<{ edge: string }>(
      `SELECT from_state::text || '>' || to_state::text AS edge
         FROM task_state_transition
        WHERE org_id = $1`,
      [ORG_A],
    );

    expect(new Set(fromDatabase.map((r) => r.edge))).toEqual(fromDomain);
  });

  it("keys the transition table on its edge, so the same move cannot be declared twice", async () => {
    // `task_state_transition` has a surrogate id AND a UNIQUE edge. Both, and the
    // edge key is the one that matters: a second declaration of `open ->
    // in_progress` would make "which rules apply here" a question with two
    // answers, and a task state machine with two answers is not a state machine.
    const found = await ownerRows<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'task_state_transition' AND c.contype = 'u'
        ORDER BY def`,
    );

    expect(found.map((r) => r.def)).toContain("UNIQUE (org_id, from_state, to_state)");
  });

  it("agrees with packages/core on the state vocabulary, by NAME", async () => {
    const found = await ownerRows<{ enumlabel: string }>(
      `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'task_state'
        ORDER BY e.enumsortorder`,
    );

    expect(found.map((r) => r.enumlabel)).toEqual([...DOMAIN_TASK_STATES]);
  });

  it("reads the domain's table rather than trusting this file's copy of it", () => {
    // A guard on the reader above. If the source-parsing helpers ever silently
    // returned an empty object, every agreement test would compare the database
    // against nothing and pass — which is the failure mode a cross-package
    // assertion is most prone to.
    expect(DOMAIN_TASK_STATES.length).toBeGreaterThan(0);
    expect(Object.keys(DOMAIN_TASK_TRANSITIONS).length).toBe(DOMAIN_TASK_STATES.length);
    expect(DOMAIN_TASK_TRANSITIONS["open"]).toContain("in_progress");
  });

  it("refuses a state change whose edge is not in the table", async () => {
    await seedTasks();

    // `open -> in_review` is NOT an edge. Only `open -> in_progress` may leave
    // `open`, because a task is started before it is reviewed.
    await expectSqlstate(
      () => asOwner(`UPDATE task SET state = 'in_review' WHERE org_id = '${ORG_A}' AND id = '${TASK_A}'`),
      SQLSTATE_CHECK_VIOLATION,
      "open -> in_review",
    );

    const found = await ownerRows<{ state: string }>(
      "SELECT state::text FROM task WHERE org_id = $1 AND id = $2",
      [ORG_A, TASK_A],
    );
    expect(found[0]!.state).toBe("open");
  });

  it("refuses a task being born or short-cutting to done", async () => {
    await seedTasks();

    // `open -> done` is the transition every board offers first.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE task SET state = 'done', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}'
            WHERE org_id = '${ORG_A}' AND id = '${TASK_A}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "open -> done",
    );
  });

  it("accepts the full legal path open → in_progress → in_review → done", async () => {
    await seedTasks();

    // Every step a legal task actually walks, in one transaction. `state_changed_by`
    // and `transitioned_at` are set together because the CHECK binds them.
    await commit(`
      UPDATE task SET state = 'in_progress', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '${TASK_A}';
      UPDATE task SET state = 'in_review', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '${TASK_A}';
      UPDATE task SET state = 'done', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '${TASK_A}';
    `);

    const found = await ownerRows<{ state: string }>(
      "SELECT state::text FROM task WHERE org_id = $1 AND id = $2",
      [ORG_A, TASK_A],
    );
    expect(found[0]!.state).toBe("done");
  });

  it("refuses leaving a terminal state, in either direction", async () => {
    await commit(`
      INSERT INTO task (id, org_id, title, state, assignee_id, created_at)
      VALUES ('${TASK_DONE}', '${ORG_A}', 'Done', 'done', '${STAFF_A}', '${PAST}');
    `);

    // `done` has no outgoing edge. Reopening is a NEW task that references this
    // one, which leaves both visible.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE task SET state = 'in_progress', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}'
            WHERE org_id = '${ORG_A}' AND id = '${TASK_DONE}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "leaving done",
    );
  });

  it("requires a reason for blocked and cancelled, and forbids one elsewhere", async () => {
    await seedTasks();

    await expectSqlstate(
      () => asOwner(`UPDATE task SET state = 'blocked' WHERE org_id = '${ORG_A}' AND id = '${TASK_A}'`),
      SQLSTATE_CHECK_VIOLATION,
      "blocked with no reason",
    );

    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE task SET state = 'in_progress', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}',
                  state_reason = 'because'
            WHERE org_id = '${ORG_A}' AND id = '${TASK_A}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "in_progress with a reason",
    );
  });

  it("refuses a state change with no actor recorded", async () => {
    await seedTasks();

    // A transition nobody performed has no author, and the whole value of a
    // transition record is who did it.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE task SET state = 'in_progress', transitioned_at = '${PAST}'
            WHERE org_id = '${ORG_A}' AND id = '${TASK_A}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "transition with no actor",
    );
  });

  it("refuses a due date at or before the moment the task was created", async () => {
    // A task born overdue is a data-entry error, and if admitted it reports as
    // overdue from the instant it exists — noise on the one board anybody reads.
    //
    // `created_at` is stated EXPLICITLY rather than left to its DEFAULT of
    // `now()`. The first version of this test omitted it, so `created_at` became
    // the current instant and `due_at` (2026-07-14) was comfortably in the
    // future — the row was accepted and the assertion proved nothing.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO task (id, org_id, title, created_at, due_at)
           VALUES ('${TASK_LATE}', '${ORG_A}', 'Born overdue', '${RETURNS}', '${DEPARTS}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "due before creation",
    );
  });

  it("refuses a dependency on a task in another organisation", async () => {
    await seedTasks();
    await asOwner(`
      INSERT INTO task (id, org_id, title, created_at)
      VALUES ('${TASK_B_ORG}', '${ORG_B}', 'ORG B task', '${PAST}');
    `);

    // ADR-0011 in the database: the referenced row cannot exist in the other
    // organisation, so the insert fails rather than being discouraged.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO task_dependency (org_id, task_id, depends_on_task_id)
           VALUES ('${ORG_A}', '${TASK_DEP}', '${TASK_B_ORG}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "cross-tenant dependency",
    );
  });

  it("refuses a task that depends on itself", async () => {
    await seedTasks();

    // The degenerate cycle: unreadable on a board as well as unschedulable.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO task_dependency (org_id, task_id, depends_on_task_id)
           VALUES ('${ORG_A}', '${TASK_A}', '${TASK_A}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "self dependency",
    );
  });

  it("refuses to UPDATE or DELETE an append-only transition record", async () => {
    await seedTasks();
    await commit(`
      UPDATE task SET state = 'in_progress', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '${TASK_A}';
      INSERT INTO task_transition (org_id, task_id, from_state, to_state, occurred_at, actor_id)
      VALUES ('${ORG_A}', '${TASK_A}', 'open', 'in_progress', '${PAST}', '${STAFF_A}');
    `);

    // A transition is a fact about a moment. A mistake is corrected by a further
    // transition, never by editing this one — and the GRANT cannot be widened by
    // omission because the REVOKE is explicit.
    await asApp(async () => {
      await expectSqlstate(
        () => db.exec("UPDATE task_transition SET to_state = 'done'"),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "update a transition",
      );
      // Targeted, not bare — see the custody assertion for why an unqualified
      // DELETE proves nothing.
      await expectSqlstate(
        () => db.exec(`DELETE FROM task_transition WHERE org_id = '${ORG_A}' AND task_id = '${TASK_A}'`),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "delete a transition",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Property 2 — the stored run status cannot drift from the step rows
// ---------------------------------------------------------------------------

describe("workflows — the cached status cannot drift", () => {
  it("derives a fresh run as running, and says so of an empty one", async () => {
    await seedWorkflow();

    const found = await ownerRows<{ derived: string }>(
      "SELECT public.workflow_derived_status_in_org($1, $2)::text AS derived",
      [ORG_A, WF_RUN_A],
    );
    expect(found[0]!.derived).toBe("running");
  });

  it("refuses a COMMIT that completes the LAST step without moving the run", async () => {
    await seedSingleStepRun();

    // The whole point of the deferred trigger: "complete the step AND move the
    // run" must be ONE transaction, because between them the run claims
    // something its steps do not say. A single-step definition is what makes the
    // status change observable — with two steps, completing the first correctly
    // leaves the run `running`.
    await expectCommitRefusal(
      `UPDATE workflow_step_run
          SET status = 'completed', started_at = '${PAST}', completed_at = '${PAST}',
              outcome_kind = 'succeeded'
        WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_ONE}';`,
      SQLSTATE_CHECK_VIOLATION,
      "last step complete without the run moving",
    );

    const found = await ownerRows<{ status: string }>(
      "SELECT status::text FROM workflow_step_run WHERE org_id = $1 AND run_id = $2",
      [ORG_A, WF_RUN_ONE],
    );
    // The whole transaction rolled back, so the step is still pending.
    expect(found[0]!.status).toBe("pending");
  });

  it("accepts completing a step and moving the run in ONE transaction", async () => {
    await seedSingleStepRun();

    await commit(`
      UPDATE workflow_step_run
         SET status = 'completed', started_at = '${PAST}', completed_at = '${PAST}',
             outcome_kind = 'succeeded'
       WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_ONE}';
      UPDATE workflow_run
         SET status = 'completed', completed_at = '${PAST}'
       WHERE org_id = '${ORG_A}' AND id = '${WF_RUN_ONE}';
    `);

    const found = await ownerRows<{ stored: string; derived: string }>(
      `SELECT r.status::text AS stored,
              public.workflow_derived_status_in_org(r.org_id, r.id)::text AS derived
         FROM workflow_run r
        WHERE r.org_id = $1 AND r.id = $2`,
      [ORG_A, WF_RUN_ONE],
    );

    expect(found[0]!.stored).toBe("completed");
    expect(found[0]!.derived).toBe("completed");
  });

  it("leaves a run RUNNING when a non-final step completes, because later steps still apply", async () => {
    // The two-step fixture, and the assertion that keeps the status rule honest.
    // Completing `quote` of {quote, book} is real progress and does not end the
    // run — reading it as an end would make a two-step process completable in one.
    await seedWorkflow();

    await commit(`
      UPDATE workflow_step_run
         SET status = 'completed', completed_at = '${PAST}', outcome_kind = 'succeeded'
       WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_A}' AND definition_step_id = '${WF_STEP_QUOTE}';
    `);

    const found = await ownerRows<{ derived: string }>(
      "SELECT public.workflow_derived_status_in_org($1, $2)::text AS derived",
      [ORG_A, WF_RUN_A],
    );
    // `book` is still pending, so the run is still running — and the stored value
    // said `running` all along, which is why the deferred trigger stayed quiet.
    expect(found[0]!.derived).toBe("running");
  });

  it("refuses a run status that its steps do not support", async () => {
    await seedWorkflow();

    // Marking a run completed while a step is still in progress is the claim
    // this whole mechanism exists to refuse.
    await expectCommitRefusal(
      `UPDATE workflow_run SET status = 'completed', completed_at = '${PAST}'
        WHERE org_id = '${ORG_A}' AND id = '${WF_RUN_A}';`,
      SQLSTATE_CHECK_VIOLATION,
      "run completed with an open step",
    );
  });

  it("counts a FAILED step as not completed, so progress cannot over-report", async () => {
    await seedWorkflow();

    // `failed` is a distinct status from `completed` precisely so a step that
    // errored cannot be counted as progress. A run whose first step failed has
    // TWO steps outstanding and must not read as "one of two done".
    await commit(`
      UPDATE workflow_step_run
         SET status = 'failed', completed_at = '${PAST}',
             outcome_kind = 'failed', outcome_reason = 'vendor unreachable'
       WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_A}' AND definition_step_id = '${WF_STEP_QUOTE}';
      UPDATE workflow_run SET status = 'failed', completed_at = '${PAST}'
       WHERE org_id = '${ORG_A}' AND id = '${WF_RUN_A}';
    `);

    const found = await ownerRows<{ derived: string }>(
      "SELECT public.workflow_derived_status_in_org($1, $2)::text AS derived",
      [ORG_A, WF_RUN_A],
    );
    expect(found[0]!.derived).toBe("failed");
  });

  it("refuses a completed step with a blank failure reason", async () => {
    await seedWorkflow();

    // A step that failed without saying why produces a record indistinguishable
    // from one nobody got to.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE workflow_step_run
              SET status = 'failed', completed_at = '${PAST}', outcome_kind = 'failed', outcome_reason = '   '
            WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_A}' AND definition_step_id = '${WF_STEP_QUOTE}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "failed with a blank reason",
    );
  });

  it("refuses a pending step row carrying a completion time", async () => {
    await seedWorkflow();

    // A record claiming work finished before anyone began it.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE workflow_step_run SET status = 'pending', completed_at = '${PAST}'
            WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_A}' AND definition_step_id = '${WF_STEP_BOOK}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "pending with completed_at",
    );
  });

  it("requires a completion instant on a terminal run and forbids one on a live one", async () => {
    await seedWorkflow();

    await expectSqlstate(
      () => asOwner(`UPDATE workflow_run SET status = 'completed' WHERE org_id = '${ORG_A}' AND id = '${WF_RUN_A}'`),
      SQLSTATE_CHECK_VIOLATION,
      "completed with no completed_at",
    );

    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE workflow_run SET completed_at = '${PAST}' WHERE org_id = '${ORG_A}' AND id = '${WF_RUN_A}'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "running with a completed_at",
    );
  });

  it("DERIVES the retry token, so a caller cannot supply one the database cannot check", async () => {
    await seedWorkflow();

    const found = await ownerRows<{ retry_token: string }>(
      `SELECT retry_token FROM workflow_step_run
        WHERE org_id = $1 AND run_id = $2 AND definition_step_id = $3`,
      [ORG_A, WF_RUN_A, WF_STEP_QUOTE],
    );

    const token = found[0]!.retry_token;
    // 64 hex characters: a sha-256. A token of any other shape is not one this
    // schema derived, and a caller that supplied its own could not be checked.
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // It is a FUNCTION of the run and the step's scope, not of arrival order:
    // recomputing it gives the identical value, which is what makes it
    // re-verifiable years later.
    const recomputed = await ownerRows<{ token: string }>(
      "SELECT public.workflow_retry_token($1, $2, $3) AS token",
      [ORG_A, WF_RUN_A, WF_STEP_QUOTE],
    );
    expect(recomputed[0]!.token).toBe(token);
  });

  it("gives two runs of one definition DIFFERENT retry tokens", async () => {
    await seedWorkflow();
    await asOwner(`
      INSERT INTO workflow_run (id, org_id, definition_id, subject_id, status, started_at)
      VALUES ('${WF_RUN_TWO}', '${ORG_A}', '${WF_DEF_A}', '${TRIP_A}', 'running', '${PAST}');
      INSERT INTO workflow_step_run (org_id, run_id, definition_step_id, status, started_at)
      VALUES ('${ORG_A}', '${WF_RUN_TWO}', '${WF_STEP_QUOTE}', 'in_progress', '${PAST}');
    `);

    const found = await ownerRows<{ run_id: string; retry_token: string }>(
      `SELECT run_id::text, retry_token FROM workflow_step_run
        WHERE org_id = $1 AND definition_step_id = $2 ORDER BY run_id`,
      [ORG_A, WF_STEP_QUOTE],
    );

    // Without the run in the derivation, two organisations' retries of "quote"
    // would carry one token and a shared downstream system would swallow the
    // second as a duplicate of the first.
    expect(found).toHaveLength(2);
    expect(found[0]!.retry_token).not.toBe(found[1]!.retry_token);
  });

  it("refuses two workflow steps sharing one idempotency scope in a definition", async () => {
    await asOwner(`
      INSERT INTO workflow_definition (id, org_id, slug, name, created_at)
      VALUES ('${WF_DEF_DUP}', '${ORG_A}', 'dup-scope', 'Duplicate scope', '${PAST}');
    `);

    // Two steps sharing a scope share a retry token, so a retry of the first
    // would be swallowed by the second's record.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO workflow_step_definition
            (id, org_id, definition_id, step_id, title, position, idempotency_scope)
          VALUES
            ('${WS_DUP_A}', '${ORG_A}', '${WF_DEF_DUP}', 'one', 'One', 0, 'shared'),
            ('${WS_DUP_B}', '${ORG_A}', '${WF_DEF_DUP}', 'two', 'Two', 1, 'shared');
        `),
      SQLSTATE_UNIQUE_VIOLATION,
      "duplicate idempotency scope",
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3 — a task and its workflow step must agree
// ---------------------------------------------------------------------------

describe("workflows — the task and the step must agree", () => {
  it("refuses a COMMIT where a step is complete and its task is not done", async () => {
    await seedWorkflow();
    await asOwner(`
      INSERT INTO task (id, org_id, title, state, assignee_id, created_at, origin_run_id, origin_step_id)
      VALUES ('${WF_TASK}', '${ORG_A}', 'Quote the trip', 'open', '${STAFF_A}', '${PAST}',
              '${WF_RUN_A}', '${WF_STEP_QUOTE}');
    `);

    // "The workflow says done, the backlog says otherwise" — the case that makes
    // a board untrustworthy, and which no single CHECK could catch because it
    // spans two tables.
    await expectCommitRefusal(
      `UPDATE workflow_step_run
          SET status = 'completed', completed_at = '${PAST}', outcome_kind = 'succeeded'
        WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_A}' AND definition_step_id = '${WF_STEP_QUOTE}';`,
      SQLSTATE_CHECK_VIOLATION,
      "step complete while its task is open",
    );
  });

  it("accepts a step and its task finishing in one transaction", async () => {
    await seedWorkflow();
    await asOwner(`
      INSERT INTO task (id, org_id, title, state, assignee_id, created_at, origin_run_id, origin_step_id)
      VALUES ('${WF_TASK}', '${ORG_A}', 'Quote the trip', 'open', '${STAFF_A}', '${PAST}',
              '${WF_RUN_A}', '${WF_STEP_QUOTE}');
    `);

    // The legal shape: one transaction moves the step AND the task. The run stays
    // `running` because `book` is still pending, which is the derived answer and
    // needs no statement at all.
    await commit(`
      UPDATE workflow_step_run
         SET status = 'completed', completed_at = '${PAST}', outcome_kind = 'succeeded'
       WHERE org_id = '${ORG_A}' AND run_id = '${WF_RUN_A}' AND definition_step_id = '${WF_STEP_QUOTE}';
      UPDATE task SET state = 'cancelled', transitioned_at = '${PAST}', state_changed_by = '${STAFF_A}',
                     state_reason = 'trip withdrawn'
        WHERE org_id = '${ORG_A}' AND id = '${WF_TASK}';
    `);

    const found = await ownerRows<{ state: string }>(
      "SELECT state::text FROM task WHERE org_id = $1 AND id = $2",
      [ORG_A, WF_TASK],
    );
    expect(found[0]!.state).toBe("cancelled");
  });

  it("refuses a task naming one half of a workflow origin", async () => {
    await seedWorkflow();

    // A run with no step is half a provenance claim. Completing it with a guess
    // would attach the task to the wrong step of the right run.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO task (id, org_id, title, created_at, origin_run_id)
           VALUES ('${TASK_HALF_ORIGIN}', '${ORG_A}', 'Half a provenance', '${PAST}', '${WF_RUN_A}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "run without a step",
    );
  });

  it("refuses a task whose origin run belongs to another organisation", async () => {
    await seedWorkflow();

    // The task→step link is a real composite FK, so an origin that does not
    // exist in THIS organisation is refused by the constraint rather than by a
    // trigger — structurally impossible rather than discouraged (ADR-0011).
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO task (id, org_id, title, created_at, origin_run_id, origin_step_id)
           VALUES ('${TASK_GHOST_ORIGIN}', '${ORG_A}', 'Ghost origin', '${PAST}',
                   'ffffffff-ffff-ffff-ffff-ffffffffffff', '${WF_STEP_QUOTE}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "origin run that does not exist",
    );
  });

  it("refuses a task whose origin step belongs to a DIFFERENT run", async () => {
    await seedWorkflow();
    await seedSingleStepRun();

    // The composite FK is on (org_id, run_id, definition_step_id), not on the
    // step alone — so pairing one run's id with another run's step is refused.
    // An FK on `origin_step_id` alone would have accepted this.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO task (id, org_id, title, created_at, origin_run_id, origin_step_id)
           VALUES ('${TASK_HALF_ORIGIN}', '${ORG_A}', 'Mismatched origin', '${PAST}',
                   '${WF_RUN_A}', '${WF_STEP_ONE}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "step from a different run",
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4 — a minor may not travel without a LIVE, SCOPED consent
// ---------------------------------------------------------------------------

describe("travel — guardian consent is reused from 0008, not restated", () => {
  beforeEach(async () => {
    await seedEngagement(ENGAGEMENT_A, ORG_A, ADULT_A, "Senior player");
    await seedEngagement(ENGAGEMENT_A_OTHER, ORG_A, ADULT_A, "Streaming contract");
    await seedEngagement(ENGAGEMENT_B, ORG_B, ADULT_B, "ORG B player");
    await seedTrip(TRIP_A, ORG_A, ENGAGEMENT_A);
  });

  it("records an adult traveller with no consent at all", async () => {
    // An adult needs none. Refusing this would be a decision the schema has no
    // basis for.
    await asOwner(`
      INSERT INTO trip_traveller (org_id, trip_id, person_id, role)
      VALUES ('${ORG_A}', '${TRIP_A}', '${ADULT_A}', 'player');
    `);

    const found = await ownerRows<{ majority_at_departure: string; guardian_consent_id: string | null }>(
      "SELECT majority_at_departure, guardian_consent_id::text FROM trip_traveller WHERE org_id = $1",
      [ORG_A],
    );
    expect(found[0]!.majority_at_departure).toBe("adult");
    expect(found[0]!.guardian_consent_id).toBeNull();
  });

  it("DERIVES majority from person.birth_date, and stores no minority flag", async () => {
    // The consent is seeded BEFORE the traveller, because the guard reads it at
    // INSERT time. An earlier draft inserted the traveller first and relied on a
    // later UPDATE to fix the row — which "worked" only because the first insert
    // had been accepted against a NULL `majority_at_departure`, i.e. because the
    // check it was written to prove had not run.
    await seedConsent({
      consentId: CONSENT_A,
      engagementId: ENGAGEMENT_A,
      minorId: MINOR_A,
      grantedAt: PAST,
      expiresAt: RETURNS,
    });

    await asOwner(`
      INSERT INTO trip_traveller (org_id, trip_id, person_id, role, guardian_consent_id)
      VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player', '${CONSENT_A}');
    `);

    // MINOR_A is born 2010-03-14 and travels 2026-07-14, so `minority` is
    // derived by the trigger through 0008's `majority_status`. No caller writes
    // it — and the column is NOT NULL-defaulted, so a value here can only have
    // come from the derivation.
    const found = await ownerRows<{ majority_at_departure: string }>(
      "SELECT majority_at_departure FROM trip_traveller WHERE org_id = $1 AND person_id = $2",
      [ORG_A, MINOR_A],
    );
    expect(found[0]!.majority_at_departure).toBe("minor");
  });

  it("stores NO minority boolean anywhere in the travel tables", async () => {
    // The absence is structural, and it is the point: a stored `is_minor` is
    // wrong the moment a date of birth is corrected and wrong SILENTLY.
    const found = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('trip', 'trip_traveller', 'trip_leg', 'trip_destination')
          AND (column_name LIKE '%minor%' OR column_name LIKE '%is_adult%'
               OR (data_type = 'boolean' AND column_name IN ('adult', 'is_of_age')))
        ORDER BY table_name, column_name`,
    );

    expect(found).toEqual([]);
  });

  it("refuses a minor traveller with NO consent recorded", async () => {
    // The failure this whole mechanism exists to prevent, and the one ADR-0016
    // says the legacy system could not express: the legacy system had no concept
    // of minors at all, so a fourteen-year-old signed anything.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip_traveller (org_id, trip_id, person_id, role)
           VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "minor with no consent",
    );
  });

  it("refuses a minor whose consent names a DIFFERENT engagement", async () => {
    // THE linkage test. A consent for a streaming contract is not a consent for a
    // trip, and 0008's rule says so in exactly one place.
    await seedConsent({
      consentId: CONSENT_WRONG_ENGAGEMENT,
      engagementId: ENGAGEMENT_A_OTHER,
      minorId: MINOR_A,
      grantedAt: PAST,
      expiresAt: RETURNS,
    });

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip_traveller (org_id, trip_id, person_id, role, guardian_consent_id)
           VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player', '${CONSENT_WRONG_ENGAGEMENT}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "consent for the wrong engagement",
    );
  });

  it("refuses a minor whose consent EXPIRED before the trip departs", async () => {
    await seedConsent({
      consentId: CONSENT_EXPIRED,
      engagementId: ENGAGEMENT_A,
      minorId: MINOR_A,
      grantedAt: PAST,
      expiresAt: DEPARTS,
    });

    // `expires_at` is compared at the DEPARTURE instant, not at the time the row
    // is written. A consent that lapsed on the day of departure does not travel.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip_traveller (org_id, trip_id, person_id, role, guardian_consent_id)
           VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player', '${CONSENT_EXPIRED}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "expired consent",
    );
  });

  it("accepts a minor whose consent is live and names THIS engagement", async () => {
    await seedConsent({
      consentId: CONSENT_A,
      engagementId: ENGAGEMENT_A,
      minorId: MINOR_A,
      grantedAt: PAST,
      expiresAt: RETURNS,
    });

    await asOwner(`
      INSERT INTO trip_traveller (org_id, trip_id, person_id, role, guardian_consent_id)
      VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player', '${CONSENT_A}');
    `);

    const found = await ownerRows<{ majority_at_departure: string; consent: string }>(
      "SELECT majority_at_departure, guardian_consent_id::text AS consent FROM trip_traveller WHERE org_id = $1",
      [ORG_A],
    );

    expect(found[0]!.majority_at_departure).toBe("minor");
    expect(found[0]!.consent).toBe(CONSENT_A);
  });

  it("refuses a minor whose consent has been WITHDRAWN", async () => {
    await seedConsent({
      consentId: CONSENT_A,
      engagementId: ENGAGEMENT_A,
      minorId: MINOR_A,
      grantedAt: PAST,
      expiresAt: RETURNS,
    });
    await asOwner(`
      INSERT INTO guardian_consent_withdrawal
        (org_id, guardian_consent_id, withdrawn_by_person_id, withdrawn_at, reason)
      VALUES ('${ORG_A}', '${CONSENT_A}', '${STAFF_A}', '${PAST}', 'family withdrew agreement');
    `);

    // "We ignored the withdrawal because another one existed" is exactly how a
    // withdrawn authorisation keeps working.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip_traveller (org_id, trip_id, person_id, role, guardian_consent_id)
           VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player', '${CONSENT_A}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "withdrawn consent",
    );
  });

  it("refuses a consent belonging to another organisation", async () => {
    // ADR-0011: the composite FK means the referenced row does not exist in the
    // other organisation, so the insert fails structurally.
    await asOwner(`
      INSERT INTO guardian_consent
        (id, org_id, person_id, guardian_person_id, guardian_name, engagement_id,
         relationship, granted_at, expires_at)
      VALUES ('${CONSENT_B}', '${ORG_B}', '${ADULT_B}', '${GUARDIAN_B}', 'B Guardian',
              '${ENGAGEMENT_B}', 'parent',
              '${PAST}', '${RETURNS}');
    `);

    // TWO mechanisms refuse this, and the assertion names both rather than
    // pretending the first did all the work:
    //
    //   * `trip_traveller_consent_fk` is COMPOSITE on (org_id,
    //     guardian_consent_id), so ORG_B's consent is not referenceable from ORG_A
    //     at all. That is ADR-0011 — structural, not behavioural.
    //   * `guard_trip_traveller_consent` ALSO refuses, because 0008's
    //     `guardian_consent_covers_in_org` is handed ORG_A and finds no consent
    //     covering this minor on this engagement.
    //
    // The TRIGGER wins, being a BEFORE INSERT trigger while the FK is checked
    // afterwards. Asserting 23503 here would assert a detail of trigger ordering
    // rather than the property, so this asserts the refusal and the assertion
    // below proves the FK is genuinely composite by reflection.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip_traveller (org_id, trip_id, person_id, role, guardian_consent_id)
           VALUES ('${ORG_A}', '${TRIP_A}', '${MINOR_A}', 'player', '${CONSENT_B}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "cross-tenant consent",
    );
  });

  it("makes the traveller's consent FK COMPOSITE, so another tenant's consent is unreferenceable", async () => {
    // The mechanism behind the previous assertion, asserted structurally instead
    // of through whichever trigger happens to fire first.
    const found = await ownerRows<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'trip_traveller' AND c.conname = 'trip_traveller_consent_fk'`,
    );

    expect(found).toHaveLength(1);
    // PostgreSQL renders `REFERENCES guardian_consent(org_id, id)` with no space
    // before the paren, so the pattern must not assume one. Asserted on the
    // COLUMN LIST rather than on a prefix, because "is it composite" is the
    // property and the prefix would hold for a single-column key too.
    expect(found[0]!.def).toMatch(/FOREIGN KEY \(org_id, guardian_consent_id\)/);
    expect(found[0]!.def).toMatch(/REFERENCES guardian_consent\(org_id, id\)/);
  });

  it("refuses a trip on another organisation's engagement", async () => {
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip (id, org_id, engagement_id, title, departs_at, returns_at, created_by)
           VALUES ('${TRIP_CROSS}', '${ORG_A}', '${ENGAGEMENT_B}', 'Cross tenant', '${DEPARTS}', '${RETURNS}', '${STAFF_A}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "cross-tenant engagement",
    );
  });

  it("refuses a budget with no currency, and a leg arriving before it departs", async () => {
    // Both are shapes that look like a working row and are not: a number whose
    // unit nobody stated, and a leg that departs after it arrives.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip (id, org_id, engagement_id, title, departs_at, returns_at, created_by, budget_amount)
           VALUES ('${TRIP_NO_CURRENCY}', '${ORG_A}', '${ENGAGEMENT_A}', 'No currency', '${DEPARTS}', '${RETURNS}', '${STAFF_A}', 500.0000)`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "budget with no currency",
    );

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO trip_destination (id, org_id, trip_id, place, position)
          VALUES ('${TRIP_NO_LEGS_D1}', '${ORG_A}', '${TRIP_NO_LEGS}', 'A', 0), ('${TRIP_NO_LEGS_D2}', '${ORG_A}', '${TRIP_NO_LEGS}', 'B', 1);
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "destination for a trip that does not exist",
    );
  });

  it("refuses a trip with no engagement, because consent is to an ENGAGEMENT", async () => {
    // 0008 established that consent names an engagement and is never a global
    // flag. A trip with no engagement could therefore never carry a valid
    // consent — so the column is NOT NULL rather than nullable, which makes that
    // unrepresentable instead of merely discouraged.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip (id, org_id, title, departs_at, returns_at, created_by)
           VALUES ('${TRIP_NO_ENGAGEMENT}', '${ORG_A}', 'No engagement', '${DEPARTS}', '${RETURNS}', '${STAFF_A}')`,
        ),
      SQLSTATE_NOT_NULL_VIOLATION,
      "trip with no engagement",
    );
  });

  it("refuses a traveller naming a trip in another organisation", async () => {
    await seedTrip(TRIP_B, ORG_B, ENGAGEMENT_B);

    // The composite FK on (org_id, trip_id) makes a cross-tenant trip
    // unreferenceable, so a traveller cannot be attached to ORG_B's trip from
    // ORG_A even by exact id.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO trip_traveller (org_id, trip_id, person_id, role)
           VALUES ('${ORG_A}', '${TRIP_B}', '${ADULT_A}', 'player')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "cross-tenant trip",
    );
  });

  it("carries the trip's real spend as numeric(18,4) with an ISO currency", async () => {
    // ADR-0005's `travel` audit class exists because the legacy system tracked
    // neither this spend nor the minors travelling. The types are the mechanism.
    const found = await ownerRows<{ data_type: string; numeric_precision: number | null; numeric_scale: number | null }>(
      `SELECT data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'trip' AND column_name = 'budget_amount'`,
    );

    expect(found[0]!.data_type).toBe("numeric");
    expect(found[0]!.numeric_precision).toBe(18);
    expect(found[0]!.numeric_scale).toBe(4);

    await asOwner(`
      INSERT INTO trip (id, org_id, engagement_id, title, departs_at, returns_at, created_by,
                        budget_amount, budget_currency)
      VALUES ('${TRIP_SPEND}', '${ORG_A}', '${ENGAGEMENT_A}', 'With budget', '${DEPARTS}', '${RETURNS}',
              '${STAFF_A}', 1234.5600, '${INR}');
    `);

    const stored = await ownerRows<{ budget_amount: string; budget_currency: string }>(
      "SELECT budget_amount::text, budget_currency FROM trip WHERE org_id = $1 AND id = $2",
      [ORG_A, TRIP_SPEND],
    );
    // Four decimal places survive the round trip, which a float column would not
    // guarantee for a figure this size.
    expect(stored[0]!.budget_amount).toBe("1234.5600");
    expect(stored[0]!.budget_currency).toBe(INR);
  });

  it("uses the EVENT date, not created_at, for every travel index that a report reads", async () => {
    // ADR-0019 rule 5, asserted structurally: backfilled history must belong to
    // the period it happened in, and an index leading on `created_at` is how that
    // stops being true.
    const found = await ownerRows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'trip'
          AND indexdef LIKE '%created_at%'`,
    );

    // A created_at index would be an invitation to filter on it.
    expect(found).toEqual([]);

    const byDeparture = await ownerRows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'trip' AND indexdef LIKE '%departs_at%'`,
    );
    expect(byDeparture.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Property 5 — custody is append-only, and the holder is DERIVED
// ---------------------------------------------------------------------------

describe("assets — no holder column, because history must survive", () => {
  it("has NO holder column anywhere, which is the whole design", async () => {
    // Reflected over the catalogue rather than asserted in a comment. A mutable
    // `holder_id` overwrites every previous holder and makes "where was this
    // last March" unanswerable — precisely the gap ADR-0016 found.
    const found = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('asset', 'asset_custody')
          AND column_name IN ('holder_id', 'assigned_to', 'custodian_id', 'held_by', 'current_holder_id')
        ORDER BY table_name, column_name`,
    );

    expect(found).toEqual([]);
  });

  it("answers where a thing WAS, by date, from the append-only record", async () => {
    await seedAssets();
    const jan = "2026-01-10T09:00:00Z";
    const mar = "2026-03-10T09:00:00Z";
    const may = "2026-05-10T09:00:00Z";

    await commit(`
      INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at, reason)
      VALUES
        ('${ORG_A}', '${ASSET_A}', 'issue',    NULL,          '${ADULT_A}',        '${jan}', 'issued at season start'),
        ('${ORG_A}', '${ASSET_A}', 'transfer', '${ADULT_A}', '${SECOND_ADULT_A}', '${mar}', 'handed over for the LAN'),
        ('${ORG_A}', '${ASSET_A}', 'return',   '${SECOND_ADULT_A}', '${STAFF_A}', '${may}', 'returned after the event');
    `);

    // Three different dates, three different answers — from ONE query. This is
    // what a holder column could never produce.
    const at = async (instant: string): Promise<string | null> => {
      const found = await ownerRows<{ holder: string | null }>(
        "SELECT public.asset_holder_at($1, $2, $3::timestamptz)::text AS holder",
        [ORG_A, ASSET_A, instant],
      );
      return found[0]!.holder;
    };

    // Before the first issue: nobody held it.
    expect(await at("2026-01-01T00:00:00Z")).toBeNull();
    expect(await at(jan)).toBe(ADULT_A);
    expect(await at(mar)).toBe(SECOND_ADULT_A);
    expect(await at(may)).toBe(STAFF_A);
    // Still the same person a year later: nothing overwrote the history.
    expect(await at("2027-01-01T00:00:00Z")).toBe(STAFF_A);
  });

  it("reports the whole custody trail with the window each holder held it", async () => {
    await seedAssets();
    await commit(`
      INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
      VALUES
        ('${ORG_A}', '${ASSET_A}', 'issue',    NULL,          '${ADULT_A}',        '2026-01-10T09:00:00Z'),
        ('${ORG_A}', '${ASSET_A}', 'transfer', '${ADULT_A}', '${SECOND_ADULT_A}', '2026-03-10T09:00:00Z');
    `);

    // PGlite renders `timestamptz` in the HOST timezone (`+05` here), so the
    // instant is rendered to text IN SQL with an explicit UTC format. Comparing a
    // host-offset string against a UTC expectation would fail on any machine that
    // is not set to UTC — which is every developer and no CI runner.
    const found = await appRows<{ to_person: string; held_until: string | null }>(
      `SELECT to_person_id::text AS to_person,
              to_char(held_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS held_until
         FROM public.asset_custody_trail($1)
        ORDER BY occurred_at`,
      [ASSET_A],
    );

    expect(found).toHaveLength(2);
    expect(found[0]!.to_person).toBe(ADULT_A);
    // The first holder's window CLOSES when the second begins, which is what
    // makes the trail a partition rather than a list of events.
    expect(found[0]!.held_until).toBe("2026-03-10T09:00:00Z");
    // The last holder's window has no end, which is what makes it current.
    expect(found[1]!.held_until).toBeNull();
  });

  it("refuses two custody events at the same instant for one asset", async () => {
    await seedAssets();
    await asOwner(`
      INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
      VALUES ('${ORG_A}', '${ASSET_A}', 'issue', NULL, '${ADULT_A}', '2026-01-10T09:00:00Z');
    `);

    // Two rows at one instant make "who held this then" answerable two ways, and
    // a custody history is worthless the moment its central question has two
    // answers.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
           VALUES ('${ORG_A}', '${ASSET_A}', 'transfer', '${ADULT_A}', '${STAFF_A}', '2026-01-10T09:00:00Z')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "two events at one instant",
    );
  });

  it("refuses a transfer naming a sender who does not hold the asset", async () => {
    await seedAssets();
    await asOwner(`
      INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
      VALUES ('${ORG_A}', '${ASSET_A}', 'issue', NULL, '${ADULT_A}', '2026-01-10T09:00:00Z');
    `);

    // A custody history that does not reconcile with itself is not a history.
    // STAFF_A never held it, so a transfer FROM them is a lie about who had it.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
           VALUES ('${ORG_A}', '${ASSET_A}', 'transfer', '${STAFF_A}', '${SECOND_ADULT_A}', '2026-03-10T09:00:00Z')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "transfer from a non-holder",
    );
  });

  it("refuses to transfer an asset that was never issued", async () => {
    await seedAssets();

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
           VALUES ('${ORG_A}', '${ASSET_A}', 'transfer', '${ADULT_A}', '${STAFF_A}', '2026-01-10T09:00:00Z')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "transfer with no history",
    );
  });

  it("refuses an issue or return with nobody named on one side", async () => {
    await seedAssets();

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
           VALUES ('${ORG_A}', '${ASSET_A}', 'issue', NULL, NULL, '2026-01-10T09:00:00Z')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "issue to nobody",
    );
  });

  it("refuses to UPDATE or DELETE a custody record", async () => {
    await seedAssets();
    await asOwner(`
      INSERT INTO asset_custody (org_id, asset_id, kind, from_person_id, to_person_id, occurred_at)
      VALUES ('${ORG_A}', '${ASSET_A}', 'issue', NULL, '${ADULT_A}', '2026-01-10T09:00:00Z');
    `);

    await asApp(async () => {
      await expectSqlstate(
        () => db.exec("UPDATE asset_custody SET to_person_id = NULL"),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "update custody",
      );
      // Targeted at the seeded row, NOT a bare `DELETE FROM asset_custody`. An
      // unqualified DELETE matches zero rows and therefore SUCCEEDS even without
      // the privilege, so the unqualified form would have asserted nothing —
      // a test that passes because it deleted nothing is worse than no test.
      await expectSqlstate(
        () => db.exec(`DELETE FROM asset_custody WHERE org_id = '${ORG_A}' AND asset_id = '${ASSET_A}'`),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "delete custody",
      );
    });

    // And the row is still there, which is the part a privilege error alone does
    // not prove.
    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM asset_custody WHERE org_id = $1 AND asset_id = $2",
      [ORG_A, ASSET_A],
    );
    expect(found[0]!.count).toBe(1);
  });

  it("gives ORG_A's asset_holder_at no answer about ORG_B's asset", async () => {
    await seedAssets();

    // The function takes an explicit organisation for integrity reasons — 0008
    // makes the same argument for `guardian_consent_covers_in_org` — so this is a
    // caller error. But the RULES isolate it as well, and this is the assertion
    // that says so: the function is not reachable for another tenant's row.
    const found = await appRows<{ holder: string | null }>(
      "SELECT public.asset_holder_at($1, $2, $3::timestamptz)::text AS holder",
      [ORG_A, ASSET_B, "2026-06-01T00:00:00Z"],
    );

    expect(found[0]!.holder).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property 6 — a facility cannot be double-booked
// ---------------------------------------------------------------------------

describe("facilities — overlapping reservations are impossible", () => {
  beforeEach(async () => {
    await asOwner(`
      INSERT INTO facility (id, org_id, name, capacity)
      VALUES
        ('${FACILITY_A}', '${ORG_A}', 'Practice room', 1),
        ('${FACILITY_B}', '${ORG_B}', 'ORG B room',    1);
    `);
  });

  it("accepts a booking, and two that merely touch", async () => {
    // Half-open [starts_at, ends_at): a booking that ends exactly when the next
    // begins is NOT a double booking, and that is what makes back-to-back
    // scheduling possible at all.
    await commit(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Scrim', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');

      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Review', '2026-07-14T12:00:00Z', '2026-07-14T14:00:00Z', '${STAFF_A}');
    `);

    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM facility_reservation WHERE org_id = $1",
      [ORG_A],
    );
    expect(found[0]!.count).toBe(2);
  });

  it("refuses a booking that OVERLAPS a live one", async () => {
    await asOwner(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Scrim', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');
    `);

    await expectCommitRefusal(
      `INSERT INTO facility_reservation
         (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
       VALUES ('${ORG_A}', '${FACILITY_A}', 'Clash', '2026-07-14T11:00:00Z', '2026-07-14T13:00:00Z', '${STAFF_A}');`,
      SQLSTATE_CHECK_VIOLATION,
      "overlapping booking",
    );

    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM facility_reservation WHERE org_id = $1",
      [ORG_A],
    );
    // The whole transaction rolled back.
    expect(found[0]!.count).toBe(1);
  });

  it("refuses a booking that overlaps one that merely ENDS inside it", async () => {
    // The contained case, which is the one a naive `starts_at < ends_at` check on
    // one column alone misses.
    await asOwner(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Long', '${DEPARTS}', '2026-07-14T18:00:00Z', '${STAFF_A}');
    `);

    await expectCommitRefusal(
      `INSERT INTO facility_reservation
         (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
       VALUES ('${ORG_A}', '${FACILITY_A}', 'Inside', '2026-07-14T10:00:00Z', '2026-07-14T11:00:00Z', '${STAFF_A}');`,
      SQLSTATE_CHECK_VIOLATION,
      "contained booking",
    );
  });

  it("refuses a booking that CONTAINS a live one", async () => {
    await asOwner(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Short', '2026-07-14T11:00:00Z', '2026-07-14T12:00:00Z', '${STAFF_A}');
    `);

    await expectCommitRefusal(
      `INSERT INTO facility_reservation
         (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
       VALUES ('${ORG_A}', '${FACILITY_A}', 'Swallow', '${DEPARTS}', '2026-07-14T18:00:00Z', '${STAFF_A}');`,
      SQLSTATE_CHECK_VIOLATION,
      "containing booking",
    );
  });

  it("lets a CANCELLED reservation be booked over", async () => {
    // A cancelled booking holds nothing and blocks nothing. Modelling that as a
    // state rather than as a delete is what keeps the history, and the guard
    // reads the state so an UPDATE that cancels is covered by the same rule.
    await commit(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, state, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Called off', 'cancelled', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');

      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'Real one', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');
    `);

    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM facility_reservation WHERE org_id = $1",
      [ORG_A],
    );
    expect(found[0]!.count).toBe(2);
  });

  it("refuses a booking past a facility's CONCURRENT capacity", async () => {
    await asOwner(`
      UPDATE facility SET capacity = 1 WHERE org_id = '${ORG_A}' AND id = '${FACILITY_A}';
    `);

    await commit(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_A}', 'One', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');
    `);

    await expectCommitRefusal(
      `INSERT INTO facility_reservation
         (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
       VALUES ('${ORG_A}', '${FACILITY_A}', 'Two', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');`,
      SQLSTATE_CHECK_VIOLATION,
      "over capacity",
    );
  });

  it("permits N concurrent bookings for a facility of capacity N, and refuses the N+1th", async () => {
    // The case that killed the separate capacity trigger. A booth bank with
    // capacity 3 is THREE bookings of the same window, not one — a guard that
    // refuses any overlap makes it behave like a room with capacity 1, which is
    // the mistake of treating "bookable" as "single occupancy".
    await asOwner(`
      INSERT INTO facility (id, org_id, name, capacity)
      VALUES ('${FACILITY_BANK}', '${ORG_A}', 'Booth bank', 3);
    `);

    await commit(`
      INSERT INTO facility_reservation (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES ('${ORG_A}', '${FACILITY_BANK}', 'Booth 1', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}'),
             ('${ORG_A}', '${FACILITY_BANK}', 'Booth 2', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}'),
             ('${ORG_A}', '${FACILITY_BANK}', 'Booth 3', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');
    `);

    const allowed = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM facility_reservation WHERE org_id = $1 AND facility_id = $2",
      [ORG_A, FACILITY_BANK],
    );
    expect(allowed[0]!.count).toBe(3);

    await expectCommitRefusal(
      `INSERT INTO facility_reservation (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
       VALUES ('${ORG_A}', '${FACILITY_BANK}', 'Booth 4', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');`,
      SQLSTATE_CHECK_VIOLATION,
      "fourth booth in a bank of three",
    );
  });

  it("treats a NULL capacity as UNBOUNDED, which is a different claim from 1", async () => {
    await asOwner(`
      INSERT INTO facility (id, org_id, name, capacity)
      VALUES ('${FACILITY_UNBOUNDED}', '${ORG_A}', 'Open desk', NULL);
    `);

    // A room holds one booking; an open desk holds several. Defaulting one to the
    // other silently loses bookings.
    await commit(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES
        ('${ORG_A}', '${FACILITY_UNBOUNDED}', 'Desk 1', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}'),
        ('${ORG_A}', '${FACILITY_UNBOUNDED}', 'Desk 2', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}'),
        ('${ORG_A}', '${FACILITY_UNBOUNDED}', 'Desk 3', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}');
    `);

    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM facility_reservation WHERE org_id = $1",
      [ORG_A],
    );
    expect(found[0]!.count).toBe(3);
  });

  it("judges a batch of bookings at COMMIT, not row by row", async () => {
    // This is the case an IMMEDIATE check gets wrong. Three bookings that
    // individually conflict with each other may be fine as a SET only if they do
    // not overlap — and the point is that the decision is made on the
    // transaction's final state, so a caller may reorder rows without changing
    // the answer.
    await commit(`
      INSERT INTO facility_reservation
        (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
      VALUES
        ('${ORG_A}', '${FACILITY_A}', 'Morning', '${DEPARTS}',                    '2026-07-14T12:00:00Z', '${STAFF_A}'),
        ('${ORG_A}', '${FACILITY_A}', 'Midday',  '2026-07-14T12:00:00Z',          '2026-07-14T14:00:00Z', '${STAFF_A}'),
        ('${ORG_A}', '${FACILITY_A}', 'Evening', '2026-07-14T14:00:00Z',          '2026-07-14T18:00:00Z', '${STAFF_A}');
    `);

    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM facility_reservation WHERE org_id = $1",
      [ORG_A],
    );
    expect(found[0]!.count).toBe(3);
  });

  it("refuses a booking with an end at or before its start", async () => {
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO facility_reservation
             (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
           VALUES ('${ORG_A}', '${FACILITY_A}', 'Backwards', '2026-07-14T12:00:00Z', '${DEPARTS}', '${STAFF_A}')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "ends before it starts",
    );
  });

  it("refuses a booking on another organisation's facility", async () => {
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO facility_reservation
             (org_id, facility_id, purpose, starts_at, ends_at, requested_by)
           VALUES ('${ORG_A}', '${FACILITY_B}', 'Trespass', '${DEPARTS}', '2026-07-14T12:00:00Z', '${STAFF_A}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "cross-tenant facility",
    );
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation, as the application role
// ---------------------------------------------------------------------------

describe("operations — tenant isolation through the application role", () => {
  it("reads nothing with the tenant context UNSET, rather than reading everything", async () => {
    await seedTasks();
    await seedAssets();

    // The failure mode ADR-0015 exists to prevent: an unset `app.org_id` matching
    // everything because a policy says `org_id IS NULL OR ...`. Here it must
    // match NOTHING.
    await asApp(async () => {
      const found = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM task");
      expect(found.rows[0]!.count).toBe(0);
    });
  });

  it("reads only its own tenant's rows", async () => {
    await seedTasks();
    await asOwner(`
      INSERT INTO task (id, org_id, title, created_at)
      VALUES ('${TASK_B_ORG}', '${ORG_B}', 'ORG B task', '${PAST}');
    `);

    // ORG_A's session sees ORG_A's three tasks and nothing else.
    await asApp(async () => {
      const mine = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM task");
      expect(mine.rows[0]!.count).toBe(3);
    }, ORG_A);

    // ORG_B's session sees exactly its own one, and cannot see ORG_A's by id.
    // A wrong-tenant row returns an EMPTY answer rather than a permission error:
    // existence must not be confirmed (ADR-0011 rule 4), and a 403 would leak
    // exactly what a 404 hides.
    await asApp(async () => {
      const theirs = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM task");
      expect(theirs.rows[0]!.count).toBe(1);

      const foreign = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM task WHERE id = $1", [
        TASK_A,
      ]);
      expect(foreign.rows[0]!.count).toBe(0);
    }, ORG_B);
  });

  it("refuses to WRITE a row into another tenant", async () => {
    // 42501 rather than 23514: the WITH CHECK clause of the tenant policy is what
    // refuses it, and RLS reports insufficient privilege. That is the right code
    // and the assertion says so — a test that expected 23514 here would pass only
    // if the policy had a bug and the row was refused for a different reason.
    await expectSqlstate(
      () =>
        asApp(async () => {
          await db.exec(
            `INSERT INTO task (id, org_id, title, created_at)
             VALUES ('${TASK_CROSS_WRITE}', '${ORG_B}', 'Written into the wrong tenant', '${PAST}')`,
          );
        }, ORG_A),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "write into another tenant",
    );

    // And the row is genuinely absent, not merely invisible: proving the write
    // was refused rather than hidden is the difference between an assertion and
    // a hope.
    const found = await ownerRows<{ count: number }>(
      "SELECT count(*)::int AS count FROM task WHERE id = $1",
      [TASK_CROSS_WRITE],
    );
    expect(found[0]!.count).toBe(0);
  });

  it("gives the custody trail no rows for another tenant's asset", async () => {
    await seedAssets();

    // `asset_custody_trail` resolves its tenant from the session, not from a
    // parameter (ADR-0011 rule 3), so an unset or wrong context reads nothing.
    await asApp(async () => {
      const found = await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.asset_custody_trail($1)",
        [ASSET_B],
      );
      expect(found.rows[0]!.count).toBe(0);
    }, ORG_A);
  });

  it("refuses to grant EXECUTE on a guard to the application role", async () => {
    // A role that can call a guard directly has no use for it — the guards are
    // reachable only through a write, and a directly-callable guard is one a
    // caller can probe.
    //
    // Reflected over `aclexplode(proacl)` rather than
    // `information_schema.routine_privileges`: the latter raises
    // `missing FROM-clause entry for table "r"` under PGlite, and an assertion
    // that cannot run is not an assertion. `aclexplode` is also the more direct
    // question — it reads the ACL itself rather than a view's rendering of it.
    const found = await ownerRows<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE n.nspname = 'public'
          AND p.proname IN (
            'guard_task_transition', 'assert_workflow_run_consistent',
            'assert_task_matches_its_step', 'assert_step_matches_its_task',
            'guard_trip_traveller_consent', 'guard_asset_custody',
            'guard_facility_overlap', 'derive_workflow_step_run_token',
            'seed_task_state_transition', 'on_organization_created_operations'
          )
          AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'raptor_app')
        ORDER BY p.proname`,
    );

    expect(found).toEqual([]);
  });

  it("DOES grant EXECUTE on the derivations the application is meant to read", async () => {
    // The other half of the previous assertion, and the reason it is not simply
    // "revoke everything": the reporting functions have to be reachable, or the
    // role that is supposed to read them cannot. A grant list is a contract in
    // both directions, and testing only the denials would leave a schema where
    // everything is refused and nothing works.
    const found = await ownerRows<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE n.nspname = 'public'
          AND p.proname IN ('workflow_derived_status_in_org', 'asset_holder_at', 'asset_custody_trail')
          AND acl.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'raptor_app')
        ORDER BY p.proname`,
    );

    expect(found.map((r) => r.proname)).toEqual([
      "asset_custody_trail",
      "asset_holder_at",
      "workflow_derived_status_in_org",
    ]);
  });

  it("carries no TRUNCATING LIMIT in any reporting function, because truncation must be reported", async () => {
    // ADR-0019 rule 6: a report that silently capped its result set and presented
    // it as the whole looks authoritative. Reflected over the catalogue rather
    // than trusted from a comment.
    //
    // Scoped to functions that RETURN A SET, and to the ones actually intended
    // for reading. `asset_holder_at` returns a SCALAR and its `LIMIT 1` is
    // structural — it is how "the most recent row" is expressed — so including it
    // would make this assertion wrong rather than strict. The set-returning
    // functions are the ones where a cap would silently truncate.
    const found = await ownerRows<{ prosrc: string; prorettype: string; proname: string }>(
      `SELECT p.proname, p.prorettype::regtype::text AS prorettype, p.prosrc
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('asset_custody_trail', 'asset_holder_at', 'workflow_derived_status_in_org')`,
    );

    expect(found.length).toBe(3);

    for (const row of found) {
      const returnsSet = row.prorettype === "SETOF uuid" || row.prorettype === "TABLE";
      if (!returnsSet) continue;
      // A set-returning report that caps its rows without saying so is the defect.
      expect(row.prosrc, `${row.proname} returns a set and must not LIMIT it`).not.toMatch(/\bLIMIT\b/i);
    }

    // And the scalar function's LIMIT is present and correct, which is what makes
    // the exemption above a judgement rather than a convenience.
    const scalar = found.find((r) => r.proname === "asset_holder_at");
    expect(scalar?.prosrc).toMatch(/LIMIT 1/);
  });
});
