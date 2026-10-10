/**
 * Commercial + content — the Phase 5 release gate.
 *
 * The design spec closes Phase 5 on one sentence: "Obligation fulfilment provable end
 * to end". Read carefully, "end to end" is the whole of the claim. A sponsorship that
 * says "4 streams, 2 social posts, appear at the final" is provable only if every link
 * in that chain is separately checkable: what was owed, what was promised as evidence,
 * what was actually delivered, and what discharged it. The failure this rebuild exists
 * to prevent is an organisation marking a sponsorship "fulfilled" with nothing behind it.
 *
 * THE CENTRAL CLAIM
 * -----------------
 * A parent obligation is NEVER directly fulfilled. It is discharged only as an AGGREGATE
 * of its parts, and the aggregate is recomputed by the database from the parts and their
 * evidence at COMMIT. A stored `state` on the parent exists — it is the column a screen
 * reads — but it is a CACHED AGGREGATE whose agreement with the truth is a constraint,
 * not a convention. `obligation_discharge_consistent` re-derives it at COMMIT and refuses
 * any transaction that leaves the two disagreeing.
 *
 * WHY THE STORED STATE EXISTS AT ALL
 * ---------------------------------
 * Because "where is this sponsorship" must be one indexed read rather than a fold over
 * evidence, and because deleting it would leave the guard with nothing to compare the
 * derivation against. The 0008 `hr_record.state` decision is the same one, and it is
 * sound only because the transition table is enforced. Here it is sound because the
 * derived value is enforced. The test that matters is the one that asserts they cannot
 * disagree — including after a retraction, which is the case where a stored flag would
 * drift and a hand-set flag would lie.
 *
 * WHAT IS ASSERTED TO BE ABSENT
 * -----------------------------
 * Several, and they matter more than the presences:
 *
 *   * No stored `is_fulfilled` boolean anywhere.
 *   * No evidence column that stores confidence without a provenance binding.
 *   * No stored inventory balance — inventory is a LEDGER OF MOVEMENTS and the balance is
 *     derived, because ADR-0016 recorded a drifting balance as a real legacy defect and
 *     0004 refused the stored counter for budgets on exactly that ground.
 *   * No second identity model for creators: a creator IS a `person`.
 *   * No private column reachable from the public surface.
 *
 * METHOD
 * ------
 * Real SQL against a real PGlite instance. Structural claims are made by reflecting over
 * the catalogue rather than by trusting the DDL, matching the existing isolation suites.
 * Isolation assertions are made as `raptor_app` (`rolsuper=false AND rolbypassrls=false`),
 * because a superuser bypasses every policy (ADR-0006) and would let an assertion pass
 * for the wrong reason.
 *
 * Both traps this file is written around are recorded in the migration brief:
 *
 *   * PGlite returns `timestamptz`/`date` to Node as HOST-timezone `Date` objects, so
 *     every instant is cast to text IN SQL before it reaches an assertion.
 *   * PostgreSQL silently parses a malformed ISO literal into a wrong-but-valid instant
 *     with NO error, so every instant here is either a whole literal or produced by
 *     PostgreSQL. Nothing is concatenated.
 *
 * A third, specific to this file: several guarantees here are DEFERRABLE CONSTRAINT
 * TRIGGERS, so the refusal arrives at COMMIT rather than at the offending statement.
 * Every such test therefore wraps its transaction in a single `BEGIN; ...; COMMIT;` and
 * asserts that the refusal happened at COMMIT — a test that wrapped each statement
 * separately would be testing the harness, not the schema.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/** ORG_A's people: the player, the sponsor's contact, and the staff member who operates. */
const PLAYER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const SPONSOR_CONTACT_A = "aaaaaaaa-0000-0000-0000-000000000002";
const STAFF_A = "aaaaaaaa-0000-0000-0000-000000000003";
/** ORG_B's one person, so cross-tenant refusals have something real to point at. */
const PLAYER_B = "bbbbbbbb-0000-0000-0000-000000000001";

/**
 * Every TENANT table introduced by 0009_commercial.sql.
 *
 * `public_site_publication` is deliberately NOT in this list and that exclusion is
 * asserted, with its reason, further down: it is the one surface a public page reads
 * without a tenant filter, so it carries no private column at all — and that is
 * asserted by reflecting over its columns rather than by trusting the comment here.
 */
const COMMERCIAL_TABLES = [
  "contract_obligation",
  "contract_obligation_part",
  "content_item",
  "content_state_transition",
  "creator_profile",
  "inventory_item",
  "inventory_movement",
  "invoice",
  "invoice_line",
  "obligation_evidence",
  "obligation_evidence_retraction",
  "partner",
  "partner_state_transition",
] as const;

let db: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the session to a usable state: no open transaction, no assumed role.
 *
 * The ROLLBACK must come FIRST. PostgreSQL refuses every statement in an ABORTED
 * transaction with 25P02 until it is rolled back — including `RESET ROLE` — and getting
 * that order wrong turns one intended refusal into a cascade of false failures that
 * look like schema bugs and are not.
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
 * The tenant IS set in the session, deliberately. Several reporting functions in this
 * schema resolve their tenant from `current_org_id()` rather than from a parameter
 * (ADR-0011 rule 3), so a read with no tenant set returns zero rows — and a test that
 * passes on an empty answer is worse than one that fails. Seeding still writes
 * explicitly, so this setting changes nothing for a write.
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
 * A superuser bypasses every policy in this schema, so an isolation assertion made as
 * the owner proves nothing. The role attributes are asserted in the suite rather than
 * assumed.
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
 * Asserting the code rather than the message: several guarantees here raise the same
 * SQLSTATE from different mechanisms, and a message match would let the wrong mechanism
 * satisfy a test that claims a specific one.
 */
async function expectSqlstate(fn: () => Promise<unknown>, sqlstate: string, label: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  } finally {
    // The statement may have been refused mid-transaction; leaving the session
    // aborted would make every later assertion in this file meaningless.
    await recoverSession();
  }

  if (caught === undefined) {
    throw new Error(`${label}: expected SQLSTATE ${sqlstate} but the statement succeeded`);
  }

  const actual = (caught as { code?: string }).code;
  expect(actual, `${label}: wrong SQLSTATE → ${String((caught as Error).message).slice(0, 240)}`).toBe(sqlstate);
}

const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_NOT_NULL_VIOLATION = "23502";
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";

/**
 * SQLSTATE the irreversibility guard reports.
 *
 * 23P01 rather than 23514, matching `guard_performance_supersession` in 0007 and
 * `guard_contract_version_sealing` in 0008: it is what a declarative constraint would
 * raise for the same shape (a pair of moves that may not coexist), so moving to one on a
 * full server is not an observable change to any caller.
 */
const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

/**
 * Quotes a value as a SQL string literal.
 *
 * Present because the fixture strings below contain apostrophes, as sponsorship briefs
 * genuinely do. Interpolating them raw produces a syntax error, and a suite full of
 * syntax errors is a suite that has stopped testing anything at all.
 */
function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Whole ISO instants, never assembled from parts — see the file header.
 *
 * `MID_YEAR` doubles as "the middle of the sponsorship season" and, in the content
 * scheduling tests, as the moment a piece of content is queued FOR. The second use needs
 * it to be in the FUTURE relative to whenever the suite runs, and a fixed literal cannot
 * promise that: this repository's own design spec is dated 2026-10-09, so a fixture pinned
 * to 2025 is already in the past and the scheduling guard would refuse a LEGAL schedule.
 *
 * The future anchor is therefore computed by the DATABASE rather than written down, and it
 * is a whole instant it produces rather than a fragment this file concatenates.
 */
const LAST_YEAR = "2025-01-01T00:00:00Z";
const MID_YEAR = "2025-06-01T00:00:00Z";
const LAST_MONTH = "2025-12-01T00:00:00Z";

/** A whole instant comfortably in the future, produced by the database itself. */
async function futureInstant(): Promise<string> {
  const found = await ownerRows<{ t: string }>(
    `SELECT to_char(now() AT TIME ZONE 'UTC' + INTERVAL '90 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`,
  );
  return found[0]!.t;
}

/** The money fixtures use, spelled with four decimal places like the column stores. */
const INR = "INR";

/**
 * A contract for the sponsor's contact, which every obligation hangs from.
 *
 * `contract` is 0008's table and is reused rather than duplicated: an obligation is owed
 * under a contract, and inventing a second contract model here would create two answers
 * to "what did they sign".
 */
async function seedContract(contractId: string, orgId: string, personId: string): Promise<void> {
  await asOwner(`
    INSERT INTO contract (id, org_id, person_id, kind, title)
    VALUES ('${contractId}', '${orgId}', '${personId}', 'sponsorship', 'Season Sponsorship Agreement')
  `);
}

interface SponsorshipFixture {
  readonly contractId: string;
  readonly obligationId: string;
}

/** A contract plus one obligation promising `partCount` parts, all OUTSTANDING. */
async function seedOpenSponsorship(options: {
  readonly orgId?: string;
  readonly contractId: string;
  readonly obligationId: string;
  readonly partCount?: number;
}): Promise<SponsorshipFixture> {
  const orgId = options.orgId ?? ORG_A;
  const partCount = options.partCount ?? 3;

  await seedContract(options.contractId, orgId, orgId === ORG_A ? SPONSOR_CONTACT_A : PLAYER_B);

  const partRows: string[] = [];
  for (let index = 0; index < partCount; index += 1) {
    partRows.push(
      `('${partId(options.obligationId, index + 1)}',
        '${orgId}', '${options.obligationId}', 'live_stream', 1, '${MID_YEAR}', 'outstanding')`,
    );
  }

  // BEGIN and COMMIT in ONE exec call, deliberately: `assert_obligation_discharge_consistent`
  // is a DEFERRABLE CONSTRAINT TRIGGER, so it fires at COMMIT and reads the state of the
  // transaction as it is then. Splitting the statements across exec calls would commit an
  // obligation with no parts under an 'open' state that the deferred trigger would judge
  // against zero parts — and that failure would be a property of the harness rather than
  // of the schema.
  await asOwner(`
    BEGIN;
    INSERT INTO contract_obligation
      (id, org_id, contract_id, title, due_at, state)
    VALUES ('${options.obligationId}', '${orgId}', '${options.contractId}',
            'Season Sponsorship 2026', '${LAST_MONTH}', 'open');

    INSERT INTO contract_obligation_part
      (id, org_id, obligation_id, kind, promised_quantity, due_at, state)
    VALUES ${partRows.join(",\n           ")};
    COMMIT;
  `);

  return { contractId: options.contractId, obligationId: options.obligationId };
}

/**
 * A UUID for the nth part of an obligation.
 *
 * Derived from the obligation's own uuid rather than from a per-scenario prefix, because
 * a test may seed two obligations from the same prefix and a prefix-derived id would then
 * collide on the primary key — a failure that looks like a schema bug and is a fixture
 * bug. Deterministic, so a failing assertion names the part it was about.
 */
function partId(obligationId: string, index: number): string {
  // 8-4-4-4-12. The obligation's own uuid supplies the first two groups and the FINAL group
  // carries the index, so part 1 of one obligation and part 1 of another are always
  // distinguishable.
  //
  // Derived from the obligation rather than from a per-scenario prefix on purpose: the
  // fixture ids in this file share an eight-character prefix inside a scenario block, so a
  // prefix-derived part id collides on the primary key the moment one test seeds two
  // obligations from that block. That failure reads like a schema bug and is a fixture bug.
  return `${obligationId.slice(0, 8)}-${obligationId.slice(-4)}-0000-0000-${String(index).padStart(12, "0")}`;
}

/**
 * Records one piece of evidence for a part, moves the part to `fulfilled`, and moves the
 * PARENT to whatever the aggregate now says — all in one transaction.
 *
 * The parent move is not optional, and the helper doing it is what makes the rest of this
 * suite readable rather than a wall of hand-written transactions. It is also the point:
 * `assert_obligation_discharge_consistent` refuses ANY commit in which the stored parent
 * state differs from the derivation, so "fulfil a part and forget the parent" is not a
 * state this schema can be left in, by any transaction shape. A caller who wants the
 * refusal instead passes `omitParentUpdate`.
 */
async function assertEvidenceAndFulfilPart(options: {
  readonly obligationId: string;
  readonly partIndex: number;
  readonly quantity?: number;
  readonly evidenceId?: string;
  readonly origin?: "machine_derived" | "human_asserted";
  readonly omitEvidence?: boolean;
  readonly omitParentUpdate?: boolean;
}): Promise<string> {
  const quantity = options.quantity ?? 1;
  const origin = options.origin ?? "human_asserted";
  const evidenceId =
    options.evidenceId ?? `${options.obligationId.slice(0, 8)}-0000-0000-0000-00000000900${options.partIndex}`;

  // The two provenances are shaped differently and cannot be written by one statement:
  // a machine read names the extractor and its own stated confidence and has no person
  // behind it; a human assertion names the person and has no extractor and no confidence.
  const evidenceColumns =
    origin === "machine_derived"
      ? `origin, quantity, captured_at, extractor, confidence, source_ref`
      : `origin, quantity, captured_at, captured_by_person_id, source_ref`;

  const evidenceValues =
    origin === "machine_derived"
      ? `'machine_derived', ${quantity}, '${LAST_MONTH}', 'vlc-stream-indexer', 0.9200, 's3://evidence/stream-01.mp4'`
      : `'human_asserted', ${quantity}, '${LAST_MONTH}', '${STAFF_A}', 's3://evidence/post-01.png'`;

  const evidenceClause = options.omitEvidence === true ? "" : `
      INSERT INTO obligation_evidence (id, org_id, obligation_part_id, ${evidenceColumns})
      VALUES ('${evidenceId}', '${ORG_A}', '${partId(options.obligationId, options.partIndex)}', ${evidenceValues});
`;

  // Ask the DATABASE what the aggregate now says rather than computing it here. A helper
  // that reimplemented the rule would agree with a wrong implementation of it, and the
  // whole point of this file is that the database is the authority.
  const parentClause =
    options.omitParentUpdate === true
      ? ""
      : `
      UPDATE contract_obligation SET state = public.obligation_derived_state_in_org('${ORG_A}', '${options.obligationId}')
       WHERE org_id = '${ORG_A}' AND id = '${options.obligationId}';
`;

  await asOwner(`
    BEGIN;
    ${evidenceClause}
      UPDATE contract_obligation_part SET state = 'fulfilled'
       WHERE org_id = '${ORG_A}' AND id = '${partId(options.obligationId, options.partIndex)}';
    ${parentClause}
    COMMIT;
  `);

  return evidenceId;
}

/**
 * Retracts one evidence row AND moves the parent to whatever the aggregate then says, in a
 * single transaction.
 *
 * The parent move is not a convenience: `assert_obligation_discharge_consistent` refuses
 * any commit in which the two disagree, so a retraction that under-delivers an obligation
 * CANNOT be committed on its own. That is deliberate — it is the same ledger-reversal
 * shape 0004 uses, where a reversal and the correction it forces are one act — and it is
 * asserted directly in property 4 ("re-judges the aggregate when a retraction removes the
 * last supporting evidence"), which is the test that proves the refusal rather than this
 * helper, which merely works within it.
 */
async function retractEvidence(options: {
  readonly obligationId: string;
  readonly evidenceId: string;
  readonly retractionId: string;
  readonly reason: string;
  readonly retractedAt?: string;
}): Promise<void> {
  await asOwner(`
    BEGIN;
      INSERT INTO obligation_evidence_retraction
        (id, org_id, obligation_evidence_id, retracted_by_person_id, retracted_at, reason)
      VALUES ('${options.retractionId}', '${ORG_A}', '${options.evidenceId}',
              '${STAFF_A}', '${options.retractedAt ?? LAST_MONTH}', ${sql(options.reason)});

      UPDATE contract_obligation
         SET state = public.obligation_derived_state_in_org('${ORG_A}', '${options.obligationId}')
       WHERE org_id = '${ORG_A}' AND id = '${options.obligationId}';
    COMMIT;
  `);
}

/** A partner in `lead`, the stage every pipeline starts at. */
async function seedPartner(partnerId: string, orgId: string, name: string): Promise<void> {
  await asOwner(`
    INSERT INTO partner (id, org_id, name, stage)
    VALUES ('${partnerId}', '${orgId}', '${name}', 'lead')
  `);
}

/** A creator profile for `personId`. The person IS the identity — there is no second model. */
async function seedCreator(profileId: string, orgId: string, personId: string, handle: string): Promise<void> {
  await asOwner(`
    INSERT INTO creator_profile (id, org_id, person_id, handle, display_name)
    VALUES ('${profileId}', '${orgId}', '${personId}', '${handle}', 'A Creator')
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

    INSERT INTO person (id, external_ref) VALUES
      ('${PLAYER_A}',           'player-a'),
      ('${SPONSOR_CONTACT_A}',  'sponsor-contact'),
      ('${STAFF_A}',            'staff'),
      ('${PLAYER_B}',           'player-b');
  `);
});

// ---------------------------------------------------------------------------
// Isolation invariants
// ---------------------------------------------------------------------------

describe("commercial schema — isolation", () => {
  it("applies 0009_commercial.sql with no pending work", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0009_commercial.sql");
    expect(status.pending).toHaveLength(0);
  });

  it("runs the isolation assertions as a role that CANNOT bypass RLS", async () => {
    // Without this, every isolation assertion below could pass while proving nothing:
    // a superuser bypasses every policy in this schema (ADR-0006).
    const found = await ownerRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raptor_app'",
    );

    expect(found, "the application role must exist").toHaveLength(1);
    expect(found[0]!.rolsuper).toBe(false);
    expect(found[0]!.rolbypassrls).toBe(false);

    // The public read role too. A role that could bypass RLS would make the public
    // surface's lack of a tenant filter irrelevant, because it would be able to read
    // past every policy as well.
    const publicRole = await ownerRows<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'raptor_public'",
    );
    expect(publicRole, "the public read role must exist").toHaveLength(1);
    expect(publicRole[0]!.rolsuper).toBe(false);
    expect(publicRole[0]!.rolbypassrls).toBe(false);
  });

  it("ENABLES and FORCES row level security on every commercial table", async () => {
    const found = await ownerRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(found.map((r) => r.relname)).toEqual([...COMMERCIAL_TABLES].sort());
    for (const row of found) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("gives every commercial table one tenant policy with no IS NULL bypass", async () => {
    const found = await ownerRows<{ relname: string; polname: string; qual: string; with_check: string }>(
      `SELECT c.relname, p.polname,
              pg_get_expr(p.polqual, p.polrelid)    AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(found).toHaveLength(COMMERCIAL_TABLES.length);
    for (const row of found) {
      expect(row.polname).toBe(`${row.relname}_tenant_isolation`);
      // The tenant predicate is the WHOLE predicate. An `OR org_id IS NULL` anywhere
      // here hands every tenant every row whenever the context is missing — the failure
      // ADR-0015 exists to prevent.
      expect(row.qual).not.toMatch(/IS NULL/i);
      expect(row.with_check).not.toMatch(/IS NULL/i);
      expect(row.qual).toMatch(/org_id/);
      expect(row.with_check).toMatch(/org_id/);
    }
  });

  it("makes org_id NOT NULL on every commercial table", async () => {
    const found = await ownerRows<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id'
        ORDER BY table_name`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(found).toHaveLength(COMMERCIAL_TABLES.length);
    for (const row of found) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("gives every commercial table UNIQUE (org_id, id) for composite foreign keys", async () => {
    const found = await ownerRows<{ relname: string; conname: string; attnames: string[] }>(
      `SELECT c.relname, u.conname, array_agg(a.attname ORDER BY k.ord) AS attnames
         FROM pg_constraint u
         JOIN pg_class c ON c.oid = u.conrelid
         JOIN LATERAL unnest(u.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = u.conrelid AND a.attnum = k.attnum
        WHERE u.contype = 'u' AND c.relname = ANY($1)
        GROUP BY c.relname, u.conname, u.conkey
        ORDER BY c.relname, u.conname`,
      [[...COMMERCIAL_TABLES]],
    );

    const keyed = found.filter((r) => r.attnames.length === 2 && r.attnames[0] === "org_id" && r.attnames[1] === "id");
    expect(
      keyed.map((r) => r.relname),
      "every commercial table must expose UNIQUE (org_id, id) for composite FKs",
    ).toEqual([...COMMERCIAL_TABLES].sort());
  });

  it("leads every multi-column index on a commercial table with org_id", async () => {
    const found = await ownerRows<{ table_name: string; index_name: string; cols: string[] }>(
      `SELECT t.relname AS table_name, i.relname AS index_name,
              array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_index x
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
        WHERE t.relname = ANY($1)
          AND k.attnum > 0
          AND array_length(x.indkey, 1) > 1
        GROUP BY t.relname, i.relname, x.indkey
        ORDER BY t.relname, i.relname`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      expect(row.cols[0], `${row.table_name}.${row.index_name} must lead with org_id`).toBe("org_id");
    }
  });

  it("has no single-column foreign key from a commercial table to a tenant table", async () => {
    // A table is tenant-owned if it has a NOT NULL org_id AND UNIQUE (org_id, id).
    // `organization` and `person` are excluded by that definition on purpose: the first
    // is the tenant root, the second is org-independent by design (ADR-0018), which is
    // exactly why `creator_profile` and `partner` may carry a single-column person FK.
    const tenantTables = new Set(
      (
        await ownerRows<{ relname: string }>(
          `SELECT c.relname
             FROM pg_class c
            WHERE c.relkind = 'r'
              AND EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND a.attnotnull)
              AND EXISTS (SELECT 1 FROM pg_constraint u
                           WHERE u.conrelid = c.oid AND u.contype = 'u' AND array_length(u.conkey, 1) = 2
                             AND u.conkey = ARRAY[
                                   (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'org_id'),
                                   (SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'id')
                                 ]::smallint[])`,
        )
      ).map((r) => r.relname),
    );

    const found = await ownerRows<{ child_table: string; parent_table: string; conname: string; cols: string[] }>(
      `SELECT child.relname AS child_table, parent.relname AS parent_table, con.conname,
              array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_constraint con
         JOIN pg_class child  ON child.oid  = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'f' AND child.relname = ANY($1)
        GROUP BY child.relname, parent.relname, con.conname
        ORDER BY child.relname, con.conname`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const fk of found) {
      if (!tenantTables.has(fk.parent_table)) continue;
      if (fk.cols.length < 2 || fk.cols[0] !== "org_id") {
        offenders.push(`${fk.child_table}.${fk.conname} → ${fk.parent_table}(${fk.cols.join(", ")})`);
      }
    }

    expect(
      offenders,
      `every FK from a commercial table to a tenant table must be composite and lead with org_id:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("rejects a commercial row naming another org's row, by the composite FK itself", async () => {
    const orgBContract = "cccccccc-0000-0000-0000-0000000000c1";
    await seedContract(orgBContract, ORG_B, PLAYER_B);

    // The premise: ORG_B's contract genuinely exists, so the refusal below cannot be
    // explained by a missing row.
    const present = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM contract WHERE org_id = $1 AND id = $2",
      [ORG_B, orgBContract],
    );
    expect(present[0]!.n, "the cross-tenant target must really exist").toBe(1);

    // Run as the OWNER, so RLS is not what does the refusing. The guarantee asserted is
    // that the database cannot EXPRESS a cross-tenant reference (ADR-0011), independent
    // of any policy.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO contract_obligation
            (id, org_id, contract_id, title, due_at, state)
          VALUES ('cccccccc-0000-0000-0000-0000000000a1', '${ORG_A}', '${orgBContract}',
                  'Stolen contract', '${LAST_MONTH}', 'open');
          COMMIT;
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "an obligation in ORG_A naming ORG_B's contract",
    );

    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM contract_obligation WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n, "a refused reference leaves no partial history behind").toBe(0);
  });

  it("rejects evidence in one org naming another org's obligation part", async () => {
    await seedOpenSponsorship({
      contractId: "cccccccc-0000-0000-0000-0000000000d1",
      obligationId: "cccccccc-0000-0000-0000-0000000000b1",
      partCount: 1,
    });

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO obligation_evidence
            (id, org_id, obligation_part_id, origin, quantity, captured_at,
             captured_by_person_id, source_ref)
          VALUES ('dddddddd-0000-0000-0000-0000000000a1', '${ORG_B}',
                  '${partId("cccccccc-0000-0000-0000-0000000000b1", 1)}', 'human_asserted', 1,
                  '${LAST_MONTH}', '${STAFF_A}', 's3://evidence/x.mp4')
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "evidence in ORG_B naming ORG_A's part",
    );
  });

  it("shows a member only their own organisation's commercial rows", async () => {
    await seedOpenSponsorship({
      contractId: "cccccccc-0000-0000-0000-0000000000e1",
      obligationId: "cccccccc-0000-0000-0000-0000000000c1",
      partCount: 1,
    });
    await seedOpenSponsorship({
      orgId: ORG_B,
      contractId: "cccccccc-0000-0000-0000-0000000000e2",
      obligationId: "cccccccc-0000-0000-0000-0000000000c2",
      partCount: 1,
    });
    await seedPartner("eeeeeeee-0000-0000-0000-0000000000c1", ORG_A, "Acme Corp");
    await seedPartner("eeeeeeee-0000-0000-0000-0000000000c2", ORG_B, "Globex");

    const asA = await appRows<{ org_id: string; name: string }>("SELECT org_id, name FROM partner ORDER BY name");
    expect(asA).toHaveLength(1);
    expect(asA[0]!.org_id).toBe(ORG_A);
    expect(asA[0]!.name).toBe("Acme Corp");

    await asApp(async () => {
      const found = await db.query<{ org_id: string; name: string }>("SELECT org_id, name FROM partner");
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]!.org_id).toBe(ORG_B);
      expect(found.rows[0]!.name).toBe("Globex");
    }, ORG_B);
  });

  it("fails CLOSED with app.org_id unset, on every commercial table", async () => {
    await seedOpenSponsorship({
      contractId: "ffffffff-0000-0000-0000-0000000000e1",
      obligationId: "ffffffff-0000-0000-0000-0000000000c1",
      partCount: 1,
    });
    await seedPartner("ffffffff-0000-0000-0000-0000000000c2", ORG_A, "Acme Corp");
    await seedCreator("ffffffff-0000-0000-0000-0000000000c3", ORG_A, PLAYER_A, "streambar");

    // Asserted per table rather than on one representative: a migration that forgot one
    // table would otherwise pass.
    await asApp(async () => {
      for (const table of COMMERCIAL_TABLES) {
        const found = await db.query(`SELECT * FROM ${table}`);
        expect(found.rows, `${table} must expose nothing without a tenant context`).toHaveLength(0);
      }
    });

    // And an INSERT with no context must be refused too, not merely invisible. The
    // partner insert is used because it needs no prior rows, so the refusal cannot be
    // attributed to a missing fixture.
    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query(
            `INSERT INTO partner (id, org_id, name, stage) VALUES ($1, $2, 'No Tenant', 'lead')`,
            ["ffffffff-0000-0000-0000-0000000000ff", ORG_A],
          ),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "insert with no tenant context",
      );
    });
  });

  it("stores money as numeric(18,4) beside an ISO-4217 currency, never an integer or a float", async () => {
    // ADR-0003. `obligation_evidence.quantity` and `inventory_movement.quantity` are
    // integers on purpose and are NOT in this list: they count things, not money, and
    // forcing them to numeric(18,4) would be a lie about what they are.
    const found = await ownerRows<{
      table_name: string;
      column_name: string;
      data_type: string;
      numeric_precision: number | null;
      numeric_scale: number | null;
    }>(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND column_name IN ('total_amount', 'amount')
        ORDER BY table_name, column_name`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      expect(row.data_type, `${row.table_name}.${row.column_name} must be numeric`).toBe("numeric");
      expect(row.numeric_precision, `${row.table_name}.${row.column_name} precision`).toBe(18);
      expect(row.numeric_scale, `${row.table_name}.${row.column_name} scale`).toBe(4);
    }

    // And the currency is a three-letter code beside it, on both tables that hold money.
    const currencies = await ownerRows<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'currency'`,
      [["invoice", "invoice_line"]],
    );
    expect(currencies).toHaveLength(2);
    for (const row of currencies) {
      expect(row.data_type, `${row.table_name}.currency must be varchar(3)`).toBe("character varying");
    }
  });

  it("stores every instant as timestamptz, never as a bare date or a text timestamp", async () => {
    // ADR-0003's lesson restated: strings do not order, and a bare `date` on a deadline
    // makes "was it late" resolve to a different day per reader's timezone.
    const found = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND (data_type = 'date' OR data_type = 'text' OR data_type = 'character varying')
          AND column_name ~ '(at|_on|_date|_time)$'
        ORDER BY table_name, column_name`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(
      found.map((r) => `${r.table_name}.${r.column_name}`),
      "a deadline or an instant must be timestamptz, never a bare date or a string",
    ).toEqual([]);
  });

  it("REFUSES an obligation with no title and a part with no deadline", async () => {
    // Two NOT NULL claims in one test because they are one claim: a promise the database
    // cannot name, or cannot date, cannot be checked by anybody reading it later. Both
    // refusals are `not_null_violation`, which is a DIFFERENT SQLSTATE from every check
    // above — so asserting the code here proves the refusal came from the column and not
    // from a constraint that happened to fire at the same moment.
    const contractId = "abababab-0000-0000-0000-0000000000d1";
    await seedContract(contractId, ORG_A, SPONSOR_CONTACT_A);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO contract_obligation (id, org_id, contract_id, title, due_at, state)
          VALUES ('abababab-0000-0000-0000-0000000000b1', '${ORG_A}', '${contractId}',
                  '   ', '${LAST_MONTH}', 'open');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an obligation whose title is blank",
    );

    // The premise: nothing was written by the refused insert.
    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM contract_obligation WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n).toBe(0);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO contract_obligation (id, org_id, contract_id, title, due_at, state)
          VALUES ('abababab-0000-0000-0000-0000000000b1', '${ORG_A}', '${contractId}',
                  'Season Sponsorship', NULL, 'open');
          COMMIT;
        `),
      SQLSTATE_NOT_NULL_VIOLATION,
      "an obligation with no deadline",
    );
  });

  it("grants the application role no DELETE on any commercial table", async () => {
    // No hard deletes anywhere in this domain: an obligation, an evidence row, a retraction
    // and a movement are all history. Mutable tables archive; append-only tables cannot
    // be rewritten at all.
    const found = await ownerRows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_app'
          AND privilege_type = 'DELETE'
          AND table_name = ANY($1)
        ORDER BY table_name`,
      [[...COMMERCIAL_TABLES]],
    );

    expect(
      found.map((r) => r.table_name),
      "a deleted obligation or evidence row is a fact nobody may remove",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 1 — a parent obligation is discharged only as an aggregate of its parts
// ---------------------------------------------------------------------------

describe("property 1 — a parent obligation is fulfilled only as an aggregate of its parts", () => {
  it("REFUSES to mark an obligation discharged while a part is outstanding", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "12121212-0000-0000-0000-0000000000c1",
      obligationId: "12121212-0000-0000-0000-0000000000b1",
      partCount: 3,
    });

    // The premise, asserted before drawing any conclusion from a refusal: the obligation
    // exists with THREE outstanding parts, and all three really are outstanding.
    const parts = await ownerRows<{ state: string; promised_quantity: number }>(
      `SELECT state::text AS state, promised_quantity
         FROM contract_obligation_part
        WHERE org_id = $1 AND obligation_id = $2
        ORDER BY id`,
      [ORG_A, seeded.obligationId],
    );
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.state === "outstanding")).toBe(true);

    // THE claim: the database refuses the flip. This is the defect the rebuild exists to
    // prevent — an organisation marking a sponsorship "fulfilled" with nothing behind it.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          UPDATE contract_obligation SET state = 'discharged'
           WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "marking an obligation discharged with three outstanding parts",
    );

    // And the stored state did not move.
    const after = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM contract_obligation WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.obligationId],
    );
    expect(after[0]!.state, "the refused flip did not move the stored state").toBe("open");
  });

  it("REFUSES to mark an obligation discharged when it has no parts at all", async () => {
    // The purest form of the defect: nothing was ever promised in parts, so nothing can
    // have been fulfilled. An obligation with zero parts can only ever be 'open'.
    await seedContract("12121212-0000-0000-0000-0000000000d1", ORG_A, SPONSOR_CONTACT_A);

    await asOwner(`
      BEGIN;
      INSERT INTO contract_obligation
        (id, org_id, contract_id, title, due_at, state)
      VALUES ('12121212-0000-0000-0000-0000000000b2', '${ORG_A}',
              '12121212-0000-0000-0000-0000000000d1', 'Vague goodwill', '${LAST_MONTH}', 'open');
      COMMIT;
    `);

    const partCount = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM contract_obligation_part WHERE org_id = $1",
      [ORG_A],
    );
    expect(partCount[0]!.n, "the premise: this obligation has no parts at all").toBe(0);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          UPDATE contract_obligation SET state = 'discharged'
           WHERE org_id = '${ORG_A}' AND id = '12121212-0000-0000-0000-0000000000b2';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "marking a partless obligation discharged",
    );
  });

  it("accepts the discharge once every part is fulfilled with evidence, and refuses one step short", async () => {
    // A guard that refuses everything would leave the domain unexpressible and would be
    // disabled by the first person who hit it. So the legal path is demonstrated, and so
    // is the step immediately short of it.
    const seeded = await seedOpenSponsorship({
      contractId: "12121212-0000-0000-0000-0000000000d2",
      obligationId: "12121212-0000-0000-0000-0000000000b3",
      partCount: 2,
    });

    // One of two parts evidenced and fulfilled. The helper moves the parent to whatever the
    // aggregate now says, which is 'partially_fulfilled' — and that is the whole point of
    // the intermediate state having a name at all. An obligation in progress must not read
    // the same as one that is done, and 'open' would not distinguish "nothing delivered"
    // from "half delivered".
    await assertEvidenceAndFulfilPart({ obligationId: seeded.obligationId, partIndex: 1 });

    const midway = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM contract_obligation WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.obligationId],
    );
    expect(midway[0]!.state, "one part down is partial progress, not a discharge").toBe("partially_fulfilled");

    // Both parts done, and the parent updated in the same transaction: accepted.
    await asOwner(`
      BEGIN;
        INSERT INTO obligation_evidence
          (id, org_id, obligation_part_id, origin, quantity, captured_at,
           captured_by_person_id, source_ref)
        VALUES ('12121212-0000-0000-0000-000000009099', '${ORG_A}',
                '${partId(seeded.obligationId, 2)}', 'human_asserted', 1, '${LAST_MONTH}',
                '${STAFF_A}', 's3://evidence/post-02.png');

        UPDATE contract_obligation_part SET state = 'fulfilled'
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 2)}';

        UPDATE contract_obligation SET state = 'discharged'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    const after = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM contract_obligation WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.obligationId],
    );
    expect(after[0]!.state, "both parts evidenced and fulfilled is a discharge").toBe("discharged");
  });

  it("reports a partially fulfilled obligation as partially fulfilled, not as fulfilled", async () => {
    // The intermediate state has to be nameable, or an obligation in progress reads the
    // same as one that is done.
    const seeded = await seedOpenSponsorship({
      contractId: "12121212-0000-0000-0000-0000000000d3",
      obligationId: "12121212-0000-0000-0000-0000000000b4",
      partCount: 3,
    });

    await asOwner(`
      BEGIN;
        INSERT INTO obligation_evidence
          (id, org_id, obligation_part_id, origin, quantity, captured_at,
           captured_by_person_id, source_ref)
        VALUES ('12121212-0000-0000-0000-000000009099', '${ORG_A}',
                '${partId(seeded.obligationId, 1)}', 'human_asserted', 1, '${LAST_MONTH}',
                '${STAFF_A}', 's3://evidence/stream-01.mp4');

        UPDATE contract_obligation_part SET state = 'fulfilled'
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';

        UPDATE contract_obligation SET state = 'partially_fulfilled'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    const found = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM contract_obligation WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.obligationId],
    );
    expect(found[0]!.state).toBe("partially_fulfilled");
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 2 — fulfilment requires evidence, and evidence carries its provenance
// ---------------------------------------------------------------------------

describe("property 2 — a part cannot be fulfilled without evidence, and every evidence row has provenance", () => {
  it("REFUSES to move a part to fulfilled with no evidence at all", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "13131313-0000-0000-0000-0000000000c1",
      obligationId: "13131313-0000-0000-0000-0000000000b1",
      partCount: 1,
    });

    // The premise: the part exists and is outstanding, and there is genuinely no evidence.
    const evidenceCount = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM obligation_evidence WHERE org_id = $1",
      [ORG_A],
    );
    expect(evidenceCount[0]!.n, "the premise: no evidence exists").toBe(0);

    await expectSqlstate(
      () => assertEvidenceAndFulfilPart({ obligationId: seeded.obligationId, partIndex: 1, omitEvidence: true }),
      SQLSTATE_CHECK_VIOLATION,
      "fulfilling a part with no evidence",
    );

    const after = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM contract_obligation_part WHERE org_id = $1 AND id = $2",
      [ORG_A, partId(seeded.obligationId, 1)],
    );
    expect(after[0]!.state, "the refused fulfilment did not move the part").toBe("outstanding");
  });

  it("REFUSES a human assertion with nobody named as having asserted it", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "13131313-0000-0000-0000-0000000000c2",
      obligationId: "13131313-0000-0000-0000-0000000000b2",
      partCount: 1,
    });

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO obligation_evidence
            (id, org_id, obligation_part_id, origin, quantity, captured_at, source_ref)
          VALUES ('13131313-0000-0000-0000-0000000090a1', '${ORG_A}',
                  '${partId(seeded.obligationId, 1)}', 'human_asserted', 1,
                  '${LAST_MONTH}', 's3://evidence/ghost.mp4')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a human assertion with no asserting person",
    );
  });

  it("REFUSES a machine read with no extractor and no confidence, and one with only some of them", async () => {
    // ADR-0019's finding was a hardcoded confidence of 85 presented as an OCR reading.
    // The structural fix is that a machine row cannot exist without naming the machine and
    // the machine's own stated confidence — so there is no constant left to hardcode into.
    const seeded = await seedOpenSponsorship({
      contractId: "13131313-0000-0000-0000-0000000000c3",
      obligationId: "13131313-0000-0000-0000-0000000000b3",
      partCount: 1,
    });

    const insert = (id: string, extra: string, values: string): string => `
      INSERT INTO obligation_evidence
        (id, org_id, obligation_part_id, origin, quantity, captured_at, ${extra})
      VALUES ('${id}', '${ORG_A}', '${partId(seeded.obligationId, 1)}',
              'machine_derived', 1, '${LAST_MONTH}', ${values})
    `;

    // Neither.
    await expectSqlstate(
      () => asOwner(insert("13131313-0000-0000-0000-0000000090a2", "source_ref", "'s3://e/x'")),
      SQLSTATE_CHECK_VIOLATION,
      "a machine read naming no extractor and no confidence",
    );

    // The extractor alone. "The pipeline read it, and was sure" is not a confidence.
    await expectSqlstate(
      () => asOwner(insert("13131313-0000-0000-0000-0000000090a3", "extractor, source_ref", "'vlc', 's3://e/x'")),
      SQLSTATE_CHECK_VIOLATION,
      "a machine read naming an extractor but no confidence",
    );

    // The confidence alone — the shape of the legacy OCR row, exactly.
    await expectSqlstate(
      () => asOwner(insert("13131313-0000-0000-0000-0000000090a4", "confidence, source_ref", "85.0000, 's3://e/x'")),
      SQLSTATE_CHECK_VIOLATION,
      "a machine read naming a confidence but no extractor",
    );
  });

  it("REFUSES a human assertion wearing a machine's provenance, and a machine read naming a person", async () => {
    // Both directions. Permitting either would let a corrected or hand-typed row be
    // presented as a machine reading, which is the same class of lie as the original.
    const seeded = await seedOpenSponsorship({
      contractId: "13131313-0000-0000-0000-0000000000c4",
      obligationId: "13131313-0000-0000-0000-0000000000b4",
      partCount: 1,
    });

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO obligation_evidence
            (id, org_id, obligation_part_id, origin, quantity, captured_at,
             captured_by_person_id, extractor, confidence, source_ref)
          VALUES ('13131313-0000-0000-0000-0000000090a5', '${ORG_A}',
                  '${partId(seeded.obligationId, 1)}', 'human_asserted', 1, '${LAST_MONTH}',
                  '${STAFF_A}', 'vlc-stream-indexer', 0.9200, 's3://evidence/x.mp4')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a human assertion also claiming a machine extractor and confidence",
    );

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO obligation_evidence
            (id, org_id, obligation_part_id, origin, quantity, captured_at,
             captured_by_person_id, extractor, confidence, source_ref)
          VALUES ('13131313-0000-0000-0000-0000000090a6', '${ORG_A}',
                  '${partId(seeded.obligationId, 1)}', 'machine_derived', 1, '${LAST_MONTH}',
                  '${STAFF_A}', 'vlc-stream-indexer', 0.9200, 's3://evidence/x.mp4')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a machine read also claiming a human capturer",
    );
  });

  it("refuses a confidence outside 0..1", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "13131313-0000-0000-0000-0000000000c5",
      obligationId: "13131313-0000-0000-0000-0000000000b5",
      partCount: 1,
    });

    const insert = (id: string, confidence: string): string => `
      INSERT INTO obligation_evidence
        (id, org_id, obligation_part_id, origin, quantity, captured_at,
         extractor, confidence, source_ref)
      VALUES ('${id}', '${ORG_A}', '${partId(seeded.obligationId, 1)}', 'machine_derived', 1,
              '${LAST_MONTH}', 'vlc-stream-indexer', ${confidence}, 's3://evidence/x.mp4')
    `;

    // 85 in a 0..1 column is the legacy hardcoded confidence made storable — which is
    // exactly why the bound exists and is asserted here rather than assumed.
    await expectSqlstate(
      () => asOwner(insert("13131313-0000-0000-0000-0000000090a7", "85.0000")),
      SQLSTATE_CHECK_VIOLATION,
      "a confidence of 85 on a 0..1 scale",
    );

    await expectSqlstate(
      () => asOwner(insert("13131313-0000-0000-0000-0000000090a8", "-0.1000")),
      SQLSTATE_CHECK_VIOLATION,
      "a negative confidence",
    );
  });

  it("records who captured it, when, and whether a machine derived it or a human asserted it", async () => {
    // The provenance is not a note. A reader must be able to tell a machine read from a
    // human assertion, and to name the party behind a human assertion, from the row alone.
    const seeded = await seedOpenSponsorship({
      contractId: "13131313-0000-0000-0000-0000000000c6",
      obligationId: "13131313-0000-0000-0000-0000000000b6",
      partCount: 2,
    });

    const humanId = await assertEvidenceAndFulfilPart({ obligationId: seeded.obligationId, partIndex: 1 });
    const machineId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 2,
      origin: "machine_derived",
    });

    const found = await ownerRows<{
      id: string;
      origin: string;
      captured_at: string;
      external_ref: string;
      extractor: string | null;
      confidence: string | null;
      source_ref: string;
    }>(
      `SELECT e.id,
              e.origin::text AS origin,
              to_char(e.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS captured_at,
              p.external_ref,
              e.extractor,
              e.confidence::text AS confidence,
              e.source_ref
         FROM obligation_evidence e
         LEFT JOIN person p ON p.id = e.captured_by_person_id
        WHERE e.org_id = $1 AND e.obligation_part_id = ANY($2::uuid[])
        ORDER BY e.origin`,
      [ORG_A, [partId(seeded.obligationId, 1), partId(seeded.obligationId, 2)]],
    );

    expect(found).toHaveLength(2);

    const human = found.find((r) => r.origin === "human_asserted")!;
    expect(human!.id).toBe(humanId);
    expect(human!.external_ref, "a human assertion names the person who made it").toBe("staff");
    expect(human!.captured_at).toBe(LAST_MONTH);
    expect(human!.extractor).toBeNull();
    expect(human!.confidence).toBeNull();
    expect(human!.source_ref).toBe("s3://evidence/post-01.png");

    const machine = found.find((r) => r.origin === "machine_derived")!;
    expect(machine!.id).toBe(machineId);
    expect(machine!.extractor, "a machine read names the machine").toBe("vlc-stream-indexer");
    expect(machine!.confidence, "a machine read states the machine's own confidence").toBe("0.9200");
    expect(machine!.captured_at).toBe(LAST_MONTH);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 3 — evidence is append-only, and a retraction is a new record
// ---------------------------------------------------------------------------

describe("property 3 — evidence is append-only and a retraction is a new row", () => {
  it("REFUSES to UPDATE evidence, by trigger and by grant", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "14141441-0000-0000-0000-0000000000c1",
      obligationId: "14141441-0000-0000-0000-0000000000b1",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
    });

    // Mechanism one: the trigger, which refuses EVERYONE including the schema owner
    // running a migration by hand.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE obligation_evidence SET quantity = 99
           WHERE org_id = '${ORG_A}' AND id = '${evidenceId}'
        `),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "updating evidence as the schema owner",
    );

    // Mechanism two: the GRANT, which removes the permission before it is attempted.
    // Asserted over the catalogue rather than by trying it, because trying it as the
    // owner would test the trigger a second time.
    const grants = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'obligation_evidence' AND grantee = 'raptor_app'
          AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(grants, "the application role must hold no UPDATE or DELETE on evidence").toHaveLength(0);

    // And the row is untouched: an evidence row that now says something else is worse
    // than no evidence at all.
    const after = await ownerRows<{ quantity: number }>(
      "SELECT quantity FROM obligation_evidence WHERE org_id = $1 AND id = $2",
      [ORG_A, evidenceId],
    );
    expect(after[0]!.quantity).toBe(1);
  });

  it("REFUSES to DELETE evidence", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "14141441-0000-0000-0000-0000000000c2",
      obligationId: "14141441-0000-0000-0000-0000000000b2",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
    });

    await expectSqlstate(
      () => asOwner(`DELETE FROM obligation_evidence WHERE org_id = '${ORG_A}' AND id = '${evidenceId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting evidence",
    );
  });

  it("retracts by a new append-only record that leaves the evidence itself untouched", async () => {
    // The shape of the whole argument: the evidence is a fact about what happened, so
    // the act that takes it back must not be able to edit it. Both rows exist afterwards.
    const seeded = await seedOpenSponsorship({
      contractId: "14141441-0000-0000-0000-0000000000c3",
      obligationId: "14141441-0000-0000-0000-0000000000b3",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
    });

    await retractEvidence({
      obligationId: seeded.obligationId,
      evidenceId,
      retractionId: "14141441-0000-0000-0000-0000000000a1",
      reason: "The stream link was a private replay",
    });

    const found = await ownerRows<{
      evidences: number;
      retractions: number;
      quantity_still_there: number;
      reason: string;
    }>(
      `SELECT (SELECT count(*)::int FROM obligation_evidence          WHERE org_id = $1 AND id = $2) AS evidences,
              (SELECT count(*)::int FROM obligation_evidence_retraction WHERE org_id = $1 AND obligation_evidence_id = $2) AS retractions,
              (SELECT quantity FROM obligation_evidence WHERE org_id = $1 AND id = $2) AS quantity_still_there,
              (SELECT reason FROM obligation_evidence_retraction WHERE org_id = $1 AND obligation_evidence_id = $2) AS reason`,
      [ORG_A, evidenceId],
    );

    expect(found[0]!.evidences, "the evidence survives its own retraction").toBe(1);
    expect(found[0]!.retractions).toBe(1);
    expect(found[0]!.quantity_still_there, "the retracted row is not rewritten").toBe(1);
    expect(found[0]!.reason, "the reason travels with the retraction").toBe(
      "The stream link was a private replay",
    );
  });

  it("REFUSES to mutate or delete a retraction", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "14141441-0000-0000-0000-0000000000c4",
      obligationId: "14141441-0000-0000-0000-0000000000b4",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
    });

    await retractEvidence({
      obligationId: seeded.obligationId,
      evidenceId,
      retractionId: "14141441-0000-0000-0000-0000000000a2",
      reason: "Duplicate capture",
    });

    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE obligation_evidence_retraction SET reason = 'Never happened'
            WHERE org_id = '${ORG_A}' AND obligation_evidence_id = '${evidenceId}'`,
        ),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "rewriting the reason a retraction was made",
    );

    await expectSqlstate(
      () =>
        asOwner(
          `DELETE FROM obligation_evidence_retraction
            WHERE org_id = '${ORG_A}' AND obligation_evidence_id = '${evidenceId}'`,
        ),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting a retraction, so the record of the retraction is permanent",
    );

    // The premise, asserted so the DELETE above cannot pass by matching zero rows: a
    // DELETE that removes nothing also "succeeds".
    const present = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM obligation_evidence_retraction WHERE org_id = $1",
      [ORG_A],
    );
    expect(present[0]!.n).toBe(1);
  });

  it("REFUSES a retraction with no reason, and a second retraction of one evidence row", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "14141441-0000-0000-0000-0000000000c5",
      obligationId: "14141441-0000-0000-0000-0000000000b5",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
    });

    const retraction = (id: string, reason: string): string => `
      INSERT INTO obligation_evidence_retraction
        (id, org_id, obligation_evidence_id, retracted_by_person_id, retracted_at, reason)
      VALUES ('${id}', '${ORG_A}', '${evidenceId}', '${STAFF_A}', '${LAST_MONTH}', ${sql(reason)})
    `;

    await expectSqlstate(
      () => asOwner(retraction("14141441-0000-0000-0000-0000000000a3", "   ")),
      SQLSTATE_CHECK_VIOLATION,
      "a retraction with a blank reason",
    );

    await retractEvidence({
      obligationId: seeded.obligationId,
      evidenceId,
      retractionId: "14141441-0000-0000-0000-0000000000a4",
      reason: "Recorded in error",
    });

    // The second attempt keeps the parent move, so it can only be refused by the UNIQUE
    // index and not by the deferred discharge guard firing on the way out.
    await expectSqlstate(
      () =>
        retractEvidence({
          obligationId: seeded.obligationId,
          evidenceId,
          retractionId: "14141441-0000-0000-0000-0000000000a5",
          reason: "Also in error",
        }),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second retraction of the same evidence row",
    );
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 4 — the chain is verifiable from one place, and the stored state cannot drift
// ---------------------------------------------------------------------------

describe("property 4 — the chain is verifiable from one place and the stored state cannot disagree", () => {
  it("answers, for one obligation, which parts are done, which are outstanding, and therefore whether it is discharged", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "15151515-0000-0000-0000-0000000000c1",
      obligationId: "15151515-0000-0000-0000-0000000000b1",
      partCount: 2,
    });

    await assertEvidenceAndFulfilPart({ obligationId: seeded.obligationId, partIndex: 1 });

    // ONE query answers the whole chain. This is the completion criterion: what was owed,
    // what was delivered, what evidence supports each done part, and the "therefore".
    const rows = await ownerRows<{
      obligation_id: string;
      part_id: string;
      promised_quantity: number;
      supported_quantity: number;
      part_state: string;
      discharge_status: string;
      evidence_count: number;
      derived_state: string;
      stored_state: string;
      states_agree: boolean;
    }>(
      `SELECT obligation_id, part_id, promised_quantity, supported_quantity,
              part_state, discharge_status, evidence_count, derived_state, stored_state, states_agree
         FROM public.obligation_discharge_report($1::uuid)`,
      [seeded.obligationId],
    );

    expect(rows).toHaveLength(2);

    const done = rows.find((r) => r.part_id === partId(seeded.obligationId, 1))!;
    expect(done!.discharge_status).toBe("fulfilled");
    expect(done!.promised_quantity).toBe(1);
    expect(done!.supported_quantity, "the evidence is what supports the part").toBe(1);
    expect(done!.evidence_count).toBe(1);

    const outstanding = rows.find((r) => r.part_id === partId(seeded.obligationId, 2))!;
    expect(outstanding!.discharge_status).toBe("not_started");
    expect(outstanding!.supported_quantity).toBe(0);
    expect(outstanding!.evidence_count).toBe(0);

    // And the "therefore", on every row, computed rather than asserted. One part of two is
    // partial progress: the derived state says so, the stored state was forced to agree,
    // and the report says whether they do.
    expect(rows.every((r) => r.derived_state === "partially_fulfilled")).toBe(true);
    expect(rows.every((r) => r.stored_state === r.derived_state)).toBe(true);
    expect(rows.every((r) => r.states_agree)).toBe(true);
  });

  it("REFUSES a commit in which the stored state and the derived aggregate disagree", async () => {
    // The drift case, and the reason the aggregate is recomputed rather than trusted.
    // A parent that says 'discharged' while a part is outstanding is exactly the claim
    // that a stored flag makes possible.
    const seeded = await seedOpenSponsorship({
      contractId: "15151515-0000-0000-0000-0000000000c2",
      obligationId: "15151515-0000-0000-0000-0000000000b2",
      partCount: 2,
    });

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO obligation_evidence
              (id, org_id, obligation_part_id, origin, quantity, captured_at,
               captured_by_person_id, source_ref)
            VALUES ('15151515-0000-0000-0000-0000000090a1', '${ORG_A}',
                    '${partId(seeded.obligationId, 1)}', 'human_asserted', 1, '${LAST_MONTH}',
                    '${STAFF_A}', 's3://evidence/stream-01.mp4');

            UPDATE contract_obligation_part SET state = 'fulfilled'
             WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 2)}';

            -- The stale flag: ONE part done, parent claims fully discharged.
            UPDATE contract_obligation SET state = 'discharged'
             WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a stored 'discharged' with one part still outstanding",
    );

    const after = await ownerRows<{ state: string; done_parts: number }>(
      `SELECT o.state::text AS state,
              (SELECT count(*)::int
                 FROM contract_obligation_part p
                WHERE p.org_id = o.org_id AND p.obligation_id = o.id AND p.state = 'fulfilled') AS done_parts
         FROM contract_obligation o WHERE o.org_id = $1 AND o.id = $2`,
      [ORG_A, seeded.obligationId],
    );
    expect(after[0]!.state, "the refused commit left the stored state alone").toBe("open");
    expect(after[0]!.done_parts, "and left no partial fulfilment behind").toBe(0);
  });

  it("re-judges the aggregate when a retraction removes the last supporting evidence", async () => {
    // The case a hand-set flag cannot survive. Retracting the only evidence row drops the
    // supported quantity to zero, so the obligation is no longer discharged — and the
    // commit is refused unless the parent state moves with it, in the same transaction.
    // That is the ledger-reversal shape 0004 uses, and it is deliberate.
    const seeded = await seedOpenSponsorship({
      contractId: "15151515-0000-0000-0000-0000000000c3",
      obligationId: "15151515-0000-0000-0000-0000000000b3",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
    });

    await asOwner(`
      BEGIN;
        UPDATE contract_obligation SET state = 'discharged'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    // Retraction alone, with the parent left claiming 'discharged'. The database refuses,
    // because the aggregate and the flag would otherwise disagree.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO obligation_evidence_retraction
              (id, org_id, obligation_evidence_id, retracted_by_person_id, retracted_at, reason)
            VALUES ('15151515-0000-0000-0000-0000000000a1', '${ORG_A}', '${evidenceId}',
                    '${STAFF_A}', '${LAST_MONTH}', 'The capture was of a private replay');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "retracting the last evidence while the parent still claims 'discharged'",
    );

    // The legal path: retract AND move the parent back, in one transaction.
    await asOwner(`
      BEGIN;
        INSERT INTO obligation_evidence_retraction
          (id, org_id, obligation_evidence_id, retracted_by_person_id, retracted_at, reason)
        VALUES ('15151515-0000-0000-0000-0000000000a2', '${ORG_A}', '${evidenceId}',
                '${STAFF_A}', '${LAST_MONTH}', 'The capture was of a private replay');

        UPDATE contract_obligation SET state = 'open'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    const after = await ownerRows<{
      state: string;
      supported_quantity: number;
      discharge_status: string;
      states_agree: boolean;
    }>(
      `SELECT o.state::text AS state,
              0 AS supported_quantity,
              'not_started' AS discharge_status,
              (o.state = public.obligation_derived_state(o.id)) AS states_agree
         FROM contract_obligation o WHERE o.org_id = $1 AND o.id = $2`,
      [ORG_A, seeded.obligationId],
    );
    expect(after[0]!.state).toBe("open");
    expect(after[0]!.states_agree, "the retraction and the flag agree again").toBe(true);
  });

  it("answers the discharge question from the session, so a caller cannot choose the tenant", async () => {
    // ADR-0011 rule 3. The report takes an obligation id and NOTHING else; the tenant
    // comes from `current_org_id()`. Asserted over the catalogue as well as behaviourally,
    // because a signature that grew an org parameter would compile and run.
    const seeded = await seedOpenSponsorship({
      contractId: "15151515-0000-0000-0000-0000000000c4",
      obligationId: "15151515-0000-0000-0000-0000000000b4",
      partCount: 3,
    });
    await assertEvidenceAndFulfilPart({ obligationId: seeded.obligationId, partIndex: 1 });

    const signature = await ownerRows<{ in_args: string }>(
      `SELECT pg_get_function_arguments(p.oid) AS in_args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'obligation_discharge_report'`,
    );
    expect(signature).toHaveLength(1);
    expect(signature[0]!.in_args).toContain("p_obligation_id");
    expect(signature[0]!.in_args, "the caller must not choose which tenant they ask about").not.toMatch(/org/i);

    // ORG_A's session sees one row per part, and the fixture wrote three.
    const asA = await appRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.obligation_discharge_report($1::uuid)",
      [seeded.obligationId],
    );
    expect(asA[0]!.n).toBe(3);

    // ORG_B's session, asking the identical question, sees nothing.
    await asApp(async () => {
      const found = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.obligation_discharge_report($1::uuid)",
        [seeded.obligationId],
      );
      expect(found.rows[0]!.n, "one tenant's obligation must not be reportable to another").toBe(0);
    }, ORG_B);

    // And with no session tenant it fails closed rather than answering for everybody.
    await asApp(async () => {
      const found = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.obligation_discharge_report($1::uuid)",
        [seeded.obligationId],
      );
      expect(found.rows[0]!.n).toBe(0);
    });
  });

  it("stores no hand-set fulfilment flag anywhere on the obligation", async () => {
    // The absence, asserted. A boolean column would make every guard above bypassable by
    // a query that read the column instead of the aggregate, and it could be set by
    // exactly one careless UPDATE.
    const offenders = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (column_name ~ '(is_fulfilled|is_complete|is_done|fulfilment_status|completion)'
               OR column_name ~ '(is_over_fulfilled|is_fully_fulfilled)')
        ORDER BY table_name, column_name`,
    );

    expect(
      offenders.map((r) => `${r.table_name}.${r.column_name}`),
      "fulfilment must be an aggregate over parts and evidence, never a stored flag",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 5 — quantities are exact, and over-fulfilment is a distinct reportable state
// ---------------------------------------------------------------------------

describe("property 5 — quantities are exact and over-fulfilment is reportable, not silently accepted", () => {
  it("REFUSES to fulfil a part promising 4 with evidence proving 3", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "16161616-0000-0000-0000-0000000000c1",
      obligationId: "16161616-0000-0000-0000-0000000000b1",
      partCount: 1,
    });

    // The part promises FOUR streams. Raise its promise so the fixture states it rather
    // than leaving it implicit in the seed.
    await asOwner(`
      BEGIN;
        UPDATE contract_obligation_part SET promised_quantity = 4
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';
      COMMIT;
    `);

    // Three streams evidenced. Three is not four.
    await asOwner(`
      BEGIN;
        INSERT INTO obligation_evidence
          (id, org_id, obligation_part_id, origin, quantity, captured_at,
           captured_by_person_id, source_ref)
        VALUES ('16161616-0000-0000-0000-0000000090a1', '${ORG_A}',
                '${partId(seeded.obligationId, 1)}', 'human_asserted', 3, '${LAST_MONTH}',
                '${STAFF_A}', 's3://evidence/three-streams.mp4');
      COMMIT;
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            UPDATE contract_obligation_part SET state = 'fulfilled'
             WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "fulfilling a part of 4 with evidence of 3",
    );

    const after = await ownerRows<{ state: string; promised_quantity: number }>(
      "SELECT state::text AS state, promised_quantity FROM contract_obligation_part WHERE org_id = $1 AND id = $2",
      [ORG_A, partId(seeded.obligationId, 1)],
    );
    expect(after[0]!.state, "the refused fulfilment did not move the part").toBe("outstanding");
    expect(after[0]!.promised_quantity).toBe(4);
  });

  it("accepts the fourth stream, and refuses a fifth", async () => {
    // The boundary on both sides, so "at least the promised quantity" is a claim about the
    // exact number rather than about a comparison that always leans one way.
    const seeded = await seedOpenSponsorship({
      contractId: "16161616-0000-0000-0000-0000000000c2",
      obligationId: "16161616-0000-0000-0000-0000000000b2",
      partCount: 1,
    });

    await asOwner(`
      BEGIN;
        UPDATE contract_obligation_part SET promised_quantity = 4
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';

        INSERT INTO obligation_evidence
          (id, org_id, obligation_part_id, origin, quantity, captured_at,
           captured_by_person_id, source_ref)
        VALUES ('16161616-0000-0000-0000-0000000090a1', '${ORG_A}',
                '${partId(seeded.obligationId, 1)}', 'human_asserted', 4, '${LAST_MONTH}',
                '${STAFF_A}', 's3://evidence/four-streams.mp4');

        UPDATE contract_obligation_part SET state = 'fulfilled'
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';

        UPDATE contract_obligation SET state = 'discharged'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    const discharged = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM contract_obligation WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.obligationId],
    );
    expect(discharged[0]!.state, "exactly the promised quantity IS fulfilled").toBe("discharged");

    // A fifth stream, on a second evidence row.
    await asOwner(`
      BEGIN;
        INSERT INTO obligation_evidence
          (id, org_id, obligation_part_id, origin, quantity, captured_at,
           captured_by_person_id, source_ref)
        VALUES ('16161616-0000-0000-0000-0000000090a2', '${ORG_A}',
                '${partId(seeded.obligationId, 1)}', 'human_asserted', 1, '${LAST_MONTH}',
                '${STAFF_A}', 's3://evidence/bonus-stream.mp4');
      COMMIT;
    `);

    const report = await ownerRows<{ promised_quantity: number; supported_quantity: number; discharge_status: string }>(
      `SELECT promised_quantity, supported_quantity, discharge_status
         FROM public.obligation_discharge_report($1::uuid)`,
      [seeded.obligationId],
    );
    expect(report[0]!.promised_quantity).toBe(4);
    expect(report[0]!.supported_quantity, "five streams really were delivered").toBe(5);
    expect(
      report[0]!.discharge_status,
      "over-fulfilment is its own reportable state, distinct from plain fulfilment",
    ).toBe("over_fulfilled");
  });

  it("keeps over-fulfilment out of the discharge arithmetic only as a LABEL, never as a refusal", async () => {
    // THE DECISION, tested: over-fulfilment does NOT block the discharge. A sponsor who
    // got five streams instead of four is owed nothing further and the obligation IS
    // discharged; `over_fulfilled` is a reportable surplus, not an error. Refusing it
    // would make generosity unrepresentable, and silently absorbing it would make it
    // unreportable.
    const seeded = await seedOpenSponsorship({
      contractId: "16161616-0000-0000-0000-0000000000c3",
      obligationId: "16161616-0000-0000-0000-0000000000b3",
      partCount: 1,
    });

    await asOwner(`
      BEGIN;
        UPDATE contract_obligation_part SET promised_quantity = 2
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';

        INSERT INTO obligation_evidence
          (id, org_id, obligation_part_id, origin, quantity, captured_at,
           captured_by_person_id, source_ref)
        VALUES ('16161616-0000-0000-0000-0000000090a1', '${ORG_A}',
                '${partId(seeded.obligationId, 1)}', 'human_asserted', 5, '${LAST_MONTH}',
                '${STAFF_A}', 's3://evidence/five-streams.mp4');

        UPDATE contract_obligation_part SET state = 'fulfilled'
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';

        -- The parent may be discharged with a SURPLUS, and the database accepts it.
        UPDATE contract_obligation SET state = 'discharged'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    const found = await ownerRows<{
      state: string;
      derived_state: string;
      states_agree: boolean;
      discharge_status: string;
      supported_quantity: number;
    }>(
      `SELECT o.state::text AS state,
              public.obligation_derived_state(o.id) AS derived_state,
              (o.state = public.obligation_derived_state(o.id)) AS states_agree,
              r.discharge_status,
              r.supported_quantity
         FROM contract_obligation o
         CROSS JOIN LATERAL public.obligation_discharge_report(o.id) r
        WHERE o.org_id = $1 AND o.id = $2`,
      [ORG_A, seeded.obligationId],
    );

    expect(found[0]!.state).toBe("discharged");
    expect(found[0]!.derived_state).toBe("discharged");
    expect(found[0]!.states_agree).toBe(true);
    expect(found[0]!.discharge_status).toBe("over_fulfilled");
    expect(found[0]!.supported_quantity).toBe(5);
  });

  it("reports a part still claiming 'fulfilled' whose evidence has been retracted as under-fulfilled", async () => {
    // The state a naive system hides. The part row still says 'fulfilled' — it cannot be
    // edited, the evidence is append-only, and nobody has corrected the flag — but the
    // evidence behind it is gone. The report says so, and the parent's aggregate stops
    // counting it.
    const seeded = await seedOpenSponsorship({
      contractId: "16161616-0000-0000-0000-0000000000c4",
      obligationId: "16161616-0000-0000-0000-0000000000b4",
      partCount: 1,
    });
    const evidenceId = await assertEvidenceAndFulfilPart({
      obligationId: seeded.obligationId,
      partIndex: 1,
      quantity: 2,
    });

    await asOwner(`
      BEGIN;
        UPDATE contract_obligation_part SET promised_quantity = 2
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';

        UPDATE contract_obligation SET state = 'discharged'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    // Retract, and move the parent off 'discharged' so the commit is legal.
    await asOwner(`
      BEGIN;
        INSERT INTO obligation_evidence_retraction
          (id, org_id, obligation_evidence_id, retracted_by_person_id, retracted_at, reason)
        VALUES ('16161616-0000-0000-0000-0000000000a1', '${ORG_A}', '${evidenceId}',
                '${STAFF_A}', '${LAST_MONTH}', 'Both captures were of the same stream');

        UPDATE contract_obligation SET state = 'open'
         WHERE org_id = '${ORG_A}' AND id = '${seeded.obligationId}';
      COMMIT;
    `);

    const report = await ownerRows<{
      part_state: string;
      discharge_status: string;
      supported_quantity: number;
      promised_quantity: number;
      evidence_count: number;
      derived_state: string;
    }>(
      `SELECT part_state, discharge_status, supported_quantity, promised_quantity,
              evidence_count, derived_state
         FROM public.obligation_discharge_report($1::uuid)`,
      [seeded.obligationId],
    );

    expect(report[0]!.part_state, "the part row itself still claims fulfilment").toBe("fulfilled");
    expect(
      report[0]!.discharge_status,
      "and the report refuses to repeat the claim: the evidence is gone",
    ).toBe("under_fulfilled");
    expect(report[0]!.supported_quantity, "retracted evidence does not count").toBe(0);
    expect(report[0]!.promised_quantity).toBe(2);
    expect(report[0]!.evidence_count).toBe(0);
    expect(report[0]!.derived_state, "so the obligation is not discharged").toBe("open");
  });

  it("REFUSES a promised quantity of zero or a negative one", async () => {
    const seeded = await seedOpenSponsorship({
      contractId: "16161616-0000-0000-0000-0000000000c5",
      obligationId: "16161616-0000-0000-0000-0000000000b5",
      partCount: 1,
    });

    const setPromise = (quantity: string): string => `
      BEGIN;
        UPDATE contract_obligation_part SET promised_quantity = ${quantity}
         WHERE org_id = '${ORG_A}' AND id = '${partId(seeded.obligationId, 1)}';
      COMMIT;
    `;

    // Zero is the worst of them: a part promising nothing is discharged the moment it is
    // created, which is the "fulfilled with nothing behind it" defect wearing a quantity.
    await expectSqlstate(
      () => asOwner(setPromise("0")),
      SQLSTATE_CHECK_VIOLATION,
      "a part promising zero",
    );

    await expectSqlstate(
      () => asOwner(setPromise("-1")),
      SQLSTATE_CHECK_VIOLATION,
      "a part promising a negative quantity",
    );
  });
});

// ---------------------------------------------------------------------------
// INVENTORY — a ledger of movements, never a stored balance
// ---------------------------------------------------------------------------

describe("inventory — a ledger of movements, never a stored balance", () => {
  it("stores no balance column on the item, and derives the position from movements", async () => {
    // THE DECISION, asserted structurally. ADR-0016 recorded a drifting balance in the
    // legacy slot system as a real defect, and 0004 refused the stored counter for
    // budgets on exactly that ground. Inventory is therefore a LEDGER: `inventory_item`
    // says what a thing is, `inventory_movement` says what happened, and the position is
    // derived on every read so there is no counter left to drift.
    const offenders = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('inventory_item', 'inventory_movement')
          AND column_name ~ '(on_hand|balance|in_stock|available|remaining|reserved)'
        ORDER BY table_name, column_name`,
    );

    expect(
      offenders.map((r) => `${r.table_name}.${r.column_name}`),
      "a stored balance is a number that can drift away from the movements that produced it",
    ).toEqual([]);
  });

  it("derives on-hand and committed from movements, and answers available as the difference", async () => {
    await asOwner(`
      INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from)
      VALUES ('17171717-0000-0000-0000-0000000000c1', '${ORG_A}', 'CHAIR', 'Gaming Chair', 'each', '${LAST_YEAR}');

      BEGIN;
        INSERT INTO inventory_movement
          (id, org_id, item_id, kind, quantity, occurred_at, reference)
        VALUES
          ('17171717-0000-0000-0000-0000000000a1', '${ORG_A}', '17171717-0000-0000-0000-0000000000c1',
           'receipt', 10, '${LAST_YEAR}', 'PO-1001'),
          ('17171717-0000-0000-0000-0000000000a2', '${ORG_A}', '17171717-0000-0000-0000-0000000000c1',
           'issue', -4, '${MID_YEAR}', 'EVENT-1 setup'),
          ('17171717-0000-0000-0000-0000000000a3', '${ORG_A}', '17171717-0000-0000-0000-0000000000c1',
           'commitment', 3, '${MID_YEAR}', 'Partner hold for Final');
      COMMIT;
    `);

    const found = await ownerRows<{
      sku: string;
      unit: string;
      on_hand: number;
      committed: number;
      available: number;
      movements_counted: number;
    }>(
      `SELECT sku, unit, on_hand, committed, available, movements_counted
         FROM public.inventory_position WHERE org_id = $1`,
      [ORG_A],
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.sku).toBe("CHAIR");
    expect(found[0]!.unit, "the unit is named, so a count is never unit-ambiguous").toBe("each");
    expect(found[0]!.on_hand, "10 in, 4 out").toBe(6);
    expect(found[0]!.committed, "a commitment is owed but not yet owned").toBe(3);
    expect(found[0]!.available, "available is on-hand minus what is already promised").toBe(3);
    expect(found[0]!.movements_counted).toBe(3);
  });

  it("REFUSES a commit that issues more of an item than exists", async () => {
    // The one thing a movements ledger can still get wrong, and the reason the balance
    // is checked at COMMIT rather than trusted: you cannot hand out chairs you do not have.
    // Deferred, so a batch of movements for one delivery is judged once, at the end —
    // an IMMEDIATE check would refuse a batch that fits and admit one that does not,
    // depending on the order the rows arrived in.
    await asOwner(`
      INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from)
      VALUES ('17171717-0000-0000-0000-0000000000c2', '${ORG_A}', 'DESK', 'Standing Desk', 'each', '${LAST_YEAR}');
    `);

    await asOwner(`
      BEGIN;
        INSERT INTO inventory_movement (id, org_id, item_id, kind, quantity, occurred_at, reference)
        VALUES ('17171717-0000-0000-0000-0000000000b1', '${ORG_A}',
                '17171717-0000-0000-0000-0000000000c2', 'receipt', 10, '${LAST_YEAR}', 'PO-1002');
      COMMIT;
    `);

    // Six of ten: legal.
    await asOwner(`
      BEGIN;
        INSERT INTO inventory_movement (id, org_id, item_id, kind, quantity, occurred_at, reference)
        VALUES ('17171717-0000-0000-0000-0000000000b2', '${ORG_A}',
                '17171717-0000-0000-0000-0000000000c2', 'issue', -6, '${MID_YEAR}', 'Studio build');
      COMMIT;
    `);

    const legal = await ownerRows<{ on_hand: number }>(
      "SELECT on_hand FROM public.inventory_position WHERE org_id = $1",
      [ORG_A],
    );
    expect(legal[0]!.on_hand).toBe(4);

    // Nine more from four: refused at COMMIT, and nothing is left behind.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO inventory_movement (id, org_id, item_id, kind, quantity, occurred_at, reference)
            VALUES ('17171717-0000-0000-0000-0000000000b3', '${ORG_A}',
                    '17171717-0000-0000-0000-0000000000c2', 'issue', -9, '${LAST_MONTH}', 'Over-issue');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "issuing nine of an item with four on hand",
    );

    const after = await ownerRows<{ on_hand: number; movements_counted: number }>(
      "SELECT on_hand, movements_counted FROM public.inventory_position WHERE org_id = $1",
      [ORG_A],
    );
    expect(after[0]!.on_hand, "a refused movement leaves the position unchanged").toBe(4);
    expect(after[0]!.movements_counted, "and leaves no row behind").toBe(2);
  });

  it("REFUSES a movement whose sign contradicts its kind", async () => {
    // A receipt that subtracts is either a typo or a lie, and both make the derived
    // position wrong in a way nobody could later detect. The sign is bound to the kind.
    await asOwner(`
      BEGIN;
        INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from)
        VALUES ('17171717-0000-0000-0000-0000000000c3', '${ORG_A}', 'HEADSET', 'Headset', 'each', '${LAST_YEAR}');
      COMMIT;
    `);

    const movement = (id: string, kind: string, quantity: number): string => `
      BEGIN;
        INSERT INTO inventory_movement (id, org_id, item_id, kind, quantity, occurred_at, reference)
        VALUES ('${id}', '${ORG_A}', '17171717-0000-0000-0000-0000000000c3',
                '${kind}', ${quantity}, '${MID_YEAR}', 'REF-1');
      COMMIT;
    `;

    await expectSqlstate(
      () => asOwner(movement("17171717-0000-0000-0000-0000000000b4", "receipt", -5)),
      SQLSTATE_CHECK_VIOLATION,
      "a receipt of a negative quantity",
    );

    await expectSqlstate(
      () => asOwner(movement("17171717-0000-0000-0000-0000000000b5", "issue", 5)),
      SQLSTATE_CHECK_VIOLATION,
      "an issue of a positive quantity",
    );

    await expectSqlstate(
      () => asOwner(movement("17171717-0000-0000-0000-0000000000b6", "release", 5)),
      SQLSTATE_CHECK_VIOLATION,
      "a release of a positive quantity",
    );

    // A receipt first, so the sign checks below are judged on the SIGN and not on the
    // over-issue guard. Without it every movement here would be refused for running the
    // balance negative, and this test would pass for the wrong reason.
    await asOwner(movement("17171717-0000-0000-0000-0000000000b9", "receipt", 10));

    // An adjustment may go either way — that is what an adjustment is — and a zero
    // movement is a note wearing a quantity's name.
    await asOwner(movement("17171717-0000-0000-0000-0000000000b7", "adjustment", -1));
    await expectSqlstate(
      () => asOwner(movement("17171717-0000-0000-0000-0000000000b8", "adjustment", 0)),
      SQLSTATE_CHECK_VIOLATION,
      "a movement of zero quantity",
    );
  });

  it("REFUSES an effective window that ends before it begins, and two overlapping windows for one sku", async () => {
    await asOwner(`
      BEGIN;
        INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from)
        VALUES ('17171717-0000-0000-0000-0000000000c4', '${ORG_A}', 'MOUSE', 'Mouse', 'each', '${LAST_YEAR}');
      COMMIT;
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from, valid_to)
            VALUES ('17171717-0000-0000-0000-0000000000c5', '${ORG_A}', 'MOUSE', 'Mouse v2', 'each',
                    '${LAST_MONTH}', '${LAST_YEAR}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an inventory window that ends before it begins",
    );

    // Effective dating must answer "which version of this thing was in force on that
    // date" with exactly one row, so two live windows for one sku are refused by the
    // database rather than resolved by whichever query ran first.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from, valid_to)
            VALUES ('17171717-0000-0000-0000-0000000000c6', '${ORG_A}', 'MOUSE', 'Mouse again', 'each',
                    '${MID_YEAR}', NULL);
          COMMIT;
        `),
      SQLSTATE_EXCLUSION_VIOLATION,
      "a second live inventory window for one sku",
    );

    // And a sku that has genuinely been superseded can coexist, because the first was
    // closed.
    await asOwner(`
      UPDATE inventory_item SET valid_to = '${MID_YEAR}'
       WHERE org_id = '${ORG_A}' AND id = '17171717-0000-0000-0000-0000000000c4'
    `);

    await asOwner(`
      BEGIN;
        INSERT INTO inventory_item (id, org_id, sku, name, unit, valid_from, valid_to)
        VALUES ('17171717-0000-0000-0000-0000000000c7', '${ORG_A}', 'MOUSE', 'Mouse v2', 'each',
                '${MID_YEAR}', NULL);
      COMMIT;
    `);

    const windows = await ownerRows<{ name: string; valid_to: string | null }>(
      `SELECT name, valid_to FROM inventory_item WHERE org_id = $1 AND sku = 'MOUSE' ORDER BY valid_from`,
      [ORG_A],
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]!.name).toBe("Mouse");
    expect(windows[0]!.valid_to, "the superseded window is closed, not deleted").not.toBeNull();
    expect(windows[1]!.name).toBe("Mouse v2");
  });
});

// ---------------------------------------------------------------------------
// PARTNER PIPELINE — a state machine, not a table the application can rewrite
// ---------------------------------------------------------------------------

describe("partner pipeline — the stage is stored and the transitions are data", () => {
  it("seeds an organisation's partner transitions when the organisation is created", async () => {
    // Empty-means-nothing-legal is the safe direction, but it would also mean the machine
    // was never installed. Asserted so the seeding trigger cannot quietly stop firing.
    const found = await ownerRows<{ from_stage: string; to_stage: string; is_irreversible: boolean }>(
      `SELECT from_stage::text, to_stage::text, is_irreversible
         FROM partner_state_transition WHERE org_id = $1
        ORDER BY from_stage::text, to_stage::text`,
      [ORG_A],
    );

    expect(found.length).toBeGreaterThan(4);

    // `|` as the pair separator rather than an arrow. An arrow is meaningful to a reader and
    // fragile to a round-trip through any tool that re-encodes a source file; `|` says the
    // same thing about a SET KEY and cannot be mistaken for prose punctuation.
    const pairs = new Set(found.map((r) => `${r.from_stage}|${r.to_stage}`));
    expect(pairs.has("lead|qualified")).toBe(true);
    expect(pairs.has("negotiation|signed")).toBe(true);
    expect(pairs.has("signed|active")).toBe(true);
    expect(pairs.has("active|lapsed")).toBe(true);

    // A deal cannot be born signed: nothing transitions INTO signed but negotiation, so
    // the shape of the machine is legible without reading the trigger.
    expect([...pairs].filter((p) => p.endsWith("|signed"))).toEqual(["negotiation|signed"]);
  });

  it("REFUSES a stage change that the transition table does not declare", async () => {
    await seedPartner("18181818-0000-0000-0000-0000000000c1", ORG_A, "Acme Corp");

    // lead — signed is a move that reads perfectly sensibly and is not in the machine.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE partner SET stage = 'signed', stage_changed_by_person_id = '${STAFF_A}'
           WHERE org_id = '${ORG_A}' AND id = '18181818-0000-0000-0000-0000000000c1'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an undeclared partner stage change",
    );

    const after = await ownerRows<{ stage: string }>(
      "SELECT stage::text AS stage FROM partner WHERE org_id = $1 AND id = '18181818-0000-0000-0000-0000000000c1'",
      [ORG_A],
    );
    expect(after[0]!.stage, "the refused change did not move the partner").toBe("lead");
  });

  it("REFUSES a declared transition that requires a reason and is given none, and one with no actor", async () => {
    await seedPartner("18181818-0000-0000-0000-0000000000c2", ORG_A, "Globex");

    await asOwner(`
      UPDATE partner SET stage = 'qualified', stage_changed_by_person_id = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '18181818-0000-0000-0000-0000000000c2'
    `);

    // qualified — lapsed requires a stated reason. "We stopped talking to them" is the
    // kind of move a CRM exists to explain.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE partner SET stage = 'lapsed', stage_changed_by_person_id = '${STAFF_A}'
           WHERE org_id = '${ORG_A}' AND id = '18181818-0000-0000-0000-0000000000c2'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a reason-requiring partner transition with no reason",
    );

    // With one, accepted.
    await asOwner(`
      UPDATE partner SET stage = 'lapsed', stage_reason = 'Went with a competitor',
                         stage_changed_by_person_id = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '18181818-0000-0000-0000-0000000000c2'
    `);

    const lapsed = await ownerRows<{ stage: string; stage_reason: string }>(
      "SELECT stage::text AS stage, stage_reason FROM partner WHERE org_id = $1 AND id = '18181818-0000-0000-0000-0000000000c2'",
      [ORG_A],
    );
    expect(lapsed[0]!.stage).toBe("lapsed");
    expect(lapsed[0]!.stage_reason).toBe("Went with a competitor");

    // And a move with nobody named as having made it is not a transition at all.
    await seedPartner("18181818-0000-0000-0000-0000000000c3", ORG_A, "Initech");
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE partner SET stage = 'qualified' WHERE org_id = '${ORG_A}' AND id = '18181818-0000-0000-0000-0000000000c3'`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "a partner stage change with no actor",
    );
  });

  it("REFUSES to declare the reverse of a transition marked irreversible", async () => {
    // Irreversibility that is only a comment is not irreversibility. A later migration —
    // or an operator with psql — must not be able to quietly add `signed → negotiation`
    // after `negotiation → signed` was recorded as one-way. The database refuses the
    // declaration itself, so the machine cannot grow a way back.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO partner_state_transition (org_id, from_stage, to_stage, is_irreversible, description)
          VALUES ('${ORG_A}', 'signed', 'negotiation', false, 'Undo the signing')
        `),
      SQLSTATE_EXCLUSION_VIOLATION,
      "declaring the reverse of an irreversible partner transition",
    );

    // A non-irreversible move may still be reversed, so the rule is not simply "no
    // backwards moves" — which would make an ordinary renegotiation unrepresentable.
    const reversible = await ownerRows<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM partner_state_transition
        WHERE org_id = $1 AND from_stage = 'qualified' AND to_stage = 'lead'`,
      [ORG_A],
    );
    expect(reversible[0]!.n).toBe(0);
  });

  it("walks the whole legal lifecycle and refuses one step out of it", async () => {
    const partnerId = "18181818-0000-0000-0000-0000000000c4";
    await seedPartner(partnerId, ORG_A, "Umbrella");

    const steps: ReadonlyArray<{ stage: string; reason: string | null }> = [
      { stage: "qualified", reason: null },
      { stage: "negotiation", reason: null },
      { stage: "signed", reason: null },
      { stage: "active", reason: null },
    ];

    for (const step of steps) {
      const reasonClause = step.reason === null ? "" : `, stage_reason = ${sql(step.reason)}`;
      await asOwner(`
        UPDATE partner SET stage = '${step.stage}'${reasonClause}, stage_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '${partnerId}'
      `);
    }

    const active = await ownerRows<{ stage: string }>(
      "SELECT stage::text AS stage FROM partner WHERE org_id = $1 AND id = $2",
      [ORG_A, partnerId],
    );
    expect(active[0]!.stage).toBe("active");

    // active — signed is the reverse of an irreversible move, so it is not in the
    // machine, and asking for it is refused rather than silently accepted.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE partner SET stage = 'signed', stage_changed_by_person_id = '${STAFF_A}'
           WHERE org_id = '${ORG_A}' AND id = '${partnerId}'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "moving an active partner back to signed",
    );

    // And the terminal state is genuinely terminal.
    await asOwner(`
      UPDATE partner SET stage = 'lapsed', stage_reason = 'Contract expired',
                         stage_changed_by_person_id = '${STAFF_A}'
       WHERE org_id = '${ORG_A}' AND id = '${partnerId}'
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE partner SET stage = 'active', stage_changed_by_person_id = '${STAFF_A}'
           WHERE org_id = '${ORG_A}' AND id = '${partnerId}'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "reviving a lapsed partner",
    );
  });

  it("does not let the application role edit the partner transition table", async () => {
    // "The database prevents an illegal move" would otherwise be a claim about a table
    // the application owns. Asserted over the catalogue rather than by trying the
    // insert, because a test that merely TRIED it would be satisfied by the grant and
    // would not notice the trigger.
    const grants = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'partner_state_transition' AND grantee = 'raptor_app'
          AND privilege_type IN ('INSERT','UPDATE','DELETE')`,
    );
    expect(grants, "only a migration or an operator may change the legal lifecycle").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CREATORS AND CONTENT — one identity model, and a content state machine
// ---------------------------------------------------------------------------

describe("creators and content", () => {
  it("makes a creator a PERSON, with no second identity model", async () => {
    // ADR-0018 forbids a second identity for the same human. A creator is therefore a
    // `person` row with a creator profile beside it — not a `creator` table with its own
    // name, email and credentials. Asserted structurally: the FK is to `person`, it is
    // NOT NULL, and the profile carries no contact or credential column of its own.
    const columns = await ownerRows<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'creator_profile' ORDER BY column_name`,
    );

    const personId = columns.find((c) => c.column_name === "person_id");
    expect(personId, "a creator profile must name the person it is").toBeDefined();
    expect(personId!.is_nullable, "a creator profile with no person is not a creator").toBe("NO");

    // No second identity: nothing that looks like a login or a contact address.
    const identityLike = columns
      .map((c) => c.column_name)
      .filter((name) => /email|login|password|credential|token|provider|identifier|username|phone/.test(name));
    expect(identityLike, "a creator carries no identity of its own; `person` owns that").toEqual([]);

    const fks = await ownerRows<{ parent_table: string; cols: string[] }>(
      `SELECT parent.relname AS parent_table, array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_constraint con
         JOIN pg_class child  ON child.oid  = con.conrelid
         JOIN pg_class parent ON parent.oid = con.confrelid
         JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE con.contype = 'f' AND child.relname = 'creator_profile'
        GROUP BY parent.relname, con.conname`,
    );

    // TWO foreign keys, and both are load-bearing. `organization` is the tenant root and
    // is referenced the way every tenant table references it; `person` is the identity
    // root. There is no third — and in particular there is nothing resembling an identity
    // of the creator's own.
    expect(fks.map((f) => f.parent_table).sort()).toEqual(["organization", "person"]);

    const toPerson = fks.find((f) => f.parent_table === "person")!;
    // Single-column, and CORRECTLY so: `person` is org-independent by design, so a
    // composite FK to it is not expressible and is not wanted.
    expect(toPerson!.cols).toEqual(["person_id"]);
  });

  it("REFUSES two creator profiles for one person in one organisation", async () => {
    await seedCreator("19191919-0000-0000-0000-0000000000c1", ORG_A, PLAYER_A, "streambar");

    await expectSqlstate(
      () => seedCreator("19191919-0000-0000-0000-0000000000c2", ORG_A, PLAYER_A, "streambar2"),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second creator profile for one person in one org",
    );

    // A different organisation may profile the same human, because the profile is a
    // tenant-scoped fact about them rather than part of who they are.
    await asOwner(`
      INSERT INTO org_membership (id, org_id, person_id, status)
      VALUES ('19191919-0000-0000-0000-0000000000ff', '${ORG_B}', '${PLAYER_A}', 'active')
    `);
    await asOwner(`
      INSERT INTO creator_profile (id, org_id, person_id, handle, display_name)
      VALUES ('19191919-0000-0000-0000-0000000000c3', '${ORG_B}', '${PLAYER_A}', 'streambar', 'Same Human')
    `);

    const profiles = await ownerRows<{ org_id: string }>(
      "SELECT org_id FROM creator_profile WHERE person_id = $1 ORDER BY org_id",
      [PLAYER_A],
    );
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.org_id)).toEqual([ORG_A, ORG_B]);
  });

  it("seeds an organisation's content transitions and REFUSES an undeclared stage change", async () => {
    const seeded = await ownerRows<{ from_state: string; to_state: string }>(
      `SELECT from_state::text, to_state::text
         FROM content_state_transition WHERE org_id = $1
        ORDER BY from_state::text, to_state::text`,
      [ORG_A],
    );

    const pairs = new Set(seeded.map((r) => `${r.from_state}|${r.to_state}`));
    for (const step of [
      "draft|review",
      "review|approved",
      "approved|scheduled",
      "scheduled|published",
      "published|archived",
      "review|draft",
    ]) {
      expect(pairs.has(step), `content lifecycle must declare ${step}`).toBe(true);
    }

    await seedCreator("19191919-0000-0000-0000-0000000000d1", ORG_A, PLAYER_A, "streambar");
    await asOwner(`
      INSERT INTO content_item (id, org_id, creator_id, title, body, state)
      VALUES ('19191919-0000-0000-0000-0000000000b1', '${ORG_A}',
              '19191919-0000-0000-0000-0000000000d1', 'Grand Final Highlights', 'A montage.', 'draft')
    `);

    // draft — published skips review and approval. It reads fine and is not in the machine.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE content_item SET state = 'published', state_changed_by_person_id = '${STAFF_A}'
           WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b1'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "publishing content straight from draft",
    );

    const after = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM content_item WHERE org_id = $1 AND id = '19191919-0000-0000-0000-0000000000b1'",
      [ORG_A],
    );
    expect(after[0]!.state).toBe("draft");
  });

  it("REFUSES to publish content with no artefact to point at", async () => {
    // A published item with no `storage_ref` is a claim that something is live when
    // nothing says what. The URL and the publication instant are both required, and both
    // are supplied by the caller rather than defaulted — a default would be a fabricated
    // instant, which is exactly the class of claim ADR-0019 exists to stop storing.
    await seedCreator("19191919-0000-0000-0000-0000000000d2", ORG_A, PLAYER_A, "clipgirl");
    // Scheduled into the FUTURE. A fixed literal cannot promise this: the scheduling guard
    // refuses an instant that has already passed, so a fixture pinned to the sponsorship
    // season would be refusing a perfectly legal schedule and the whole test below would
    // be asserting the wrong refusal.
    const queuedFor = await futureInstant();
    await asOwner(`
      INSERT INTO content_item (id, org_id, creator_id, title, body, state)
      VALUES ('19191919-0000-0000-0000-0000000000b2', '${ORG_A}',
              '19191919-0000-0000-0000-0000000000d2', 'Behind the Scenes', 'A clip.', 'draft');

      BEGIN;
        UPDATE content_item SET state = 'review', state_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';
        UPDATE content_item SET state = 'approved', state_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';
        UPDATE content_item SET state = 'scheduled', state_changed_by_person_id = '${STAFF_A}',
                                scheduled_for = '${queuedFor}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';
      COMMIT;
    `);

    // No storage_ref and no published_at.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            UPDATE content_item SET state = 'published', published_at = '${LAST_MONTH}',
                                    state_changed_by_person_id = '${STAFF_A}'
             WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "publishing content with no storage_ref",
    );

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            UPDATE content_item SET state = 'published', storage_ref = 'https://cdn.test/clip.mp4',
                                    state_changed_by_person_id = '${STAFF_A}'
             WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "publishing content with no publication instant",
    );

    // Both supplied: accepted, and the state machine is demonstrated walkable.
    await asOwner(`
      BEGIN;
        UPDATE content_item SET state = 'published', storage_ref = 'https://cdn.test/clip.mp4',
                                published_at = '${LAST_MONTH}',
                                state_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';

        UPDATE content_item SET state = 'archived', state_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b2';
      COMMIT;
    `);

    const after = await ownerRows<{ state: string; published_at: string }>(
      `SELECT state::text AS state,
              to_char(published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at
         FROM content_item WHERE org_id = $1 AND id = '19191919-0000-0000-0000-0000000000b2'`,
      [ORG_A],
    );
    expect(after[0]!.state).toBe("archived");
    expect(after[0]!.published_at, "the publication instant is the one supplied, in UTC").toBe(LAST_MONTH);
  });

  it("REFUSES to schedule content for a past instant", async () => {
    await seedCreator("19191919-0000-0000-0000-0000000000d3", ORG_A, PLAYER_A, "caster");
    await asOwner(`
      INSERT INTO content_item (id, org_id, creator_id, title, body, state)
      VALUES ('19191919-0000-0000-0000-0000000000b3', '${ORG_A}',
              '19191919-0000-0000-0000-0000000000d3', 'VOD Review', 'A review.', 'draft');

      BEGIN;
        UPDATE content_item SET state = 'review', state_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b3';
        UPDATE content_item SET state = 'approved', state_changed_by_person_id = '${STAFF_A}'
         WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b3';
      COMMIT;
    `);

    // "Scheduled for" a moment that has already passed is not a schedule.
    const past = await ownerRows<{ d: string }>(
      `SELECT to_char(now() AT TIME ZONE 'UTC' - INTERVAL '30 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS d`,
    );

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            UPDATE content_item SET state = 'scheduled', state_changed_by_person_id = '${STAFF_A}',
                                    scheduled_for = '${past[0]!.d}'
             WHERE org_id = '${ORG_A}' AND id = '19191919-0000-0000-0000-0000000000b3';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "scheduling content for an instant that has already passed",
    );
  });
});

// ---------------------------------------------------------------------------
// INVOICING — the total is derived from the lines
// ---------------------------------------------------------------------------

describe("invoicing — a total that disagrees with its lines is refused", () => {
  /** Two ledger accounts and one balanced journal, for the settlement reference. */
  async function seedSettlementJournal(journalId: string, orgId: string, accountIds: readonly [string, string]): Promise<void> {
    await asOwner(`
      INSERT INTO ledger_account (id, org_id, code, name, account_type, currency)
      VALUES ('${accountIds[0]}', '${orgId}', '1100', 'Accounts Receivable', 'asset', '${INR}'),
             ('${accountIds[1]}', '${orgId}', '4000', 'Sponsorship Revenue', 'revenue', '${INR}');

      BEGIN;
        INSERT INTO ledger_journal (id, org_id, description, source_kind, posting_period, currency)
        VALUES ('${journalId}', '${orgId}', 'Sponsorship invoice settlement', 'settlement', '2025-02-01', '${INR}');

        INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
        VALUES ('${orgId}', '${journalId}', 1, '${accountIds[0]}', 'debit',  5000.0000, '${INR}'),
               ('${orgId}', '${journalId}', 2, '${accountIds[1]}', 'credit', 5000.0000, '${INR}');
      COMMIT;
    `);
  }

  const ACC_RECEIVABLE = "21212121-0000-0000-0000-0000000000a1";
  const ACC_REVENUE = "21212121-0000-0000-0000-0000000000a2";

  it("REFUSES an invoice whose total disagrees with its lines", async () => {
    // THE claim. A supplied total that the lines do not support is a defect, not a
    // rounding convenience: it is how an organisation bills one number and accounts for
    // another, and the difference is only ever found by a human, late.
    await seedPartner("21212121-0000-0000-0000-0000000000c1", ORG_A, "Acme Corp");

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO invoice
              (id, org_id, partner_id, invoice_number, currency, total_amount, state, issued_at)
            VALUES ('21212121-0000-0000-0000-0000000000b1', '${ORG_A}',
                    '21212121-0000-0000-0000-0000000000c1', 'INV-2026-001', '${INR}',
                    10000.0000, 'issued', '${LAST_MONTH}');

            INSERT INTO invoice_line (org_id, invoice_id, line_no, description, amount, currency)
            VALUES ('${ORG_A}', '21212121-0000-0000-0000-0000000000b1', 1,
                    'Season sponsorship', 4000.0000, '${INR}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an invoice totalling 10000 with one line of 4000",
    );

    // Nothing was written: a refused invoice leaves no partial history behind.
    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM invoice WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("accepts an invoice whose total is exactly its lines, and keeps four decimal places", async () => {
    await seedPartner("21212121-0000-0000-0000-0000000000c2", ORG_A, "Globex");

    await asOwner(`
      BEGIN;
        INSERT INTO invoice
          (id, org_id, partner_id, invoice_number, currency, total_amount, state, issued_at)
        VALUES ('21212121-0000-0000-0000-0000000000b2', '${ORG_A}',
                '21212121-0000-0000-0000-0000000000c2', 'INV-2026-002', '${INR}',
                6123.4500, 'issued', '${LAST_MONTH}');

        INSERT INTO invoice_line (org_id, invoice_id, line_no, description, amount, currency)
        VALUES ('${ORG_A}', '21212121-0000-0000-0000-0000000000b2', 1, 'Season sponsorship', 6000.0000, '${INR}'),
               ('${ORG_A}', '21212121-0000-0000-0000-0000000000b2', 2, 'Creator appearance', 123.4500, '${INR}');
      COMMIT;
    `);

    const found = await ownerRows<{
      invoice_number: string;
      total_amount: string;
      line_amount: string;
      line_count: number;
    }>(
      `SELECT i.invoice_number, i.total_amount::text AS total_amount,
              l.amount::text AS line_amount, l.line_no::int AS line_count
         FROM invoice i
         JOIN invoice_line l ON l.org_id = i.org_id AND l.invoice_id = i.id
        WHERE i.org_id = $1 AND l.line_no = 2`,
      [ORG_A],
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.invoice_number).toBe("INV-2026-002");
    expect(found[0]!.total_amount, "the total survives storage at four decimal places").toBe("6123.4500");
    expect(found[0]!.line_amount).toBe("123.4500");
  });

  it("REFUSES an issued invoice with no lines, and a line quoted in another currency", async () => {
    await seedPartner("21212121-0000-0000-0000-0000000000c3", ORG_A, "Initech");

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO invoice
              (id, org_id, partner_id, invoice_number, currency, total_amount, state, issued_at)
            VALUES ('21212121-0000-0000-0000-0000000000b3', '${ORG_A}',
                    '21212121-0000-0000-0000-0000000000c3', 'INV-2026-003', '${INR}',
                    0.0000, 'issued', '${LAST_MONTH}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an issued invoice with no lines",
    );

    // A line in USD inside an INR invoice is a conversion somebody performed at no rate
    // and recorded nowhere — the same refusal 0004 makes on a journal.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            INSERT INTO invoice
              (id, org_id, partner_id, invoice_number, currency, total_amount, state, issued_at)
            VALUES ('21212121-0000-0000-0000-0000000000b4', '${ORG_A}',
                    '21212121-0000-0000-0000-0000000000c3', 'INV-2026-004', '${INR}',
                    100.0000, 'issued', '${LAST_MONTH}');

            INSERT INTO invoice_line (org_id, invoice_id, line_no, description, amount, currency)
            VALUES ('${ORG_A}', '21212121-0000-0000-0000-0000000000b4', 1,
                    'Overseas placement', 100.0000, 'USD');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an invoice line quoted in another currency",
    );
  });

  it("REFUSES to mark an invoice paid with no settlement journal, and accepts one that names it", async () => {
    await seedPartner("21212121-0000-0000-0000-0000000000c4", ORG_A, "Umbrella");
    const journalId = "21212121-0000-0000-0000-0000000000f1";
    await seedSettlementJournal(journalId, ORG_A, [ACC_RECEIVABLE, ACC_REVENUE]);

    await asOwner(`
      BEGIN;
        INSERT INTO invoice
          (id, org_id, partner_id, invoice_number, currency, total_amount, state, issued_at)
        VALUES ('21212121-0000-0000-0000-0000000000b5', '${ORG_A}',
                '21212121-0000-0000-0000-0000000000c4', 'INV-2026-005', '${INR}',
                5000.0000, 'issued', '${LAST_MONTH}');

        INSERT INTO invoice_line (org_id, invoice_id, line_no, description, amount, currency)
        VALUES ('${ORG_A}', '21212121-0000-0000-0000-0000000000b5', 1,
                'Season sponsorship', 5000.0000, '${INR}');
      COMMIT;
    `);

    // "Paid" with nothing in the books is the invoice-domain version of a hardcoded
    // confidence: a claim the database cannot contradict.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            UPDATE invoice SET state = 'paid'
             WHERE org_id = '${ORG_A}' AND id = '21212121-0000-0000-0000-0000000000b5';
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "marking an invoice paid with no settlement journal",
    );

    await asOwner(`
      BEGIN;
        UPDATE invoice SET state = 'paid', settled_journal_id = '${journalId}'
         WHERE org_id = '${ORG_A}' AND id = '21212121-0000-0000-0000-0000000000b5';
      COMMIT;
    `);

    const paid = await ownerRows<{ state: string; settled_journal_id: string; total_amount: string }>(
      `SELECT state::text AS state, settled_journal_id, total_amount::text AS total_amount
         FROM invoice WHERE org_id = $1 AND id = '21212121-0000-0000-0000-0000000000b5'`,
      [ORG_A],
    );
    expect(paid[0]!.state).toBe("paid");
    expect(paid[0]!.settled_journal_id).toBe(journalId);
    expect(paid[0]!.total_amount, "the invoice still reconciles with its line").toBe("5000.0000");
  });

  it("REFUSES an invoice naming a settlement journal from another organisation", async () => {
    // The composite FK makes the cross-tenant reference unexpressible, which is stronger
    // than any check this function could perform on a journal id.
    await seedPartner("21212121-0000-0000-0000-0000000000c5", ORG_A, "Acme Corp");
    await seedPartner("21212121-0000-0000-0000-0000000000c6", ORG_B, "Globex");

    await asOwner(`
      BEGIN;
        INSERT INTO invoice
          (id, org_id, partner_id, invoice_number, currency, total_amount, state, issued_at)
        VALUES ('21212121-0000-0000-0000-0000000000b6', '${ORG_A}',
                '21212121-0000-0000-0000-0000000000c5', 'INV-2026-006', '${INR}',
                5000.0000, 'issued', '${LAST_MONTH}');

        INSERT INTO invoice_line (org_id, invoice_id, line_no, description, amount, currency)
        VALUES ('${ORG_A}', '21212121-0000-0000-0000-0000000000b6', 1,
                'Season sponsorship', 5000.0000, '${INR}');
      COMMIT;
    `);

    const orgBJournal = "21212121-0000-0000-0000-0000000000f2";
    await asOwner(`
      BEGIN;
        INSERT INTO ledger_account (id, org_id, code, name, account_type, currency)
        VALUES ('21212121-0000-0000-0000-0000000000a3', '${ORG_B}', '1100', 'AR', 'asset', 'USD'),
               ('21212121-0000-0000-0000-0000000000a4', '${ORG_B}', '4000', 'Revenue', 'revenue', 'USD');

        INSERT INTO ledger_journal (id, org_id, description, source_kind, posting_period, currency)
        VALUES ('${orgBJournal}', '${ORG_B}', 'ORG B settlement', 'settlement', '2025-02-01', 'USD');

        INSERT INTO ledger_line (org_id, journal_id, line_no, account_id, side, amount, currency)
        VALUES ('${ORG_B}', '${orgBJournal}', 1, '21212121-0000-0000-0000-0000000000a3', 'debit', 100.0000, 'USD'),
               ('${ORG_B}', '${orgBJournal}', 2, '21212121-0000-0000-0000-0000000000a4', 'credit', 100.0000, 'USD');
      COMMIT;
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
            UPDATE invoice SET state = 'paid', settled_journal_id = '${orgBJournal}'
             WHERE org_id = '${ORG_A}' AND id = '21212121-0000-0000-0000-0000000000b6';
          COMMIT;
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "an ORG_A invoice settling against ORG_B's journal",
    );
  });
});

// ---------------------------------------------------------------------------
// PUBLIC SITE — the one place public and multi-tenant collide
// ---------------------------------------------------------------------------

describe("public site — what may be exposed without a tenant filter, and what may never be", () => {
  /**
   * Publishes a content item and returns its publication id.
   *
   * The publication is a DENORMALISED, publish-time materialisation rather than a live
   * join over the tenant tables. That is the whole of the design decision, and it is why
   * the public role needs no elevation at all: the table it reads contains only columns
   * that were vetted as publishable when the row was written.
   */
  async function publishAs(contentItemId: string, orgId?: string): Promise<void> {
    // Defaults to ORG_A. Without it every call would run with an EMPTY tenant and be
    // refused for the wrong reason — the "no organisation in the session" refusal would
    // satisfy every assertion here and the publisher's own rules would never be tested.
    await asApp(async () => {
      await db.query("SELECT public.publish_content_to_public_site($1::uuid)", [contentItemId]);
    }, orgId ?? ORG_A);
  }

  /** A creator with one published content item. */
  async function seedPublishedContent(options: {
    readonly orgId: string;
    readonly profileId: string;
    readonly itemId: string;
    readonly handle: string;
    readonly personId: string;
  }): Promise<void> {
    await asOwner(`
      INSERT INTO creator_profile (id, org_id, person_id, handle, display_name)
      VALUES ('${options.profileId}', '${options.orgId}', '${options.personId}',
              '${options.handle}', 'A Creator')
    `);

    await asOwner(`
      BEGIN;
        INSERT INTO content_item
          (id, org_id, creator_id, title, body, state, storage_ref, published_at)
        VALUES ('${options.itemId}', '${options.orgId}', '${options.profileId}',
                'Grand Final Highlights', 'A montage.', 'published',
                'https://cdn.test/clip.mp4', '${LAST_MONTH}');
      COMMIT;
    `);
  }

  it("carries ONLY publishable columns, and no person identity at all", async () => {
    // The load-bearing structural claim of the public surface. `public_site_publication`
    // is the one table a page reads with no tenant filter, so it carries no column that
    // could expose an obligation, an invoice, a partner contact or a person's identity.
    // Asserted by reflecting over the column list rather than by trusting a comment.
    const columns = await ownerRows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'public_site_publication' ORDER BY column_name`,
    );

    expect(columns.map((c) => c.column_name)).toEqual([
      "body",
      "content_item_id",
      "creator_handle",
      "id",
      "org_id",
      "published_at",
      "title",
    ]);

    // Belt and braces: no column whose name suggests a fact the public must never see.
    const forbidden = columns
      .map((c) => c.column_name)
      .filter((name) =>
        /amount|total|invoice|price|cost|obligation|evidence|inventory|partner|contact|email|person|creator_id|owner|stage|contract/.test(
          name,
        ),
      );
    expect(forbidden, "the public surface must carry no private fact, not even by name").toEqual([]);
  });

  it("carries no tenant filter on purpose, and the public role holds no grant on any tenant table", async () => {
    // The exclusion from the isolation list is deliberate and is asserted here with its
    // reason: this is the only surface read without `app.org_id`, and it is safe because
    // everything on it was written through a session-scoped publisher.
    const rls = await ownerRows<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'public_site_publication'",
    );
    expect(rls[0]!.relrowsecurity, "a tenant policy here would hide the public site").toBe(false);

    const grants = await ownerRows<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'raptor_public'
        ORDER BY table_name`,
    );

    const granted = grants.map((g) => `${g.table_name}:${g.privilege_type}`);
    expect(
      granted,
      "the public role may read the publication projection and the organisation's public name — nothing else",
    ).toEqual(["public_site_org:SELECT", "public_site_publication:SELECT"]);

    // And it cannot write, update or delete a single public row.
    const writable = grants.filter((g) => g.privilege_type !== "SELECT");
    expect(writable, "a public read role that could write could publish anything").toEqual([]);
  });

  it("REFUSES to publish with no tenant context, and REFUSES to publish another org's content", async () => {
    await seedPublishedContent({
      orgId: ORG_A,
      profileId: "21212121-0000-0000-0000-0000000000e1",
      itemId: "21212121-0000-0000-0000-0000000000b1",
      handle: "streambar",
      personId: PLAYER_A,
    });

    // No session tenant: fails closed, because the organisation is taken from the
    // session and never from a parameter.
    await asApp(async () => {
      await expectSqlstate(
        () => db.query("SELECT public.publish_content_to_public_site($1::uuid)", ["21212121-0000-0000-0000-0000000000b1"]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "publishing with no tenant context",
      );
    });

    // ORG_B's session, ORG_A's content item. The refusal is `insufficient_privilege` and
    // not "not found" on purpose: ADR-0011 rule 4 — cross-tenant access is a 404, so a
    // refusal must not confirm that the row exists at all.
    await asApp(async () => {
      await expectSqlstate(
        () => db.query("SELECT public.publish_content_to_public_site($1::uuid)", ["21212121-0000-0000-0000-0000000000b1"]),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "publishing another org's content item",
      );
    }, ORG_B);

    const published = await ownerRows<{ n: number }>("SELECT count(*)::int AS n FROM public_site_publication");
    expect(published[0]!.n, "no refused call left a public row behind").toBe(0);
  });

  it("REFUSES to publish content that is not in the published state", async () => {
    await asOwner(`
      INSERT INTO creator_profile (id, org_id, person_id, handle, display_name)
      VALUES ('21212121-0000-0000-0000-0000000000e2', '${ORG_A}', '${PLAYER_A}', 'draftscholar', 'A Creator');

      INSERT INTO content_item (id, org_id, creator_id, title, body, state)
      VALUES ('21212121-0000-0000-0000-0000000000b2', '${ORG_A}',
              '21212121-0000-0000-0000-0000000000e2', 'Unreleased', 'A draft.', 'draft');
    `);

    await expectSqlstate(
      () => publishAs("21212121-0000-0000-0000-0000000000b2"),
      SQLSTATE_CHECK_VIOLATION,
      "publishing a draft to the public site",
    );
  });

  it("publishes, then serves a public page that crosses no organisation boundary", async () => {
    // ORG_A publishes. ORG_B publishes a different item under a different slug. The
    // public read is by SLUG, and the two slugs answer only for themselves.
    await seedPublishedContent({
      orgId: ORG_A,
      profileId: "21212121-0000-0000-0000-0000000000e3",
      itemId: "21212121-0000-0000-0000-0000000000b3",
      handle: "streambar",
      personId: PLAYER_A,
    });
    await seedPublishedContent({
      orgId: ORG_B,
      profileId: "21212121-0000-0000-0000-0000000000e4",
      itemId: "21212121-0000-0000-0000-0000000000b4",
      handle: "clipgirl",
      personId: PLAYER_B,
    });

    await publishAs("21212121-0000-0000-0000-0000000000b3");
    await publishAs("21212121-0000-0000-0000-0000000000b4", ORG_B);

    // The public read, as the public role, with NO tenant context at all. This is the
    // whole reason the projection table exists: no session tenant is needed, and none of
    // the tenant tables is read.
    const pageOf = async (slug: string): Promise<{ org_slug: string; title: string; creator_handle: string }[]> => {
      await recoverSession();
      await db.exec("SET ROLE raptor_public");
      await db.exec("SELECT set_config('app.org_id', '', false)");
      try {
        const found = await db.query<{ org_slug: string; title: string; creator_handle: string }>(
          "SELECT org_slug, title, creator_handle FROM public.public_site_content($1::text)",
          [slug],
        );
        return found.rows;
      } finally {
        await recoverSession();
      }
    };

    const orgAPage = await pageOf("org-a");
    expect(orgAPage).toHaveLength(1);
    expect(orgAPage[0]!.title).toBe("Grand Final Highlights");
    expect(orgAPage[0]!.creator_handle).toBe("streambar");

    const orgBPage = await pageOf("org-b");
    expect(orgBPage).toHaveLength(1);
    expect(orgBPage[0]!.creator_handle, "one slug serves exactly one organisation's content").toBe("clipgirl");

    // A slug nobody has returns nothing rather than somebody else's.
    expect(await pageOf("org-c"), "an unknown slug must serve nobody's content").toHaveLength(0);

    // And the two tenants' content never appears under the other's address, which is the
    // property "no public read crosses an organisation boundary" means concretely.
    const crossRead = orgAPage.filter((r) => r.creator_handle === "clipgirl");
    expect(crossRead, "ORG_B's content must never appear under ORG_A's slug").toEqual([]);
  });

  it("stops serving a suspended organisation's content while the tenant still sees it", async () => {
    // The boundary, at its sharpest. The row is readable by its owner and invisible to
    // the public — not because of a filter somebody remembered, but because the read is
    // joined to an organisation that is no longer active.
    await seedPublishedContent({
      orgId: ORG_A,
      profileId: "21212121-0000-0000-0000-0000000000e5",
      itemId: "21212121-0000-0000-0000-0000000000b5",
      handle: "streambar",
      personId: PLAYER_A,
    });
    await publishAs("21212121-0000-0000-0000-0000000000b5");

    const countPublic = async (): Promise<number> => {
      await recoverSession();
      await db.exec("SET ROLE raptor_public");
      try {
        const found = await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM public.public_site_content('org-a')",
        );
        return found.rows[0]!.n;
      } finally {
        await recoverSession();
      }
    };

    expect(await countPublic()).toBe(1);

    await asOwner(`UPDATE organization SET status = 'suspended' WHERE id = '${ORG_A}'`);

    expect(await countPublic(), "a suspended organisation's site goes dark").toBe(0);

    // And the tenant itself still has its own content — the row was not destroyed, it
    // stopped being public.
    const asA = await appRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM content_item WHERE state = 'published'",
    );
    expect(asA[0]!.n, "the tenant's own record is untouched by going public-dark").toBe(1);
  });

  it("REFUSES to rewrite or delete a published row — the public record is append-only", async () => {
    // A public page that can be silently edited after the fact is a claim nobody can
    // check. The publication is a fact about a moment, exactly as 0008's contract
    // versions are, so it is corrected by republishing, never by an UPDATE.
    await seedPublishedContent({
      orgId: ORG_A,
      profileId: "21212121-0000-0000-0000-0000000000e6",
      itemId: "21212121-0000-0000-0000-0000000000b6",
      handle: "streambar",
      personId: PLAYER_A,
    });
    await publishAs("21212121-0000-0000-0000-0000000000b6");

    const publicationId = await ownerRows<{ id: string }>("SELECT id FROM public_site_publication LIMIT 1");
    const id = publicationId[0]!.id;

    await expectSqlstate(
      () => asOwner(`UPDATE public_site_publication SET title = 'Rewritten' WHERE id = '${id}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "rewriting a published row",
    );

    await expectSqlstate(
      () => asOwner(`DELETE FROM public_site_publication WHERE id = '${id}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting a published row",
    );

    const after = await ownerRows<{ title: string }>("SELECT title FROM public_site_publication WHERE id = $1", [id]);
    expect(after[0]!.title, "the public record still says what it said").toBe("Grand Final Highlights");
  });

  it("REFUSES to publish the same content item twice", async () => {
    // Two public rows for one item means a public page whose content has two answers.
    await seedPublishedContent({
      orgId: ORG_A,
      profileId: "21212121-0000-0000-0000-0000000000e7",
      itemId: "21212121-0000-0000-0000-0000000000b7",
      handle: "streambar",
      personId: PLAYER_A,
    });
    await publishAs("21212121-0000-0000-0000-0000000000b7");

    await expectSqlstate(
      () => publishAs("21212121-0000-0000-0000-0000000000b7"),
      SQLSTATE_UNIQUE_VIOLATION,
      "publishing the same content item twice",
    );
  });
});