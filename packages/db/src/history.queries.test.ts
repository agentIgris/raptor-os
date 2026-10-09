/**
 * Historical queries — the Phase 2 completion criterion.
 *
 * Section 8 of the design spec closes Phase 2 on "Attendance and roster history
 * queries answerable by date". `competitive.isolation.test.ts` proves the schema
 * can REFUSE bad rows; it says nothing about whether a question asked in the past
 * can be ANSWERED. A schema full of tables that no query can interrogate is
 * inert, and the only way to find out is to seed months of overlapping windows and
 * ask.
 *
 * Every assertion here runs real SQL against a real PGlite instance against seeded
 * data. Nothing asserts how a query "would" behave. Dates are arbitrary instants,
 * never `now()`, because every bug this criterion exists to prevent lives in the
 * gap between two windows rather than in either window.
 *
 * WHAT THE SCHEMA COULD NOT ANSWER (migration 0006)
 * ------------------------------------------------
 * Three questions were asked against the schema as 0002 left it and had no answer:
 *
 *   1. Was this session generated or written by hand? `session` had no provenance
 *      column and no reference to `session_template` at all, so the only way to tell
 *      them apart was substring-matching a cosmetic title — exactly the
 *      undecidability ADR-0016 lists as unrecoverable.
 *   2. What does `attendance_policy.holiday_scope` select? It is an enum, and the
 *      schema had no holidays table anywhere, so the column could not change any
 *      query's answer.
 *   3. Can a person hold two memberships of one team on one date? Yes. The partial
 *      unique indexes only constrain rows where `valid_to IS NULL`, so two CLOSED
 *      windows sharing an instant were accepted.
 *
 * The fourth thing this file found is not a schema defect but a way of writing
 * tests that lie, and it is recorded at the timestamp constants below: PostgreSQL
 * does not reject `"2026-03-15T00:00:00Z" + "T17:00:00Z"`. It silently parses the
 * concatenation as `16:00:00Z`, an hour early, with no error.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { migrateUp, migrationStatus } from "./migrations.js";

const ORG_A = "11111111-1111-1111-1111-111111111111";

/**
 * Anchor dates for the seed, as fixed ISO instants.
 *
 * Deliberately in the PAST relative to whenever this suite runs. A test whose dates
 * are `now() + interval '3 months'` proves the schema works for dates after the
 * migration was written and says nothing about dates before it, which is exactly
 * the half a history query has to get right.
 */
const D_JAN = "2026-01-05T00:00:00Z";
const D_FEB = "2026-02-10T00:00:00Z";
const D_MAR = "2026-03-15T00:00:00Z";
const D_APR = "2026-04-20T00:00:00Z";

/**
 * Session and check-in instants, spelled out whole rather than assembled.
 *
 * This is not fussiness. `"${D_MAR}T17:00:00Z"` builds the string
 * `2026-03-15T00:00:00ZT17:00:00Z`, and PostgreSQL does NOT reject it — it silently
 * parses it as `2026-03-15 16:00:00Z`, an hour early. Verified against this build.
 * A concatenated timestamp literal is therefore a fixture that looks right, produces
 * no error, and quietly shifts every session by an hour; only an assertion on the
 * time of day catches it.
 */
const S_JAN = "2026-01-05T17:00:00Z";
const E_JAN = "2026-01-05T19:00:00Z";
const S_FEB = "2026-02-10T17:00:00Z";
const E_FEB = "2026-02-10T19:00:00Z";
const S_MAR = "2026-03-15T17:00:00Z";
const E_MAR = "2026-03-15T19:00:00Z";
const S_APR = "2026-04-20T17:00:00Z";
const E_APR = "2026-04-20T19:00:00Z";

/**
 * Check-in instants.
 *
 * The org policy's deadline is starts_at + cutoff_offset_minutes + grace_minutes
 * = 17:00 - 15 + 5 = 16:50Z, so these sit on deliberately chosen sides of it.
 */
const CI_JAN_ON_TIME = "2026-01-05T16:40:00Z";
const CI_FEB_ON_TIME = "2026-02-10T16:42:00Z";
/** 50 minutes past the deadline: a genuine absence that is nonetheless marked 'late'. */
const CI_FEB_WAY_LATE = "2026-02-10T17:40:00Z";
/** 3 minutes past the cutoff, inside the 5-minute grace: within the deadline. */
const CI_MAR_WITHIN_GRACE = "2026-03-15T16:48:00Z";

let db: PGlite;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs `fn` as the non-superuser application role with `org_id` set.
 *
 * Historical queries are the ones most likely to be run as the superuser by
 * accident, because a read-only query gives no signal that it bypassed RLS and the
 * fixture looks the same either way. Running the answerable-by-date assertions
 * through `asApp` means the tenant scoping is part of what is under test.
 */
async function asApp(fn: (sql: string) => Promise<void>, orgId?: string): Promise<void> {
  await db.exec("SET ROLE raptor_app");
  if (orgId) await db.exec(`SET app.org_id = '${orgId}'`);
  else await db.exec("SELECT set_config('app.org_id', '', false)");
  try {
    await fn("");
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** As the schema owner, which bypasses RLS. Used only for seeding and reflection. */
async function asOwner(sql: string): Promise<void> {
  await db.exec("RESET ROLE");
  await db.exec(sql);
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec("RESET ROLE");
  const result = await db.query<T>(sql, params);
  return result.rows;
}

/**
 * Runs `fn` expecting PostgreSQL to refuse it with a specific SQLSTATE.
 *
 * Asserting the code rather than the message: several distinct guarantees in this
 * schema all produce "rejected", and a message match would let the wrong mechanism
 * satisfy a test that claims a specific one.
 */
async function expectSqlstate(fn: () => Promise<unknown>, sqlstate: string, label: string): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(`${label}: expected SQLSTATE ${sqlstate} but the statement succeeded`);
  }

  const actual = (caught as { code?: string }).code;
  expect(actual, `${label}: wrong SQLSTATE — ${String((caught as Error).message).slice(0, 200)}`).toBe(sqlstate);
}

const SQLSTATE_UNIQUE_VIOLATION = "23505";
const SQLSTATE_EXCLUSION_VIOLATION = "23P01";
const SQLSTATE_FOREIGN_KEY_VIOLATION = "23503";
const SQLSTATE_CHECK_VIOLATION = "23514";

// ---------------------------------------------------------------------------
// Fixture
//
// Two teams, three people, four months of overlapping effective-dated windows.
// The overlap is the point: a roster query that only ever sees one open membership
// cannot tell whether it honours valid_to.
// ---------------------------------------------------------------------------

const P_ALICE = "aaaaaaaa-0000-0000-0000-000000000001";
const P_BEN = "aaaaaaaa-0000-0000-0000-000000000002";
const P_CARA = "aaaaaaaa-0000-0000-0000-000000000003";

const T_RED = "cccccccc-0000-0000-0000-000000000001";
const T_BLUE = "cccccccc-0000-0000-0000-000000000002";

/** The policy in force for the whole seeded period. */
const POLICY_STRICT = "eeeeeeee-0000-0000-0000-000000000001";

/** A per-team override: Blue closes its window 30 minutes early and allows no grace. */
const POLICY_BLUE = "eeeeeeee-0000-0000-0000-000000000002";

/**
 * Session ids keyed by a stable label.
 *
 * An explicit shape rather than `Record<string, string>`: under `noUncheckedIndexedAccess`
 * a record makes every lookup `string | undefined`, and the only ways out are a
 * non-null assertion or an `any` — both of which would let a renamed label compile
 * and then quietly match no session at all.
 */
interface SessionIds {
  readonly janRed: string;
  readonly febRed: string;
  readonly marRed: string;
  readonly marBlue: string;
  readonly aprBlue: string;
  readonly aprRed: string;
}

interface Seeded {
  readonly gameId: string;
  readonly divisionId: string;
  /** Session ids keyed by a stable label, so assertions never hard-code a uuid. */
  readonly sessions: SessionIds;
}

async function seedHistory(): Promise<Seeded> {
  const gameId = "cccccccc-0000-0000-0000-000000000010";
  const divisionId = "cccccccc-0000-0000-0000-000000000011";

  await asOwner(`
    INSERT INTO game (id, org_id, name, slug)
    VALUES ('${gameId}', '${ORG_A}', 'History Game', 'history-game');

    INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
    VALUES ('cccccccc-0000-0000-0000-000000000012', '${ORG_A}', '${gameId}', 'History Cup', 'history-cup', 'competitive', 'active');

    INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
    VALUES ('cccccccc-0000-0000-0000-000000000013', '${ORG_A}', 'cccccccc-0000-0000-0000-000000000012',
            'Season 2026', 'S2026', '${D_JAN}', '2026-12-31T00:00:00Z', true);

    INSERT INTO division (id, org_id, season_id, name, slug, tier)
    VALUES ('${divisionId}', '${ORG_A}', 'cccccccc-0000-0000-0000-000000000013', 'Open', 'open', 'challenger');

    INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
    VALUES
      ('${T_RED}',  '${ORG_A}', 'Red',  'red',  '${gameId}', '${divisionId}', 'active', '${D_JAN}'),
      ('${T_BLUE}', '${ORG_A}', 'Blue', 'blue', '${gameId}', '${divisionId}', 'active', '${D_JAN}');
  `);

  // ---------------------------------------------------------------------------
  // MEMBERSHIP WINDOWS
  //
  // Half-open [valid_from, valid_to) throughout, which is the convention the rest
  // of this repo uses for effective dating: `valid_to IS NULL` means "still
  // open", so `valid_to` itself is already OUTSIDE the window. A membership ending
  // on D is therefore not in force on D, and one beginning on D is.
  //
  //   alice  red   [Jan 05, Mar 15)      joins, leaves
  //   ben    red   [Feb 10, NULL)       joins, still there
  //   cara   red   [Mar 15, NULL)       joins on the exact day alice leaves
  //   cara   blue  [Jan 05, Feb 10)     on TWO teams at once — legitimate, and the
  //                                    reason a per-team query is required
  // ---------------------------------------------------------------------------
  await asOwner(`
    INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
    VALUES
      ('cccccccc-0000-0000-0000-000000000101', '${ORG_A}', '${T_RED}',  '${P_ALICE}', 'captain',    40, '${D_JAN}', '${D_MAR}'),
      ('cccccccc-0000-0000-0000-000000000102', '${ORG_A}', '${T_RED}',  '${P_BEN}',   'player',     60, '${D_FEB}', NULL),
      ('cccccccc-0000-0000-0000-000000000103', '${ORG_A}', '${T_RED}',  '${P_CARA}',  'substitute', 50, '${D_MAR}', NULL),
      ('cccccccc-0000-0000-0000-000000000104', '${ORG_A}', '${T_BLUE}', '${P_CARA}',  'player',     50, '${D_JAN}', '${D_FEB}');
  `);

  // Staff windows deliberately do NOT line up with the roster: ben coaches Red from
  // Feb 10 (the day he joins its roster) through Apr 20, and Cara assists Blue from
  // Mar 15. Cara is on Blue's STAFF in April having left Blue's ROSTER in February,
  // which is the conflation this fixture exists to catch.
  await asOwner(`
    INSERT INTO team_staff (id, org_id, team_id, person_id, role_in_team, valid_from, valid_to)
    VALUES
      ('cccccccc-0000-0000-0000-000000000201', '${ORG_A}', '${T_RED}',  '${P_BEN}',  'head_coach',   '${D_FEB}', NULL),
      ('cccccccc-0000-0000-0000-000000000202', '${ORG_A}', '${T_BLUE}', '${P_CARA}', 'assistant_coach', '${D_MAR}', NULL);
  `);

  // ---------------------------------------------------------------------------
  // ATTENDANCE POLICY
  //
  // Cutoff 15 minutes before the start, 5 minutes of grace. Both are stored as
  // offsets/allowances rather than as a precomputed timestamp so that a session
  // created later is still evaluated against the policy in force at read time.
  // ---------------------------------------------------------------------------
  await asOwner(
    `INSERT INTO attendance_policy (id, org_id, team_id, name, cutoff_offset_minutes, grace_minutes, holiday_scope)
     VALUES ('${POLICY_STRICT}', '${ORG_A}', NULL, 'Org default', -15, 5, 'none')`,
  );

  // One policy per team as well, so a per-team override is exercised rather than
  // assumed: Blue closes its window 30 minutes early and allows no grace.
  await asOwner(
    `INSERT INTO attendance_policy (id, org_id, team_id, name, cutoff_offset_minutes, grace_minutes, holiday_scope)
     VALUES ('${POLICY_BLUE}', '${ORG_A}', '${T_BLUE}', 'Blue strict', -30, 0, 'none')`,
  );

  // ---------------------------------------------------------------------------
  // SESSIONS — one per month, so every window boundary is exercised.
  // ---------------------------------------------------------------------------
  const sessions: SessionIds = {
    janRed: "cccccccc-0000-0000-0000-000000000301",
    febRed: "cccccccc-0000-0000-0000-000000000302",
    marRed: "cccccccc-0000-0000-0000-000000000303",
    aprBlue: "cccccccc-0000-0000-0000-000000000304",
    aprRed: "cccccccc-0000-0000-0000-000000000305",
    marBlue: "cccccccc-0000-0000-0000-000000000306",
  };

  // Two Blue sessions, deliberately: a holiday-exclusion query is vacuous over a
  // single row, because "excluded everything" and "excluded the holiday" look
  // identical until there is a second row that must survive.
  await asOwner(`
    INSERT INTO session (id, org_id, team_id, kind, title, status, starts_at, ends_at, attendance_policy_id)
    VALUES
      ('${sessions.janRed}',  '${ORG_A}', '${T_RED}',  'practice', 'January practice', 'held',
       '${S_JAN}', '${E_JAN}', '${POLICY_STRICT}'),
      ('${sessions.febRed}',  '${ORG_A}', '${T_RED}',  'practice', 'February practice', 'held',
       '${S_FEB}', '${E_FEB}', '${POLICY_STRICT}'),
      ('${sessions.marRed}',  '${ORG_A}', '${T_RED}',  'practice', 'March practice', 'held',
       '${S_MAR}', '${E_MAR}', '${POLICY_STRICT}'),
      ('${sessions.marBlue}', '${ORG_A}', '${T_BLUE}', 'practice', 'March Blue practice', 'held',
       '2026-03-20T17:00:00Z', '2026-03-20T19:00:00Z', '${POLICY_BLUE}'),
      ('${sessions.aprBlue}', '${ORG_A}', '${T_BLUE}', 'practice', 'April Blue practice', 'held',
       '${S_APR}', '${E_APR}', '${POLICY_BLUE}'),
      ('${sessions.aprRed}',  '${ORG_A}', '${T_RED}',  'practice', 'April Red practice', 'held',
       '${S_APR}', '${E_APR}', '${POLICY_STRICT}');
  `);

  // ---------------------------------------------------------------------------
  // ATTENDANCE
  //
  // Check-in instants are chosen to sit on specific sides of the policy's deadline,
  // because the rate query is required to derive lateness from the policy rather than
  // from the declared status. Deadline for the org policy is
  // starts_at + cutoff_offset_minutes + grace_minutes = 17:00 - 15 + 5 = 16:50Z.
  //
  //   janRed  alice present 16:40  -> before the 16:45 cutoff, unambiguously on time
  //   febRed  alice present 16:42  -> on time
  //          ben   LATE    17:40  -> 50 min past the deadline: a real absence
  //   marRed  cara   absent        -> was rostered, was marked, did not attend
  //          ben   LATE    16:48  -> DECLARED late by 3 min, but the arrival is
  //                                  3 min past the cutoff and INSIDE the 5 min
  //                                  grace. The declared status and the recorded
  //                                  arrival contradict each other on purpose.
  //   aprRed  cara   absent
  //          ben   NO ROW AT ALL  -> expected but never marked
  //   aprBlue nobody              -> nobody is on Blue's roster by April
  // ---------------------------------------------------------------------------
  await asOwner(`
    INSERT INTO attendance_record (org_id, session_id, person_id, status, method, checked_in_at, late_minutes)
    VALUES
      ('${ORG_A}', '${sessions.janRed}', '${P_ALICE}', 'present', 'kiosk_scan', '${CI_JAN_ON_TIME}', NULL),
      ('${ORG_A}', '${sessions.febRed}', '${P_ALICE}', 'present', 'kiosk_scan', '${CI_FEB_ON_TIME}', NULL),
      ('${ORG_A}', '${sessions.febRed}', '${P_BEN}',   'late',    'kiosk_scan', '${CI_FEB_WAY_LATE}', 40),
      ('${ORG_A}', '${sessions.marRed}', '${P_CARA}',  'absent',  'coach_marked', NULL, NULL),
      ('${ORG_A}', '${sessions.marRed}', '${P_BEN}',   'late',    'self_reported', '${CI_MAR_WITHIN_GRACE}', 3),
      ('${ORG_A}', '${sessions.aprRed}', '${P_CARA}',  'absent',  'coach_marked', NULL, NULL);
  `);

  return { gameId, divisionId, sessions };
}

beforeAll(async () => {
  db = new PGlite();
  await migrateUp(db);
});

beforeEach(async () => {
  await db.exec("RESET ROLE");
  await db.exec("SELECT set_config('app.org_id', '', false)");
  await asOwner("TRUNCATE organization, person CASCADE");
  await asOwner(`
    INSERT INTO organization (id, slug, display_name, default_currency, status)
    VALUES ('${ORG_A}', 'org-a', 'Org A', 'INR', 'active');
    INSERT INTO person (id, external_ref) VALUES
      ('${P_ALICE}', 'alice'), ('${P_BEN}', 'ben'), ('${P_CARA}', 'cara');
  `);
});

// ---------------------------------------------------------------------------
// 1. Roster as of a date
// ---------------------------------------------------------------------------

describe("roster as of an arbitrary date", () => {
  it("answers for a date inside a membership window", async () => {
    const seeded = await seedHistory();

    // 2026-01-20: Alice is on Red. Ben has not joined yet. Cara is on Blue only.
    const roster = await rows<{ person: string; team: string; role: string }>(
      `SELECT p.external_ref AS person, t.name AS team, m.role_in_team::text AS role
         FROM team_membership m
         JOIN person p ON p.id = m.person_id
         JOIN team   t ON t.org_id = m.org_id AND t.id = m.team_id
        WHERE m.org_id = $1
          AND m.valid_from <= $2::timestamptz
          AND (m.valid_to IS NULL OR m.valid_to > $2::timestamptz)
        ORDER BY t.name, p.external_ref`,
      [ORG_A, "2026-01-20T00:00:00Z"],
    );

    expect(roster).toEqual([
      { person: "cara", team: "Blue", role: "player" },
      { person: "alice", team: "Red", role: "captain" },
    ]);
    expect(seeded.sessions.janRed).toBeDefined();
  });

  it("excludes a membership whose valid_to EQUALS the date, and includes one whose valid_from equals it", async () => {
    await seedHistory();

    const at = async (d: string): Promise<string[]> => {
      const found = await rows<{ person: string; team: string }>(
        `SELECT p.external_ref AS person, t.name AS team
           FROM team_membership m
           JOIN person p ON p.id = m.person_id
           JOIN team   t ON t.org_id = m.org_id AND t.id = m.team_id
          WHERE m.org_id = $1
            AND m.valid_from <= $2::timestamptz
            AND (m.valid_to IS NULL OR m.valid_to > $2::timestamptz)
          ORDER BY p.external_ref, t.name`,
        [ORG_A, d],
      );
      return found.map((r) => `${r.person}@${r.team}`);
    };

    // The boundary pair. `valid_to = D` is EXCLUSIVE (the half-open window), and
    // `valid_from = D` is INCLUSIVE. Both asserted in the same place because a
    // half-open window whose two ends disagree is not half-open, it is closed at
    // both ends, which double-counts a handover on the day it happens.
    const beforeBoundary = await at("2026-03-14T23:59:59Z");
    expect(beforeBoundary).toContain("alice@Red");
    expect(beforeBoundary).not.toContain("cara@Red");

    const onBoundary = await at(D_MAR);
    expect(onBoundary, "valid_to == D must be excluded").not.toContain("alice@Red");
    expect(onBoundary, "valid_from == D must be included").toContain("cara@Red");
    // Cara was on Blue until Feb 10 and joins Red's staff on Mar 15, but her Blue
    // ROSTER membership ended in February. A query that treated staff as roster
    // would wrongly list her here.
    expect(onBoundary).not.toContain("cara@Blue");

    // Cara's Blue roster membership ends on D_FEB, so that date is also a boundary
    // and is asserted the same way rather than assumed.
    const febBoundary = await at(D_FEB);
    expect(febBoundary).not.toContain("cara@Blue");
    expect(febBoundary).toContain("alice@Red");
    expect(febBoundary).toContain("ben@Red");
  });

  it("returns an empty roster for a date before anyone joined, rather than everything", async () => {
    await seedHistory();

    const roster = await rows(
      `SELECT m.id FROM team_membership m
        WHERE m.org_id = $1
          AND m.valid_from <= $2::timestamptz
          AND (m.valid_to IS NULL OR m.valid_to > $2::timestamptz)`,
      [ORG_A, "2025-12-31T00:00:00Z"],
    );

    expect(roster).toHaveLength(0);
  });

  it("returns a person on two teams as two distinct rows, not one collapsed row", async () => {
    await seedHistory();

    // Cara leaves Blue's roster on 10 Feb and joins Red's on 15 Mar, so the seeded
    // fixture never has her on both at once — which means a query that silently
    // collapsed duplicate people would still look correct. Give her a genuine
    // second-team window so the collapsing is actually exercised.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
       VALUES ('cccccccc-0000-0000-0000-000000000112', '${ORG_A}', '${T_BLUE}', '${P_CARA}',
               'player', 50, '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
    );

    // 20 March: Cara is on Red (from 15 Mar) and on Blue (from 1 Mar). Both rows
    // must survive — the grouping key is the (person, team) pair, not the person.
    const onDate = await rows<{ person: string; team: string }>(
      `SELECT p.external_ref AS person, t.name AS team
         FROM team_membership m
         JOIN person p ON p.id = m.person_id
         JOIN team   t ON t.org_id = m.org_id AND t.id = m.team_id
        WHERE m.org_id = $1 AND m.person_id = $2
          AND m.valid_from <= $3::timestamptz
          AND (m.valid_to IS NULL OR m.valid_to > $3::timestamptz)
        ORDER BY t.name`,
      [ORG_A, P_CARA, "2026-03-20T00:00:00Z"],
    );

    expect(onDate).toEqual([
      { person: "cara", team: "Blue" },
      { person: "cara", team: "Red" },
    ]);

    // And the count-per-person grouping below must therefore report her, which is
    // what makes the assertion above non-vacuous: it is only meaningful if a
    // person CAN appear twice.
    const grouped = await rows<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM team_membership m
        WHERE m.org_id = $1 AND m.person_id = $2
          AND m.valid_from <= $3::timestamptz
          AND (m.valid_to IS NULL OR m.valid_to > $3::timestamptz)
        GROUP BY m.person_id
       HAVING count(*) > 1`,
      [ORG_A, P_CARA, "2026-03-20T00:00:00Z"],
    );
    expect(grouped).toEqual([{ n: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// 2. Staff as of a date
// ---------------------------------------------------------------------------

describe("staff as of an arbitrary date", () => {
  it("is answerable and is NOT the roster", async () => {
    await seedHistory();

    const staffOn = async (d: string): Promise<string[]> => {
      const found = await rows<{ person: string; team: string; role: string }>(
        `SELECT p.external_ref AS person, t.name AS team, s.role_in_team::text AS role
           FROM team_staff s
           JOIN person p ON p.id = s.person_id
           JOIN team   t ON t.org_id = s.org_id AND t.id = s.team_id
          WHERE s.org_id = $1
            AND s.valid_from <= $2::timestamptz
            AND (s.valid_to IS NULL OR s.valid_to > $2::timestamptz)
          ORDER BY t.name, p.external_ref`,
        [ORG_A, d],
      );
      return found.map((r) => `${r.person}@${r.team}:${r.role}`);
    };

    // Jan 20: no staff at all, and Red's roster holds Alice. A single conflated
    // query would return "alice@Red" for this date.
    expect(await staffOn("2026-01-20T00:00:00Z")).toEqual([]);

    // Feb 10 onward: Ben coaches Red.
    expect(await staffOn(D_FEB)).toEqual(["ben@Red:head_coach"]);

    // Mar 15 onward: Cara assists Blue — she left Blue's ROSTER in February, so
    // this is the date on which a conflated query loses her entirely.
    //
    // Ordered by team name then person, so "Blue" sorts before "Red" and Cara's row
    // comes first. Asserting the query's own ordering rather than a narrative one:
    // an assertion that only holds in some order is a description, not a test.
    expect(await staffOn(D_MAR)).toEqual(["cara@Blue:assistant_coach", "ben@Red:head_coach"]);

    // The boundary: staff honours the same half-open window as the roster.
    const justBefore = await staffOn("2026-03-14T23:59:59Z");
    expect(justBefore).toEqual(["ben@Red:head_coach"]);
  });

  it("keeps a coach off the roster and a player off the staff list", async () => {
    await seedHistory();

    // Ben is a head coach on Red from Feb 10. He is also a rostered player on Red
    // from the same date — the legacy defect was a coach inheriting a playing
    // share, so both facts must be separately answerable.
    const benRoster = await rows<{ role: string; share: string }>(
      `SELECT role_in_team::text AS role, share_percent::text AS share
         FROM team_membership
        WHERE org_id = $1 AND person_id = $2
          AND valid_from <= $3::timestamptz
          AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
      [ORG_A, P_BEN, D_MAR],
    );
    expect(benRoster).toEqual([{ role: "player", share: "60.0000" }]);

    const benStaff = await rows<{ role: string }>(
      `SELECT role_in_team::text AS role
         FROM team_staff
        WHERE org_id = $1 AND person_id = $2
          AND valid_from <= $3::timestamptz
          AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
      [ORG_A, P_BEN, D_MAR],
    );
    expect(benStaff).toEqual([{ role: "head_coach" }]);
  });

  it("answers for one team without naming people who staff another team", async () => {
    await seedHistory();

    const blueStaff = await rows<{ person: string }>(
      `SELECT p.external_ref AS person
         FROM team_staff s
         JOIN person p ON p.id = s.person_id
        WHERE s.org_id = $1 AND s.team_id = $2
          AND s.valid_from <= $3::timestamptz
          AND (s.valid_to IS NULL OR s.valid_to > $3::timestamptz)`,
      [ORG_A, T_BLUE, D_APR],
    );

    expect(blueStaff).toEqual([{ person: "cara" }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Attendance for a person on a date
// ---------------------------------------------------------------------------

describe("attendance for a person on a date", () => {
  it("answers what they should have attended, what they did, and the delta", async () => {
    const seeded = await seedHistory();

    // Cara on 2026-03-15. She joined Red's roster that day, so she was expected at
    // the March session, and she was marked absent. The delta is therefore one
    // session she was rostered for and did not attend.
    const day = await rows<{
      session_id: string;
      expected: boolean;
      status: string | null;
      delta: string;
    }>(
      `SELECT s.id AS session_id,
              true AS expected,
              ar.status::text AS status,
              CASE WHEN ar.status IS NULL THEN 'unrecorded'
                   WHEN ar.status IN ('present','remote') THEN 'attended'
                   ELSE 'missed' END AS delta
         FROM session s
         JOIN team_membership m
           ON m.org_id = s.org_id
          AND m.team_id = s.team_id
          AND m.person_id = $2
          AND m.valid_from <= s.starts_at
          AND (m.valid_to IS NULL OR m.valid_to > s.starts_at)
        LEFT JOIN attendance_record ar
           ON ar.org_id = s.org_id
          AND ar.session_id = s.id
          AND ar.person_id = $2
        WHERE s.org_id = $1
          AND s.starts_at >= $3::timestamptz
          AND s.starts_at <  $3::timestamptz + interval '1 day'
          AND s.status <> 'cancelled'
        ORDER BY s.starts_at`,
      [ORG_A, P_CARA, D_MAR],
    );

    expect(day).toHaveLength(1);
    expect(day[0]!.session_id).toBe(seeded.sessions.marRed);
    expect(day[0]!.expected).toBe(true);
    expect(day[0]!.status).toBe("absent");
    expect(day[0]!.delta).toBe("missed");
  });

  it("shows a session that happened on a team they had already left", async () => {
    await seedHistory();

    // Alice on 2026-04-20. Her Red membership ended 2026-03-15, so the April Red
    // session was NOT hers. A query that joined session to team_membership on team
    // alone, ignoring the window, would list her and then report an absence.
    const day = await rows<{ session_id: string }>(
      `SELECT s.id AS session_id
         FROM session s
         JOIN team_membership m
           ON m.org_id = s.org_id AND m.team_id = s.team_id AND m.person_id = $2
          AND m.valid_from <= s.starts_at
          AND (m.valid_to IS NULL OR m.valid_to > s.starts_at)
        WHERE s.org_id = $1
          AND s.starts_at >= $3::timestamptz
          AND s.starts_at <  $3::timestamptz + interval '1 day'`,
      [ORG_A, P_ALICE, D_APR],
    );

    expect(day).toEqual([]);
  });

  it("reports an expected session with no attendance row as unrecorded, not as absent", async () => {
    await seedHistory();

    // Ben on 2026-04-20 is expected at the April Red session. There is no row for
    // him, so the delta is "unrecorded". Treating a missing row as absent is the
    // mistake that made the legacy backlog unreconcilable: nobody can later tell
    // "was marked absent" from "was never marked".
    const day = await rows<{ status: string | null; delta: string }>(
      `SELECT ar.status::text AS status,
              CASE WHEN ar.id IS NULL THEN 'unrecorded'
                   WHEN ar.status IN ('present','remote') THEN 'attended'
                   ELSE 'missed' END AS delta
         FROM session s
         JOIN team_membership m
           ON m.org_id = s.org_id AND m.team_id = s.team_id AND m.person_id = $2
          AND m.valid_from <= s.starts_at
          AND (m.valid_to IS NULL OR m.valid_to > s.starts_at)
         LEFT JOIN attendance_record ar
           ON ar.org_id = s.org_id AND ar.session_id = s.id AND ar.person_id = $2
        WHERE s.org_id = $1
          AND s.starts_at >= $3::timestamptz
          AND s.starts_at <  $3::timestamptz + interval '1 day'`,
      [ORG_A, P_BEN, D_APR],
    );

    expect(day).toHaveLength(1);
    expect(day[0]!.status).toBeNull();
    expect(day[0]!.delta).toBe("unrecorded");
  });

  it("excludes a cancelled session from what anyone was expected to attend", async () => {
    const seeded = await seedHistory();

    // Cancels the session Cara is ACTUALLY expected at. Cancelling April Blue and
    // then asking about Red would prove nothing: the join is on team, so a Blue
    // cancellation cannot remove a Red session whatever the predicate says.
    await asOwner(
      `UPDATE session SET status = 'cancelled'
        WHERE org_id = '${ORG_A}' AND id = '${seeded.sessions.aprRed}'`,
    );

    const expected = await rows<{ session_id: string }>(
      `SELECT s.id AS session_id
         FROM session s
         JOIN team_membership m
           ON m.org_id = s.org_id AND m.team_id = s.team_id AND m.person_id = $2
          AND m.valid_from <= s.starts_at
          AND (m.valid_to IS NULL OR m.valid_to > s.starts_at)
        WHERE s.org_id = $1 AND s.status <> 'cancelled'
          AND s.starts_at >= $3::timestamptz
          AND s.starts_at <  $3::timestamptz + interval '1 day'`,
      [ORG_A, P_CARA, D_APR],
    );

    expect(expected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Attendance rate over an arbitrary window
// ---------------------------------------------------------------------------

describe("attendance rate over an arbitrary window", () => {
  it("computes the rate over the window, not over all time", async () => {
    await seedHistory();

    // Ben's rostered sessions are Feb, Mar and Apr on Red. The rate is derived from
    // the POLICY, not from the declared status:
    //
    //   febRed  late, arrived 17:40 -> 55 min past the 16:50 deadline: a real absence
    //   marRed  late, arrived 16:48 -> 3 min past the 16:45 cutoff but INSIDE the
    //                               5 min grace, so the policy counts it as attended
    //   aprRed  no row at all       -> expected and never marked
    //
    // Over the whole period that is 1 of 3 on the policy's reading and 2 of 3 if you
    // simply count every row that says "late". Asserting BOTH is the point: a query
    // that ignores attendance_policy cannot produce the first number.
    const rate = async (
      from: string,
      to: string,
    ): Promise<{ expected: number; attended: number; declared: number }> => {
      const found = await rows<{ expected: number; attended: number; declared: number }>(
        `WITH expected AS (
           SELECT s.id,
                  s.starts_at + make_interval(mins => COALESCE(ap.cutoff_offset_minutes, 0)
                                                         + COALESCE(ap.grace_minutes, 0)) AS deadline
             FROM session s
             LEFT JOIN attendance_policy ap
               ON ap.org_id = s.org_id AND ap.id = s.attendance_policy_id
             JOIN team_membership m
               ON m.org_id = s.org_id AND m.team_id = s.team_id AND m.person_id = $2
              AND m.valid_from <= s.starts_at
              AND (m.valid_to IS NULL OR m.valid_to > s.starts_at)
            WHERE s.org_id = $1
              AND s.status <> 'cancelled'
              AND s.starts_at >= $3::timestamptz
              AND s.starts_at <  $4::timestamptz
         )
         SELECT count(*)::int AS expected,
                count(*) FILTER (
                  WHERE EXISTS (
                    SELECT 1 FROM attendance_record ar
                     WHERE ar.org_id = $1 AND ar.session_id = expected.id AND ar.person_id = $2
                       AND (ar.status IN ('present','remote')
                            OR (ar.status = 'late' AND ar.checked_in_at <= expected.deadline))
                  )
                )::int AS attended,
                count(*) FILTER (
                  WHERE EXISTS (
                    SELECT 1 FROM attendance_record ar
                     WHERE ar.org_id = $1 AND ar.session_id = expected.id AND ar.person_id = $2
                       AND ar.status IN ('present','remote','late')
                  )
                )::int AS declared
           FROM expected`,
        [ORG_A, P_BEN, from, to],
      );
      return found[0]!;
    };

    // January: Ben was not on the roster, so there is nothing to report — and a query
    // that ignored the window would hand him a rate for a month he was not on the team.
    const january = await rate("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z");
    expect(january.expected).toBe(0);

    const all = await rate("2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(all.expected).toBe(3);
    // Policy-aware: the grace window rescues the March check-in, nothing rescues February.
    expect(all.attended).toBe(1);
    // Status-only: both 'late' rows are counted, including the 55-minute one.
    expect(all.declared).toBe(2);

    const february = await rate("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z");
    expect(february.expected).toBe(1);
    expect(february.attended).toBe(0);
    expect(february.declared).toBe(1);

    const march = await rate("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z");
    expect(march.expected).toBe(1);
    // The whole difference between the two readings lives in this one session.
    expect(march.attended).toBe(1);
    expect(march.declared).toBe(1);

    const april = await rate("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(april.expected).toBe(1);
    // Never marked at all, so neither reading credits it.
    expect(april.attended).toBe(0);
    expect(april.declared).toBe(0);
  });

  it("moves the deadline when the policy changes, so grace is read not assumed", async () => {
    const seeded = await seedHistory();

    const deadlineOf = async (policyId: string): Promise<string> => {
      const found = await rows<{ closes_at: string; on_time_by: string }>(
        `SELECT to_char((s.starts_at + make_interval(mins => ap.cutoff_offset_minutes))
                          AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS closes_at,
                to_char((s.starts_at + make_interval(mins => ap.cutoff_offset_minutes
                                                          + ap.grace_minutes))
                          AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS on_time_by
           FROM session s
           JOIN attendance_policy ap ON ap.org_id = s.org_id AND ap.id = $1
          WHERE s.org_id = $2 AND s.id = $3`,
        [policyId, ORG_A, seeded.sessions.marRed],
      );
      return found[0]!.on_time_by;
    };

    // Org default: -15 cutoff, 5 grace. 17:00Z start, so the window closes at 16:45Z
    // and the last instant that still counts is 16:50Z. Ben's 16:48 check-in is
    // inside it.
    expect(await deadlineOf(POLICY_STRICT)).toBe("2026-03-15T16:50:00");

    // Narrowing the grace to zero pulls the deadline back to 16:45Z — which is now
    // BEFORE Ben's 16:48 arrival, so the same check-in stops counting. Asserting both
    // directions is what proves the number is read rather than baked into the query:
    // a hard-coded 5 would satisfy the first assertion and fail this one.
    await asOwner(
      `UPDATE attendance_policy SET grace_minutes = 0
        WHERE org_id = '${ORG_A}' AND id = '${POLICY_STRICT}'`,
    );
    expect(await deadlineOf(POLICY_STRICT)).toBe("2026-03-15T16:45:00");

    // Widening it to 20 pushes the deadline past the session start. Legal here — the
    // schema only constrains grace_minutes to be non-negative, and a grace that
    // extends past the start is a real (if odd) policy, not a corrupt one.
    await asOwner(
      `UPDATE attendance_policy SET grace_minutes = 20
        WHERE org_id = '${ORG_A}' AND id = '${POLICY_STRICT}'`,
    );
    expect(await deadlineOf(POLICY_STRICT)).toBe("2026-03-15T17:05:00");
  });

  it("derives the check-in window from attendance_policy rather than hard-coding it", async () => {
    const seeded = await seedHistory();

    // The policy in force is cutoff -15min, grace 5min, so a session starting at
    // 17:00Z closes at 16:45Z and the last instant that still counts as on time is
    // 16:50Z. Ben's February check-in at 17:40Z is outside it.
    //
    // Rendered through `AT TIME ZONE 'UTC'` and then to_char, NOT as a bare
    // timestamptz. This is a PGlite trap, verified rather than assumed: PGlite
    // returns timestamptz/timestamp/date columns to Node as JavaScript Date objects
    // built in the HOST's timezone, so on this machine `17:00Z` came back as
    // `2026-02-10 22:00:00+05` and an assertion on the raw value would be asserting
    // the test runner's locale, not the database. Casting to text inside SQL keeps
    // the comparison in PostgreSQL, where it belongs.
    const evaluated = await rows<{ closes_at: string; on_time_by: string; status: string }>(
      `SELECT to_char((s.starts_at + make_interval(mins => ap.cutoff_offset_minutes))
                        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS closes_at,
              to_char((s.starts_at + make_interval(mins => ap.cutoff_offset_minutes
                                                      + ap.grace_minutes))
                        AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS on_time_by,
              ar.status::text AS status
         FROM session s
         JOIN attendance_policy ap ON ap.org_id = s.org_id AND ap.id = s.attendance_policy_id
         JOIN attendance_record ar
           ON ar.org_id = s.org_id AND ar.session_id = s.id AND ar.person_id = $2
        WHERE s.org_id = $1 AND s.id = $3`,
      [ORG_A, P_BEN, seeded.sessions.febRed],
    );

    expect(evaluated).toHaveLength(1);
    // starts_at 17:00Z + (-15 min) = 16:45Z.
    expect(evaluated[0]!.closes_at).toBe("2026-02-10T16:45:00");
    expect(evaluated[0]!.on_time_by).toBe("2026-02-10T16:50:00");
    expect(evaluated[0]!.status).toBe("late");
  });

  it("picks up a per-team policy override instead of the org default", async () => {
    const seeded = await seedHistory();

    const windows = await rows<{ session_id: string; cutoff: number; grace: number }>(
      `SELECT s.id AS session_id, ap.cutoff_offset_minutes AS cutoff, ap.grace_minutes AS grace
         FROM session s
         JOIN attendance_policy ap ON ap.org_id = s.org_id AND ap.id = s.attendance_policy_id
        WHERE s.org_id = $1
        ORDER BY s.starts_at`,
      [ORG_A],
    );

    const byId = new Map(windows.map((w) => [w.session_id, w]));

    // Red sessions use the org policy; the Blue sessions use the team override.
    expect(byId.get(seeded.sessions.janRed)).toEqual({
      session_id: seeded.sessions.janRed,
      cutoff: -15,
      grace: 5,
    });
    expect(byId.get(seeded.sessions.marBlue)).toEqual({
      session_id: seeded.sessions.marBlue,
      cutoff: -30,
      grace: 0,
    });
  });

  it("excludes a holiday from the denominator only when the policy's scope covers it", async () => {
    const seeded = await seedHistory();

    // 2026-04-20 is an org holiday, and it is the date BOTH teams' April sessions
    // fall on — which is what makes this a comparison rather than a coincidence.
    // Under a 'none' policy the session still counts toward the denominator; under
    // 'org' it does not. This is the whole point of the column, and before migration
    // 0006 there was no table to record the holiday in at all.
    await asOwner(`
      INSERT INTO session_holiday (org_id, scope, holiday_date, description)
      VALUES ('${ORG_A}', 'org', DATE '${D_APR}', 'Founders Day');
    `);

    // The Blue override now covers org holidays. Red's org default stays 'none'.
    await asOwner(
      `UPDATE attendance_policy SET holiday_scope = 'org'
        WHERE org_id = '${ORG_A}' AND id = '${POLICY_BLUE}'`,
    );

    const denominator = async (policyId: string, teamId: string): Promise<number> => {
      const found = await rows<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM session s
           JOIN attendance_policy ap ON ap.org_id = s.org_id AND ap.id = $1
          WHERE s.org_id = $2
            AND s.team_id = $3
            AND s.status <> 'cancelled'
            AND NOT (
              ap.holiday_scope <> 'none'
              AND EXISTS (
                SELECT 1 FROM session_holiday h
                 WHERE h.org_id = s.org_id
                   AND h.holiday_date = (s.starts_at AT TIME ZONE 'UTC')::date
                   AND (h.team_id IS NULL OR h.team_id = s.team_id)
                   AND NOT h.is_working_day
              )
            )`,
        [policyId, ORG_A, teamId],
      );
      return found[0]!.n;
    };

    // Red: four sessions, one of them on the holiday. The org policy says scope
    // 'none', so the holiday is ignored and all four count.
    expect(await denominator(POLICY_STRICT, T_RED)).toBe(4);

    // Blue: two sessions (20 March and 20 April), one of them on the holiday.
    // Scope 'org' drops the April one and leaves the March one — so the answer is
    // 1, not 0. An exclusion that emptied the set would look identical if the
    // fixture had only one Blue session.
    expect(await denominator(POLICY_BLUE, T_BLUE)).toBe(1);

    // Set the scope back to 'none' and the same two sessions both count. Asserting
    // both directions is what proves the scope is being read, rather than the query
    // coincidentally excluding something else.
    await asOwner(
      `UPDATE attendance_policy SET holiday_scope = 'none'
        WHERE org_id = '${ORG_A}' AND id = '${POLICY_BLUE}'`,
    );
    expect(await denominator(POLICY_BLUE, T_BLUE)).toBe(2);

    // A working day on the same date is NOT excluded even at scope 'org': a bootcamp
    // held on a public holiday is still a session the roster was expected at.
    await asOwner(`UPDATE session_holiday SET is_working_day = true WHERE org_id = '${ORG_A}'`);
    await asOwner(
      `UPDATE attendance_policy SET holiday_scope = 'org'
        WHERE org_id = '${ORG_A}' AND id = '${POLICY_BLUE}'`,
    );
    expect(await denominator(POLICY_BLUE, T_BLUE)).toBe(2);

    expect(seeded.sessions.aprBlue).toBeDefined();
  });

  it("refuses a team holiday that also claims to be national", async () => {
    await seedHistory();

    // 'national' means a day for the whole country, which cannot simultaneously be a
    // day for one team's roster. The legacy holidays table mixed the two in a nullable
    // team_id with no discriminator (AUDIT F-ATT-10); here the combination is refused
    // rather than stored as a claim with two parts.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO session_holiday (org_id, team_id, scope, holiday_date, description)
           VALUES ('${ORG_A}', '${T_RED}', 'national', DATE '2026-02-11', 'Both?')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "team holiday claiming national scope",
    );

    // The converse must stay legal, or the CHECK is merely refusing everything: a
    // TEAM-SPECIFIC organisation holiday is a real thing and is what team_id is for.
    await asOwner(
      `INSERT INTO session_holiday (org_id, team_id, scope, holiday_date, description)
       VALUES ('${ORG_A}', '${T_RED}', 'org', DATE '2026-02-11', 'Blue tryout')`,
    );
    const stored = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM session_holiday WHERE org_id = $1 AND team_id = $2",
      [ORG_A, T_RED],
    );
    expect(stored[0]!.n).toBe(1);
  });

  it("still records a national holiday alongside an organisation holiday on the same date", async () => {
    await seedHistory();

    // Independent facts: the country is closed and we are closed. Reading the second
    // as a duplicate of the first would make one of them unrecordable.
    await asOwner(`
      INSERT INTO session_holiday (org_id, scope, holiday_date, description)
      VALUES ('${ORG_A}', 'national', DATE '2026-04-20', 'Republic Day'),
             ('${ORG_A}', 'org',      DATE '2026-04-20', 'Founders Day');
    `);

    const onDate = await rows<{ scope: string }>(
      `SELECT scope::text AS scope FROM session_holiday
        WHERE org_id = $1 AND holiday_date = DATE '2026-04-20' ORDER BY scope`,
      [ORG_A],
    );
    expect(onDate).toEqual([{ scope: "national" }, { scope: "org" }]);
  });
});

// ---------------------------------------------------------------------------
// 5. Session provenance
// ---------------------------------------------------------------------------

describe("session provenance", () => {
  it("answers whether a session was generated from a template or created by hand", async () => {
    const seeded = await seedHistory();

    // Seeding one generated session and one hand-written one, so the query has
    // something to discriminate rather than a homogeneous set to pass over.
    const templateId = "dddddddd-0000-0000-0000-000000000001";
    await asOwner(
      `INSERT INTO session_template (id, org_id, team_id, name, kind, duration_minutes, start_minute_of_day, valid_from)
       VALUES ('${templateId}', '${ORG_A}', '${T_RED}', 'Evening practice', 'practice', 120, 1020, '${D_JAN}')`,
    );

    const generated = "cccccccc-0000-0000-0000-0000000003f1";
    const manual = "cccccccc-0000-0000-0000-0000000003f2";

    await asOwner(`
      INSERT INTO session (id, org_id, team_id, kind, title, status, starts_at, ends_at, session_template_id, origin)
      VALUES ('${generated}', '${ORG_A}', '${T_RED}', 'practice', 'Evening practice', 'held',
              '2026-05-01T17:00:00Z', '2026-05-01T19:00:00Z', '${templateId}', 'generated'),
             ('${manual}',    '${ORG_A}', '${T_RED}', 'scrim',   'Extra scrim',      'held',
              '2026-05-02T17:00:00Z', '2026-05-02T19:00:00Z', NULL, 'manual');
    `);

    const byOrigin = await rows<{ origin: string; n: number }>(
      `SELECT origin::text AS origin, count(*)::int AS n
         FROM session
        WHERE org_id = $1
        GROUP BY origin
        ORDER BY origin`,
      [ORG_A],
    );

    // Six seeded sessions plus the hand-written one: every row written without an
    // explicit origin defaults to 'manual', which is why the aggregate has to say 7
    // and not 6 for the count to mean anything.
    expect(byOrigin).toEqual([
      { origin: "generated", n: 1 },
      { origin: "manual", n: 7 },
    ]);

    // And the same question answered per session, without reading the title.
    const provenance = await rows<{ session_id: string; origin: string }>(
      `SELECT id AS session_id, origin::text AS origin
         FROM session
        WHERE org_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id`,
      [ORG_A, [generated, manual]],
    );

    // Ordered by id, and ...3f1 sorts before ...3f2, so "generated" comes first.
    expect(provenance).toEqual([
      { session_id: generated, origin: "generated" },
      { session_id: manual, origin: "manual" },
    ]);
    expect(seeded.sessions.janRed).toBeDefined();
  });

  it("refuses a session that claims a template but does not name one", async () => {
    const seeded = await seedHistory();

    // 'generated' without a template is a claim with nothing behind it: the
    // question "generated from what?" has no answer, which is the legacy defect
    // restated with a provenance column bolted on.
    //
    // check_violation (23514), not foreign_key_violation: PostgreSQL evaluates a row
    // CHECK during the insert and defers the composite FK to an AFTER trigger, so the
    // CHECK is reached first. That is also the more useful code — the row is wrong on
    // its own terms and no other table has to be consulted to say so.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO session (id, org_id, team_id, kind, title, starts_at, ends_at, origin)
           VALUES ('cccccccc-0000-0000-0000-0000000003f3', '${ORG_A}', '${T_RED}', 'practice',
                   'Mystery session', '2026-05-03T17:00:00Z', '2026-05-03T19:00:00Z', 'generated')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "generated session with no template",
    );

    // The converse: naming a template without claiming generation would make the
    // origin column unreliable in the other direction, so it is refused too.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO session (id, org_id, team_id, kind, title, starts_at, ends_at, origin, session_template_id)
           VALUES ('cccccccc-0000-0000-0000-0000000003f4', '${ORG_A}', '${T_RED}', 'practice',
                   'Confused session', '2026-05-04T17:00:00Z', '2026-05-04T19:00:00Z', 'manual',
                   'dddddddd-0000-0000-0000-000000000001')`,
        ),
      SQLSTATE_CHECK_VIOLATION,
      "manual session naming a template",
    );

    expect(seeded.divisionId).toBeDefined();
  });

  it("keeps the composite foreign key on the template reference tenant-scoped", async () => {
    // A session naming another org's template must be refused by the database, not
    // merely invisible under RLS (ADR-0011).
    const otherOrg = "22222222-2222-2222-2222-222222222222";
    const otherTemplate = "dddddddd-0000-0000-0000-000000000002";

    // ORG_B needs its own game, division and team before its template can exist,
    // because the composite FK to team is what makes the template tenant-owned in the
    // first place. Seeded in full rather than partially: a template hanging off a
    // team that does not exist would fail on its own FK and prove nothing about the
    // session reference under test.
    await asOwner(`
      INSERT INTO organization (id, slug, display_name, default_currency, status)
      VALUES ('${otherOrg}', 'org-b', 'Org B', 'USD', 'active');

      INSERT INTO game (id, org_id, name, slug)
      VALUES ('dddddddd-0000-0000-0000-000000000010', '${otherOrg}', 'Their game', 'their-game');

      INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
      VALUES ('dddddddd-0000-0000-0000-000000000011', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000010',
              'Their Cup', 'their-cup', 'competitive', 'active');

      INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
      VALUES ('dddddddd-0000-0000-0000-000000000012', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000011',
              'Their Season', 'TS', '${D_JAN}', '2026-12-31T00:00:00Z', true);

      INSERT INTO division (id, org_id, season_id, name, slug, tier)
      VALUES ('dddddddd-0000-0000-0000-000000000013', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000012',
              'Theirs', 'theirs', 'challenger');

      INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
      VALUES ('dddddddd-0000-0000-0000-000000000003', '${otherOrg}', 'Theirs', 'theirs',
              'dddddddd-0000-0000-0000-000000000010', 'dddddddd-0000-0000-0000-000000000013', 'active', '${D_JAN}');

      INSERT INTO session_template (id, org_id, team_id, name, kind, duration_minutes, start_minute_of_day, valid_from)
      VALUES ('${otherTemplate}', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000003',
              'Their template', 'practice', 60, 600, '${D_JAN}');
    `);

    // The template genuinely exists — asserted so this cannot pass because the row
    // was never written.
    const present = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM session_template WHERE org_id = $1",
      [otherOrg],
    );
    expect(present[0]!.n).toBe(1);

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO session (org_id, team_id, kind, title, starts_at, ends_at, origin, session_template_id)
           VALUES ('${ORG_A}', '${T_RED}', 'practice', 'Cross tenant', '2026-05-05T17:00:00Z', '2026-05-05T19:00:00Z',
                   'generated', '${otherTemplate}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "session naming another org's template",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Retroactive template edits
// ---------------------------------------------------------------------------

describe("retroactive template edits", () => {
  it("does NOT propagate a template edit to sessions that were already generated", async () => {
    const seeded = await seedHistory();

    const templateId = "dddddddd-0000-0000-0000-000000000001";
    await asOwner(
      `INSERT INTO session_template (id, org_id, team_id, name, kind, duration_minutes, start_minute_of_day, valid_from)
       VALUES ('${templateId}', '${ORG_A}', '${T_RED}', 'Evening practice', 'practice', 120, 1020, '${D_JAN}')`,
    );

    const generated = "cccccccc-0000-0000-0000-0000000003f1";
    await asOwner(
      `INSERT INTO session (id, org_id, team_id, kind, title, status, starts_at, ends_at, session_template_id, origin)
       VALUES ('${generated}', '${ORG_A}', '${T_RED}', 'practice', 'Evening practice', 'held',
               '2026-05-01T17:00:00Z', '2026-05-01T19:00:00Z', '${templateId}', 'generated')`,
    );

    // The legacy generator COPIED config into each session (ADR-0016), so editing a
    // template never propagated and nobody could tell whether a stale session was
    // stale by design or by bug. The behaviour now INTENDED is the opposite of a
    // silent copy: a generated session is a FACT about a past date and does not
    // move when the template that produced it is edited.
    //
    // The template's duration is changed from 120 to 45 minutes.
    await asOwner(
      `UPDATE session_template SET duration_minutes = 45
        WHERE org_id = '${ORG_A}' AND id = '${templateId}'`,
    );

    const session = await rows<{ starts_at: string; ends_at: string; duration: string }>(
      `SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at,
              to_char(ends_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_at,
              (EXTRACT(EPOCH FROM (ends_at - starts_at)) / 60)::numeric(9,2)::text AS duration
         FROM session
        WHERE org_id = $1 AND id = $2`,
      [ORG_A, generated],
    );

    // Unmoved: still the 17:00–19:00 that actually happened.
    expect(session[0]!.starts_at).toBe("2026-05-01T17:00:00");
    expect(session[0]!.ends_at).toBe("2026-05-01T19:00:00");
    expect(session[0]!.duration).toBe("120.00");

    // And the template itself DID change, so this is not a query that simply failed
    // to find the template.
    const template = await rows<{ duration: number }>(
      "SELECT duration_minutes AS duration FROM session_template WHERE org_id = $1 AND id = $2",
      [ORG_A, templateId],
    );
    expect(template[0]!.duration).toBe(45);

    expect(seeded.gameId).toBeDefined();
  });

  it("records which template version produced a past session, so a stale session is explicable", async () => {
    // The reason the non-propagation above is acceptable rather than merely a
    // repeat of the legacy defect: the session still NAMES the template that
    // produced it, so "this session predates the template change" is answerable
    // rather than a guess.
    await seedHistory();

    const templateId = "dddddddd-0000-0000-0000-000000000001";
    await asOwner(
      `INSERT INTO session_template (id, org_id, team_id, name, kind, duration_minutes, start_minute_of_day, valid_from)
       VALUES ('${templateId}', '${ORG_A}', '${T_RED}', 'Evening practice', 'practice', 120, 1020, '${D_JAN}')`,
    );
    await asOwner(
      `INSERT INTO session (id, org_id, team_id, kind, title, starts_at, ends_at, session_template_id, origin)
       VALUES ('cccccccc-0000-0000-0000-0000000003f5', '${ORG_A}', '${T_RED}', 'practice',
               'Evening practice', '2026-05-01T17:00:00Z', '2026-05-01T19:00:00Z', '${templateId}', 'generated')`,
    );

    const aged = await rows<{ session_starts: string; template_from: string; session_predates_template: boolean }>(
      `SELECT s.starts_at::text AS session_starts,
              t.valid_from::text AS template_from,
              (s.starts_at < t.valid_from) AS session_predates_template
         FROM session s
         JOIN session_template t
           ON t.org_id = s.org_id AND t.id = s.session_template_id
        WHERE s.org_id = $1 AND s.origin = 'generated'
          AND s.session_template_id IS NOT NULL`,
      [ORG_A],
    );

    expect(aged).toHaveLength(1);
    // The session started after the template became current, so it is NOT stale:
    // it was generated under the version in force when it was created.
    expect(aged[0]!.session_predates_template).toBe(false);
    expect(aged[0]!.session_starts).toContain("2026-05-01");
    expect(aged[0]!.template_from).toContain("2026-01-05");
  });
});

// ---------------------------------------------------------------------------
// Overlapping historical membership windows
// ---------------------------------------------------------------------------

describe("overlapping membership windows", () => {
  it("refuses two memberships on one team whose windows overlap, even when both are closed", async () => {
    const seeded = await seedHistory();

    // Alice's Red membership is [Jan 05, Mar 15). This one starts inside it and
    // runs past it. Both are CLOSED (valid_to NOT NULL), so 0002's partial unique
    // index — which only constrains rows where valid_to IS NULL — does not see
    // them. Whether the database refuses this is the question, and the answer
    // recorded by the migration that fixes it is: it must.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
           VALUES ('cccccccc-0000-0000-0000-000000000109', '${ORG_A}', '${T_RED}', '${P_ALICE}',
                   'substitute', 10, '2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
        ),
      SQLSTATE_EXCLUSION_VIOLATION,
      "overlapping historical membership on one team",
    );

    expect(seeded.sessions.marRed).toBeDefined();
  });

  it("still permits two memberships on DIFFERENT teams that overlap in time", async () => {
    await seedHistory();

    // Cara is on Blue [Jan 05, Feb 10) and Red [Mar 15, ...) — those do not
    // overlap, so this test adds a genuine second-team overlap: Cara on Blue again
    // from Mar 01. Being on two teams at once is the domain; being on one team
    // twice at once is the defect.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
       VALUES ('cccccccc-0000-0000-0000-000000000110', '${ORG_A}', '${T_BLUE}', '${P_CARA}',
               'player', 50, '2026-03-01T00:00:00Z', '2026-04-15T00:00:00Z')`,
    );

    const concurrent = await rows<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM team_membership
        WHERE org_id = $1 AND person_id = $2 AND team_id = $3
          AND valid_from <= $4::timestamptz
          AND (valid_to IS NULL OR valid_to > $4::timestamptz)`,
      [ORG_A, P_CARA, T_BLUE, "2026-03-10T00:00:00Z"],
    );

    expect(concurrent[0]!.n).toBe(1);
  });

  it("permits abutting windows that merely touch, because the window is half-open", async () => {
    await seedHistory();

    // Alice's Red membership ends exactly at 2026-03-15. A successor beginning at
    // 2026-03-15 shares no instant with it, so it is not an overlap and must be
    // accepted. A closed-on-both-ends window would refuse this and make a clean
    // handover unrecordable.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
       VALUES ('cccccccc-0000-0000-0000-000000000111', '${ORG_A}', '${T_RED}', '${P_ALICE}',
               'player', 40, '2026-03-15T00:00:00Z', '2026-05-01T00:00:00Z')`,
    );

    const overlapping = await rows(
      `SELECT id FROM team_membership
        WHERE org_id = $1 AND team_id = $2 AND person_id = $3
          AND valid_from < '2026-03-15T00:00:00Z'::timestamptz
          AND (valid_to IS NULL OR valid_to > '2026-03-15T00:00:00Z'::timestamptz)`,
      [ORG_A, T_RED, P_ALICE],
    );

    expect(overlapping).toHaveLength(0);
  });

  it("refuses overlapping staff windows on one team and role", async () => {
    const seeded = await seedHistory();

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO team_staff (id, org_id, team_id, person_id, role_in_team, valid_from, valid_to)
           VALUES ('cccccccc-0000-0000-0000-000000000203', '${ORG_A}', '${T_RED}', '${P_BEN}',
                   'head_coach', '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
        ),
      SQLSTATE_EXCLUSION_VIOLATION,
      "overlapping staff windows for one team and role",
    );

    expect(seeded.gameId).toBeDefined();
  });

  it("permits one person holding two DIFFERENT staff roles on one team at once", async () => {
    await seedHistory();

    // The exclusion is keyed on (team, person, role), matching the existing partial
    // unique index. Being head coach AND analyst simultaneously is a real thing and
    // must not be refused; being head coach twice is the defect.
    await asOwner(
      `INSERT INTO team_staff (id, org_id, team_id, person_id, role_in_team, valid_from, valid_to)
       VALUES ('cccccccc-0000-0000-0000-000000000204', '${ORG_A}', '${T_RED}', '${P_BEN}',
               'analyst', '2026-03-01T00:00:00Z', NULL)`,
    );

    const roles = await rows<{ role: string }>(
      `SELECT role_in_team::text AS role
         FROM team_staff
        WHERE org_id = $1 AND team_id = $2 AND person_id = $3
          AND valid_from <= $4::timestamptz
          AND (valid_to IS NULL OR valid_to > $4::timestamptz)
        ORDER BY role`,
      [ORG_A, T_RED, P_BEN, "2026-03-15T00:00:00Z"],
    );

    expect(roles).toEqual([{ role: "analyst" }, { role: "head_coach" }]);
  });

  it("still reports two CURRENT memberships as a unique violation, not an overlap", async () => {
    await seedHistory();

    // A deliberate split in the error contract, recorded in migration 0006. Two open
    // memberships for one person on one team is caught by the PARTIAL unique index
    // from 0002 (`WHERE valid_to IS NULL`), so the caller sees 23505. The 0006 guard
    // runs AFTER, specifically so it does not get there first and re-label the same
    // business rule as 23P01 — one rule, one code, whichever mechanism happens to see
    // it first. A caller that learned only one of these codes would otherwise have to
    // branch on something that has not changed.
    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO team_membership (org_id, team_id, person_id, role_in_team, share_percent, valid_from)
           VALUES ('${ORG_A}', '${T_RED}', '${P_BEN}', 'player', 60, '2026-03-01T00:00:00Z')`,
        ),
      SQLSTATE_UNIQUE_VIOLATION,
      "second current membership",
    );
  });

  it("refuses a retroactive UPDATE that would create an overlap", async () => {
    await seedHistory();

    // The earlier version of this test stretched Alice's Red membership forward past
    // Cara's and expected a refusal. That was wrong, and the database was right:
    // the guard is keyed on (org, team, PERSON), and Alice overlapping Cara is two
    // different people — which is the domain, not the defect. Being able to prove a
    // guard's key is the person rather than the team is the point of having two
    // teams in the fixture at all.
    //
    // The real case needs a SECOND membership for the SAME person. Alice's seeded
    // Red membership is [Jan 05, Mar 15); this adds a non-overlapping successor
    // beginning the day after it ends, which the guard must accept.
    await asOwner(
      `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
       VALUES ('cccccccc-0000-0000-0000-000000000105', '${ORG_A}', '${T_RED}', '${P_ALICE}',
               'player', 40, '2026-03-15T00:00:00Z', '2026-05-01T00:00:00Z')`,
    );

    // Now stretch the first one to 15 April. It shared no instant with its successor;
    // after the UPDATE it shares 16:30 days with it, and "who was on Red on 20 March"
    // would return two rows for Alice.
    await expectSqlstate(
      () =>
        asOwner(
          `UPDATE team_membership SET valid_to = '2026-04-15T00:00:00Z'
            WHERE org_id = '${ORG_A}' AND id = 'cccccccc-0000-0000-0000-000000000101'`,
        ),
      SQLSTATE_EXCLUSION_VIOLATION,
      "UPDATE stretching a membership into an overlap",
    );

    // The refused UPDATE left nothing behind: the original window is intact.
    const window = await rows<{ valid_to: string }>(
      `SELECT to_char(valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS valid_to
         FROM team_membership WHERE org_id = $1 AND id = 'cccccccc-0000-0000-0000-000000000101'`,
      [ORG_A],
    );
    expect(window[0]!.valid_to).toBe("2026-03-15T00:00:00");
  });

  it("still accepts an UPDATE that moves a membership without creating an overlap", async () => {
    await seedHistory();

    // The guard must not be a blanket refusal. Shortening a window that touches
    // nothing is legal and has to stay legal, or a corrected effective date could
    // never be written — which is how corrected data stops being writable and
    // errors get worked around by disabling the constraint.
    await asOwner(
      `UPDATE team_membership SET valid_to = '2026-02-01T00:00:00Z'
        WHERE org_id = '${ORG_A}' AND id = 'cccccccc-0000-0000-0000-000000000101'`,
    );

    const moved = await rows<{ valid_to: string }>(
      `SELECT to_char(valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS valid_to
         FROM team_membership WHERE org_id = $1 AND id = 'cccccccc-0000-0000-0000-000000000101'`,
      [ORG_A],
    );
    expect(moved[0]!.valid_to).toBe("2026-02-01T00:00:00");
  });
});

// ---------------------------------------------------------------------------
// Phase 2 guarantees, re-confirmed after Phase 3 landed
// ---------------------------------------------------------------------------

const PHASE_2_TABLES = [
  "game",
  "title",
  "season",
  "division",
  "team",
  "team_membership",
  "team_staff",
  "competition",
  "competition_division",
  "registration",
  "opponent",
  "match",
  "match_result",
  "prize_pool",
  "attendance_policy",
  "session",
  "attendance_record",
] as const;

describe("Phase 2 guarantees still hold after Phase 3", () => {
  it("applies every migration with no pending work", async () => {
    const status = await migrationStatus(db);
    expect(status.pending).toHaveLength(0);
    expect(status.applied).toContain("0002_competitive.sql");
    expect(status.applied).toContain("0006_history_queries.sql");
  });

  it("keeps RLS enabled AND forced on every Phase 2 table", async () => {
    const found = await rows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1) AND relkind = 'r'
        ORDER BY relname`,
      [[...PHASE_2_TABLES]],
    );

    expect(found.map((r) => r.relname)).toEqual([...PHASE_2_TABLES].sort());
    for (const row of found) {
      expect(row.relrowsecurity, `${row.relname} must have RLS enabled`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });

  it("still fails CLOSED with app.org_id unset, on every Phase 2 table", async () => {
    await seedHistory();

    await asApp(async () => {
      for (const table of PHASE_2_TABLES) {
        const found = await db.query(`SELECT * FROM ${table}`);
        expect(found.rows, `${table} must expose nothing without a tenant context`).toHaveLength(0);
      }
    });
  });

  it("still scopes a historical query to one tenant", async () => {
    await seedHistory();

    const otherOrg = "22222222-2222-2222-2222-222222222222";
    const otherTeam = "dddddddd-0000-0000-0000-000000000003";

    await asOwner(`
      INSERT INTO organization (id, slug, display_name, default_currency, status)
      VALUES ('${otherOrg}', 'org-b', 'Org B', 'USD', 'active');

      INSERT INTO game (id, org_id, name, slug)
      VALUES ('dddddddd-0000-0000-0000-000000000010', '${otherOrg}', 'Their game', 'their-game');

      INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
      VALUES ('dddddddd-0000-0000-0000-000000000011', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000010',
              'Their Cup', 'their-cup', 'competitive', 'active');

      INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
      VALUES ('dddddddd-0000-0000-0000-000000000012', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000011',
              'Their Season', 'TS', '${D_JAN}', '2026-12-31T00:00:00Z', true);

      INSERT INTO division (id, org_id, season_id, name, slug, tier)
      VALUES ('dddddddd-0000-0000-0000-000000000013', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000012',
              'Theirs', 'theirs', 'challenger');

      INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
      VALUES ('${otherTeam}', '${otherOrg}', 'Theirs', 'theirs',
              'dddddddd-0000-0000-0000-000000000010', 'dddddddd-0000-0000-0000-000000000013', 'active', '${D_JAN}');

      -- Ben is on OUR Red roster, and on THEIR team for the same period. A
      -- historical query with a missing tenant predicate would list him twice, from
      -- two organisations, with no way to tell them apart.
      INSERT INTO team_membership (org_id, team_id, person_id, role_in_team, share_percent, valid_from, valid_to)
      VALUES ('${otherOrg}', '${otherTeam}', '${P_BEN}', 'player', 100, '${D_FEB}', '${D_MAR}');
    `);

    const roster = async (orgId: string): Promise<string[]> => {
      const found = await rows<{ person: string; team: string }>(
        `SELECT p.external_ref AS person, t.name AS team
           FROM team_membership m
           JOIN person p ON p.id = m.person_id
           JOIN team   t ON t.org_id = m.org_id AND t.id = m.team_id
          WHERE m.org_id = $1
            AND m.valid_from <= $2::timestamptz
            AND (m.valid_to IS NULL OR m.valid_to > $2::timestamptz)
          ORDER BY t.name, p.external_ref`,
        [orgId, "2026-02-20T00:00:00Z"],
      );
      return found.map((r) => `${r.person}@${r.team}`);
    };

    expect(await roster(ORG_A)).toEqual(["alice@Red", "ben@Red"]);
    expect(await roster(otherOrg)).toEqual(["ben@Theirs"]);

    // And through the application role rather than the owner, because the owner
    // bypasses RLS entirely and a superuser-scoped assertion proves nothing about
    // isolation (ADR-0006).
    await asApp(async () => {
      const visible = await db.query<{ name: string }>("SELECT name FROM team ORDER BY name");
      expect(visible.rows.map((r) => r.name)).toEqual(["Blue", "Red"]);
    }, ORG_A);

    await asApp(async () => {
      const visible = await db.query<{ name: string }>("SELECT name FROM team ORDER BY name");
      expect(visible.rows.map((r) => r.name)).toEqual(["Theirs"]);
    }, otherOrg);
  });

  it("still refuses a cross-tenant composite FK on the history path", async () => {
    await seedHistory();

    const otherOrg = "22222222-2222-2222-2222-222222222222";
    const otherTeam = "dddddddd-0000-0000-0000-000000000003";

    // ORG_B's team exists. A membership in ORG_A naming it must be refused by the
    // composite FK — run as the schema owner, so RLS is not what does the refusing
    // and the guarantee being asserted is the DATABASE's (ADR-0011).
    await asOwner(`
      INSERT INTO organization (id, slug, display_name, default_currency, status)
      VALUES ('${otherOrg}', 'org-b', 'Org B', 'USD', 'active');

      INSERT INTO game (id, org_id, name, slug)
      VALUES ('dddddddd-0000-0000-0000-000000000010', '${otherOrg}', 'Their game', 'their-game');

      INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
      VALUES ('dddddddd-0000-0000-0000-000000000011', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000010',
              'Their Cup', 'their-cup', 'competitive', 'active');

      INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
      VALUES ('dddddddd-0000-0000-0000-000000000012', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000011',
              'Their Season', 'TS', '${D_JAN}', '2026-12-31T00:00:00Z', true);

      INSERT INTO division (id, org_id, season_id, name, slug, tier)
      VALUES ('dddddddd-0000-0000-0000-000000000013', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000012',
              'Theirs', 'theirs', 'challenger');

      INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
      VALUES ('${otherTeam}', '${otherOrg}', 'Theirs', 'theirs',
              'dddddddd-0000-0000-0000-000000000010', 'dddddddd-0000-0000-0000-000000000013', 'active', '${D_JAN}');
    `);

    await expectSqlstate(
      () =>
        asOwner(
          `INSERT INTO team_membership (id, org_id, team_id, person_id, role_in_team, valid_from)
           VALUES ('cccccccc-0000-0000-0000-000000000401', '${ORG_A}', '${otherTeam}', '${P_ALICE}', 'player', '${D_JAN}')`,
        ),
      SQLSTATE_FOREIGN_KEY_VIOLATION,
      "membership naming a team in another org",
    );

    // Nothing was written: a refused reference leaves no partial history behind.
    const stored = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM team_membership WHERE org_id = $1 AND team_id = $2",
      [ORG_A, otherTeam],
    );
    expect(stored[0]!.n).toBe(0);
  });

  it("still has no single-column FK from a Phase 2 table to a tenant table", async () => {
    const tenantTables = new Set(
      (
        await rows<{ relname: string }>(
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

    const fks = await rows<{ child_table: string; parent_table: string; conname: string; cols: string[] }>(
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
      [[...PHASE_2_TABLES]],
    );

    const offenders = fks
      .filter((fk) => tenantTables.has(fk.parent_table) && (fk.cols.length < 2 || fk.cols[0] !== "org_id"))
      .map((fk) => `${fk.child_table}.${fk.conname} -> ${fk.parent_table}(${fk.cols.join(", ")})`);

    expect(offenders).toEqual([]);
  });

  it("refuses the application role an attendance record naming another org's session", async () => {
    await seedHistory();

    const otherOrg = "22222222-2222-2222-2222-222222222222";
    const otherTeam = "dddddddd-0000-0000-0000-000000000003";
    const otherSession = "dddddddd-0000-0000-0000-000000000301";

    await asOwner(`
      INSERT INTO organization (id, slug, display_name, default_currency, status)
      VALUES ('${otherOrg}', 'org-b', 'Org B', 'USD', 'active');
      INSERT INTO game (id, org_id, name, slug)
      VALUES ('dddddddd-0000-0000-0000-000000000010', '${otherOrg}', 'Their game', 'their-game');
      INSERT INTO title (id, org_id, game_id, name, slug, tier, status)
      VALUES ('dddddddd-0000-0000-0000-000000000011', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000010',
              'Their Cup', 'their-cup', 'competitive', 'active');
      INSERT INTO season (id, org_id, title_id, name, code, starts_on, ends_on, is_current)
      VALUES ('dddddddd-0000-0000-0000-000000000012', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000011',
              'Their Season', 'TS', '${D_JAN}', '2026-12-31T00:00:00Z', true);
      INSERT INTO division (id, org_id, season_id, name, slug, tier)
      VALUES ('dddddddd-0000-0000-0000-000000000013', '${otherOrg}', 'dddddddd-0000-0000-0000-000000000012',
              'Theirs', 'theirs', 'challenger');
      INSERT INTO team (id, org_id, name, slug, game_id, division_id, status, valid_from)
      VALUES ('${otherTeam}', '${otherOrg}', 'Theirs', 'theirs',
              'dddddddd-0000-0000-0000-000000000010', 'dddddddd-0000-0000-0000-000000000013', 'active', '${D_JAN}');
      INSERT INTO session (id, org_id, team_id, kind, title, status, starts_at, ends_at)
      VALUES ('${otherSession}', '${otherOrg}', '${otherTeam}', 'practice', 'Theirs', 'held',
              '2026-02-10T17:00:00Z', '2026-02-10T19:00:00Z');
    `);

    // ORG_A writes an attendance record naming ORG_B's session. Two mechanisms could
    // refuse this — the RLS WITH CHECK on the child row, and the composite FK — and
    // the SQLSTATE is asserted rather than the message precisely because they report
    // different codes and a message match would let the wrong one satisfy the test.
    // WITH CHECK is what fires here: the row's own org_id matches the session
    // context, and it is the FK that names another tenant's session.
    await asApp(async () => {
      await expectSqlstate(
        () =>
          db.query(
            `INSERT INTO attendance_record (org_id, session_id, person_id, status, method)
             VALUES ($1, $2, $3, 'present', 'coach_marked')`,
            [ORG_A, otherSession, P_CARA],
          ),
        SQLSTATE_FOREIGN_KEY_VIOLATION,
        "attendance naming another org's session, as the application role",
      );
    }, ORG_A);
  });
});