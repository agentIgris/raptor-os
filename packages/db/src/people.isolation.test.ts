/**
 * People — provable acceptance, minors and consent, compensation, HR lifecycle,
 * documents and expiry. Asserted against a real database.
 *
 * The two clauses this file exists to defend are in the phase table of the design
 * spec (`docs/superpowers/specs/2026-10-09-raptor-os-v2-design.md`, section 8):
 *
 *     Acceptance provable by content hash; expiry reminders fire
 *
 * Both are the DESIGN PROBLEM rather than a checkbox, so each is broken into the
 * smallest claim the database can actually enforce, and each claim has a NAMED test.
 * An assertion that could pass for the wrong reason is worse than no assertion, so
 * several tests here assert a PREMISE before drawing a conclusion from it: that the
 * referenced row really exists, that the fixture really produced four rows and not
 * three, that the rejected insert really would otherwise have been legal.
 *
 * THE CENTRAL CLAIM
 * -----------------
 * A contract's acceptance is provable, which means a party disputing it can be shown
 * three things from the database alone: WHICH version they accepted, WHO accepted it
 * and under what identity, and the hash of the exact text in front of them. The
 * legacy system could show none of these — `guardian_consent` in 0001 was a global
 * per-person flag with no organisation, no engagement and no version, and 0008 had to
 * correct all three.
 *
 * WHAT IS ASSERTED TO BE ABSENT
 * -----------------------------
 * As in `performance.isolation.test.ts`, the absences matter as much as the
 * presences. A schema with no stored majority boolean, no `next_reminder_at`, and no
 * reminder queue is a schema that refused to store a claim it cannot keep.
 *
 * METHOD
 * ------
 * Real SQL against a real PGlite instance. Structural claims are made by reflecting
 * over the catalogue rather than by trusting the DDL, matching the existing
 * isolation suites.
 *
 * Two traps this file is written around, both recorded in the migration brief and
 * both learned the hard way:
 *
 *   * PGlite returns `timestamptz` and `date` to Node as HOST-timezone `Date`
 *     objects. Every instant is therefore cast to text IN SQL before it reaches an
 *     assertion, so a test asserts the database's reading and not the test runner's
 *     locale.
 *   * PostgreSQL silently parses a malformed ISO literal into a wrong-but-valid
 *     instant with no error at all. Nothing here concatenates a timestamp: instants
 *     are either whole literals spelled out in full, or produced by PostgreSQL.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

/**
 * Every table introduced or corrected by 0008_people.sql.
 *
 * `guardian_consent` is in the list because 0008 gave it an `org_id`, a policy and a
 * FORCED RLS it never had — it is the table this migration had to fix rather than
 * create, and a fixed table is exactly the one a later migration forgets to protect.
 *
 * `person` is deliberately NOT in the list: it is org-independent by design
 * (ADR-0018) and its `birth_date` column is asserted on its own terms below.
 */
const PEOPLE_TABLES = [
  "acceptance_withdrawal",
  "compensation_agreement",
  "contract",
  "contract_acceptance",
  "contract_version",
  "guardian_consent",
  "guardian_consent_withdrawal",
  "hr_record",
  "hr_state_transition",
  "person_document",
] as const;

/** ORG_A's roster. A minor, an adult, and a person whose age is unknown. */
const PLAYER_ADULT = "aaaaaaaa-0000-0000-0000-000000000001";
const PLAYER_MINOR = "aaaaaaaa-0000-0000-0000-000000000002";
const PLAYER_UNKNOWN_AGE = "aaaaaaaa-0000-0000-0000-000000000003";
const GUARDIAN = "aaaaaaaa-0000-0000-0000-000000000004";
const WITNESS = "aaaaaaaa-0000-0000-0000-000000000005";
/** ORG_B's one player, so cross-tenant refusals have something real to point at. */
const PLAYER_B = "bbbbbbbb-0000-0000-0000-000000000001";

let db: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the session to a usable state: no open transaction, no assumed role.
 *
 * PostgreSQL refuses every statement in an ABORTED transaction with 25P02 until it
 * is rolled back — including `RESET ROLE`, which is why the ROLLBACK has to come
 * FIRST. Getting that order wrong turns one intended refusal into a cascade of
 * false failures for every test after it, which is the exact failure mode this file
 * would be least able to detect: the failures look like schema bugs and are not.
 *
 * Every statement here is individually guarded because each can legitimately fail:
 * there may be no transaction open, and there may be no role to reset.
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

async function ownerRows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await recoverSession();
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
 * A superuser bypasses every policy in this schema, so an isolation assertion made
 * as the owner proves nothing (ADR-0006). The role attributes are asserted below
 * rather than assumed.
 */
async function asApp(fn: (sql: string) => Promise<void>, orgId?: string): Promise<void> {
  await recoverSession();
  await db.exec("SET ROLE raptor_app");
  if (orgId) await db.exec(`SET app.org_id = '${orgId}'`);
  else await db.exec("SELECT set_config('app.org_id', '', false)");
  try {
    await fn("");
  } finally {
    await recoverSession();
  }
}

/**
 * A query through the application role with ORG_A in the session context.
 *
 * Not written as `asApp` plus a captured variable: the rows have to come back out of
 * the callback, and a module-level holder would be shared mutable state that a
 * future nested call could clobber.
 */
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
 * Asserting the code rather than the message: every guarantee in this schema
 * produces "rejected", and a message match would let the wrong mechanism satisfy a
 * test that claims a specific one. Two of the SQLSTATEs below appear more than once
 * on purpose and are asserted in context.
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
  expect(actual, `${label}: wrong SQLSTATE — ${String((caught as Error).message).slice(0, 240)}`).toBe(sqlstate);
}

const SQLSTATE_CHECK_VIOLATION = "23514";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_NOT_NULL_VIOLATION = "23502";
const SQLSTATE_INSUFFICIENT_PRIVILEGE = "42501";
const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

// ---------------------------------------------------------------------------
// Content hashing, computed by the database
// ---------------------------------------------------------------------------

/** The body used by every contract fixture, so a failure names the body, not a hash. */
const BODY_V1 = "Article 1. The player shall compete for the Organisation under the coach's direction.";
const BODY_V2 = "Article 1. The player shall compete for the Organisation under a head coach's direction.";

/**
 * Quotes a value as a SQL string literal.
 *
 * Present because the contract bodies above contain an apostrophe, as real contract
 * text does. Interpolating them raw produces `syntax error at or near "s"` — and a
 * suite full of syntax errors is a suite that has stopped testing anything at all,
 * which is the failure mode a green-looking run hides.
 *
 * Doubling the quote is the standard literal escape and is what every SQL dialect
 * implements; nothing exotic is going on here.
 */
function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The literals most fixtures need, already quoted. */
const Q_BODY_V1 = sql(BODY_V1);
const Q_BODY_V2 = sql(BODY_V2);

/**
 * The hash the DATABASE computes for a version's content.
 *
 * Asked of the database rather than computed in JavaScript on purpose: the property
 * under test is that the database's own function is what the row is checked against,
 * and a test that duplicated the function would pass even if the function were wrong
 * — both sides would drift together.
 */
async function hashFor(
  contractId: string,
  versionNo: number,
  title: string,
  body: string,
): Promise<string> {
  const found = await ownerRows<{ h: string }>(
    `SELECT public.contract_content_hash($1::uuid, $2::integer, $3::text, $4::text)::text AS h`,
    [contractId, versionNo, title, body],
  );
  return found[0]!.h.trim();
}

/**
 * A hash that is well-formed and wrong.
 *
 * 64 hex characters, so it satisfies the shape CHECK. This is the whole point: a
 * shape-only check would accept it, and the test that uses it is the one that proves
 * the hash is verified rather than validated.
 */
const WRONG_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * An engagement for `personId` in `orgId`, named explicitly and returned.
 *
 * The id is supplied rather than generated because the guardian consent that makes a
 * minor engagement legal has to name a REAL engagement, and a generated id could not
 * be predicted by the caller that writes the consent.
 */
async function seedEngagement(
  orgId: string,
  engagementId: string,
  personId: string,
  validFrom: string,
): Promise<string> {
  await asOwner(`
    INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
    VALUES ('${engagementId}', '${orgId}', '${personId}', 'player', '${validFrom}')
  `);
  return engagementId;
}

interface ContractFixture {
  readonly contractId: string;
  readonly versionId: string;
  readonly versionNo: number;
  readonly contentHash: string;
}

/**
 * A contract with one DRAFT version 1.
 *
 * A draft, deliberately: version 1 of a contract nobody has signed is the state a
 * contract spends most of its early life in, and the sealing tests need to start
 * from it.
 */
async function seedDraftContract(orgId: string, contractId: string, personId: string): Promise<ContractFixture> {
  const versionId = `${contractId.slice(0, 8)}-0000-0000-0000-000000000010`;
  const title = "Player Agreement 2026";
  const contentHash = await hashFor(contractId, 1, title, BODY_V1);

  await asOwner(`
    INSERT INTO contract (id, org_id, person_id, kind, title)
    VALUES ('${contractId}', '${orgId}', '${personId}', 'player_agreement', '${title}');

    INSERT INTO contract_version
      (id, org_id, contract_id, version_no, title, document_body, content_hash)
    VALUES ('${versionId}', '${orgId}', '${contractId}', 1, '${title}',
            ${Q_BODY_V1}, '${contentHash}')
  `);

  return { contractId, versionId, versionNo: 1, contentHash };
}

/** Accepts a version as `signer`, pinning the version's own hash. */
async function seedAcceptance(
  orgId: string,
  contractId: string,
  versionId: string,
  contentHash: string,
  signer: string,
  acceptedAt: string,
): Promise<string> {
  const acceptanceId = `${contractId.slice(0, 8)}-0000-0000-0000-000000000030`;
  await asOwner(`
    INSERT INTO contract_acceptance
      (id, org_id, contract_id, contract_version_id, accepted_by_person_id,
       accepted_at, identity_method, identity_assertion, method, content_hash)
    VALUES ('${acceptanceId}', '${orgId}', '${contractId}', '${versionId}', '${signer}',
            '${acceptedAt}', 'email_otp', 'signer@example.test', 'electronic_signature', '${contentHash}')
  `);
  return acceptanceId;
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/**
 * Calendar anchors produced by the DATABASE.
 *
 * Spelled whole, never assembled from parts. PostgreSQL does not reject a malformed
 * ISO literal — it parses `"...T00:00:00Z" + "T23:59:59Z"` into a wrong-but-valid
 * instant with no error at all — so a fixture built by concatenation looks right and
 * quietly tests nothing. And `birth_date` is a `date`, so every anchor below is a
 * whole calendar date with no time component and no zone to get wrong.
 */
interface Anchors {
  /** A date comfortably in the past: used for engagements that predate any test. */
  readonly lastYear: string;
  /** A date comfortably in the future: used for the majority-boundary fixtures. */
  readonly nextYear: string;
  /** A fixed instant well inside the past, for `accepted_at`. */
  readonly signedAt: string;
  /** Today, as a date. */
  readonly today: string;
}

async function anchors(): Promise<Anchors> {
  const found = await ownerRows<{
    last_year: string;
    next_year: string;
    signed_at: string;
    today: string;
  }>(
    `SELECT to_char((now() AT TIME ZONE 'UTC')::date - 365,        'YYYY-MM-DD') AS last_year,
            to_char((now() AT TIME ZONE 'UTC')::date + 365,        'YYYY-MM-DD') AS next_year,
            to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')     AS signed_at,
            to_char((now() AT TIME ZONE 'UTC')::date,               'YYYY-MM-DD') AS today`,
  );

  const row = found[0]!;
  return {
    lastYear: row.last_year,
    nextYear: row.next_year,
    signedAt: row.signed_at,
    today: row.today,
  };
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
    VALUES ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active'),
           ('${ORG_B}', 'org-b', 'Org B', 'USD', 'active');

    INSERT INTO person (id, external_ref, birth_date) VALUES
      ('${PLAYER_ADULT}',       'adult',       '1995-01-15'),
      ('${PLAYER_MINOR}',       'minor',       NULL),
      ('${PLAYER_UNKNOWN_AGE}', 'unknown-age', NULL),
      ('${GUARDIAN}',           'guardian',    '1980-06-01'),
      ('${WITNESS}',            'witness',     '1975-03-03'),
      ('${PLAYER_B}',           'pb',          '1990-02-02');
  `);

  // The minor's birth date is set here rather than in the INSERT above so that
  // "unknown age" stays unknown in every other test. A fixture that made everyone a
  // minor would let a guard that fired unconditionally pass for a guard that fires
  // correctly.
  const clock = await anchors();
  await asOwner(`UPDATE person SET birth_date = '2009-01-15' WHERE id = '${PLAYER_MINOR}'`);
  expect(await majorityOf(PLAYER_MINOR, clock.today)).toBe("minor");
});

/** The majority status of a person on a date, as the database's own function says. */
async function majorityOf(personId: string, onDate: string): Promise<string> {
  const found = await ownerRows<{ s: string }>(
    `SELECT public.majority_status(p.birth_date, $2::date) AS s
       FROM person p WHERE p.id = $1`,
    [personId, onDate],
  );
  return found[0]!.s;
}

// ---------------------------------------------------------------------------
// Isolation invariants
// ---------------------------------------------------------------------------

describe("people schema — isolation", () => {
  it("applies 0008_people.sql with no pending work", async () => {
    const status = await migrationStatus(db);
    expect(status.applied).toContain("0008_people.sql");
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

  it("ENABLES and FORCES row level security on every people table", async () => {
    const found = await ownerRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...PEOPLE_TABLES]],
    );

    expect(found.map((r) => r.relname)).toEqual([...PEOPLE_TABLES].sort());
    for (const row of found) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("gives every people table one tenant policy with no IS NULL bypass", async () => {
    const found = await ownerRows<{ relname: string; polname: string; qual: string; with_check: string }>(
      `SELECT c.relname, p.polname,
              pg_get_expr(p.polqual, p.polrelid)    AS qual,
              pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = ANY($1)
        ORDER BY c.relname`,
      [[...PEOPLE_TABLES]],
    );

    expect(found).toHaveLength(PEOPLE_TABLES.length);
    for (const row of found) {
      expect(row.polname).toBe(`${row.relname}_tenant_isolation`);
      // The tenant predicate is the WHOLE predicate. An `OR org_id IS NULL` anywhere
      // here hands every tenant every row whenever the context is missing — the
      // failure ADR-0015 exists to prevent.
      expect(row.qual).not.toMatch(/IS NULL/i);
      expect(row.with_check).not.toMatch(/IS NULL/i);
      expect(row.qual).toMatch(/org_id/);
      expect(row.with_check).toMatch(/org_id/);
    }
  });

  it("makes org_id NOT NULL on every people table", async () => {
    const found = await ownerRows<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = ANY($1) AND column_name = 'org_id'
        ORDER BY table_name`,
      [[...PEOPLE_TABLES]],
    );

    expect(found).toHaveLength(PEOPLE_TABLES.length);
    for (const row of found) {
      expect(row.is_nullable, `${row.table_name}.org_id must be NOT NULL`).toBe("NO");
    }
  });

  it("gives every people table UNIQUE (org_id, id) for composite foreign keys", async () => {
    const found = await ownerRows<{ relname: string; conname: string; attnames: string[] }>(
      `SELECT c.relname, u.conname, array_agg(a.attname ORDER BY k.ord) AS attnames
         FROM pg_constraint u
         JOIN pg_class c ON c.oid = u.conrelid
         JOIN LATERAL unnest(u.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = u.conrelid AND a.attnum = k.attnum
        WHERE u.contype = 'u' AND c.relname = ANY($1)
        GROUP BY c.relname, u.conname, u.conkey
        ORDER BY c.relname, u.conname`,
      [[...PEOPLE_TABLES]],
    );

    const keyed = found.filter((r) => r.attnames.length === 2 && r.attnames[0] === "org_id" && r.attnames[1] === "id");
    expect(
      keyed.map((r) => r.relname),
      "every people table must expose UNIQUE (org_id, id) for composite FKs",
    ).toEqual([...PEOPLE_TABLES].sort());
  });

  it("leads every multi-column index on a people table with org_id", async () => {
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
      [[...PEOPLE_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);
    for (const row of found) {
      expect(row.cols[0], `${row.table_name}.${row.index_name} must lead with org_id`).toBe("org_id");
    }
  });

  it("has no single-column foreign key from a people table to a tenant table", async () => {
    // A table is tenant-owned if it has a NOT NULL org_id AND UNIQUE (org_id, id).
    // `organization` and `person` are excluded by that definition on purpose: the
    // first is the tenant root, the second is org-independent by design (ADR-0018).
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
      [[...PEOPLE_TABLES]],
    );

    expect(found.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const fk of found) {
      if (!tenantTables.has(fk.parent_table)) continue;
      if (fk.cols.length < 2 || fk.cols[0] !== "org_id") {
        offenders.push(`${fk.child_table}.${fk.conname} -> ${fk.parent_table}(${fk.cols.join(", ")})`);
      }
    }

    expect(
      offenders,
      `every FK from a people table to a tenant table must be composite and lead with org_id:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("rejects a people row naming another org's row, by the composite FK itself", async () => {
    const clock = await anchors();
    // ORG_B's engagement genuinely exists — asserted so this cannot pass for the
    // wrong reason (the row was never written).
    await seedEngagement(ORG_B, "cccccccc-0000-0000-0000-0000000000c1", PLAYER_B, clock.lastYear);

    const present = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement WHERE org_id = $1",
      [ORG_B],
    );
    expect(present[0]!.n, "the cross-tenant target must really exist").toBe(1);

    // Run as the OWNER, so RLS is not what does the refusing. The guarantee asserted
    // is that the database cannot EXPRESS a cross-tenant reference (ADR-0011),
    // independent of any policy.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO hr_record (org_id, person_id, engagement_id, state)
          VALUES ('${ORG_A}', '${PLAYER_ADULT}', 'cccccccc-0000-0000-0000-0000000000c1', 'draft')
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "an HR record naming another org's engagement",
    );

    // Nothing was written: a refused reference leaves no partial history behind.
    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM hr_record WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("rejects a contract version naming another org's contract", async () => {
    const clock = await anchors();
    const engagementA = await seedEngagement(ORG_A, "dddddddd-0000-0000-0000-0000000000c1", PLAYER_ADULT, clock.lastYear);

    await asOwner(`
      INSERT INTO contract (id, org_id, person_id, engagement_id, kind, title)
      VALUES ('cccccccc-0000-0000-0000-0000000000c1', '${ORG_B}', '${PLAYER_B}',
              NULL, 'player_agreement', 'ORG B Contract')
    `);
    const orgBHash = await hashFor("cccccccc-0000-0000-0000-0000000000c1", 1, "ORG B Contract", BODY_V1);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash)
          VALUES ('dddddddd-0000-0000-0000-000000000010', '${ORG_A}',
                  'cccccccc-0000-0000-0000-0000000000c1', 1, 'ORG B Contract',
                  ${Q_BODY_V1}, '${orgBHash}')
        `),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "a version in ORG_A naming ORG_B's contract",
    );

    // The ORG_A engagement above exists, so the test also proves the failure was
    // about the CONTRACT and not about some unrelated missing row.
    const eng = await ownerRows<{ n: number }>("SELECT count(*)::int AS n FROM engagement WHERE id = $1", [
      engagementA,
    ]);
    expect(eng[0]!.n).toBe(1);
  });

  it("shows a member only their own organisation's people rows", async () => {
    const clock = await anchors();
    await seedEngagement(ORG_A, "dddddddd-0000-0000-0000-0000000000c1", PLAYER_ADULT, clock.lastYear);
    await seedEngagement(ORG_B, "cccccccc-0000-0000-0000-0000000000c1", PLAYER_B, clock.lastYear);

    await asOwner(`
      INSERT INTO hr_record (org_id, person_id, engagement_id, state)
      VALUES ('${ORG_A}', '${PLAYER_ADULT}', 'dddddddd-0000-0000-0000-0000000000c1', 'draft'),
             ('${ORG_B}', '${PLAYER_B}',      'cccccccc-0000-0000-0000-0000000000c1', 'draft')
    `);

    const asA = await appRows<{ org_id: string }>("SELECT org_id FROM hr_record");
    expect(asA).toHaveLength(1);
    expect(asA[0]!.org_id).toBe(ORG_A);

    await asApp(async () => {
      const found = await db.query<{ org_id: string }>("SELECT org_id FROM hr_record");
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0]!.org_id).toBe(ORG_B);
    }, ORG_B);
  });

  it("fails CLOSED with app.org_id unset, on every people table", async () => {
    const clock = await anchors();
    await seedEngagement(ORG_A, "dddddddd-0000-0000-0000-0000000000c1", PLAYER_ADULT, clock.lastYear);
    await asOwner(`
      INSERT INTO hr_record (org_id, person_id, engagement_id, state)
      VALUES ('${ORG_A}', '${PLAYER_ADULT}', 'dddddddd-0000-0000-0000-0000000000c1', 'draft')
    `);

    // Fail CLOSED: no IS NULL branch in any policy, so an unset context cannot expose
    // anything. Asserted per table rather than on one representative, because a
    // migration that forgot one table would otherwise pass.
    await asApp(async () => {
      for (const table of PEOPLE_TABLES) {
        const found = await db.query(`SELECT * FROM ${table}`);
        expect(found.rows, `${table} must expose nothing without a tenant context`).toHaveLength(0);
      }
    });

    // And an INSERT with no context must be refused too, not merely invisible.
    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query(
            `INSERT INTO person_document
               (org_id, person_id, kind, title, storage_ref, document_hash, issued_at)
             VALUES ($1, $2, 'identity', 'Passport', 's3://bucket/passport', $3, $4::timestamptz)`,
            [ORG_A, PLAYER_ADULT, "a".repeat(64), clock.signedAt],
          ),
        SQLSTATE_INSUFFICIENT_PRIVILEGE,
        "insert with no tenant context",
      );
    });
  });

  it("stores every instant on the people tables as timestamptz", async () => {
    // ADR-0003's lesson restated: strings do not order, and a `text` timestamp is how
    // the legacy attendance backlog began. `date` is permitted in exactly two named
    // places — `person.birth_date` and `guardian_consent`'s expiry comparison — and
    // this query is what would catch a third.
    const found = await ownerRows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_name = ANY($1)
          AND data_type = 'date'
        ORDER BY table_name, column_name`,
      [[...PEOPLE_TABLES]],
    );

    // No people table carries a bare `date` at all: `issued_at` and `expires_at` are
    // both instants precisely so that "expired as of" has a single unambiguous
    // boundary.
    expect(
      found.map((r) => `${r.table_name}.${r.column_name}`),
      "a document expiry or issue instant must be timestamptz, not a bare date",
    ).toEqual([]);
  });

  it("stores person.birth_date as a date, not an instant", async () => {
    // The permitted exception, asserted rather than assumed: a birthday is a calendar
    // fact, so it is a `date`. Storing an instant would mean "this person turned
    // eighteen" resolving to a different day per reader's timezone.
    const found = await ownerRows<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'person' AND column_name = 'birth_date'`,
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.data_type).toBe("date");
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 1 — a contract document is immutable once any version is accepted
// ---------------------------------------------------------------------------

describe("property 1 — a contract document is immutable once any version has been accepted", () => {
  it("refuses to change an accepted version's text", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "eeeeeeee-0000-0000-0000-0000000000c1", PLAYER_ADULT);
    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    // The premise: version 1 IS accepted. Without it, a refusal could be explained by
    // a constraint that never fires.
    const accepted = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM contract_acceptance WHERE org_id = $1 AND contract_version_id = $2",
      [ORG_A, seeded.versionId],
    );
    expect(accepted[0]!.n).toBe(1);

    // The text is UNCHANGED afterwards. The hash trigger would also refuse this
    // (it fires before the append-only trigger? no — both are BEFORE, and trigger
    // order is alphabetical by name, so the outcome is asserted, not assumed).
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE contract_version SET document_body = ${Q_BODY_V2}
           WHERE org_id = '${ORG_A}' AND id = '${seeded.versionId}'
        `),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "changing the text of an accepted version",
    );

    const after = await ownerRows<{ document_body: string }>(
      "SELECT document_body FROM contract_version WHERE org_id = $1 AND id = $2",
      [ORG_A, seeded.versionId],
    );
    expect(after[0]!.document_body).toBe(BODY_V1);
  });

  it("refuses a version written alongside an accepted chain rather than superseding it", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "eeeeeeee-0000-0000-0000-0000000000c2", PLAYER_ADULT);
    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    const title = "Player Agreement 2026";
    const v2Hash = await hashFor(seeded.contractId, 2, title, BODY_V2);

    // No supersedes_id. This is the move that would let "version 2" exist without
    // saying what it replaced — leaving "which text is current" with two answers.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash)
          VALUES ('eeeeeeee-0000-0000-0000-000000000011', '${ORG_A}', '${seeded.contractId}',
                  2, '${title}', ${Q_BODY_V2}, '${v2Hash}')
        `),
      SQLSTATE_EXCLUSION_VIOLATION,
      "a version beside the accepted chain",
    );
  });

  it("refuses a correction that forks the chain at an old version", async () => {
    const clock = await anchors();
    const title = "Player Agreement 2026";
    const seeded = await seedDraftContract(ORG_A, "eeeeeeee-0000-0000-0000-0000000000c3", PLAYER_ADULT);

    // A legitimate correction FIRST, while nothing is accepted: version 1 → 2.
    const v2Hash = await hashFor(seeded.contractId, 2, title, BODY_V2);
    await asOwner(`
      INSERT INTO contract_version
        (id, org_id, contract_id, version_no, title, document_body, content_hash, supersedes_id)
      VALUES ('eeeeeeee-0000-0000-0000-000000000011', '${ORG_A}', '${seeded.contractId}',
              2, '${title}', ${Q_BODY_V2}, '${v2Hash}', '${seeded.versionId}')
    `);

    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      "eeeeeeee-0000-0000-0000-000000000011",
      v2Hash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    // Now a correction naming version 1 — which is no longer the head. This is the
    // fork: the chain would become a tree, and "which version replaced which" would
    // have two answers.
    const v3Hash = await hashFor(seeded.contractId, 3, title, `${BODY_V2} (third)`);
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash, supersedes_id)
          VALUES ('eeeeeeee-0000-0000-0000-000000000012', '${ORG_A}', '${seeded.contractId}',
                  3, '${title}', ${Q_BODY_V2} || ' (third)', '${v3Hash}', '${seeded.versionId}')
        `),
      SQLSTATE_EXCLUSION_VIOLATION,
      "a correction superseding a version that is not the head",
    );

    // And a version number that is not the next one. A version number must mean one
    // text forever; a writer-chosen number is how "version 2" becomes ambiguous.
    const v9Hash = await hashFor(seeded.contractId, 9, title, `${BODY_V2} (ninth)`);
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash, supersedes_id)
          VALUES ('eeeeeeee-0000-0000-0000-000000000019', '${ORG_A}', '${seeded.contractId}',
                  9, '${title}', ${Q_BODY_V2} || ' (ninth)', '${v9Hash}',
                  'eeeeeeee-0000-0000-0000-000000000011')
        `),
      SQLSTATE_EXCLUSION_VIOLATION,
      "a correction with a version number that is not head + 1",
    );
  });

  it("accepts a correction that properly supersedes the head of a sealed contract", async () => {
    // A guard that refuses everything would leave corrected documents unwritable,
    // which is exactly how people start disabling constraints. The legal path must be
    // demonstrably open.
    const clock = await anchors();
    const title = "Player Agreement 2026";
    const seeded = await seedDraftContract(ORG_A, "eeeeeeee-0000-0000-0000-0000000000c4", PLAYER_ADULT);
    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    const v2Hash = await hashFor(seeded.contractId, 2, title, BODY_V2);
    await asOwner(`
      INSERT INTO contract_version
        (id, org_id, contract_id, version_no, title, document_body, content_hash, supersedes_id)
      VALUES ('eeeeeeee-0000-0000-0000-000000000011', '${ORG_A}', '${seeded.contractId}',
              2, '${title}', ${Q_BODY_V2}, '${v2Hash}', '${seeded.versionId}')
    `);

    const chain = await ownerRows<{ version_no: number; supersedes_id: string | null; document_body: string }>(
      `SELECT version_no, supersedes_id::text, document_body
         FROM contract_version WHERE org_id = $1 AND contract_id = $2
        ORDER BY version_no`,
      [ORG_A, seeded.contractId],
    );

    expect(chain).toHaveLength(2);
    // The correction names its predecessor, and the predecessor's text is intact —
    // which is the whole of property 1: the accepted version still says what it said.
    expect(chain[1]!.supersedes_id).toBe(seeded.versionId);
    expect(chain[0]!.document_body).toBe(BODY_V1);
    expect(chain[1]!.document_body).toBe(BODY_V2);
  });

  it("refuses to DELETE an accepted version at all", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "eeeeeeee-0000-0000-0000-0000000000c5", PLAYER_ADULT);
    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    await expectSqlstate(
      () => asOwner(`DELETE FROM contract_version WHERE org_id = '${ORG_A}' AND id = '${seeded.versionId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting an accepted version",
    );
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 2 — the content hash is computed by the database
// ---------------------------------------------------------------------------

describe("property 2 — every version carries a hash computed by the database", () => {
  it("refuses an INSERT whose stored hash is not the hash of the stored text", async () => {
    // WRONG_HASH is 64 hex characters, so it satisfies the shape CHECK. This is the
    // test that distinguishes a VERIFIED hash from a VALIDATED one: if the schema
    // only checked the shape, this row would be written and a party could later be
    // shown a hash that describes nothing.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract (id, org_id, person_id, kind, title)
          VALUES ('ffffffff-0000-0000-0000-0000000000c1', '${ORG_A}', '${PLAYER_ADULT}',
                  'player_agreement', 'Player Agreement 2026');

          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash)
          VALUES ('ffffffff-0000-0000-0000-000000000010', '${ORG_A}',
                  'ffffffff-0000-0000-0000-0000000000c1', 1, 'Player Agreement 2026',
                  ${Q_BODY_V1}, '${WRONG_HASH}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a version whose hash does not describe its text",
    );

    // Nothing was written. Asserted so this cannot pass because the whole transaction
    // aborted for an unrelated reason.
    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM contract_version WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("refuses a hash that describes a DIFFERENT document's text", async () => {
    // The realistic error, and the one a shape check would let straight through: the
    // hash is genuine, it is just the hash of the wrong document.
    const contractId = "ffffffff-0000-0000-0000-0000000000c2";
    const title = "Player Agreement 2026";
    const hashOfV2 = await hashFor(contractId, 2, title, BODY_V2);

    await asOwner(`
      INSERT INTO contract (id, org_id, person_id, kind, title)
      VALUES ('${contractId}', '${ORG_A}', '${PLAYER_ADULT}', 'player_agreement', '${title}')
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash)
          VALUES ('ffffffff-0000-0000-0000-000000000010', '${ORG_A}', '${contractId}',
                  1, '${title}', ${Q_BODY_V1}, '${hashOfV2}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a version carrying another version's hash",
    );
  });

  it("accepts the hash the database itself computes", async () => {
    const contractId = "ffffffff-0000-0000-0000-0000000000c3";
    const title = "Player Agreement 2026";
    const correct = await hashFor(contractId, 1, title, BODY_V1);

    await asOwner(`
      INSERT INTO contract (id, org_id, person_id, kind, title)
      VALUES ('${contractId}', '${ORG_A}', '${PLAYER_ADULT}', 'player_agreement', '${title}')
    `);
    await asOwner(`
      INSERT INTO contract_version
        (id, org_id, contract_id, version_no, title, document_body, content_hash)
      VALUES ('ffffffff-0000-0000-0000-000000000010', '${ORG_A}', '${contractId}',
              1, '${title}', ${Q_BODY_V1}, '${correct}')
    `);

    const stored = await ownerRows<{ content_hash: string }>(
      "SELECT content_hash::text AS content_hash FROM contract_version WHERE org_id = $1 AND id = $2",
      [ORG_A, "ffffffff-0000-0000-0000-000000000010"],
    );
    // Read back through SQL, cast to text, so the assertion is about the database's
    // reading of the column rather than about a host-timezone value in Node.
    expect(stored[0]!.content_hash).toBe(correct);
  });

  it("hashes the version's IDENTITY as well as its text", async () => {
    // The property that makes the hash evidence ABOUT A DOCUMENT rather than about a
    // piece of text. Two contracts with identical wording hash differently, so a hash
    // copied from one contract cannot vouch for another — and, framed the other way,
    // the same text under a different version number is a different claim.
    const contractA = "ffffffff-0000-0000-0000-0000000000c4";
    const contractB = "ffffffff-0000-0000-0000-0000000000c5";
    const title = "Player Agreement 2026";

    const hashA = await hashFor(contractA, 1, title, BODY_V1);
    const hashB = await hashFor(contractB, 1, title, BODY_V1);
    const hashV2 = await hashFor(contractA, 2, title, BODY_V1);

    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toBe(hashV2);
  });

  it("frames the hashed fields so a shifted boundary cannot collide", async () => {
    // Without length framing, "ab" + "c" and "a" + "bc" would hash identically, and
    // two different documents would share a hash — at which point the hash proves
    // nothing about which one was signed. Moving one character across the title/body
    // boundary must therefore change the hash.
    const contractId = "ffffffff-0000-0000-0000-0000000000c6";
    const shifted = await hashFor(contractId, 1, "Player", ` Agreement 2026${BODY_V1}`);
    const unsplit = await hashFor(contractId, 1, "Player Agreement 2026", BODY_V1);

    expect(shifted).not.toBe(unsplit);
  });

  it("refuses a content hash that is not 64 lowercase hex characters", async () => {
    // The shape check, asserted on its own so the two checks are distinguishable: the
    // verification test above would also pass if this one were missing, and this one
    // would pass if the verification were missing.
    await asOwner(`
      INSERT INTO contract (id, org_id, person_id, kind, title)
      VALUES ('ffffffff-0000-0000-0000-0000000000c7', '${ORG_A}', '${PLAYER_ADULT}',
              'player_agreement', 'Player Agreement 2026')
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_version
            (id, org_id, contract_id, version_no, title, document_body, content_hash)
          VALUES ('ffffffff-0000-0000-0000-000000000010', '${ORG_A}',
                  'ffffffff-0000-0000-0000-0000000000c7', 1, 'Player Agreement 2026',
                  ${Q_BODY_V1}, 'NOT-A-HASH')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a content hash that is not hexadecimal",
    );
  });
});

// ---------------------------------------------------------------------------
// PROPERTY 3 — acceptance names a specific version and never covers a later one
// ---------------------------------------------------------------------------

describe("property 3 — acceptance names a specific version and never a later one", () => {
  it("keeps the acceptance on version 1 after version 2 exists, and does not cover version 2", async () => {
    // THE central test of this phase. Accept version 1. Then create version 2 with
    // different text — a correction. The acceptance must still point at version 1 and
    // must NOT cover version 2. If it covered version 2, "that was not the version I
    // signed" would be unanswerable, because the record would say the player agreed
    // to text they were never shown.
    const clock = await anchors();
    const title = "Player Agreement 2026";
    const seeded = await seedDraftContract(ORG_A, "99999999-0000-0000-0000-0000000000c1", PLAYER_ADULT);

    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    // Version 2, written CORRECTLY as a supersession of the head.
    const v2Hash = await hashFor(seeded.contractId, 2, title, BODY_V2);
    await asOwner(`
      INSERT INTO contract_version
        (id, org_id, contract_id, version_no, title, document_body, content_hash, supersedes_id)
      VALUES ('99999999-0000-0000-0000-000000000011', '${ORG_A}', '${seeded.contractId}',
              2, '${title}', ${Q_BODY_V2}, '${v2Hash}', '${seeded.versionId}')
    `);

    // The premise: TWO versions exist and the texts genuinely differ. Without this,
    // "the acceptance still points at N" could pass because there is only one N.
    const versions = await ownerRows<{ version_no: number; document_body: string }>(
      `SELECT version_no, document_body FROM contract_version
        WHERE org_id = $1 AND contract_id = $2 ORDER BY version_no`,
      [ORG_A, seeded.contractId],
    );
    expect(versions).toHaveLength(2);
    expect(versions[0]!.document_body).toBe(BODY_V1);
    expect(versions[1]!.document_body).not.toBe(versions[0]!.document_body);

    // The acceptance still names version 1 — asserted by joining the acceptance to
    // the version it names, so it cannot pass by the acceptance having been moved.
    const acceptance = await ownerRows<{
      contract_version_id: string;
      version_no: number;
      document_body: string;
      content_hash: string;
    }>(
      `SELECT a.contract_version_id,
              v.version_no,
              v.document_body,
              a.content_hash::text AS content_hash
         FROM contract_acceptance a
         JOIN contract_version v ON v.org_id = a.org_id AND v.id = a.contract_version_id
        WHERE a.org_id = $1 AND a.contract_id = $2`,
      [ORG_A, seeded.contractId],
    );

    expect(acceptance).toHaveLength(1);
    expect(acceptance[0]!.contract_version_id).toBe(seeded.versionId);
    expect(acceptance[0]!.version_no).toBe(1);
    // The text it accepted is still the ORIGINAL text, not the correction.
    expect(acceptance[0]!.document_body).toBe(BODY_V1);

    // And the version nobody signed is genuinely unsigned — a separate query, so
    // "no acceptance exists for version 2" is its own claim rather than an inference.
    const v2Acceptances = await ownerRows<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM contract_acceptance a
         JOIN contract_version v ON v.org_id = a.org_id AND v.id = a.contract_version_id
        WHERE a.org_id = $1 AND v.contract_id = $2 AND v.version_no = 2`,
      [ORG_A, seeded.contractId],
    );
    expect(v2Acceptances[0]!.n, "version 2 must NOT be covered by the acceptance of version 1").toBe(0);
  });

  it("refuses an acceptance that pins a hash other than the version's", async () => {
    const clock = await anchors();
    const contractId = "99999999-0000-0000-0000-0000000000c2";
    const title = "Player Agreement 2026";
    const correct = await hashFor(contractId, 1, title, BODY_V1);
    const seeded = await seedDraftContract(ORG_A, contractId, PLAYER_ADULT);
    expect(seeded.contentHash).toBe(correct);

    // The realistic forgery: an acceptance row that names version 1 but claims a
    // different hash, as though the player had signed something else.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_acceptance
            (id, org_id, contract_id, contract_version_id, accepted_by_person_id,
             accepted_at, identity_method, identity_assertion, method, content_hash)
          VALUES ('99999999-0000-0000-0000-0000000000a9', '${ORG_A}', '${contractId}',
                  '${seeded.versionId}', '${PLAYER_ADULT}', '${clock.signedAt}',
                  'email_otp', 'signer@example.test', 'electronic_signature', '${WRONG_HASH}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an acceptance pinning a hash that is not the version's",
    );
  });

  it("refuses an acceptance that names a version of a different contract", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "99999999-0000-0000-0000-0000000000c3", PLAYER_ADULT);

    // A second contract with the SAME person, so nothing about the fixture makes this
    // obviously wrong.
    const otherContract = "99999999-0000-0000-0000-0000000000c4";
    const otherTitle = "NDA";
    const otherHash = await hashFor(otherContract, 1, otherTitle, BODY_V1);
    await asOwner(`
      INSERT INTO contract (id, org_id, person_id, kind, title)
      VALUES ('${otherContract}', '${ORG_A}', '${PLAYER_ADULT}', 'nda', '${otherTitle}');
      INSERT INTO contract_version
        (id, org_id, contract_id, version_no, title, document_body, content_hash)
      VALUES ('99999999-0000-0000-0000-000000000020', '${ORG_A}', '${otherContract}',
              1, '${otherTitle}', ${Q_BODY_V1}, '${otherHash}')
    `);

    // Names contract A but version of contract B. The composite FKs cannot see it:
    // each column pair is individually valid.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_acceptance
            (id, org_id, contract_id, contract_version_id, accepted_by_person_id,
             accepted_at, identity_method, identity_assertion, method, content_hash)
          VALUES ('99999999-0000-0000-0000-0000000000a8', '${ORG_A}', '${seeded.contractId}',
                  '99999999-0000-0000-0000-000000000020', '${PLAYER_ADULT}', '${clock.signedAt}',
                  'email_otp', 'signer@example.test', 'electronic_signature', '${otherHash}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an acceptance naming a version belonging to a different contract",
    );
  });

  it("refuses an acceptance attributed to somebody who is not a party to the contract", async () => {
    // Self-signing is ordinary and is NOT what is being tested here; a contract for
    // PLAYER_ADULT signed by the WITNESS is a forgery with a row in the table.
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "99999999-0000-0000-0000-0000000000c5", PLAYER_ADULT);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_acceptance
            (id, org_id, contract_id, contract_version_id, accepted_by_person_id,
             accepted_at, identity_method, identity_assertion, method, content_hash)
          VALUES ('99999999-0000-0000-0000-0000000000a7', '${ORG_A}', '${seeded.contractId}',
                  '${seeded.versionId}', '${WITNESS}', '${clock.signedAt}',
                  'email_otp', 'signer@example.test', 'electronic_signature', '${seeded.contentHash}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an acceptance by a non-party",
    );
  });

  it("refuses a second acceptance of the same version", async () => {
    // "Who accepted this version" must have one answer. A double-click and a second
    // signer are the same shape here, and a re-signature of corrected text is a NEW
    // VERSION — which is the whole mechanism.
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "99999999-0000-0000-0000-0000000000c6", PLAYER_ADULT);
    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_acceptance
            (id, org_id, contract_id, contract_version_id, accepted_by_person_id,
             accepted_at, identity_method, identity_assertion, method, content_hash)
          VALUES ('99999999-0000-0000-0000-0000000000a6', '${ORG_A}', '${seeded.contractId}',
                  '${seeded.versionId}', '${PLAYER_ADULT}', '${clock.signedAt}',
                  'sso', 'staff@example.test', 'in_person_witnessed', '${seeded.contentHash}')
        `),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second acceptance of the same version",
    );
  });

  it("records who accepted, when, and under what identity", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "99999999-0000-0000-0000-0000000000c7", PLAYER_ADULT);
    await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    const found = await ownerRows<{
      accepted_by_person_id: string;
      external_ref: string;
      accepted_at: string;
      identity_method: string;
      identity_assertion: string;
      method: string;
    }>(
      `SELECT a.accepted_by_person_id,
              p.external_ref,
              to_char(a.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS accepted_at,
              a.identity_method::text AS identity_method,
              a.identity_assertion,
              a.method::text AS method
         FROM contract_acceptance a
         JOIN person p ON p.id = a.accepted_by_person_id
        WHERE a.org_id = $1 AND a.contract_id = $2`,
      [ORG_A, seeded.contractId],
    );

    expect(found).toHaveLength(1);
    expect(found[0]!.accepted_by_person_id).toBe(PLAYER_ADULT);
    expect(found[0]!.external_ref).toBe("adult");
    // Cast to text in SQL: PGlite hands Node a host-timezone Date otherwise, and the
    // assertion would be about the test runner's locale rather than the record.
    expect(found[0]!.accepted_at).toBe(clock.signedAt);
    expect(found[0]!.identity_method).toBe("email_otp");
    expect(found[0]!.identity_assertion).toBe("signer@example.test");
    expect(found[0]!.method).toBe("electronic_signature");
  });

  it("refuses an acceptance with no identity assertion", async () => {
    // "We checked them somehow" is not a provable acceptance. A blank assertion is
    // refused by the CHECK, which is why the column is NOT NULL *and* trimmed.
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "99999999-0000-0000-0000-0000000000c8", PLAYER_ADULT);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO contract_acceptance
            (id, org_id, contract_id, contract_version_id, accepted_by_person_id,
             accepted_at, identity_method, identity_assertion, method, content_hash)
          VALUES ('99999999-0000-0000-0000-0000000000a5', '${ORG_A}', '${seeded.contractId}',
                  '${seeded.versionId}', '${PLAYER_ADULT}', '${clock.signedAt}',
                  'email_otp', '   ', 'electronic_signature', '${seeded.contentHash}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an acceptance whose identity assertion is blank",
    );
  });
});

// ---------------------------------------------------------------------------
// PROPERTIES 4 AND 5 — acceptance is append-only; withdrawal is a separate row
// ---------------------------------------------------------------------------

describe("properties 4 and 5 — acceptance is append-only and withdrawal is a row", () => {
  it("refuses an UPDATE of an acceptance, by trigger and by grant", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "77777777-0000-0000-0000-0000000000c1", PLAYER_ADULT);
    const acceptanceId = await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    // Mechanism one: the trigger, which refuses EVERYONE including the owner.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE contract_acceptance SET accepted_by_person_id = '${WITNESS}'
           WHERE org_id = '${ORG_A}' AND id = '${acceptanceId}'
        `),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "updating an acceptance as the owner",
    );

    // Mechanism two: the GRANT, which removes the permission before it is attempted.
    // Asserted over the catalogue rather than by trying it, because trying it as the
    // owner would test the trigger a second time.
    const grants = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'contract_acceptance' AND grantee = 'raptor_app'
          AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(grants, "the application role must hold no UPDATE or DELETE on an acceptance").toHaveLength(0);

    // And the row is untouched: an acceptance that names the wrong signer would be
    // worse than no acceptance at all.
    const after = await ownerRows<{ accepted_by_person_id: string }>(
      "SELECT accepted_by_person_id FROM contract_acceptance WHERE org_id = $1 AND id = $2",
      [ORG_A, acceptanceId],
    );
    expect(after[0]!.accepted_by_person_id).toBe(PLAYER_ADULT);
  });

  it("refuses a DELETE of an acceptance", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "77777777-0000-0000-0000-0000000000c2", PLAYER_ADULT);
    const acceptanceId = await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    await expectSqlstate(
      () => asOwner(`DELETE FROM contract_acceptance WHERE org_id = '${ORG_A}' AND id = '${acceptanceId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting an acceptance",
    );
  });

  it("refuses a DELETE of a withdrawal, so the record of a withdrawal is permanent", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "77777777-0000-0000-0000-0000000000c3", PLAYER_ADULT);
    const acceptanceId = await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    await asOwner(`
      INSERT INTO acceptance_withdrawal
        (id, org_id, acceptance_id, withdrawn_by_person_id, withdrawn_at, reason)
      VALUES ('77777777-0000-0000-0000-000000000020', '${ORG_A}', '${acceptanceId}',
              '${WITNESS}', '${clock.signedAt}', 'Player disputes the clause on bonuses')
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          DELETE FROM acceptance_withdrawal
           WHERE org_id = '${ORG_A}' AND acceptance_id = '${acceptanceId}'
        `),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting a withdrawal",
    );

    // The premise, asserted so the refusal cannot pass by matching zero rows: a
    // DELETE that removes nothing also "succeeds".
    const present = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM acceptance_withdrawal WHERE org_id = $1 AND acceptance_id = $2",
      [ORG_A, acceptanceId],
    );
    expect(present[0]!.n, "the withdrawal must exist for its refusal to mean anything").toBe(1);
  });

  it("withdraws by a new row that leaves the acceptance itself untouched", async () => {
    // The shape of the whole argument: the acceptance is evidence that someone
    // signed, so the act that takes it back must not be able to edit it. Both rows
    // exist afterwards and the acceptance is unchanged.
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "77777777-0000-0000-0000-0000000000c4", PLAYER_ADULT);
    const acceptanceId = await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    await asOwner(`
      INSERT INTO acceptance_withdrawal
        (id, org_id, acceptance_id, withdrawn_by_person_id, withdrawn_at, reason)
      VALUES ('77777777-0000-0000-0000-000000000042', '${ORG_A}', '${acceptanceId}',
              '${WITNESS}', '${clock.signedAt}', 'Withdrawn at the player''s request')
    `);

    const found = await ownerRows<{
      acceptances: number;
      withdrawals: number;
      hash_still_there: boolean;
      reason: string;
    }>(
      `SELECT (SELECT count(*)::int FROM contract_acceptance  WHERE org_id = $1 AND id = $2) AS acceptances,
              (SELECT count(*)::int FROM acceptance_withdrawal WHERE org_id = $1 AND acceptance_id = $2) AS withdrawals,
              (SELECT content_hash = $3 FROM contract_acceptance WHERE org_id = $1 AND id = $2) AS hash_still_there,
              (SELECT reason FROM acceptance_withdrawal WHERE org_id = $1 AND acceptance_id = $2) AS reason`,
      [ORG_A, acceptanceId, seeded.contentHash],
    );

    expect(found[0]!.acceptances, "the acceptance survives the withdrawal").toBe(1);
    expect(found[0]!.withdrawals).toBe(1);
    expect(found[0]!.hash_still_there, "the acceptance still carries the hash it was made with").toBe(true);
    // The reason travels with the withdrawal, not with the acceptance — which is the
    // whole reason it is a separate row.
    expect(found[0]!.reason).toBe("Withdrawn at the player's request");
  });

  it("refuses a withdrawal with no reason", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "77777777-0000-0000-0000-0000000000c5", PLAYER_ADULT);
    const acceptanceId = await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO acceptance_withdrawal
            (id, org_id, acceptance_id, withdrawn_by_person_id, withdrawn_at, reason)
          VALUES ('77777777-0000-0000-0000-000000000043', '${ORG_A}', '${acceptanceId}',
                  '${WITNESS}', '${clock.signedAt}', '   ')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a withdrawal with a blank reason",
    );
  });

  it("refuses a second withdrawal of the same acceptance", async () => {
    const clock = await anchors();
    const seeded = await seedDraftContract(ORG_A, "77777777-0000-0000-0000-0000000000c6", PLAYER_ADULT);
    const acceptanceId = await seedAcceptance(
      ORG_A,
      seeded.contractId,
      seeded.versionId,
      seeded.contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    const row = (id: string): string => `
      INSERT INTO acceptance_withdrawal
        (id, org_id, acceptance_id, withdrawn_by_person_id, withdrawn_at, reason)
      VALUES ('${id}', '${ORG_A}', '${acceptanceId}', '${WITNESS}', '${clock.signedAt}', 'reason text')
    `;

    await asOwner(row("77777777-0000-0000-0000-000000000044"));
    await expectSqlstate(
      () => asOwner(row("77777777-0000-0000-0000-000000000045")),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second withdrawal of one acceptance",
    );
  });
});

// ---------------------------------------------------------------------------
// MINORS AND CONSENT
// ---------------------------------------------------------------------------

describe("minors and consent — a minor cannot be engaged without guardian consent", () => {
  /**
   * Writes an engagement AND the guardian consent that legitimises it, inside one
   * transaction, and commits.
   *
   * This exists because of the DEFERRABLE guard: consent names an engagement through
   * a foreign key, so the engagement has to exist before the consent row can be
   * written, and the guard has to run at COMMIT for the pair to be legal at all. Every
   * legal minor engagement in this file is written through here, and every test that
   * asserts a refusal is contrasted with a call to this one — otherwise a guard that
   * refuses EVERYTHING would pass every refusal test while making the domain
   * unexpressible.
   */
  async function writeEngagementWithConsent(options: {
    readonly engagementId: string;
    readonly orgId: string;
    readonly personId: string;
    readonly validFrom: string;
    readonly consentId: string;
    readonly expiresAt?: string;
  }): Promise<void> {
    const { engagementId, orgId, personId, validFrom, consentId } = options;
    const expiry = options.expiresAt === undefined ? "NULL" : sql(options.expiresAt);

    // BEGIN…COMMIT in ONE exec call, deliberately. The guard is a DEFERRABLE
    // constraint trigger, so it fires at COMMIT and reads the state of the transaction
    // as it is then — not as it was when the engagement was inserted. Splitting the
    // statements across separate exec calls opens an implicit transaction per call,
    // the engagement would commit alone, and the guard would (correctly) refuse it.
    // That failure is a property of the harness, not of the schema, and the two are
    // worth telling apart.
    await asOwner(`
      BEGIN;
      INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
      VALUES ('${engagementId}', '${orgId}', '${personId}', 'player', '${validFrom}');

      INSERT INTO guardian_consent
        (id, org_id, person_id, engagement_id, guardian_name, guardian_person_id,
         relationship, document_asset_id, granted_at, expires_at)
      VALUES ('${consentId}', '${orgId}', '${personId}', '${engagementId}',
              'R. Guardian', '${GUARDIAN}', 'parent',
              'aaaaaaaa-0000-0000-0000-0000000000ff', '${validFrom}', ${expiry});
      COMMIT;
    `);
  }

  it("refuses to commit an engagement for a known minor with no guardian consent", async () => {
    const clock = await anchors();
    // The premise: the person IS a minor today. Asserted through the database's own
    // function so the test cannot pass because the fixture failed to make a minor.
    expect(await majorityOf(PLAYER_MINOR, clock.today)).toBe("minor");

    // One statement, one transaction: the deferrable guard fires at COMMIT.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
          VALUES ('66666666-0000-0000-0000-0000000000e1', '${ORG_A}', '${PLAYER_MINOR}',
                  'player', '${clock.lastYear}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "committing an engagement for a minor with no consent",
    );

    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement WHERE org_id = $1",
      [ORG_A],
    );
    expect(stored[0]!.n, "a refused engagement must leave nothing behind").toBe(0);
  });

  it("accepts a minor's engagement when a guardian consented to THAT engagement", async () => {
    // The legal path, demonstrated. A guard that refuses everything would leave the
    // domain unexpressible and would be disabled by the first person who hit it.
    const clock = await anchors();
    await writeEngagementWithConsent({
      engagementId: "66666666-0000-0000-0000-0000000000e2",
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId: "66666666-0000-0000-0000-0000000000c1",
    });

    const found = await ownerRows<{ engagements: number; consents: number; status: string }>(
      `SELECT (SELECT count(*)::int FROM engagement      WHERE org_id = $1 AND person_id = $2) AS engagements,
              (SELECT count(*)::int FROM guardian_consent WHERE org_id = $1 AND person_id = $2) AS consents,
              (SELECT public.majority_status(p.birth_date, $3::date)
                 FROM person p WHERE p.id = $2) AS status`,
      [ORG_A, PLAYER_MINOR, clock.today],
    );

    expect(found[0]!.engagements).toBe(1);
    expect(found[0]!.consents).toBe(1);
    expect(found[0]!.status).toBe("minor");
  });

  it("refuses a guardian consent that names somebody else's engagement", async () => {
    // Consent is per-engagement, so a consent for engagement A cannot legitimise
    // engagement B. This is the difference between consent and a global flag, and it
    // is exactly the rule the 0001 shape could not express.
    const clock = await anchors();
    const engagementA = "66666666-0000-0000-0000-0000000000e3";
    const engagementB = "66666666-0000-0000-0000-0000000000e4";

    // A real, valid minor engagement with its own consent.
    await writeEngagementWithConsent({
      engagementId: engagementA,
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId: "66666666-0000-0000-0000-0000000000c2",
    });

    // Close A so a second CURRENT engagement is permitted at all. Without this the
    // next attempt would be refused by `engagement_current_per_classification_key`
    // and this test would pass for the wrong reason — which is exactly the mistake
    // this file exists not to make.
    await asOwner(`
      UPDATE engagement SET valid_to = '${clock.signedAt}'
       WHERE org_id = '${ORG_A}' AND id = '${engagementA}'
    `);

    // THE claim. A consent row exists for this person, from a real guardian, and it
    // does NOT answer for a different engagement.
    const coverage = await ownerRows<{ covers_a: boolean; covers_b: boolean }>(
      `SELECT public.guardian_consent_covers_in_org($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) AS covers_a,
              public.guardian_consent_covers_in_org($1::uuid, $2::uuid, $5::uuid, $4::timestamptz) AS covers_b`,
      [ORG_A, PLAYER_MINOR, engagementA, `${clock.lastYear}T00:00:00Z`, engagementB],
    );

    expect(coverage[0]!.covers_a, "consent for engagement A must cover engagement A").toBe(true);
    expect(
      coverage[0]!.covers_b,
      "consent for engagement A must NOT cover engagement B — that would be the global flag 0001 had",
    ).toBe(false);

    // And so the engagement itself is refused, which is the same fact reached through
    // the constraint rather than through the predicate.
    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
          VALUES ('${engagementB}', '${ORG_A}', '${PLAYER_MINOR}', 'player', '${clock.lastYear}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an engagement relying on another engagement's consent",
    );
  });

  it("refuses a minor's engagement when the guardian consent had already been withdrawn", async () => {
    const clock = await anchors();
    const engagementId = "66666666-0000-0000-0000-0000000000e5";
    const consentId = "66666666-0000-0000-0000-0000000000c4";

    await writeEngagementWithConsent({
      engagementId,
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId,
    });

    // The withdrawal is its own append-only row.
    await asOwner(`
      INSERT INTO guardian_consent_withdrawal
        (id, org_id, guardian_consent_id, withdrawn_by_person_id, withdrawn_at, reason)
      VALUES ('66666666-0000-0000-0000-000000000020', '${ORG_A}', '${consentId}',
              '${GUARDIAN}', '${clock.signedAt}', 'Guardian withdrew consent')
    `);

    // A SECOND engagement for the same minor is refused. Closed the first one first,
    // so the refusal cannot be `engagement_current_per_classification_key` doing the
    // work instead of the consent rule this test is about.
    await asOwner(`
      UPDATE engagement SET valid_to = '${clock.signedAt}'
       WHERE org_id = '${ORG_A}' AND id = '${engagementId}'
    `);

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
          VALUES ('66666666-0000-0000-0000-0000000000e6', '${ORG_A}', '${PLAYER_MINOR}',
                  'player', '${clock.lastYear}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an engagement for a minor whose consent was withdrawn",
    );

    // And the consent itself is untouched by the withdrawal — asserted so the
    // withdrawal cannot be passing for a mutation.
    const consent = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM guardian_consent WHERE org_id = $1 AND id = $2",
      [ORG_A, consentId],
    );
    expect(consent[0]!.n, "the consent row survives its own withdrawal").toBe(1);
  });

  it("refuses a minor's engagement when the guardian consent had expired before it began", async () => {
    // Expiry is arithmetic on a stored instant, not a flag somebody sets. The consent
    // here was valid from a year ago and expired last month, so an engagement starting
    // now has no consent in force.
    const clock = await anchors();
    const engagementId = "66666666-0000-0000-0000-0000000000e7";
    const consentId = "66666666-0000-0000-0000-0000000000c5";

    await expectSqlstate(
      () =>
        writeEngagementWithConsent({
          engagementId,
          orgId: ORG_A,
          personId: PLAYER_MINOR,
          validFrom: clock.lastYear,
          consentId,
          expiresAt: clock.lastYear,
        }),
      SQLSTATE_CHECK_VIOLATION,
      "an engagement beginning after its guardian consent expired",
    );

    // The same consent, at a moment INSIDE its validity, is accepted — so the refusal
    // above is about the boundary and not about the shape of the row.
    await writeEngagementWithConsent({
      engagementId: "66666666-0000-0000-0000-0000000000e8",
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId: "66666666-0000-0000-0000-0000000000c6",
      expiresAt: clock.nextYear,
    });

    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement WHERE org_id = $1 AND person_id = $2",
      [ORG_A, PLAYER_MINOR],
    );
    expect(stored[0]!.n).toBe(1);
  });

  it("makes it impossible for the guardian to be the person they are guarding", async () => {
    // The hard case. A self-consent loop provides zero independent authority, so it is
    // refused structurally rather than tolerated with a second signature: admitting it
    // "as long as another guardian also signs" would still let the schema store a
    // record naming a person as the independent authority over their own engagement.
    const clock = await anchors();

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
          VALUES ('66666666-0000-0000-0000-0000000000ea', '${ORG_A}', '${PLAYER_MINOR}',
                  'player', '${clock.lastYear}');
          INSERT INTO guardian_consent
            (id, org_id, person_id, engagement_id, guardian_name, guardian_person_id,
             relationship, document_asset_id, granted_at)
          VALUES ('66666666-0000-0000-0000-0000000000ca', '${ORG_A}', '${PLAYER_MINOR}',
                  '66666666-0000-0000-0000-0000000000ea',
                  'Self', '${PLAYER_MINOR}', 'parent',
                  'aaaaaaaa-0000-0000-0000-0000000000ff', '${clock.lastYear}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a person consenting to their own engagement",
    );

    // And the reference is not merely "not equal for this fixture": a different
    // guardian on the same engagement is accepted, so the guard is about the identity
    // and not about minors in general.
    await writeEngagementWithConsent({
      engagementId: "66666666-0000-0000-0000-0000000000eb",
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId: "66666666-0000-0000-0000-0000000000cb",
    });

    const guardians = await ownerRows<{ guardian_person_id: string; person_id: string }>(
      `SELECT guardian_person_id, person_id FROM guardian_consent
        WHERE org_id = $1 AND person_id = $2`,
      [ORG_A, PLAYER_MINOR],
    );
    expect(guardians).toHaveLength(1);
    expect(guardians[0]!.guardian_person_id).toBe(GUARDIAN);
    expect(guardians[0]!.guardian_person_id).not.toBe(guardians[0]!.person_id);
  });

  it("requires a guardian consent to name a relationship and a specific engagement", async () => {
    // Independently provable means: WHO the guardian was, WHAT they are to the person,
    // and WHICH engagement. Two of the three are NOT NULL; the third is the composite
    // FK. A consent with any of them missing is not provable.
    const clock = await anchors();
    const engagementId = "66666666-0000-0000-0000-0000000000ec";
    await asOwner(`
      BEGIN;
      INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
      VALUES ('${engagementId}', '${ORG_A}', '${PLAYER_ADULT}', 'player', '${clock.lastYear}');
      COMMIT;
    `);

    // No relationship: a name and an identity are not enough to say what the guardian
    // IS to the person.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO guardian_consent
            (id, org_id, person_id, engagement_id, guardian_name, guardian_person_id, granted_at)
          VALUES ('66666666-0000-0000-0000-0000000000cc', '${ORG_A}', '${PLAYER_ADULT}',
                  '${engagementId}', 'R. Guardian', '${GUARDIAN}', '${clock.lastYear}')
        `),
      SQLSTATE_NOT_NULL_VIOLATION,
      "a guardian consent with no relationship",
    );

    // No engagement: consent to WHAT?
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO guardian_consent
            (id, org_id, person_id, guardian_name, guardian_person_id, relationship, granted_at)
          VALUES ('66666666-0000-0000-0000-0000000000cd', '${ORG_A}', '${PLAYER_ADULT}',
                  'R. Guardian', '${GUARDIAN}', 'parent', '${clock.lastYear}')
        `),
      SQLSTATE_NOT_NULL_VIOLATION,
      "a guardian consent naming no engagement",
    );

    // No organisation: consent given to one org must not authorise another.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO guardian_consent
            (id, person_id, engagement_id, guardian_name, guardian_person_id, relationship, granted_at)
          VALUES ('66666666-0000-0000-0000-0000000000ce', '${PLAYER_ADULT}',
                  '${engagementId}', 'R. Guardian', '${GUARDIAN}', 'parent', '${clock.lastYear}')
        `),
      SQLSTATE_NOT_NULL_VIOLATION,
      "a guardian consent naming no organisation",
    );
  });

  it("refuses two guardian consents for the same engagement", async () => {
    const clock = await anchors();
    await writeEngagementWithConsent({
      engagementId: "66666666-0000-0000-0000-0000000000ed",
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId: "66666666-0000-0000-0000-0000000000cf",
    });

    // A second guardian for the SAME engagement is refused: consent to an engagement
    // is a fact about that engagement, and two guardians "consented" to it means
    // neither of them did.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO guardian_consent
            (id, org_id, person_id, engagement_id, guardian_name, guardian_person_id,
             relationship, document_asset_id, granted_at)
          VALUES ('66666666-0000-0000-0000-0000000000d0', '${ORG_A}', '${PLAYER_MINOR}',
                  '66666666-0000-0000-0000-0000000000ed',
                  'S. Guardian', '${WITNESS}', 'legal_guardian',
                  'aaaaaaaa-0000-0000-0000-0000000000fe', '${clock.lastYear}')
        `),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second guardian consent for one engagement",
    );
  });

  it("refuses to change or delete a guardian consent", async () => {
    const clock = await anchors();
    const consentId = "66666666-0000-0000-0000-0000000000d1";
    await writeEngagementWithConsent({
      engagementId: "66666666-0000-0000-0000-0000000000ee",
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId,
    });

    await expectSqlstate(
      () => asOwner(`UPDATE guardian_consent SET guardian_name = 'Someone Else' WHERE id = '${consentId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "changing a guardian consent",
    );

    await expectSqlstate(
      () => asOwner(`DELETE FROM guardian_consent WHERE id = '${consentId}'`),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "deleting a guardian consent",
    );

    // 0001 granted ALL on guardian_consent. That grant is taken back here — asserted
    // over the catalogue, because a test that merely TRIED the delete would be
    // satisfied by the trigger and would not notice the grant.
    const grants = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'guardian_consent' AND grantee = 'raptor_app'
          AND privilege_type IN ('UPDATE','DELETE')`,
    );
    expect(grants).toHaveLength(0);
  });

  it("refuses an age-restricted engagement for a person with no recorded birth date", async () => {
    // Where the law genuinely requires proof of age, an absent birth date is a
    // REFUSAL rather than an unknown. This is the strict half of the minors rule and
    // it is deliberately stricter than the general case.
    const clock = await anchors();
    expect(await majorityOf(PLAYER_UNKNOWN_AGE, clock.today)).toBe("unknown");

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO engagement (id, org_id, person_id, classification, is_age_restricted, valid_from)
          VALUES ('66666666-0000-0000-0000-0000000000ef', '${ORG_A}', '${PLAYER_UNKNOWN_AGE}',
                  'player', true, '${clock.lastYear}');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an age-restricted engagement for a person of unknown age",
    );
  });

  it("accepts an age-restricted engagement for a known adult, with no guardian needed", async () => {
    const clock = await anchors();
    expect(await majorityOf(PLAYER_ADULT, clock.today)).toBe("adult");

    await asOwner(`
      BEGIN;
      INSERT INTO engagement (id, org_id, person_id, classification, is_age_restricted, valid_from)
      VALUES ('66666666-0000-0000-0000-0000000000f0', '${ORG_A}', '${PLAYER_ADULT}',
              'player', true, '${clock.lastYear}');
      COMMIT;
    `);

    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement WHERE org_id = $1 AND person_id = $2",
      [ORG_A, PLAYER_ADULT],
    );
    expect(stored[0]!.n).toBe(1);
  });

  it("answers the majority boundary on the day before, the day, and the day after", async () => {
    // A stored boolean would make this untestable — which is the point. The reference
    // dates are computed in SQL from the birth date so the fixture cannot drift out of
    // step with the rule, and each row is asserted individually.
    const found = await ownerRows<{ label: string; d: string; status: string }>(
      `WITH b AS (SELECT birth_date FROM person WHERE id = $1)
       SELECT label, d,
              public.majority_status(b.birth_date, d::date) AS status
         FROM b,
              LATERAL (VALUES
                ('day before', ((b.birth_date + INTERVAL '18 years')::date - 1)),
                ('day of',     ((b.birth_date + INTERVAL '18 years')::date)),
                ('day after',  ((b.birth_date + INTERVAL '18 years')::date + 1))
              ) AS v(label, d)
        ORDER BY d`,
      [PLAYER_ADULT],
    );

    expect(found).toHaveLength(3);
    expect(found.map((r) => [r.label, r.status])).toEqual([
      ["day before", "minor"],
      ["day of", "adult"],
      ["day after", "adult"],
    ]);

    // And the ENGAGEMENT GUARD agrees with the function at the same boundary, because
    // the guard reads the function rather than restating the threshold. This is what
    // would catch it if the trigger ever grew its own copy of the number.
    //
    // The person is engaged twice: once starting the day BEFORE they turn 18 (refused
    // — they are a minor, so a guardian must consent) and once starting ON the
    // birthday (accepted — they are an adult, so no guardian is required). Two
    // engagements, so the first is closed before the second is written and neither
    // refusal can be `engagement_current_per_classification_key`.
    const eighteenth = await ownerRows<{ d: string }>(
      `SELECT to_char(birth_date + INTERVAL '18 years', 'YYYY-MM-DD') AS d
         FROM person WHERE id = $1`,
      [PLAYER_MINOR],
    );
    const dayBefore = await ownerRows<{ d: string }>(
      `SELECT to_char(birth_date + INTERVAL '18 years' - INTERVAL '1 day', 'YYYY-MM-DD') AS d
         FROM person WHERE id = $1`,
      [PLAYER_MINOR],
    );

    await expectSqlstate(
      () =>
        asOwner(`
          BEGIN;
          INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
          VALUES ('66666666-0000-0000-0000-0000000000f1', '${ORG_A}', '${PLAYER_MINOR}',
                  'player', '${dayBefore[0]!.d}T00:00:00Z');
          COMMIT;
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an engagement starting the day before the 18th birthday, with no guardian consent",
    );

    await asOwner(`
      BEGIN;
      INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
      VALUES ('66666666-0000-0000-0000-0000000000f2', '${ORG_A}', '${PLAYER_MINOR}',
              'player', '${eighteenth[0]!.d}T00:00:00Z');
      COMMIT;
    `);

    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement WHERE org_id = $1 AND person_id = $2",
      [ORG_A, PLAYER_MINOR],
    );
    expect(
      stored[0]!.n,
      "exactly one engagement survives: the day-before one refused, the birthday one accepted",
    ).toBe(1);
  });

  it("judges majority on the engagement's start date, not on the clock at insert time", async () => {
    // A player who is 17 today and turns 18 next month is engageable next month.
    // Judging them by now() would refuse a contract that is correct on the day it
    // starts — and would make the same engagement legal or illegal depending on when
    // somebody re-ran the query.
    const eighteenth = await ownerRows<{ d: string }>(
      `SELECT to_char(birth_date + INTERVAL '18 years', 'YYYY-MM-DD') AS d
         FROM person WHERE id = $1`,
      [PLAYER_MINOR],
    );
    const startOnEighteenth = `${eighteenth[0]!.d}T00:00:00Z`;

    // Today they are a minor.
    const clock = await anchors();
    expect(await majorityOf(PLAYER_MINOR, clock.today)).toBe("minor");

    // The same person, engaged from the day they turn 18, needs NO guardian.
    await asOwner(`
      BEGIN;
      INSERT INTO engagement (id, org_id, person_id, classification, valid_from)
      VALUES ('66666666-0000-0000-0000-0000000000f3', '${ORG_A}', '${PLAYER_MINOR}',
              'player', '${startOnEighteenth}');
      COMMIT;
    `);

    const stored = await ownerRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM engagement WHERE org_id = $1 AND id = $2",
      [ORG_A, "66666666-0000-0000-0000-0000000000f3"],
    );
    expect(stored[0]!.n, "a minor whose engagement starts on their 18th birthday needs no guardian").toBe(1);
  });

  it("stores no majority flag anywhere in the schema", async () => {
    // The absence, asserted. A boolean column would make every one of the tests above
    // bypassable by a query that read the column instead of calling the function, and
    // a stored boolean can be set wrongly by exactly one careless UPDATE.
    const offenders = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type = 'boolean'
          AND column_name ~ '(is_minor|is_adult|minor|adult|majority|is_under_age)'
        ORDER BY table_name, column_name`,
    );

    expect(
      offenders.map((r) => `${r.table_name}.${r.column_name}`),
      "majority must be a function of a birth date and a reference date, never a stored flag",
    ).toEqual([]);
  });

  it("answers the consent question through a function that takes no tenant argument", async () => {
    // ADR-0011 rule 3: the caller never chooses which tenant they ask about. The
    // function's INPUT arguments are rendered with pg_get_function_arguments, which
    // shows inputs only — proargnames would also carry the OUT columns.
    const signature = await ownerRows<{ in_args: string }>(
      `SELECT pg_get_function_arguments(p.oid) AS in_args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'guardian_consent_covers'`,
    );

    expect(signature).toHaveLength(1);
    expect(signature[0]!.in_args).not.toMatch(/org/i);
  });

  it("resolves the consent question from the session, not from a parameter", async () => {
    const clock = await anchors();
    await writeEngagementWithConsent({
      engagementId: "66666666-0000-0000-0000-0000000000f4",
      orgId: ORG_A,
      personId: PLAYER_MINOR,
      validFrom: clock.lastYear,
      consentId: "66666666-0000-0000-0000-0000000000d3",
    });

    // ORG_A's session sees the consent.
    const asA = await appRows<{ covers: boolean }>(
      `SELECT public.guardian_consent_covers($1::uuid, $2::uuid, $3::timestamptz) AS covers`,
      [PLAYER_MINOR, "66666666-0000-0000-0000-0000000000f4", `${clock.lastYear}T00:00:00Z`],
    );
    expect(asA[0]!.covers).toBe(true);

    // ORG_B's session does not — the same question, asked by a different tenant, and
    // the answer changes because the SESSION changed and nothing else did.
    await asApp(async () => {
      const found = await db.query<{ covers: boolean }>(
        `SELECT public.guardian_consent_covers($1::uuid, $2::uuid, $3::timestamptz) AS covers`,
        [PLAYER_MINOR, "66666666-0000-0000-0000-0000000000f4", `${clock.lastYear}T00:00:00Z`],
      );
      expect(found.rows[0]!.covers, "consent in one tenant must not answer for another").toBe(false);
    }, ORG_B);

    // And with no session tenant, it fails closed rather than answering for everyone.
    await asApp(async () => {
      const found = await db.query<{ covers: boolean }>(
        `SELECT public.guardian_consent_covers($1::uuid, $2::uuid, $3::timestamptz) AS covers`,
        [PLAYER_MINOR, "66666666-0000-0000-0000-0000000000f4", `${clock.lastYear}T00:00:00Z`],
      );
      expect(found.rows[0]!.covers).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// COMPENSATION
// ---------------------------------------------------------------------------

describe("compensation agreements are money with a contract behind them", () => {
  it("stores money as numeric(18,4) beside an ISO-4217 currency, never an integer or a float", async () => {
    const found = await ownerRows<{ column_name: string; data_type: string; numeric_precision: number; numeric_scale: number }>(
      `SELECT column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = 'compensation_agreement' AND column_name IN ('amount', 'currency')`,
    );

    const amount = found.find((c) => c.column_name === "amount");
    const currency = found.find((c) => c.column_name === "currency");

    // ADR-0003: numeric(18,4) beside a currency code. An integer minor unit was
    // considered and rejected (currencies carry more than two decimal places), and a
    // float cannot represent 0.1 — which is the whole reason ADR-0003 exists.
    expect(amount!.data_type).toBe("numeric");
    expect(amount!.numeric_precision).toBe(18);
    expect(amount!.numeric_scale).toBe(4);
    expect(currency!.data_type).toBe("character varying");
  });

  it("refuses a currency that is not three uppercase letters", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c1", PLAYER_ADULT, clock.lastYear);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO compensation_agreement
            (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
          VALUES ('55555555-0000-0000-0000-0000000000c1', '${ORG_A}', '${PLAYER_ADULT}',
                  '${engagementId}', 'salary', 'Base', 'inr', 3000000.0000, '${clock.lastYear}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a lowercase currency code",
    );
  });

  it("refuses a negative pay figure", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c2", PLAYER_ADULT, clock.lastYear);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO compensation_agreement
            (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
          VALUES ('55555555-0000-0000-0000-0000000000c2', '${ORG_A}', '${PLAYER_ADULT}',
                  '${engagementId}', 'salary', 'Base', 'INR', -1.0000, '${clock.lastYear}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a negative salary",
    );
  });

  it("keeps four decimal places exactly, through the round trip", async () => {
    // A figure that survives storage unchanged is a claim that can be made exactly.
    // Read back through SQL: a float would return 1234.5600000000001 and the
    // comparison below would catch it.
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c3", PLAYER_ADULT, clock.lastYear);

    await asOwner(`
      INSERT INTO compensation_agreement
        (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
      VALUES ('55555555-0000-0000-0000-0000000000c3', '${ORG_A}', '${PLAYER_ADULT}',
              '${engagementId}', 'salary', 'Base', 'INR', 1234.5601, '${clock.lastYear}')
    `);

    const found = await ownerRows<{ amount: string }>(
      "SELECT amount::text AS amount FROM compensation_agreement WHERE org_id = $1 AND id = $2",
      [ORG_A, "55555555-0000-0000-0000-0000000000c3"],
    );
    expect(found[0]!.amount).toBe("1234.5601");
  });

  it("freezes the pay figure once a contract covering the engagement has been accepted", async () => {
    // "A pay figure editable after signing is a different dispute." So the same
    // discipline as a contract: once anything about the engagement has been accepted,
    // the figure that applied at that moment must remain answerable.
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c4", PLAYER_ADULT, clock.lastYear);
    const agreementId = "55555555-0000-0000-0000-0000000000c4";
    const contractId = "55555555-0000-0000-0000-0000000000d4";

    await asOwner(`
      INSERT INTO compensation_agreement
        (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
      VALUES ('${agreementId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}',
              'salary', 'Base', 'INR', 3000000.0000, '${clock.lastYear}');

      INSERT INTO contract (id, org_id, person_id, engagement_id, kind, title)
      VALUES ('${contractId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}',
              'employment', 'Employment Agreement');
    `);

    // The version for that contract, written directly rather than through
    // seedDraftContract — which inserts the contract row too, and inserting it twice
    // would fail on the primary key for reasons that have nothing to do with this
    // test.
    const contentHash = await hashFor(contractId, 1, "Employment Agreement", BODY_V1);
    await asOwner(`
      INSERT INTO contract_version
        (id, org_id, contract_id, version_no, title, document_body, content_hash)
      VALUES ('${contractId.slice(0, 8)}-0000-0000-0000-000000000010', '${ORG_A}',
              '${contractId}', 1, 'Employment Agreement', ${Q_BODY_V1}, '${contentHash}')
    `);

    await seedAcceptance(
      ORG_A,
      contractId,
      `${contractId.slice(0, 8)}-0000-0000-0000-000000000010`,
      contentHash,
      PLAYER_ADULT,
      clock.signedAt,
    );

    // The premise: an accepted contract really does cover this engagement.
    const under = await ownerRows<{ frozen: boolean }>(
      "SELECT public.compensation_is_under_contract($1::uuid, $2::uuid) AS frozen",
      [ORG_A, engagementId],
    );
    expect(under[0]!.frozen).toBe(true);

    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE compensation_agreement SET amount = 9000000.0000
           WHERE org_id = '${ORG_A}' AND id = '${agreementId}'
        `),
      SQLSTATE_INSUFFICIENT_PRIVILEGE,
      "changing a pay figure under an accepted contract",
    );

    // Archiving stays available: it is not a change to what was agreed, and refusing
    // it would leave no way to retire a superseded agreement at all.
    await asOwner(`
      UPDATE compensation_agreement SET archived_at = now()
       WHERE org_id = '${ORG_A}' AND id = '${agreementId}'
    `);

    const after = await ownerRows<{ amount: string; archived: boolean }>(
      `SELECT amount::text AS amount, archived_at IS NOT NULL AS archived
         FROM compensation_agreement WHERE org_id = $1 AND id = $2`,
      [ORG_A, agreementId],
    );
    expect(after[0]!.amount, "the figure that applied at signing is still answerable").toBe("3000000.0000");
    expect(after[0]!.archived).toBe(true);
  });

  it("allows a pay change while no contract has been accepted", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c5", PLAYER_ADULT, clock.lastYear);
    const agreementId = "55555555-0000-0000-0000-0000000000c5";

    await asOwner(`
      INSERT INTO compensation_agreement
        (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
      VALUES ('${agreementId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}',
              'salary', 'Base', 'INR', 3000000.0000, '${clock.lastYear}')
    `);

    await asOwner(`
      UPDATE compensation_agreement SET amount = 3600000.0000
       WHERE org_id = '${ORG_A}' AND id = '${agreementId}'
    `);

    const found = await ownerRows<{ amount: string }>(
      "SELECT amount::text AS amount FROM compensation_agreement WHERE org_id = $1 AND id = $2",
      [ORG_A, agreementId],
    );
    expect(found[0]!.amount).toBe("3600000.0000");
  });

  it("refuses two CURRENT agreements of the same kind for one engagement", async () => {
    // "What does this player currently earn" must have one answer.
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c6", PLAYER_ADULT, clock.lastYear);

    const row = (id: string, amount: string): string => `
      INSERT INTO compensation_agreement
        (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
      VALUES ('${id}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}',
              'salary', 'Base', 'INR', ${amount}, '${clock.lastYear}')
    `;

    await asOwner(row("55555555-0000-0000-0000-0000000000c6", "3000000.0000"));
    await expectSqlstate(
      () => asOwner(row("55555555-0000-0000-0000-0000000000c7", "4000000.0000")),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second current salary agreement for one engagement",
    );

    // A different kind coexists — a salary and a per-diem are different claims, and
    // nothing in the numbers says which is which.
    await asOwner(`
      INSERT INTO compensation_agreement
        (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from)
      VALUES ('55555555-0000-0000-0000-0000000000c8', '${ORG_A}', '${PLAYER_ADULT}',
              '${engagementId}', 'per_diem', 'Per Diem', 'INR', 2000.0000, '${clock.lastYear}')
    `);
  });

  it("refuses an effective-dated window that ends before it begins", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "55555555-0000-0000-0000-0000000000c7", PLAYER_ADULT, clock.lastYear);

    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO compensation_agreement
            (id, org_id, person_id, engagement_id, kind, title, currency, amount, valid_from, valid_to)
          VALUES ('55555555-0000-0000-0000-0000000000c9', '${ORG_A}', '${PLAYER_ADULT}',
                  '${engagementId}', 'salary', 'Base', 'INR', 3000000.0000,
                  '${clock.nextYear}', '${clock.lastYear}')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a compensation window that ends before it begins",
    );
  });
});

// ---------------------------------------------------------------------------
// HR LIFECYCLE
// ---------------------------------------------------------------------------

describe("HR lifecycle — the state is stored and the transitions are a table", () => {
  it("seeds an organisation's transition table when the organisation is created", async () => {
    // If an organisation could exist with an empty transition table, "nothing is
    // legal" is the safe direction — but it would also mean the machine was never
    // installed. Asserted so the seeding trigger cannot quietly stop firing.
    const found = await ownerRows<{ from_state: string; to_state: string; requires_reason: boolean }>(
      `SELECT from_state::text, to_state::text, requires_reason
         FROM hr_state_transition WHERE org_id = $1
        ORDER BY from_state::text, to_state::text`,
      [ORG_A],
    );

    expect(found.length).toBeGreaterThan(10);

    // Spot-checks that make the SHAPE of the machine legible rather than a count.
    const pairs = new Set(found.map((r) => `${r.from_state}->${r.to_state}`));
    expect(pairs.has("draft->offered")).toBe(true);
    expect(pairs.has("active->suspended")).toBe(true);
    // A record cannot be born suspended, because nothing transitions INTO the set
    // from outside.
    expect([...pairs].filter((p) => p.endsWith("->suspended"))).toEqual(["active->suspended"]);
    // Terminated is a dead end but for offboarding, so a terminated person cannot
    // silently become active again.
    expect([...pairs].filter((p) => p.startsWith("terminated->"))).toEqual(["terminated->offboarded"]);
  });

  it("refuses a state transition that is not in the table", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "44444444-0000-0000-0000-0000000000d1", PLAYER_ADULT, clock.lastYear);
    const recordId = "44444444-0000-0000-0000-0000000000c1";

    await asOwner(`
      INSERT INTO hr_record (id, org_id, person_id, engagement_id, state)
      VALUES ('${recordId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}', 'draft')
    `);

    // draft → active is a real-looking move that the table does not declare.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE hr_record
             SET state = 'active', state_changed_by_person_id = '${WITNESS}'
           WHERE org_id = '${ORG_A}' AND id = '${recordId}'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "an undeclared HR transition",
    );

    const after = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM hr_record WHERE org_id = $1 AND id = $2",
      [ORG_A, recordId],
    );
    expect(after[0]!.state, "the refused transition did not move the record").toBe("draft");
  });

  it("refuses a declared transition that requires a reason and is given none", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "44444444-0000-0000-0000-0000000000d2", PLAYER_ADULT, clock.lastYear);
    const recordId = "44444444-0000-0000-0000-0000000000c2";

    await asOwner(`
      INSERT INTO hr_record (id, org_id, person_id, engagement_id, state)
      VALUES ('${recordId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}', 'draft')
    `);
    // draft → offered needs no reason.
    await asOwner(`
      UPDATE hr_record SET state = 'offered', state_changed_by_person_id = '${WITNESS}'
       WHERE org_id = '${ORG_A}' AND id = '${recordId}'
    `);

    // offered → terminated DOES, and "I resigned" is the kind of transition an HR
    // record exists to explain.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE hr_record
             SET state = 'terminated', state_changed_by_person_id = '${WITNESS}'
           WHERE org_id = '${ORG_A}' AND id = '${recordId}'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a reason-requiring transition with no reason",
    );

    // With a reason it is accepted.
    await asOwner(`
      UPDATE hr_record
         SET state = 'terminated', state_reason = 'Offer declined in writing',
             state_changed_by_person_id = '${WITNESS}'
       WHERE org_id = '${ORG_A}' AND id = '${recordId}'
    `);

    const after = await ownerRows<{ state: string; state_reason: string }>(
      "SELECT state::text AS state, state_reason FROM hr_record WHERE org_id = $1 AND id = $2",
      [ORG_A, recordId],
    );
    expect(after[0]!.state).toBe("terminated");
    expect(after[0]!.state_reason).toBe("Offer declined in writing");
  });

  it("refuses a state change with nobody named as having made it", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "44444444-0000-0000-0000-0000000000d3", PLAYER_ADULT, clock.lastYear);
    const recordId = "44444444-0000-0000-0000-0000000000c3";

    await asOwner(`
      INSERT INTO hr_record (id, org_id, person_id, engagement_id, state)
      VALUES ('${recordId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}', 'draft')
    `);

    await expectSqlstate(
      () =>
        asOwner(`UPDATE hr_record SET state = 'offered' WHERE org_id = '${ORG_A}' AND id = '${recordId}'`),
      SQLSTATE_CHECK_VIOLATION,
      "a state change with no actor",
    );
  });

  it("walks the whole legal lifecycle and refuses one step out of it", async () => {
    // The happy path, end to end, so the state machine is demonstrated to be
    // walkable and not merely restrictive.
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "44444444-0000-0000-0000-0000000000d4", PLAYER_ADULT, clock.lastYear);
    const recordId = "44444444-0000-0000-0000-0000000000c4";

    await asOwner(`
      INSERT INTO hr_record (id, org_id, person_id, engagement_id, state)
      VALUES ('${recordId}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}', 'draft')
    `);

    const steps: ReadonlyArray<{ state: string; reason: string | null }> = [
      { state: "offered", reason: null },
      { state: "onboarding", reason: null },
      { state: "active", reason: null },
      { state: "leave", reason: "Medical leave, certified" },
      { state: "active", reason: null },
      { state: "notice", reason: null },
      { state: "terminated", reason: "End of fixed term" },
      { state: "offboarded", reason: null },
    ];

    for (const step of steps) {
      const reasonClause = step.reason === null ? "" : `, state_reason = '${step.reason}'`;
      await asOwner(`
        UPDATE hr_record
           SET state = '${step.state}'${reasonClause},
               state_changed_by_person_id = '${WITNESS}'
         WHERE org_id = '${ORG_A}' AND id = '${recordId}'
      `);
    }

    const final = await ownerRows<{ state: string }>(
      "SELECT state::text AS state FROM hr_record WHERE org_id = $1 AND id = $2",
      [ORG_A, recordId],
    );
    expect(final[0]!.state).toBe("offboarded");

    // And offboarded is a genuine dead end: the only move out of a terminated record
    // is offboarding, so a fully offboarded person cannot be reactivated.
    await expectSqlstate(
      () =>
        asOwner(`
          UPDATE hr_record
             SET state = 'active', state_changed_by_person_id = '${WITNESS}'
           WHERE org_id = '${ORG_A}' AND id = '${recordId}'
        `),
      SQLSTATE_CHECK_VIOLATION,
      "reactivating an offboarded record",
    );
  });

  it("refuses two CURRENT HR records for one engagement", async () => {
    const clock = await anchors();
    const engagementId = await seedEngagement(ORG_A, "44444444-0000-0000-0000-0000000000d5", PLAYER_ADULT, clock.lastYear);

    const row = (id: string): string => `
      INSERT INTO hr_record (id, org_id, person_id, engagement_id, state)
      VALUES ('${id}', '${ORG_A}', '${PLAYER_ADULT}', '${engagementId}', 'draft')
    `;

    await asOwner(row("44444444-0000-0000-0000-0000000000c5"));
    await expectSqlstate(
      () => asOwner(row("44444444-0000-0000-0000-0000000000c6")),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second current HR record for one engagement",
    );
  });

  it("does not let the application role edit the transition table", async () => {
    // The lifecycle is governance data. If the request path could rewrite it, then
    // "the database prevents an illegal move" would be a claim about a table the
    // application owns. Asserted over the catalogue, because a test that merely
    // TRIED the insert would be satisfied by the grant and would not notice the
    // trigger.
    const grants = await ownerRows<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'hr_state_transition' AND grantee = 'raptor_app'
          AND privilege_type IN ('INSERT','UPDATE','DELETE')`,
    );
    expect(grants, "only a migration or an operator may change the legal lifecycle").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENTS AND EXPIRY
// ---------------------------------------------------------------------------

describe("documents and expiry", () => {
  /**
   * A document issued at `issuedAt`, expiring at `expiresAt`.
   *
   * Both instants are WHOLE ISO literals with an explicit `Z`. Nothing here is
   * assembled from parts: PostgreSQL silently parses a malformed ISO literal into a
   * wrong-but-valid instant with no error, so a concatenated fixture looks right and
   * quietly tests nothing.
   */
  async function seedDocument(options: {
    readonly id: string;
    readonly personId: string;
    readonly kind: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly noticeDays?: number;
  }): Promise<void> {
    const notice = options.noticeDays === undefined ? "NULL" : String(options.noticeDays);
    await asOwner(`
      INSERT INTO person_document
        (id, org_id, person_id, kind, title, storage_ref, document_hash,
         issued_at, expires_at, expiry_notice_days)
      VALUES ('${options.id}', '${ORG_A}', '${options.personId}', '${options.kind}',
              'Right to Work', 's3://bucket/rtw.pdf', '${"b".repeat(64)}',
              '${options.issuedAt}', '${options.expiresAt}', ${notice})
    `);
  }

  it("answers what is expired as of a given instant", async () => {
    // Midnight UTC on a fixed date, spelled whole. A boundary derived from the
    // database's own clock would also be valid, but a FIXED instant is what makes the
    // boundary assertions below reproducible rather than dependent on the day the
    // suite runs.
    const asOf = "2027-03-15T00:00:00Z";

    await seedDocument({
      id: "33333333-0000-0000-0000-000000000001",
      personId: PLAYER_ADULT,
      kind: "right_to_work",
      issuedAt: "2026-03-15T00:00:00Z",
      expiresAt: "2027-03-14T23:59:59Z",
      noticeDays: 30,
    });
    await seedDocument({
      id: "33333333-0000-0000-0000-000000000002",
      personId: PLAYER_ADULT,
      kind: "tax_form",
      issuedAt: "2026-03-15T00:00:00Z",
      expiresAt: "2027-03-16T00:00:00Z",
    });

    const found = await appRows<{
      document_id: string;
      kind: string;
      expires_at: string;
      is_expired: boolean;
      seconds_to_expiry: string;
      expiry_notice_days: number | null;
    }>(
      `SELECT document_id,
              kind::text AS kind,
              to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at,
              is_expired,
              seconds_to_expiry::text AS seconds_to_expiry,
              expiry_notice_days
         FROM public.person_document_expiry_status($1::timestamptz)`,
      [asOf],
    );

    // Exactly the one that has expired, and not the one that has not.
    expect(found).toHaveLength(1);
    expect(found[0]!.document_id).toBe("33333333-0000-0000-0000-000000000001");
    expect(found[0]!.kind).toBe("right_to_work");
    expect(found[0]!.expires_at).toBe("2027-03-14T23:59:59Z");
    expect(found[0]!.is_expired).toBe(true);
    expect(found[0]!.expiry_notice_days).toBe(30);

    const kinds = found.map((r) => r.kind);
    expect(kinds, "the document expiring tomorrow must NOT appear").not.toContain("tax_form");
  });

  it("treats the expiry boundary as inclusive, and one microsecond either side of it", async () => {
    // THE boundary test. `expires_at` is the instant validity ENDS, so a document is
    // expired AT that instant and not one microsecond before it. Using `<` would
    // expire every document an instant early — at 23:59:59.999999 the previous day —
    // which is a day nobody agreed to.
    const expiresAt = "2027-06-01T00:00:00Z";

    await seedDocument({
      id: "33333333-0000-0000-0000-000000000003",
      personId: PLAYER_ADULT,
      kind: "right_to_work",
      issuedAt: "2026-06-01T00:00:00Z",
      expiresAt,
    });

    const countAt = async (asOf: string): Promise<number> => {
      const found = await appRows<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.person_document_expiry_status($1::timestamptz)",
        [asOf],
      );
      return found[0]!.n;
    };

    // One microsecond before the boundary: still valid, so NOT expired.
    expect(await countAt("2027-05-31T23:59:59.999999Z")).toBe(0);
    // The boundary itself: expired. `<=`, not `<`.
    expect(await countAt(expiresAt)).toBe(1);
    // One microsecond after: expired.
    expect(await countAt("2027-06-01T00:00:00.000001Z")).toBe(1);

    // THE ASSERTION THAT CAUGHT A REAL DEFECT. Asserting only the row COUNT above
    // would pass even if the function's filter were right and its reported
    // `is_expired` flag were computed with a different, wrong comparison — a report
    // that returns the right rows and labels them wrongly is worse than one that
    // returns nothing, because the caller trusts the label.
    //
    // It was found by mutation: flipping `(expires_at <= p_as_of)` to `<` in the
    // SELECT list alone left every count assertion passing.
    const reported = await appRows<{ is_expired: boolean }>(
      "SELECT is_expired FROM public.person_document_expiry_status($1::timestamptz)",
      [expiresAt],
    );
    expect(reported).toHaveLength(1);
    expect(
      reported[0]!.is_expired,
      "at the expiry instant itself the document must be reported expired, not valid",
    ).toBe(true);

    // And the two halves of the function must agree with each other: any row the
    // function returns is expired, because the filter and the flag are the same
    // predicate written twice.
    const disagreement = await appRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.person_document_expiry_status($1::timestamptz) WHERE NOT is_expired",
      [expiresAt],
    );
    expect(disagreement[0]!.n, "a returned row that is not expired would mean the filter and the flag disagree").toBe(0);

    // The same three instants read through the raw predicate, so the function and the
    // column cannot disagree — a query whose two halves could disagree is a query
    // nobody trusts.
    const raw = await ownerRows<{ at_boundary: number; just_before: number }>(
      `SELECT (SELECT count(*)::int FROM person_document
                WHERE expires_at <= '2027-06-01T00:00:00Z'::timestamptz) AS at_boundary,
              (SELECT count(*)::int FROM person_document
                WHERE expires_at <= '2027-05-31T23:59:59.999999Z'::timestamptz) AS just_before`,
    );
    expect(raw[0]!.at_boundary).toBe(1);
    expect(raw[0]!.just_before).toBe(0);
  });

  it("orders expired documents soonest-first, so the most urgent is first", async () => {
    await seedDocument({
      id: "33333333-0000-0000-0000-000000000005",
      personId: PLAYER_ADULT,
      kind: "right_to_work",
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2027-12-01T00:00:00Z",
    });
    await seedDocument({
      id: "33333333-0000-0000-0000-000000000006",
      personId: PLAYER_ADULT,
      kind: "tax_form",
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    });

    const found = await appRows<{ document_id: string; seconds_to_expiry: string }>(
      `SELECT document_id, seconds_to_expiry::text AS seconds_to_expiry
         FROM public.person_document_expiry_status('2028-01-01T00:00:00Z'::timestamptz)`,
    );

    expect(found.map((r) => r.document_id)).toEqual([
      "33333333-0000-0000-0000-000000000006",
      "33333333-0000-0000-0000-000000000005",
    ]);
  });

  it("refuses a document whose expiry precedes its issue", async () => {
    // Not a very short document — a mistake, and the kind that makes "is this
    // expired" answerable in a way nobody can defend.
    await expectSqlstate(
      () =>
        asOwner(`
          INSERT INTO person_document
            (id, org_id, person_id, kind, title, storage_ref, document_hash, issued_at, expires_at)
          VALUES ('33333333-0000-0000-0000-000000000007', '${ORG_A}', '${PLAYER_ADULT}',
                  'identity', 'Passport', 's3://bucket/p', '${"c".repeat(64)}',
                  '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        `),
      SQLSTATE_CHECK_VIOLATION,
      "a document that expires before it was issued",
    );
  });

  it("holds a document with no expiry out of the expiry report entirely", async () => {
    // An open-ended document is not one that has expired; putting it in the report
    // would make "what is expired" answer "everything, eventually".
    await asOwner(`
      INSERT INTO person_document
        (id, org_id, person_id, kind, title, storage_ref, document_hash, issued_at)
      VALUES ('33333333-0000-0000-0000-000000000008', '${ORG_A}', '${PLAYER_ADULT}',
              'identity', 'Passport', 's3://bucket/p', '${"d".repeat(64)}',
              '2020-01-01T00:00:00Z')
    `);

    const found = await appRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.person_document_expiry_status('2099-01-01T00:00:00Z'::timestamptz)",
    );
    expect(found[0]!.n).toBe(0);
  });

  it("refuses two CURRENT documents of the same kind for one person", async () => {
    await seedDocument({
      id: "33333333-0000-0000-0000-000000000009",
      personId: PLAYER_ADULT,
      kind: "right_to_work",
      issuedAt: "2026-01-01T00:00:00Z",
      expiresAt: "2027-01-01T00:00:00Z",
    });

    await expectSqlstate(
      () =>
        seedDocument({
          id: "33333333-0000-0000-0000-00000000000a",
          personId: PLAYER_ADULT,
          kind: "right_to_work",
          issuedAt: "2026-06-01T00:00:00Z",
          expiresAt: "2028-01-01T00:00:00Z",
        }),
      SQLSTATE_UNIQUE_VIOLATION,
      "a second current right-to-work document for one person",
    );
  });

  it("refuses a notice period outside 0..365 days", async () => {
    await expectSqlstate(
      () =>
        seedDocument({
          id: "33333333-0000-0000-0000-00000000000b",
          personId: PLAYER_ADULT,
          kind: "right_to_work",
          issuedAt: "2026-01-01T00:00:00Z",
          expiresAt: "2027-01-01T00:00:00Z",
          noticeDays: 400,
        }),
      SQLSTATE_CHECK_VIOLATION,
      "a notice period of 400 days",
    );
  });

  it("holds no reminder queue, no schedule column and no next_reminder_at", async () => {
    // Delivery belongs to another package. A `next_reminder_at` written by THIS
    // schema would be a claim that a reminder was scheduled — exactly the kind of
    // claim ADR-0019 exists to stop storing. The table's whole job is to make the
    // question answerable, and it is.
    //
    // Scoped to the People tables on purpose. `outbox_event` exists in the platform
    // from 0001 and is the correct shape for platform-wide event publication; this
    // assertion is about what the PEOPLE migration added, and widening it to the
    // whole schema would either condemn a correct existing table or force the regex
    // to be weakened until it proved nothing.
    const offenders = await ownerRows<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND (column_name ~ '(remind|notify|scheduled_send|next_send|queue|job)'
               OR table_name ~ '(reminder|notification|queue|job)')
        ORDER BY table_name, column_name`,
      [[...PEOPLE_TABLES]],
    );

    expect(
      offenders.map((r) => `${r.table_name}.${r.column_name}`),
      "delivery is another package's job; this schema must not store a scheduling claim",
    ).toEqual([]);

    // And the query it does need is present, so the absence of a queue is a decision
    // rather than an oversight.
    const function_exists = await ownerRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'person_document_expiry_status'`,
    );
    expect(function_exists[0]!.n, "the expiry query the delivery layer will call must exist").toBe(1);
  });

  it("takes no tenant argument in the expiry function", async () => {
    const signature = await ownerRows<{ in_args: string }>(
      `SELECT pg_get_function_arguments(p.oid) AS in_args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'person_document_expiry_status'`,
    );

    expect(signature).toHaveLength(1);
    expect(signature[0]!.in_args).toContain("p_as_of");
    expect(signature[0]!.in_args).not.toMatch(/org/i);
  });

  it("reports no cap on the number of expired documents it returns", async () => {
    // ADR-0019's finding: `limit` silently capped at 1000 and presented the capped
    // set as a ranking. A capped expiry report would present a subset as the whole
    // set, and the caller would have no way to tell.
    //
    // Six documents, not 1501: what is asserted is that the FUNCTION has no LIMIT in
    // its definition. A number large enough to trip a hypothetical 1000 cap would
    // prove less about the intent and more about the fixture — and would cost a
    // thousand inserts to do it. Each document gets its own KIND, because
    // `person_document_current_key` is UNIQUE (org_id, person_id, kind) and six
    // tax forms for one person is a different rule failing, not this one.
    const kinds = ["tax_form", "identity", "right_to_work", "contract", "bank_details", "medical"] as const;
    const rows: string[] = kinds.map(
      (kind, index) =>
        `('22222222-0000-0000-0000-00000000000${index}', '${ORG_A}', '${PLAYER_ADULT}', '${kind}',
          'Document ${index}', 's3://bucket/${index}', '${"e".repeat(64)}',
          '2026-01-01T00:00:00Z', '2027-01-0${index + 1}T00:00:00Z')`,
    );

    await asOwner(`
      INSERT INTO person_document
        (id, org_id, person_id, kind, title, storage_ref, document_hash, issued_at, expires_at)
      VALUES ${rows.join(",\n       ")}
    `);

    // Read the function's definition from the catalogue rather than from the file, so
    // this asserts what the DATABASE contains and not what a migration file says.
    //
    // `pg_get_functiondef` is used rather than `prosrc` because prosrc for a SQL
    // function is the body only, with no name or signature around it — which makes
    // the match depend on a formatting detail of the body rather than on the claim.
    const definition = await ownerRows<{ def: string }>(
      `SELECT pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'person_document_expiry_status'`,
    );
    expect(definition, "the expiry function must exist for this assertion to mean anything").toHaveLength(1);
    expect(definition[0]!.def.toUpperCase(), "the expiry report must not silently cap its result set").not.toMatch(
      /\bLIMIT\b/,
    );

    const found = await appRows<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.person_document_expiry_status('2028-01-01T00:00:00Z'::timestamptz)",
    );
    expect(found[0]!.n).toBe(6);
  });
});